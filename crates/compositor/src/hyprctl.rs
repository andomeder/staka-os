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

use serde::{Deserialize, Serialize};

/// A monitor/output as reported by `hyprctl monitors -j`. Only the fields
/// the driver needs are parsed; Hyprland emits more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Monitor {
    pub name: String,
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

pub fn is_headless(name: &str) -> bool {
    name.starts_with("HEADLESS-")
}

pub struct HyprCtl<C: CommandRunner = SystemRunner> {
    runner: C,
}

impl HyprCtl<SystemRunner> {
    pub fn system() -> Self {
        HyprCtl {
            runner: SystemRunner::default(),
        }
    }
}

impl<C: CommandRunner> HyprCtl<C> {
    pub fn new(runner: C) -> Self {
        HyprCtl { runner }
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

    /// Runs a Hyprland dispatcher, e.g. `dispatch(&["movetoworkspacesilent",
    /// "9,address:0x..."])`.
    pub fn dispatch(&self, args: &[&str]) -> Result<(), HyprError> {
        let mut full: Vec<&str> = vec!["dispatch"];
        full.extend_from_slice(args);
        let output = self.run(&full)?;
        check_success(&full, &output)
    }
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
}
