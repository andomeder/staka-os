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

#![cfg(feature = "integration")]

use staka_compositor::hyprctl::{is_headless, HyprCtl};

fn hyprctl() -> HyprCtl {
    HyprCtl::system()
}

#[test]
fn hyprland_answers_monitors() {
    hyprctl().health_check().expect("hyprctl health check");
}

#[test]
fn headless_output_lifecycle() {
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
