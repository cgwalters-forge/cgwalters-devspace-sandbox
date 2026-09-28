# A devspace-like job: provision the machine as `runner`, then build and
# test as the sandbox user, and check that the sandbox holds nothing of the
# job's credentials. Compiled to .github/workflows/devspace-proto.lock.yml.
let gha = import "../lib/gha.ncl" in
let checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" in # v7.0.1
let upload_artifact = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" in # v7.0.1

gha.compile {
  name = "Sandboxed job prototype",
  on = {
    push = { branches = ["bot/gha-compile"] },
    workflow_dispatch = {},
  },
  permissions = { contents = "read" },
  jobs.devspace = {
    "runs-on" = "ubuntu-24.04",
    "timeout-minutes" = 30,
    sandbox = {
      user = "runner-sandbox",
      allowed_actions = ["actions/upload-artifact"],
    },
    runner_steps = [
      { uses = checkout, with = { persist-credentials = false } },
      {
        name = "Install the Rust toolchain system-wide",
        shell = "bash",
        run = m%"
          curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$RUNNER_TEMP/rustup-init.sh"
          sudo env RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo sh "$RUNNER_TEMP/rustup-init.sh" \
            -y --no-modify-path --profile minimal --default-toolchain 1.90.0
          sudo ln -sf /opt/cargo/bin/cargo /opt/cargo/bin/rustc /opt/cargo/bin/rustup /usr/local/bin/
        "%,
      },
    ],
    steps = [
      {
        name = "Runs as the sandbox user",
        run = m%"
          id
          test "$(id -un)" = runner-sandbox
          test "$PWD" = /var/lib/runner-sandbox/work
        "%,
      },
      { name = "sudo is refused", id = "sudo", "continue-on-error" = true, run = "sudo -n true" },
      {
        name = "The sudo step failed",
        env = { OUTCOME = "${{ steps.sudo.outcome }}" },
        run = m%"test "$OUTCOME" = failure"%,
      },
      {
        name = "The job's credentials are out of reach",
        run = m%"
          for v in ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_RUNTIME_TOKEN GITHUB_TOKEN GITHUB_ENV GITHUB_PATH; do
            if [[ -v $v ]]; then echo "$v is set"; exit 1; fi
          done
          worker=$(pgrep -f Runner.Worker | head -n1)
          test -n "$worker"
          if cat "/proc/$worker/environ" >/dev/null; then echo "read Runner.Worker's environment"; exit 1; fi
          if ls /home/runner >/dev/null; then echo "listed the runner's home"; exit 1; fi
          if docker ps >/dev/null 2>&1; then echo "reached a docker daemon"; exit 1; fi
          echo "no credentials reachable"
        "%,
      },
      {
        name = "Write a step output",
        id = "out",
        run = m%"
          echo "answer=42" >>"$GITHUB_OUTPUT"
          echo "Written from the sandbox by $(id -un)" >>"$GITHUB_STEP_SUMMARY"
        "%,
      },
      {
        name = "Read it back",
        env = { ANSWER = "${{ steps.out.outputs.answer }}" },
        run = m%"test "$ANSWER" = 42"%,
      },
      # Escape attempts: each must fail, or leave nothing behind.
      {
        name = "Point GITHUB_OUTPUT at a root-only file",
        id = "symlink",
        "continue-on-error" = true,
        run = m%"ln -sf /etc/shadow "$GITHUB_OUTPUT""%,
      },
      {
        name = "Smuggle a multi-line output",
        id = "heredoc",
        "continue-on-error" = true,
        run = m%"printf 'x<<EOF\nsomething\nEOF\n' >>"$GITHUB_OUTPUT""%,
      },
      {
        name = "Leave a process behind",
        run = m%"setsid sleep 600 </dev/null >/dev/null 2>&1 & echo "started $!""%,
      },
      {
        name = "The escapes failed",
        env = {
          SYMLINK = "${{ steps.symlink.outcome }}",
          HEREDOC = "${{ steps.heredoc.outcome }}",
        },
        run = m%"
          test "$SYMLINK" = failure
          test "$HEREDOC" = failure
          if pgrep -u runner-sandbox -x sleep; then echo "a process survived its step"; exit 1; fi
          echo "all escapes failed"
        "%,
      },
      {
        name = "Build and test",
        env = { RUSTUP_HOME = "/opt/rustup" },
        run = "cargo test --locked 2>&1 | tee test.log",
      },
      {
        name = "Upload the test log",
        "if" = "always()",
        uses = upload_artifact,
        with = { name = "test-log", path = "/var/lib/runner-sandbox/work/test.log" },
      },
    ],
  },
}
