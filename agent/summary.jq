# summary.json (agent-run-summary/v1, see docs/devspace-agent-runs.md in
# cgwalters-bot/homegit) from the stamped agent events and what the
# supervisor measured:
#   jq -n -L agent -f agent/summary.jq --slurpfile events stamped.jsonl \
#     --slurpfile outcome outcome.json --argjson meta META
# META holds run_id, run_attempt, run_url, item, repo, base, workflow,
# agent, model, cores, started_at, finished_at, duration_s, exit_code,
# aic_budget, aic_pricing, files, egress_denied and redactions.
include "lib";

($events | map(select(.event.type == "result")) | last | .event) as $result
| ($events | map(select(.event.type == "system" and .event.subtype == "init")) | first | .event) as $init
| ($events | tool_calls) as $calls
| ($outcome[0] // {}) as $out
# Without a result event (the agent was stopped), sum the per-message
# usage, once per message id.
| ($events | map(.event | select(.type == "assistant") | .message) | unique_by(.id) | map(.usage)) as $usages
| (if $result.usage then $result.usage
   else {input_tokens: ($usages | map(.input_tokens // 0) | add),
         output_tokens: ($usages | map(.output_tokens // 0) | add),
         cache_read_input_tokens: ($usages | map(.cache_read_input_tokens // 0) | add),
         cache_creation_input_tokens: ($usages | map(.cache_creation_input_tokens // 0) | add)}
   end) as $u
| (if $meta.exit_code == 124 then "timeout"
   elif $meta.exit_code != 0 then "failure"
   elif $result == null or $result.is_error == true then "failure"
   else "success" end) as $status
| {
    schema: "agent-run-summary/v1",
    run_id: $meta.run_id,
    run_attempt: $meta.run_attempt,
    run_url: $meta.run_url,
    item: $meta.item,
    repo: $meta.repo,
    base: $meta.base,
    workflow: $meta.workflow,
    agent: $meta.agent,
    model: ($init.model // $meta.model),
    cores: $meta.cores,
    started_at: $meta.started_at,
    finished_at: $meta.finished_at,
    duration_s: $meta.duration_s,
    result: $status,
    turns: ($result.num_turns // ($usages | length)),
    tokens: {input: $u.input_tokens, output: $u.output_tokens,
             cache_read: $u.cache_read_input_tokens, cache_write: $u.cache_creation_input_tokens},
    aic: (if $result.total_cost_usd then $result.total_cost_usd * 1000 | round / 10 else null end),
    aic_budget: $meta.aic_budget,
    aic_pricing: $meta.aic_pricing,
    tools: ($calls | group_by(.name) | map({key: .[0].name, value: {
      calls: length,
      errors: map(select(.error)) | length,
      duration_s: map(.duration_s // 0) | add}}) | from_entries),
    slowest: ($calls | map(select(.duration_s != null)) | sort_by(-.duration_s) | .[0:10]
              | map({tool: .name, summary, duration_s})),
    failures: (
      ($calls | map(select(.error) | {kind: "tool_error", message: ("\(.name): \(.message)" | cut)}))
      + (if $status == "timeout" then [{kind: "timeout", message: "the agent hit the step timeout"}]
         elif $meta.exit_code != 0 then [{kind: "agent_exit", message: "the agent exited \($meta.exit_code)"}]
         else [] end)),
    tests: ($out.tests // [] | if type == "array" then . else [] end
            | map(select(type == "object") | {command: (.command | cut), exit_code, duration_s})),
    files: $meta.files,
    egress_denied: $meta.egress_denied,
    outcome: {status: null, url: null, why: null},
    redactions: $meta.redactions
  }
