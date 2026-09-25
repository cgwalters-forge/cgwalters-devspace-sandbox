// The unprivileged runner-sandbox user that SSH sessions and agent runs use
// (created by setup-runner-sandbox.mjs): who it is, and how a workflow step
// runs a command as it, with nothing of the step's environment.
import { spawnSync } from "node:child_process";

export const SANDBOX_USER = "runner-sandbox";
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// Runs a command, returning its stdout; throws if it fails.
export function run(cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"], maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.error ?? `exit ${r.status}`})`);
  }
  return r.stdout.trim();
}

// The argv that runs CMD as runner-sandbox, as a transient systemd service
// (in SLICE, if given), with only a fixed environment plus ENV. Unlike sudo
// -u, nothing of the calling step's environment or cgroup comes along.
// Its stdio must be pipes, not regular files: systemd-run hands them to
// PID 1 over D-Bus, which refuses those.
export function sandboxCommand(cmd, { cwd = SANDBOX_HOME, env = {}, slice } = {}) {
  const vars = { HOME: SANDBOX_HOME, USER: SANDBOX_USER, LOGNAME: SANDBOX_USER, LANG: "C.UTF-8", PATH: SANDBOX_PATH, ...env };
  const argv = ["systemd-run", "--quiet", "--collect", "--wait", "--pipe", "--service-type=exec",
    ...(slice ? [`--slice=${slice}`] : []), `--uid=${SANDBOX_USER}`, `--gid=${SANDBOX_USER}`,
    `--working-directory=${cwd}`, ...Object.entries(vars).map(([k, v]) => `--setenv=${k}=${v}`), "--", ...cmd];
  return process.getuid() === 0 ? [argv[0], argv.slice(1)] : ["sudo", argv];
}

// Runs CMD as runner-sandbox; returns {status, stdout} (stdout as a Buffer;
// stderr is dropped).
export function asSandbox(cmd, opts = {}) {
  const [bin, args] = sandboxCommand(cmd, opts);
  const r = spawnSync(bin, args, { input: opts.input ?? "", stdio: "pipe", maxBuffer: 1 << 30 });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0) };
}
