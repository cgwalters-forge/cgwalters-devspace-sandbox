#!/usr/bin/env node
// The job's side of a praxis run (cgwalters-bot/praxis-credential-broker,
// run-token mode): the supervisor registers this job's run with an OIDC
// token, gives the agent only the run token it gets back, and ends the run
// when the agent is done, keeping its usage record for summary.json.
//
//   praxis.mjs register DIR      needs ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN;
//                                MAX_TOKENS (optional) lowers the run's cap
//   praxis.mjs configure DIR     writes runner-sandbox's opencode.json
//   praxis.mjs finish DIR        ends the run; DIR/usage.json is its record
//
// PRAXIS_BASE_URL is the broker's Responses base URL (http://HOST:PORT/v1);
// its runs endpoint is beside it. DIR is runner's own (mode 0700): it holds
// the run token, which reaches runner-sandbox only in its opencode.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asSandbox } from "../scripts/runner-sandbox.mjs";

// The audience praxis expects (its RUN_OIDC_AUDIENCE default).
export const AUDIENCE = "praxis-credential-broker";
export const TOKEN_FILE = "run-token";
export const USAGE_FILE = "usage.json";
export const RECORD_SCHEMA = "praxis-run-usage/v1";
// The environment that lets a process mint this job's OIDC tokens, and so
// register runs: never for the agent (scripts/runner-sandbox.mjs).
export const OIDC_REQUEST_VARS = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
// A run token as praxis mints them, for redaction.
export const RUN_TOKEN_PATTERN = "praxis-run-[0-9a-f]{64}";
// The run outlives the agent's timeout by this much, for bot-harness to
// finish and this job to end it.
const TTL_GRACE_S = 15 * 60;
const HTTP_TIMEOUT_MS = 30_000;
// Registration is retried with the same OIDC token, which praxis answers
// with the same run (and a new token), so a lost reply costs nothing.
const REGISTER_ATTEMPTS = 4;
const RETRY_DELAY_MS = 3000;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// opencode's configuration: the broker as its only provider; the base URL
// and key are filled in here.
const OPENCODE_CONFIG = join(ROOT, "agent/opencode.json");
// Where opencode reads its global configuration, in runner-sandbox's home.
export const OPENCODE_CONFIG_DIR = ".config/opencode";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// The runs endpoint beside the Responses base URL.
export function runsUrl(baseUrl, path = "") {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/runs${path}`;
  return url.toString();
}

async function http(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

// A private directory of runner's; files in it are 0600.
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writePrivate(path, content) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readToken(dir) {
  const token = readFileSync(join(dir, TOKEN_FILE), "utf8").trim();
  if (!new RegExp(`^${RUN_TOKEN_PATTERN}$`).test(token)) throw new Error(`${join(dir, TOKEN_FILE)} holds no run token`);
  return token;
}

// The per-run token cap a dispatch may ask for: empty (praxis' default) or
// a positive integer; praxis only ever lowers its own cap to it.
const MAX_TOKENS_RE = /^[1-9][0-9]{0,11}$/;

// How praxis must be set up for this job's runs, for error messages.
function deployHint(env) {
  const workflow = env.GITHUB_WORKFLOW_REF || "OWNER/REPO/.github/workflows/agent.yml@refs/heads/main";
  const repoId = env.GITHUB_REPOSITORY_ID || "REPOSITORY_ID";
  return `the broker must run cgwalters-bot/praxis-credential-broker in run-token mode `
    + `(PRAXIS_CLIENT_AUTH_MODE=run-token PRAXIS_RUN_OIDC_WORKFLOWS=${workflow} `
    + `PRAXIS_RUN_OIDC_REPOSITORY_IDS=${repoId}), and this run must be a workflow_dispatch`;
}

// Why a registration answered STATUS failed, for the job's log.
function registrationError(env, base, status, detail) {
  const at = `praxis at ${base}`;
  switch (status) {
    case 404:
    case 405:
      return `${at} doesn't take run registrations (HTTP ${status}), so it isn't in run-token mode yet: ${deployHint(env)}`;
    case 403:
      return `${at} refused to register runs of this workflow (HTTP 403: ${detail}): ${deployHint(env)}`;
    case 401:
      return `${at} rejected this job's OIDC token (HTTP 401: ${detail}); its audience is ${AUDIENCE}, `
        + "which the broker's RUN_OIDC_AUDIENCE must match";
    case 409:
      return `${at} refused to register this job's run again (HTTP 409): it was registered with another OIDC token `
        + "or has already ended; a re-run of the workflow registers a new run attempt";
    default:
      return `registering the run with ${at} failed (HTTP ${status}: ${detail})`;
  }
}

async function oidcToken(env) {
  const [url, bearer] = OIDC_REQUEST_VARS.map((name) => env[name]);
  if (!url || !bearer) throw new Error("no OIDC request credentials: the job needs permissions id-token: write");
  const request = new URL(url);
  request.searchParams.set("audience", AUDIENCE);
  const r = await http(request, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!r.ok) throw new Error(`requesting an OIDC token failed: HTTP ${r.status}`);
  const { value } = await r.json();
  if (typeof value !== "string" || !value) throw new Error("the OIDC token response has no token");
  return value;
}

// Registers this job's run and keeps its token in DIR. Environment:
// PRAXIS_BASE_URL, TIMEOUT_MINUTES, MAX_TOKENS (optional), the OIDC request
// variables, and GITHUB_WORKFLOW_REF and GITHUB_REPOSITORY_ID for errors.
// Returns the run's initial usage record.
export async function register(dir, { env = process.env, retryDelayMs = RETRY_DELAY_MS, log = console.log } = {}) {
  const base = env.PRAXIS_BASE_URL;
  const minutes = Number(env.TIMEOUT_MINUTES);
  const maxTokens = env.MAX_TOKENS ?? "";
  if (!base) throw new Error("PRAXIS_BASE_URL is not set");
  if (!(minutes > 0)) throw new Error("TIMEOUT_MINUTES is not set");
  if (maxTokens !== "" && !MAX_TOKENS_RE.test(maxTokens)) {
    throw new Error(`MAX_TOKENS must be empty or a positive number of tokens, not '${maxTokens}'`);
  }
  privateDir(dir);
  const jwt = await oidcToken(env);
  const body = JSON.stringify({
    ttl_secs: minutes * 60 + TTL_GRACE_S,
    ...(maxTokens !== "" ? { max_tokens: Number(maxTokens) } : {}),
  });
  let last = "";
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    let r;
    try {
      r = await http(runsUrl(base), {
        method: "POST", body, headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      });
    } catch (e) {
      last = `can't reach praxis at ${base} (${e.cause?.code ?? e.message}); is this runner on the tailnet?`;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }
    if (r.status === 201) {
      const { token, usage } = await r.json();
      if (typeof token !== "string" || !new RegExp(`^${RUN_TOKEN_PATTERN}$`).test(token)) {
        throw new Error("praxis returned no run token");
      }
      // Masked in every later line of this job's log.
      log(`::add-mask::${token}`);
      writePrivate(join(dir, TOKEN_FILE), `${token}\n`);
      const expires = new Date(usage.expires_at_unix * 1000).toISOString();
      log(`Registered praxis run ${usage.run_id}/${usage.run_attempt}: at most ${usage.max_tokens} tokens, until ${expires}`);
      // The broker may grant less than asked (its RUN_MAX_SECS): the agent
      // then loses inference before its own timeout.
      const deadline = Math.floor(Date.now() / 1000) + minutes * 60;
      if (!(usage.expires_at_unix >= deadline)) {
        log(`::warning::the praxis run expires at ${expires}, before the agent's ${minutes}-minute timeout; `
          + "the broker's RUN_MAX_SECS is shorter, so its last requests will be refused");
      }
      return usage;
    }
    last = registrationError(env, base, r.status, (await r.text()).trim().slice(0, 200));
    // Only a server error or overload is worth another try, with the same
    // OIDC token: praxis answers that with the same run.
    if (r.status < 500 && r.status !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new Error(last);
}

// Writes runner-sandbox's opencode configuration, readable only by it: the
// run token is its API key, which the broker takes in place of the caller's.
function configure(dir) {
  const base = process.env.PRAXIS_BASE_URL;
  if (!base) fail("PRAXIS_BASE_URL is not set");
  const config = JSON.parse(readFileSync(OPENCODE_CONFIG, "utf8"));
  config.provider.praxis.options.baseURL = base;
  config.provider.praxis.options.apiKey = readToken(dir);
  // umask 077 from the start, so the file is never readable by others; the
  // content goes over stdin, never onto a command line.
  const write = asSandbox(["sh", "-c",
    `umask 077 && mkdir -p "$HOME/${OPENCODE_CONFIG_DIR}" && chmod 0700 "$HOME/${OPENCODE_CONFIG_DIR}" `
    + `&& cat > "$HOME/${OPENCODE_CONFIG_DIR}/opencode.json.tmp" && chmod 0600 "$HOME/${OPENCODE_CONFIG_DIR}/opencode.json.tmp" `
    + `&& mv "$HOME/${OPENCODE_CONFIG_DIR}/opencode.json.tmp" "$HOME/${OPENCODE_CONFIG_DIR}/opencode.json"`],
  { input: `${JSON.stringify(config, null, 2)}\n` });
  if (write.status !== 0) fail("writing runner-sandbox's opencode configuration failed");
}

// Ends the run, so its token admits nothing more, and keeps the final usage
// record. Ending it again returns the same record, so this is safe to run
// from both the agent step and the always() step after it.
export async function finish(dir, { env = process.env, log = console.log } = {}) {
  const base = env.PRAXIS_BASE_URL;
  if (!existsSync(join(dir, TOKEN_FILE))) {
    log("No praxis run to end");
    return null;
  }
  if (!base) throw new Error("PRAXIS_BASE_URL is not set, so the praxis run can't be ended");
  // Until this succeeds the token may still be live, so nothing is uploaded
  // (agent.yml gates the uploads on it).
  const live = "; its token may still be live until the run expires";
  let r;
  try {
    r = await http(runsUrl(base, "/self"), {
      method: "DELETE", headers: { Authorization: `Bearer ${readToken(dir)}` },
    });
  } catch (e) {
    throw new Error(`can't reach praxis at ${base} to end the run (${e.cause?.code ?? e.message})${live}`);
  }
  if (!r.ok) throw new Error(`ending the praxis run failed: HTTP ${r.status}${live}`);
  const record = await r.json();
  if (record.schema !== RECORD_SCHEMA) throw new Error(`praxis returned ${record.schema}, not ${RECORD_SCHEMA}`);
  writePrivate(join(dir, USAGE_FILE), `${JSON.stringify(record)}\n`);
  const t = record.tokens ?? {};
  log(`Ended praxis run ${record.run_id}/${record.run_attempt} (${record.state}): `
    + `${record.requests} request(s), ${t.total} tokens (${t.input} in + ${t.cache_read} cached / ${t.output} out), `
    + `${record.refused} refused, ${record.estimated} estimated`);
  return record;
}

const COMMANDS = { register: (dir) => register(dir), configure, finish };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, dir] = process.argv.slice(2);
  if (!COMMANDS[command] || !dir) fail(`usage: praxis.mjs ${Object.keys(COMMANDS).join("|")} DIR`);
  Promise.resolve(COMMANDS[command](dir)).catch((e) => {
    // An annotation, so the reason shows on the run's page.
    console.log(`::error::${e.message.replace(/[\x00-\x1f\x7f]/g, " ")}`);
    process.exit(1);
  });
}
