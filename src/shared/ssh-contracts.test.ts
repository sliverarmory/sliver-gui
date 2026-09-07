import { describe, expect, it } from "vitest";

import {
  parseManagedSshTarget,
  parseSshAttachRequest,
  parseSshDeploymentInput,
  parseSshHostKeyReview,
  parseSshOpenTabResult,
  parseSshWindowLaunchContext,
  SSH_PROTOCOL_VERSION,
} from "./ssh-contracts.js";

const deploymentId = "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0001";
const tabId = "a".repeat(43);
const attachmentToken = "b".repeat(43);

const target = {
  deploymentId,
  name: "test1",
  provider: "aws" as const,
  host: "44.240.136.251",
  port: 22,
  username: "ubuntu",
  status: "running" as const,
  connectable: true,
};

describe("SSH contracts", () => {
  it("parses exact renderer-safe targets and deployment-only requests", () => {
    expect(parseSshDeploymentInput({ deploymentId })).toEqual({ deploymentId });
    expect(parseManagedSshTarget(target)).toEqual(target);
    expect(() => parseSshDeploymentInput({ deploymentId, host: target.host })).toThrow("invalid shape");
    expect(() => parseManagedSshTarget({ ...target, privateKey: "secret" })).toThrow("invalid shape");
  });

  it("requires an unavailable reason for non-connectable targets", () => {
    expect(parseManagedSshTarget({
      ...target,
      host: "",
      status: "stopped",
      connectable: false,
      unavailableReason: "Start the managed server before connecting.",
    })).toMatchObject({ host: "", connectable: false });
    expect(() => parseManagedSshTarget({ ...target, connectable: false })).toThrow("reason");
    expect(() => parseManagedSshTarget({ ...target, unavailableReason: "unexpected" })).toThrow("reason");
  });

  it("parses one-use attachment capabilities", () => {
    expect(parseSshAttachRequest({
      v: SSH_PROTOCOL_VERSION,
      attachmentToken,
    })).toEqual({ v: SSH_PROTOCOL_VERSION, attachmentToken });
    expect(() => parseSshAttachRequest({ v: 2, attachmentToken })).toThrow("unsupported");
  });

  it("parses a bounded multi-tab launch context and validates the active tab", () => {
    const context = {
      kind: "ssh" as const,
      shortcutModifier: "Command" as const,
      tabs: [{ tabId, attachmentToken, target }],
      activeTabId: tabId,
    };
    expect(parseSshWindowLaunchContext(context)).toEqual(context);
    expect(() => parseSshWindowLaunchContext({ ...context, activeTabId: "z".repeat(43) }))
      .toThrow("unavailable");
    expect(() => parseSshWindowLaunchContext({ ...context, tabs: [...context.tabs, ...context.tabs] }))
      .toThrow("duplicated");
  });

  it("parses explicit host-key reviews without accepting arbitrary fingerprints", () => {
    const review = {
      token: "c".repeat(43),
      deploymentId,
      name: "test1",
      host: target.host,
      port: 22,
      fingerprint: `SHA256:${"A".repeat(43)}`,
      expiresAt: "2026-09-07T19:00:00.000Z",
    };
    expect(parseSshHostKeyReview(review)).toEqual(review);
    expect(parseSshOpenTabResult({ status: "host-key-review", review })).toEqual({
      status: "host-key-review",
      review,
    });
    expect(() => parseSshHostKeyReview({ ...review, fingerprint: "SHA256:not-valid" }))
      .toThrow("fingerprint");
  });
});
