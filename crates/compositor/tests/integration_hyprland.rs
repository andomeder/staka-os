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

#![cfg(feature = "integration")]

use std::sync::Mutex;
use std::time::Duration;

use staka_compositor::cage::{cage_socket_path, CageConfig, CageSession, SystemSpawner};
use staka_compositor::hyprctl::{is_headless, HyprCtl};
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
