#!/usr/bin/env node
// The agent step of agent.yml: run the agent CLI as the unprivileged
// runner-sandbox user on a checkout of the target repository, stream its
// condensed transcript into the job log, then collect the run's files for
// upload. Runs as runner (with sudo), after scripts/setup-runner-sandbox.mjs
// and scripts/public-repo.mjs. The artifact layout and summary.json are the
// contract in docs/devspace-agent-runs.md in cgwalters-bot/homegit.
//
// TODO: this drives Claude Code through its own CLI flags and stream-json
// output, so each further agent needs its own glue. Medium term, replace
// that with a generic wrapper speaking the Agent Client Protocol
// (https://agentclientprotocol.com): one client for every ACP agent
// (natively or through an adapter), with the transcript, tool calls,
// permission requests and usage as protocol events.
//
// Environment (from the workflow): ITEM REPO BASE AGENT MODEL CORES
// TIMEOUT_MINUTES BUDGET WORKFLOW BRIEF OUT, and the GITHUB_* run variables. Everything lands in OUT: run/ (the agent-run
// artifact) and transcript.tar.zst (agent-transcript).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, createWriteStream, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { SANDBOX_HOME, agentCommand, asAgent, fail, killAgent, run } from "../scripts/agent-lib.mjs";
import { makeRedactor, redactTree } from "./redact.mjs";

const LIB = dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 18080;
const DEFAULT_MODEL = "claude-sonnet-4-5";
const LOG_GROUP = "agent (condensed)";
// Largest outcome.json taken from the agent.
const MAX_OUTCOME_BYTES = 65536;
const EXIT_TIMEOUT = 124;
// Egress is open, so nothing is denied; summary.json keeps the field.
const EGRESS_DENIED = [];
// The values of whatever tokens this step can see, for redaction.
const TOKEN_VARS = ["ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_TOKEN"];
const REQUIRED = ["ITEM", "REPO", "BASE", "AGENT", "CORES", "TIMEOUT_MINUTES", "BUDGET", "WORKFLOW", "BRIEF", "OUT",
  "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY"];

const env = process.env;
// On one line and without control characters: text from the target
// repository or the agent must not act as a workflow command.
const oneLine = (s) => s.replace(/[\x00-\x1f\x7f]/g, " ");
const jq = (args, input) => run("jq", ["-L", LIB, ...args], { input });

function validate() {
  for (const name of REQUIRED) {
    if (!env[name]) fail(`${name} is not set`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.REPO)) fail("bad repository name");
  // A branch or tag name for git clone --branch.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(env.BASE) || env.BASE.includes("..")) {
    fail("bad base ref (letters, digits and _ . / - only)");
  }
  if (env.AGENT !== "claude") fail(`agent '${env.AGENT}' is not supported yet (only claude)`);
}

// Starts the mock Messages API and waits until it answers.
async function startMock(workdir, usageLog, logFile) {
  const mock = spawn("python3", [join(LIB, "mock-model.py"), "--script", join(LIB, "mock-conversation.json"),
    "--workdir", workdir, "--port", String(MOCK_PORT), "--usage-log", usageLog],
  { stdio: ["ignore", "ignore", openSync(logFile, "w")] });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${MOCK_PORT}/`);
      return mock;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("the mock model didn't start");
}

// Runs the agent, streaming its stream-json output: raw to RAW, redacted and
// timestamped to STAMPED, and condensed (by condense.jq) to the log and
// CONDENSED. Returns the agent's exit status.
async function runAgent({ workdir, model, redact, raw, stamped, condensed, stderrLog }) {
  const [bin, args] = agentCommand(["timeout", "--kill-after=30", `${env.TIMEOUT_MINUTES}m`,
    "claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", model],
  { cwd: workdir, env: {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, ANTHROPIC_API_KEY: "mock-no-credentials",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" } });
  const agent = spawn(bin, args, { stdio: "pipe" });
  const agentClosed = new Promise((resolve) => agent.on("close", (code) => resolve(code ?? 128)));
  const condense = spawn("jq", ["-nr", "--unbuffered", "-L", LIB, "-f", join(LIB, "condense.jq")], { stdio: ["pipe", "pipe", "inherit"] });
  const rawOut = createWriteStream(raw);
  const stampedOut = createWriteStream(stamped);
  const condensedOut = createWriteStream(condensed);
  agent.stderr.pipe(createWriteStream(stderrLog));
  condense.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    condensedOut.write(chunk);
  });
  agent.stdin.end(`${env.BRIEF}\n`);
  for await (const line of createInterface({ input: agent.stdout })) {
    rawOut.write(`${line}\n`);
    const clean = redact(line);
    let record;
    try {
      record = { ts: Date.now() / 1000, event: JSON.parse(clean) };
    } catch {
      record = { ts: Date.now() / 1000, event: null, line: clean };
    }
    const json = `${JSON.stringify(record)}\n`;
    stampedOut.write(json);
    condense.stdin.write(json);
  }
  const status = await agentClosed;
  condense.stdin.end();
  await new Promise((resolve) => condense.on("close", resolve));
  await Promise.all([rawOut, stampedOut, condensedOut].map((s) => new Promise((resolve) => s.end(resolve))));
  return status;
}

// Collects what the agent left, reading its files as the agent: as root, a
// link planted there could copy the runner's secrets into an artifact.
function collect({ workdir, runDir, tx }) {
  const status = asAgent(["timeout", "60", "git", "-c", "core.fsmonitor=false", "-C", workdir,
    "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = status.status === 0
    ? status.stdout.toString().split("\0").filter((e) => e.length > 3).map((e) => e.slice(3)).sort() : [];
  killAgent();
  // The agent's own outcome, if it's a JSON object of sane size.
  let outcome = {};
  const out = asAgent(["head", "-c", String(MAX_OUTCOME_BYTES + 1), `${SANDBOX_HOME}/out/outcome.json`]);
  if (out.status === 0 && out.stdout.length <= MAX_OUTCOME_BYTES) {
    try {
      const parsed = JSON.parse(out.stdout.toString());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) outcome = parsed;
    } catch { /* not JSON: none */ }
  }
  writeFileSync(join(runDir, "outcome.json"), `${JSON.stringify(outcome)}\n`);
  // Session files, copied by tar so links stay links (deleted later).
  const sessions = join(tx, "sessions");
  mkdirSync(sessions, { recursive: true });
  const tarball = asAgent(["tar", "-C", `${SANDBOX_HOME}/.claude/projects`, "-cf", "-", "."]);
  if (tarball.status === 0) {
    spawnSync("tar", ["-C", sessions, "-xf", "-", "--no-same-owner", "--no-same-permissions"], { input: tarball.stdout });
  }
  killAgent();
  return files;
}

async function main() {
  validate();
  const out = env.OUT;
  const runDir = join(out, "run");
  const tx = join(out, "transcript");
  const work = join(out, "work");
  for (const dir of [runDir, join(tx, "test-logs"), work]) mkdirSync(dir, { recursive: true });
  const workdir = `${SANDBOX_HOME}/work/${env.REPO.split("/")[1]}`;
  const redact = makeRedactor(TOKEN_VARS.map((name) => env[name]).filter(Boolean));
  const model = env.MODEL || DEFAULT_MODEL;
  process.on("exit", killAgent);

  console.log(`::group::Check out ${env.REPO} (${env.BASE}) as runner-sandbox`);
  asAgent(["mkdir", "-p", `${SANDBOX_HOME}/work`, `${SANDBOX_HOME}/out`]);
  const clone = asAgent(["git", "clone", "--quiet", "--depth", "50", "--branch", env.BASE, `https://github.com/${env.REPO}`, workdir]);
  if (clone.status !== 0) fail(`cloning ${env.REPO} failed`);
  console.log(`head: ${oneLine(asAgent(["git", "-C", workdir, "log", "-1", "--format=%h %s"]).stdout.toString().trim())}`);
  console.log("::endgroup::");

  // Inference: a mock replaying agent/mock-conversation.json, so no
  // credentials are needed. TODO (plan step 4): a spend-capped shim.
  const mock = await startMock(workdir, join(tx, "token-usage.jsonl"), join(work, "mock-model.log"));
  const started = new Date();
  // The condensed lines each start with condense.jq's own marker and never
  // span lines, so none can be read as a workflow command.
  console.log(`::group::${LOG_GROUP}`);
  const condensed = join(runDir, "condensed.log");
  const exitCode = await runAgent({ workdir, model, redact, raw: join(work, "raw.jsonl"), stamped: join(work, "stamped.jsonl"),
    condensed, stderrLog: join(work, "agent-stderr.log") });
  if (exitCode !== 0) {
    const line = exitCode === EXIT_TIMEOUT ? `⚠ agent timed out after ${env.TIMEOUT_MINUTES}m` : `⚠ agent exited ${exitCode}`;
    console.log(line);
    appendFileSync(condensed, `${line}\n`);
  }
  console.log("::endgroup::");
  const finished = new Date();
  killAgent();
  mock.kill();

  console.log("::group::Collect the run's files");
  const files = collect({ workdir, runDir, tx });
  copyFileSync(join(work, "raw.jsonl"), join(tx, "raw.jsonl"));
  redactTree(redact, [tx, runDir]);
  console.log("::endgroup::");

  const meta = {
    run_id: Number(env.GITHUB_RUN_ID), run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    run_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    item: env.ITEM, repo: env.REPO, base: env.BASE, workflow: env.WORKFLOW, agent: env.AGENT, model,
    cores: Number(env.CORES), started_at: started.toISOString().replace(/\.\d+Z$/, "Z"),
    finished_at: finished.toISOString().replace(/\.\d+Z$/, "Z"),
    duration_s: Math.round((finished - started) / 1000), exit_code: exitCode, aic_budget: Number(env.BUDGET),
    aic_pricing: "mock", files, egress_denied: EGRESS_DENIED, redactions: redact.count,
  };
  const summary = jq(["-n", "-f", join(LIB, "summary.jq"), "--slurpfile", "events", join(work, "stamped.jsonl"),
    "--slurpfile", "outcome", join(runDir, "outcome.json"), "--argjson", "meta", JSON.stringify(meta)]);
  writeFileSync(join(runDir, "summary.json"), `${summary}\n`);
  const markdown = jq(["-r", "-f", join(LIB, "summary-md.jq")], summary);
  writeFileSync(join(runDir, "summary.md"), `${markdown}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);

  // Public repositories only (scripts/public-repo.mjs), so the transcript
  // may be public as well; it's redacted like everything else.
  run("tar", ["--zstd", "-cf", join(out, "transcript.tar.zst"), "-C", tx, "."]);
  console.log(`Agent ${env.AGENT} exited ${exitCode}: ${JSON.parse(summary).result}`);
  process.exitCode = exitCode;
}

main().catch((e) => fail(e.message));
