# One line per agent event for the job log and condensed.log, streamed:
#   jq -nr --unbuffered -L agent -f agent/condense.jq < stamped.jsonl
# Tool calls print when their result arrives, with its outcome and time.
include "lib";

def exit_note($r):
  (($r.content | result_text | capture("^Exit code (?<n>[0-9]+)").n) // null) as $code
  | if $code then "exit \($code)" elif $r.is_error == true then "error" else "ok" end;

foreach inputs as $x (
  {calls: {}, turns: 0, seen: {}, input: 0, output: 0, cwd: "", out: []};
  .out = []
  | if $x.event == null then
      .out = ["· \($x.line | cut)"]
    elif $x.event.type == "system" and $x.event.subtype == "init" then
      .cwd = ($x.event.cwd // "")
      | .out = ["start: \($x.event.model // "default model" | cut), \($x.event.tools | length) tools, in \(.cwd | cut)"]
    elif $x.event.type == "assistant" then
      ($x.event.message) as $m
      | (if .seen[$m.id] then . else
           .seen[$m.id] = true | .turns += 1
           | .input += (($m.usage.input_tokens // 0) + ($m.usage.cache_read_input_tokens // 0) + ($m.usage.cache_creation_input_tokens // 0))
           | .output += ($m.usage.output_tokens // 0)
           | if .turns == 1 or .turns % 10 == 0 then
               .out += ["turn \(.turns), \(.input | human_count) in / \(.output | human_count) out"]
             else . end
         end)
      | reduce ($m.content[]?) as $c (.;
          if $c.type == "tool_use" then
            .calls[$c.id] = {ts: $x.ts, name: $c.name, summary: tool_summary($c.name; $c.input; .cwd)}
          elif $c.type == "text" and ($c.text | test("\\S")) then
            .out += ["» \($c.text | first_line | cut)"]
          else . end)
    elif $x.event.type == "user" then
      reduce ($x.event.message.content[]? | select(.type == "tool_result")) as $r (.;
        .calls[$r.tool_use_id] as $call
        | if $call == null then . else
            (($x.ts - $call.ts) | floor) as $secs
            | .out += [if is_edit($call.name) then "✎ \($call.name) \($call.summary)"
                       else "▶ \($call.name): \($call.summary) (\(exit_note($r)), \($secs)s)" end]
            | if $r.is_error == true then
                .out += ["⚠ tool error: \($call.name): \($r.content | error_line)"]
              else . end
          end)
    elif $x.event.type == "result" then
      .out = ["done: \($x.event.subtype // "?" | cut), \($x.event.num_turns // .turns) turns, \(($x.event.duration_ms // 0) / 1000 | floor | human_duration)"]
    else . end;
  .out[]
)
