//! Unix socket server: accepts agent connections, decodes request frames,
//! dispatches commands, and encodes response frames.
//!
//! One driver process owns at most one agent workspace at a time:
//! `create_workspace` captures the user's layout, creates a headless
//! output, launches the nested cage compositor with the requested app, and
//! pins a dedicated named agent workspace to the invisible output.
//! `screenshot` captures that output. Virtual input commands (click,
//! move, type, key) connect to cage's Wayland socket on first use and
//! inject into cage's seat only - never the user's physical seat.
//! `teardown` reverses everything and restores the user's layout.

use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::cage::{cage_socket_path, split_app, CageConfig, CageSession, ChildProcess, ProcessSpawner, SystemSpawner};
use crate::hyprctl::{Client, CommandRunner, HyprCtl, HyprError};
use crate::input::{InputConnector, InputError, VirtualSeat, WaylandInputConnector};
use crate::ipc::{
    encode_response, parse_request, read_frame, Command, Frame, Request, Response, ImageFormat,
    FRAME_TYPE_JSON,
};
use crate::screencopy::{capture_png, CaptureRunner, GrimCapture};
use crate::workspace::{LayoutSnapshot, WorkspaceManager};

/// Name of the Wayland socket the nested cage compositor creates.
const CAGE_SOCKET_NAME: &str = "staka-cage";

/// How long to wait for the cage window to appear in `hyprctl clients -j`.
const WINDOW_APPEAR_TIMEOUT: Duration = Duration::from_secs(10);

/// Everything one agent workspace owns; torn down by `Teardown`.
pub struct ActiveSession {
    pub output: String,
    pub workspace: String,
    pub layout: LayoutSnapshot,
    pub cage: Option<CageSession>,
    /// Nested output geometry; virtual-input coordinates are relative to
    /// it (zero when no cage is running).
    pub cage_width: u32,
    pub cage_height: u32,
    /// Live virtual-input connection to cage's seat, created lazily on
    /// the first input command and reused until teardown.
    pub input: Option<Box<dyn VirtualSeat>>,
    /// Apps launched into the cage; killed on teardown. Cage's own death
    /// takes the apps with it, but explicit kills keep teardown
    /// deterministic.
    pub apps: Vec<Box<dyn ChildProcess>>,
    /// The app command this session was created with, so suspend/resume
    /// recovery can relaunch the same thing. `None` for a bare workspace.
    pub app: Option<String>,
}

pub struct ServerState<C: CommandRunner, S: ProcessSpawner, G: CaptureRunner, I: InputConnector> {
    hyprctl: HyprCtl<C>,
    spawner: S,
    capture: G,
    input: I,
    cage_binary: PathBuf,
    /// Runtime dir where the cage Wayland socket appears.
    runtime_dir: PathBuf,
    session: Mutex<Option<ActiveSession>>,
}

impl<C: CommandRunner, S: ProcessSpawner, G: CaptureRunner, I: InputConnector>
    ServerState<C, S, G, I>
{
    pub fn new(
        hyprctl: HyprCtl<C>,
        spawner: S,
        capture: G,
        input: I,
        cage_binary: impl Into<PathBuf>,
        runtime_dir: impl Into<PathBuf>,
    ) -> Self {
        ServerState {
            hyprctl,
            spawner,
            capture,
            input,
            cage_binary: cage_binary.into(),
            runtime_dir: runtime_dir.into(),
            session: Mutex::new(None),
        }
    }

    /// Snapshot of the user's layout before the driver touches anything.
    /// Kept separate from the generic impl so the concrete `system()`
    /// constructor lives beside the concrete types it uses.

    pub fn handle(&self, request: &Request) -> Handled {
        let id = request.id;
        match &request.command {
            Command::Health {} => self.handle_health(id),
            Command::CreateWorkspace { app } => self.handle_create_workspace(id, app.as_deref()),
            Command::RunApp { app } => self.handle_run_app(id, app),
            Command::Screenshot { format } => self.handle_screenshot(id, *format),
            Command::Teardown {} => self.handle_teardown(id),
            Command::Click { x, y, button } => self.handle_input_command(
                id,
                "click",
                move |seat, w, h| seat.click(*x, *y, *button, w, h),
            ),
            Command::MovePointer { x, y } => self.handle_input_command(
                id,
                "move",
                move |seat, w, h| seat.move_pointer(*x, *y, w, h),
            ),
            Command::TypeText { text } => {
                self.handle_input_command(id, "type", move |seat, _, _| seat.type_text(text))
            }
            Command::PressKeys { keys } => {
                self.handle_input_command(id, "key", move |seat, _, _| seat.press_keys(keys))
            }
        }
    }

    /// Health: Hyprland reachability plus a probe of the active session,
    /// so a supervisor (the agent's resume watcher) can tell whether the
    /// headless workspace survived a suspend. The probe is deliberately
    /// cheap: process liveness and output presence, no screenshot.
    fn handle_health(&self, id: u64) -> Handled {
        if let Err(e) = self.hyprctl.health_check() {
            return error(id, e);
        }
        let mut data = serde_json::json!({ "hyprland": true });
        let mut session_guard = self.session.lock().unwrap();
        if let Some(session) = session_guard.as_mut() {
            // A cage that exited (killed by a resume race, OOM, or a
            // compositor restart) is detectable without waiting: try_wait
            // reaps only exited children.
            let cage_alive = match session.cage.as_mut() {
                Some(cage) => cage.is_running(),
                None => false,
            };
            let output_present = self
                .hyprctl
                .list_outputs()
                .map(|outputs| outputs.iter().any(|o| o.name == session.output))
                .unwrap_or(false);
            data["session"] = serde_json::json!({
                "active": true,
                "cage_alive": cage_alive,
                "output_present": output_present,
                "output": session.output,
                "workspace": session.workspace,
                "app": session.app,
            });
        }
        Handled {
            response: Response::ok_with(id, data),
            binary: None,
        }
    }

    fn handle_create_workspace(&self, id: u64, app: Option<&str>) -> Handled {
        let mut session_guard = self.session.lock().unwrap();
        if session_guard.is_some() {
            return Handled {
                response: Response::err(
                    id,
                    "a workspace is already active; tear it down before creating another",
                ),
                binary: None,
            };
        }

        let manager = WorkspaceManager::new(&self.hyprctl);

        // Snapshot first: teardown compares against exactly this state.
        let layout = match LayoutSnapshot::capture(&self.hyprctl) {
            Ok(layout) => layout,
            Err(e) => return error(id, e),
        };

        let output = match self.hyprctl.create_headless_output() {
            Ok(output) => output,
            Err(e) => return error(id, e),
        };

        // Creating the output makes Hyprland grab a workspace for it
        // immediately - sometimes a fresh empty one, sometimes one of the
        // user's. Adopt a fresh grab as the agent workspace; otherwise the
        // agent workspace is created by moving the cage window and pinned
        // below. Either way the output ends up hosting the agent
        // workspace, which is the only stable state: an output left
        // without a workspace gets another one grabbed for it
        // immediately.
        let adopted = match manager.adopt_grabbed_workspace(&layout, &output) {
            Ok(adopted) => adopted,
            Err(e) => return self.fail_create(id, &output, layout, e),
        };
        let was_adopted = adopted.is_some();
        let workspace = match adopted {
            Some(name) => name,
            None => match manager.select() {
                Ok(name) => name,
                Err(e) => return self.fail_create(id, &output, layout, e),
            },
        };

        // Launch cage with the app inside, then move its window silently
        // onto the dedicated agent workspace on the invisible output. The
        // user's focused workspace never changes.
        let mut cage_width: u32 = 0;
        let mut cage_height: u32 = 0;
        let cage = match app {
            Some(app) => match self.launch_cage(&manager, &workspace, &output, app, !was_adopted) {
                Ok((cage, width, height)) => {
                    cage_width = width;
                    cage_height = height;
                    Some(cage)
                }
                Err(e) => return self.fail_create(id, &output, layout, e),
            },
            None => None,
        };

        // With the agent workspace occupying the output, give back any
        // user workspace Hyprland grabbed, and verify the layout is
        // stable.
        if let Err(e) = manager.settle(&layout, &output, 5) {
            return self.fail_create(id, &output, layout, e);
        }

        *session_guard = Some(ActiveSession {
            output: output.clone(),
            workspace: workspace.clone(),
            layout,
            cage,
            cage_width,
            cage_height,
            input: None,
            apps: Vec::new(),
            app: app.map(str::to_string),
        });

        let mut data = serde_json::json!({ "output": output, "workspace": workspace });
        if let Some(cage) = session_guard.as_ref().and_then(|s| s.cage.as_ref()) {
            data["cage_pid"] = serde_json::json!(cage.pid);
            data["socket"] = serde_json::json!(CAGE_SOCKET_NAME);
        }
        Handled {
            response: Response::ok_with(id, data),
            binary: None,
        }
    }

    /// Fails a create_workspace and undoes everything done so far, so a
    /// half-created workspace never lingers.
    fn fail_create(&self, id: u64, output: &str, layout: LayoutSnapshot, e: HyprError) -> Handled {
        if let Err(remove_err) = self.hyprctl.remove_output(output) {
            eprintln!(
                "warning: failed to remove {} during cleanup: {}",
                output, remove_err
            );
        }
        let manager = WorkspaceManager::new(&self.hyprctl);
        if let Err(restore_err) = manager.restore(&layout) {
            eprintln!("warning: layout restore during cleanup failed: {}", restore_err);
        }
        error(id, e)
    }

    fn launch_cage(
        &self,
        manager: &WorkspaceManager<C>,
        workspace: &str,
        output: &str,
        app: &str,
        needs_pin: bool,
    ) -> Result<(CageSession, u32, u32), HyprError> {
        let wayland_display = std::env::var("WAYLAND_DISPLAY").map_err(|_| {
            HyprError::Parse(
                "WAYLAND_DISPLAY is not set; cannot launch the nested compositor".to_string(),
            )
        })?;
        let config = CageConfig {
            cage_binary: self.cage_binary.clone(),
            socket_name: CAGE_SOCKET_NAME.to_string(),
            socket_dir: self.runtime_dir.clone(),
            wayland_display,
            app: app.to_string(),
            ..Default::default()
        };
        let session = CageSession::spawn(&self.spawner, &config)
            .map_err(|e| HyprError::Parse(e.to_string()))?;
        let geometry = (config.width, config.height);

        // Wait for Hyprland to see the cage window, then move it silently
        // onto the dedicated agent workspace. The user's focused workspace
        // never changes.
        let client = wait_for_client(&self.hyprctl, session.pid).map_err(HyprError::Parse)?;
        manager
            .move_window(workspace, &client.address)
            .map_err(|e| HyprError::Parse(format!("cage window move failed: {}", e)))?;
        if needs_pin {
            // The agent workspace was created by the move on the user's
            // monitor; force it onto the invisible output.
            manager
                .pin_to_output(workspace, output)
                .map_err(|e| HyprError::Parse(format!("workspace pin failed: {}", e)))?;
        }
        Ok((session, geometry.0, geometry.1))
    }

    /// Runs one virtual-input operation against cage's seat. The
    /// connection to cage's socket is created lazily on first use and
    /// reused; coordinates are relative to the nested output geometry.
    fn handle_input_command<F>(&self, id: u64, op: &str, command: F) -> Handled
    where
        F: FnOnce(&mut dyn VirtualSeat, u32, u32) -> Result<(), InputError>,
    {
        let mut session_guard = self.session.lock().unwrap();
        let Some(session) = session_guard.as_mut() else {
            return error(id, "no active workspace; create one first");
        };
        let (socket, width, height) = match session.cage.as_ref() {
            Some(cage) => (
                cage_socket_path(&cage.socket_dir, &cage.socket_name),
                session.cage_width,
                session.cage_height,
            ),
            None => {
                return error(id, "the nested compositor is not running in this workspace");
            }
        };
        if session.input.is_none() {
            match self.input.connect(&socket) {
                Ok(seat) => session.input = Some(seat),
                Err(e) => return error(id, format!("{} failed: {}", op, e)),
            }
        }
        let seat = session.input.as_mut().expect("input set above");
        match command(seat.as_mut(), width, height) {
            Ok(()) => Handled {
                response: Response::ok(id),
                binary: None,
            },
            Err(e) => error(id, format!("{} failed: {}", op, e)),
        }
    }

    fn handle_run_app(&self, id: u64, app: &str) -> Handled {
        let mut session_guard = self.session.lock().unwrap();
        let Some(session) = session_guard.as_mut() else {
            return error(id, "no active workspace; create one first");
        };
        let Some(cage) = session.cage.as_ref() else {
            return error(id, "the nested compositor is not running in this workspace");
        };
        let mut words = split_app(app);
        if words.is_empty() {
            return error(id, "run_app requires an app command");
        }
        let program = words.remove(0);
        match self.spawner.spawn(
            std::path::Path::new(&program),
            &words,
            &[("WAYLAND_DISPLAY", cage.socket_name.clone())],
        ) {
            Ok(child) => {
                let pid = child.pid();
                session.apps.push(child);
                Handled {
                    response: Response::ok_with(id, serde_json::json!({ "pid": pid })),
                    binary: None,
                }
            }
            Err(e) => error(id, format!("failed to launch app: {}", e)),
        }
    }

    fn handle_screenshot(&self, id: u64, format: ImageFormat) -> Handled {
        if format != ImageFormat::Png {
            return error(id, "only png capture is supported");
        }
        let session_guard = self.session.lock().unwrap();
        let Some(session) = session_guard.as_ref() else {
            return error(id, "no active workspace; create one first");
        };
        match capture_png(&self.capture, &session.output) {
            Ok(png) => Handled {
                response: Response::ok_with(id, serde_json::json!({ "binary": true })),
                binary: Some(png),
            },
            Err(e) => error(id, e),
        }
    }

    fn handle_teardown(&self, id: u64) -> Handled {
        let mut session_guard = self.session.lock().unwrap();
        let Some(mut session) = session_guard.take() else {
            return Handled {
                response: Response::ok_with(id, serde_json::json!({ "removed": [] })),
                binary: None,
            };
        };

        let mut failures: Vec<String> = Vec::new();

        // Kill apps first: they are cage's clients, and teardown must be
        // deterministic even if cage ignores its own shutdown.
        while let Some(mut app) = session.apps.pop() {
            let pid = app.pid();
            if let Err(e) = app.signal(SIGTERM) {
                failures.push(format!("failed to signal app pid {}: {}", pid, e));
            }
            if let Err(e) = app.wait() {
                failures.push(format!("failed to reap app pid {}: {}", pid, e));
            }
        }

        let cage_terminated = session.cage.is_some();
        if let Some(cage) = session.cage.as_mut() {
            if let Err(e) = cage.terminate() {
                failures.push(e.to_string());
            }
        }

        // Put every workspace that drifted onto a headless output back
        // where the user had it, before the output itself disappears.
        let manager = WorkspaceManager::new(&self.hyprctl);
        let mut moved_back = Vec::new();
        match manager.restore(&session.layout) {
            Ok(report) => moved_back = report.moved_back,
            Err(e) => failures.push(format!("layout restore failed: {}", e)),
        }

        match self.hyprctl.remove_output(&session.output) {
            Ok(()) => {}
            Err(e) => {
                // Keep the session (minus the dead cage) so teardown can
                // be retried after a transient hyprctl failure.
                failures.push(format!("failed to remove {}: {}", session.output, e));
                session.cage = None;
                *session_guard = Some(session);
                return error(id, failures.join("; "));
            }
        }

        if failures.is_empty() {
            Handled {
                response: Response::ok_with(
                    id,
                    serde_json::json!({
                        "removed": [session.output],
                        "moved_back": moved_back,
                        "cage_terminated": cage_terminated,
                    }),
                ),
                binary: None,
            }
        } else {
            error(id, failures.join("; "))
        }
    }
}

impl ServerState<crate::hyprctl::SystemRunner, SystemSpawner, GrimCapture, WaylandInputConnector> {
    /// The real driver state: hyprctl on PATH, grim for capture, cage on
    /// PATH, virtual input into cage's socket, sockets in the session
    /// runtime dir.
    pub fn system() -> Self {
        let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".to_string());
        ServerState::new(
            HyprCtl::system(),
            SystemSpawner,
            GrimCapture::default(),
            WaylandInputConnector,
            "cage",
            runtime_dir,
        )
    }
}

/// One command's outcome: the JSON response plus an optional binary frame
/// (screenshots send PNG bytes here).
pub struct Handled {
    pub response: Response,
    pub binary: Option<Vec<u8>>,
}

fn error(id: u64, e: impl std::fmt::Display) -> Handled {
    Handled {
        response: Response::err(id, e.to_string()),
        binary: None,
    }
}

const SIGTERM: i32 = 15;

/// Polls `hyprctl clients -j` until a client whose pid matches appears.
fn wait_for_client<C: CommandRunner>(
    ctl: &HyprCtl<C>,
    pid: u32,
) -> Result<Client, String> {
    let deadline = Instant::now() + WINDOW_APPEAR_TIMEOUT;
    loop {
        let clients = ctl.list_clients().map_err(|e| e.to_string())?;
        if let Some(client) = clients.iter().find(|c| c.pid == pid) {
            return Ok(client.clone());
        }
        if let Ok(Some(_)) = ctl_pid_exited(pid) {
            return Err(format!("process {} exited before its window appeared", pid));
        }
        if Instant::now() >= deadline {
            return Err(format!("window for pid {} did not appear in time", pid));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Checks whether a pid is still alive, via signal 0 (existence probe).
fn ctl_pid_exited(pid: u32) -> io::Result<Option<()>> {
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        Ok(None)
    } else {
        let err = io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::ESRCH) => Ok(Some(())),
            Some(libc::EPERM) => Ok(None), // alive but not ours
            _ => Err(err),
        }
    }
}

/// Serves one connection: request frame in, response frame out, until the
/// peer closes. Malformed requests get an error response with id 0 (the id
/// cannot be recovered from an unparsable payload).
pub fn serve_connection<C, S, G, I>(stream: &mut UnixStream, state: &ServerState<C, S, G, I>) -> io::Result<()>
where
    C: CommandRunner,
    S: ProcessSpawner,
    G: CaptureRunner,
    I: InputConnector,
{
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
    use crate::ipc::{parse_response, MouseButton};
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};
    use std::sync::{Arc, Mutex};

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

    fn client(address: &str, pid: u32, workspace: &str) -> Client {
        Client {
            address: address.to_string(),
            class: "wlroots".to_string(),
            title: "cage".to_string(),
            pid,
            workspace: Some(crate::hyprctl::ClientWorkspace {
                name: workspace.to_string(),
            }),
        }
    }

    /// Shared state between the hyprctl mock and the spawner mock, so a
    /// spawned cage "process" can appear as a Hyprland client.
    struct MockState {
        monitors: Mutex<Vec<String>>,
        workspaces: Mutex<Vec<crate::hyprctl::Workspace>>,
        clients: Mutex<Vec<Client>>,
        dispatches: Mutex<Vec<String>>,
        spawned_processes: Mutex<Vec<SpawnedProcess>>,
        /// When true, the output create grabs one of the user's workspaces
        /// instead of a fresh empty one (both behaviors seen on 0.56).
        grab_user: std::sync::atomic::AtomicBool,
        remove_fails: std::sync::atomic::AtomicBool,
    }

    impl Default for MockState {
        fn default() -> Self {
            MockState {
                monitors: Mutex::new(Vec::new()),
                workspaces: Mutex::new(Vec::new()),
                clients: Mutex::new(Vec::new()),
                dispatches: Mutex::new(Vec::new()),
                spawned_processes: Mutex::new(Vec::new()),
                grab_user: std::sync::atomic::AtomicBool::new(false),
                remove_fails: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }

    struct SpawnedProcess {
        program: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
        signals_seen: Arc<Mutex<Vec<i32>>>,
    }

    struct MockHyprland {
        state: Arc<MockState>,
    }

    impl CommandRunner for MockHyprland {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            let state = &self.state;
            match args {
                ["monitors", "-j"] => {
                    let monitors = state.monitors.lock().unwrap();
                    let entries: Vec<String> = monitors
                        .iter()
                        .enumerate()
                        .map(|(i, name)| format!(r#"{{"id": {}, "name": "{}"}}"#, i, name))
                        .collect();
                    Ok(ok(&format!("[{}]", entries.join(","))))
                }
                ["workspaces", "-j"] => {
                    let workspaces = state.workspaces.lock().unwrap();
                    let entries: Vec<String> = workspaces
                        .iter()
                        .map(|w| {
                            format!(
                                r#"{{"id": {}, "name": "{}", "monitor": "{}", "windows": {}}}"#,
                                w.id, w.name, w.monitor, w.windows
                            )
                        })
                        .collect();
                    Ok(ok(&format!("[{}]", entries.join(","))))
                }
                ["clients", "-j"] => {
                    let clients = state.clients.lock().unwrap();
                    let entries: Vec<String> = clients
                        .iter()
                        .map(|c| {
                            let ws = c
                                .workspace
                                .as_ref()
                                .map(|w| format!(r#"{{"id": 0, "name": "{}"}}"#, w.name))
                                .unwrap_or_else(|| "null".to_string());
                            format!(
                                r#"{{"address": "{}", "class": "{}", "title": "{}",
                                    "pid": {}, "monitor": 0, "workspace": {}}}"#,
                                c.address, c.class, c.title, c.pid, ws
                            )
                        })
                        .collect();
                    Ok(ok(&format!("[{}]", entries.join(","))))
                }
                ["output", "create", "headless"] => {
                    let mut monitors = state.monitors.lock().unwrap();
                    let max = monitors
                        .iter()
                        .filter(|n| is_headless(n))
                        .filter_map(|n| n.rsplit('-').next().and_then(|s| s.parse::<u32>().ok()))
                        .max()
                        .unwrap_or(1);
                    let name = format!("HEADLESS-{}", max + 1);
                    monitors.push(name.clone());
                    drop(monitors);
                    // Hyprland grabs a workspace for the new output
                    // immediately: a fresh empty one, or one of the user's
                    // (grab_user).
                    let mut workspaces = state.workspaces.lock().unwrap();
                    if state.grab_user.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Some(user_ws) = workspaces
                            .iter_mut()
                            .find(|w| w.name != "1" && w.name.parse::<u32>().is_ok())
                        {
                            user_ws.monitor = name;
                        }
                    } else {
                        let next_id = workspaces.iter().map(|w| w.id).max().unwrap_or(0) + 1;
                        workspaces.push(crate::hyprctl::Workspace {
                            id: next_id,
                            name: next_id.to_string(),
                            monitor: name,
                            windows: 0,
                        });
                    }
                    Ok(ok("ok"))
                }
                ["output", "remove", name] => {
                    if state.remove_fails.load(std::sync::atomic::Ordering::SeqCst) {
                        return Ok(failed("error removing output"));
                    }
                    state.monitors.lock().unwrap().retain(|n| n != name);
                    // Workspaces on a removed output are destroyed.
                    state
                        .workspaces
                        .lock()
                        .unwrap()
                        .retain(|w| w.monitor != *name);
                    Ok(ok("ok"))
                }
                ["dispatch", rest @ ..] => {
                    // dispatch args arrive as one joined string (legacy
                    // form) or one lua expression; normalize to legacy
                    // words for the in-memory behavior below.
                    let joined = rest.join(" ");
                    state.dispatches.lock().unwrap().push(joined.clone());
                    let mut words = joined.split_whitespace();
                    let dispatcher = words.next().unwrap_or("");
                    let dispatch_args: Vec<&str> = words.collect();
                    match (dispatcher, dispatch_args.as_slice()) {
                        // movetoworkspacesilent <ws>,address:<addr>: move
                        // the client and, like Hyprland, create the
                        // workspace if it does not exist. Placement on the
                        // physical monitor simulates Hyprland's default
                        // pick; the driver is expected to pin afterwards.
                        ("movetoworkspacesilent", [spec]) => {
                            let (ws, addr) = spec.split_once(",address:").ok_or_else(|| {
                                io::Error::other("bad movetoworkspacesilent spec")
                            })?;
                            let mut clients = state.clients.lock().unwrap();
                            for c in clients.iter_mut() {
                                if c.address == addr {
                                    c.workspace = Some(crate::hyprctl::ClientWorkspace {
                                        name: ws.to_string(),
                                    });
                                }
                            }
                            let mut workspaces = state.workspaces.lock().unwrap();
                            if !workspaces.iter().any(|w| w.name == ws) {
                                let next_id = workspaces
                                    .iter()
                                    .map(|w| w.id)
                                    .max()
                                    .unwrap_or(0)
                                    + 1;
                                workspaces.push(crate::hyprctl::Workspace {
                                    id: next_id,
                                    name: ws.to_string(),
                                    monitor: "DP-3".to_string(),
                                    windows: 0,
                                });
                            }
                        }
                        // moveworkspacetomonitor <ws> <monitor>.
                        ("moveworkspacetomonitor", [ws, monitor]) => {
                            let mut workspaces = state.workspaces.lock().unwrap();
                            for w in workspaces.iter_mut() {
                                if w.name == *ws {
                                    w.monitor = monitor.to_string();
                                }
                            }
                        }
                        // renameworkspace <id> <name>.
                        ("renameworkspace", [id, name]) => {
                            let mut workspaces = state.workspaces.lock().unwrap();
                            for w in workspaces.iter_mut() {
                                if w.id.to_string() == *id {
                                    w.name = name.to_string();
                                }
                            }
                        }
                        _ => {}
                    }
                    Ok(ok("ok"))
                }
                _ => Err(io::Error::other("unexpected call")),
            }
        }
    }

    use crate::hyprctl::is_headless;

    /// Shared signals so tests can assert what the fake processes received.
    type SignalLog = Arc<Mutex<Vec<i32>>>;

    struct MockChild {
        pid: u32,
        signals: SignalLog,
    }

    impl ChildProcess for MockChild {
        fn pid(&self) -> u32 {
            self.pid
        }
        fn signal(&mut self, sig: i32) -> io::Result<()> {
            self.signals.lock().unwrap().push(sig);
            Ok(())
        }
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            // Fake processes exit as soon as they are signalled, so
            // teardown tests do not burn the 3s SIGTERM grace window.
            if self.signals.lock().unwrap().is_empty() {
                Ok(None)
            } else {
                Ok(Some(ExitStatus::from_raw(0)))
            }
        }
        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::from_raw(0))
        }
    }

    struct MockSpawner {
        state: Arc<MockState>,
        runtime_dir: PathBuf,
        fail: bool,
        next_pid: Mutex<u32>,
    }

    impl ProcessSpawner for MockSpawner {
        fn spawn(
            &self,
            program: &std::path::Path,
            args: &[String],
            env: &[(&str, String)],
        ) -> io::Result<Box<dyn ChildProcess>> {
            if self.fail {
                return Err(io::Error::other("exec format error"));
            }
            let mut next = self.next_pid.lock().unwrap();
            let pid = *next;
            *next += 2;
            drop(next);
            let signals: SignalLog = Default::default();
            self.state.spawned_processes.lock().unwrap().push(SpawnedProcess {
                program: program.display().to_string(),
                args: args.to_vec(),
                env: env
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
                signals_seen: signals.clone(),
            });
            // A spawned cage registers itself as a Hyprland client and
            // creates its Wayland socket, like the real thing.
            self.state
                .clients
                .lock()
                .unwrap()
                .push(client("0xcage", pid, "DP-3"));
            std::fs::create_dir_all(&self.runtime_dir).unwrap();
            std::fs::write(
                crate::cage::cage_socket_path(&self.runtime_dir, CAGE_SOCKET_NAME),
                b"",
            )
            .unwrap();
            Ok(Box::new(MockChild { pid, signals }))
        }
    }

    struct MockCapture;

    impl CaptureRunner for MockCapture {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            assert_eq!(args, ["-o", "HEADLESS-2", "-"]);
            let mut png = crate::screencopy::PNG_SIGNATURE.to_vec();
            png.extend_from_slice(b"captured");
            Ok(Output {
                status: ExitStatus::from_raw(0),
                stdout: png,
                stderr: Vec::new(),
            })
        }
    }

    // --- Virtual input mocks ---

    /// Records high-level seat operations instead of Wayland requests.
    struct MockSeat {
        log: Arc<Mutex<Vec<String>>>,
    }

    impl VirtualSeat for MockSeat {
        fn move_pointer(&mut self, x: i32, y: i32, w: u32, h: u32) -> Result<(), InputError> {
            self.log.lock().unwrap().push(format!("move {x} {y} {w} {h}"));
            Ok(())
        }
        fn click(
            &mut self,
            x: i32,
            y: i32,
            button: MouseButton,
            w: u32,
            h: u32,
        ) -> Result<(), InputError> {
            self.log
                .lock()
                .unwrap()
                .push(format!("click {} {} {:?} {w} {h}", x, y, button));
            Ok(())
        }
        fn type_text(&mut self, text: &str) -> Result<(), InputError> {
            self.log.lock().unwrap().push(format!("type {text}"));
            Ok(())
        }
        fn press_keys(&mut self, keys: &[String]) -> Result<(), InputError> {
            self.log.lock().unwrap().push(format!("keys {}", keys.join("+")));
            Ok(())
        }
        fn flush(&mut self) -> Result<(), InputError> {
            Ok(())
        }
    }

    /// Hands out recording seats; counts connections and can fail.
    struct MockConnector {
        log: Arc<Mutex<Vec<String>>>,
        fail: bool,
        connections: std::sync::atomic::AtomicUsize,
    }

    impl MockConnector {
        fn new() -> Self {
            MockConnector {
                log: Arc::new(Mutex::new(Vec::new())),
                fail: false,
                connections: std::sync::atomic::AtomicUsize::new(0),
            }
        }
    }

    impl InputConnector for MockConnector {
        fn connect(&self, _socket: &std::path::Path) -> Result<Box<dyn VirtualSeat>, InputError> {
            self.connections
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self.fail {
                return Err(InputError::Connect("connection refused".to_string()));
            }
            Ok(Box::new(MockSeat {
                log: self.log.clone(),
            }))
        }
    }

    fn ws(id: i64, name: &str, monitor: &str, windows: u32) -> crate::hyprctl::Workspace {
        crate::hyprctl::Workspace {
            id,
            name: name.to_string(),
            monitor: monitor.to_string(),
            windows,
        }
    }

    fn make_state() -> Arc<MockState> {
        let state = Arc::new(MockState::default());
        *state.monitors.lock().unwrap() = vec!["DP-3".to_string()];
        *state.workspaces.lock().unwrap() = vec![
            ws(1, "1", "DP-3", 1),
            ws(2, "2", "DP-3", 2),
        ];
        state
    }

    /// Unique per-test runtime dirs so fake cage sockets never collide.
    fn unique_runtime_dir() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("staka-server-test-{}-{}", std::process::id(), n))
    }

    fn make_server(
        state: Arc<MockState>,
    ) -> ServerState<MockHyprland, MockSpawner, MockCapture, MockConnector> {
        let runtime_dir = unique_runtime_dir();
        ServerState::new(
            HyprCtl::new(MockHyprland { state: state.clone() }),
            MockSpawner {
                state,
                runtime_dir: runtime_dir.clone(),
                fail: false,
                next_pid: Mutex::new(4242),
            },
            MockCapture,
            MockConnector::new(),
            "/usr/bin/cage",
            runtime_dir,
        )
    }

    fn make_request(id: u64, command: Command) -> Request {
        Request { id, command }
    }

    #[test]
    fn health_returns_hyprland_status() {
        let state = make_server(make_state());
        let handled = state.handle(&make_request(1, Command::Health {}));
        assert_eq!(
            handled.response,
            Response::ok_with(1, serde_json::json!({ "hyprland": true }))
        );
        assert!(handled.binary.is_none());
    }

    #[test]
    fn health_reports_session_probe_with_live_cage() {
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let _ = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("gnome-calculator".into()),
            },
        ));
        let handled = server.handle(&make_request(2, Command::Health {}));
        assert!(handled.response.ok);
        let data = handled.response.data.unwrap();
        let session = data["session"].as_object().unwrap();
        assert_eq!(session["active"], serde_json::json!(true));
        assert_eq!(session["cage_alive"], serde_json::json!(true));
        assert_eq!(session["output_present"], serde_json::json!(true));
        assert_eq!(session["output"], serde_json::json!("HEADLESS-2"));
        assert_eq!(session["workspace"], serde_json::json!("staka-agent-1"));
        assert_eq!(session["app"], serde_json::json!("gnome-calculator"));
    }

    #[test]
    fn health_reports_a_dead_cage() {
        // After a suspend/resume cycle the cage can be dead while its
        // output still exists: the health probe must say so, without
        // waiting on anything.
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let _ = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        // Simulate the cage process exiting: the fake child reports exit
        // as soon as it is signalled.
        mock.spawned_processes.lock().unwrap()[0]
            .signals_seen
            .lock()
            .unwrap()
            .push(15);
        let handled = server.handle(&make_request(2, Command::Health {}));
        let data = handled.response.data.unwrap();
        assert_eq!(data["session"]["cage_alive"], serde_json::json!(false));
        assert_eq!(data["session"]["output_present"], serde_json::json!(true));
    }

    #[test]
    fn health_reports_a_missing_headless_output() {
        // Hyprland can drop a headless output across a suspend; the probe
        // must catch that too.
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let _ = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        mock.monitors.lock().unwrap().retain(|n| n != "HEADLESS-2");
        let handled = server.handle(&make_request(2, Command::Health {}));
        let data = handled.response.data.unwrap();
        assert_eq!(data["session"]["cage_alive"], serde_json::json!(true));
        assert_eq!(data["session"]["output_present"], serde_json::json!(false));
    }

    #[test]
    fn create_workspace_without_app_adopts_the_grabbed_workspace() {
        let mock = make_state();
        let server = make_server(mock.clone());

        let handled = server.handle(&make_request(1, Command::CreateWorkspace { app: None }));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({
                "output": "HEADLESS-2",
                "workspace": "staka-agent-1",
            }))
        );
        // The fresh workspace Hyprland grabbed was renamed to the agent
        // name; the user's workspaces are untouched.
        let workspaces = mock.workspaces.lock().unwrap();
        let agent_ws = workspaces
            .iter()
            .find(|w| w.name == "staka-agent-1")
            .expect("agent workspace exists");
        assert_eq!(agent_ws.monitor, "HEADLESS-2");
        assert_eq!(
            workspaces
                .iter()
                .find(|w| w.name == "2")
                .map(|w| w.monitor.as_str()),
            Some("DP-3")
        );
        drop(workspaces);

        let handled = server.handle(&make_request(2, Command::Teardown {}));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({
                "removed": ["HEADLESS-2"],
                "moved_back": [],
                "cage_terminated": false,
            }))
        );
        // Layout fully restored: monitors and workspaces as before.
        assert_eq!(*mock.monitors.lock().unwrap(), vec!["DP-3"]);
        assert_eq!(
            *mock.workspaces.lock().unwrap(),
            vec![ws(1, "1", "DP-3", 1), ws(2, "2", "DP-3", 2)]
        );
    }

    #[test]
    fn create_workspace_with_app_spawns_cage_and_pins_agent_workspace() {
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let handled = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("gnome-calculator".into()),
            },
        ));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({
                "output": "HEADLESS-2",
                "workspace": "staka-agent-1",
                "cage_pid": 4242,
                "socket": "staka-cage",
            }))
        );

        // Cage was launched with the right command line and env.
        let spawned = mock.spawned_processes.lock().unwrap();
        assert_eq!(spawned.len(), 1);
        assert_eq!(spawned[0].program, "/usr/bin/cage");
        assert_eq!(
            spawned[0].args,
            vec![
                "-S".to_string(),
                "staka-cage".to_string(),
                "-W".to_string(),
                "1920".to_string(),
                "-H".to_string(),
                "1080".to_string(),
                "--".to_string(),
                "gnome-calculator".to_string(),
            ]
        );
        assert!(spawned[0]
            .env
            .contains(&("WAYLAND_DISPLAY".to_string(), "wayland-1".to_string())));
        drop(spawned);

        // The fresh grabbed workspace was adopted (renamed), so the cage
        // window was moved straight onto the output-hosting workspace: no
        // pin needed, no user workspace touched.
        let dispatches = mock.dispatches.lock().unwrap();
        assert!(dispatches
            .iter()
            .any(|d| d == "movetoworkspacesilent staka-agent-1,address:0xcage"));
        assert!(
            !dispatches
                .iter()
                .any(|d| d.starts_with("moveworkspacetomonitor")),
            "adopted workspace needs no pin, got {:?}",
            *dispatches
        );
        drop(dispatches);
        let workspaces = mock.workspaces.lock().unwrap();
        let agent_ws = workspaces.iter().find(|w| w.name == "staka-agent-1");
        assert_eq!(
            agent_ws.map(|w| w.monitor.as_str()),
            Some("HEADLESS-2")
        );
        drop(workspaces);

        // Teardown kills cage and removes the output.
        let handled = server.handle(&make_request(2, Command::Teardown {}));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({
                "removed": ["HEADLESS-2"],
                "moved_back": [],
                "cage_terminated": true,
            }))
        );
        assert_eq!(*mock.monitors.lock().unwrap(), vec!["DP-3"]);
    }

    #[test]
    fn create_workspace_pins_and_restores_when_hyprland_grabs_a_user_workspace() {
        // Some Hyprland states make the output grab one of the user's
        // workspaces instead of a fresh one. The driver must give it back
        // and pin its own workspace instead.
        let mock = make_state();
        mock.grab_user
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let handled = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        assert!(handled.response.ok, "{:?}", handled.response);

        // User workspace 2 was given back; the agent workspace is on the
        // invisible output.
        let workspaces = mock.workspaces.lock().unwrap();
        assert_eq!(
            workspaces
                .iter()
                .find(|w| w.name == "2")
                .map(|w| w.monitor.as_str()),
            Some("DP-3"),
            "user workspace must be given back"
        );
        let agent_ws = workspaces
            .iter()
            .find(|w| w.name.starts_with("staka-agent-"))
            .expect("agent workspace exists");
        assert_eq!(agent_ws.monitor, "HEADLESS-2");
        drop(workspaces);
        assert!(mock
            .dispatches
            .lock()
            .unwrap()
            .iter()
            .any(|d| d.contains("moveworkspacetomonitor")));

        let handled = server.handle(&make_request(2, Command::Teardown {}));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(*mock.monitors.lock().unwrap(), vec!["DP-3"]);
    }

    #[test]
    fn create_workspace_never_hijacks_a_user_workspace_number() {
        // The point of the whole exercise: the mock Hyprland starts with
        // user workspaces 1 and 2 on DP-3, and the agent workspace must be
        // a prefixed named workspace, never "2".
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let handled = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        assert!(handled.response.ok);
        let workspace = handled.response.data.unwrap()["workspace"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(workspace.starts_with("staka-agent-"));
        // User workspaces untouched.
        let workspaces = mock.workspaces.lock().unwrap();
        assert!(workspaces.iter().any(|w| w.name == "2"));
        assert_eq!(
            workspaces
                .iter()
                .find(|w| w.name == "2")
                .map(|w| w.monitor.as_str()),
            Some("DP-3")
        );
    }

    #[test]
    fn second_create_is_rejected_until_teardown() {
        let server = make_server(make_state());
        let handled = server.handle(&make_request(1, Command::CreateWorkspace { app: None }));
        assert!(handled.response.ok);
        let handled = server.handle(&make_request(2, Command::CreateWorkspace { app: None }));
        assert!(!handled.response.ok);
        assert!(handled
            .response
            .error
            .unwrap()
            .contains("already active"));
    }

    #[test]
    fn failed_cage_launch_cleans_up_output_and_reports() {
        let mock = make_state();
        let server = {
            let spawner = MockSpawner {
                state: mock.clone(),
                runtime_dir: unique_runtime_dir(),
                fail: true,
                next_pid: Mutex::new(4242),
            };
            ServerState::new(
                HyprCtl::new(MockHyprland { state: mock.clone() }),
                spawner,
                MockCapture,
                MockConnector::new(),
                "/usr/bin/cage",
                unique_runtime_dir(),
            )
        };
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let handled = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        assert!(!handled.response.ok);
        // The headless output was rolled back; nothing lingers.
        assert_eq!(*mock.monitors.lock().unwrap(), vec!["DP-3"]);
        assert!(server.session.lock().unwrap().is_none());
    }

    #[test]
    fn screenshot_requires_a_session() {
        let server = make_server(make_state());
        let handled = server.handle(&make_request(
            1,
            Command::Screenshot {
                format: ImageFormat::Png,
            },
        ));
        assert!(!handled.response.ok);
    }

    #[test]
    fn screenshot_returns_binary_frame_payload() {
        let server = make_server(make_state());
        let _ = server.handle(&make_request(1, Command::CreateWorkspace { app: None }));
        let handled = server.handle(&make_request(
            2,
            Command::Screenshot {
                format: ImageFormat::Png,
            },
        ));
        assert!(handled.response.ok);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({ "binary": true }))
        );
        let png = handled.binary.expect("screenshot must carry bytes");
        assert!(crate::screencopy::is_png(&png));
        assert!(png.ends_with(b"captured"));
    }

    #[test]
    fn run_app_spawns_into_the_cage_socket() {
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let handled = server.handle(&make_request(1, Command::RunApp { app: "foot".into() }));
        assert!(!handled.response.ok, "no session yet");

        let _ = server.handle(&make_request(2, Command::CreateWorkspace { app: None }));
        let handled = server.handle(&make_request(
            3,
            Command::RunApp { app: "foot".into() },
        ));
        assert!(!handled.response.ok, "no cage in this session");

        let _ = server.handle(&make_request(4, Command::Teardown {}));
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        let _ = server.handle(&make_request(
            5,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        let handled = server.handle(&make_request(
            6,
            Command::RunApp {
                app: "libreoffice --calc".into(),
            },
        ));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({ "pid": 4244 }))
        );
        let spawned = mock.spawned_processes.lock().unwrap();
        let last = spawned.last().unwrap();
        assert_eq!(last.program, "libreoffice");
        assert_eq!(last.args, vec!["--calc".to_string()]);
        assert_eq!(
            last.env,
            vec![("WAYLAND_DISPLAY".to_string(), "staka-cage".to_string())]
        );
    }

    #[test]
    fn teardown_kills_spawned_apps_before_the_cage() {
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        let _ = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        let _ = server.handle(&make_request(
            2,
            Command::RunApp { app: "xterm".into() },
        ));

        let handled = server.handle(&make_request(3, Command::Teardown {}));
        assert!(handled.response.ok, "{:?}", handled.response);

        let signals: Vec<Vec<i32>> = mock
            .spawned_processes
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.signals_seen.lock().unwrap().clone())
            .collect();
        for seen in signals {
            assert!(
                seen.contains(&SIGTERM),
                "every spawned app must be terminated, saw {:?}",
                seen
            );
        }
    }

    #[test]
    fn teardown_without_session_reports_empty() {
        let server = make_server(make_state());
        let handled = server.handle(&make_request(1, Command::Teardown {}));
        assert!(handled.response.ok);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({ "removed": [] }))
        );
    }

    #[test]
    fn teardown_keeps_session_for_retry_when_output_removal_fails() {
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        let _ = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));

        mock.remove_fails
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let handled = server.handle(&make_request(2, Command::Teardown {}));
        assert!(!handled.response.ok);
        // Cage was terminated already; the output stays registered so a
        // retry only has to remove the output.
        assert!(server.session.lock().unwrap().is_some());
        assert_eq!(*mock.monitors.lock().unwrap(), vec!["DP-3", "HEADLESS-2"]);

        mock.remove_fails
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let handled = server.handle(&make_request(3, Command::Teardown {}));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert!(server.session.lock().unwrap().is_none());
        assert_eq!(*mock.monitors.lock().unwrap(), vec!["DP-3"]);
    }

    #[test]
    fn teardown_reports_layout_restore_moves() {
        let mock = make_state();
        let server = make_server(mock.clone());
        let _ = server.handle(&make_request(1, Command::CreateWorkspace { app: None }));
        // Simulate a user workspace drifting onto the headless output
        // while the session was active.
        {
            let mut workspaces = mock.workspaces.lock().unwrap();
            workspaces.retain(|w| w.name != "2");
            workspaces.push(ws(2, "2", "HEADLESS-2", 2));
        }

        let handled = server.handle(&make_request(2, Command::Teardown {}));
        assert!(handled.response.ok, "{:?}", handled.response);
        assert_eq!(
            handled.response.data,
            Some(serde_json::json!({
                "removed": ["HEADLESS-2"],
                "moved_back": ["2"],
                "cage_terminated": false,
            }))
        );
        assert_eq!(
            *mock.workspaces.lock().unwrap(),
            vec![ws(1, "1", "DP-3", 1), ws(2, "2", "DP-3", 2)]
        );
    }

    #[test]
    fn input_commands_route_to_the_cage_seat() {
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");

        let handled = server.handle(&make_request(
            1,
            Command::Click {
                x: 320,
                y: 240,
                button: MouseButton::Left,
            },
        ));
        assert!(!handled.response.ok, "no session yet");
        let _ = server.handle(&make_request(
            2,
            Command::CreateWorkspace { app: None },
        ));
        let handled = server.handle(&make_request(
            3,
            Command::Click {
                x: 1,
                y: 2,
                button: MouseButton::Left,
            },
        ));
        assert!(!handled.response.ok, "no cage in this session");

        let _ = server.handle(&make_request(4, Command::Teardown {}));
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        let _ = server.handle(&make_request(
            5,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        for (id, cmd) in [
            (
                6,
                Command::Click {
                    x: 320,
                    y: 240,
                    button: MouseButton::Left,
                },
            ),
            (7, Command::MovePointer { x: 10, y: 20 }),
            (8, Command::TypeText { text: "hi".into() }),
            (
                9,
                Command::PressKeys {
                    keys: vec!["ctrl".into(), "s".into()],
                },
            ),
        ] {
            let handled = server.handle(&make_request(id, cmd));
            assert!(handled.response.ok, "command {id}: {:?}", handled.response);
        }
        let events = server.input.log.lock().unwrap().clone();
        assert_eq!(
            events,
            vec![
                "click 320 240 Left 1920 1080".to_string(),
                "move 10 20 1920 1080".to_string(),
                "type hi".to_string(),
                "keys ctrl+s".to_string(),
            ]
        );
    }

    #[test]
    fn input_connection_is_created_once_and_reused() {
        let mock = make_state();
        let server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        let _ = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        for id in 2..5 {
            let handled = server.handle(&make_request(
                id,
                Command::MovePointer { x: id as i32, y: 0 },
            ));
            assert!(handled.response.ok);
        }
        assert_eq!(server.input.connections.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn input_connect_failure_reports_an_error_response() {
        let mock = make_state();
        let mut server = make_server(mock.clone());
        std::env::set_var("WAYLAND_DISPLAY", "wayland-1");
        let _ = server.handle(&make_request(
            1,
            Command::CreateWorkspace {
                app: Some("foot".into()),
            },
        ));
        server.input.fail = true;
        let handled = server.handle(&make_request(
            2,
            Command::Click {
                x: 1,
                y: 1,
                button: MouseButton::Left,
            },
        ));
        assert!(!handled.response.ok);
        assert!(handled
            .response
            .error
            .unwrap()
            .contains("connection refused"));
    }

    #[test]
    fn serve_connection_round_trips_screenshot_as_two_frames() {
        let (client, mut server_stream) = UnixStream::pair().unwrap();
        let server_state = make_server(make_state());
        let server_thread = std::thread::spawn(move || {
            serve_connection(&mut server_stream, &server_state).unwrap();
        });

        let mut client_w = client.try_clone().unwrap();
        let mut client_r = client.try_clone().unwrap();

        client_w
            .write_all(
                &crate::ipc::encode_request(&make_request(
                    1,
                    Command::CreateWorkspace { app: None },
                ))
                .unwrap()
                .encode(),
            )
            .unwrap();
        client_w
            .write_all(
                &crate::ipc::encode_request(&make_request(
                    2,
                    Command::Screenshot {
                        format: ImageFormat::Png,
                    },
                ))
                .unwrap()
                .encode(),
            )
            .unwrap();
        client_w.flush().unwrap();

        let frame = read_frame(&mut client_r).unwrap().unwrap();
        assert_eq!(frame.frame_type, FRAME_TYPE_JSON);
        let resp = parse_response(&frame.payload).unwrap();
        assert_eq!(resp.id, 1);
        assert!(resp.ok);

        let frame = read_frame(&mut client_r).unwrap().unwrap();
        assert_eq!(frame.frame_type, FRAME_TYPE_JSON);
        let resp = parse_response(&frame.payload).unwrap();
        assert_eq!(resp.id, 2);
        assert_eq!(resp.data, Some(serde_json::json!({ "binary": true })));

        let frame = read_frame(&mut client_r).unwrap().unwrap();
        assert_eq!(frame.frame_type, crate::ipc::FRAME_TYPE_BINARY);
        assert!(crate::screencopy::is_png(&frame.payload));

        drop(client_w);
        drop(client_r);
        drop(client);
        server_thread.join().unwrap();
    }
}

