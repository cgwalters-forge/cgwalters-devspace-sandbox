// Shared by the scripts that run and check the agent: how to run a command
// as the unprivileged runner-sandbox user, and how to stop all of it.
import { spawnSync } from "node:child_process";

export const SANDBOX_USER = "runner-sandbox";
export const SANDBOX_HOME = `/home/${SANDBOX_USER}`;
// Everything the agent runs is in this slice, so the supervisor can kill
// it. A service in it can't move itself out, unlike processes under sudo,
// which stay in the calling step's cgroup.
export const AGENT_SLICE = "agent.slice";
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

// The argv that runs CMD as runner-sandbox in the agent's slice, with only
// a fixed environment (plus ENV): nothing of the calling step's survives.
// Its stdio must be pipes, not regular files: systemd-run hands them to
// PID 1 over D-Bus, which refuses those.
export function agentCommand(cmd, { cwd = SANDBOX_HOME, env = {} } = {}) {
  const vars = { HOME: SANDBOX_HOME, USER: SANDBOX_USER, LOGNAME: SANDBOX_USER, LANG: "C.UTF-8", PATH: SANDBOX_PATH, ...env };
  return ["sudo", ["systemd-run", "--quiet", "--collect", "--wait", "--pipe", "--service-type=exec",
    `--slice=${AGENT_SLICE}`, `--uid=${SANDBOX_USER}`, `--gid=${SANDBOX_USER}`, `--working-directory=${cwd}`,
    ...Object.entries(vars).map(([k, v]) => `--setenv=${k}=${v}`), "--", ...cmd]];
}

// Runs CMD as runner-sandbox; returns {status, stdout} (stdout as a Buffer).
export function asAgent(cmd, opts = {}) {
  const [bin, args] = agentCommand(cmd, opts);
  const r = spawnSync(bin, args, { input: opts.input ?? "", stdio: "pipe", maxBuffer: 1 << 30 });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0) };
}

// Stops everything the agent started: its slice, a user manager it may have
// started by enabling lingering, and stray processes of its uid.
export function killAgent() {
  for (const args of [["systemctl", "kill", "--signal=KILL", AGENT_SLICE], ["loginctl", "disable-linger", SANDBOX_USER],
    ["loginctl", "terminate-user", SANDBOX_USER], ["pkill", "-KILL", "-u", SANDBOX_USER]]) {
    spawnSync("sudo", args, { stdio: "ignore" });
  }
}
