import { describe, expect, it } from "vitest";

import {
  parseManagedSshTarget,
  parseSshAttachRequest,
  parseSshDeploymentInput,
  parseSshHostKeyReview,
  parseSshOpenTabResult,
  parseSshTabRenameInput,
  parseSshTabRenameResult,
  parseSshWindowLaunchContext,
  SSH_PROTOCOL_VERSION,
  SSH_TAB_LABEL_MAX_LENGTH,
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
const azureTarget = {
  ...target,
  name: "azure-control",
  provider: "azure" as const,
  host: "203.0.113.42",
  username: "azureuser",
};

describe("SSH contracts", () => {
  it("parses exact renderer-safe targets and deployment-only requests", () => {
    expect(parseSshDeploymentInput({ deploymentId })).toEqual({ deploymentId });
    expect(parseManagedSshTarget(target)).toEqual(target);
    expect(parseManagedSshTarget({ ...target, port: 2_222 })).toMatchObject({
      provider: "aws",
      port: 2_222,
    });
    expect(parseManagedSshTarget(azureTarget)).toEqual(azureTarget);
    expect(() => parseManagedSshTarget({ ...azureTarget, port: 2_222 })).toThrow(
      "managed Azure SSH target port must be 22",
    );
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
      tabs: [{ tabId, attachmentToken, label: target.name, target }],
      activeTabId: tabId,
    };
    expect(parseSshWindowLaunchContext(context)).toEqual(context);
    expect(() => parseSshWindowLaunchContext({
      ...context,
      tabs: [{ ...context.tabs[0], label: "\u200b" }],
    })).toThrow("label");
    expect(() => parseSshWindowLaunchContext({ ...context, activeTabId: "z".repeat(43) }))
      .toThrow("unavailable");
    expect(() => parseSshWindowLaunchContext({ ...context, tabs: [...context.tabs, ...context.tabs] }))
      .toThrow("duplicated");
  });

  it("parses exact bounded tab rename requests and results", () => {
    const input = { tabId, label: "Production shell" };
    expect(parseSshTabRenameInput(input)).toEqual(input);
    expect(parseSshTabRenameResult(input)).toEqual(input);

    expect(() => parseSshTabRenameInput({ ...input, target: "unexpected" })).toThrow("invalid shape");
    expect(() => parseSshTabRenameInput({ ...input, label: " padded " })).toThrow("label");
    expect(() => parseSshTabRenameInput({ ...input, label: "bad\nlabel" })).toThrow("label");
    expect(() => parseSshTabRenameInput({ ...input, label: "\u200b" })).toThrow("label");
    expect(() => parseSshTabRenameInput({ ...input, label: "left\u061cright" })).toThrow("label");
    expect(() => parseSshTabRenameInput({ ...input, label: "left\u200eright" })).toThrow("label");
    expect(() => parseSshTabRenameInput({ ...input, label: "left\u200fright" })).toThrow("label");
    expect(() => parseSshTabRenameInput({ ...input, label: "left\u202eright" })).toThrow("label");
    expect(() => parseSshTabRenameInput({ ...input, label: "x".repeat(SSH_TAB_LABEL_MAX_LENGTH + 1) }))
      .toThrow("label");
    expect(() => parseSshTabRenameResult({ tabId, label: "" })).toThrow("label");
    expect(() => parseSshTabRenameResult({ ...input, target: "unexpected" })).toThrow("invalid shape");
    expect(() => parseManagedSshTarget({ ...target, name: "\u200b" })).toThrow("name");
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
