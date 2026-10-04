// @vitest-environment node

import { describe, expect, it } from "vitest";

import { formatSshCommand } from "./ssh-command.js";

describe("formatSshCommand", () => {
  const identityPath = "~/.ssh/sliver-gui/test1";

  it.each([
    [{ username: "ubuntu", host: "44.240.136.251", port: 22 }, "ssh -i ~/.ssh/sliver-gui/test1 -p 22 ubuntu@44.240.136.251"],
    [{ username: "operator", host: "10.0.0.42", port: 2222 }, "ssh -i ~/.ssh/sliver-gui/test1 -p 2222 operator@10.0.0.42"],
    [{ username: "root", host: "2001:db8::1", port: 22 }, "ssh -i ~/.ssh/sliver-gui/test1 -p 22 root@2001:db8::1"],
    [{ username: "service$", host: "192.0.2.20", port: 22 }, "ssh -i ~/.ssh/sliver-gui/test1 -p 22 -l service$ -- 192.0.2.20"],
  ] as const)("formats a paste-ready command for %o", (target, expected) => {
    expect(formatSshCommand(target, identityPath)).toBe(expected);
  });

  it.each([
    { username: "operator;touch-pwned", host: "192.0.2.20", port: 22 },
    { username: "operator", host: "example.test", port: 22 },
    { username: "operator", host: "192.0.2.20;touch-pwned", port: 22 },
    { username: "operator", host: "192.0.2.20", port: 0 },
    { username: "operator", host: "192.0.2.20", port: 65_536 },
  ])("refuses shell-active or invalid endpoint data for %o", (target) => {
    expect(() => formatSshCommand(target, identityPath)).toThrow("SSH command target is invalid");
  });

  it.each([
    "~/.ssh/sliver-gui/test 1",
    "~/.ssh/sliver-gui/../../id_ed25519",
    "~/.ssh/sliver-gui/.",
    "~/.ssh/sliver-gui/..",
    "/tmp/operator-key",
    "~/.ssh/sliver-gui/test1;touch-pwned",
  ])("refuses an identity path outside the main-owned safe command namespace: %s", (path) => {
    expect(() => formatSshCommand(
      { username: "ubuntu", host: "192.0.2.20", port: 22 },
      path,
    )).toThrow("SSH command target is invalid");
  });
});
