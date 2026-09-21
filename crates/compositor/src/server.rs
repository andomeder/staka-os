//! Unix socket server: accepts agent connections, decodes request frames,
//! dispatches commands, and encodes response frames.
//!
//! Screenshot and virtual input require the nested-compositor lifecycle and
//! are dispatched as explicit "not implemented" errors until those land.
//! Headless workspace create/teardown is real: it talks to hyprctl.

use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;

use crate::hyprctl::{CommandRunner, HyprCtl};
use crate::ipc::{
    encode_response, parse_request, read_frame, Command, Frame, Request, Response,
    FRAME_TYPE_JSON,
};

pub struct ServerState<C: CommandRunner> {
    hyprctl: HyprCtl<C>,
    /// Headless outputs created by this driver process, removed on teardown.
    created_outputs: Mutex<Vec<String>>,
}

/// One command's outcome: the JSON response plus an optional binary frame
/// (currently unused; screenshots will send PNG bytes here).
pub struct Handled {
    pub response: Response,
    pub binary: Option<Vec<u8>>,
}

impl<C: CommandRunner> ServerState<C> {
    pub fn new(hyprctl: HyprCtl<C>) -> Self {
        ServerState {
            hyprctl,
            created_outputs: Mutex::new(Vec::new()),
        }
    }

    pub fn handle(&self, request: &Request) -> Handled {
        let id = request.id;
        match &request.command {
            Command::Health {} => match self.hyprctl.health_check() {
                Ok(()) => Handled {
                    response: Response::ok_with(id, serde_json::json!({ "hyprland": true })),
                    binary: None,
                },
                Err(e) => Handled {
                    response: Response::err(id, e.to_string()),
                    binary: None,
                },
            },
            Command::CreateWorkspace { app } => {
                if app.is_some() {
                    return Handled {
                        response: Response::err(
                            id,
                            "launching an app requires the nested compositor, not available yet",
                        ),
                        binary: None,
                    };
                }
                match self.hyprctl.create_headless_output() {
                    Ok(name) => {
                        self.created_outputs.lock().unwrap().push(name.clone());
                        Handled {
                            response: Response::ok_with(id, serde_json::json!({ "output": name })),
                            binary: None,
                        }
                    }
                    Err(e) => Handled {
                        response: Response::err(id, e.to_string()),
                        binary: None,
                    },
                }
            }
            Command::Teardown {} => {
                let mut created = self.created_outputs.lock().unwrap();
                let mut removed = Vec::new();
                let mut first_error = None;
                let names: Vec<String> = created.drain(..).collect();
                for name in names {
                    match self.hyprctl.remove_output(&name) {
                        Ok(()) => removed.push(name),
                        Err(e) => {
                            if first_error.is_none() {
                                first_error =
                                    Some(format!("failed to remove {}: {}", name, e));
                            }
                            // Keep the name so a later teardown can retry.
                            created.push(name);
                        }
                    }
                }
                drop(created);
                match first_error {
                    Some(error) => Handled {
                        response: Response::err(id, error),
                        binary: None,
                    },
                    None => Handled {
                        response: Response::ok_with(id, serde_json::json!({ "removed": removed })),
                        binary: None,
                    },
                }
            }
            Command::RunApp { .. } => not_implemented(id, "run_app"),
            Command::Screenshot { .. } => not_implemented(id, "screenshot"),
            Command::Click { .. } => not_implemented(id, "click"),
            Command::MovePointer { .. } => not_implemented(id, "move_pointer"),
            Command::TypeText { .. } => not_implemented(id, "type"),
            Command::PressKeys { .. } => not_implemented(id, "key"),
        }
    }
}

fn not_implemented(id: u64, cmd: &str) -> Handled {
    Handled {
        response: Response::err(
            id,
            format!(
                "{} is not implemented yet; headless workspace lifecycle only",
                cmd
            ),
        ),
        binary: None,
    }
}

/// Serves one connection: request frame in, response frame out, until the
/// peer closes. Malformed requests get an error response with id 0 (the id
/// cannot be recovered from an unparsable payload).
pub fn serve_connection<C: CommandRunner>(
    stream: &mut UnixStream,
    state: &ServerState<C>,
) -> io::Result<()> {
    loop {
        let frame = match read_frame(stream)? {
            Some(frame) => frame,
            None => return Ok(()),
        };

        let mut out_frames: Vec<Vec<u8>> = Vec::new();
        if frame.frame_type != FRAME_TYPE_JSON {
            let resp = Response::err(0, "requests must be JSON frames");
            out_frames.push(encode_response(&resp).unwrap().encode());
        } else {
            let handled = match parse_request(&frame.payload) {
                Ok(request) => state.handle(&request),
                Err(e) => Handled {
                    response: Response::err(0, format!("invalid request: {}", e)),
                    binary: None,
                },
            };
            let resp_frame = encode_response(&handled.response).unwrap();
            out_frames.push(resp_frame.encode());
            if let Some(bytes) = handled.binary {
                out_frames.push(Frame::binary(bytes).encode());
            }
        }

        for out in out_frames {
            stream.write_all(&out)?;
        }
        stream.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{parse_response, ImageFormat, MouseButton};
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    const BASE_MONITORS: &str = r#"[{"id": 0, "name": "DP-3"}]"#;

    fn ok(stdout: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(0),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    fn failed(stdout: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(256),
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }

    /// In-memory Hyprland: tracks created headless outputs and reflects them
    /// in the monitors list, mirroring real hyprctl behavior.
    struct MockHyprland {
        created: Mutex<Vec<String>>,
        /// When set, `output remove` fails with this stdout text.
        remove_fails: Option<String>,
    }

    impl MockHyprland {
        fn new() -> Self {
            MockHyprland {
                created: Mutex::new(Vec::new()),
                remove_fails: None,
            }
        }

        fn next_name(&self) -> String {
            let created = self.created.lock().unwrap();
            format!("HEADLESS-{}", created.len() + 2)
        }

        fn monitors_json(&self) -> String {
            let created = self.created.lock().unwrap();
            let mut entries = vec![r#"{"id": 0, "name": "DP-3"}"#.to_string()];
            for (i, name) in created.iter().enumerate() {
                entries.push(format!(r#"{{"id": {}, "name": "{}"}}"#, i + 1, name));
            }
            format!("[{}]", entries.join(","))
        }
    }

    impl CommandRunner for MockHyprland {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            match args {
                ["monitors", "-j"] => Ok(ok(&self.monitors_json())),
                ["output", "create", "headless"] => {
                    let name = self.next_name();
                    self.created.lock().unwrap().push(name);
                    Ok(ok("ok"))
                }
                ["output", "remove", name] => {
                    if let Some(text) = &self.remove_fails {
                        return Ok(failed(text));
                    }
                    self.created.lock().unwrap().retain(|n| n != name);
                    Ok(ok("ok"))
                }
                _ => Err(io::Error::other("unexpected call")),
            }
        }
    }

    fn make_request(id: u64, command: Command) -> Request {
        Request { id, command }
    }

    #[test]
    fn health_returns_hyprland_status() {
        let state = ServerState::new(HyprCtl::new(MockHyprland::new()));
        let handled = state.handle(&make_request(1, Command::Health {}));
        assert_eq!(
            handled.response,
            Response::ok_with(1, serde_json::json!({ "hyprland": true }))
        );
        assert!(handled.binary.is_none());
    }

    #[test]
    fn create_then_teardown_round_trip() {
        let state = ServerState::new(HyprCtl::new(MockHyprland::new()));

        let handled = state.handle(&make_request(1, Command::CreateWorkspace { app: None }));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({ "output": "HEADLESS-2" }))
        );

        let handled = state.handle(&make_request(2, Command::Teardown {}));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({ "removed": ["HEADLESS-2"] }))
        );

        // Nothing left to remove.
        let handled = state.handle(&make_request(3, Command::Teardown {}));
        assert!(handled.response.ok);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({ "removed": [] }))
        );
    }

    #[test]
    fn teardown_reports_and_survives_removal_errors() {
        let mut mock = MockHyprland::new();
        mock.remove_fails = Some("error".to_string());
        let state = ServerState::new(HyprCtl::new(mock));

        let _handled = state.handle(&make_request(1, Command::CreateWorkspace { app: None }));
        let handled = state.handle(&make_request(2, Command::Teardown {}));
        assert!(!handled.response.ok);
        // The output stays registered so teardown can be retried.
        assert_eq!(state.created_outputs.lock().unwrap().len(), 1);
    }

    #[test]
    fn create_with_app_is_rejected_until_cage_lands() {
        let state = ServerState::new(HyprCtl::new(MockHyprland::new()));
        let handled = state.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("gnome-calculator".into()),
            },
        ));
        assert!(!handled.response.ok);
        assert!(handled
            .response
            .error
            .unwrap()
            .contains("nested compositor"));
    }

    #[test]
    fn create_failure_is_reported() {
        struct CreateFails;
        impl CommandRunner for CreateFails {
            fn run(&self, args: &[&str]) -> io::Result<Output> {
                match args {
                    ["monitors", "-j"] => Ok(ok(BASE_MONITORS)),
                    ["output", "create", "headless"] => Ok(failed("error creating output")),
                    _ => Err(io::Error::other("unexpected call")),
                }
            }
        }
        let state = ServerState::new(HyprCtl::new(CreateFails));
        let handled = state.handle(&make_request(1, Command::CreateWorkspace { app: None }));
        assert!(!handled.response.ok);
        assert!(state.created_outputs.lock().unwrap().is_empty());
    }

    #[test]
    fn unimplemented_commands_report_clear_errors() {
        let state = ServerState::new(HyprCtl::new(MockHyprland::new()));
        let commands = [
            Command::RunApp { app: "x".into() },
            Command::Screenshot {
                format: ImageFormat::Png,
            },
            Command::Click {
                x: 1,
                y: 2,
                button: MouseButton::Left,
            },
            Command::MovePointer { x: 1, y: 2 },
            Command::TypeText { text: "hi".into() },
            Command::PressKeys {
                keys: vec!["ctrl".into()],
            },
        ];
        for cmd in commands {
            let handled = state.handle(&make_request(7, cmd));
            assert!(!handled.response.ok);
            assert!(handled.response.error.unwrap().contains("not implemented"));
        }
    }

    #[test]
    fn serve_connection_round_trips_over_socketpair() {
        let (client, mut server) = UnixStream::pair().unwrap();
        let state = ServerState::new(HyprCtl::new(MockHyprland::new()));
        let server_thread = std::thread::spawn(move || {
            serve_connection(&mut server, &state).unwrap();
        });

        let mut client_w = client.try_clone().unwrap();
        let mut client_r = client.try_clone().unwrap();

        let req = make_request(42, Command::Health {});
        client_w
            .write_all(&crate::ipc::encode_request(&req).unwrap().encode())
            .unwrap();
        client_w.flush().unwrap();

        let frame = read_frame(&mut client_r).unwrap().unwrap();
        assert_eq!(frame.frame_type, FRAME_TYPE_JSON);
        let resp = parse_response(&frame.payload).unwrap();
        assert_eq!(resp.id, 42);
        assert!(resp.ok);

        // Second request: create_workspace over the same connection.
        let req = make_request(43, Command::CreateWorkspace { app: None });
        client_w
            .write_all(&crate::ipc::encode_request(&req).unwrap().encode())
            .unwrap();
        client_w.flush().unwrap();
        let frame = read_frame(&mut client_r).unwrap().unwrap();
        let resp = parse_response(&frame.payload).unwrap();
        assert_eq!(resp.id, 43);
        assert_eq!(
            resp.data,
            Some(serde_json::json!({ "output": "HEADLESS-2" }))
        );

        // Closing the socket ends the server loop cleanly.
        drop(client_w);
        drop(client_r);
        drop(client);
        server_thread.join().unwrap();
    }

    #[test]
    fn serve_connection_answers_malformed_request_with_error() {
        let (client, mut server) = UnixStream::pair().unwrap();
        let state = ServerState::new(HyprCtl::new(MockHyprland::new()));
        let server_thread = std::thread::spawn(move || {
            serve_connection(&mut server, &state).unwrap();
        });

        let mut client_w = client.try_clone().unwrap();
        let mut client_r = client.try_clone().unwrap();
        client_w
            .write_all(&Frame::json(b"{not json".to_vec()).encode())
            .unwrap();
        client_w.flush().unwrap();

        let frame = read_frame(&mut client_r).unwrap().unwrap();
        let resp = parse_response(&frame.payload).unwrap();
        assert_eq!(resp.id, 0);
        assert!(!resp.ok);

        drop(client_w);
        drop(client_r);
        drop(client);
        server_thread.join().unwrap();
    }
}
