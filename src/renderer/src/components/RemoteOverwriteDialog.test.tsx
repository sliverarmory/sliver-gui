import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRendererTestEnvironment } from "../../../tests/renderer-test-helpers";

import type { TextEditorRemoteOverwriteRequest } from "../../../shared/text-editor-contracts";
import { RemoteOverwriteDialog } from "./RemoteOverwriteDialog";

const request: TextEditorRemoteOverwriteRequest = {
  requestId: "00000000-0000-4000-8000-000000000001",
  path: "/tmp/remote.txt",
  target: {
    name: "remote-session",
    hostname: "remote-host",
    sessionId: "session-1",
    backend: { id: "backend-1", displayName: "Production" },
  },
  originalSha256: "a".repeat(64),
  newSha256: "b".repeat(64),
  warning: "Remote overwrite warning.",
};

useRendererTestEnvironment();

afterEach(cleanup);

describe("RemoteOverwriteDialog", () => {
  it("treats a backdrop dismissal as cancellation and locks dismissal while responding", async () => {
    const onRespond = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <RemoteOverwriteDialog
        request={request}
        responseChoice={undefined}
        responseError={undefined}
        onRespond={onRespond}
      />,
    );
    const backdrop = document.querySelector<HTMLElement>('[data-slot="alert-dialog-backdrop"]');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);
    expect(onRespond).toHaveBeenCalledOnce();
    expect(onRespond).toHaveBeenCalledWith(false);

    onRespond.mockClear();
    view.rerender(
      <RemoteOverwriteDialog
        request={request}
        responseChoice={false}
        responseError={undefined}
        onRespond={onRespond}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Overwrite file" })).toBeDisabled();
  });
});
