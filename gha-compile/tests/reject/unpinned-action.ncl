# expect: must be pinned by full commit SHA
let gha = import "../../lib/gha.ncl" in
gha.compile {
  name = "t",
  on = { push = {} },
  jobs.t = {
    "runs-on" = "ubuntu-24.04",
    runner_steps = [{ uses = "actions/checkout@v7" }],
    steps = [{ run = "id" }],
  },
}
