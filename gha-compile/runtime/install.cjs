// The compiler-generated "enter the sandbox" step, run as root (`sudo node`)
// right after the job's runner_steps. The compiler prepends
// `const CONFIG = {...};` to this file and passes the two halves of the step
// wrapper as RUNNER_SANDBOX_EXEC_JS and RUNNER_SANDBOX_RUN_JS.
//
// It creates the sandbox user, gives it a copy of the workspace, installs
// the two halves of the step wrapper, and (with CONFIG.lockRunnerSudo) takes
// root away from the runner user, whose only remaining sudo rule is the
// wrapper. From here on, the job's run steps execute as the sandbox user.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const CONFIG_DIR = "/etc/runner-sandbox";
const EXEC = "/usr/local/bin/runner-sandbox-exec";
const RUN = "/usr/local/libexec/runner-sandbox-run";
const SUDOERS = "/etc/sudoers.d/zz-runner-sandbox";
const WORKDIR = "/var/lib/runner-sandbox/work";
const DOCKER_UNITS = ["docker.socket", "docker.service", "containerd.service"];

function run(cmd, args, { check = true } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (check && r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.error ?? `exit ${r.status}`})`);
  return { status: r.status, stdout: (r.stdout ?? "").trim() };
}

function passwd(name) {
  const [, , uid, gid, , home] = run("getent", ["passwd", name]).stdout.split(":");
  return { uid: Number(uid), gid: Number(gid), home };
}

if (process.getuid() !== 0) throw new Error("must run as root");
const runner = process.env.SUDO_USER;
if (!runner || runner === "root") throw new Error("must be started with sudo by the runner user");
const user = CONFIG.user;

if (run("getent", ["passwd", user], { check: false }).status !== 0) {
  run("useradd", ["--create-home", "--user-group", "--shell", "/bin/bash", user]);
}
const sandbox = passwd(user);
const runnerHome = passwd(runner).home;

// The sandbox works on its own copy of the checkout; the runner's home,
// which holds the runner's credentials and the job's temp files, is closed.
fs.mkdirSync(WORKDIR, { recursive: true });
run("cp", ["-a", `${CONFIG.workspace}/.`, WORKDIR]);
run("chown", ["-R", `${sandbox.uid}:${sandbox.gid}`, WORKDIR]);
fs.chmodSync(runnerHome, 0o700);

fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o755 });
fs.writeFileSync(`${CONFIG_DIR}/config.json`, JSON.stringify({ user, ...sandbox, workdir: WORKDIR, runnerHome }), { mode: 0o644 });
fs.mkdirSync("/usr/local/libexec", { recursive: true });
for (const [dest, text] of [[EXEC, process.env.RUNNER_SANDBOX_EXEC_JS], [RUN, process.env.RUNNER_SANDBOX_RUN_JS]]) {
  if (!text) throw new Error(`nothing to install at ${dest}`);
  fs.writeFileSync(dest, `#!${process.execPath}\n${text}`, { mode: 0o755 });
  fs.chmodSync(dest, 0o755);
}
for (const d of ["/run/runner-sandbox/steps", "/run/runner-sandbox/results"]) {
  fs.mkdirSync(d, { recursive: true, mode: 0o755 });
}

// The last matching sudoers rule wins, and this file is read last.
let sudoers = `${user} ALL=(ALL:ALL) !ALL\n`;
if (CONFIG.lockRunnerSudo) {
  sudoers += `${runner} ALL=(ALL:ALL) !ALL\n${runner} ALL=(root) NOPASSWD: ${RUN} ""\n`;
}
fs.writeFileSync(`${SUDOERS}.tmp`, sudoers, { mode: 0o440 });
run("visudo", ["-cq", "-f", `${SUDOERS}.tmp`]);
fs.renameSync(`${SUDOERS}.tmp`, SUDOERS);

if (CONFIG.lockRunnerSudo) {
  // The runner user is in the docker group, and processes the runner
  // already started keep that group; a daemon that isn't running can't
  // be asked for a root container.
  const present = DOCKER_UNITS.filter((u) => run("systemctl", ["cat", u], { check: false }).status === 0);
  if (present.length) run("systemctl", ["stop", ...present]);
  // Fail closed: the runner must have lost root, and kept only the wrapper.
  if (run("runuser", ["-u", runner, "--", "sudo", "-n", "true"], { check: false }).status === 0) {
    throw new Error(`${runner} still has sudo after the lock`);
  }
  run("runuser", ["-u", runner, "--", "sudo", "-n", "-l", RUN]);
}
console.log(`Entered the sandbox: later run steps execute as ${user} (uid ${sandbox.uid}) in ${WORKDIR}`);
console.log(run("sudo", ["-l", "-U", runner]).stdout);
