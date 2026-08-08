import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SavedConfigSelector } from "./SavedConfigSelector";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const CONFIGS = [
  {
    id: "config-one",
    fileName: "/Users/example/.sliver-client/configs/red-team.cfg",
    displayName: "Red team",
    operator: "alice",
    lhost: "c2.example.test",
    lport: 31337,
    transport: "mtls" as const,
    modifiedAt: "2026-08-08T12:00:00.000Z",
  },
  {
    id: "config-two",
    fileName: "wireguard.cfg",
    displayName: "Field operator",
    operator: "bob",
    lhost: "2001:db8::8",
    lport: 51820,
    transport: "wireguard" as const,
    modifiedAt: "2026-08-07T12:00:00.000Z",
  },
];

function renderSelector(overrides: Partial<React.ComponentProps<typeof SavedConfigSelector>> = {}) {
  const props: React.ComponentProps<typeof SavedConfigSelector> = {
    isOpen: true,
    configs: CONFIGS,
    onChooseFile: vi.fn(),
    onConnect: vi.fn(),
    onOpenChange: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
  return { ...render(<SavedConfigSelector {...props} />), props };
}

describe("SavedConfigSelector", () => {
  it("shows operator and connection metadata without exposing a source path", () => {
    renderSelector();

    expect(screen.getByRole("dialog", { name: "Connect to Sliver" })).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("red-team.cfg")).toBeInTheDocument();
    expect(screen.getByText("c2.example.test:31337")).toBeInTheDocument();
    expect(screen.getByText("WireGuard")).toBeInTheDocument();
    expect(screen.queryByText(/Users\/example/)).not.toBeInTheDocument();
  });

  it("uses the selected saved configuration for the primary action", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    renderSelector({ onConnect });

    await user.click(screen.getByRole("option", { name: /bob/i }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith(CONFIGS[1]);
  });

  it("keeps refresh and native file import as distinct actions", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onChooseFile = vi.fn();
    renderSelector({ onChooseFile, onRefresh });

    await user.click(screen.getByRole("button", { name: "Refresh saved configurations" }));
    await user.click(screen.getByRole("button", { name: "Choose configuration file" }));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onChooseFile).toHaveBeenCalledOnce();
  });

  it("renders loading, error, and empty states", () => {
    const { rerender, props } = renderSelector({ configs: [], isLoading: true });
    expect(screen.getByText("Finding configurations")).toBeInTheDocument();

    rerender(<SavedConfigSelector {...props} configs={[]} isLoading={false} />);
    expect(screen.getByText("No saved configurations")).toBeInTheDocument();

    rerender(
      <SavedConfigSelector
        {...props}
        configs={[]}
        error="Configuration directory could not be read"
        isLoading={false}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Configuration directory could not be read");
    expect(screen.getByText("Couldn't load configurations")).toBeInTheDocument();
    expect(screen.queryByText("No saved configurations")).not.toBeInTheDocument();
  });
});
