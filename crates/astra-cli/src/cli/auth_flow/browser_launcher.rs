#[cfg(any(target_os = "windows", target_os = "linux", test))]
fn windows_browser_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("powershell.exe");
    // The URL is data in the child environment, never shell source. In
    // particular the callback's &state= cannot become another command.
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "try { Start-Process -FilePath $env:ASTRA_LOGIN_URL -ErrorAction Stop; exit 0 } catch { exit 1 }",
        ])
        .env("ASTRA_LOGIN_URL", url);
    command
}

#[cfg(target_os = "linux")]
fn is_wsl_kernel_release(release: &str) -> bool {
    release.to_ascii_lowercase().contains("microsoft")
}

#[cfg(target_os = "linux")]
fn running_in_wsl() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::env::var_os("WSL_INTEROP").is_some()
        || std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| is_wsl_kernel_release(&release))
}

#[cfg(target_os = "linux")]
fn wsl_browser_command(url: &str, wslenv: Option<&std::ffi::OsStr>) -> std::process::Command {
    let mut command = windows_browser_command(url);
    command.env("WSLENV", forwarded_wslenv(wslenv));
    command
}

#[cfg(target_os = "linux")]
fn forwarded_wslenv(existing: Option<&std::ffi::OsStr>) -> std::ffi::OsString {
    use std::os::unix::ffi::{OsStrExt, OsStringExt};

    let mut entries = Vec::new();
    if let Some(existing) = existing {
        for entry in existing.as_bytes().split(|byte| *byte == b':') {
            let name = entry.split(|byte| *byte == b'/').next().unwrap_or_default();
            // WSLENV names are case-sensitive. Replace every exact entry so
            // stale /u, /p or /l flags cannot suppress or transform the URL.
            if !entry.is_empty() && name != b"ASTRA_LOGIN_URL" {
                entries.push(entry);
            }
        }
    }
    entries.push(b"ASTRA_LOGIN_URL/w");
    std::ffi::OsString::from_vec(entries.join(&b':'))
}

use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use std::time::Duration;

pub(super) async fn launch_login_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if running_in_wsl() {
        let primary = wsl_browser_command(&url, std::env::var_os("WSLENV").as_deref());
        let mut fallback = Command::new("wslview");
        fallback.arg(&url);
        return launch_wsl_commands(
            [("powershell.exe", primary), ("wslview", fallback)],
            Duration::from_secs(5),
            Duration::from_secs(1),
        )
        .await;
    }

    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    command.arg(&url);
    #[cfg(target_os = "windows")]
    let command = windows_browser_command(&url);
    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    return hand_off_browser(command);
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    Err("automatic browser opening is unsupported".into())
}

// Native openers may become the browser itself. Preserve that handoff and let
// Tokio collect eventual exits without tying browser lifetime to login lifetime.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn hand_off_browser(command: Command) -> Result<(), String> {
    tokio::process::Command::from(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false)
        .spawn()
        .map(drop)
        .map_err(|error| format!("browser opener could not start ({:?})", error.kind()))
}

#[cfg(target_os = "linux")]
struct LauncherFailure {
    description: String,
    cleanup_settled: bool,
}

#[cfg(target_os = "linux")]
async fn launch_wsl_commands(
    commands: [(&'static str, Command); 2],
    attempt_timeout: Duration,
    cleanup_timeout: Duration,
) -> Result<(), String> {
    let mut failures = Vec::with_capacity(2);
    for (label, command) in commands {
        match run_wsl_launcher(command, label, attempt_timeout, cleanup_timeout).await {
            Ok(()) => return Ok(()),
            Err(failure) => {
                failures.push(failure.description);
                if !failure.cleanup_settled {
                    break;
                }
            }
        }
    }
    Err(failures.join("; "))
}

#[cfg(target_os = "linux")]
async fn stop_launcher(child: &mut tokio::process::Child, timeout: Duration) -> bool {
    let _ = child.start_kill();
    matches!(tokio::time::timeout(timeout, child.wait()).await, Ok(Ok(_)))
}

#[cfg(target_os = "linux")]
async fn run_wsl_launcher(
    command: Command,
    label: &'static str,
    attempt_timeout: Duration,
    cleanup_timeout: Duration,
) -> Result<(), LauncherFailure> {
    let mut child = tokio::process::Command::from(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| LauncherFailure {
            description: format!("{label} could not start ({:?})", error.kind()),
            cleanup_settled: true,
        })?;
    let (mut sender, receiver) = tokio::sync::oneshot::channel();
    // This task owns only process collection. Dropping the login's receiver
    // requests cleanup; it cannot launch a fallback, publish progress or log in.
    let owner = tokio::spawn(async move {
        let outcome = tokio::select! {
            biased;
            _ = sender.closed() => {
                let _ = stop_launcher(&mut child, cleanup_timeout).await;
                return;
            }
            outcome = tokio::time::timeout(attempt_timeout, child.wait()) => outcome,
        };
        let reason = match outcome {
            Ok(Ok(status)) => {
                use std::os::unix::process::ExitStatusExt;
                let result = if status.success() {
                    Ok(())
                } else {
                    Err(LauncherFailure {
                        description: format!(
                            "{label} exited unsuccessfully (code {:?}, signal {:?})",
                            status.code(),
                            status.signal()
                        ),
                        cleanup_settled: true,
                    })
                };
                let _ = sender.send(result);
                return;
            }
            Ok(Err(error)) => format!("wait failed ({:?})", error.kind()),
            Err(_) => "timed out".to_string(),
        };
        let cleanup_settled = stop_launcher(&mut child, cleanup_timeout).await;
        let _ = sender.send(Err(LauncherFailure {
            description: format!(
                "{label} {reason}{}",
                if cleanup_settled {
                    ""
                } else {
                    "; cleanup is unverified"
                }
            ),
            cleanup_settled,
        }));
    });
    let result = receiver.await;
    match (result, owner.await) {
        (Ok(result), Ok(())) => result,
        _ => Err(LauncherFailure {
            description: format!("{label} process owner failed; cleanup is unverified"),
            cleanup_settled: false,
        }),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    #[test]
    fn wsl_login_uses_windows_browser_without_interpreting_callback_url() {
        assert!(super::is_wsl_kernel_release(
            "5.15.167.4-microsoft-standard-WSL2"
        ));
        assert!(super::is_wsl_kernel_release("4.4.0-Microsoft"));
        assert!(!super::is_wsl_kernel_release("6.8.0-generic"));
        let url =
            "https://uc.example.com/authorize?client_id=astra-cli&response_type=code&state=abc";
        let wsl = super::wsl_browser_command(url, None);
        assert_eq!(wsl.get_program(), std::ffi::OsStr::new("powershell.exe"));
        assert!(wsl.get_envs().any(
            |(key, value)| key == "ASTRA_LOGIN_URL" && value == Some(std::ffi::OsStr::new(url))
        ));
        assert!(wsl.get_envs().any(|(key, value)| {
            key == "WSLENV" && value == Some(std::ffi::OsStr::new("ASTRA_LOGIN_URL/w"))
        }));
        assert!(
            wsl.get_args()
                .all(|arg| !arg.to_string_lossy().contains(url))
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn wsl_login_normalizes_forwarded_environment() {
        for (existing, expected) in [
            (
                "WT_SESSION:GTK_MODULES/w",
                "WT_SESSION:GTK_MODULES/w:ASTRA_LOGIN_URL/w",
            ),
            (
                "WT_SESSION:astra_login_url/p",
                "WT_SESSION:astra_login_url/p:ASTRA_LOGIN_URL/w",
            ),
            ("ASTRA_LOGIN_URL", "ASTRA_LOGIN_URL/w"),
            ("ASTRA_LOGIN_URL/u", "ASTRA_LOGIN_URL/w"),
            ("ASTRA_LOGIN_URL/p", "ASTRA_LOGIN_URL/w"),
            ("ASTRA_LOGIN_URL/l", "ASTRA_LOGIN_URL/w"),
            (
                "ASTRA_LOGIN_URL/u:FOO:ASTRA_LOGIN_URL/p",
                "FOO:ASTRA_LOGIN_URL/w",
            ),
            ("FOO:ASTRA_LOGIN_URL/w", "FOO:ASTRA_LOGIN_URL/w"),
        ] {
            let command = super::wsl_browser_command(
                "https://uc.example.com/authorize",
                Some(std::ffi::OsStr::new(existing)),
            );
            assert!(command.get_envs().any(|(key, value)| {
                key == "WSLENV" && value == Some(std::ffi::OsStr::new(expected))
            }));
        }
    }

    #[test]
    fn windows_browser_launch_keeps_callback_url_out_of_shell_source() {
        let url = "https://thememoria.ai/connect/astra?port=1234&state=abc&cli_version=0.2.1";
        let command = super::windows_browser_command(url);
        let args: Vec<_> = command
            .get_args()
            .map(|v| v.to_string_lossy().into_owned())
            .collect();
        assert!(
            args.iter()
                .all(|arg| !arg.contains(url) && !arg.contains("&state"))
        );
        assert!(
            command
                .get_envs()
                .any(|(name, value)| name == "ASTRA_LOGIN_URL"
                    && value == Some(std::ffi::OsStr::new(url)))
        );
    }

    #[cfg(target_os = "linux")]
    mod processes {
        use super::super::{hand_off_browser, launch_wsl_commands, wsl_browser_command};
        use nix::{
            errno::Errno,
            sys::{
                signal::{Signal, kill},
                wait::{WaitPidFlag, waitpid},
            },
            unistd::Pid,
        };
        use std::path::Path;
        use std::process::Command;
        use std::time::Duration;

        fn shell(script: &str, paths: &[&Path]) -> Command {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script, "browser-test"]).args(paths);
            command
        }

        async fn pid_file(path: &Path) -> Pid {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Ok(pid) = std::fs::read_to_string(path)
                        && let Ok(pid) = pid.parse::<i32>()
                    {
                        return Pid::from_raw(pid);
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("launcher readiness")
        }

        async fn collected(pid: Pid) {
            tokio::time::timeout(Duration::from_secs(3), async {
                while kill(pid, None).is_ok() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("launcher must terminate and be collected");
            assert_eq!(kill(pid, None), Err(Errno::ESRCH));
            assert_eq!(waitpid(pid, Some(WaitPidFlag::WNOHANG)), Err(Errno::ECHILD));
        }

        #[tokio::test]
        async fn launcher_completion_controls_fallback_and_sanitizes_failure() {
            let dir = tempfile::tempdir().unwrap();
            let fallback = dir.path().join("fallback");
            for script in ["exit 0", "exit 7", "kill -TERM $$"] {
                let _ = std::fs::remove_file(&fallback);
                launch_wsl_commands(
                    [
                        ("powershell.exe", shell(script, &[])),
                        ("wslview", shell("printf fallback > \"$1\"", &[&fallback])),
                    ],
                    Duration::from_secs(1),
                    Duration::from_secs(1),
                )
                .await
                .unwrap();
                assert_eq!(fallback.exists(), script != "exit 0");
            }
            let missing = Command::new(dir.path().join("missing"));
            launch_wsl_commands(
                [
                    ("powershell.exe", missing),
                    ("wslview", shell("exit 0", &[])),
                ],
                Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .await
            .unwrap();

            let secret = "synthetic-URL-state-that-must-not-appear";
            let mut primary = shell("printf '%s' \"$SECRET\" >&2; exit 7", &[]);
            primary.env("SECRET", secret);
            let error = launch_wsl_commands(
                [
                    ("powershell.exe", primary),
                    ("wslview", shell("exit 9", &[])),
                ],
                Duration::from_secs(1),
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
            assert!(error.contains("powershell.exe") && error.contains("wslview"));
            assert!(error.contains("Some(7)") && error.contains("Some(9)"));
            assert!(!error.contains(secret));
        }

        #[tokio::test]
        async fn launcher_timeout_reaps_before_fallback_and_bounds_both_attempts() {
            let dir = tempfile::tempdir().unwrap();
            let primary_pid = dir.path().join("primary");
            let fallback_pid = dir.path().join("fallback");
            let result = launch_wsl_commands(
                [
                    (
                        "powershell.exe",
                        shell(
                            "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30",
                            &[&primary_pid],
                        ),
                    ),
                    (
                        "wslview",
                        shell(
                            "if kill -0 \"$(cat \"$1\")\" 2>/dev/null; then exit 44; fi; printf '%s' \"$$\" > \"$2\"; exec /bin/sleep 30",
                            &[&primary_pid, &fallback_pid],
                        ),
                    ),
                ],
                Duration::from_millis(200),
                Duration::from_secs(1),
            );
            let error = tokio::time::timeout(Duration::from_secs(4), result)
                .await
                .unwrap()
                .unwrap_err();
            assert_eq!(error.matches("timed out").count(), 2, "{error}");
            collected(pid_file(&primary_pid).await).await;
            collected(pid_file(&fallback_pid).await).await;
        }

        #[tokio::test]
        async fn cancelling_the_caller_reaps_without_starting_fallback() {
            let dir = tempfile::tempdir().unwrap();
            let pid_path = dir.path().join("pid");
            let fallback = dir.path().join("fallback");
            let commands = [
                (
                    "powershell.exe",
                    shell(
                        "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30",
                        &[&pid_path],
                    ),
                ),
                ("wslview", shell("printf unexpected > \"$1\"", &[&fallback])),
            ];
            let task = tokio::spawn(launch_wsl_commands(
                commands,
                Duration::from_secs(5),
                Duration::from_secs(1),
            ));
            let pid = pid_file(&pid_path).await;
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
            collected(pid).await;
            assert!(!fallback.exists());
        }

        #[tokio::test]
        async fn native_handoff_does_not_kill_a_long_lived_browser() {
            let dir = tempfile::tempdir().unwrap();
            let pid_path = dir.path().join("pid");
            hand_off_browser(shell(
                "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30",
                &[&pid_path],
            ))
            .unwrap();
            let pid = pid_file(&pid_path).await;
            assert!(kill(pid, None).is_ok());
            kill(pid, Signal::SIGKILL).unwrap();
            collected(pid).await;
        }

        #[tokio::test]
        async fn concurrent_launches_keep_url_and_wslenv_in_child_data() {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let stub = dir.path().join("powershell.exe");
            std::fs::write(
                &stub,
                "#!/bin/sh\nprintf '%s\\n%s' \"$ASTRA_LOGIN_URL\" \"$WSLENV\" > \"$OUT_FILE\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o700)).unwrap();
            let parent_url = std::env::var_os("ASTRA_LOGIN_URL");
            let parent_wslenv = std::env::var_os("WSLENV");
            let mut tasks = tokio::task::JoinSet::new();
            for index in 0..8 {
                let path = dir.path().to_owned();
                tasks.spawn(async move {
                    let url = format!("https://login.example/authorize?state={index}&data=';$()/");
                    let output = path.join(format!("received-{index}"));
                    let mut primary = wsl_browser_command(
                        &url,
                        Some(std::ffi::OsStr::new("KEEP/p:ASTRA_LOGIN_URL/u")),
                    );
                    primary.env("PATH", &path).env("OUT_FILE", &output);
                    launch_wsl_commands(
                        [
                            ("powershell.exe", primary),
                            ("wslview", shell("exit 99", &[])),
                        ],
                        Duration::from_secs(2),
                        Duration::from_secs(1),
                    )
                    .await
                    .unwrap();
                    assert_eq!(
                        std::fs::read_to_string(output).unwrap(),
                        format!("{url}\nKEEP/p:ASTRA_LOGIN_URL/w")
                    );
                });
            }
            while let Some(result) = tasks.join_next().await {
                result.unwrap();
            }
            assert_eq!(std::env::var_os("ASTRA_LOGIN_URL"), parent_url);
            assert_eq!(std::env::var_os("WSLENV"), parent_wslenv);
        }

        #[test]
        fn wslenv_preserves_non_utf8_bytes_and_is_idempotent() {
            use std::os::unix::ffi::{OsStrExt, OsStringExt};
            let input = std::ffi::OsString::from_vec(
                b"KEEP\xff/p:ASTRA_LOGIN_URL/u:ASTRA_LOGIN_URL/l".to_vec(),
            );
            let output = super::super::forwarded_wslenv(Some(&input));
            assert_eq!(output.as_bytes(), b"KEEP\xff/p:ASTRA_LOGIN_URL/w");
            assert_eq!(super::super::forwarded_wslenv(Some(&output)), output);
        }
    }
}
