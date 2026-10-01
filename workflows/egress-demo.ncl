# The wfc-spike egress demo (workflow-compiler#22): the sandboxed phase
# reaches only the hosts in sandbox.network.allow, through the compiler's
# proxy, and has no DNS of its own; the privileged phases before and after
# it keep the runner's network. Compiled with wfc (at the commit in
# .wfc-rev) to .github/workflows/egress-demo.lock.yml by ./wfc-compile.sh.
let gha = import "../wfc/lib/gha.ncl" in
let checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" in # v7.0.1
let ANY_HOST = "curl -sSf --max-time 20 -o /dev/null https://example.com/ && echo 'reached example.com as '$(id -un)" in

gha.compile {
  name = "Egress demo",
  "run-name" = "Egress demo (wfc-spike)",
  on = {
    workflow_dispatch = {},
    # GitHub learns of a workflow on a branch other than the default from
    # a run: this push trigger gives the lock file its first one.
    push = { branches = ["wfc-spike"], paths = [".github/workflows/egress-demo.lock.yml"] },
  },
  permissions = { contents = "read" },
  jobs.egress = {
    "timeout-minutes" = 15,
    sandbox.network.allow = ["api.github.com"],
    runner_steps = [
      { uses = checkout, with = { persist-credentials = false } },
      { name = "runner_steps reach any host", run = ANY_HOST },
    ],
    steps = [
      { name = "The sandbox reaches only allowed hosts", run = import "egress-demo/sandbox-egress.sh" as 'Text },
    ],
    publish_steps = [
      { name = "publish_steps reach any host", run = ANY_HOST },
    ],
  },
}
