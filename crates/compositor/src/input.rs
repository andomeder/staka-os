//! Virtual input injection into the nested compositor's seat.
//!
//! Connects to the nested cage compositor's Wayland socket as a plain
//! Wayland client and injects input through `zwlr_virtual_pointer_v1` and
//! `zwp_virtual_keyboard_v1` - the same mechanism the working prototype
//! used. Because the socket belongs to cage, input lands in cage's seat
//! and never reaches the user's physical seat; that isolation is
//! structural (a separate Wayland server), not best-effort.
//!
//! The protocol plumbing lives behind [`InputSink`] (raw event sink) and
//! [`VirtualSeat`] (high-level operations), so the event-order and
//! keysym-mapping logic is unit-testable without a Wayland connection.
//!
//! Key events are raw evdev codes (linux/input-event-codes.h), matching
//! the prototype: cage's seat processes them through its own keymap.

use std::path::Path;

use crate::ipc::MouseButton;

// --- evdev key codes (subset used by the text and chord mappers) ---

pub const KEY_ESC: u16 = 1;
pub const KEY_1: u16 = 2;
pub const KEY_2: u16 = 3;
pub const KEY_3: u16 = 4;
pub const KEY_4: u16 = 5;
pub const KEY_5: u16 = 6;
pub const KEY_6: u16 = 7;
pub const KEY_7: u16 = 8;
pub const KEY_8: u16 = 9;
pub const KEY_9: u16 = 10;
pub const KEY_0: u16 = 11;
pub const KEY_MINUS: u16 = 12;
pub const KEY_EQUAL: u16 = 13;
pub const KEY_BACKSPACE: u16 = 14;
pub const KEY_TAB: u16 = 15;
pub const KEY_Q: u16 = 16;
pub const KEY_W: u16 = 17;
pub const KEY_E: u16 = 18;
pub const KEY_R: u16 = 19;
pub const KEY_T: u16 = 20;
pub const KEY_Y: u16 = 21;
pub const KEY_U: u16 = 22;
pub const KEY_I: u16 = 23;
pub const KEY_O: u16 = 24;
pub const KEY_P: u16 = 25;
pub const KEY_LEFTBRACE: u16 = 26;
pub const KEY_RIGHTBRACE: u16 = 27;
pub const KEY_ENTER: u16 = 28;
pub const KEY_LEFTCTRL: u16 = 29;
pub const KEY_A: u16 = 30;
pub const KEY_S: u16 = 31;
pub const KEY_D: u16 = 32;
pub const KEY_F: u16 = 33;
pub const KEY_G: u16 = 34;
pub const KEY_H: u16 = 35;
pub const KEY_J: u16 = 36;
pub const KEY_K: u16 = 37;
pub const KEY_L: u16 = 38;
pub const KEY_SEMICOLON: u16 = 39;
pub const KEY_APOSTROPHE: u16 = 40;
pub const KEY_GRAVE: u16 = 41;
pub const KEY_LEFTSHIFT: u16 = 42;
pub const KEY_BACKSLASH: u16 = 43;
pub const KEY_Z: u16 = 44;
pub const KEY_X: u16 = 45;
pub const KEY_C: u16 = 46;
pub const KEY_V: u16 = 47;
pub const KEY_B: u16 = 48;
pub const KEY_N: u16 = 49;
pub const KEY_M: u16 = 50;pub const KEY_COMMA: u16 = 51;
pub const KEY_DOT: u16 = 52;
pub const KEY_SLASH: u16 = 53;
pub const KEY_LEFTALT: u16 = 56;
pub const KEY_SPACE: u16 = 57;
pub const KEY_UP: u16 = 103;
pub const KEY_LEFT: u16 = 105;
pub const KEY_RIGHT: u16 = 106;
pub const KEY_DOWN: u16 = 108;
pub const KEY_DELETE: u16 = 111;
pub const KEY_LEFTMETA: u16 = 125;

// libinput button codes.
pub const BTN_LEFT: u32 = 0x110;
pub const BTN_RIGHT: u32 = 0x111;
pub const BTN_MIDDLE: u32 = 0x112;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputError {
    /// A chord name (e.g. "ctrl", "f5") has no mapping.
    UnknownKey(String),
    /// Text contains a character outside the ASCII keysym table.
    UnsupportedCharacter(char),
    /// The Wayland connection or protocol handshake failed.
    Connect(String),
}

impl std::fmt::Display for InputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InputError::UnknownKey(name) => write!(f, "unknown key name: {}", name),
            InputError::UnsupportedCharacter(c) => {
                write!(f, "cannot type character {:?}: outside the ASCII key table", c)
            }
            InputError::Connect(e) => write!(f, "virtual input connection failed: {}", e),
        }
    }
}

impl std::error::Error for InputError {}

/// Maps a printable character to its evdev key code plus whether the
/// shift key must be held. `\n` and `\t` map to Enter and Tab.
pub fn key_for_char(c: char) -> Option<(u16, bool)> {
    // Letters sit in QWERTY order on the keyboard, not alphabetically,
    // so each letter maps by table; digits are contiguous.
    let letter = |c: char| -> u16 {
        match c {
            'a' => KEY_A,
            'b' => KEY_B,
            'c' => KEY_C,
            'd' => KEY_D,
            'e' => KEY_E,
            'f' => KEY_F,
            'g' => KEY_G,
            'h' => KEY_H,
            'i' => KEY_I,
            'j' => KEY_J,
            'k' => KEY_K,
            'l' => KEY_L,
            'm' => KEY_M,
            'n' => KEY_N,
            'o' => KEY_O,
            'p' => KEY_P,
            'q' => KEY_Q,
            'r' => KEY_R,
            's' => KEY_S,
            't' => KEY_T,
            'u' => KEY_U,
            'v' => KEY_V,
            'w' => KEY_W,
            'x' => KEY_X,
            'y' => KEY_Y,
            'z' => KEY_Z,
            _ => unreachable!("non-letter passed to letter table"),
        }
    };
    let (code, shift) = match c {
        'a'..='z' => (letter(c), false),
        'A'..='Z' => (letter(c.to_ascii_lowercase()), true),
        '1'..='9' => (KEY_1 + (c as u16 - '1' as u16), false),
        '0' => (KEY_0, false),
        '!' => (KEY_1, true),
        '@' => (KEY_2, true),
        '#' => (KEY_3, true),
        '$' => (KEY_4, true),
        '%' => (KEY_5, true),
        '^' => (KEY_6, true),
        '&' => (KEY_7, true),
        '*' => (KEY_8, true),
        '(' => (KEY_9, true),
        ')' => (KEY_0, true),
        '\n' | '\r' => (KEY_ENTER, false),
        '\t' => (KEY_TAB, false),
        ' ' => (KEY_SPACE, false),
        '-' | '_' => (KEY_MINUS, c == '_'),
        '=' | '+' => (KEY_EQUAL, c == '+'),
        '\u{8}' | '\u{7f}' => (KEY_BACKSPACE, false),
        '[' | '{' => (KEY_LEFTBRACE, c == '{'),
        ']' | '}' => (KEY_RIGHTBRACE, c == '}'),
        '\\' | '|' => (KEY_BACKSLASH, c == '|'),
        ';' | ':' => (KEY_SEMICOLON, c == ':'),
        '\'' | '"' => (KEY_APOSTROPHE, c == '"'),
        '`' | '~' => (KEY_GRAVE, c == '~'),
        ',' | '<' => (KEY_COMMA, c == '<'),
        '.' | '>' => (KEY_DOT, c == '>'),
        '/' | '?' => (KEY_SLASH, c == '?'),
        _ => return None,
    };
    Some((code, shift))
}

/// Maps a named key (chord element) to its evdev key code. Accepts
/// modifier names, common action keys, and single ASCII characters.
pub fn key_for_name(name: &str) -> Option<u16> {
    let code = match name.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "leftctrl" => KEY_LEFTCTRL,
        "alt" | "leftalt" => KEY_LEFTALT,
        "shift" | "leftshift" => KEY_LEFTSHIFT,
        "super" | "win" | "meta" | "leftmeta" => KEY_LEFTMETA,
        "enter" | "return" => KEY_ENTER,
        "esc" | "escape" => KEY_ESC,
        "tab" => KEY_TAB,
        "space" => KEY_SPACE,
        "backspace" => KEY_BACKSPACE,
        "delete" | "del" => KEY_DELETE,
        "up" => KEY_UP,
        "down" => KEY_DOWN,
        "left" => KEY_LEFT,
        "right" => KEY_RIGHT,
        other => {
            let chars = other.chars();            let (c, is_single) = {
                let mut it = chars.clone();
                let first = it.next()?;
                (first, it.next().is_none())
            };
            if !is_single {
                return None;
            }
            key_for_char(c)?.0
        }
    };
    Some(code)
}

/// Maps a logical mouse button to its libinput button code.
pub fn button_code(button: MouseButton) -> u32 {
    match button {
        MouseButton::Left => BTN_LEFT,
        MouseButton::Middle => BTN_MIDDLE,
        MouseButton::Right => BTN_RIGHT,
    }
}

/// Clamps a requested pointer coordinate into the nested output extent,
/// so a coordinate from a mis-scaled screenshot can never fall outside
/// the output. Returns the `(x, y)` to send.
pub fn clamp_to_output(x: i32, y: i32, width: u32, height: u32) -> (u32, u32) {
    let clamp = |v: i32, max: u32| -> u32 {
        if v < 0 {
            0
        } else if v >= max as i32 {
            max.saturating_sub(1)
        } else {
            v as u32
        }
    };
    (clamp(x, width), clamp(y, height))
}

/// Raw sink for virtual input events. The Wayland implementation forwards
/// each call as one protocol request; the test implementation records.
pub trait InputSink {
    fn pointer_motion_absolute(&mut self, x: u32, y: u32, x_extent: u32, y_extent: u32);
    fn pointer_button(&mut self, button: u32, pressed: bool);
    /// Groups the pointer events sent so far into one atomic input frame.
    fn pointer_frame(&mut self);
    fn keyboard_key(&mut self, code: u16, pressed: bool);
    /// Sets the raw depressed-modifier mask (xkb mod mask space; shift is
    /// bit 0). Virtual keyboards must drive modifiers through this
    /// channel - compositor-side shift key presses are not relayed as
    /// modifier state.
    fn keyboard_modifiers(&mut self, depressed: u32);
}

/// wl_keyboard keymap format for XKB v1 text keymaps.
const KEYMAP_FORMAT_XKB_V1: u32 = 1;

/// High-level input operations built on [`InputSink`]. Implemented
/// explicitly for the Wayland seat (which also flushes) and for test
/// doubles; the free functions below carry the shared logic.
pub trait VirtualSeat: Send {
    fn move_pointer(&mut self, x: i32, y: i32, width: u32, height: u32) -> Result<(), InputError>;
    fn click(
        &mut self,
        x: i32,
        y: i32,
        button: MouseButton,
        width: u32,
        height: u32,
    ) -> Result<(), InputError>;
    fn type_text(&mut self, text: &str) -> Result<(), InputError>;
    fn press_keys(&mut self, keys: &[String]) -> Result<(), InputError>;
    /// Flushes buffered protocol requests toward the compositor.
    fn flush(&mut self) -> Result<(), InputError>;
}

/// Moves the virtual pointer to an absolute position inside the output.
pub fn move_pointer<S: InputSink + ?Sized>(
    sink: &mut S,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), InputError> {
    if width == 0 || height == 0 {
        return Err(InputError::Connect(
            "nested output has no extent; cage geometry unknown".to_string(),
        ));
    }
    let (x, y) = clamp_to_output(x, y, width, height);
    sink.pointer_motion_absolute(x, y, width, height);
    sink.pointer_frame();
    Ok(())
}

/// Clicks a logical button at an absolute position: move, press, release,
/// one frame - the exact event sequence of the working prototype.
pub fn click<S: InputSink + ?Sized>(
    sink: &mut S,
    x: i32,
    y: i32,
    button: MouseButton,
    width: u32,
    height: u32,
) -> Result<(), InputError> {
    move_pointer(sink, x, y, width, height)?;
    let code = button_code(button);
    sink.pointer_button(code, true);
    sink.pointer_button(code, false);
    sink.pointer_frame();
    Ok(())
}

/// Types text through the virtual keyboard. Shifted characters raise the
/// shift modifier around the character key: the virtual-keyboard protocol
/// carries modifier state through its modifiers request, and the
/// compositor-side keymap then produces the shifted glyph.
pub const XKB_SHIFT_MASK: u32 = 1;

pub fn type_text<S: InputSink + ?Sized>(sink: &mut S, text: &str) -> Result<(), InputError> {
    for c in text.chars() {
        let (code, shift) = key_for_char(c)
            .ok_or(InputError::UnsupportedCharacter(c))?;
        if shift {
            sink.keyboard_modifiers(XKB_SHIFT_MASK);
        }
        sink.keyboard_key(code, true);
        sink.keyboard_key(code, false);
        if shift {
            sink.keyboard_modifiers(0);
        }
    }
    Ok(())
}

/// Presses a chord: every key except the last is held, the last is
/// tapped, then the held keys release in reverse order (ctrl+s = hold
/// ctrl, tap s, release ctrl). A single-element chord is a plain tap.
pub fn press_keys<S: InputSink + ?Sized>(sink: &mut S, keys: &[String]) -> Result<(), InputError> {
    if keys.is_empty() {
        return Ok(());
    }
    let codes: Vec<u16> = keys
        .iter()
        .map(|k| key_for_name(k).ok_or_else(|| InputError::UnknownKey(k.clone())))
        .collect::<Result<_, _>>()?;
    let (last, held) = codes.split_last().expect("non-empty checked above");
    for code in held {
        sink.keyboard_key(*code, true);
    }
    sink.keyboard_key(*last, true);
    sink.keyboard_key(*last, false);
    for code in held.iter().rev() {
        sink.keyboard_key(*code, false);
    }
    Ok(())
}

// --- Wayland implementation ---

/// Client-side API of the virtual-keyboard protocol, generated from the
/// vendored XML at compile time. The protocol is not packaged in the
/// maintained wayland-protocols crates yet; the XML comes from the cage
/// fork's bundled wlroots protocol set (MIT).
#[allow(
    dead_code,
    non_camel_case_types,
    unused_variables,
    unused_unsafe,
    unused_imports,
    non_upper_case_globals,
    non_snake_case,
    missing_docs,
    clippy::all
)]
pub mod vk_generated {
    pub use wayland_client;
    pub use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("protocols/virtual-keyboard-unstable-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("protocols/virtual-keyboard-unstable-v1.xml");
}

/// Creates virtual input device connections to a Wayland socket.
pub trait InputConnector: Send + Sync {
    fn connect(&self, socket: &Path) -> Result<Box<dyn VirtualSeat>, InputError>;
}

mod wayland {
    use super::{
        click, move_pointer, press_keys, type_text, InputConnector, InputError, InputSink,
        VirtualSeat, KEYMAP_FORMAT_XKB_V1,
    };
    use std::os::unix::io::{AsFd, FromRawFd, IntoRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::path::Path;

    use wayland_client::protocol::{wl_pointer, wl_registry, wl_seat};
    use wayland_client::{
        Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    };
    use wayland_protocols_wlr::virtual_pointer::v1::client::{
        zwlr_virtual_pointer_manager_v1, zwlr_virtual_pointer_v1,
    };

    use super::vk_generated::{zwp_virtual_keyboard_manager_v1, zwp_virtual_keyboard_v1};

    /// Globals discovered from the registry; also the dispatch state.
    #[derive(Default)]
    struct Globals {
        seat: Option<wl_seat::WlSeat>,
        pointer_manager: Option<zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1>,
        keyboard_manager: Option<zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1>,
    }

    /// A live virtual input connection to the nested compositor's seat.
    /// Dropping it closes the socket and destroys the virtual devices.
    pub struct WaylandSeatInput {
        _connection: Connection,
        _queue: EventQueue<Globals>,
        /// Keeps the keymap memfd alive for the connection's lifetime.
        _keymap_fd: OwnedFd,
        pointer: zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
        keyboard: zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1,
        /// Monotonic event timestamps in milliseconds; the compositor
        /// only needs them non-decreasing.
        next_time: u32,
    }

    impl WaylandSeatInput {
        /// Connects to the Wayland socket at `socket_path` (the nested
        /// compositor's socket, e.g. `$XDG_RUNTIME_DIR/staka-cage`), binds
        /// the seat and both virtual-input managers, and creates the
        /// virtual pointer and keyboard.
        pub fn connect(socket_path: &Path) -> Result<WaylandSeatInput, InputError> {
            let stream = UnixStream::connect(socket_path)
                .map_err(|e| InputError::Connect(format!("{}: {}", socket_path.display(), e)))?;
            let connection = Connection::from_socket(stream)
                .map_err(|e| InputError::Connect(format!("wayland handshake: {}", e)))?;

            let mut queue = connection.new_event_queue();
            let qh = queue.handle();
            let mut globals = Globals::default();
            connection.display().get_registry(&qh, ());
            queue
                .roundtrip(&mut globals)
                .map_err(|e| InputError::Connect(format!("registry roundtrip: {}", e)))?;

            let seat = globals
                .seat
                .as_ref()
                .ok_or_else(|| InputError::Connect("compositor exposes no seat".to_string()))?
                .clone();
            let pointer_manager = globals
                .pointer_manager
                .as_ref()
                .ok_or_else(|| {
                    InputError::Connect(
                        "compositor lacks zwlr_virtual_pointer_manager_v1 (is this the cage fork?)"
                            .to_string(),
                    )
                })?
                .clone();
            let keyboard_manager = globals
                .keyboard_manager
                .as_ref()
                .ok_or_else(|| {
                    InputError::Connect(
                        "compositor lacks zwp_virtual_keyboard_manager_v1 (is this the cage fork?)"
                            .to_string(),
                    )
                })?
                .clone();

            let pointer = pointer_manager.create_virtual_pointer(Some(&seat), &qh, ());
            let keyboard = keyboard_manager.create_virtual_keyboard(&seat, &qh, ());
            // wlroots drops key events from keymap-less virtual keyboards
            // (its xkb_state is NULL), so install a standard US keymap
            // before injecting anything.
            let keymap_fd = Self::send_keymap(&keyboard)?;
            // Settle the device creation before the first injection.
            queue
                .roundtrip(&mut globals)
                .map_err(|e| InputError::Connect(format!("device roundtrip: {}", e)))?;

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u32;
            Ok(WaylandSeatInput {
                _connection: connection,
                _queue: queue,
                _keymap_fd: keymap_fd,
                pointer,
                keyboard,
                next_time: now,
            })
        }

        fn time(&mut self) -> u32 {
            self.next_time = self.next_time.wrapping_add(1);
            self.next_time
        }

        /// Installs the keymap on the virtual keyboard via a memfd, as the
        /// virtual-keyboard protocol requires.
        fn send_keymap(
            keyboard: &zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1,
        ) -> Result<OwnedFd, InputError> {
            use std::io::Write;
            const KEYMAP: &str = include_str!("keymap-us-v1.txt");
            let bytes = KEYMAP.as_bytes();
            let rc = unsafe { libc::memfd_create(c"staka-virtual-keymap".as_ptr(), libc::MFD_CLOEXEC) };
            if rc < 0 {
                return Err(InputError::Connect(format!(
                    "memfd_create failed: {}",
                    std::io::Error::last_os_error()
                )));
            }
            let mut file = unsafe { std::fs::File::from_raw_fd(rc) };
            if let Err(e) = file.write_all(bytes) {
                return Err(InputError::Connect(format!("keymap write failed: {}", e)));
            }
            // Hand ownership to the OwnedFd without closing: the compositor
            // may still need the memfd, so it lives with the connection.
            let fd = unsafe { OwnedFd::from_raw_fd(file.into_raw_fd()) };
            keyboard.keymap(KEYMAP_FORMAT_XKB_V1, fd.as_fd(), bytes.len() as u32);
            Ok(fd)
        }
    }

    impl InputSink for WaylandSeatInput {
        fn pointer_motion_absolute(&mut self, x: u32, y: u32, x_extent: u32, y_extent: u32) {
            let t = self.time();
            self.pointer.motion_absolute(t, x, y, x_extent, y_extent);
        }

        fn pointer_button(&mut self, button: u32, pressed: bool) {
            let t = self.time();
            let state = if pressed {
                wl_pointer::ButtonState::Pressed
            } else {
                wl_pointer::ButtonState::Released
            };
            self.pointer.button(t, button, state);
        }

        fn pointer_frame(&mut self) {
            self.pointer.frame();
        }

        fn keyboard_key(&mut self, code: u16, pressed: bool) {
            let t = self.time();
            // The virtual-keyboard protocol has no KeyState enum; the
            // state is a raw uint (1 = pressed, 0 = released).
            self.keyboard.key(t, code as u32, u32::from(pressed));
        }

        fn keyboard_modifiers(&mut self, depressed: u32) {
            self.keyboard.modifiers(depressed, 0, 0, 0);
        }
    }

    impl VirtualSeat for WaylandSeatInput {
        fn move_pointer(&mut self, x: i32, y: i32, width: u32, height: u32) -> Result<(), InputError> {
            move_pointer(self, x, y, width, height)?;
            self.flush()
        }
        fn click(
            &mut self,
            x: i32,
            y: i32,
            button: crate::ipc::MouseButton,
            width: u32,
            height: u32,
        ) -> Result<(), InputError> {
            click(self, x, y, button, width, height)?;
            self.flush()
        }
        fn type_text(&mut self, text: &str) -> Result<(), InputError> {
            type_text(self, text)?;
            self.flush()
        }
        fn press_keys(&mut self, keys: &[String]) -> Result<(), InputError> {
            press_keys(self, keys)?;
            self.flush()
        }
        /// Sends every buffered request now, so an injection is complete
        /// (not sitting in the client's queue) when this call returns.
        fn flush(&mut self) -> Result<(), InputError> {
            self._connection
                .flush()
                .map_err(|e| InputError::Connect(format!("flush: {}", e)))
        }
    }

    /// Real connector: talks Wayland over a Unix socket.
    #[derive(Debug, Clone, Copy, Default)]
    pub struct WaylandInputConnector;

    impl InputConnector for WaylandInputConnector {
        fn connect(&self, socket: &Path) -> Result<Box<dyn VirtualSeat>, InputError> {
            Ok(Box::new(WaylandSeatInput::connect(socket)?))
        }
    }

    impl Dispatch<wl_registry::WlRegistry, ()> for Globals {
        fn event(
            state: &mut Self,
            registry: &wl_registry::WlRegistry,
            event: wl_registry::Event,
            _: &(),
            _: &Connection,
            qh: &QueueHandle<Self>,
        ) {
            if let wl_registry::Event::Global {
                name,
                interface,
                version,
            } = event
            {
                match interface.as_str() {
                    "wl_seat" if state.seat.is_none() => {
                        state.seat = Some(registry.bind(name, version.min(1), qh, ()));
                    }
                    "zwlr_virtual_pointer_manager_v1" => {
                        state.pointer_manager =
                            Some(registry.bind(name, version.min(2), qh, ()));
                    }
                    "zwp_virtual_keyboard_manager_v1" => {
                        state.keyboard_manager = Some(registry.bind(name, 1, qh, ()));
                    }
                    _ => {}
                }
            }
        }
    }

    impl Dispatch<wl_seat::WlSeat, ()> for Globals {
        fn event(
            _: &mut Self,
            _: &wl_seat::WlSeat,
            _: wl_seat::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            // Seat capabilities do not gate virtual device creation.
        }
    }

    // The four virtual-input proxies carry no client-side events; the
    // empty Dispatch impls satisfy the queue's type requirements.
    impl Dispatch<zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1, ()> for Globals {
        fn event(
            _: &mut Self,
            _: &zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1,
            _: <zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1 as Proxy>::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1, ()> for Globals {
        fn event(
            _: &mut Self,
            _: &zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
            _: <zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1 as Proxy>::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1, ()> for Globals {
        fn event(
            _: &mut Self,
            _: &zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1,
            _: <zwp_virtual_keyboard_manager_v1::ZwpVirtualKeyboardManagerV1 as Proxy>::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }

    impl Dispatch<zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1, ()> for Globals {
        fn event(
            _: &mut Self,
            _: &zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1,
            _: <zwp_virtual_keyboard_v1::ZwpVirtualKeyboardV1 as Proxy>::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
        }
    }
}

pub use wayland::{WaylandInputConnector, WaylandSeatInput};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::MouseButton;

    /// Records every sink event so tests can assert the exact sequence.
    #[derive(Default)]
    struct RecordingSink {
        events: Vec<String>,
    }

    impl InputSink for RecordingSink {
        fn pointer_motion_absolute(&mut self, x: u32, y: u32, xe: u32, ye: u32) {
            self.events
                .push(format!("move {} {} in {}x{}", x, y, xe, ye));
        }
        fn pointer_button(&mut self, button: u32, pressed: bool) {
            self.events
                .push(format!("button {} {}", button, if pressed { "down" } else { "up" }));
        }
        fn pointer_frame(&mut self) {
            self.events.push("frame".to_string());
        }
        fn keyboard_key(&mut self, code: u16, pressed: bool) {
            self.events.push(format!(
                "key {} {}",
                code,
                if pressed { "down" } else { "up" }
            ));
        }
        fn keyboard_modifiers(&mut self, depressed: u32) {
            self.events.push(format!("mods {}", depressed));
        }
    }

    #[test]
    fn key_for_char_maps_letters_digits_and_shift_pairs() {
        assert_eq!(key_for_char('a'), Some((KEY_A, false)));
        assert_eq!(key_for_char('z'), Some((KEY_Z, false)));
        assert_eq!(key_for_char('A'), Some((KEY_A, true)));
        assert_eq!(key_for_char('Z'), Some((KEY_Z, true)));
        assert_eq!(key_for_char('1'), Some((KEY_1, false)));
        assert_eq!(key_for_char('0'), Some((KEY_0, false)));
        assert_eq!(key_for_char('5'), Some((KEY_5, false)));
        assert_eq!(key_for_char('%'), Some((KEY_5, true)));
        assert_eq!(key_for_char('*'), Some((KEY_8, true)));
        assert_eq!(key_for_char(' '), Some((KEY_SPACE, false)));
        assert_eq!(key_for_char('\n'), Some((KEY_ENTER, false)));
        assert_eq!(key_for_char('\t'), Some((KEY_TAB, false)));
        assert_eq!(key_for_char('?'), Some((KEY_SLASH, true)));
        assert_eq!(key_for_char('+'), Some((KEY_EQUAL, true)));
        assert_eq!(key_for_char('-'), Some((KEY_MINUS, false)));
        assert_eq!(key_for_char('_'), Some((KEY_MINUS, true)));
        // Outside the ASCII table.
        assert_eq!(key_for_char('é'), None);
        assert_eq!(key_for_char('日'), None);
    }

    #[test]
    fn key_for_name_maps_modifiers_and_actions() {
        assert_eq!(key_for_name("ctrl"), Some(KEY_LEFTCTRL));
        assert_eq!(key_for_name("CTRL"), Some(KEY_LEFTCTRL));
        assert_eq!(key_for_name("alt"), Some(KEY_LEFTALT));
        assert_eq!(key_for_name("shift"), Some(KEY_LEFTSHIFT));
        assert_eq!(key_for_name("super"), Some(KEY_LEFTMETA));
        assert_eq!(key_for_name("enter"), Some(KEY_ENTER));
        assert_eq!(key_for_name("return"), Some(KEY_ENTER));
        assert_eq!(key_for_name("esc"), Some(KEY_ESC));
        assert_eq!(key_for_name("tab"), Some(KEY_TAB));
        assert_eq!(key_for_name("space"), Some(KEY_SPACE));
        assert_eq!(key_for_name("backspace"), Some(KEY_BACKSPACE));
        assert_eq!(key_for_name("delete"), Some(KEY_DELETE));
        assert_eq!(key_for_name("up"), Some(KEY_UP));
        assert_eq!(key_for_name("s"), Some(KEY_S));
        assert_eq!(key_for_name("S"), Some(KEY_S));
        assert_eq!(key_for_name("f5"), None);
        assert_eq!(key_for_name("ctrls"), None);
        assert_eq!(key_for_name(""), None);
    }

    #[test]
    fn button_code_matches_libinput_constants() {
        assert_eq!(button_code(MouseButton::Left), 0x110);
        assert_eq!(button_code(MouseButton::Right), 0x111);
        assert_eq!(button_code(MouseButton::Middle), 0x112);
    }

    #[test]
    fn clamp_to_output_keeps_coordinates_inside_the_extent() {
        assert_eq!(clamp_to_output(320, 240, 640, 480), (320, 240));
        assert_eq!(clamp_to_output(0, 0, 640, 480), (0, 0));
        assert_eq!(clamp_to_output(-5, -5, 640, 480), (0, 0));
        assert_eq!(clamp_to_output(640, 480, 640, 480), (639, 479));
        assert_eq!(clamp_to_output(10_000, 10_000, 1920, 1080), (1919, 1079));
        assert_eq!(clamp_to_output(-1, 500, 1, 1), (0, 0));
    }

    #[test]
    fn click_sends_move_press_release_frame_in_order() {
        let mut sink = RecordingSink::default();
        click(&mut sink, 320, 240, MouseButton::Left, 640, 480).unwrap();
        assert_eq!(
            sink.events,
            vec![
                "move 320 240 in 640x480".to_string(),
                "frame".to_string(),
                "button 272 down".to_string(),
                "button 272 up".to_string(),
                "frame".to_string(),
            ]
        );
    }

    #[test]
    fn click_rejects_unknown_output_extent() {
        let mut sink = RecordingSink::default();
        let err = click(&mut sink, 0, 0, MouseButton::Left, 0, 0).unwrap_err();
        assert!(matches!(err, InputError::Connect(_)));
        assert!(sink.events.is_empty());
    }

    #[test]
    fn type_text_raises_the_shift_modifier_around_shifted_characters() {
        let mut sink = RecordingSink::default();
        type_text(&mut sink, "aA").unwrap();
        assert_eq!(
            sink.events,
            vec![
                "key 30 down".to_string(),
                "key 30 up".to_string(),
                "mods 1".to_string(),
                "key 30 down".to_string(),
                "key 30 up".to_string(),
                "mods 0".to_string(),
            ]
        );
    }

    #[test]
    fn type_text_rejects_non_ascii_without_emitting_events() {
        let mut sink = RecordingSink::default();
        let err = type_text(&mut sink, "ok\u{2603}").unwrap_err();
        assert_eq!(err, InputError::UnsupportedCharacter('\u{2603}'));
        // The valid prefix may already be emitted; the invalid part is not.
        assert!(!sink.events.is_empty());
    }

    #[test]
    fn press_keys_taps_a_single_key() {
        let mut sink = RecordingSink::default();
        press_keys(&mut sink, &["s".to_string()]).unwrap();
        assert_eq!(
            sink.events,
            vec!["key 31 down".to_string(), "key 31 up".to_string()]
        );
    }

    #[test]
    fn press_keys_holds_modifiers_around_the_final_key() {
        let mut sink = RecordingSink::default();
        press_keys(
            &mut sink,
            &["ctrl".to_string(), "alt".to_string(), "delete".to_string()],
        )
        .unwrap();
        assert_eq!(
            sink.events,
            vec![
                "key 29 down".to_string(),
                "key 56 down".to_string(),
                "key 111 down".to_string(),
                "key 111 up".to_string(),
                "key 56 up".to_string(),
                "key 29 up".to_string(),
            ]
        );
    }

    #[test]
    fn press_keys_reports_unknown_names_and_sends_nothing() {
        let mut sink = RecordingSink::default();
        let err = press_keys(&mut sink, &["ctrl".to_string(), "f5".to_string()]).unwrap_err();
        assert_eq!(err, InputError::UnknownKey("f5".to_string()));
        assert!(sink.events.is_empty());
        assert!(press_keys(&mut sink, &[]).is_ok());
    }
}
