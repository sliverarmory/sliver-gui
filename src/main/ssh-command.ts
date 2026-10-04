import { isIP } from "node:net";

import type { ManagedSshTarget } from "../shared/ssh-contracts.js";

const SSH_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]*[$]?$/u;
const SSH_IDENTITY_PATH_PATTERN = /^~\/\.ssh\/sliver-gui\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type SshCommandTarget = Pick<ManagedSshTarget, "host" | "port" | "username">;

/** Formats a paste-ready OpenSSH command from a main-owned managed target. */
export function formatSshCommand(target: SshCommandTarget, identityPath: string): string {
  if (
    !SSH_USERNAME_PATTERN.test(target.username) ||
    isIP(target.host) === 0 ||
    !Number.isSafeInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535 ||
    !SSH_IDENTITY_PATH_PATTERN.test(identityPath)
  ) {
    throw new TypeError("SSH command target is invalid");
  }

  // A trailing '$' is valid for AWS/Linux machine accounts, but the compact
  // user@host form would make `$@` shell-active. Keep it as a separate -l value.
  return target.username.endsWith("$")
    ? `ssh -i ${identityPath} -p ${target.port} -l ${target.username} -- ${target.host}`
    : `ssh -i ${identityPath} -p ${target.port} ${target.username}@${target.host}`;
}
