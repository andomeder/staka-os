//! Compositor control by shelling out to `hyprctl`.
//!
//! Only three operations are needed against the user's Hyprland session:
//! create/remove a headless output and workspace dispatch. The heavy
//! Wayland protocol work (screencopy, virtual input) happens against the
//! nested compositor, not here. No Hyprland binding crate, so no
//! version-matching risk.
//!
//! The subprocess boundary is behind [`CommandRunner`] so parsing and
//! command construction are unit-testable without a Hyprland session.

use std::fmt;
use std::io;
use std::process::{Command, Output};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// A monitor/output as reported by `hyprctl monitors -j`. Only the fields
/// the driver needs are parsed; Hyprland emits more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Monitor {
    pub name: String,
}

/// A workspace as reported by `hyprctl workspaces -j`. `monitor` is the
/// output the workspace currently lives on (a name like `DP-3` or
/// `HEADLESS-2`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub id: i64,
    pub name: String,
    pub monitor: String,
    pub windows: u32,
}

/// The workspace reference embedded in a `hyprctl clients -j` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientWorkspace {
    pub name: String,
}

/// A window as reported by `hyprctl clients -j`. Only the fields the driver
/// needs are parsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Client {
    /// Hex address, e.g. `0x5557c66de9e0`, usable in dispatchers.
    pub address: String,
    pub class: String,
    pub title: String,
    pub pid: u32,
    pub workspace: Option<ClientWorkspace>,
}

#[derive(Debug)]
pub enum HyprError {
    /// The hyprctl subprocess could not be run.
    Io(io::Error),
    /// Command output could not be parsed.
    Parse(String),
    /// hyprctl ran but reported failure.
    Failed { command: String, detail: String },
}

impl fmt::Display for HyprError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HyprError::Io(e) => write!(f, "failed to run hyprctl: {}", e),
            HyprError::Parse(msg) => write!(f, "failed to parse hyprctl output: {}", msg),
            HyprError::Failed { command, detail } => {
                write!(f, "hyprctl {} failed: {}", command, detail)
            }
        }
    }
}

impl std::error::Error for HyprError {}

impl From<io::Error> for HyprError {
    fn from(e: io::Error) -> Self {
        HyprError::Io(e)
    }
}

/// Runs one hyprctl invocation. Abstracted so tests can feed canned output.
pub trait CommandRunner: Send + Sync {
    fn run(&self, args: &[&str]) -> io::Result<Output>;
}

/// The real runner: executes the `hyprctl` binary on PATH.
#[derive(Debug, Clone)]
pub struct SystemRunner {
    pub program: String,
}

impl Default for SystemRunner {
    fn default() -> Self {
        SystemRunner {
            program: "hyprctl".to_string(),
        }
    }
}

impl CommandRunner for SystemRunner {
    fn run(&self, args: &[&str]) -> io::Result<Output> {
        Command::new(&self.program).args(args).output()
    }
}

fn stdout_of(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn check_success(args: &[&str], output: &Output) -> Result<(), HyprError> {
    let command = args.join(" ");
    if !output.status.success() {
        return Err(HyprError::Failed {
            detail: stdout_of(output),
            command,
        });
    }
    let out = stdout_of(output).to_ascii_lowercase();
    if out.starts_with("invalid") || out.starts_with("error") {
        return Err(HyprError::Failed {
            detail: stdout_of(output),
            command,
        });
    }
    Ok(())
}

/// Parses `hyprctl monitors -j` output, keeping only monitor names.
pub fn parse_monitors(json: &str) -> Result<Vec<Monitor>, HyprError> {
    let values: Vec<serde_json::Value> = serde_json::from_str(json)
        .map_err(|e| HyprError::Parse(format!("monitors -j is not a JSON array: {}", e)))?;
    let monitors = values
        .into_iter()
        .map(|v| {
            let name = v
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or_else(|| HyprError::Parse("monitor entry missing name".to_string()))?
                .to_string();
            Ok(Monitor { name })
        })
        .collect::<Result<Vec<Monitor>, HyprError>>()?;
    Ok(monitors)
}

/// Parses `hyprctl workspaces -j` output, keeping id, name, monitor, and
/// window count.
pub fn parse_workspaces(json: &str) -> Result<Vec<Workspace>, HyprError> {
    let values: Vec<serde_json::Value> = serde_json::from_str(json)
        .map_err(|e| HyprError::Parse(format!("workspaces -j is not a JSON array: {}", e)))?;
    let mut workspaces = Vec::new();
    for v in values {
        let missing = |field: &str| HyprError::Parse(format!("workspace entry missing {}", field));
        workspaces.push(Workspace {
            id: v
                .get("id")
                .and_then(|i| i.as_i64())
                .ok_or_else(|| missing("id"))?,
            name: v
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or_else(|| missing("name"))?
                .to_string(),
            monitor: v
                .get("monitor")
                .and_then(|m| m.as_str())
                .ok_or_else(|| missing("monitor"))?
                .to_string(),
            windows: v
                .get("windows")
                .and_then(|w| w.as_u64())
                .ok_or_else(|| missing("windows"))?
                .try_into()
                .map_err(|_| HyprError::Parse("workspace window count out of range".to_string()))?,
        });
    }
    Ok(workspaces)
}

/// Parses `hyprctl clients -j` output, keeping the fields the driver needs.
pub fn parse_clients(json: &str) -> Result<Vec<Client>, HyprError> {
    let values: Vec<serde_json::Value> = serde_json::from_str(json)
        .map_err(|e| HyprError::Parse(format!("clients -j is not a JSON array: {}", e)))?;
    let mut clients = Vec::new();
    for v in values {
        let missing = |field: &str| HyprError::Parse(format!("client entry missing {}", field));
        clients.push(Client {
            address: v
                .get("address")
                .and_then(|a| a.as_str())
                .ok_or_else(|| missing("address"))?
                .to_string(),
            class: v
                .get("class")
                .and_then(|c| c.as_str())
                .ok_or_else(|| missing("class"))?
                .to_string(),
            title: v
                .get("title")
                .and_then(|t| t.as_str())
                .ok_or_else(|| missing("title"))?
                .to_string(),
            pid: v
                .get("pid")
                .and_then(|p| p.as_u64())
                .ok_or_else(|| missing("pid"))?
                .try_into()
                .map_err(|_| HyprError::Parse("client pid out of range".to_string()))?,
            workspace: v.get("workspace").and_then(|w| {
                let name = w.get("name").and_then(|n| n.as_str())?;
                Some(ClientWorkspace {
                    name: name.to_string(),
                })
            }),
        });
    }
    Ok(clients)
}

pub fn is_headless(name: &str) -> bool {
    name.starts_with("HEADLESS-")
}

/// The IPC command language Hyprland accepts for dispatchers.
///
/// Since Hyprland 0.55 the default Lua config makes the `dispatch` IPC
/// endpoint evaluate its payload as Lua, rejecting the legacy textual
/// syntax (`hyprctl dispatch movetoworkspacesilent 2,address:0x...` fails
/// with a Lua parse error). Sessions running the old hyprlang config still
/// speak only the legacy syntax. The driver probes once, caches what the
/// session accepts, and translates known dispatchers to the Lua form
/// (`hl.dsp.*`) when needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispatchSyntax {
    Legacy,
    Lua,
}

/// Hyprland's reply when the payload was evaluated as Lua and the legacy
/// textual syntax did not parse. Only these exact markers mean "wrong
/// syntax"; anything else is a real failure and must not trigger a retry.
fn is_syntax_rejection(detail: &str) -> bool {
    detail.contains("your syntax might need to be updated")
        || detail.contains("Invalid dispatcher")
}

fn dispatch_failed(args: &[&str], detail: &str) -> HyprError {
    HyprError::Failed {
        command: format!("dispatch {}", args.join(" ")),
        detail: detail.to_string(),
    }
}

/// Escapes a string for inclusion in a single-quoted Lua string literal.
fn lua_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// References a workspace in a Lua dispatcher argument: numeric IDs work
/// bare, named workspaces need the `name:` selector (verified against
/// Hyprland 0.56; a bare name is rejected as an invalid workspace).
fn lua_workspace_ref(workspace: &str) -> String {
    if workspace.parse::<i64>().is_ok() {
        workspace.to_string()
    } else {
        format!("name:{}", lua_escape(workspace))
    }
}

/// Translates a legacy dispatcher invocation into the Lua dispatcher form.
/// Only dispatchers the driver actually uses are translated; anything else
/// returns None and the legacy form is sent as-is.
fn legacy_to_lua(args: &[&str]) -> Option<String> {
    match args {
        // movetoworkspacesilent <ws>,address:<window>: move a window to a
        // workspace without changing the user's focused workspace
        // (follow = false).
        ["movetoworkspacesilent", spec] => {
            let (workspace, window) = spec.split_once(",address:")?;
            Some(format!(
                "hl.dsp.window.move({{ workspace = '{}', follow = false, window = 'address:{}' }})",
                lua_workspace_ref(workspace),
                lua_escape(window),
            ))
        }
        // moveworkspacetomonitor <ws> <monitor>: move a workspace to a
        // monitor.
        ["moveworkspacetomonitor", workspace, monitor] => Some(format!(
            "hl.dsp.workspace.move({{ workspace = '{}', monitor = '{}' }})",
            lua_workspace_ref(workspace),
            lua_escape(monitor),
        )),
        // renameworkspace <id> <name>: rename a workspace by numeric id.
        ["renameworkspace", id, name] => Some(format!(
            "hl.dsp.workspace.rename({{ workspace = {}, name = '{}' }})",
            id,
            lua_escape(name),
        )),
        _ => None,
    }
}

pub struct HyprCtl<C: CommandRunner = SystemRunner> {
    runner: C,
    syntax: Mutex<Option<DispatchSyntax>>,
}

impl HyprCtl<SystemRunner> {
    pub fn system() -> Self {
        HyprCtl {
            runner: SystemRunner::default(),
            syntax: Mutex::new(None),
        }
    }
}

impl<C: CommandRunner> HyprCtl<C> {
    pub fn new(runner: C) -> Self {
        HyprCtl {
            runner,
            syntax: Mutex::new(None),
        }
    }

    fn run(&self, args: &[&str]) -> Result<Output, HyprError> {
        self.runner.run(args).map_err(HyprError::Io)
    }

    fn monitors(&self) -> Result<Vec<Monitor>, HyprError> {
        let output = self.run(&["monitors", "-j"])?;
        check_success(&["monitors", "-j"], &output)?;
        parse_monitors(&stdout_of(&output))
    }

    /// Liveness probe: Hyprland answers `monitors -j` with parseable JSON.
    pub fn health_check(&self) -> Result<(), HyprError> {
        self.monitors().map(|_| ())
    }

    pub fn list_outputs(&self) -> Result<Vec<Monitor>, HyprError> {
        self.monitors()
    }

    /// Creates a headless output and returns its name (e.g. `HEADLESS-2`).
    ///
    /// `hyprctl output create headless` itself prints only "ok", so the new
    /// name is found by diffing the monitor list before and after.
    pub fn create_headless_output(&self) -> Result<String, HyprError> {
        let before: Vec<String> = self
            .monitors()?
            .into_iter()
            .map(|m| m.name)
            .collect();
        let output = self.run(&["output", "create", "headless"])?;
        check_success(&["output", "create", "headless"], &output)?;
        let after = self.monitors()?;
        let created = after
            .into_iter()
            .map(|m| m.name)
            .find(|name| is_headless(name) && !before.contains(name));
        created.ok_or_else(|| HyprError::Failed {
            command: "output create headless".to_string(),
            detail: "no new HEADLESS- output appeared in monitors -j".to_string(),
        })
    }

    /// Removes an output by name (e.g. a previously created headless one).
    pub fn remove_output(&self, name: &str) -> Result<(), HyprError> {
        let args = ["output", "remove", name];
        let output = self.run(&args)?;
        check_success(&args, &output)
    }

    /// Lists workspaces (name + current monitor).
    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, HyprError> {
        let args = ["workspaces", "-j"];
        let output = self.run(&args)?;
        check_success(&args, &output)?;
        parse_workspaces(&stdout_of(&output))
    }

    /// Lists windows (address, class, pid, workspace).
    pub fn list_clients(&self) -> Result<Vec<Client>, HyprError> {
        let args = ["clients", "-j"];
        let output = self.run(&args)?;
        check_success(&args, &output)?;
        parse_clients(&stdout_of(&output))
    }

    /// Runs a dispatcher given in legacy textual form, e.g.
    /// `dispatch(&["movetoworkspacesilent", "9,address:0x..."])`.
    ///
    /// The accepted syntax is detected on the first call and cached: on a
    /// hyprlang session the legacy form is sent as-is; on a Lua-config
    /// session (Hyprland 0.55+) the dispatcher is translated to its
    /// `hl.dsp.*` form and retried once when Hyprland rejects the legacy
    /// payload with the syntax-rejection marker.
    pub fn dispatch(&self, args: &[&str]) -> Result<(), HyprError> {
        let legacy = args.join(" ");
        match *self.syntax.lock().unwrap() {
            Some(DispatchSyntax::Legacy) => return self.dispatch_legacy(&legacy),
            Some(DispatchSyntax::Lua) => {
                return match legacy_to_lua(args) {
                    Some(lua) => self.dispatch_legacy(&lua),
                    None => self.dispatch_legacy(&legacy),
                }
            }
            None => {}
        }

        // First dispatch of the session: probe with the legacy form.
        let output = self.run(&["dispatch", &legacy])?;
        let detail = stdout_of(&output);
        if output.status.success() && !starts_with_error(&detail) {
            *self.syntax.lock().unwrap() = Some(DispatchSyntax::Legacy);
            return Ok(());
        }
        if is_syntax_rejection(&detail) {
            if let Some(lua) = legacy_to_lua(args) {
                let retried = self.run(&["dispatch", &lua])?;
                let retried_detail = stdout_of(&retried);
                if retried.status.success() && !starts_with_error(&retried_detail) {
                    *self.syntax.lock().unwrap() = Some(DispatchSyntax::Lua);
                    return Ok(());
                }
                return Err(dispatch_failed(args, &retried_detail));
            }
        }
        Err(dispatch_failed(args, &detail))
    }

    fn dispatch_legacy(&self, command: &str) -> Result<(), HyprError> {
        let args = ["dispatch", command];
        let output = self.run(&args)?;
        let detail = stdout_of(&output);
        if output.status.success() && !starts_with_error(&detail) {
            Ok(())
        } else {
            Err(HyprError::Failed {
                command: args.join(" "),
                detail,
            })
        }
    }
}

fn starts_with_error(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.starts_with("invalid") || lower.starts_with("error")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};
    use std::sync::Mutex;

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

    /// In-memory Hyprland: tracks headless outputs and reflects them in the
    /// monitors JSON, mirroring real hyprctl behavior.
    struct MockHyprland {
        monitors: Mutex<Vec<String>>,
        calls: Mutex<Vec<String>>,
        /// `output create headless` reports ok but no output appears.
        create_is_silent: bool,
        /// `output create headless` exits nonzero.
        create_fails: bool,
        /// Removing an unknown output exits nonzero (vs printing an error
        /// with exit 0, which older hyprctl versions do).
        remove_unknown_exits_nonzero: bool,
    }

    impl MockHyprland {
        fn new() -> Self {
            MockHyprland {
                monitors: Mutex::new(vec!["DP-3".to_string(), "HEADLESS-1".to_string()]),
                calls: Mutex::new(Vec::new()),
                create_is_silent: false,
                create_fails: false,
                remove_unknown_exits_nonzero: true,
            }
        }

        fn monitors_json(&self) -> String {
            let monitors = self.monitors.lock().unwrap();
            let entries: Vec<String> = monitors
                .iter()
                .enumerate()
                .map(|(i, name)| format!(r#"{{"id": {}, "name": "{}"}}"#, i, name))
                .collect();
            format!("[{}]", entries.join(", "))
        }
    }

    impl CommandRunner for MockHyprland {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            self.calls.lock().unwrap().push(args.join(" "));
            match args {
                ["monitors", "-j"] => Ok(ok(&self.monitors_json())),
                ["output", "create", "headless"] => {
                    if self.create_fails {
                        return Ok(failed("error creating output"));
                    }
                    if !self.create_is_silent {
                        let mut monitors = self.monitors.lock().unwrap();
                        let max = monitors
                            .iter()
                            .filter(|n| is_headless(n))
                            .filter_map(|n| n.rsplit('-').next().and_then(|s| s.parse::<u32>().ok()))
                            .max()
                            .unwrap_or(0);
                        monitors.push(format!("HEADLESS-{}", max + 1));
                    }
                    Ok(ok("ok"))
                }
                ["output", "remove", name] => {
                    let mut monitors = self.monitors.lock().unwrap();
                    if monitors.iter().any(|n| n == name) {
                        monitors.retain(|n| n != name);
                        Ok(ok("ok"))
                    } else if self.remove_unknown_exits_nonzero {
                        Ok(failed("invalid output"))
                    } else {
                        Ok(ok(&format!("Invalid output {}", name)))
                    }
                }
                ["dispatch", ..] => Ok(ok("ok")),
                _ => Err(io::Error::other("unexpected call")),
            }
        }
    }

    #[test]
    fn parses_monitor_names() {
        let monitors = parse_monitors(
            r#"[{"id": 0, "name": "DP-3", "description": "Dell U2415"},
                {"id": 1, "name": "HEADLESS-1", "description": "headless"}]"#,
        )
        .unwrap();
        assert_eq!(
            monitors,
            vec![
                Monitor { name: "DP-3".into() },
                Monitor {
                    name: "HEADLESS-1".into()
                },
            ]
        );
    }

    #[test]
    fn parse_monitors_rejects_non_json() {
        assert!(matches!(parse_monitors("not json"), Err(HyprError::Parse(_))));
    }

    #[test]
    fn parses_workspace_names_and_monitors() {
        let workspaces = parse_workspaces(
            r#"[{"id": 3, "name": "3", "monitor": "DP-3", "windows": 1},
                {"id": -98, "name": "special:magic", "monitor": "HEADLESS-2", "windows": 0}]"#,
        )
        .unwrap();
        assert_eq!(
            workspaces,
            vec![
                Workspace {
                    id: 3,
                    name: "3".into(),
                    monitor: "DP-3".into(),
                    windows: 1,
                },
                Workspace {
                    id: -98,
                    name: "special:magic".into(),
                    monitor: "HEADLESS-2".into(),
                    windows: 0,
                },
            ]
        );
    }

    #[test]
    fn parse_workspaces_rejects_missing_monitor() {
        assert!(matches!(
            parse_workspaces(r#"[{"id": 3, "name": "3"}]"#),
            Err(HyprError::Parse(_))
        ));
    }

    #[test]
    fn parse_workspaces_rejects_non_json() {
        assert!(matches!(parse_workspaces("not json"), Err(HyprError::Parse(_))));
    }

    #[test]
    fn parses_clients() {
        let clients = parse_clients(
            r#"[{"address": "0x1234", "class": "wlroots", "title": "cage",
                 "pid": 4242, "monitor": 1,
                 "workspace": {"id": -1337, "name": "staka-agent-1"}},
                {"address": "0x5678", "class": "foot", "title": "term",
                 "pid": 7, "monitor": 0, "workspace": {"id": 0, "name": "1"}}]"#,
        )
        .unwrap();
        assert_eq!(
            clients,
            vec![
                Client {
                    address: "0x1234".into(),
                    class: "wlroots".into(),
                    title: "cage".into(),
                    pid: 4242,
                    workspace: Some(ClientWorkspace {
                        name: "staka-agent-1".into()
                    }),
                },
                Client {
                    address: "0x5678".into(),
                    class: "foot".into(),
                    title: "term".into(),
                    pid: 7,
                    workspace: Some(ClientWorkspace { name: "1".into() }),
                },
            ]
        );
    }

    #[test]
    fn parse_clients_handles_null_workspace() {
        let clients = parse_clients(
            r#"[{"address": "0x1", "class": "x", "title": "y", "pid": 1,
                 "monitor": 0, "workspace": null}]"#,
        )
        .unwrap();
        assert_eq!(clients[0].workspace, None);
    }

    #[test]
    fn parse_clients_rejects_missing_pid() {
        assert!(matches!(
            parse_clients(r#"[{"address": "0x1", "class": "x", "title": "y", "monitor": 0}]"#),
            Err(HyprError::Parse(_))
        ));
    }

    #[test]
    fn headless_detection() {
        assert!(is_headless("HEADLESS-2"));
        assert!(!is_headless("DP-3"));
        assert!(!is_headless("HEADLESSHDMI"));
    }

    #[test]
    fn create_headless_output_returns_new_name() {
        let ctl = HyprCtl::new(MockHyprland::new());
        assert_eq!(ctl.create_headless_output().unwrap(), "HEADLESS-2");
    }

    #[test]
    fn create_headless_output_errors_when_no_new_output_appears() {
        let mut mock = MockHyprland::new();
        mock.create_is_silent = true;
        let ctl = HyprCtl::new(mock);
        let err = ctl.create_headless_output().unwrap_err();
        assert!(matches!(err, HyprError::Failed { .. }));
    }

    #[test]
    fn create_headless_output_errors_when_create_fails() {
        let mut mock = MockHyprland::new();
        mock.create_fails = true;
        let ctl = HyprCtl::new(mock);
        assert!(ctl.create_headless_output().is_err());
    }

    #[test]
    fn remove_output_succeeds_for_existing_output() {
        let ctl = HyprCtl::new(MockHyprland::new());
        ctl.remove_output("HEADLESS-1").unwrap();
        let names: Vec<String> = ctl
            .list_outputs()
            .unwrap()
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert!(!names.contains(&"HEADLESS-1".to_string()));
    }

    #[test]
    fn remove_output_reports_nonzero_exit() {
        let ctl = HyprCtl::new(MockHyprland::new());
        let err = ctl.remove_output("HEADLESS-9").unwrap_err();
        assert!(matches!(err, HyprError::Failed { .. }));
    }

    #[test]
    fn remove_output_rejects_error_text_on_zero_exit() {
        // Some hyprctl versions print errors on stdout with exit 0.
        let mut mock = MockHyprland::new();
        mock.remove_unknown_exits_nonzero = false;
        let ctl = HyprCtl::new(mock);
        let err = ctl.remove_output("HEADLESS-9").unwrap_err();
        assert!(matches!(err, HyprError::Failed { .. }));
    }

    #[test]
    fn health_check_passes_on_valid_monitors_json() {
        let ctl = HyprCtl::new(MockHyprland::new());
        ctl.health_check().unwrap();
    }

    #[test]
    fn health_check_fails_on_bad_output() {
        struct BadRunner;
        impl CommandRunner for BadRunner {
            fn run(&self, _args: &[&str]) -> io::Result<Output> {
                Ok(ok("garbage"))
            }
        }
        let ctl = HyprCtl::new(BadRunner);
        assert!(ctl.health_check().is_err());
    }

    #[test]
    fn dispatch_builds_expected_command() {
        let calls: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
        struct RecordingRunner {
            calls: std::sync::Arc<Mutex<Vec<String>>>,
        }
        impl CommandRunner for RecordingRunner {
            fn run(&self, args: &[&str]) -> io::Result<Output> {
                self.calls.lock().unwrap().push(args.join(" "));
                Ok(ok("ok"))
            }
        }
        let ctl = HyprCtl::new(RecordingRunner { calls: calls.clone() });
        ctl.dispatch(&["movetoworkspacesilent", "9,address:0x1234"])
            .unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            vec!["dispatch movetoworkspacesilent 9,address:0x1234".to_string()]
        );
    }

    /// Accepts the legacy syntax and rejects the Lua dispatcher form.
    struct LegacySession {
        calls: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl CommandRunner for LegacySession {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            self.calls.lock().unwrap().push(args.join(" "));
            Ok(ok("ok"))
        }
    }

    /// Rejects legacy textual dispatch with Hyprland 0.55+'s Lua
    /// syntax-rejection marker; accepts `hl.dsp.*` payloads.
    struct LuaSession {
        calls: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl CommandRunner for LuaSession {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            let joined = args.join(" ");
            self.calls.lock().unwrap().push(joined.clone());
            if joined.starts_with("dispatch hl.dsp.") {
                Ok(ok("ok"))
            } else {
                Ok(ok(
                    "error: [string \"return hl.dispatch(...)\"]:1: ')' expected near '...'\n\n → Note: dispatch in lua is a shorthand for hl.dispatch(...), your syntax might need to be updated.",
                ))
            }
        }
    }

    #[test]
    fn dispatch_caches_legacy_syntax_after_first_success() {
        let calls: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
        let ctl = HyprCtl::new(LegacySession { calls: calls.clone() });
        ctl.dispatch(&["moveworkspacetomonitor", "2", "DP-3"]).unwrap();
        ctl.dispatch(&["moveworkspacetomonitor", "3", "DP-3"]).unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                "dispatch moveworkspacetomonitor 2 DP-3".to_string(),
                "dispatch moveworkspacetomonitor 3 DP-3".to_string(),
            ]
        );
    }

    #[test]
    fn dispatch_retries_and_translates_on_lua_config_session() {
        let calls: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
        let ctl = HyprCtl::new(LuaSession { calls: calls.clone() });
        ctl.dispatch(&["movetoworkspacesilent", "staka-agent-1,address:0xcage"])
            .unwrap();

        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "legacy attempt then lua retry");
        assert!(
            calls[0].starts_with("dispatch movetoworkspacesilent"),
            "first try is legacy: {}",
            calls[0]
        );
        assert_eq!(
            calls[1],
            "dispatch hl.dsp.window.move({ workspace = 'name:staka-agent-1', follow = false, \
             window = 'address:0xcage' })"
        );
    }

    #[test]
    fn dispatch_translates_workspace_monitor_move_for_lua_sessions() {
        let calls: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
        let ctl = HyprCtl::new(LuaSession { calls: calls.clone() });
        ctl.dispatch(&["moveworkspacetomonitor", "2", "HEADLESS-2"])
            .unwrap();
        assert_eq!(
            calls.lock().unwrap()[1],
            "dispatch hl.dsp.workspace.move({ workspace = '2', monitor = 'HEADLESS-2' })"
        );
    }

    #[test]
    fn dispatch_on_lua_session_is_translated_directly_after_caching() {
        let calls: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
        let ctl = HyprCtl::new(LuaSession { calls: calls.clone() });
        ctl.dispatch(&["moveworkspacetomonitor", "2", "HEADLESS-2"])
            .unwrap();
        ctl.dispatch(&["moveworkspacetomonitor", "3", "HEADLESS-2"])
            .unwrap();
        // First dispatch: failed legacy probe then lua retry. Second
        // dispatch: the cached Lua syntax goes straight to the lua form.
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert!(calls[1].starts_with("dispatch hl.dsp.workspace.move"));
        assert!(calls[2].starts_with("dispatch hl.dsp.workspace.move"));
        assert!(!calls[2].contains("moveworkspacetomonitor"));
    }

    #[test]
    fn dispatch_reports_real_failures_after_syntax_is_resolved() {
        struct BrokenSession;
        impl CommandRunner for BrokenSession {
            fn run(&self, args: &[&str]) -> io::Result<Output> {
                if args.join(" ").starts_with("dispatch hl.dsp.") {
                    Ok(failed("invalid workspace"))
                } else {
                    Ok(ok(
                        "error: ... your syntax might need to be updated.",
                    ))
                }
            }
        }
        let ctl = HyprCtl::new(BrokenSession);
        let err = ctl
            .dispatch(&["moveworkspacetomonitor", "2", "NOWHERE"])
            .unwrap_err();
        assert!(matches!(err, HyprError::Failed { .. }));
        assert!(err.to_string().contains("invalid workspace"));
    }

    #[test]
    fn lua_translation_only_covers_known_dispatchers() {
        assert!(legacy_to_lua(&["exec", "foot"]).is_none());
        assert!(legacy_to_lua(&["movetoworkspacesilent", "2"]).is_none(),
            "spec without an address selector is not translatable");
    }

    #[test]
    fn lua_workspace_refs_use_name_selector_for_named_workspaces() {
        assert_eq!(lua_workspace_ref("2"), "2");
        assert_eq!(lua_workspace_ref("-99"), "-99");
        assert_eq!(lua_workspace_ref("staka-agent-1"), "name:staka-agent-1");
        assert_eq!(
            lua_workspace_ref("special:magic"),
            "name:special:magic",
            "special workspaces are referenced by name too"
        );
    }

    #[test]
    fn syntax_rejection_marker_is_matched_exactly() {
        assert!(is_syntax_rejection(
            "error: [string \"return hl.dispatch(workspace 5)\"]:1: ')' expected near '5'\n\n → Note: dispatch in lua is a shorthand for hl.dispatch(...), your syntax might need to be updated."
        ));
        assert!(is_syntax_rejection("Invalid dispatcher"));
        // Real failures must not look like syntax rejections.
        assert!(!is_syntax_rejection("invalid workspace"));
        assert!(!is_syntax_rejection("error creating output"));
    }

    #[test]
    fn lua_escape_quotes_correctly() {
        assert_eq!(lua_escape("staka-agent-1"), "staka-agent-1");
        assert_eq!(lua_escape("it's"), "it\\'s");
        assert_eq!(lua_escape("back\\slash"), "back\\\\slash");
    }
}
