# expect: extra field `defaults`
let gha = import "../../lib/gha.ncl" in
gha.compile {
  name = "t",
  on = { push = {} },
  jobs.t = {
    "runs-on" = "ubuntu-24.04",
    defaults = { run = { shell = "bash {0}" } },
    steps = [{ run = "id" }],
  },
}
