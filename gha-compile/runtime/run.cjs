// Root side of a sandboxed step: runner-sandbox-exec pipes a request
// ({id, script, env}) to this program through `sudo -n`, the one command the
// runner user may still run as root once the job has entered the sandbox.
// It runs the script as the sandbox user in a transient systemd service with
// a fixed environment, then hands back what the step wrote to its
// GITHUB_OUTPUT and GITHUB_STEP_SUMMARY. Nothing here trusts the request: its
// fields are validated, and the files the sandbox wrote are read without
// following symlinks.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CONFIG = JSON.parse(fs.readFileSync("/etc/runner-sandbox/config.json", "utf8"));
const STEPS_DIR = "/run/runner-sandbox/steps";
const RESULTS_DIR = "/run/runner-sandbox/results";
const MAX_FILE = 1 << 20;
const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";
// Variables the request may not set: the runner's credentials and anything
// that changes how the sandbox's own programs start.
const DENIED_ENV = /^(ACTIONS_|GITHUB_TOKEN$|GITHUB_ENV$|GITHUB_PATH$|GITHUB_OUTPUT$|GITHUB_STATE$|GITHUB_STEP_SUMMARY$|RUNNER_|LD_|BASH_ENV$|ENV$|NODE_OPTIONS$|PATH$|HOME$|USER$|LOGNAME$|SHELL$)/;

function fail(message) {
  console.error(`runner-sandbox-run: ${message}`);
  process.exit(125);
}

// Reads a file the sandbox user wrote, refusing symlinks and oversized files.
function readSandboxFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw new Error(`${path.basename(file)}: ${e.code}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
    if (st.size > MAX_FILE) throw new Error(`${path.basename(file)} is larger than ${MAX_FILE} bytes`);
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

let req;
try {
  req = JSON.parse(fs.readFileSync(0, "utf8"));
} catch (e) {
  fail(`invalid request: ${e.message}`);
}
if (!/^[0-9a-f]{32}$/.test(req.id ?? "")) fail("invalid step id");
if (typeof req.script !== "string") fail("missing script");
const env = req.env ?? {};
for (const [k, v] of Object.entries(env)) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) fail(`invalid variable name ${JSON.stringify(k)}`);
  if (DENIED_ENV.test(k)) fail(`${k} cannot be passed into the sandbox`);
  if (typeof v !== "string" || /[\0\n\r]/.test(v)) fail(`${k}: values must be single-line strings`);
}

const user = CONFIG.user;
const stepDir = path.join(STEPS_DIR, req.id);
const outDir = path.join(stepDir, "out");
fs.mkdirSync(stepDir, { mode: 0o755 }); // fails if the id was used before
fs.writeFileSync(path.join(stepDir, "script.sh"), req.script, { mode: 0o644 });
fs.mkdirSync(outDir, { mode: 0o700 });
fs.chownSync(outDir, CONFIG.uid, CONFIG.gid);

const vars = {
  ...env,
  HOME: CONFIG.home, USER: user, LOGNAME: user, LANG: "C.UTF-8", PATH: SANDBOX_PATH,
  GITHUB_OUTPUT: path.join(outDir, "output"),
  GITHUB_STEP_SUMMARY: path.join(outDir, "summary"),
};
const argv = [
  "--quiet", "--collect", "--wait", "--pipe", "--service-type=exec",
  `--uid=${user}`, `--gid=${user}`, `--working-directory=${CONFIG.workdir}`,
  // The sandbox gets its own /tmp, so it can't leave files there for the
  // runner's later steps; the runner's home is hidden outright.
  "-p", "PrivateTmp=yes", "-p", `InaccessiblePaths=-${CONFIG.runnerHome}`,
  ...Object.entries(vars).map(([k, v]) => `--setenv=${k}=${v}`),
  "--", "/bin/bash", "--noprofile", "--norc", "-e", "-o", "pipefail", path.join(stepDir, "script.sh"),
];
// systemd-run --pipe hands stdin to PID 1, which accepts a pipe but not
// every file type, so give it an empty pipe rather than /dev/null.
const r = spawnSync("systemd-run", argv, { stdio: ["pipe", "inherit", "inherit"], input: "" });
const status = r.status ?? 125;

// The unit is gone (--wait), so no sandbox process can change these now.
let result;
try {
  result = { status, output: readSandboxFile(path.join(outDir, "output")), summary: readSandboxFile(path.join(outDir, "summary")) };
} catch (e) {
  result = { status: 125, error: e.message };
}
fs.rmSync(stepDir, { recursive: true, force: true });
fs.writeFileSync(path.join(RESULTS_DIR, `${req.id}.json`), JSON.stringify(result), { mode: 0o644, flag: "wx" });
process.exit(status);
