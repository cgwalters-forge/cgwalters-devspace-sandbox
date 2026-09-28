# expect: extra field `shell`
let gha = import "../../lib/gha.ncl" in
gha.compile {
  name = "t",
  on = { push = {} },
  jobs.t = {
    "runs-on" = "ubuntu-24.04",
    steps = [{ run = "id", shell = "bash {0}" }],
  },
}
