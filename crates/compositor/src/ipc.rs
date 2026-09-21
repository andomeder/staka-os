//! Length-prefixed frame protocol for the Unix socket between the agent and
//! the compositor driver, plus the JSON control message types.
//!
//! Frame layout (same on the wire in both directions):
//!
//! ```text
//! [1 byte type][4 bytes big-endian payload length][payload]
//! type 'J' (0x4A): payload is UTF-8 JSON (control messages)
//! type 'B' (0x42): payload is raw bytes (e.g. a PNG screenshot)
//! ```
//!
//! Control messages are request/response with an id supplied by the caller
//! and echoed in the response. A response with `binary: true` in its data is
//! followed by one `B` frame carrying the bytes.

use std::io::{self, Read};

use serde::{Deserialize, Serialize};

pub const FRAME_TYPE_JSON: u8 = b'J';
pub const FRAME_TYPE_BINARY: u8 = b'B';

/// Screenshots are the only large payloads expected; 32 MiB covers 4K PNG
/// with headroom and stops a corrupt length field from demanding gigabytes.
pub const MAX_FRAME_LEN: u32 = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub frame_type: u8,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn json(payload: impl Into<Vec<u8>>) -> Self {
        Frame {
            frame_type: FRAME_TYPE_JSON,
            payload: payload.into(),
        }
    }

    pub fn binary(payload: impl Into<Vec<u8>>) -> Self {
        Frame {
            frame_type: FRAME_TYPE_BINARY,
            payload: payload.into(),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 + self.payload.len());
        out.push(self.frame_type);
        out.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        out.extend_from_slice(&self.payload);
        out
    }
}

/// Reads one frame. Returns `Ok(None)` on a clean EOF before any bytes of a
/// frame (peer closed the connection).
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Frame>> {
    let mut first = [0u8; 1];
    loop {
        let n = reader.read(&mut first)?;
        if n == 0 {
            return Ok(None);
        }
        if n == 1 {
            break;
        }
    }

    let mut rest = [0u8; 4];
    reader.read_exact(&mut rest)?;
    let len = u32::from_be_bytes(rest);
    if len > MAX_FRAME_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame length {} exceeds limit {}", len, MAX_FRAME_LEN),
        ));
    }

    let mut payload = vec![0u8; len as usize];
    reader.read_exact(&mut payload)?;

    let frame_type = match first[0] {
        FRAME_TYPE_JSON | FRAME_TYPE_BINARY => first[0],
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("unknown frame type 0x{:02X}", other),
            ))
        }
    };

    Ok(Some(Frame {
        frame_type,
        payload,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    Png,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

fn default_image_format() -> ImageFormat {
    ImageFormat::Png
}

fn default_mouse_button() -> MouseButton {
    MouseButton::Left
}

/// Commands the agent can send. Wire shape follows the plan:
/// `{"cmd": "<name>", "args": {...}}` with an externally supplied id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "cmd", content = "args", rename_all = "snake_case")]
pub enum Command {
    /// Create the headless workspace: headless output now, nested cage and
    /// dedicated workspace pinning once the cage lifecycle lands.
    CreateWorkspace {
        #[serde(default)]
        app: Option<String>,
    },
    /// Launch an app inside the nested compositor.
    RunApp { app: String },
    /// Capture the headless output. The ok response carries
    /// `data: {"binary": true}` and is followed by one `B` frame.
    Screenshot {
        #[serde(default = "default_image_format")]
        format: ImageFormat,
    },
    /// Virtual pointer click, in headless-output coordinates.
    Click {
        x: i32,
        y: i32,
        #[serde(default = "default_mouse_button")]
        button: MouseButton,
    },
    /// Virtual pointer move without a click.
    MovePointer { x: i32, y: i32 },
    /// Virtual keyboard text input.
    #[serde(rename = "type")]
    TypeText { text: String },
    /// Virtual keyboard chord, e.g. ["ctrl", "s"].
    #[serde(rename = "key")]
    PressKeys { keys: Vec<String> },
    /// Destroy the workspace created by this driver: remove the headless
    /// output and restore the prior layout.
    Teardown {},
    /// Liveness + Hyprland reachability probe.
    Health {},
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: u64,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl Response {
    pub fn ok(id: u64) -> Self {
        Response {
            id,
            ok: true,
            error: None,
            data: None,
        }
    }

    pub fn ok_with(id: u64, data: serde_json::Value) -> Self {
        Response {
            id,
            ok: true,
            error: None,
            data: Some(data),
        }
    }

    pub fn err(id: u64, message: impl Into<String>) -> Self {
        Response {
            id,
            ok: false,
            error: Some(message.into()),
            data: None,
        }
    }
}

/// Encodes a request as a `J` frame.
pub fn encode_request(request: &Request) -> Result<Frame, serde_json::Error> {
    Ok(Frame::json(serde_json::to_vec(request)?))
}

/// Parses a request from a `J` frame payload.
///
/// The plan's wire format always carries `"args"`, but argument-less
/// commands may omit it; an omitted `args` is treated as `{}`.
pub fn parse_request(payload: &[u8]) -> Result<Request, serde_json::Error> {
    serde_json::from_slice(payload).or_else(|first_error| {
        let mut value: serde_json::Value = serde_json::from_slice(payload)?;
        let args_was_null = value
            .as_object_mut()
            .map(|obj| {
                obj.entry("args")
                    .or_insert_with(|| serde_json::json!({}))
                    .is_null()
            })
            .unwrap_or(false);
        if args_was_null {
            return Err(first_error);
        }
        serde_json::from_value(value)
    })
}

/// Encodes a response as a `J` frame.
pub fn encode_response(response: &Response) -> Result<Frame, serde_json::Error> {
    Ok(Frame::json(serde_json::to_vec(response)?))
}

/// Parses a response from a `J` frame payload.
pub fn parse_response(payload: &[u8]) -> Result<Response, serde_json::Error> {
    serde_json::from_slice(payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn round_trip(frame: &Frame) -> Frame {
        let bytes = frame.encode();
        let mut cursor = Cursor::new(bytes);
        read_frame(&mut cursor)
            .expect("read_frame")
            .expect("frame present")
    }

    #[test]
    fn json_frame_round_trip() {
        let frame = Frame::json(b"{\"id\":1}".to_vec());
        assert_eq!(round_trip(&frame), frame);
    }

    #[test]
    fn binary_frame_round_trip() {
        let payload: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        let frame = Frame::binary(payload);
        assert_eq!(round_trip(&frame), frame);
    }

    #[test]
    fn empty_payload_round_trip() {
        let frame = Frame::json(Vec::new());
        assert_eq!(round_trip(&frame), frame);
    }

    #[test]
    fn frame_layout_is_type_len_payload() {
        let frame = Frame::json(b"hi".to_vec());
        let bytes = frame.encode();
        assert_eq!(&bytes[..5], &[b'J', 0, 0, 0, 2]);
        assert_eq!(&bytes[5..], b"hi");
    }

    #[test]
    fn read_frame_returns_none_on_clean_eof() {
        let mut cursor = Cursor::new(Vec::new());
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn read_frame_rejects_unknown_type_tag() {
        let mut bytes = Frame::json(b"x".to_vec()).encode();
        bytes[0] = b'Z';
        let mut cursor = Cursor::new(bytes);
        let err = read_frame(&mut cursor).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn read_frame_rejects_oversized_length() {
        let bytes = [b'J', 0xFF, 0xFF, 0xFF, 0xFF];
        let mut cursor = Cursor::new(&bytes[..]);
        let err = read_frame(&mut cursor).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn read_frame_errors_on_truncated_payload() {
        let mut bytes = Frame::binary(vec![1, 2, 3]).encode();
        bytes.truncate(6);
        let mut cursor = Cursor::new(bytes);
        assert!(read_frame(&mut cursor).is_err());
    }

    #[test]
    fn parses_plan_example_requests() {
        let cases = [
            (r#"{"id":1,"cmd":"create_workspace","args":{"app":null}}"#, Command::CreateWorkspace { app: None }),
            (r#"{"id":2,"cmd":"run_app","args":{"app":"libreoffice --calc"}}"#, Command::RunApp { app: "libreoffice --calc".into() }),
            (r#"{"id":3,"cmd":"screenshot","args":{"format":"png"}}"#, Command::Screenshot { format: ImageFormat::Png }),
            (r#"{"id":4,"cmd":"click","args":{"x":320,"y":240,"button":"left"}}"#, Command::Click { x: 320, y: 240, button: MouseButton::Left }),
            (r#"{"id":5,"cmd":"type","args":{"text":"hello"}}"#, Command::TypeText { text: "hello".into() }),
            (r#"{"id":6,"cmd":"key","args":{"keys":["ctrl","s"]}}"#, Command::PressKeys { keys: vec!["ctrl".into(), "s".into()] }),
            (r#"{"id":7,"cmd":"teardown","args":{}}"#, Command::Teardown {}),
        ];
        for (json, expected) in cases {
            let req: Request = serde_json::from_str(json).expect(json);
            assert_eq!(req.command, expected, "mismatch for {}", json);
        }
    }

    #[test]
    fn parses_unit_command_without_args_field() {
        let req = parse_request(br#"{"id":9,"cmd":"health"}"#).unwrap();
        assert_eq!(req.command, Command::Health {});
        // With the args key present but empty, as the plan's examples send it.
        let req = parse_request(br#"{"id":9,"cmd":"health","args":{}}"#).unwrap();
        assert_eq!(req.command, Command::Health {});
    }

    #[test]
    fn screenshot_defaults_and_move_pointer() {
        let req: Request = serde_json::from_str(r#"{"id":10,"cmd":"screenshot","args":{}}"#).unwrap();
        assert_eq!(req.command, Command::Screenshot { format: ImageFormat::Png });

        let req: Request = serde_json::from_str(r#"{"id":11,"cmd":"click","args":{"x":1,"y":2}}"#).unwrap();
        assert_eq!(req.command, Command::Click { x: 1, y: 2, button: MouseButton::Left });

        let req: Request = serde_json::from_str(r#"{"id":12,"cmd":"move_pointer","args":{"x":5,"y":6}}"#).unwrap();
        assert_eq!(req.command, Command::MovePointer { x: 5, y: 6 });
    }

    #[test]
    fn request_frame_round_trip() {
        let req = Request {
            id: 4,
            command: Command::Click {
                x: 320,
                y: 240,
                button: MouseButton::Right,
            },
        };
        let frame = encode_request(&req).unwrap();
        assert_eq!(frame.frame_type, FRAME_TYPE_JSON);
        assert_eq!(parse_request(&frame.payload).unwrap(), req);
    }

    #[test]
    fn response_serialization_matches_protocol_examples() {
        let ok = Response::ok_with(3, serde_json::json!({ "binary": true }));
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            serde_json::json!({ "id": 3, "ok": true, "data": { "binary": true } })
        );

        let err = Response::err(1, "headless output create failed");
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            serde_json::json!({ "id": 1, "ok": false, "error": "headless output create failed" })
        );

        let plain = Response::ok(4);
        assert_eq!(
            serde_json::to_value(&plain).unwrap(),
            serde_json::json!({ "id": 4, "ok": true })
        );
    }

    #[test]
    fn response_frame_round_trip() {
        let resp = Response::err(2, "boom");
        let frame = encode_response(&resp).unwrap();
        assert_eq!(parse_response(&frame.payload).unwrap(), resp);
    }
}
