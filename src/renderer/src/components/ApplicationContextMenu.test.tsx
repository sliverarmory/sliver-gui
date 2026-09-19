import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { faCopy } from "@fortawesome/free-solid-svg-icons";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  APPLICATION_CONTEXT_MENU_VERSION,
  type ApplicationContextMenuAPI,
  type ApplicationContextMenuItem,
  type ApplicationContextMenuRequest,
} from "../../../shared/application-context-menu-contracts";
import {
  ApplicationContextMenu,
  ApplicationContextMenuScope,
  useApplicationContextMenuScope,
} from "./ApplicationContextMenu";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

afterEach(() => {
  cleanup();
});

describe("ApplicationContextMenu", () => {
  it("shows native edit actions and restores the captured selection before executing a capability", async () => {
    const user = userEvent.setup();
    let inputElement: HTMLInputElement | undefined;
    let focusAtExecution: Element | null = null;
    let selectionAtExecution: readonly [number | null, number | null] = [null, null];
    const contextMenu = mockContextMenuAPI(async () => {
      focusAtExecution = document.activeElement;
      selectionAtExecution = [
        inputElement?.selectionStart ?? null,
        inputElement?.selectionEnd ?? null,
      ];
      return true;
    });

    render(
      <ApplicationContextMenu api={contextMenu.api}>
        <label>
          Command
          <input defaultValue="copy this value" />
        </label>
      </ApplicationContextMenu>,
    );

    const input = screen.getByRole("textbox", { name: "Command" }) as HTMLInputElement;
    inputElement = input;
    input.focus();
    input.setSelectionRange(0, 4);
    const genuineEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 24,
    });
    input.dispatchEvent(genuineEvent);
    expect(genuineEvent.defaultPrevented).toBe(false);

    contextMenu.emit(request(REQUEST_ID_ONE, nativeEditItems()));

    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    await waitFor(() => expect(contextMenu.api.setOpen).toHaveBeenCalledWith({
      requestId: REQUEST_ID_ONE,
      open: true,
    }));
    expect(within(menu).getByRole("menuitem", { name: "Undo" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Paste" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Select All" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Inspect Element" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Copy" }));

    await waitFor(() => expect(contextMenu.api.executeAction).toHaveBeenCalledWith({
      requestId: REQUEST_ID_ONE,
      actionId: COPY_ACTION_ID,
    }));
    const execution = vi.mocked(contextMenu.api.executeAction).mock.results.at(-1)?.value;
    await expect(execution).resolves.toBe(true);
    await waitFor(() => {
      expect(focusAtExecution).toBe(input);
      expect(selectionAtExecution).toEqual([0, 4]);
    });
    expect(contextMenu.api.setOpen).not.toHaveBeenCalledWith({
      requestId: REQUEST_ID_ONE,
      open: false,
    });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Application context menu" })).not.toBeInTheDocument());
  });

  it("adds only the nearest matching scope's renderer actions before native actions", async () => {
    const user = userEvent.setup();
    const contextMenu = mockContextMenuAPI();
    const copyTargetId = vi.fn();
    const copyContainerId = vi.fn();

    render(
      <ApplicationContextMenu api={contextMenu.api}>
        <button type="button">Outside target</button>
        <ScopedContainer onCopyContainerId={copyContainerId}>
          <ScopedTarget onCopyTargetId={copyTargetId} />
        </ScopedContainer>
      </ApplicationContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Outside target" }), {
      clientX: 10,
      clientY: 12,
    });
    contextMenu.emit(request(REQUEST_ID_ONE, nativeEditItems()));
    let menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).queryByRole("menuitem", { name: "Copy target ID" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Application context menu" })).not.toBeInTheDocument());
    await waitFor(() => expect(contextMenu.api.setOpen).toHaveBeenCalledWith({
      requestId: REQUEST_ID_ONE,
      open: false,
    }));

    const scopedTarget = screen.getByRole("button", { name: "Scoped target" });
    scopedTarget.focus();
    fireEvent.contextMenu(scopedTarget, { clientX: 30, clientY: 32 });
    contextMenu.emit(request(REQUEST_ID_TWO, nativeEditItems()));
    menu = await screen.findByRole("menu", { name: "Application context menu" });

    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveAccessibleName("Copy target ID");
    expect(items[1]).toHaveAccessibleName("Undo");
    expect(within(menu).queryByRole("menuitem", { name: "Copy container ID" }))
      .not.toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Copy target ID" }));

    await waitFor(() => expect(copyTargetId).toHaveBeenCalledOnce());
    await waitFor(() => expect(contextMenu.api.setOpen).toHaveBeenCalledWith({
      requestId: REQUEST_ID_TWO,
      open: false,
    }));
    expect(copyContainerId).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(scopedTarget);
    expect(contextMenu.api.executeAction).not.toHaveBeenCalled();
  });

  it.each(["View details", "Start"])(
    "separates scoped action groups and dispatches %s without changing native action boundaries",
    async (selectedAction) => {
      const user = userEvent.setup();
      const contextMenu = mockContextMenuAPI();
      const viewDetails = vi.fn();
      const openSsh = vi.fn();
      const start = vi.fn();
      render(
        <ApplicationContextMenu api={contextMenu.api}>
          <ApplicationContextMenuScope actions={[
            { id: "details", label: "View details", separatorBefore: true, onAction: viewDetails },
            { id: "ssh", label: "SSH", onAction: openSsh },
            { id: "start", label: "Start", separatorBefore: true, onAction: start },
          ]}>
            <button type="button">Grouped target</button>
          </ApplicationContextMenuScope>
        </ApplicationContextMenu>,
      );

      fireEvent.contextMenu(screen.getByRole("button", { name: "Grouped target" }));
      contextMenu.emit(request(REQUEST_ID_ONE, nativeEditItems().slice(-1)));
      const menu = await screen.findByRole("menu", { name: "Application context menu" });
      const entries = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')];
      expect(entries.map((entry) => entry.getAttribute("role") === "separator"
        ? "separator"
        : entry.textContent)).toEqual([
        "View details",
        "SSH",
        "separator",
        "Start",
        "separator",
        "Inspect Element",
      ]);

      await user.click(within(menu).getByRole("menuitem", { name: selectedAction }));
      const expectedAction = selectedAction === "Start" ? start : viewDetails;
      const otherAction = selectedAction === "Start" ? viewDetails : start;
      await waitFor(() => expect(expectedAction).toHaveBeenCalledOnce());
      expect(otherAction).not.toHaveBeenCalled();
      expect(openSsh).not.toHaveBeenCalled();
      expect(contextMenu.api.executeAction).not.toHaveBeenCalled();
      expect(contextMenu.api.setOpen).toHaveBeenCalledWith({ requestId: REQUEST_ID_ONE, open: false });
    },
  );

  it("preserves Select All on an editable target after the main action completes", async () => {
    const user = userEvent.setup();
    const contextMenu = mockContextMenuAPI();
    render(
      <ApplicationContextMenu api={contextMenu.api}>
        <label>
          Editable value
          <input defaultValue="select this value" />
        </label>
      </ApplicationContextMenu>,
    );
    const input = screen.getByRole("textbox", { name: "Editable value" }) as HTMLInputElement;
    input.focus();
    input.setSelectionRange(3, 3);
    fireEvent.contextMenu(input);
    contextMenu.emit(request(REQUEST_ID_ONE, nativeEditItems()));

    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    await user.click(within(menu).getByRole("menuitem", { name: "Select All" }));

    await waitFor(() => expect(input.selectionStart).toBe(0));
    await waitFor(() => expect(input.selectionEnd).toBe(input.value.length));
  });

  it("can limit a terminal-like scope to the native Inspect Element action", async () => {
    const contextMenu = mockContextMenuAPI();
    render(
      <ApplicationContextMenu api={contextMenu.api}>
        <InspectOnlyTarget />
      </ApplicationContextMenu>,
    );

    fireEvent.contextMenu(screen.getByLabelText("Terminal canvas"), {
      clientX: 50,
      clientY: 52,
    });
    contextMenu.emit(request(REQUEST_ID_ONE, nativeEditItems()));

    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAccessibleName("Inspect Element");
    expect(within(menu).queryByRole("menuitem", { name: "Copy" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Paste" })).not.toBeInTheDocument();
  });

  it("contains failures from component-owned asynchronous actions", async () => {
    const user = userEvent.setup();
    const contextMenu = mockContextMenuAPI();
    const failingAction = vi.fn(async () => {
      throw new Error("expected scoped action failure");
    });

    render(
      <ApplicationContextMenu api={contextMenu.api}>
        <ScopedTarget onCopyTargetId={failingAction} />
      </ApplicationContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Scoped target" }));
    contextMenu.emit(request(REQUEST_ID_ONE, nativeEditItems()));
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    await user.click(within(menu).getByRole("menuitem", { name: "Copy target ID" }));

    await waitFor(() => expect(failingAction).toHaveBeenCalledOnce());
    await waitFor(() => expect(
      screen.queryByRole("menu", { name: "Application context menu" }),
    ).not.toBeInTheDocument());
  });

  it("revokes a visible native request when the provider unmounts", async () => {
    const contextMenu = mockContextMenuAPI();
    const rendered = render(
      <ApplicationContextMenu api={contextMenu.api}>
        <button type="button">Context target</button>
      </ApplicationContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Context target" }));
    contextMenu.emit(request(REQUEST_ID_ONE, nativeEditItems()));
    await screen.findByRole("menu", { name: "Application context menu" });
    await waitFor(() => expect(contextMenu.api.setOpen).toHaveBeenCalledWith({
      requestId: REQUEST_ID_ONE,
      open: true,
    }));

    rendered.unmount();

    await waitFor(() => expect(contextMenu.api.setOpen).toHaveBeenCalledWith({
      requestId: REQUEST_ID_ONE,
      open: false,
    }));
  });
});

function ScopedTarget({ onCopyTargetId }: { readonly onCopyTargetId: () => void }): React.JSX.Element {
  const contextMenuProps = useApplicationContextMenuScope({
    actions: [{
      id: "copy-target-id",
      label: "Copy target ID",
      icon: faCopy,
      shortcut: "C",
      onAction: onCopyTargetId,
    }],
  });
  return <button {...contextMenuProps} type="button">Scoped target</button>;
}

function ScopedContainer({
  children,
  onCopyContainerId,
}: {
  readonly children: React.ReactNode;
  readonly onCopyContainerId: () => void;
}): React.JSX.Element {
  const contextMenuProps = useApplicationContextMenuScope({
    actions: [{
      id: "copy-container-id",
      label: "Copy container ID",
      icon: faCopy,
      onAction: onCopyContainerId,
    }],
  });
  return <div {...contextMenuProps}>{children}</div>;
}

function InspectOnlyTarget(): React.JSX.Element {
  return (
    <div
      aria-label="Terminal canvas"
      data-application-context-menu-policy="inspect-only"
    />
  );
}

function mockContextMenuAPI(
  executeAction: ApplicationContextMenuAPI["executeAction"] = async () => true,
): {
  api: ApplicationContextMenuAPI;
  emit: (request: ApplicationContextMenuRequest) => void;
} {
  let listener: ((request: ApplicationContextMenuRequest) => void) | undefined;
  const api: ApplicationContextMenuAPI = {
    onMenuRequested: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
    executeAction: vi.fn().mockImplementation(executeAction),
    setOpen: vi.fn(async () => true),
  };
  return {
    api,
    emit: (nextRequest) => {
      if (!listener) throw new Error("Context-menu listener was not registered");
      act(() => listener?.(nextRequest));
    },
  };
}

function request(
  requestId: string,
  items: readonly ApplicationContextMenuItem[],
): ApplicationContextMenuRequest {
  return {
    v: APPLICATION_CONTEXT_MENU_VERSION,
    requestId,
    x: 40,
    y: 24,
    items,
  };
}

function nativeEditItems(): readonly ApplicationContextMenuItem[] {
  return [
    {
      type: "action",
      actionId: UNDO_ACTION_ID,
      kind: "undo",
      label: "Undo",
      enabled: false,
      shortcut: "mod+z",
    },
    {
      type: "action",
      actionId: COPY_ACTION_ID,
      kind: "copy",
      label: "Copy",
      enabled: true,
      shortcut: "mod+c",
    },
    {
      type: "action",
      actionId: PASTE_ACTION_ID,
      kind: "paste",
      label: "Paste",
      enabled: true,
      shortcut: "mod+v",
    },
    {
      type: "action",
      actionId: SELECT_ALL_ACTION_ID,
      kind: "select-all",
      label: "Select All",
      enabled: true,
      shortcut: "mod+a",
    },
    { type: "separator" },
    {
      type: "action",
      actionId: INSPECT_ACTION_ID,
      kind: "inspect",
      label: "Inspect Element",
      enabled: true,
    },
  ];
}

const REQUEST_ID_ONE = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID_TWO = "10000000-0000-4000-8000-000000000002";
const UNDO_ACTION_ID = "20000000-0000-4000-8000-000000000001";
const COPY_ACTION_ID = "20000000-0000-4000-8000-000000000002";
const PASTE_ACTION_ID = "20000000-0000-4000-8000-000000000003";
const SELECT_ALL_ACTION_ID = "20000000-0000-4000-8000-000000000004";
const INSPECT_ACTION_ID = "20000000-0000-4000-8000-000000000005";
