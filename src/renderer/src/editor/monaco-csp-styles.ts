/**
 * Monaco's trusted, bundled theme/layout code generates CSS at runtime. Keep
 * that CSS in constructed stylesheets rather than authorizing arbitrary inline
 * <style> text in the application's Content Security Policy.
 *
 * This adapter is installed only at Monaco's two stylesheet creation sites by
 * the pinned-source Vite transform. It does not modify DOM prototypes or accept
 * user source. Ordinary app styles and user-supplied strings remain subject to
 * the original CSP.
 */
export function createMonacoStyleElement(container: HTMLElement | ShadowRoot): HTMLStyleElement {
  const document = container.ownerDocument;
  const style = document.createElement("style");
  style.type = "text/css";
  style.media = "screen";
  // Monaco writes suggestion-list styles before attaching their container and
  // detaches/reuses that container later. A native style.sheet is null while
  // detached and loses CSSOM-only rules on reattachment, so keep a stable sheet.
  const ownerWindow = document.defaultView as (Window & typeof globalThis) | null;
  const Sheet = ownerWindow?.CSSStyleSheet ?? CSSStyleSheet;
  const sheet = new Sheet({ media: "screen" });
  const entry: MonacoStyleEntry = { handle: new WeakRef(style), sheet, root: null };
  const tracker = styleTracker(document);
  tracker.entries.add(entry);
  Object.defineProperty(style, "sheet", { get: () => sheet });
  container.appendChild(style);
  synchronizeStyle(entry, tracker);

  let currentText = "";
  Object.defineProperty(style, "textContent", {
    configurable: false,
    get: () => currentText,
    set: (value: string | null) => {
      const nextText = value ?? "";
      if (nextText === currentText) return;
      // Parse only CSS, never HTML/JavaScript. replaceSync also preserves nested
      // @media/@supports rules without trying to split their source strings.
      sheet.replaceSync(nextText);
      currentText = nextText;
      const StyleEvent = ownerWindow?.Event ?? Event;
      style.dispatchEvent(new StyleEvent("monaco-css-changed"));
    },
  });
  const remove = style.remove.bind(style);
  Object.defineProperty(style, "remove", {
    value: () => { remove(); synchronizeStyle(entry, tracker); },
  });
  return style;
}

interface MonacoStyleEntry {
  handle: WeakRef<HTMLStyleElement>;
  sheet: CSSStyleSheet;
  root: Document | ShadowRoot | null;
}

interface MonacoStyleTracker {
  entries: Set<MonacoStyleEntry>;
  roots: WeakMap<Document | ShadowRoot, MutationObserver>;
}

const trackers = new WeakMap<Document, MonacoStyleTracker>();

function styleTracker(document: Document): MonacoStyleTracker {
  let tracker = trackers.get(document);
  if (!tracker) {
    tracker = { entries: new Set(), roots: new WeakMap() };
    trackers.set(document, tracker);
    observeStyleRoot(document, tracker);
  }
  return tracker;
}

function observeStyleRoot(root: Document | ShadowRoot, tracker: MonacoStyleTracker): void {
  if (tracker.roots.has(root)) return;
  // One observer per document/shadow root, not one retained closure per widget.
  // Entries hold weak handles, so abandoned detached widgets can be collected.
  const observer = new MutationObserver(() => {
    for (const entry of tracker.entries) synchronizeStyle(entry, tracker);
  });
  observer.observe(root, { childList: true, subtree: true });
  tracker.roots.set(root, observer);
}

function synchronizeStyle(entry: MonacoStyleEntry, tracker: MonacoStyleTracker): void {
  const style = entry.handle.deref();
  const candidate = style?.isConnected ? style.getRootNode() : null;
  // getRootNode() returns DOM-owned nodes; nodeType works across window realms.
  const root = candidate && (candidate.nodeType === 9 || (candidate.nodeType === 11 && "host" in candidate))
    ? candidate as Document | ShadowRoot : null;
  if (entry.root !== root) {
    if (entry.root) {
      entry.root.adoptedStyleSheets = (entry.root.adoptedStyleSheets ?? []).filter((sheet) => sheet !== entry.sheet);
    }
    entry.root = root;
    if (root) {
      observeStyleRoot(root, tracker);
      root.adoptedStyleSheets = [...(root.adoptedStyleSheets ?? []), entry.sheet];
    }
  }
  if (!style) tracker.entries.delete(entry);
}

/** Monaco auxiliary-window clones must observe CSSOM-backed text assignments. */
export function observeMonacoStyle(source: HTMLStyleElement, clone: HTMLStyleElement): { dispose(): void } {
  const listener = (): void => { clone.textContent = source.textContent; };
  source.addEventListener("monaco-css-changed", listener);
  return { dispose: () => source.removeEventListener("monaco-css-changed", listener) };
}

/**
 * Restore trusted Monaco layout declarations through CSSOM after its source
 * emitters have been adapted to inert data attributes. Text and token markup
 * remain exactly as escaped by Monaco; no source-code text is rewritten here.
 */
export function createMonacoMarkupFragment(markup: unknown): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = String(markup);
  for (const element of template.content.querySelectorAll<HTMLElement | SVGElement>("[data-monaco-style]")) {
    const declarations = element.getAttribute("data-monaco-style") ?? "";
    element.removeAttribute("data-monaco-style");
    element.style.cssText = declarations;
  }
  return template.content;
}
