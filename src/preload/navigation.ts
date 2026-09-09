// This session-wide preload runs in the isolated world before renderer code.
// Electron's main-process will-* hooks do not fire for no-request navigations
// such as about:blank. The Navigation API can cancel these before they start,
// preserving both the document and its main-process lifecycle state.
interface NavigationGuardEvent {
  readonly destination: { readonly url: string };
  preventDefault(): void;
}

const browser = globalThis as unknown as {
  readonly location: { readonly protocol: string };
  readonly navigation: {
    addEventListener(name: "navigate", listener: (event: NavigationGuardEvent) => void): void;
  };
};

// The native DevTools frontend has its own internal navigation. Main allows
// devtools: only for Electron's remote contents, never for application views.
if (browser.location.protocol !== "devtools:") {
  browser.navigation.addEventListener("navigate", (event) => {
    try {
      const url = new URL(event.destination.url);
      if (
        url.protocol === "sliver:" && url.host === "app" &&
        url.pathname === "/index.html" && url.username === "" && url.password === ""
      ) return;
    } catch {
      // Invalid destinations are denied too.
    }
    event.preventDefault();
  });
}

export {};
