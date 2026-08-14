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
    origin: "preexisting" as const,
    removal: "detach" as const,
    availability: "available" as const,
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
    origin: "preexisting" as const,
    removal: "detach" as const,
    availability: "deferred" as const,
    unavailableReason: "WireGuard operator connections are deferred for this milestone",
  },
  {
    id: "config-three",
    fileName: "89c18203-c7d1-46b9-a088-cb59b70ce7f6.cfg",
    displayName: "Managed lab",
    operator: "charlie",
    lhost: "lab.example.test",
    lport: 8888,
    transport: "mtls" as const,
    modifiedAt: "2026-08-06T12:00:00.000Z",
    origin: "managed" as const,
    removal: "delete-managed-copy" as const,
    availability: "available" as const,
  },
];

function renderSelector(overrides: Partial<React.ComponentProps<typeof SavedConfigSelector>> = {}) {
  const props: React.ComponentProps<typeof SavedConfigSelector> = {
    isOpen: true,
    configs: CONFIGS,
    onChooseFile: vi.fn(),
    onConnect: vi.fn(),
    onImport: vi.fn(),
    onOpenChange: vi.fn(),
    onRefresh: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  return { ...render(<SavedConfigSelector {...props} />), props };
}

describe("SavedConfigSelector", () => {
  it("shows operator and connection metadata without exposing a source path", () => {
    renderSelector();

    expect(screen.getByRole("dialog", { name: "Saved configurations" })).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("red-team.cfg")).toBeInTheDocument();
    expect(screen.getByText("c2.example.test:31337")).toBeInTheDocument();
    expect(screen.getByText("WireGuard")).toBeInTheDocument();
    expect(screen.getByText("Deferred")).toBeInTheDocument();
    expect(screen.getByText("Imported")).toBeInTheDocument();
    expect(screen.queryByText(/Users\/example/)).not.toBeInTheDocument();
  });

  it("uses the selected saved configuration for the primary action", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    renderSelector({ onConnect });

    await user.click(screen.getByRole("option", { name: /charlie/i }));
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith(CONFIGS[2]);
  });

  it("does not submit an opaque config ID while the catalog is refreshing", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    renderSelector({ isLoading: true, onConnect });

    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("keeps refresh, managed import, and one-off external selection distinct", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onChooseFile = vi.fn();
    const onImport = vi.fn();
    renderSelector({ onChooseFile, onImport, onRefresh });

    await user.click(screen.getByRole("button", { name: "Refresh saved configurations" }));
    await user.click(screen.getByRole("button", { name: "Connect external file" }));
    await user.click(screen.getByRole("button", { name: "Import a copy" }));
    await user.type(screen.getByRole("textbox", { name: "Local configuration name" }), "  Production west  ");
    await user.click(screen.getByRole("button", { name: "Choose file and import" }));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onChooseFile).toHaveBeenCalledOnce();
    expect(onImport).toHaveBeenCalledWith("Production west");
  });

  it("keeps deferred WireGuard configurations unavailable", async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn();
    renderSelector({ onConnect });

    const wireGuard = screen.getByRole("option", { name: /bob/i });
    expect(wireGuard).toHaveAttribute("aria-disabled", "true");
    await user.click(wireGuard);
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith(CONFIGS[0]);
  });

  it("confirms detach without offering to delete a pre-existing source file", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    renderSelector({ onRemove });

    await user.click(screen.getByRole("button", { name: "Forget" }));
    expect(await screen.findByRole("alertdialog", { name: "Forget this configuration?" })).toHaveTextContent(
      "source file remains on disk",
    );
    await user.click(screen.getByRole("button", { name: "Forget only" }));

    expect(onRemove).toHaveBeenCalledWith(CONFIGS[0]);
  });

  it("closes a removal confirmation when a catalog refresh invalidates its opaque ID", async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderSelector();

    await user.click(screen.getByRole("button", { name: "Forget" }));
    expect(await screen.findByRole("alertdialog", { name: "Forget this configuration?" })).toBeInTheDocument();

    rerender(
      <SavedConfigSelector
        {...props}
        configs={CONFIGS.map((config, index) => ({ ...config, id: `refreshed-config-${index}` }))}
      />,
    );
    expect(screen.queryByRole("alertdialog", { name: "Forget this configuration?" })).not.toBeInTheDocument();
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
