//! staka-compositor: headless workspace driver for the Staka desktop.
//!
//! Accepts one or more agent connections on a local Unix socket and
//! dispatches framed control commands (see the ipc module). The socket path
//! is the first argument, defaulting to
//! `$XDG_RUNTIME_DIR/staka/compositor-<n>.sock` style path with a fixed
//! name for now: `$XDG_RUNTIME_DIR/staka/compositor.sock`.

use std::fs::{create_dir_all, remove_file, set_permissions, Permissions};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::exit;
use std::sync::Arc;
use std::thread;

use staka_compositor::server::{serve_connection, ServerState};

fn default_socket_path() -> PathBuf {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(runtime_dir)
        .join("staka")
        .join("compositor.sock")
}

fn prepare_socket(path: &PathBuf) -> io::Result<UnixListener> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
        set_permissions(parent, Permissions::from_mode(0o700))?;
    }
    // A stale socket file from a previous crash would fail bind().
    remove_file(path).ok();
    let listener = UnixListener::bind(path)?;
    set_permissions(path, Permissions::from_mode(0o600))?;
    Ok(listener)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let socket_path = args.next().map(PathBuf::from).unwrap_or_else(default_socket_path);

    if std::env::var("HYPRLAND_INSTANCE_SIGNATURE").is_err() {
        eprintln!("warning: HYPRLAND_INSTANCE_SIGNATURE is not set; hyprctl calls will fail");
    }

    let listener = match prepare_socket(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("failed to bind {}: {}", socket_path.display(), e);
            exit(1);
        }
    };
    eprintln!("staka-compositor listening on {}", socket_path.display());

    let state = Arc::new(ServerState::system());

    for stream in listener.incoming() {
        match stream {
            Ok(mut stream) => {
                let state = state.clone();
                thread::spawn(move || {
                    if let Err(e) = serve_connection(&mut stream, &state) {
                        eprintln!("connection error: {}", e);
                    }
                });
            }
            Err(e) => eprintln!("accept failed: {}", e),
        }
    }
}
