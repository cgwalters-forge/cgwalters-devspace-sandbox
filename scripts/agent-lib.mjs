// Shared by the scripts that run and check the agent: running a command as
// runner-sandbox (scripts/runner-sandbox.mjs) in the agent's slice, and
// stopping all of it.
import { spawnSync } from "node:child_process";
import { SANDBOX_USER, asSandbox, sandboxCommand } from "./runner-sandbox.mjs";

// Everything the agent runs is in this slice, so the supervisor can kill
// it. A service in it can't move itself out, unlike processes under sudo,
// which stay in the calling step's cgroup. Not runner-sandbox.slice: a
// hyphen in a slice name nests it (under runner.slice).
export const AGENT_SLICE = "agent.slice";

// The argv that runs CMD as runner-sandbox in the agent's slice.
export function agentCommand(cmd, opts = {}) {
  return sandboxCommand(cmd, { ...opts, slice: AGENT_SLICE });
}

// Runs CMD as runner-sandbox in the agent's slice; returns {status, stdout}.
export function asAgent(cmd, opts = {}) {
  return asSandbox(cmd, { ...opts, slice: AGENT_SLICE });
}

// Stops everything the agent started: its slice, a user manager it may have
// started by enabling lingering, and stray processes of its uid.
export function killAgent() {
  for (const args of [["systemctl", "kill", "--signal=KILL", AGENT_SLICE], ["loginctl", "disable-linger", SANDBOX_USER],
    ["loginctl", "terminate-user", SANDBOX_USER], ["pkill", "-KILL", "-u", SANDBOX_USER]]) {
    spawnSync("sudo", args, { stdio: "ignore" });
  }
}
