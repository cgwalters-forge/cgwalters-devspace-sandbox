# expect: exactly one of `run` or `uses`
let gha = import "../../lib/gha.ncl" in
gha.compile {
  name = "t",
  on = { push = {} },
  jobs.t = {
    "runs-on" = "ubuntu-24.04",
    steps = [{ name = "nothing" }],
  },
}
