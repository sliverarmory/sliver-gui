import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BeaconFullResponseModel } from "./beacon-full-response-model";
import { BeaconFullResponse } from "./BeaconFullResponse";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

function show(sections: BeaconFullResponseModel["sections"]) {
  return render(<BeaconFullResponse model={{ title: "Task result", sections }} />);
}

describe("BeaconFullResponse", () => {
  it("omits repeated task headings while retaining distinct sections and accessible output labels", () => {
    render(<BeaconFullResponse hideTaskTitle model={{ title: "File contents", sections: [
      { kind: "text", title: "File contents", text: "complete file" },
      { kind: "fields", title: "Response details", fields: [{ label: "Path", value: "/tmp/file.txt" }] },
    ] }} />);
    expect(screen.queryByRole("heading", { name: "File contents" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Response details" })).toBeVisible();
    const output = screen.getByRole("region", { name: "File contents" });
    expect(within(output).getByLabelText("File contents")).toHaveTextContent("complete file");
    expect(within(output).getByRole("button", { name: "Copy File contents" })).toBeVisible();
  });

  it("renders and copies complete file text with real lines and preserved whitespace", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const text = `  first line\r\n${"full text\n".repeat(600)}<script>literal text</script>\nlast line  `;
    show([{ kind: "text", title: "File contents", text }]);
    const section = screen.getByRole("region", { name: "File contents" });
    const output = within(section).getByLabelText("File contents");
    expect(output.tagName).toBe("PRE");
    expect(output.textContent).toBe(text);
    expect(output.textContent).not.toContain("\\n");
    expect(output.querySelector("script")).toBeNull();
    expect(screen.queryByText("encoding")).not.toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "Copy File contents" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    expect(await within(section).findByRole("status")).toHaveTextContent("File contents copied.");
  });

  it("renders stdout and stderr as independent complete text sections", () => {
    const stdout = `result\n${"x".repeat(4_100)}\nstdout tail`;
    const stderr = "warning\nsecond warning\n";
    show([
      { kind: "fields", title: "Process", fields: [{ label: "PID", value: "4321" }, { label: "Exit code", value: "1" }] },
      { kind: "text", title: "Standard output", text: stdout },
      { kind: "text", title: "Standard error", text: stderr },
    ]);
    expect(within(screen.getByRole("region", { name: "Standard output" })).getByLabelText("Standard output").textContent).toBe(stdout);
    expect(within(screen.getByRole("region", { name: "Standard error" })).getByLabelText("Standard error").textContent).toBe(stderr);
    expect(screen.getByText("PID").tagName).toBe("DT");
    expect(screen.getByText("4321").tagName).toBe("DD");
    expect(screen.queryByText("encoding")).not.toBeInTheDocument();
  });

  it("searches all rows beyond the compact preview and restores complete semantic paging", async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 301 }, (_, index) => [`file-${index}.txt`, String(index), index === 299 ? "last matching owner" : "alice"]);
    show([{ kind: "table", title: "Files", columns: ["Name", "Size", "Owner"], rows }]);
    const section = screen.getByRole("region", { name: "Files" });
    const table = within(section).getByRole("table", { name: "Files" });
    expect(within(table).getAllByRole("row")).toHaveLength(101);
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeVisible();
    expect(within(section).getByRole("status")).toHaveTextContent("1–100 of 301 rows");
    const filter = within(section).getByRole("searchbox", { name: "Filter Files" });
    await user.type(filter, "LAST MATCHING");
    expect(within(section).getByRole("cell", { name: "file-299.txt" })).toBeVisible();
    expect(within(section).getAllByRole("row")).toHaveLength(2);
    expect(within(section).getByRole("status")).toHaveTextContent("1–1 of 1 rows · 301 total");
    await user.clear(filter);
    await user.click(within(section).getByRole("button", { name: "Next" }));
    expect(within(section).getByRole("cell", { name: "file-100.txt" })).toBeVisible();
    await user.click(within(section).getByRole("button", { name: "Next" }));
    expect(within(section).getByRole("cell", { name: "file-299.txt" })).toBeVisible();
    await user.click(within(section).getByRole("button", { name: "Next" }));
    expect(within(section).getByRole("cell", { name: "file-300.txt" })).toBeVisible();
    expect(within(section).getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(within(section).getByRole("button", { name: "Previous" }));
    expect(within(section).getByRole("cell", { name: "file-200.txt" })).toBeVisible();
  });

  it("preserves long cell values and multiline fields without clipping their contents", () => {
    const longValue = `${"x".repeat(4_100)} visible tail\nsecond line`;
    show([
      { kind: "table", title: "Environment variables", columns: ["Name", "Value"], rows: [["LONG_VALUE", longValue]] },
      { kind: "fields", title: "Service", fields: [{ label: "Description", value: longValue }] },
    ]);
    expect(screen.getByRole("cell", { name: /visible tail/u }).textContent).toBe(longValue);
    expect(screen.getByText("Description").nextElementSibling?.textContent).toBe(longValue);
  });

  it("shows readable empty and no-match states", async () => {
    const user = userEvent.setup();
    show([
      { kind: "table", title: "Files", columns: ["Name"], rows: [["one-file"]] },
      { kind: "table", title: "Services", columns: ["Name"], rows: [] },
      { kind: "text", title: "Standard output", text: "" },
    ]);
    expect(screen.getByText("No entries were returned.")).toBeVisible();
    expect(screen.getByText("No output was returned.")).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "Filter Files" }), "unmatched");
    expect(screen.getByText("No rows match this filter.")).toBeVisible();
    expect(screen.queryByRole("table", { name: "Files" })).not.toBeInTheDocument();
  });

  it("renders binary data as offsets, bytes, and ASCII with every byte available", async () => {
    const user = userEvent.setup();
    const hex = `414200ff${"20".repeat(4_092)}5441494c`;
    show([{ kind: "bytes", title: "File contents", hex }]);
    const section = screen.getByRole("region", { name: "File contents" });
    expect(within(section).getByLabelText("File contents hex view")).toHaveTextContent("00000000 41 42 00 ff");
    expect(within(section).getByLabelText("File contents hex view")).toHaveTextContent("AB..");
    expect(within(section).getByRole("status")).toHaveTextContent("Bytes 1–4,096 of 4,100");
    await user.click(within(section).getByRole("button", { name: "Next" }));
    expect(within(section).getByLabelText("File contents hex view")).toHaveTextContent("00001000 54 41 49 4c TAIL");
    expect(within(section).getByRole("status")).toHaveTextContent("Bytes 4,097–4,100 of 4,100");
    expect(within(section).getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("keeps the response readable when copying is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard unavailable"));
    show([{ kind: "text", title: "Output", text: "kept output" }]);
    await user.click(screen.getByRole("button", { name: "Copy Output" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the output.");
    expect(within(screen.getByRole("region", { name: "Output" })).getByLabelText("Output")).toHaveTextContent("kept output");
  });
});
