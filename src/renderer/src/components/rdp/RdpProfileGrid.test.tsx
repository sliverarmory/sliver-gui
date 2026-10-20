import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpProfile } from "../../../../shared/rdp-contracts";
import { renderWithApplicationContextMenu } from "../../application-context-menu-test-utils";
import { RdpProfileGrid } from "./RdpProfileGrid";

const profile: RdpProfile = {
  id: "office", label: "Office", host: "office.test", port: 3389, username: "operator", domain: "LAB",
  width: 1280, height: 800, clipboard: false, scaleMode: "fit", hasCredential: true, credentialPersistence: "secure",
};
const secondProfile: RdpProfile = { ...profile, id: "home", label: "Home", host: "home.test" };

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function mount(disabled = false) {
  const callbacks = { onConnect: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() };
  const view = renderWithApplicationContextMenu(<RdpProfileGrid profiles={[profile, secondProfile]} tabs={[]} disabled={disabled} {...callbacks} />);
  return { ...view, ...callbacks };
}

describe("saved RDP connection card actions", () => {
  it("connects on click and keyboard activation while keeping the delete button separate", async () => {
    const user = userEvent.setup();
    const view = mount();
    const connect = screen.getByRole("button", { name: "Connect to Office" });
    await user.click(connect);
    expect(view.onConnect).toHaveBeenCalledExactlyOnceWith(profile);
    connect.focus();
    await user.keyboard("{Enter}");
    expect(view.onConnect).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Delete Office" }));
    expect(view.onDelete).toHaveBeenCalledExactlyOnceWith(profile);
    expect(view.onConnect).toHaveBeenCalledTimes(2);
    expect(view.onEdit).not.toHaveBeenCalled();
  });

  it.each(["Connect", "Edit", "Delete"] as const)("runs %s for the right-clicked profile only", async (action) => {
    const user = userEvent.setup();
    const view = mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Connect to Home" }));
    view.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Connect", "Edit", "Delete", "Inspect Element"]);
    await user.click(within(menu).getByRole("menuitem", { name: action }));
    const callback = { Connect: view.onConnect, Edit: view.onEdit, Delete: view.onDelete }[action];
    await waitFor(() => expect(callback).toHaveBeenCalledExactlyOnceWith(secondProfile));
    for (const other of [view.onConnect, view.onEdit, view.onDelete].filter((candidate) => candidate !== callback)) expect(other).not.toHaveBeenCalled();
    expect(view.contextMenu.api.executeAction).not.toHaveBeenCalled();
  });

  it("applies the profile menu to the delete button and filters irrelevant native actions", async () => {
    const view = mount();
    const button = screen.getByRole("button", { name: "Delete Office" });
    expect(button.closest("[data-application-context-menu-policy]")).toHaveAttribute("data-application-context-menu-policy", "inspect-only");
    fireEvent.contextMenu(button);
    view.contextMenu.emit([
      { type: "action", actionId: "10000000-0000-4000-8000-000000000001", kind: "select-all", label: "Select All", enabled: true },
      { type: "action", actionId: "10000000-0000-4000-8000-000000000002", kind: "inspect", label: "Inspect Element", enabled: true },
    ]);
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Edit" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Inspect Element" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Select All" })).not.toBeInTheDocument();
    expect(view.onDelete).not.toHaveBeenCalled();
  });

  it("keeps the card focusable and Edit/Delete available when only connecting is disabled", async () => {
    const user = userEvent.setup();
    const view = mount(true);
    const connect = screen.getByRole("button", { name: "Connect to Office" });
    expect(connect).toHaveAttribute("aria-disabled", "true");
    expect(connect).not.toBeDisabled();
    await user.tab();
    expect(connect).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(connect);
    expect(view.onConnect).not.toHaveBeenCalled();
    fireEvent.contextMenu(connect);
    view.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Connect" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Edit" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).not.toHaveAttribute("aria-disabled", "true");
    await user.click(within(menu).getByRole("menuitem", { name: "Edit" }));
    await waitFor(() => expect(view.onEdit).toHaveBeenCalledExactlyOnceWith(profile));
    await user.click(screen.getByRole("button", { name: "Delete Office" }));
    expect(view.onDelete).toHaveBeenCalledExactlyOnceWith(profile);
    expect(view.onConnect).not.toHaveBeenCalled();
  });
});
