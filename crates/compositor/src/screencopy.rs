//! Screenshot capture of the headless output.
//!
//! v1 shells out to `grim` (the wlroots screenshot tool) writing PNG to
//! stdout, exactly like the validated prototype did: `grim -o HEADLESS-N -`.
//! A native `zwlr_screencopy_manager_v1` client can replace this later with
//! no caller-visible change.

use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum CaptureError {
    /// The capture subprocess could not be run (e.g. grim not installed).
    Io(io::Error),
    /// grim ran but failed.
    Failed { stderr: String },
    /// The captured bytes are not a PNG.
    NotPng { length: usize },
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaptureError::Io(e) => write!(f, "failed to run capture: {}", e),
            CaptureError::Failed { stderr } => write!(f, "capture failed: {}", stderr),
            CaptureError::NotPng { length } => {
                write!(f, "capture produced {} bytes that are not PNG", length)
            }
        }
    }
}

impl std::error::Error for CaptureError {}

/// Runs one capture invocation. Abstracted so tests can feed canned output.
pub trait CaptureRunner: Send + Sync {
    fn run(&self, args: &[&str]) -> io::Result<Output>;
}

/// The real runner: executes `grim` on PATH.
#[derive(Debug, Clone)]
pub struct GrimCapture {
    pub program: String,
    /// How long to wait for grim before killing it. A headless output can
    /// fail to produce a frame, and an unbounded wait would wedge the
    /// driver.
    pub timeout: Duration,
}

impl Default for GrimCapture {
    fn default() -> Self {
        GrimCapture {
            program: "grim".to_string(),
            timeout: Duration::from_secs(10),
        }
    }
}

impl CaptureRunner for GrimCapture {
    fn run(&self, args: &[&str]) -> io::Result<Output> {
        let mut child = Command::new(&self.program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdout_pipe = child.stdout.take().expect("stdout piped");
        let mut stderr_pipe = child.stderr.take().expect("stderr piped");
        let stdout_reader = thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stdout_pipe.read_to_end(&mut buf);
            buf
        });
        let stderr_reader = thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr_pipe.read_to_end(&mut buf);
            buf
        });

        let deadline = Instant::now() + self.timeout;
        let status = loop {
            match child.try_wait()? {
                Some(status) => break status,
                None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
                None => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "capture did not finish in time",
                    ));
                }
            }
        };

        let stdout = stdout_reader
            .join()
            .map_err(|_| io::Error::other("stdout reader panicked"))?;
        let stderr = stderr_reader
            .join()
            .map_err(|_| io::Error::other("stderr reader panicked"))?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }
}

/// PNG signature: the first eight bytes every PNG file starts with.
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&PNG_SIGNATURE)
}

/// Captures `output` (e.g. `HEADLESS-2`) as PNG bytes via stdout.
pub fn capture_png<C: CaptureRunner>(
    runner: &C,
    output: &str,
) -> Result<Vec<u8>, CaptureError> {
    let args = ["-o", output, "-"];
    let result = runner.run(&args).map_err(CaptureError::Io)?;
    if !result.status.success() {
        return Err(CaptureError::Failed {
            stderr: String::from_utf8_lossy(&result.stderr).trim().to_string(),
        });
    }
    if !is_png(&result.stdout) {
        return Err(CaptureError::NotPng {
            length: result.stdout.len(),
        });
    }
    Ok(result.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    fn output(status: i32, stdout: &[u8], stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(status << 8),
            stdout: stdout.to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    /// Minimal valid PNG: signature plus a fake IHDR chunk.
    fn fake_png() -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(b"fake-ihdr-payload");
        bytes
    }

    struct MockGrim {
        status: i32,
        stdout: Vec<u8>,
        stderr: String,
    }

    impl CaptureRunner for MockGrim {
        fn run(&self, args: &[&str]) -> io::Result<Output> {
            assert_eq!(args, ["-o", "HEADLESS-2", "-"], "grim must capture to stdout");
            Ok(output(self.status, &self.stdout, &self.stderr))
        }
    }

    #[test]
    fn capture_returns_png_bytes() {
        let png = fake_png();
        let runner = MockGrim {
            status: 0,
            stdout: png.clone(),
            stderr: String::new(),
        };
        let captured = capture_png(&runner, "HEADLESS-2").unwrap();
        assert_eq!(captured, png);
    }

    #[test]
    fn capture_reports_nonzero_exit() {
        let runner = MockGrim {
            status: 1,
            stdout: Vec::new(),
            stderr: "output not found".to_string(),
        };
        let err = capture_png(&runner, "HEADLESS-2").unwrap_err();
        match err {
            CaptureError::Failed { stderr } => assert_eq!(stderr, "output not found"),
            other => panic!("unexpected error: {:?}", other),
        }
    }

    #[test]
    fn capture_rejects_non_png_stdout() {
        let runner = MockGrim {
            status: 0,
            stdout: b"hello, not an image".to_vec(),
            stderr: String::new(),
        };
        let err = capture_png(&runner, "HEADLESS-2").unwrap_err();
        assert!(matches!(err, CaptureError::NotPng { length: 19 }));
    }

    #[test]
    fn capture_rejects_truncated_png() {
        let png = fake_png();
        let runner = MockGrim {
            status: 0,
            stdout: png[..4].to_vec(),
            stderr: String::new(),
        };
        assert!(matches!(
            capture_png(&runner, "HEADLESS-2"),
            Err(CaptureError::NotPng { .. })
        ));
    }

    #[test]
    fn capture_reports_missing_tool() {
        struct Missing;
        impl CaptureRunner for Missing {
            fn run(&self, _args: &[&str]) -> io::Result<Output> {
                Err(io::Error::new(io::ErrorKind::NotFound, "no grim"))
            }
        }
        assert!(matches!(
            capture_png(&Missing, "HEADLESS-2"),
            Err(CaptureError::Io(_))
        ));
    }

    #[test]
    fn png_signature_check() {
        assert!(is_png(&fake_png()));
        assert!(!is_png(&[]));
        assert!(!is_png(b"\x89PNG"));
        assert!(!is_png(b"GIF89a-anything"));
    }

    #[test]
    fn grim_capture_times_out_and_kills_a_wedged_tool() {
        // "sleep 1" as a stand-in for a grim that never produces a frame.
        let grim = GrimCapture {
            program: "sleep".to_string(),
            timeout: Duration::from_millis(100),
        };
        let err = grim.run(&["1"]).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn grim_capture_collects_stdout_of_a_real_process() {
        let grim = GrimCapture {
            program: "/bin/echo".to_string(),
            timeout: Duration::from_secs(5),
        };
        let output = grim.run(&["-o", "HEADLESS-2", "-"]).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"-o HEADLESS-2 -\n");
    }
}
