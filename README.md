# cgwalters-devspace

This repository dispatches a bounded, disposable RHEL 10 development runner.
Tailscale supplies private networking inside the remote workflow; access is
ordinary OpenSSH as the unprivileged user `runner-sandbox`.

## Prerequisites

Install Rust/Cargo 1.85 or newer. The `cargo devspace` alias is defined in this
repository's `.cargo/config.toml` and is local to this checkout. Authenticate
the GitHub CLI (`gh auth login`) with permission to dispatch, view, and cancel
this repository's workflows. The `ssh` and `ssh-keygen` commands must also be
available.

An administrator must configure repository variables `TS_OAUTH_CLIENT_ID` and
`TS_AUDIENCE`. The federated Tailscale identity needs writable `auth_keys`, the
`tag:bootc-dev-sandbox` tag, and network ACL access from your device to that tag
on TCP port 22. No repository secret or OAuth client secret is used.
The client must be connected to the relevant Tailscale network with MagicDNS
access. The Rust tool uses ordinary OpenSSH and does not invoke the local
Tailscale CLI, inspect Tailscale status, or use a local Tailscale socket.

## Use

`cargo devspace` has exactly four commands:

```console
cargo devspace start --duration 240 --cores 16
cargo devspace list
cargo devspace ssh RUN_ID
cargo devspace stop RUN_ID
```

`start` generates an ephemeral Ed25519 key, records it privately under
`${XDG_STATE_HOME:-$HOME/.local/state}/devspace` (using XDG_STATE_HOME only when
it is a nonempty absolute path), dispatches the workflow, and
prints the exact run ID and URL. It does not wait for readiness or cancel the
runner. `ssh` repeatedly probes the deterministic MagicDNS hostname
`cgwalters-devspace-RUN_ID` while the workflow is active, then opens interactive
OpenSSH with that key. `stop` acts only on the given development run and removes
its local key after cancellation or after confirming that the run has already
completed. `list` shows active dispatched-run metadata: run ID, status, title,
and URL.

The duration choices are 30, 60, 120, and 240 minutes (the default); the
workflow's 270-minute timeout allows setup plus the full four-hour lifetime.
Use `--cores 4`, `--cores 16` (the default), or `--cores 64` to select a runner
size. The runner is disposable: do not store secrets on it.
`runner-sizes.json` records the corresponding runner labels.

If dispatch cannot be correlated, the CLI retains the pending private key and
identifies its session so the run can be located manually.

The workflow runs stock `sshd.service`, binds it only to the Tailscale IPv4
address, and enforces a public-key-only configuration. Its keepalive verifies
the service, SELinux context, and bound address every five seconds.

SSH sessions run as `runner-sandbox`, which has no sudo, so builds and tests
started over SSH can't reach the job's credentials. Every workflow step runs as
`runner`, which has passwordless sudo, and the running steps' environments hold
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`; with it, any process of that user could mint
the GitHub OIDC tokens the Tailscale login trusts.
`scripts/setup-runner-sandbox.mjs` creates `runner-sandbox` (in the `kvm` group
and with subordinate IDs, so rootless podman and KVM work; not in `libvirt`,
whose `qemu:///system` access is root-equivalent). That uid separation is the
boundary; otherwise the stock runner setup stays, except for real exposures of
an image built with umask 000: the runner's credentials are world-readable (so
its home directory and `/opt/hca` become private), and system files root loads
code from, such as polkit rules, are world-writable (so world write permission
is removed). `/etc/environment` also loses its `XDG_RUNTIME_DIR`, which pointed
every login at runner's runtime directory.

On top of that, once setup is done nothing needs root any more, so before
OpenSSH starts every setuid and setgid program loses that bit, sudo included
(rootless podman's `newuidmap` and `newgidmap` use file capabilities instead,
which stay). The
long-running keepalive step re-executes itself without the request token, so
the Tailscale login is its one use (`tailscaled`, which the Tailscale action
starts with `sudo -E`, still has it in its environment, readable only by root),
`ptrace_scope` is 1, Cockpit is off, and `runner-sandbox` can't reach the cloud
metadata service. The Tailscale action's logout at the end of the job fails for
lack of sudo, which is harmless: its node is ephemeral.
Rootless VMs (`bcvk ephemeral`, `qemu:///session`) work; anything that needs
root must run inside a VM. The toolchain in `packages.txt` is installed before
OpenSSH starts, since sessions can't install packages themselves.

The runner hosts [cgwalters-bot](https://github.com/cgwalters-bot) agent
sessions. Before OpenSSH is made available, it automatically installs the bot's
[homegit](https://github.com/cgwalters-bot/homegit) dotfiles, skills, and agent
configuration for `runner-sandbox`. Because the runner executes homegit code, it is
pinned to the commit in the `Justfile`'s `homegit_rev`, which Renovate bumps through
reviewed pull requests. The checkout is created at
`$HOME/src/github/cgwalters-bot/homegit` when absent, and existing checkouts
are moved to the pinned commit, fetching it if needed. Interactive users on the
devspace therefore get the bot's git identity from its `.gitconfig`.

The opencode and Claude Code agent CLIs are preinstalled globally with npm
(from the RHEL `nodejs` package). Their exact versions are pinned in `npm.txt`,
which Renovate keeps current via the shared bootc-dev configuration. The
GitHub CLI, which the bot's tools call for every GitHub operation, comes from
EPEL. Agent credentials are not provisioned, so `gh` is not logged in.

## Agent runs

`.github/workflows/agent.yml` runs an agent CLI on one task, unattended, as
the same unprivileged `runner-sandbox` user, in its own `agent.slice`
(`scripts/agent-lib.mjs`). The job has no `id-token` permission and no
secrets. `scripts/agent-isolation-check.mjs` verifies before every run that
the agent can't use sudo, read the job's environment or files, or reach the
cloud metadata service, also from a container on the host network. Its
network access is otherwise open for now; the plan is a proxy that sees
requests and allows writes (`POST` and the like) only to known endpoints.

Devspaces and agent runs are for public repositories only: their logs and
transcripts are public. `scripts/public-repo.mjs` refuses a target that
GitHub doesn't confirm is public, failing closed, before anything is cloned
and again before anything is uploaded (`scripts/check-uploads.mjs`).

The condensed transcript streams into the job log in an `agent (condensed)`
group, a summary table goes to the step summary, and the `agent-run` (90
days) and `agent-transcript` (30 days) artifacts hold the rest, redacted by
`agent/redact.mjs` and checked for anything secret-shaped before upload. The
files and the dispatch inputs follow the
[agent runs contract](https://github.com/cgwalters-bot/homegit/blob/main/docs/devspace-agent-runs.md),
and homegit's `bot-runs` dispatches and reads the runs.

Inference is a mock for now: `agent/mock-model.py` serves the Messages API
locally and replays `agent/mock-conversation.json`, so a run needs no
credentials.

The `harness` input picks how the agent is driven. `cli`, the default, runs
Claude Code through its own CLI. `acp` runs `bot-harness` (`harness/`), a
client of the [Agent Client Protocol](https://agentclientprotocol.com) on
the `agent-client-protocol` crate, so no agent is hardcoded: it starts any
agent in `harness/agents.toml` (Claude Code through its ACP adapter, or
opencode) as `runner-sandbox`. It records the protocol stream, both
directions, as `acp.jsonl` in the transcript, answers the agent's permission
requests from `harness/policy.toml` (recording each decision and its rule),
and cancels the session at the timeout or when the agent goes over budget:
the cost it reports, or a number of tool calls. `bot-harness summary` then
writes `summary.json` from the recording, so both agents give the same
summary. With the mock, opencode gets a `mock` provider using the AI SDK's
Anthropic client. The harness lives here, next to `agent.yml`, until the
[task harness design](https://gist.github.com/cgwalters-bot/290d1fbd3545e430f7717948caab260f)
settles where tasks and their tools belong.

## TODO / roadmap

- Move the `runner-sandbox` setup into
  [bootc-dev/actions](https://github.com/bootc-dev/actions)' `bootc-host-setup`
  action, on by default, so CI jobs get the same unprivileged user.
- Align `packages.txt` with what `bootc-ubuntu-setup` installs, or switch to a
  devcontainer with the podman socket mounted in.
- Later, support launching an agent that can work autonomously and push changes
  with safe, scoped credentials, while preserving interactive access.
