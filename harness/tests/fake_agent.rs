//! bot-harness against a scripted fake agent (tests/fake-agent.py), for
//! protocol behavior the real agents don't readily show.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const AGENTS: &str = "[fake]\ncommand = [\"python3\", \"tests/fake-agent.py\"]\n";

struct Run {
    status: i32,
    elapsed: Duration,
    result: Value,
    /// acp.jsonl
    records: Vec<Value>,
}

fn run(mode: &str, env: &[(&str, &str)], args: &[&str]) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| -> PathBuf { dir.path().join(name) };
    std::fs::write(path("agents.toml"), AGENTS).unwrap();
    std::fs::write(path("prompt.md"), "Do the fake task.\n").unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let start = Instant::now();
    let out = Command::new(env!("CARGO_BIN_EXE_bot-harness"))
        .current_dir(root)
        .args(["run", "--agent", "fake", "--cwd", "."])
        .arg("--agents")
        .arg(path("agents.toml"))
        .arg("--prompt")
        .arg(path("prompt.md"))
        .arg("--out")
        .arg(path("out"))
        .args(args)
        .env("FAKE_MODE", mode)
        .envs(env.iter().copied())
        .output()
        .unwrap();
    let elapsed = start.elapsed();
    let read = |name: &str| std::fs::read_to_string(path("out").join(name)).unwrap();
    let result: Value = serde_json::from_str(&read("harness.json")).unwrap();
    let records = read("acp.jsonl")
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    Run {
        status: out.status.code().unwrap(),
        elapsed,
        result,
        records,
    }
}

/// The harness's response to the agent's request ID.
fn response_to(records: &[Value], id: u64) -> &Value {
    records
        .iter()
        .find(|r| r["dir"] == "send" && r["msg"]["id"] == id && r["msg"]["method"].is_null())
        .unwrap_or_else(|| panic!("no response to request {id}"))
}

#[test]
fn unadvertised_requests_are_refused() {
    // Each would hang for the fake agent's 5s if left unanswered.
    let r = run("fs", &[], &["--timeout", "60s"]);
    assert_eq!(
        (r.status, r.result["result"].as_str()),
        (0, Some("success")),
        "{:#}",
        r.result
    );
    for id in [100, 101, 102] {
        assert_eq!(
            response_to(&r.records, id)["msg"]["error"]["code"],
            -32601,
            "request {id}"
        );
    }
    assert!(r.elapsed < Duration::from_secs(5), "took {:?}", r.elapsed);
}

#[test]
fn update_flood() {
    // A smoke test: unhandled, these piled up in the SDK's retry queue,
    // which shows in memory (about 1 GB for 200k), not in the result.
    let r = run(
        "flood",
        &[("FAKE_UPDATES", "20000")],
        &["--timeout", "120s"],
    );
    assert_eq!(
        (r.status, r.result["result"].as_str()),
        (0, Some("success")),
        "{:#}",
        r.result
    );
    assert!(r.records.len() > 20000);
}

#[test]
fn permission_after_cancel() {
    let r = run("grace", &[], &["--timeout", "60s", "--max-tool-calls", "2"]);
    assert_eq!(
        (r.status, r.result["result"].as_str()),
        (3, Some("budget")),
        "{:#}",
        r.result
    );
    let answer = &response_to(&r.records, 300)["msg"]["result"];
    assert_eq!(answer["outcome"]["outcome"], "cancelled", "{answer}");
    assert_eq!(answer["_meta"]["botHarness"]["decision"], "cancelled");
    // The cancel went out before the request came in.
    let cancel = r
        .records
        .iter()
        .position(|r| r["msg"]["method"] == "session/cancel")
        .unwrap();
    let request = r
        .records
        .iter()
        .position(|r| r["dir"] == "recv" && r["msg"]["id"] == 300)
        .unwrap();
    assert!(cancel < request);
}

#[test]
fn timeout_before_the_session() {
    let r = run("slow-init", &[], &["--timeout", "2s"]);
    assert_eq!(
        (r.status, r.result["result"].as_str()),
        (124, Some("timeout")),
        "{:#}",
        r.result
    );
    assert!(r.elapsed < Duration::from_secs(10), "took {:?}", r.elapsed);
}
