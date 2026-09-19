import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Key,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowPointer,
  faArrowRotateLeft,
  faArrowRotateRight,
  faArrowUpRightFromSquare,
  faCode,
  faCopy,
  faImage,
  faLink,
  faPaste,
  faScissors,
  faSpellCheck,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";
import { ContextMenu } from "@heroui-pro/react/context-menu";
import { Label } from "@heroui/react";

import type {
  ApplicationContextMenuAPI,
  ApplicationContextMenuActionItem,
  ApplicationContextMenuItem,
  ApplicationContextMenuItemKind,
  ApplicationContextMenuItemVariant,
  ApplicationContextMenuRequest,
} from "../../../shared/application-context-menu-contracts";

const SCOPE_ATTRIBUTE = "data-application-context-menu-scope" as const;
const POLICY_ATTRIBUTE = "data-application-context-menu-policy" as const;

export type ApplicationContextMenuBuiltInPolicy = "all" | "inspect-only";

export interface ApplicationContextMenuAction {
  readonly id: string;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly icon?: IconDefinition;
  readonly isDisabled?: boolean;
  readonly shortcut?: string;
  readonly variant?: ApplicationContextMenuItemVariant;
  readonly onAction: () => void | Promise<void>;
}

export interface ApplicationContextMenuScopeOptions {
  readonly actions?: readonly ApplicationContextMenuAction[];
  /** Controls which main-owned actions are shown without affecting scoped actions. */
  readonly builtInPolicy?: ApplicationContextMenuBuiltInPolicy;
}

export interface ApplicationContextMenuScopeDataProps {
  readonly [SCOPE_ATTRIBUTE]: string;
  readonly [POLICY_ATTRIBUTE]?: ApplicationContextMenuBuiltInPolicy;
}

interface ScopeRegistry {
  readonly scopes: Map<string, ApplicationContextMenuScopeOptions>;
  readonly register: (
    scopeId: string,
    options: ApplicationContextMenuScopeOptions,
  ) => () => void;
}

const ApplicationContextMenuScopeRegistry = createContext<ScopeRegistry | null>(null);

/**
 * Marks an existing component as a context-menu scope without adding a wrapper.
 * The closest marked ancestor of the original right-click target wins.
 */
export function useApplicationContextMenuScope(
  options: ApplicationContextMenuScopeOptions,
): ApplicationContextMenuScopeDataProps {
  const registry = useContext(ApplicationContextMenuScopeRegistry);
  const reactId = useId();
  const scopeId = `application-context-menu-${reactId}`;

  if (!registry) {
    throw new Error("useApplicationContextMenuScope must be used inside ApplicationContextMenu");
  }

  useLayoutEffect(
    () => registry.register(scopeId, options),
    [options, registry, scopeId],
  );

  return useMemo(
    () => ({
      [SCOPE_ATTRIBUTE]: scopeId,
      ...(options.builtInPolicy === undefined
        ? {}
        : { [POLICY_ATTRIBUTE]: options.builtInPolicy }),
    }),
    [options.builtInPolicy, scopeId],
  );
}

export interface ApplicationContextMenuScopeProps
  extends ApplicationContextMenuScopeOptions {
  readonly children: ReactNode;
  readonly className?: string;
}

/** Convenience scope for layouts where a display:contents wrapper is appropriate. */
export function ApplicationContextMenuScope({
  actions,
  builtInPolicy,
  children,
  className,
}: ApplicationContextMenuScopeProps): React.JSX.Element {
  const scopeProps = useApplicationContextMenuScope({
    ...(actions === undefined ? {} : { actions }),
    ...(builtInPolicy === undefined ? {} : { builtInPolicy }),
  });
  return (
    <div
      {...scopeProps}
      className={["contents", className].filter(Boolean).join(" ")}
    >
      {children}
    </div>
  );
}

export interface ApplicationContextMenuProps {
  readonly api?: ApplicationContextMenuAPI;
  readonly children: ReactNode;
}

interface CapturedInteraction {
  readonly target: EventTarget | null;
  readonly focus: FocusSnapshot;
}

interface FocusSnapshot {
  readonly activeElement: HTMLElement | null;
  readonly inputSelection?: {
    readonly start: number;
    readonly end: number;
    readonly direction: "backward" | "forward" | "none";
  };
  readonly documentRanges: readonly Range[];
}

interface MenuSession {
  readonly capture: CapturedInteraction;
  readonly nativeItems: readonly ApplicationContextMenuItem[];
  readonly request: ApplicationContextMenuRequest;
  readonly scopeActions: readonly ApplicationContextMenuAction[];
}

interface PendingExecution {
  readonly capture: CapturedInteraction;
  readonly consumesNativeCapability: boolean;
  readonly menuElement: Element | null;
  readonly requestId: string;
  readonly run: () => void | Promise<unknown>;
}

interface ResolvedMenuAction {
  readonly consumesNativeCapability: boolean;
  readonly run: () => void | Promise<unknown>;
}

/**
 * Presents main-owned Electron edit actions through HeroUI while leaving the
 * real application content outside ContextMenu.Trigger. This preserves the
 * genuine DOM contextmenu event for Electron's authoritative native request.
 */
export function ApplicationContextMenu({
  api = window.applicationContextMenu,
  children,
}: ApplicationContextMenuProps): React.JSX.Element {
  const scopesRef = useRef(new Map<string, ApplicationContextMenuScopeOptions>());
  const capturedInteractionRef = useRef<CapturedInteraction>(captureInteraction(null));
  const triggerTargetRef = useRef<HTMLSpanElement>(null);
  const lastDispatchedRequestIdRef = useRef<string | undefined>(undefined);
  const isOpenRef = useRef(false);
  const wasOpenRef = useRef(false);
  const pendingExecutionRef = useRef<PendingExecution | undefined>(undefined);
  const openRequestIdRef = useRef<string | undefined>(undefined);
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<MenuSession>();

  const registry = useMemo<ScopeRegistry>(() => ({
    scopes: scopesRef.current,
    register: (scopeId, options) => {
      scopesRef.current.set(scopeId, options);
      return () => {
        if (scopesRef.current.get(scopeId) === options) {
          scopesRef.current.delete(scopeId);
        }
      };
    },
  }), []);

  const setOpen = useCallback((nextOpen: boolean): void => {
    isOpenRef.current = nextOpen;
    setIsOpen(nextOpen);
  }, []);

  const captureContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>): void => {
    capturedInteractionRef.current = captureInteraction(event.target);
  }, []);

  useEffect(() => {
    let pendingFrame: number | undefined;
    const unsubscribe = api.onMenuRequested((request) => {
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      // Electron can deliver its main-process context-menu notification before
      // React's capture phase has finished for the matching DOM event. Resolve
      // the target on the next frame so the request cannot inherit the prior
      // right-click's focus/selection or component scope.
      pendingFrame = requestAnimationFrame(() => {
        const capture = capturedInteractionRef.current;
        const scope = resolveScope(capture.target, scopesRef.current);
        const policy = resolveBuiltInPolicy(capture.target) ?? scope?.builtInPolicy ?? "all";
        const nativeItems = filterNativeItems(request.items, policy);
        const commitSession = (): void => {
          pendingFrame = undefined;
          // A second native request replaces an open menu atomically with current data.
          if (isOpenRef.current) setOpen(false);
          setSession({
            capture,
            nativeItems,
            request,
            scopeActions: scope?.actions ? [...scope.actions] : [],
          });
        };

        // Ghostty can emit one final focus/scroll event after the native
        // contextmenu notification. HeroUI intentionally dismisses on scroll,
        // so let inspect-only surfaces settle before mounting their popover.
        if (containsOnlyInspectAction(nativeItems)) {
          pendingFrame = requestAnimationFrame(commitSession);
        } else {
          commitSession();
        }
      });
    });
    return () => {
      if (pendingFrame !== undefined) cancelAnimationFrame(pendingFrame);
      unsubscribe();
    };
  }, [api, setOpen]);

  useLayoutEffect(() => {
    if (!session || lastDispatchedRequestIdRef.current === session.request.requestId) return;
    const target = triggerTargetRef.current;
    if (!target) return;
    lastDispatchedRequestIdRef.current = session.request.requestId;
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: session.request.x,
      clientY: session.request.y,
    }));
  }, [session]);

  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!wasOpen || isOpen) return;

    const pending = pendingExecutionRef.current;
    pendingExecutionRef.current = undefined;
    const openRequestId = openRequestIdRef.current;
    openRequestIdRef.current = undefined;
    if (pending) {
      scheduleMenuAction(pending.consumesNativeCapability
        ? pending
        : {
            ...pending,
            run: async () => {
              await revokeMenuCapabilities(api, pending.requestId);
              await pending.run();
            },
          });
    } else {
      if (openRequestId) void revokeMenuCapabilities(api, openRequestId);
      restoreInteraction(session?.capture);
    }
  }, [api, isOpen, session]);

  useEffect(() => {
    if (!isOpen || !session) return;
    const requestId = session.request.requestId;
    openRequestIdRef.current = requestId;
    void api.setOpen({ requestId, open: true }).then((retained) => {
      if (!retained && openRequestIdRef.current === requestId) setOpen(false);
    }, () => {
      if (openRequestIdRef.current === requestId) setOpen(false);
    });
  }, [api, isOpen, session, setOpen]);

  useEffect(() => () => {
    const requestId = openRequestIdRef.current;
    if (requestId) void revokeMenuCapabilities(api, requestId);
  }, [api]);

  const scheduleExecution = useCallback((execution: PendingExecution): void => {
    pendingExecutionRef.current = execution;
    setOpen(false);
  }, [setOpen]);

  const menuActions = useMemo(() => buildMenuActions(session, api), [api, session]);
  const handleAction = useCallback((key: Key): void => {
    if (!session) return;
    const action = menuActions.get(String(key));
    if (!action) return;
    scheduleExecution({
      capture: session.capture,
      consumesNativeCapability: action.consumesNativeCapability,
      menuElement: document.querySelector(
        '[role="menu"][aria-label="Application context menu"]',
      ),
      requestId: session.request.requestId,
      run: action.run,
    });
  }, [menuActions, scheduleExecution, session]);

  return (
    <ApplicationContextMenuScopeRegistry.Provider value={registry}>
      <div className="contents" onContextMenuCapture={captureContextMenu}>
        {children}
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 -z-10 size-px overflow-hidden opacity-0"
      >
        <ContextMenu open={isOpen} onOpenChange={setOpen}>
          <ContextMenu.Trigger className="size-px">
            <span ref={triggerTargetRef} className="block size-px" />
          </ContextMenu.Trigger>
          <ContextMenu.Popover
            shouldSkipAnimation={pendingExecutionRef.current !== undefined}
          >
            <ContextMenu.Menu
              aria-label="Application context menu"
              onAction={handleAction}
            >
              {session?.scopeActions.map((item, index) => (
                <ContextMenu.Item
                  id={scopeActionKey(item, index)}
                  key={scopeActionKey(item, index)}
                  textValue={item.label}
                  {...(item.ariaLabel === undefined ? {} : { "aria-label": item.ariaLabel })}
                  {...(item.isDisabled === undefined ? {} : { isDisabled: item.isDisabled })}
                  {...(item.variant === undefined ? {} : { variant: item.variant })}
                >
                  {item.icon ? (
                    <FontAwesomeIcon
                      aria-hidden
                      className={item.variant === "danger" ? "size-4 text-danger" : "size-4 text-muted"}
                      icon={item.icon}
                    />
                  ) : null}
                  <Label>{item.label}</Label>
                  {item.shortcut ? <MenuShortcut value={item.shortcut} /> : null}
                </ContextMenu.Item>
              ))}

              {session && session.scopeActions.length > 0 && session.nativeItems.length > 0
                ? <ContextMenu.Separator />
                : null}

              {session?.nativeItems.map((item, index) => item.type === "separator" ? (
                <ContextMenu.Separator key={`native-separator-${index}`} />
              ) : (
                <ContextMenu.Item
                  id={nativeActionKey(item)}
                  isDisabled={!item.enabled}
                  key={nativeActionKey(item)}
                  textValue={item.label}
                  {...(item.variant === undefined ? {} : { variant: item.variant })}
                >
                  <FontAwesomeIcon
                    aria-hidden
                    className={item.variant === "danger" ? "size-4 text-danger" : "size-4 text-muted"}
                    icon={iconForNativeItem(item.kind)}
                  />
                  <Label>{item.label}</Label>
                  {item.shortcut ? <MenuShortcut value={formatShortcut(item.shortcut)} /> : null}
                </ContextMenu.Item>
              ))}
            </ContextMenu.Menu>
          </ContextMenu.Popover>
        </ContextMenu>
      </div>
    </ApplicationContextMenuScopeRegistry.Provider>
  );
}

async function executeMenuAction(run: PendingExecution["run"]): Promise<void> {
  try {
    await run();
  } catch {
    // Component-owned actions must not turn a dismissed menu into an unhandled
    // renderer failure. Individual components can surface actionable errors in
    // their own callback when they need user-visible recovery.
  }
}

function scheduleMenuAction(pending: PendingExecution): void {
  const waitForPopoverUnmount = (): void => {
    if (pending.menuElement?.isConnected) {
      requestAnimationFrame(waitForPopoverUnmount);
      return;
    }

    // React Aria restores its pre-overlay focus while the FocusScope unmounts.
    // Wait until that unmount is complete, then restore the exact editable
    // selection before Chromium receives the editing command.
    requestAnimationFrame(() => {
      restoreInteraction(pending.capture, true);
      void executeMenuAction(pending.run);
    });
  };
  requestAnimationFrame(waitForPopoverUnmount);
}

function MenuShortcut({ value }: { readonly value: string }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="ms-auto text-xs text-muted" slot="keyboard">
      {value}
    </span>
  );
}

function buildMenuActions(
  session: MenuSession | undefined,
  api: ApplicationContextMenuAPI,
): ReadonlyMap<string, ResolvedMenuAction> {
  const actions = new Map<string, ResolvedMenuAction>();
  if (!session) return actions;

  session.scopeActions.forEach((action, index) => {
    actions.set(scopeActionKey(action, index), {
      consumesNativeCapability: false,
      run: action.onAction,
    });
  });
  session.nativeItems.forEach((item) => {
    if (item.type !== "action") return;
    actions.set(nativeActionKey(item), {
      consumesNativeCapability: true,
      run: async () => {
        const executed = await api.executeAction({
          requestId: session.request.requestId,
          actionId: item.actionId,
        });
        if (executed && item.kind === "select-all") {
          selectCapturedEditableContents(session.capture);
        }
      },
    });
  });
  return actions;
}

async function revokeMenuCapabilities(
  api: ApplicationContextMenuAPI,
  requestId: string,
): Promise<void> {
  try {
    await api.setOpen({ requestId, open: false });
  } catch {
    // Navigation or teardown may retire the fixed bridge before menu cleanup.
  }
}

function scopeActionKey(action: ApplicationContextMenuAction, index: number): string {
  return `scope:${index}:${action.id}`;
}

function nativeActionKey(item: ApplicationContextMenuActionItem): string {
  return `native:${item.actionId}`;
}

function resolveScope(
  target: EventTarget | null,
  scopes: ReadonlyMap<string, ApplicationContextMenuScopeOptions>,
): ApplicationContextMenuScopeOptions | undefined {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  const scopeElement = element?.closest<HTMLElement>(`[${SCOPE_ATTRIBUTE}]`);
  const scopeId = scopeElement?.getAttribute(SCOPE_ATTRIBUTE);
  return scopeId ? scopes.get(scopeId) : undefined;
}

function resolveBuiltInPolicy(
  target: EventTarget | null,
): ApplicationContextMenuBuiltInPolicy | undefined {
  const element = eventTargetElement(target);
  const policy = element
    ?.closest<HTMLElement>(`[${POLICY_ATTRIBUTE}]`)
    ?.getAttribute(POLICY_ATTRIBUTE);
  return policy === "all" || policy === "inspect-only" ? policy : undefined;
}

function eventTargetElement(target: EventTarget | null): Element | null {
  return target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
}

function filterNativeItems(
  items: readonly ApplicationContextMenuItem[],
  policy: ApplicationContextMenuBuiltInPolicy,
): readonly ApplicationContextMenuItem[] {
  if (policy === "all") return items;

  const filtered: ApplicationContextMenuItem[] = [];
  let separatorPending = false;
  for (const item of items) {
    if (item.type === "separator") {
      separatorPending = filtered.length > 0;
      continue;
    }
    if (item.kind !== "inspect") continue;
    if (separatorPending) filtered.push({ type: "separator" });
    filtered.push(item);
    separatorPending = false;
  }
  return filtered;
}

function containsOnlyInspectAction(items: readonly ApplicationContextMenuItem[]): boolean {
  let foundInspect = false;
  for (const item of items) {
    if (item.type === "separator") continue;
    if (item.kind !== "inspect") return false;
    foundInspect = true;
  }
  return foundInspect;
}

function captureInteraction(target: EventTarget | null): CapturedInteraction {
  const editableTarget = resolveEditableTarget(target);
  const activeElement = editableTarget ?? (
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const inputSelection = captureInputSelection(activeElement);
  const selection = window.getSelection();
  const documentRanges: Range[] = [];
  if (selection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      documentRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }
  return {
    target,
    focus: {
      activeElement,
      ...(inputSelection === undefined ? {} : { inputSelection }),
      documentRanges,
    },
  };
}

function resolveEditableTarget(target: EventTarget | null): HTMLElement | null {
  const element = eventTargetElement(target);
  const editable = element?.closest<HTMLElement>(
    "input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable]:not([contenteditable='false'])",
  );
  return editable ?? null;
}

function captureInputSelection(
  element: HTMLElement | null,
): FocusSnapshot["inputSelection"] {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return undefined;
  }
  if (element.selectionStart === null || element.selectionEnd === null) return undefined;
  return {
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection ?? "none",
  };
}

function selectCapturedEditableContents(capture: CapturedInteraction): void {
  const editableTarget = resolveEditableTarget(capture.target);
  if (
    capture.focus.inputSelection &&
    (editableTarget instanceof HTMLInputElement || editableTarget instanceof HTMLTextAreaElement)
  ) {
    editableTarget.focus({ preventScroll: true });
    editableTarget.setSelectionRange(0, editableTarget.value.length);
    return;
  }
  if (!editableTarget?.isContentEditable) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editableTarget);
  selection.removeAllRanges();
  selection.addRange(range);
}

function restoreInteraction(
  capture: CapturedInteraction | undefined,
  forceFocusTransition = false,
): void {
  if (!capture) return;
  const { activeElement, documentRanges, inputSelection } = capture.focus;
  if (activeElement?.isConnected) {
    if (forceFocusTransition && document.activeElement === activeElement) {
      activeElement.blur();
    }
    activeElement.focus({ preventScroll: true });
    if (
      inputSelection &&
      (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement)
    ) {
      activeElement.setSelectionRange(
        inputSelection.start,
        inputSelection.end,
        inputSelection.direction,
      );
    }
  }

  // Text controls have their own selection model. Restoring document ranges
  // after setSelectionRange collapses that native control selection in Chromium.
  if (inputSelection || documentRanges.length === 0) return;
  const selection = window.getSelection();
  if (!selection) return;
  const connectedRanges = documentRanges.filter((range) => range.commonAncestorContainer.isConnected);
  if (connectedRanges.length === 0) return;
  selection.removeAllRanges();
  connectedRanges.forEach((range) => selection.addRange(range));
}

function iconForNativeItem(kind: ApplicationContextMenuItemKind): IconDefinition {
  switch (kind) {
    case "undo": return faArrowRotateLeft;
    case "redo": return faArrowRotateRight;
    case "cut": return faScissors;
    case "copy": return faCopy;
    case "paste":
    case "paste-and-match-style": return faPaste;
    case "delete": return faTrashCan;
    case "select-all": return faArrowPointer;
    case "replace-misspelling": return faSpellCheck;
    case "open-link": return faArrowUpRightFromSquare;
    case "copy-link": return faLink;
    case "copy-image": return faImage;
    case "inspect": return faCode;
  }
}

function formatShortcut(shortcut: string): string {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  if (isMac) {
    return shortcut
      .replace("mod", "⌘")
      .replace("shift", "⇧")
      .replaceAll("+", "")
      .toUpperCase();
  }
  return shortcut
    .replace("mod", "Ctrl")
    .replace("shift", "Shift")
    .split("+")
    .map((part) => part.length === 1 ? part.toUpperCase() : part)
    .join("+");
}
