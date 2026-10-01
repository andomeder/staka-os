//! Nested compositor (cage) lifecycle.
//!
//! Spawns the `cage` kiosk compositor as a Wayland client of the user's
//! Hyprland session, with the target app running inside it. Cage then owns
//! a second Wayland socket of its own: agent input goes into cage's seat,
//! never the user's physical seat.
//!
//! The process boundary is behind [`ProcessSpawner`] / [`ChildProcess`] so
//! the lifecycle (spawn, socket readiness, terminate) is unit-testable
//! without a Wayland session or a real cage binary.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const SIGTERM: i32 = 15;
const SIGKILL: i32 = 9;

/// How often to poll for the socket and for child exit while waiting.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug)]
pub enum CageError {
    /// The cage subprocess could not be spawned.
    Spawn(io::Error),
    /// Cage exited before its socket appeared.
    ExitedEarly { status: ExitStatus },
    /// Cage's socket did not appear within the configured timeout. The
    /// wedged child is killed before this error is reported.
    SocketTimeout { path: PathBuf },
    /// A kill/wait step failed.
    Kill(io::Error),
}

impl std::fmt::Display for CageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CageError::Spawn(e) => write!(f, "failed to spawn cage: {}", e),
            CageError::ExitedEarly { status } => {
                write!(f, "cage exited before its socket appeared: {}", status)
            }
            CageError::SocketTimeout { path } => {
                write!(f, "cage socket {} did not appear in time", path.display())
            }
            CageError::Kill(e) => write!(f, "failed to terminate cage: {}", e),
        }
    }
}

impl std::error::Error for CageError {}

impl From<io::Error> for CageError {
    fn from(e: io::Error) -> Self {
        CageError::Spawn(e)
    }
}

/// Everything needed to launch one cage instance.
#[derive(Debug, Clone)]
pub struct CageConfig {
    /// Path to the cage binary.
    pub cage_binary: PathBuf,
    /// Name of the Wayland socket cage creates, passed as `-S`.
    pub socket_name: String,
    /// Directory cage's socket appears in (the session's runtime dir).
    pub socket_dir: PathBuf,
    /// Nested output width, passed as `-W`.
    pub width: u32,
    /// Nested output height, passed as `-H`.
    pub height: u32,
    /// The user's Wayland session socket name (e.g. `wayland-1`), which
    /// cage connects to via its wayland backend.
    pub wayland_display: String,
    /// The app to run inside cage, split on whitespace (no shell).
    pub app: String,
    /// How long to wait for cage's socket to appear after spawn.
    pub socket_ready_timeout: Duration,
}

impl Default for CageConfig {
    fn default() -> Self {
        CageConfig {
            cage_binary: PathBuf::from("cage"),
            socket_name: "staka-cage".to_string(),
            socket_dir: std::env::var("XDG_RUNTIME_DIR")
                .unwrap_or_else(|_| "/tmp".to_string())
                .into(),
            width: 1920,
            height: 1080,
            wayland_display: "wayland-1".to_string(),
            app: String::new(),
            socket_ready_timeout: Duration::from_secs(15),
        }
    }
}

/// Splits an app command line on whitespace. No shell, no quoting: app
/// strings come from the agent and must never run through `sh -c`.
pub fn split_app(app: &str) -> Vec<String> {
    app.split_whitespace().map(str::to_string).collect()
}

/// Full path of cage's socket file.
pub fn cage_socket_path(socket_dir: &Path, socket_name: &str) -> PathBuf {
    socket_dir.join(socket_name)
}

/// Spawns one process with an environment override. The returned child is
/// trait-erased so tests can substitute fakes.
pub trait ProcessSpawner: Send + Sync {
    fn spawn(
        &self,
        program: &Path,
        args: &[String],
        env: &[(&str, String)],
    ) -> io::Result<Box<dyn ChildProcess>>;
}

/// A running child process.
pub trait ChildProcess: Send {
    fn pid(&self) -> u32;
    /// Sends a raw signal (e.g. SIGTERM/SIGKILL from libc).
    fn signal(&mut self, sig: i32) -> io::Result<()>;
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>>;
    fn wait(&mut self) -> io::Result<ExitStatus>;
}

/// The real spawner: fork+exec via std, stdin detached so the child can
/// never inherit or consume the driver's terminal.
#[derive(Debug, Clone, Default)]
pub struct SystemSpawner;

impl ProcessSpawner for SystemSpawner {
    fn spawn(
        &self,
        program: &Path,
        args: &[String],
        env: &[(&str, String)],
    ) -> io::Result<Box<dyn ChildProcess>> {
        let mut cmd = Command::new(program);
        cmd.args(args).stdin(Stdio::null());
        for (key, value) in env {
            cmd.env(key, value);
        }
        Ok(Box::new(SystemChild {
            child: cmd.spawn()?,
        }))
    }
}

struct SystemChild {
    child: std::process::Child,
}

impl ChildProcess for SystemChild {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn signal(&mut self, sig: i32) -> io::Result<()> {
        // std's Child::kill is SIGKILL-only; teardown wants a polite
        // SIGTERM first, so go through libc directly.
        let rc = unsafe { libc::kill(self.child.id() as libc::pid_t, sig) };
        if rc == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }
}

/// One running cage instance plus its socket.
pub struct CageSession {
    child: Box<dyn ChildProcess>,
    /// Directory the socket lives in.
    pub socket_dir: PathBuf,
    /// Name (not path) of cage's Wayland socket, e.g. `staka-cage`.
    pub socket_name: String,
    pub pid: u32,
}

impl std::fmt::Debug for CageSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CageSession")
            .field("pid", &self.pid)
            .field("socket_dir", &self.socket_dir)
            .field("socket_name", &self.socket_name)
            .finish()
    }
}

impl CageSession {
    /// Spawns cage and waits for its Wayland socket to appear.
    ///
    /// Command shape (validated by the working prototype):
    /// `cage -S <socket> -W <w> -H <h> -- <app...>` with `WAYLAND_DISPLAY`
    /// pointing at the user's session, so cage runs nested as a Wayland
    /// client of Hyprland.
    pub fn spawn(
        spawner: &dyn ProcessSpawner,
        config: &CageConfig,
    ) -> Result<CageSession, CageError> {
        if config.app.trim().is_empty() {
            return Err(CageError::Spawn(io::Error::new(
                io::ErrorKind::InvalidInput,
                "cage requires an app to run",
            )));
        }

        let mut args: Vec<String> = vec![
            "-S".into(),
            config.socket_name.clone(),
            "-W".into(),
            config.width.to_string(),
            "-H".into(),
            config.height.to_string(),
            "--".into(),
        ];
        args.extend(split_app(&config.app));

        let env = [("WAYLAND_DISPLAY", config.wayland_display.clone())];
        let mut child = spawner
            .spawn(&config.cage_binary, &args, &env)
            .map_err(CageError::Spawn)?;

        let socket_path = cage_socket_path(&config.socket_dir, &config.socket_name);
        let deadline = Instant::now() + config.socket_ready_timeout;
        loop {
            if let Some(status) = child.try_wait()? {
                return Err(CageError::ExitedEarly { status });
            }
            if socket_path.exists() {
                break;
            }
            if Instant::now() >= deadline {
                // Do not leak a wedged cage: kill it before reporting.
                let _ = child.signal(SIGKILL);
                let _ = child.wait();
                return Err(CageError::SocketTimeout { path: socket_path });
            }
            thread::sleep(POLL_INTERVAL);
        }

        Ok(CageSession {
            pid: child.pid(),
            socket_dir: config.socket_dir.clone(),
            socket_name: config.socket_name.clone(),
            child,
        })
    }

    /// Cheap liveness probe: true while the cage process has not exited.
    /// Reaps the child once it has exited, so a later terminate() is a
    /// no-op.
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Terminates cage: SIGTERM, a grace window, then SIGKILL, and removes
    /// the socket file if cage left it behind. A cage that already exited
    /// still resolves to `Ok`.
    pub fn terminate(&mut self) -> Result<(), CageError> {
        let result = self.terminate_inner();
        // Cage removes its own socket on clean exit; a SIGKILLed or crashed
        // one may leave it. A stale socket would poison the next spawn.
        let _ = std::fs::remove_file(cage_socket_path(&self.socket_dir, &self.socket_name));
        result
    }

    fn terminate_inner(&mut self) -> Result<(), CageError> {
        if let Ok(Some(_)) = self.child.try_wait() {
            return Ok(());
        }
        self.child.signal(SIGTERM).map_err(CageError::Kill)?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {}
                Err(e) => return Err(CageError::Kill(e)),
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(POLL_INTERVAL);
        }
        // SIGKILL is final: after this the child is a zombie until wait
        // reaps it, and wait cannot fail for a child we spawned.
        self.child.signal(SIGKILL).map_err(CageError::Kill)?;
        self.child.wait().map_err(CageError::Kill).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::sync::Mutex;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct SpawnRecord {
        program: PathBuf,
        args: Vec<String>,
        env: Vec<(String, String)>,
    }

    /// Fake child with scriptable behavior.
    struct MockChild {
        pid: u32,
        dies_on_signal: bool,
        /// When set, try_wait reports this status immediately.
        exited_with: Option<ExitStatus>,
        signals_seen: std::sync::Arc<Mutex<Vec<i32>>>,
    }

    impl MockChild {
        fn new(pid: u32) -> Self {
            MockChild {
                pid,
                dies_on_signal: true,
                exited_with: None,
                signals_seen: Default::default(),
            }
        }
        fn never_dies(mut self) -> Self {
            self.dies_on_signal = false;
            self
        }
        fn signals(&self) -> Vec<i32> {
            self.signals_seen.lock().unwrap().clone()
        }
    }

    impl ChildProcess for MockChild {
        fn pid(&self) -> u32 {
            self.pid
        }
        fn signal(&mut self, sig: i32) -> io::Result<()> {
            self.signals_seen.lock().unwrap().push(sig);
            Ok(())
        }
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            if self.exited_with.is_some() {
                return Ok(self.exited_with);
            }
            if self.dies_on_signal && !self.signals_seen.lock().unwrap().is_empty() {
                return Ok(Some(ExitStatus::from_raw(0)));
            }
            Ok(None)
        }
        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::from_raw(0))
        }
    }

    struct MockSpawner {
        spawns: Mutex<Vec<SpawnRecord>>,
        child: Mutex<Vec<MockChild>>,
        /// Status the spawned child reports immediately (simulates cage
        /// dying on startup).
        child_exits_immediately: Option<ExitStatus>,
    }

    impl MockSpawner {
        fn new() -> Self {
            MockSpawner {
                spawns: Mutex::new(Vec::new()),
                child: Mutex::new(Vec::new()),
                child_exits_immediately: None,
            }
        }
        fn last_spawn(&self) -> SpawnRecord {
            self.spawns.lock().unwrap().last().unwrap().clone()
        }
        fn only_child(&self) -> MockChild {
            self.child.lock().unwrap().remove(0)
        }
    }

    impl ProcessSpawner for MockSpawner {
        fn spawn(
            &self,
            program: &Path,
            args: &[String],
            env: &[(&str, String)],
        ) -> io::Result<Box<dyn ChildProcess>> {
            self.spawns.lock().unwrap().push(SpawnRecord {
                program: program.to_path_buf(),
                args: args.to_vec(),
                env: env
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
            });
            let mut child = MockChild::new(4242);
            child.exited_with = self.child_exits_immediately;
            // The kept copy shares the signal log with the returned child,
            // so tests can assert on signals after the session owns it.
            self.child.lock().unwrap().push(MockChild {
                pid: child.pid,
                dies_on_signal: child.dies_on_signal,
                exited_with: child.exited_with,
                signals_seen: child.signals_seen.clone(),
            });
            Ok(Box::new(child))
        }
    }

    fn test_config(socket_name: &str) -> CageConfig {
        CageConfig {
            cage_binary: PathBuf::from("/usr/bin/cage"),
            socket_name: socket_name.to_string(),
            socket_dir: std::env::temp_dir().join(format!("staka-cage-test-{}", std::process::id())),
            width: 1280,
            height: 720,
            wayland_display: "wayland-1".to_string(),
            app: "gnome-calculator".to_string(),
            socket_ready_timeout: Duration::from_secs(15),
        }
    }

    /// Pre-creates the socket file so spawn() succeeds without waiting.
    fn create_fake_socket(config: &CageConfig) -> PathBuf {
        std::fs::create_dir_all(&config.socket_dir).unwrap();
        let path = cage_socket_path(&config.socket_dir, &config.socket_name);
        std::fs::write(&path, b"").unwrap();
        path
    }

    #[test]
    fn split_app_splits_on_whitespace_without_shell() {
        assert_eq!(
            split_app("libreoffice --calc"),
            vec!["libreoffice".to_string(), "--calc".to_string()]
        );
        assert!(split_app("   ").is_empty());
        assert_eq!(split_app("foot"), vec!["foot".to_string()]);
    }

    #[test]
    fn spawn_builds_expected_command_line() {
        let spawner = MockSpawner::new();
        let config = test_config("staka-cage-test-cmdline");
        let path = create_fake_socket(&config);
        CageSession::spawn(&spawner, &config).unwrap();
        let record = spawner.last_spawn();
        assert_eq!(record.program, PathBuf::from("/usr/bin/cage"));
        assert_eq!(
            record.args,
            vec![
                "-S".to_string(),
                "staka-cage-test-cmdline".to_string(),
                "-W".to_string(),
                "1280".to_string(),
                "-H".to_string(),
                "720".to_string(),
                "--".to_string(),
                "gnome-calculator".to_string(),
            ]
        );
        assert_eq!(
            record.env,
            vec![("WAYLAND_DISPLAY".to_string(), "wayland-1".to_string())]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn spawn_rejects_empty_app() {
        let spawner = MockSpawner::new();
        let mut config = test_config("staka-cage-test-empty");
        config.app = "  ".to_string();
        let err = CageSession::spawn(&spawner, &config).unwrap_err();
        assert!(matches!(err, CageError::Spawn(_)));
        assert!(spawner.spawns.lock().unwrap().is_empty());
    }

    #[test]
    fn spawn_reports_cage_exiting_before_socket() {
        let mut spawner = MockSpawner::new();
        spawner.child_exits_immediately = Some(ExitStatus::from_raw(1 << 8));
        let err = CageSession::spawn(&spawner, &test_config("staka-cage-test-early")).unwrap_err();
        assert!(matches!(err, CageError::ExitedEarly { .. }));
    }

    #[test]
    fn spawn_times_out_and_kills_wedged_cage() {
        let spawner = MockSpawner::new();
        let mut config = test_config("staka-cage-test-wedged");
        config.socket_ready_timeout = Duration::from_millis(60);
        // No socket file is ever created; the child never exits.
        let err = CageSession::spawn(&spawner, &config).unwrap_err();
        assert!(matches!(err, CageError::SocketTimeout { .. }));
        // The wedged child was killed, not leaked.
        let child = spawner.only_child();
        assert!(child.signals().contains(&SIGKILL), "{:?}", child.signals());
    }

    #[test]
    fn spawn_returns_pid_and_socket_name() {
        let spawner = MockSpawner::new();
        let config = test_config("staka-cage-test-pid");
        create_fake_socket(&config);
        let session = CageSession::spawn(&spawner, &config).unwrap();
        assert_eq!(session.pid, 4242);
        assert_eq!(session.socket_name, "staka-cage-test-pid");
    }

    #[test]
    fn terminate_sends_sigterm_then_cleans_socket() {
        let spawner = MockSpawner::new();
        let config = test_config("staka-cage-test-term");
        let path = create_fake_socket(&config);
        let mut session = CageSession::spawn(&spawner, &config).unwrap();
        session.terminate().unwrap();
        // The socket file is gone after terminate even though the mock
        // cage never cleaned it up itself.
        assert!(!path.exists(), "stale socket must be removed");
    }

    #[test]
    fn terminate_escalates_to_sigkill_when_cage_ignores_sigterm() {
        let child = MockChild::new(99).never_dies();
        let signals = child.signals_seen.clone();
        let mut session = CageSession {
            child: Box::new(child),
            socket_dir: std::env::temp_dir(),
            socket_name: "staka-cage-test-escalate".to_string(),
            pid: 99,
        };
        // The grace window is 3s; a child that ignores SIGTERM makes
        // terminate take the full window before SIGKILL.
        let started = Instant::now();
        session.terminate().unwrap();
        assert!(started.elapsed() >= Duration::from_secs(3));
        let seen = signals.lock().unwrap().clone();
        assert_eq!(seen, vec![SIGTERM, SIGKILL]);
    }

    #[test]
    fn terminate_is_noop_on_already_exited_cage() {
        let child = MockChild {
            pid: 7,
            dies_on_signal: false,
            exited_with: Some(ExitStatus::from_raw(0)),
            signals_seen: Default::default(),
        };
        let mut session = CageSession {
            child: Box::new(child),
            socket_dir: std::env::temp_dir(),
            socket_name: "staka-cage-test-reaped".to_string(),
            pid: 7,
        };
        session.terminate().unwrap();
    }

    #[test]
    fn cage_error_messages_are_actionable() {
        let msg = CageError::SocketTimeout {
            path: PathBuf::from("/run/user/1000/staka-cage"),
        }
        .to_string();
        assert!(msg.contains("/run/user/1000/staka-cage"));
        let msg = CageError::ExitedEarly {
            status: ExitStatus::from_raw(256),
        }
        .to_string();
        assert!(msg.contains("exited before"));
    }
}
