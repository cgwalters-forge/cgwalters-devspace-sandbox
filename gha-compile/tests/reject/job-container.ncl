# expect: extra field `container`
let gha = import "../../lib/gha.ncl" in
gha.compile {
  name = "t",
  on = { push = {} },
  jobs.t = {
    "runs-on" = "ubuntu-24.04",
    container = { image = "fedora", options = "--user 1001" },
    steps = [{ run = "id" }],
  },
}
