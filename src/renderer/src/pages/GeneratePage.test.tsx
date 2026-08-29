import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { OperationResult, SavedArtifact, SliverDesktopAPI } from "../../../shared/contracts";
import { GeneratePage, parseNumberInput } from "./GeneratePage";

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

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "sliver");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function readyGenerationSnapshot() {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = { status: "connected" };
  snapshot.domains.compiler = {
    status: "ready",
    revision: 1,
    updatedAt: "2026-08-09T12:00:00.000Z",
    items: [{ os: "linux", arch: "arm64", format: "executable", supported: true }],
    page: { limit: 500, total: 1, truncated: false },
  };
  snapshot.domains.profiles = {
    status: "empty",
    revision: 1,
    updatedAt: "2026-08-09T12:00:00.000Z",
    items: [],
    page: { limit: 500, total: 0, truncated: false },
  };
  return snapshot;
}

function targetMatrixSnapshot() {
  const snapshot = readyGenerationSnapshot();
  snapshot.domains.compiler.items = [
    { os: "windows", arch: "386", format: "archive", supported: true },
    { os: "windows", arch: "386", format: "executable", supported: true },
    { os: "windows", arch: "amd64", format: "archive", supported: true },
    { os: "windows", arch: "amd64", format: "executable", supported: true },
    { os: "darwin", arch: "amd64", format: "archive", supported: true },
    { os: "darwin", arch: "amd64", format: "executable", supported: true },
    { os: "darwin", arch: "arm64", format: "archive", supported: true },
    { os: "darwin", arch: "arm64", format: "executable", supported: true },
    { os: "linux", arch: "386", format: "executable", supported: true },
    { os: "linux", arch: "amd64", format: "executable", supported: true },
    { os: "aix", arch: "ppc64", format: "executable", supported: false },
    { os: "android", arch: "arm64", format: "executable", supported: false },
    { os: "dragonfly", arch: "amd64", format: "executable", supported: false },
    { os: "freebsd", arch: "386", format: "executable", supported: false },
    { os: "freebsd", arch: "amd64", format: "executable", supported: false },
    { os: "illumos", arch: "amd64", format: "executable", supported: false },
    { os: "ios", arch: "arm64", format: "executable", supported: false },
    { os: "js", arch: "wasm", format: "executable", supported: false },
    { os: "netbsd", arch: "amd64", format: "executable", supported: false },
    { os: "openbsd", arch: "amd64", format: "executable", supported: false },
    { os: "plan9", arch: "amd64", format: "executable", supported: false },
    { os: "solaris", arch: "amd64", format: "executable", supported: false },
    { os: "wasip1", arch: "wasm", format: "executable", supported: false },
  ];
  snapshot.domains.compiler.page = {
    limit: 500,
    total: snapshot.domains.compiler.items.length,
    truncated: false,
  };
  return snapshot;
}

describe("GeneratePage action footer", () => {
  it("keeps the reusable profile form and build actions outside the scrolling form body", () => {
    render(<GeneratePage snapshot={disconnectedSnapshot()} />);

    const profileField = screen.getByRole("textbox", { name: "Reusable profile name" });
    const footer = profileField.closest("footer");

    expect(footer).not.toBeNull();
    if (!footer) throw new Error("Reusable profile field is not inside the Generate footer");

    expect(footer).toHaveClass("generate-page__footer");
    expect(footer).toHaveAccessibleName("Generate actions");
    expect(within(footer).getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Save profile" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Generate and save" })).toBeInTheDocument();

    const scrollingContent = footer.previousElementSibling;
    expect(scrollingContent).toHaveClass("generate-page__content");
    expect(scrollingContent).not.toContainElement(footer);
  });

  it("does not fabricate compiler targets while the authoritative domain is idle", () => {
    render(<GeneratePage snapshot={disconnectedSnapshot()} />);

    expect(screen.getByText("Compiler targets are not loaded")).toBeInTheDocument();
    expect(screen.getByText("0 compiler targets")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "All platforms" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate and save" })).toBeDisabled();
  });

  it("keeps section titles and subtitles in the icon row", () => {
    render(<GeneratePage snapshot={readyGenerationSnapshot()} />);

    for (const [title, subtitle] of [
      ["Artifact", "Choose the build identity, target, and output container."],
      ["Command and control", "Endpoints are attempted in the listed order unless a strategy is selected."],
    ] as const) {
      const header = screen.getByText(title).closest<HTMLElement>(".card__header");
      expect(header).not.toBeNull();
      if (!header) throw new Error(`${title} is not inside a card header`);
      expect(header).toHaveClass("flex-row", "items-center", "gap-3");
      expect(within(header).getByText(subtitle)).toBeInTheDocument();
      expect(header.querySelector(".section-icon")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("shows exact extended targets on demand and applies deterministic target defaults", async () => {
    const user = userEvent.setup();
    render(<GeneratePage snapshot={targetMatrixSnapshot()} />);

    const allPlatforms = screen.getByRole("checkbox", { name: "All platforms" });
    const osSelect = screen.getByRole("button", { name: /Operating system/i });
    const archSelect = screen.getByRole("button", { name: /Architecture/i });
    const formatSelect = screen.getByRole("button", { name: /Output format/i });

    expect(allPlatforms).toBeEnabled();
    expect(allPlatforms).not.toBeChecked();
    expect(osSelect).toHaveTextContent("Windows");
    expect(archSelect).toHaveTextContent("AMD64");
    expect(formatSelect).toHaveTextContent("Executable");
    expect(screen.getByText("10 compiler targets")).toBeInTheDocument();

    await user.click(osSelect);
    expect(screen.getByRole("option", { name: "Windows" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Linux" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "macOS" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "AIX" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "FreeBSD" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "macOS" }));
    await waitFor(() => {
      expect(archSelect).toHaveTextContent("ARM64");
      expect(formatSelect).toHaveTextContent("Executable");
    });

    await user.click(osSelect);
    await user.click(screen.getByRole("option", { name: "Windows" }));
    await waitFor(() => {
      expect(archSelect).toHaveTextContent("AMD64");
      expect(formatSelect).toHaveTextContent("Executable");
    });

    await user.click(allPlatforms);
    expect(allPlatforms).toBeChecked();
    expect(screen.getByText("23 compiler targets")).toBeInTheDocument();
    await user.click(osSelect);
    for (const [label, icon] of [
      ["AIX", "server"],
      ["Android", "android"],
      ["DragonFly BSD", "dragon"],
      ["FreeBSD", "freebsd"],
      ["illumos", "sun"],
      ["iOS", "app-store-ios"],
      ["JavaScript", "js"],
      ["NetBSD", "flag"],
      ["OpenBSD", "fish-fins"],
      ["Plan 9", "carrot"],
      ["Solaris", "sun"],
      ["WebAssembly (WASI)", "cube"],
    ] as const) {
      expect(
        screen.getByRole("option", { name: label }).querySelector(`svg[data-icon="${icon}"]`),
      ).toBeInTheDocument();
    }

    await user.click(screen.getByRole("option", { name: "FreeBSD" }));
    await waitFor(() => {
      expect(archSelect).toHaveTextContent("AMD64");
      expect(formatSelect).toHaveTextContent("Executable");
    });
    expect(screen.getByText(/extended platform target/i)).toBeInTheDocument();

    await user.click(archSelect);
    expect(screen.getByRole("option", { name: "AMD64" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "x86 (386)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "ARM64" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "x86 (386)" }));
    await waitFor(() => expect(formatSelect).toHaveTextContent("Executable"));

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(osSelect).toHaveTextContent("Windows");
      expect(archSelect).toHaveTextContent("AMD64");
      expect(formatSelect).toHaveTextContent("Executable");
    });
  });

  it("enables generation only for targets advertised by the connected server", () => {
    const snapshot = readyGenerationSnapshot();

    render(<GeneratePage snapshot={snapshot} />);

    expect(screen.getByText("1 compiler targets")).toBeInTheDocument();
    expect(screen.queryByText("Compiler targets are not loaded")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Generate and save" })).toBeEnabled();
    expect(screen.getByText(/without a scheme default to mTLS/i)).toBeInTheDocument();
  });

  it("adds a selected running listener endpoint without replacing existing C2 entries", async () => {
    const user = userEvent.setup();
    const snapshot = readyGenerationSnapshot();
    snapshot.domains.jobs = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-29T12:00:00.000Z",
      items: [
        {
          id: 7,
          name: "HTTPS",
          description: "Primary HTTPS listener",
          protocol: "tcp",
          port: 8443,
          domains: ["first.example.test"],
          profileName: "",
        },
        {
          id: 8,
          name: "HTTPS",
          description: "Secondary HTTPS listener",
          protocol: "tcp",
          port: 9443,
          domains: ["second.example.test"],
          profileName: "",
        },
      ],
      page: { limit: 500, total: 2, truncated: false },
    };

    render(<GeneratePage snapshot={snapshot} />);

    const c2Field = screen.getByRole("textbox", { name: "C2 endpoints" });
    expect(c2Field).toHaveValue("mtls://127.0.0.1:8888");

    await user.click(screen.getByRole("button", { name: "Add listener" }));

    expect(screen.getByRole("dialog", { name: "Add listener endpoint" })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Running C2 listeners" })).toBeInTheDocument();
    expect(screen.getByText("https://first.example.test:8443")).toBeVisible();
    const secondListener = screen.getByRole("option", {
      name: /Job #8.*https:\/\/second\.example\.test:9443/i,
    });
    await user.click(secondListener);
    expect(secondListener).toHaveAttribute("aria-selected", "true");

    const addEndpoint = screen.getByRole("button", { name: "Add endpoint" });
    await waitFor(() => expect(addEndpoint).toBeEnabled());
    await user.click(addEndpoint);

    expect(screen.queryByRole("dialog", { name: "Add listener endpoint" })).not.toBeInTheDocument();
    expect(c2Field).toHaveValue(
      "mtls://127.0.0.1:8888\nhttps://second.example.test:9443",
    );
  });

  it("offers local interface addresses for a wildcard listener in routability order", async () => {
    const user = userEvent.setup();
    const snapshot = readyGenerationSnapshot();
    snapshot.connection = {
      status: "connected",
      server: "localhost:53137",
      incarnation: 3,
    };
    snapshot.domains.jobs = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-29T12:00:00.000Z",
      items: [
        {
          id: 1,
          name: "mTLS",
          description: "mutual tls listener 0.0.0.0:8888",
          protocol: "tcp",
          port: 8888,
          domains: [],
          profileName: "",
        },
      ],
      page: { limit: 500, total: 1, truncated: false },
    };
    const listLocalNetworkInterfaces = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        hostname: "sliver-host",
        addresses: [
          { name: "lo0", address: "127.0.0.1", family: "IPv4", scope: "loopback" },
          { name: "en0", address: "192.168.50.10", family: "IPv4", scope: "private" },
          { name: "utun0", address: "8.8.8.8", family: "IPv4", scope: "global" },
        ],
      },
    });
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: {
        listLocalNetworkInterfaces,
      } as Pick<SliverDesktopAPI, "listLocalNetworkInterfaces"> as SliverDesktopAPI,
    });

    render(<GeneratePage snapshot={snapshot} />);

    const c2Field = screen.getByRole("textbox", { name: "C2 endpoints" });
    await user.click(screen.getByRole("button", { name: "Add listener" }));
    await waitFor(() => expect(listLocalNetworkInterfaces).toHaveBeenCalledOnce());

    expect(screen.getByText("Wildcard")).toBeVisible();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
    const addressList = await screen.findByRole("listbox", { name: "Callback address" });
    expect(within(addressList).getByText("Globally routable")).toBeVisible();
    expect(within(addressList).getByText("Private")).toBeVisible();
    expect(within(addressList).getByText("Localhost")).toBeVisible();
    expect(within(addressList).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringMatching(/mtls:\/\/8\.8\.8\.8:8888.*utun0.*Public IPv4/i),
      expect.stringMatching(/mtls:\/\/192\.168\.50\.10:8888.*en0.*Private IPv4/i),
      expect.stringMatching(/mtls:\/\/127\.0\.0\.1:8888.*lo0.*Loopback IPv4.*Added/i),
    ]);

    await user.click(within(addressList).getByRole("option", {
      name: /mtls:\/\/192\.168\.50\.10:8888.*en0.*Private IPv4/i,
    }));
    const addEndpoint = screen.getByRole("button", { name: "Add endpoint" });
    await waitFor(() => expect(addEndpoint).toBeEnabled());
    await user.click(addEndpoint);

    expect(c2Field).toHaveValue(
      "mtls://127.0.0.1:8888\nmtls://192.168.50.10:8888",
    );
  });

  it("marks an existing listener endpoint as added and prevents duplicates", async () => {
    const user = userEvent.setup();
    const snapshot = readyGenerationSnapshot();
    snapshot.domains.jobs = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-29T12:00:00.000Z",
      items: [
        {
          id: 8,
          name: "mTLS",
          description: "mutual tls listener 127.0.0.1:8888",
          protocol: "tcp",
          port: 8888,
          domains: [],
          profileName: "",
        },
      ],
      page: { limit: 500, total: 1, truncated: false },
    };

    render(<GeneratePage snapshot={snapshot} />);
    const c2Field = screen.getByRole("textbox", { name: "C2 endpoints" });
    await user.click(screen.getByRole("button", { name: "Add listener" }));

    expect(screen.getByText("Added")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add endpoint" })).toBeDisabled();
    expect(c2Field).toHaveValue("mtls://127.0.0.1:8888");
  });

  it("explains why an underspecified running listener cannot be added", async () => {
    const user = userEvent.setup();
    const snapshot = readyGenerationSnapshot();
    snapshot.domains.jobs = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-29T12:00:00.000Z",
      items: [
        {
          id: 9,
          name: "WG",
          description: "WireGuard listener",
          protocol: "udp",
          port: 53,
          domains: [],
          profileName: "",
        },
      ],
      page: { limit: 500, total: 1, truncated: false },
    };

    render(<GeneratePage snapshot={snapshot} />);
    await user.click(screen.getByRole("button", { name: "Add listener" }));

    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.getByText(/does not expose the callback host or WireGuard auxiliary ports/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Add endpoint" })).toBeDisabled();
  });

  it("indicates an invalid C2 endpoint and blocks config submission until it is repaired", async () => {
    const user = userEvent.setup();
    const generate = vi.fn();
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { generate } as Pick<SliverDesktopAPI, "generate"> as SliverDesktopAPI,
    });

    render(<GeneratePage snapshot={readyGenerationSnapshot()} />);

    const c2Field = screen.getByRole("textbox", { name: "C2 endpoints" });
    const saveProfileButton = screen.getByRole("button", { name: "Save profile" });
    const generateButton = screen.getByRole("button", { name: "Generate and save" });
    await waitFor(() => expect(generateButton).toBeEnabled());

    await user.clear(c2Field);
    await user.type(c2Field, "ftp://c2.example.test");

    expect(c2Field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Unsupported C2 protocol.*ftp/i)).toBeVisible();
    expect(saveProfileButton).toBeDisabled();
    expect(generateButton).toBeDisabled();

    await user.click(generateButton);
    expect(generate).not.toHaveBeenCalled();

    await user.clear(c2Field);
    await user.type(c2Field, "https://c2.example.test");

    await waitFor(() => {
      expect(c2Field).not.toHaveAttribute("aria-invalid", "true");
      expect(saveProfileButton).toBeEnabled();
      expect(generateButton).toBeEnabled();
    });
    expect(screen.queryByText(/Unsupported C2 protocol.*ftp/i)).not.toBeInTheDocument();
  });

  it("resets an invalid form to a valid configuration for the advertised target", async () => {
    const user = userEvent.setup();

    render(<GeneratePage snapshot={readyGenerationSnapshot()} />);

    const c2Field = screen.getByRole("textbox", { name: "C2 endpoints" });
    const saveProfileButton = screen.getByRole("button", { name: "Save profile" });
    const generateButton = screen.getByRole("button", { name: "Generate and save" });
    await waitFor(() => expect(generateButton).toBeEnabled());

    await user.clear(c2Field);
    await user.type(c2Field, "ftp://c2.example.test");
    expect(generateButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(c2Field).toHaveValue("mtls://127.0.0.1:8888");
    await waitFor(() => {
      expect(c2Field).not.toHaveAttribute("aria-invalid", "true");
      expect(saveProfileButton).toBeEnabled();
      expect(generateButton).toBeEnabled();
    });
  });

  it("shows build progress and disables the complete generation form while compiling", async () => {
    const user = userEvent.setup();
    const build = deferred<OperationResult<SavedArtifact>>();
    const generate = vi.fn().mockReturnValue(build.promise);
    Object.defineProperty(window, "sliver", {
      configurable: true,
      value: { generate } as Pick<SliverDesktopAPI, "generate"> as SliverDesktopAPI,
    });

    render(<GeneratePage snapshot={readyGenerationSnapshot()} />);

    const generateButton = screen.getByRole("button", { name: "Generate and save" });
    await user.click(generateButton);

    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generateButton).toHaveAttribute("data-pending");
    expect(within(generateButton).getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Implant generation configuration" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Build name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Operating system/i })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Reconnect delay (seconds)" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Obfuscate symbols" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Reusable profile name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add listener" })).toBeDisabled();

    build.resolve({
      ok: true,
      value: { fileName: "implant", size: 0, implantName: "implant", buildId: "build-id", saved: false },
    });

    await waitFor(() => expect(generateButton).not.toHaveAttribute("data-pending"));
    expect(within(generateButton).queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Build name" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeEnabled();
  });

  it("keeps profile saves disabled when the server inventory is truncated", () => {
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected" };
    snapshot.domains.compiler = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-09T12:00:00.000Z",
      items: [{ os: "linux", arch: "amd64", format: "executable", supported: true }],
      page: { limit: 500, total: 1, truncated: false },
    };
    snapshot.domains.profiles = {
      status: "ready",
      revision: 1,
      updatedAt: "2026-08-09T12:00:00.000Z",
      items: [],
      page: { limit: 500, total: 501, truncated: true, nextCursor: "500" },
    };

    render(<GeneratePage snapshot={snapshot} />);

    expect(screen.getByText(/Saving is unavailable while the profile inventory is incomplete or stale/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate and save" })).toBeEnabled();
  });
});

describe("GeneratePage numeric input parsing", () => {
  it("accepts finite numbers and rejects values that would poison typed form state", () => {
    expect(parseNumberInput("31337")).toBe(31_337);
    expect(parseNumberInput("1.5")).toBe(1.5);
    expect(parseNumberInput("not-a-number")).toBeUndefined();
    expect(parseNumberInput("Infinity")).toBeUndefined();
  });
});
