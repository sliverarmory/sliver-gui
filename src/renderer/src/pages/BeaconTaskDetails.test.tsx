import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { OperationResult, SliverDesktopAPI } from "../../../shared/contracts";
import type { BeaconTaskResponse, BeaconTaskSummary } from "../../../shared/operation-contracts";
import { BeaconTaskDetails } from "./BeaconTaskDetails";

const task: BeaconTaskSummary = {
  taskId: "00000000-0000-4000-8000-000000000001",
  beaconId: "beacon-1",
  state: "completed",
  description: "FutureTaskReq",
  resultAvailable: true,
  cancellation: { available: false },
  ownership: { origin: "external", actor: { attribution: "unknown" } },
};

function response(text: string, overrides: Partial<BeaconTaskResponse> = {}): OperationResult<BeaconTaskResponse> {
  return { ok: true, value: {
    taskId: task.taskId, beaconId: task.beaconId, format: "text", text, offset: 0, totalCharacters: text.length, ...overrides,
  } };
}

function deferred() {
  let resolve!: (result: OperationResult<BeaconTaskResponse>) => void;
  const promise = new Promise<OperationResult<BeaconTaskResponse>>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function setup(getBeaconTaskResponse = vi.fn<SliverDesktopAPI["getBeaconTaskResponse"]>(), description = task.description) {
  vi.stubGlobal("sliver", { getBeaconTaskResponse });
  return { ...render(<BeaconTaskDetails task={{ ...task, description }} />), getBeaconTaskResponse };
}

function renderedText(): string | null | undefined {
  return screen.getByRole("region", { name: "Full task output" }).querySelector("pre")?.textContent;
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterEach(cleanup);
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("BeaconTaskDetails", () => {
  it("loads only on open and renders exact complete text with the GUID inside the wide modal", async () => {
    const user = userEvent.setup();
    const text = `  preserved whitespace\r\n${"x".repeat(4_096)}\n<script>literal output</script>\nfull response tail  `;
    const { getBeaconTaskResponse } = setup(vi.fn().mockResolvedValue(response(text)));
    expect(getBeaconTaskResponse).not.toHaveBeenCalled();
    expect(screen.queryByText(task.taskId)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "Task details" });
    expect(within(dialog).getByText("Task GUID")).toBeVisible();
    expect(within(dialog).getByText(task.taskId)).toBeVisible();
    await waitFor(() => expect(renderedText()).toBe(text));
    expect(dialog.querySelector("script")).toBeNull();
    expect(getBeaconTaskResponse).toHaveBeenCalledExactlyOnceWith({ taskId: task.taskId, offset: 0 });
    await user.click(within(dialog).getByRole("button", { name: /^Close$/u }));
    expect(screen.queryByRole("region", { name: "Full task output" })).not.toBeInTheDocument();
    expect(screen.queryByText(task.taskId)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByRole("region", { name: "Full task output" });
    expect(getBeaconTaskResponse).toHaveBeenCalledTimes(2);
  });

  it("automatically assembles transport pages and renders full file contents without JSON or character paging", async () => {
    const user = userEvent.setup();
    const file = `first line\n${"whole file line\n".repeat(6000)}LAST FILE LINE\n`;
    const json = JSON.stringify({ Path: "/tmp/example.txt", Data: { encoding: "utf-8", bytes: file.length, data: file } });
    const split = 65_536;
    const { getBeaconTaskResponse } = setup(vi.fn().mockImplementation(async ({ offset }) =>
      offset === split
        ? response(json.slice(split), { format: "json", offset: split, totalCharacters: json.length })
        : response(json.slice(0, split), { format: "json", totalCharacters: json.length, nextOffset: split })
    ), "DownloadReq");
    await user.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(renderedText()).toBe(file));
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Characters .* of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"encoding"/)).not.toBeInTheDocument();
    expect(screen.getByText("/tmp/example.txt")).toBeVisible();
    expect(getBeaconTaskResponse.mock.calls).toEqual([
      [{ taskId: task.taskId, offset: 0 }], [{ taskId: task.taskId, offset: split }],
    ]);
  });

  it.each(["failure", "rejection"])("offers retry after a response %s", async (failure) => {
    const user = userEvent.setup();
    const getBeaconTaskResponse = vi.fn<SliverDesktopAPI["getBeaconTaskResponse"]>();
    if (failure === "failure") getBeaconTaskResponse.mockResolvedValueOnce({ ok: false, error: "No response is available yet." });
    else getBeaconTaskResponse.mockRejectedValueOnce(new Error("No response is available yet."));
    getBeaconTaskResponse.mockResolvedValueOnce(response("ready"));
    setup(getBeaconTaskResponse);
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No response is available yet.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(renderedText()).toBe("ready"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    { taskId: "another-task" }, { beaconId: "another-beacon" }, { offset: 5 },
  ])("rejects response identity mismatch %j", async (overrides) => {
    const user = userEvent.setup();
    setup(vi.fn().mockResolvedValue(response("unrelated output", overrides)));
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The server returned a response for a different task or page.");
    expect(screen.queryByText("unrelated output")).not.toBeInTheDocument();
  });

  it.each([
    { totalCharacters: 10, offset: 5 },
    { totalCharacters: 11, offset: 5, format: "hex" as const },
    { totalCharacters: 11, offset: 5, nextOffset: 5 },
  ])("refuses inconsistent later pages instead of rendering incomplete output %j", async (overrides) => {
    const user = userEvent.setup();
    setup(vi.fn().mockResolvedValueOnce(response("first", { totalCharacters: 11, nextOffset: 5 }))
      .mockResolvedValueOnce(response("second", overrides)));
    await user.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("region", { name: "Full task output" })).not.toBeInTheDocument();
  });

  it("ignores a late response after dismissal and reopening", async () => {
    const user = userEvent.setup();
    const stale = deferred();
    const fresh = deferred();
    const { getBeaconTaskResponse } = setup(vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise));
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading task output…");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    await act(async () => stale.resolve(response("stale response")));
    expect(screen.queryByText("stale response")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading task output…");
    await act(async () => fresh.resolve(response("fresh response")));
    expect(renderedText()).toBe("fresh response");
    expect(getBeaconTaskResponse).toHaveBeenCalledTimes(2);
  });

  it("stops loading more pages when the target workspace unmounts", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const { unmount, getBeaconTaskResponse } = setup(vi.fn().mockReturnValue(pending.promise));
    await user.click(screen.getByRole("button", { name: "Details" }));
    unmount();
    await act(async () => pending.resolve(response("obsolete", { totalCharacters: 16, nextOffset: 8 })));
    expect(getBeaconTaskResponse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("obsolete")).not.toBeInTheDocument();
  });
});
