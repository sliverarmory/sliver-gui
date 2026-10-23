import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "@heroui/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BeagleAPI, BeagleState } from "../../../shared/beagle-contracts";
import { BeagleProjectPanel } from "./BeagleProjectPanel";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterAll(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(Element.prototype, "getAnimations"); });
afterEach(cleanup);
const state: BeagleState = { runtime: { available: true, version: "1", source: "test", operations: ["backup"] }, projects: [{ id: "11111111-1111-4111-8111-111111111111", name: "Lab", createdAt: "2026-10-23" }],
  selectedProjectId: "11111111-1111-4111-8111-111111111111", stats: null };
function setup(beforeAction: () => Promise<void> = vi.fn(async () => undefined), inProjectModal = false) {
  const api = { importFiles: vi.fn(async () => ({ ok: true, value: { state, report: {} } })), cleanup: vi.fn(async () => ({ ok: true, value: { state, report: {} } })),
    archiveProject: vi.fn(async () => ({ ok: true, value: state })), backupProject: vi.fn(async () => ({ ok: true, value: { cancelled: false } })) } as unknown as BeagleAPI;
  const callbacks = { onState: vi.fn(), onError: vi.fn(), onNotice: vi.fn(), onBusyChange: vi.fn() };
  const panel = <BeagleProjectPanel api={api} state={state} busy={false} beforeAction={beforeAction} {...callbacks} />;
  render(inProjectModal ? <Modal.Backdrop isOpen><Modal.Container placement="center" scroll="inside" size="lg"><Modal.Dialog>
    <Modal.Header><Modal.Heading>Project tools</Modal.Heading></Modal.Header><Modal.Body>{panel}</Modal.Body>
  </Modal.Dialog></Modal.Container></Modal.Backdrop> : panel);
  return { api, beforeAction, ...callbacks };
}
describe("BeagleProjectPanel", () => {
  it("requires a concrete replacement confirmation and waits for saved workspace before importing", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { api, onBusyChange } = setup(vi.fn(() => pending));
    fireEvent.change(screen.getByRole("combobox", { name: "Collection import mode" }), { target: { value: "replace" } });
    await userEvent.click(screen.getByRole("button", { name: "Choose collection files" }));
    expect(api.importFiles).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm replace" }));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(api.importFiles).not.toHaveBeenCalled();
    await act(async () => release());
    expect(api.importFiles).toHaveBeenCalledWith({ mode: "replace" });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("confirms cleanup scope and archive separately", async () => {
    const { api } = setup();
    fireEvent.change(screen.getByRole("combobox", { name: "Cleanup scope" }), { target: { value: "collected" } });
    await userEvent.click(screen.getByRole("button", { name: "Clean selected data" }));
    expect(api.cleanup).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm cleanup" }));
    expect(api.cleanup).toHaveBeenCalledWith({ scope: "collected" });
    await userEvent.click(screen.getByRole("button", { name: "Archive project" }));
    expect(api.archiveProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    expect(api.archiveProject).toHaveBeenCalledWith({ id: state.selectedProjectId });
  });
  it("does not create a backup after workspace persistence fails", async () => {
    const { api, onError, onBusyChange } = setup(vi.fn(async () => { throw new Error("Disk is full"); }));
    await userEvent.click(screen.getByRole("button", { name: "Back up project" }));
    expect(api.backupProject).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Disk is full");
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });
  it("opens confirmation above project tools and restores focus after Cancel or Escape without mutating data", async () => {
    const { api } = setup(undefined, true);
    const panel = screen.getByRole("region", { name: "Project management" });
    const archive = screen.getByRole("button", { name: "Archive project" });
    await userEvent.click(archive);
    const confirmation = screen.getByRole("alertdialog", { name: "Archive project?" });
    expect(panel).not.toContainElement(confirmation);
    expect(confirmation).toHaveTextContent("Its data stays available for recovery.");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Project tools" })).toBeInTheDocument();
    await waitFor(() => expect(archive).toHaveFocus());
    await userEvent.click(archive);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Project tools" })).toBeInTheDocument();
    expect(api.archiveProject).not.toHaveBeenCalled();
    expect(api.cleanup).not.toHaveBeenCalled();
    expect(api.importFiles).not.toHaveBeenCalled();
  });
});
