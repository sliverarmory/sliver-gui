import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { faBolt, faGear } from "@fortawesome/free-solid-svg-icons";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AppCommandPalette,
  type AppCommandPaletteCommand,
} from "./AppCommandPalette";

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

describe("AppCommandPalette", () => {
  it("searches and runs an enabled command", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(<PaletteHarness commands={commands(onGenerate)} shortcut="mod+k" />);

    await user.click(screen.getByRole("button", { name: "Open test palette" }));
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search commands" }), "implant");
    await user.click(screen.getByRole("menuitem", { name: /Generate/u }));

    expect(onGenerate).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());
  });

  it("does not run disabled commands and closes with Escape", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(<PaletteHarness commands={commands(onGenerate, true)} shortcut="mod+shift+p" />);

    await user.click(screen.getByRole("button", { name: "Open test palette" }));
    const generate = await screen.findByRole("menuitem", { name: /Generate/u });
    expect(generate).toHaveAttribute("aria-disabled", "true");
    await user.click(generate);
    expect(onGenerate).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());
  });
});

function PaletteHarness({
  commands: availableCommands,
  shortcut,
}: {
  readonly commands: readonly AppCommandPaletteCommand[];
  readonly shortcut: string;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>Open test palette</button>
      <AppCommandPalette
        commands={availableCommands}
        isOpen={isOpen}
        shortcut={shortcut}
        onOpenChange={setIsOpen}
      />
    </>
  );
}

function commands(onGenerate: () => void, disabled = false): readonly AppCommandPaletteCommand[] {
  return [
    {
      id: "navigate-generate",
      group: "Navigate",
      icon: faBolt,
      label: "Generate",
      description: "Create implant artifacts.",
      keywords: ["implant"],
      isDisabled: disabled,
      onAction: onGenerate,
    },
    {
      id: "navigate-settings",
      group: "Navigate",
      icon: faGear,
      label: "Settings",
      description: "Configure the app.",
      onAction: vi.fn(),
    },
  ];
}
