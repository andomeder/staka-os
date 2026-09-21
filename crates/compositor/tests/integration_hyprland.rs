//! Integration tests that need a live Hyprland session (hyprctl on PATH and
//! HYPRLAND_INSTANCE_SIGNATURE set). Gated behind the `integration` feature:
//!
//! ```sh
//! cargo test --features integration --test integration_hyprland
//! ```
//!
//! Run them from inside a Hyprland session. They create and remove one
//! headless output, which is safe: the output is invisible and removed on
//! teardown.
//!
//! The nested-compositor tests additionally need a cage binary. They only
//! run when `STAKA_CAGE_BIN` points at one; otherwise they report a skip.
//! The injection test runs the target app from `STAKA_CAGE_APP`
//! (default `foot`).

#![cfg(feature = "integration")]

use std::sync::Mutex;
use std::time::Duration;

use staka_compositor::cage::{cage_socket_path, CageConfig, CageSession, SystemSpawner};
use staka_compositor::hyprctl::{is_headless, HyprCtl};
use staka_compositor::input::WaylandInputConnector;
use staka_compositor::ipc::{Command, Request};
use staka_compositor::server::ServerState;
use staka_compositor::screencopy::{capture_png, GrimCapture};
use staka_compositor::workspace::{LayoutSnapshot, WorkspaceManager, AGENT_WORKSPACE_PREFIX};

/// The tests share one live Hyprland session, so they must not create or
/// remove headless outputs concurrently.
static LIVE_SESSION: Mutex<()> = Mutex::new(());

fn hyprctl() -> HyprCtl {
    HyprCtl::system()
}

#[test]
fn hyprland_answers_monitors() {
    let _session = LIVE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
    hyprctl().health_check().expect("hyprctl health check");
}

#[test]
fn headless_output_lifecycle() {
    let _session = LIVE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
    let ctl = hyprctl();

    let before: Vec<String> = ctl
        .list_outputs()
        .expect("list outputs")
        .into_iter()
        .map(|m| m.name)
        .collect();

    let created = ctl.create_headless_output().expect("create headless output");
    assert!(is_headless(&created));
    assert!(!before.contains(&created));

    let after: Vec<String> = ctl
        .list_outputs()
        .expect("list outputs after create")
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert!(after.contains(&created), "{} missing after create", created);

    ctl.remove_output(&created).expect("remove headless output");

    let final_list: Vec<String> = ctl
        .list_outputs()
        .expect("list outputs after remove")
        .into_iter()
        .map(|m| m.name)
        .collect();
    assert!(
        !final_list.contains(&created),
        "{} still present after remove",
        created
    );
}

#[test]
fn screencopy_of_headless_output_returns_png() {
    let _session = LIVE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
    let ctl = hyprctl();
    let created = ctl.create_headless_output().expect("create headless output");

    let captured = capture_png(&GrimCapture::default(), &created);
    ctl.remove_output(&created).expect("remove headless output");

    let png = captured.expect("grim capture of the headless output");
    assert!(staka_compositor::screencopy::is_png(&png));
    // A headless output defaults to a real resolution; a few-KB empty
    // capture still encodes a header with those dimensions.
    assert!(png.len() > 100, "capture suspiciously small: {} bytes", png.len());
}

#[test]
fn agent_workspace_selection_avoids_live_workspaces() {
    let _session = LIVE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
    let ctl = hyprctl();
    let manager = WorkspaceManager::new(&ctl);

    let name = manager.select().expect("select agent workspace");
    assert!(name.starts_with(AGENT_WORKSPACE_PREFIX));
    assert!(!name.parse::<i64>().is_ok(), "agent workspace must be named, not numeric");

    // Nothing was created or moved by selection alone.
    let workspaces = ctl.list_workspaces().expect("list workspaces");
    assert!(!workspaces.iter().any(|w| w.name == name));
}

/// Full nested-compositor lifecycle against the live session. Needs a cage
/// binary in STAKA_CAGE_BIN (see vendor/cage for how to build one); skips
/// with a printed note otherwise.
#[test]
fn cage_lifecycle_on_headless_output() {
    let _session = LIVE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(cage_bin) = std::env::var("STAKA_CAGE_BIN") else {
        eprintln!("skip: set STAKA_CAGE_BIN to a cage binary to run this test");
        return;
    };

    let ctl = hyprctl();
    let manager = WorkspaceManager::new(&ctl);

    let before_users: Vec<(String, String)> = ctl
        .list_workspaces()
        .expect("list workspaces before")
        .into_iter()
        .map(|w| (w.name, w.monitor))
        .collect();

    let mut snapshot = LayoutSnapshot::default();
    for (name, monitor) in &before_users {
        snapshot.workspaces.push(staka_compositor::workspace::WorkspaceLayout {
            name: name.clone(),
            monitor: monitor.clone(),
        });
    }

    let output = ctl.create_headless_output().expect("create headless output");
    // Creating the output makes Hyprland grab a workspace for it
    // immediately. Mirror the driver: adopt it when fresh, otherwise give
    // it back after the agent workspace is pinned.
    let adopted = manager
        .adopt_grabbed_workspace(&snapshot, &output)
        .expect("adopt grabbed workspace");
    let workspace = match &adopted {
        Some(name) => name.clone(),
        None => manager.select().expect("select workspace"),
    };
    assert!(workspace.starts_with(AGENT_WORKSPACE_PREFIX));
    // A panicking test must not leave the invisible output behind.
    struct OutputGuard<'a, C: staka_compositor::hyprctl::CommandRunner> {
        ctl: &'a HyprCtl<C>,
        output: String,
    }
    impl<'a, C: staka_compositor::hyprctl::CommandRunner> Drop for OutputGuard<'a, C> {
        fn drop(&mut self) {
            let _ = self.ctl.remove_output(&self.output);
        }
    }
    let _guard = OutputGuard { ctl: &ctl, output: output.clone() };

    // cage creates its socket in the session runtime dir, like any
    // Wayland compositor.
    let runtime_dir = std::path::PathBuf::from(
        std::env::var("XDG_RUNTIME_DIR").expect("XDG_RUNTIME_DIR set inside Hyprland session"),
    );
    let socket_name = format!("staka-cage-it-{}", std::process::id());
    let wayland_display =
        std::env::var("WAYLAND_DISPLAY").expect("WAYLAND_DISPLAY set inside Hyprland session");

    let config = CageConfig {
        cage_binary: cage_bin.into(),
        socket_name: socket_name.clone(),
        socket_dir: runtime_dir.clone(),
        wayland_display,
        app: "sleep 60".to_string(),
        ..Default::default()
    };
    let mut cage = CageSession::spawn(&SystemSpawner, &config).expect("spawn cage");
    assert!(cage_socket_path(&runtime_dir, &socket_name).exists());

    // Cage appears as a window in Hyprland; move it to a dedicated agent
    // workspace pinned to the headless output.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let address = loop {
        let clients = ctl.list_clients().expect("list clients");
        if let Some(c) = clients.iter().find(|c| c.pid == cage.pid) {
            break c.address.clone();
        }
        assert!(std::time::Instant::now() < deadline, "cage window never appeared");
        std::thread::sleep(Duration::from_millis(50));
    };
    let workspace_name = &workspace;
    manager.move_window(workspace_name, &address).expect("move window");
    if adopted.is_none() {
        manager.pin_to_output(workspace_name, &output).expect("pin workspace");
    }

    // The agent workspace occupies the headless output; give back any
    // workspace Hyprland grabbed and verify stability, exactly like the
    // driver does.
    let report = manager.settle(&snapshot, &output, 5).expect("settle layout");
    assert!(report.moved_back.is_empty() || adopted.is_none());

    let workspaces = ctl.list_workspaces().expect("list workspaces after settle");
    let agent_ws = workspaces.iter().find(|w| w.name == workspace).expect("agent workspace exists");
    assert_eq!(
        agent_ws.monitor, output,
        "agent workspace must sit on the headless output"
    );
    // No user workspace may remain on the headless output (the failure
    // mode the agent-workspace prefix prevents).
    for w in &workspaces {
        if w.name == workspace || was_headless_before(&before_users, &w.name) {
            continue;
        }
        assert!(
            !is_headless(&w.monitor),
            "user workspace {} ended up on the headless output",
            w.name
        );
    }

    // Capture the headless output; the cage window is on it now.
    let png = capture_png(&GrimCapture::default(), &output).expect("capture after cage");
    assert!(staka_compositor::screencopy::is_png(&png));

    // Teardown: kill cage, restore layout, remove output. The user's
    // workspaces must end up exactly where they started.
    cage.terminate().expect("terminate cage");

    let restored = manager.restore(&snapshot).expect("restore");
    assert!(restored.moved_back.is_empty(), "nothing should have moved");

    ctl.remove_output(&output).expect("remove output");

    let after: Vec<(String, String)> = ctl
        .list_workspaces()
        .expect("list workspaces after teardown")
        .into_iter()
        .map(|w| (w.name, w.monitor))
        .collect();
    for (name, monitor) in &before_users {
        let now = after.iter().find(|(n, _)| n == name);
        assert_eq!(
            now.map(|(_, m)| m),
            Some(monitor),
            "user workspace {} changed monitors across the lifecycle",
            name
        );
    }
}

fn was_headless_before(before: &[(String, String)], name: &str) -> bool {
    before
        .iter()
        .any(|(n, m)| n == name && is_headless(m))
}

// --- Virtual injection (driver-level, live) ---

/// Runs hyprctl directly and returns stdout.
fn hyprctl_raw(args: &[&str]) -> String {
    let out = std::process::Command::new("hyprctl")
        .args(args)
        .output()
        .expect("run hyprctl");
    assert!(out.status.success(), "hyprctl {:?} failed", args);
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Captures an output as raw PPM (grim -t ppm) so the test can diff
/// pixels without an image-decoding dependency.
fn capture_ppm(output: &str) -> (u32, u32, Vec<u8>) {
    let out = std::process::Command::new("grim")
        .args(["-o", output, "-t", "ppm", "-"])
        .output()
        .expect("run grim");
    assert!(out.status.success(), "grim capture of {} failed", output);
    parse_ppm(&out.stdout).expect("grim produced a valid P6 ppm")
}

fn parse_ppm(bytes: &[u8]) -> Option<(u32, u32, Vec<u8>)> {
    // P6 header: magic, whitespace, width, whitespace, height,
    // whitespace, maxval, single whitespace, then RGB triplets.
    let mut fields: Vec<u32> = Vec::new();
    let mut pos = 2usize; // skip "P6"
    while fields.len() < 3 {
        while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        let start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        if start == pos {
            return None;
        }
        fields.push(std::str::from_utf8(&bytes[start..pos]).ok()?.parse().ok()?);
    }
    pos += 1; // the single whitespace after maxval
    let (width, height, _max) = (fields[0], fields[1], fields[2]);
    Some((width, height, bytes[pos..].to_vec()))
}

/// Fraction of pixels that differ by more than a small epsilon between
/// two same-sized captures, ignoring the desktop bar rows at the top
/// (the bar carries a clock that can legitimately tick between frames).
fn differing_fraction(a: &[u8], b: &[u8], width: u32, skip_top_rows: u32) -> f64 {
    assert_eq!(a.len(), b.len(), "captures must have identical sizes");
    let start = (skip_top_rows * width * 3) as usize;
    let mut changed = 0u64;
    let mut total = 0u64;
    for (pa, pb) in a[start..].chunks_exact(3).zip(b[start..].chunks_exact(3)) {
        total += 1;
        if pa.iter().zip(pb.iter()).any(|(x, y)| x.abs_diff(*y) > 8) {
            changed += 1;
        }
    }
    changed as f64 / total.max(1) as f64
}

/// Drives the whole driver with a live cage: injects a click and typed
/// text into the caged app, verifies the app responded via screencopy
/// pixel diff, and verifies the user's physical seat was untouched
/// (cursor position and active window unchanged across the injection).
/// This is the thesis test: virtual input reaches cage's seat only.
#[test]
fn virtual_input_drives_the_caged_app_without_touching_the_user_seat() {
    let _session = LIVE_SESSION.lock().unwrap_or_else(|p| p.into_inner());
    let Ok(cage_bin) = std::env::var("STAKA_CAGE_BIN") else {
        eprintln!("skip: set STAKA_CAGE_BIN to a cage binary to run this test");
        return;
    };
    let app = std::env::var("STAKA_CAGE_APP").unwrap_or_else(|_| "foot".to_string());

    let runtime_dir = std::path::PathBuf::from(
        std::env::var("XDG_RUNTIME_DIR").expect("XDG_RUNTIME_DIR set inside Hyprland session"),
    );
    let server = ServerState::new(
        HyprCtl::system(),
        SystemSpawner,
        GrimCapture::default(),
        WaylandInputConnector,
        cage_bin,
        runtime_dir,
    );
    let request = |id: u64, cmd: Command| Request { id, command: cmd };

    /// Tears the session down even if an assertion fails, so a failed
    /// run never leaks the headless output, the cage process, or its
    /// socket (which would poison the next run).
    struct TeardownOnDrop<'a, C, S, G, I>
    where
        C: staka_compositor::hyprctl::CommandRunner,
        S: staka_compositor::cage::ProcessSpawner,
        G: staka_compositor::screencopy::CaptureRunner,
        I: staka_compositor::input::InputConnector,
    {
        server: &'a ServerState<C, S, G, I>,
    }
    impl<'a, C, S, G, I> Drop for TeardownOnDrop<'a, C, S, G, I>
    where
        C: staka_compositor::hyprctl::CommandRunner,
        S: staka_compositor::cage::ProcessSpawner,
        G: staka_compositor::screencopy::CaptureRunner,
        I: staka_compositor::input::InputConnector,
    {
        fn drop(&mut self) {
            let _ = self.server.handle(&Request {
                id: 0,
                command: Command::Teardown {},
            });
        }
    }

    let created = server.handle(&request(
        1,
        Command::CreateWorkspace { app: Some(app) },
    ));
    assert!(
        created.response.ok,
        "create_workspace failed: {:?}",
        created.response
    );
    let _guard = TeardownOnDrop { server: &server };
    let output = created.response.data.as_ref().unwrap()["output"]
        .as_str()
        .unwrap()
        .to_string();

    // Give the caged app time to draw its first frame.
    std::thread::sleep(Duration::from_secs(2));
    let (w, h, _) = capture_ppm(&output);
    assert_eq!((w, h), (1920, 1080), "nested output geometry");

    // Inject through the driver: click the middle of the nested output,
    // then type text and press enter so the app renders new content. If
    // the human moved the physical cursor during the check window, the
    // attempt is retried once (an idle seat is required for the strict
    // isolation assertion to be meaningful).
    let mut isolated = false;
    let mut last_cursor_change: Option<(String, String)> = None;
    for attempt in 0..2 {
        // Wait for the physical seat to be idle before baselining.
        loop {
            let a = hyprctl_raw(&["cursorpos"]);
            std::thread::sleep(Duration::from_millis(500));
            if a == hyprctl_raw(&["cursorpos"]) {
                break;
            }
        }
        let cursor_before = hyprctl_raw(&["cursorpos"]);
        let active_before = hyprctl_raw(&["activewindow", "-j"]);
        let (before_w, _, before_px) = capture_ppm(&output);

        for (id, cmd) in [
            (
                2,
                Command::Click {
                    x: 960,
                    y: 540,
                    button: staka_compositor::ipc::MouseButton::Left,
                },
            ),
            (
                3,
                Command::TypeText {
                    text: "for i in 1 2 3; do echo staka-injection-ok-$i; done".to_string(),
                },
            ),
            (
                4,
                Command::PressKeys {
                    keys: vec!["enter".to_string()],
                },
            ),
        ] {
            let handled = server.handle(&request(id, cmd));
            assert!(
                handled.response.ok,
                "injection command {} failed: {:?}",
                id, handled.response
            );
        }
        std::thread::sleep(Duration::from_millis(900));

        let (_, _, after_px) = capture_ppm(&output);
        let changed = differing_fraction(&before_px, &after_px, before_w, 40);
        // The typed command, its output, and the shifted prompt line
        // change a fraction of a percent of the 1920x1080 frame; noise
        // (cursor blink) is an order of magnitude below that.
        assert!(
            changed > 0.001,
            "caged app did not visibly respond to virtual input; only {} of pixels changed",
            changed
        );

        let cursor_after_injection = hyprctl_raw(&["cursorpos"]);
        if cursor_after_injection == cursor_before {
            // The seat stayed put through the injection; the user's
            // focused window must be untouched as well.
            assert_eq!(
                active_before,
                hyprctl_raw(&["activewindow", "-j"]),
                "user active window changed during virtual injection"
            );
            isolated = true;
            break;
        }
        last_cursor_change = Some((cursor_before.clone(), cursor_after_injection.clone()));
        eprintln!(
            "attempt {}: physical cursor moved during injection ({} -> {}); \
             retrying with an idle-seat check",
            attempt, cursor_before, cursor_after_injection
        );
    }
    assert!(
        isolated,
        "user cursor moved during virtual injection: {:?}",
        last_cursor_change
    );

    let torn = server.handle(&request(5, Command::Teardown {}));
    assert!(torn.response.ok, "teardown failed: {:?}", torn.response);
}
