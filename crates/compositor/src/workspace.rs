//! Safe agent workspace selection, pinning, and layout restore.
//!
//! This module exists to prevent one specific failure observed while
//! prototyping: moving a window to a plain numbered workspace bound that
//! workspace to the headless output, silently hijacking a workspace the
//! user reaches with a number key (e.g. `Super+2`). The workspace the user
//! knew was suddenly invisible, on an output they cannot see.
//!
//! The fix is structural, not best-effort:
//!
//! - Agent workspaces are *named* workspaces with the `staka-agent-` prefix.
//!   Hyprland only binds number keys to numeric workspace names, so a named
//!   workspace can never shadow a user keybind, and the prefix makes an
//!   accidental claim of the user's workspaces impossible.
//! - The cage window is moved with `movetoworkspacesilent`, so the user's
//!   focused workspace never changes.
//! - Before anything is touched, a layout snapshot records every workspace
//!   and its monitor. On teardown, [`restore`] moves any user workspace that
//!   ended up on a headless output back to the monitor it came from. Agent
//!   workspaces are left to vanish on their own once their window dies and
//!   the headless output is removed.

use crate::hyprctl::{is_headless, CommandRunner, HyprCtl, HyprError};

pub const AGENT_WORKSPACE_PREFIX: &str = "staka-agent-";

/// Name of the Nth agent workspace, e.g. `staka-agent-1`.
pub fn agent_workspace_name(n: u32) -> String {
    format!("{}{}", AGENT_WORKSPACE_PREFIX, n)
}

/// True for workspaces owned by the agent, false for anything the user owns.
pub fn is_agent_workspace(name: &str) -> bool {
    name.starts_with(AGENT_WORKSPACE_PREFIX)
}

/// Lowest agent workspace number not already in `existing`. Agent numbers
/// grow from 1; named workspaces never collide with user number keys, so
/// the only constraint is avoiding reuse of our own live workspaces.
pub fn next_agent_workspace(existing: &[String]) -> u32 {
    let mut n = 1;
    while existing.iter().any(|w| w == &agent_workspace_name(n)) {
        n += 1;
    }
    n
}

/// One workspace's placement, as captured by [`LayoutSnapshot`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceLayout {
    pub name: String,
    pub monitor: String,
}

/// Where every workspace lived before the driver touched anything.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct LayoutSnapshot {
    pub workspaces: Vec<WorkspaceLayout>,
}

impl LayoutSnapshot {
    /// Captures the current workspace-to-monitor placement.
    pub fn capture<C: CommandRunner>(ctl: &HyprCtl<C>) -> Result<Self, HyprError> {
        Ok(LayoutSnapshot {
            workspaces: ctl
                .list_workspaces()?
                .into_iter()
                .map(|w| WorkspaceLayout {
                    name: w.name,
                    monitor: w.monitor,
                })
                .collect(),
        })
    }
}

/// What [`restore`] did, for logging and assertions.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestoreReport {
    /// User workspaces moved off headless outputs back to their recorded
    /// monitor.
    pub moved_back: Vec<String>,
    /// Agent workspaces still present after restore. These disappear on
    /// their own once the headless output is removed; a persistent entry
    /// means the teardown caller leaked a window.
    pub leftover_agent_workspaces: Vec<String>,
}

/// High-level workspace operations for one driver session.
pub struct WorkspaceManager<'a, C: CommandRunner> {
    ctl: &'a HyprCtl<C>,
}

impl<'a, C: CommandRunner> WorkspaceManager<'a, C> {
    pub fn new(ctl: &'a HyprCtl<C>) -> Self {
        WorkspaceManager { ctl }
    }

    /// Picks an agent workspace name that does not collide with any live
    /// workspace. The workspace materialises when the first window is
    /// moved onto it.
    pub fn select(&self) -> Result<String, HyprError> {
        let existing: Vec<String> = self
            .ctl
            .list_workspaces()?
            .into_iter()
            .map(|w| w.name)
            .collect();
        Ok(agent_workspace_name(next_agent_workspace(&existing)))
    }

    /// Moves a window to the agent workspace without changing the user's
    /// focused workspace. Hyprland creates the named workspace, bound to
    /// the window's new output.
    pub fn move_window(&self, workspace: &str, address: &str) -> Result<(), HyprError> {
        self.ctl
            .dispatch(&["movetoworkspacesilent", &format!("{},address:{}", workspace, address)])
    }

    /// Forces an agent workspace onto the headless output. After
    /// [`Self::move_window`], Hyprland picks the output for a newly created
    /// workspace by its own placement rules, which is how a user workspace
    /// once ended up bound to a headless output. This makes the placement
    /// explicit: the agent workspace always ends up on the invisible
    /// output, and no user workspace ever has to move at all.
    pub fn pin_to_output(&self, workspace: &str, output: &str) -> Result<(), HyprError> {
        let current = self.ctl.list_workspaces()?;
        let monitor = current
            .iter()
            .find(|w| w.name == workspace)
            .map(|w| w.monitor.clone())
            .ok_or_else(|| HyprError::Parse(format!("workspace {} not found", workspace)))?;
        if monitor != output {
            self.ctl
                .dispatch(&["moveworkspacetomonitor", workspace, output])?;
        }
        Ok(())
    }

    /// Adopts the workspace Hyprland just grabbed for a newly created
    /// output, if possible.
    ///
    /// Creating an output makes Hyprland immediately assign a numeric
    /// workspace to it - sometimes a fresh empty one, sometimes one of the
    /// user's. An output with no workspace gets another one grabbed for it
    /// immediately, so fighting this by moving the workspace back is
    /// futile; the stable configuration is that the output hosts the agent
    /// workspace. When the grabbed workspace is fresh (not in the user's
    /// snapshot) and empty, it is renamed to an agent workspace name and
    /// adopted, leaving the user untouched. Returns the adopted name, or
    /// None when the grabbed workspace belongs to the user and must be
    /// given back by the caller.
    pub fn adopt_grabbed_workspace(
        &self,
        snapshot: &LayoutSnapshot,
        output: &str,
    ) -> Result<Option<String>, HyprError> {
        let current = self.ctl.list_workspaces()?;
        let Some(grabbed) = current.iter().find(|w| w.monitor == output) else {
            return Ok(None);
        };
        let is_user_workspace = snapshot
            .workspaces
            .iter()
            .any(|l| l.name == grabbed.name);
        if is_user_workspace || grabbed.windows > 0 {
            return Ok(None);
        }
        let existing: Vec<String> = current.iter().map(|w| w.name.clone()).collect();
        let name = agent_workspace_name(next_agent_workspace(&existing));
        self.ctl.dispatch(&[
            "renameworkspace",
            &grabbed.id.to_string(),
            &name,
        ])?;
        Ok(Some(name))
    }

    /// Moves every user workspace off the headless outputs and verifies
    /// the state is stable: `output` must host an agent workspace, and no
    /// workspace from the snapshot may sit on a headless output. Hyprland
    /// grabs a replacement for an output that is left without any
    /// workspace, so [`Self::restore`] alone can leave a hijack behind;
    /// this retries a bounded number of times and fails loudly rather
    /// than leaving the user's workspace invisible.
    pub fn settle(
        &self,
        snapshot: &LayoutSnapshot,
        output: &str,
        attempts: u32,
    ) -> Result<RestoreReport, HyprError> {
        let mut last_report = RestoreReport::default();
        for _ in 0..attempts {
            last_report = self.restore(snapshot)?;
            let current = self.ctl.list_workspaces()?;
            let agent_on_output = current
                .iter()
                .any(|w| w.monitor == output && is_agent_workspace(&w.name));
            let hijacked = current.iter().any(|w| {
                // Only a workspace whose home was a real monitor counts as
                // hijacked. Workspaces that already lived on a headless
                // output before the driver started are not ours to fix.
                let home = snapshot
                    .workspaces
                    .iter()
                    .find(|l| l.name == w.name)
                    .map(|l| l.monitor.clone());
                matches!(home, Some(home) if !is_headless(&home)) && is_headless(&w.monitor)
            });
            let our_output_holds_user = current.iter().any(|w| {
                w.monitor == output
                    && !is_agent_workspace(&w.name)
                    && snapshot
                        .workspaces
                        .iter()
                        .any(|l| l.name == w.name && !is_headless(&l.monitor))
            });
            if agent_on_output && !hijacked && !our_output_holds_user {
                return Ok(last_report);
            }
            if !agent_on_output || our_output_holds_user {
                // The output must host the agent workspace before the
                // user's can be given back, otherwise Hyprland re-grabs.
                // Caller-provided ordering problem: fail loudly.
                return Err(HyprError::Parse(format!(
                    "output {} does not host an agent workspace; cannot settle layout",
                    output
                )));
            }
        }
        Err(HyprError::Parse(format!(
            "workspaces keep landing on {} after {} restore attempts",
            output, attempts
        )))
    }

    /// Restores user workspaces that ended up on headless outputs, using
    /// the snapshot taken before the driver created anything. Never moves
    /// agent-prefixed workspaces, and never moves a workspace whose
    /// recorded monitor no longer exists (that monitor's removal is
    /// Hyprland's to handle, not ours).
    pub fn restore(&self, snapshot: &LayoutSnapshot) -> Result<RestoreReport, HyprError> {
        let mut report = RestoreReport::default();
        let current = self.ctl.list_workspaces()?;
        for workspace in current {
            if is_agent_workspace(&workspace.name) {
                report.leftover_agent_workspaces.push(workspace.name);
                continue;
            }
            if !is_headless(&workspace.monitor) {
                continue;
            }
            let home = snapshot
                .workspaces
                .iter()
                .find(|l| l.name == workspace.name)
                .map(|l| l.monitor.clone());
            let Some(home) = home else {
                // Not in the snapshot: it existed before us but on a monitor
                // we never saw. Leave it; report it so nothing is silent.
                report
                    .leftover_agent_workspaces
                    .push(format!("{} (on {})", workspace.name, workspace.monitor));
                continue;
            };
            if is_headless(&home) {
                continue;
            }
            self.ctl
                .dispatch(&["moveworkspacetomonitor", &workspace.name, &home])?;
            report.moved_back.push(workspace.name);
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hyprctl::Workspace;
    use std::io;
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

    /// In-memory Hyprland: workspaces with monitors, dispatch recording.
    /// Dispatches are recorded into a shared Arc so tests can assert on
    /// them after the mock is moved inside a `HyprCtl`.
    struct MockHyprland {
        workspaces: Mutex<Vec<Workspace>>,
        dispatches: std::sync::Arc<Mutex<Vec<String>>>,
        dispatch_fails: bool,
    }

    impl MockHyprland {
        fn new(workspaces: Vec<Workspace>) -> Self {
            MockHyprland {
                workspaces: Mutex::new(workspaces),
                dispatches: Default::default(),
                dispatch_fails: false,
            }
        }

        fn workspaces_json(&self) -> String {
            let workspaces = self.workspaces.lock().unwrap();
            let entries: Vec<String> = workspaces
                .iter()
                .map(|w| {
                    format!(
                        r#"{{"id": {}, "name": "{}", "monitor": "{}", "windows": {}}}"#,
                        w.id, w.name, w.monitor, w.windows
                    )
                })
                .collect();
            format!("[{}]", entries.join(","))
        }
    }

    impl CommandRunner for MockHyprland {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            match args {
                ["workspaces", "-j"] => Ok(ok(&self.workspaces_json())),
                ["dispatch", rest @ ..] => {
                    if self.dispatch_fails {
                        return Ok(ok("invalid dispatcher"));
                    }
                    let joined = rest.join(" ");
                    self.dispatches.lock().unwrap().push(joined.clone());
                    // renameworkspace <id> <name>
                    if let Some(spec) = joined.strip_prefix("renameworkspace ") {
                        let mut words = spec.split_whitespace();
                        let (id, name) = (
                            words.next().unwrap_or(""),
                            words.next().unwrap_or(""),
                        );
                        let mut workspaces = self.workspaces.lock().unwrap();
                        for w in workspaces.iter_mut() {
                            if w.id.to_string() == id {
                                w.name = name.to_string();
                            }
                        }
                    }
                    Ok(ok("ok"))
                }
                _ => Err(io::Error::other("unexpected call")),
            }
        }
    }

    fn ws(name: &str, monitor: &str) -> Workspace {
        Workspace {
            id: name.parse().unwrap_or(0),
            name: name.to_string(),
            monitor: monitor.to_string(),
            windows: 0,
        }
    }

    #[test]
    fn agent_workspace_naming_uses_prefix() {
        assert_eq!(agent_workspace_name(1), "staka-agent-1");
        assert_eq!(agent_workspace_name(12), "staka-agent-12");
        assert!(is_agent_workspace("staka-agent-1"));
        assert!(!is_agent_workspace("staka-agent"));
        // User workspaces, including numerics and other names, are never
        // mistaken for agent ones.
        assert!(!is_agent_workspace("2"));
        assert!(!is_agent_workspace("special:magic"));
        assert!(!is_agent_workspace("DP-3-notes"));
    }

    #[test]
    fn next_agent_workspace_skips_live_agent_workspaces() {
        assert_eq!(next_agent_workspace(&[]), 1);
        assert_eq!(
            next_agent_workspace(&["1".into(), "2".into()]),
            1,
            "user numeric workspaces do not constrain agent numbering"
        );
        assert_eq!(
            next_agent_workspace(&["staka-agent-1".into(), "staka-agent-2".into()]),
            3
        );
        // Gaps in our own numbering are reused.
        assert_eq!(
            next_agent_workspace(&["staka-agent-1".into(), "staka-agent-3".into()]),
            2
        );
    }

    #[test]
    fn snapshot_captures_workspace_placement() {
        let mock = MockHyprland::new(vec![ws("1", "DP-3"), ws("staka-agent-1", "HEADLESS-2")]);
        let ctl = HyprCtl::new(mock);
        let snapshot = LayoutSnapshot::capture(&ctl).unwrap();
        assert_eq!(
            snapshot.workspaces,
            vec![
                WorkspaceLayout {
                    name: "1".into(),
                    monitor: "DP-3".into(),
                },
                WorkspaceLayout {
                    name: "staka-agent-1".into(),
                    monitor: "HEADLESS-2".into(),
                },
            ]
        );
    }

    #[test]
    fn select_avoids_live_agent_workspaces() {
        let mock = MockHyprland::new(vec![
            ws("1", "DP-3"),
            ws("staka-agent-1", "HEADLESS-2"),
            ws("staka-agent-2", "HEADLESS-2"),
        ]);
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        assert_eq!(manager.select().unwrap(), "staka-agent-3");
    }

    #[test]
    fn move_window_dispatches_silent_move_with_address() {
        let mock = MockHyprland::new(vec![]);
        let dispatches = mock.dispatches.clone();
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        manager.move_window("staka-agent-1", "0xdeadbeef").unwrap();
        assert_eq!(
            *dispatches.lock().unwrap(),
            vec!["movetoworkspacesilent staka-agent-1,address:0xdeadbeef".to_string()]
        );
    }

    #[test]
    fn restore_moves_user_workspaces_off_headless_outputs() {
        let mock = MockHyprland::new(vec![
            ws("2", "HEADLESS-2"),             // hijacked by the move, snapshot says DP-3
            ws("staka-agent-1", "HEADLESS-2"), // ours; reported, not moved
            ws("7", "DP-3"),                   // untouched user workspace
        ]);
        let dispatches = mock.dispatches.clone();
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        let snapshot = LayoutSnapshot {
            workspaces: vec![
                WorkspaceLayout {
                    name: "2".into(),
                    monitor: "DP-3".into(),
                },
                WorkspaceLayout {
                    name: "staka-agent-1".into(),
                    monitor: "HEADLESS-2".into(),
                },
                WorkspaceLayout {
                    name: "7".into(),
                    monitor: "DP-3".into(),
                },
            ],
        };
        let report = manager.restore(&snapshot).unwrap();
        assert_eq!(report.moved_back, vec!["2".to_string()]);
        assert_eq!(
            report.leftover_agent_workspaces,
            vec!["staka-agent-1".to_string()]
        );
        assert_eq!(
            *dispatches.lock().unwrap(),
            vec!["moveworkspacetomonitor 2 DP-3".to_string()]
        );
    }

    #[test]
    fn restore_never_moves_a_user_workspace_onto_a_missing_monitor() {
        // Snapshot says workspace 4 lived on HEADLESS-1, which no longer
        // exists; moving it there would fail. Leaving it on the headless
        // output it already sits on is the correct no-op.
        let mock = MockHyprland::new(vec![ws("4", "HEADLESS-2")]);
        let dispatches = mock.dispatches.clone();
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        let snapshot = LayoutSnapshot {
            workspaces: vec![WorkspaceLayout {
                name: "4".into(),
                monitor: "HEADLESS-1".into(),
            }],
        };
        let report = manager.restore(&snapshot).unwrap();
        assert!(report.moved_back.is_empty());
        assert_eq!(*dispatches.lock().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn restore_reports_unknown_workspace_found_on_headless_output() {
        let mock = MockHyprland::new(vec![ws("9", "HEADLESS-2")]);
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        let report = manager.restore(&LayoutSnapshot::default()).unwrap();
        assert!(report.moved_back.is_empty());
        assert_eq!(
            report.leftover_agent_workspaces,
            vec!["9 (on HEADLESS-2)".to_string()],
            "an unexplained workspace on a headless output must surface, not vanish"
        );
    }

    #[test]
    fn restore_propagates_dispatch_failure() {
        let mut mock = MockHyprland::new(vec![ws("2", "HEADLESS-2")]);
        mock.dispatch_fails = true;
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        let snapshot = LayoutSnapshot {
            workspaces: vec![WorkspaceLayout {
                name: "2".into(),
                monitor: "DP-3".into(),
            }],
        };
        assert!(manager.restore(&snapshot).is_err());
    }

    #[test]
    fn pin_to_output_skips_dispatch_when_already_on_headless_output() {
        let mock = MockHyprland::new(vec![ws("staka-agent-1", "HEADLESS-2")]);
        let dispatches = mock.dispatches.clone();
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        manager.pin_to_output("staka-agent-1", "HEADLESS-2").unwrap();
        assert_eq!(*dispatches.lock().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn pin_to_output_moves_agent_workspace_off_user_display() {
        // Hyprland placed the new workspace on the physical monitor; pin
        // it to the headless output instead.
        let mock = MockHyprland::new(vec![
            ws("1", "DP-3"),
            ws("staka-agent-1", "DP-3"),
        ]);
        let dispatches = mock.dispatches.clone();
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        manager.pin_to_output("staka-agent-1", "HEADLESS-2").unwrap();
        assert_eq!(
            *dispatches.lock().unwrap(),
            vec!["moveworkspacetomonitor staka-agent-1 HEADLESS-2".to_string()]
        );
    }

    #[test]
    fn pin_to_output_fails_for_unknown_workspace() {
        let mock = MockHyprland::new(vec![]);
        let ctl = HyprCtl::new(mock);
        let manager = WorkspaceManager::new(&ctl);
        // Unknown workspace: nothing to pin; surface the failure instead
        // of dispatching blindly.
        assert!(manager.pin_to_output("staka-agent-9", "HEADLESS-2").is_err());
    }

    #[test]
    fn select_fails_when_hyprctl_is_unreachable() {
        struct Dead;
        impl CommandRunner for Dead {
            fn run(&self, _args: &[&str]) -> io::Result<Output> {
                Err(io::Error::other("no hyprctl"))
            }
        }
        let ctl = HyprCtl::new(Dead);
        let manager = WorkspaceManager::new(&ctl);
        assert!(manager.select().is_err());
    }
}
