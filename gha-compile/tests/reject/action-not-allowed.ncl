# expect: is not in sandbox.allowed_actions
let gha = import "../../lib/gha.ncl" in
gha.compile {
  name = "t",
  on = { push = {} },
  jobs.t = {
    "runs-on" = "ubuntu-24.04",
    steps = [{ uses = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" }],
  },
}
