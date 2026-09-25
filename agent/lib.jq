# Shared by condense.jq and summary.jq. Their input is the agent CLI's
# stream-json output (Claude Code's -p --output-format stream-json
# --verbose), one event per line, each wrapped by the supervisor as
# {"ts": <arrival time, epoch seconds>, "event": <the event>}.

# Free text in summaries and log lines: on one line (so nothing the agent
# writes can start a line of the job log, and so act as a workflow
# command) and cut to 200 characters.
def cut: tostring | gsub("[[:cntrl:]]"; " ") | if length > 200 then .[0:199] + "…" else . end;
def first_line: tostring | split("\n") | map(select(test("\\S"))) | (.[0] // "");

# A tool call as one short line, from its name and input.
def tool_summary($name; $input; $cwd):
  def rel: tostring | if $cwd != "" and startswith($cwd + "/") then .[($cwd | length) + 1:] else . end;
  ($input // {}) as $i
  | if $name == "Bash" then $i.command | first_line
    elif $i.file_path then $i.file_path | rel
    elif $i.notebook_path then $i.notebook_path | rel
    elif $i.pattern then $i.pattern
    elif $i.url then $i.url
    elif $i.description then $i.description
    else $i | tojson
    end
  | cut;

def is_edit($name): $name == "Edit" or $name == "Write" or $name == "MultiEdit" or $name == "NotebookEdit";

# A tool result's text, whether a string or a list of content blocks.
def result_text:
  if type == "string" then .
  elif type == "array" then map(.text? // "" ) | join("\n")
  else tostring
  end;

# The line that says what went wrong: a failed Bash result starts with
# "Exit code N", which the log line already shows.
def error_line: result_text | split("\n") | map(select(test("\\S") and (test("^Exit code [0-9]+$") | not))) | (.[0] // "") | cut;

# Pairs each tool call with its result: a list of {id, name, summary,
# start, end, duration_s, error, message}, in call order. A call without
# a result (the agent was stopped) has end, duration_s and error null.
def tool_calls:
  (map(select(.event.type == "system" and .event.subtype == "init") | .event.cwd) | first // "") as $cwd
  | reduce .[] as $x ({calls: [], index: {}};
      if $x.event.type == "assistant" then
        reduce ($x.event.message.content[]? | select(.type == "tool_use")) as $t (.;
          .index[$t.id] = (.calls | length)
          | .calls += [{id: $t.id, name: $t.name, summary: tool_summary($t.name; $t.input; $cwd),
                        start: $x.ts, end: null, duration_s: null, error: null, message: null}])
      elif $x.event.type == "user" then
        reduce ($x.event.message.content[]? | select(.type == "tool_result")) as $r (.;
          .index[$r.tool_use_id] as $i
          | if $i == null then . else
              .calls[$i] += {end: $x.ts, duration_s: (($x.ts - .calls[$i].start) | floor),
                             error: ($r.is_error == true),
                             message: ($r.content | error_line)}
            end)
      else . end)
  | .calls;

# "1.2M", "40k" or "386"
def human_count:
  if . == null then "?"
  elif . >= 1000000 then "\(. / 100000 | floor / 10)M"
  elif . >= 1000 then "\(. / 1000 | floor)k"
  else tostring end;

# "42m", "1h05m" or "12s"
def human_duration:
  if . == null then "?"
  elif . >= 3600 then "\(. / 3600 | floor)h\(. % 3600 / 60 | floor | tostring | if length < 2 then "0" + . else . end)m"
  elif . >= 60 then "\(. / 60 | floor)m"
  else "\(.)s" end;
