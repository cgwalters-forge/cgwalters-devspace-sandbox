# The step summary (summary.md) from summary.json: jq -r -L agent -f agent/summary-md.jq
include "lib";

def row: "| " + join(" | ") + " |";
def code: "`" + (tostring | gsub("`"; "'") | gsub("\\|"; "\\|")) + "`";

"## Agent run: \(.item) on \(.repo) (\(.base))",
"",
"\(.agent)/\(.model // "default"), \(.cores) cores: **\(.result)**",
"",
(["Duration", "Turns", "Tokens in/out", "Est. AIC"] | row),
("|---|---|---|---|"),
([(.duration_s | human_duration), (.turns | tostring),
  "\(.tokens.input | human_count) / \(.tokens.output | human_count)",
  "\(.aic // "?") of \(.aic_budget // "?") (\(.aic_pricing))"] | row),
(if .outcome.url then "", "Result: \(.outcome.url)" else empty end),
(if (.tools | length) > 0 then
   "", "| Tool | Calls | Errors | Time |", "|---|---|---|---|",
   (.tools | to_entries | sort_by(-.value.calls)[] | [.key, (.value.calls | tostring), (.value.errors | tostring), (.value.duration_s | human_duration)] | row)
 else empty end),
(if (.slowest | length) > 0 then
   "", "Slowest tool calls:", "",
   (.slowest[] | "- \(.duration_s | human_duration) \(.tool): \(.summary | code)")
 else empty end),
(if (.failures | length) > 0 then
   "", "Failures:", "", (.failures[] | "- \(.kind): \(.message | code)")
 else empty end),
(if (.tests | length) > 0 then
   "", "Tests:", "", (.tests[] | "- \(.command | code): exit \(.exit_code)")
 else empty end),
(if (.egress_denied | length) > 0 then
   "", "Denied egress: " + (.egress_denied | map("\(.domain | cut | code) (\(.count))") | join(", "))
 else empty end),
(if .redactions > 0 then "", "Redacted \(.redactions) string(s)." else empty end)
