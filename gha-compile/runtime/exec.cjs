// Runner side of a sandboxed step, used as its shell
// (`shell: /usr/local/bin/runner-sandbox-exec {0}`). It runs as the runner
// user, which holds the job's credentials, so it passes along only the step
// script, the variables the compiler listed in RUNNER_SANDBOX_ENV and a
// fixed set of non-secret context variables, and asks runner-sandbox-run
// (through sudo) to run the script as the sandbox user. Afterwards it copies
// the step's outputs and summary into the runner's own files, accepting only
// plain name=value output lines.
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const RUN = "/usr/local/libexec/runner-sandbox-run";
const RESULTS_DIR = "/run/runner-sandbox/results";
const CONTEXT_ENV = [
  "CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "GITHUB_EVENT_NAME", "GITHUB_JOB", "GITHUB_REF", "GITHUB_REF_NAME",
  "GITHUB_REPOSITORY", "GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID", "GITHUB_SERVER_URL", "GITHUB_SHA", "GITHUB_WORKFLOW",
];
const OUTPUT_LINE = /^[A-Za-z_][A-Za-z0-9_-]*=[^\r]*$/;

function fail(message) {
  console.error(`runner-sandbox-exec: ${message}`);
  process.exit(125);
}

const scriptPath = process.argv[2];
if (!scriptPath || process.argv.length !== 3) fail("usage: runner-sandbox-exec SCRIPT");
const names = (process.env.RUNNER_SANDBOX_ENV ?? "").split(",").filter(Boolean);
const env = {};
for (const name of [...CONTEXT_ENV, ...names]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
const id = crypto.randomBytes(16).toString("hex");
const request = JSON.stringify({ id, script: fs.readFileSync(scriptPath, "utf8"), env });
const r = spawnSync("sudo", ["-n", RUN], { input: request, stdio: ["pipe", "inherit", "inherit"] });
if (r.error) fail(`running ${RUN}: ${r.error.message}`);

let result;
try {
  result = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/${id}.json`, "utf8"));
} catch (e) {
  fail(`no result from the sandbox (exit ${r.status}): ${e.message}`);
}
if (result.error) fail(result.error);
const lines = result.output.split("\n").filter((l) => l !== "");
const bad = lines.find((l) => !OUTPUT_LINE.test(l));
if (bad !== undefined) fail(`refusing GITHUB_OUTPUT line ${JSON.stringify(bad.slice(0, 80))}: only name=value lines are accepted`);
if (lines.length) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
if (result.summary) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary);
process.exit(result.status);
