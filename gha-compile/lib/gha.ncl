# A GitHub Actions workflow in which every job has two phases.
#
# `runner_steps` run as the stock `runner` user, with its sudo, and set the
# machine up: packages, checkout, network. The compiler then adds one step
# that enters the sandbox (runtime/install.cjs). Every step in `steps` runs
# after that as the unprivileged sandbox user: `run:` steps get the sandbox
# wrapper as their shell, and `uses:` steps are limited to the job's
# `sandbox.allowed_actions`, pinned by commit.
#
# Fields otherwise map one to one onto the workflow syntax. The contracts
# are closed records, so anything the compiler doesn't know how to keep
# sandboxed (a step `shell:`, `defaults`, a job `container:`, workflow or job
# `env:`) is an error rather than silently passed through.
let EXEC = "/usr/local/bin/runner-sandbox-exec" in
let USER_RE = "^[a-z_][a-z0-9_-]{0,30}$" in

let validator = fun pred msg =>
  std.contract.from_validator (fun v => if pred v then 'Ok else 'Error { message = msg v })
in

# owner/repo[/path]@<40 hex>: a tag or branch can be moved, a commit can't.
let Pinned = validator
  (fun s => std.string.is_match "^[A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40}$" s)
  (fun s => "`%{s}` must be pinned by full commit SHA (owner/repo@<40 hex>)")
in

# Sandboxed steps never see the job's credentials, so they may not name them
# either: an expression expanding a secret or the token into a script or an
# env value would hand it to the sandbox.
let NoCredentials = validator
  (fun s => !(std.string.is_match "\\$\\{\\{[^}]*(secrets\\.|github\\.token)" s))
  (fun s => "sandboxed steps cannot reference secrets or github.token; pass data through runner_steps outputs instead")
in

let OneOfRunUses = validator
  (fun step => std.record.has_field "run" step != std.record.has_field "uses" step)
  (fun step => "a step needs exactly one of `run` or `uses`")
in

let Allowed = fun allowed => validator
  (fun step =>
    !(std.record.has_field "uses" step)
    || std.array.elem (std.array.first (std.string.split "@" step.uses)) allowed)
  (fun step => "`%{step.uses}` is not in sandbox.allowed_actions; after the privileged phase an action runs as the runner user with the job's tokens")
in

let RunnerStep = std.contract.Sequence [
  {
    name | String | optional,
    id | String | optional,
    "if" | String | optional,
    run | String | optional,
    shell | String | optional,
    uses | Pinned | optional,
    with | { _ : Dyn } | optional,
    env | { _ : String } | optional,
    "working-directory" | String | optional,
    "continue-on-error" | Bool | optional,
    "timeout-minutes" | Number | optional,
  },
  OneOfRunUses,
] in

# No `shell` (the compiler sets it) and no `working-directory` (the wrapper
# owns the working directory): both are errors here.
let SandboxStep = fun allowed => std.contract.Sequence [
  {
    name | String | optional,
    id | String | optional,
    "if" | String | optional,
    run | NoCredentials | optional,
    uses | Pinned | optional,
    with | { _ : NoCredentials } | optional,
    env | { _ : NoCredentials } | optional,
    "continue-on-error" | Bool | optional,
    "timeout-minutes" | Number | optional,
  },
  OneOfRunUses,
  Allowed allowed,
] in

let Sandbox = {
  user | String | validator (fun s => std.string.is_match USER_RE s) (fun s => "invalid user name `%{s}`") | default = "runner-sandbox",
  # Take root away from the runner user too, once the sandbox is entered;
  # its only sudo rule left is the wrapper.
  lock_runner_sudo | Bool | default = true,
  # Actions (owner/repo[/path], without @ref) allowed in `steps`. They run as
  # the runner user, not in the sandbox, so keep this short.
  allowed_actions | Array String | default = [],
} in

let Job = {
  name | String | optional,
  "runs-on" | Dyn,
  "timeout-minutes" | Number | optional,
  "if" | String | optional,
  needs | Dyn | optional,
  permissions | { _ : String } | optional,
  sandbox | Sandbox | default = {},
  runner_steps | Array RunnerStep | default = [],
  steps | Array Dyn,
} in

let Workflow = {
  name | String,
  "run-name" | String | optional,
  on | Dyn,
  permissions | { _ : String } | optional,
  concurrency | Dyn | optional,
  jobs | { _ : Job },
} in

let install_step = fun sandbox =>
  let config = {
    user = sandbox.user,
    lockRunnerSudo = sandbox.lock_runner_sudo,
    # Expanded by Actions when the step runs.
    workspace = "${{ github.workspace }}",
  }
  in
  {
    name = "Enter the sandbox (generated)",
    # sudo resets the environment; the runner's NOPASSWD: ALL rule allows
    # keeping these two.
    shell = "sudo --preserve-env=RUNNER_SANDBOX_EXEC_JS,RUNNER_SANDBOX_RUN_JS node {0}",
    env = {
      RUNNER_SANDBOX_EXEC_JS = import "../runtime/exec.cjs" as 'Text,
      RUNNER_SANDBOX_RUN_JS = import "../runtime/run.cjs" as 'Text,
    },
    run = "const CONFIG = %{std.serialize 'Json config};\n" ++ (import "../runtime/install.cjs" as 'Text),
  }
in

let sandbox_step = fun step =>
  if std.record.has_field "run" step then
    let env = if std.record.has_field "env" step then step.env else {} in
    let env_names = std.array.filter (fun n => n != "RUNNER_SANDBOX_ENV") (std.record.fields env) in
    let step = step |> std.record.insert "shell" "%{EXEC} {0}" in
    if env_names == [] then
      step
    else
      step
      |> std.record.remove "env"
      |> std.record.insert "env" (std.record.insert "RUNNER_SANDBOX_ENV" (std.string.join "," env_names) env)
  else
    step
in

let COMPILER_FIELDS = ["sandbox", "runner_steps", "steps"] in

let compile_job = fun job =>
  let sandbox = job.sandbox in
  let steps = std.array.map (fun s => s | SandboxStep sandbox.allowed_actions) job.steps in
  job
  |> std.record.filter (fun name _v => !(std.array.elem name COMPILER_FIELDS))
  |> std.record.insert "steps" (job.runner_steps @ [install_step sandbox] @ std.array.map sandbox_step steps)
in

{
  compile = fun source =>
    let wf = source | Workflow in
    wf
    |> std.record.remove "jobs"
    |> std.record.insert "jobs" (std.record.map (fun _name job => compile_job job) wf.jobs),
}
