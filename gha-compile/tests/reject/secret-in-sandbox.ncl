# expect: sandboxed steps cannot reference secrets
let gha = import "../../lib/gha.ncl" in
gha.compile {
  name = "t",
  on = { push = {} },
  jobs.t = {
    "runs-on" = "ubuntu-24.04",
    steps = [{ run = "make", env = { TOKEN = "${{ secrets.GITHUB_TOKEN }}" } }],
  },
}
