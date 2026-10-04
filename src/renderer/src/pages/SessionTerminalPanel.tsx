import {
  createRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Selection } from "react-aria-components";
import {
  AlertDialog,
  Button,
  Chip,
  Modal,
  ScrollShadow,
  Toolbar,
  Tooltip,
  toast,
} from "@heroui/react";
import { EmptyState, ListView, Sheet } from "@heroui-pro/react";
import { Resizable } from "@heroui-pro/react/resizable";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faTerminal,
  faTriangleExclamation,
  faUpRightFromSquare,
} from "@fortawesome/free-solid-svg-icons";

import type { SessionSummary } from "../../../shared/target-contracts";
import type {
  PrepareSessionShellInput,
  SessionShellResource,
  SessionShellResourceAction,
  SessionShellResourceList,
  TerminalRuntimeAsset,
} from "../../../shared/stream-contracts";
import {
  GhosttyTerminal,
  type GhosttyTerminalHandle,
} from "../components/GhosttyTerminal";
import { applicationTerminalAppearance } from "../components/application-terminal-appearance";
import { useApplicationSettings } from "../components/ApplicationSettingsProvider";
import {
  SessionShellTransport,
  type SessionShellTransportSnapshot,
} from "../components/session-shell-transport";

const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;
const MAX_PASTE_BYTES = 64 * 1_024;
const METRICS_UPDATE_MILLISECONDS = 250;
const WIDE_SHELL_WORKSPACE_QUERY = "(min-width: 768px)";

let cachedTerminalRuntime: TerminalRuntimeAsset | undefined;
let pendingTerminalRuntime: Promise<TerminalRuntimeAsset> | undefined;

export interface SessionTerminalRoute {
  readonly sessionId: string;
  readonly backendEpoch: number;
  readonly connectionIncarnation: number;
  readonly targetFingerprint: string;
}

export interface SessionTerminalPanelProps {
  readonly onPopOut?: (preferredResourceId?: string) => Promise<void>;
  readonly preferredResourceId?: string;
  readonly presentation?: SessionTerminalPresentation;
  readonly route: SessionTerminalRoute;
  readonly session: SessionSummary;
}

export type SessionTerminalPresentation = "embedded" | "dedicated";

type PanelStatus = "loading" | "ready" | "error";

interface PendingResourceAction {
  readonly resourceId: string;
  readonly action: "close" | "kill";
}

interface PasteReview {
  readonly bytes: number;
  readonly lines: number;
  readonly controlCharacters: number;
}

interface PendingPaste {
  readonly entry: AttachedTerminal;
  readonly resourceId: string;
  readonly routeIdentity: string;
  readonly text: string;
}

interface AttachmentPumpRun {
  readonly generation: number;
  readonly promise: Promise<void>;
}

interface AttachedTerminal {
  readonly resourceId: string;
  readonly transport: SessionShellTransport;
  readonly terminalRef: RefObject<GhosttyTerminalHandle | null>;
  latestSnapshot: SessionShellTransportSnapshot;
  metricsTimer?: ReturnType<typeof setTimeout>;
  unsubscribeState?: () => void;
}

const initialTransportSnapshot: SessionShellTransportSnapshot = Object.freeze({
  state: "connecting",
  pressure: "normal",
  queuedInputBytes: 0,
  queuedOutputBytes: 0,
  inputCreditBytes: 0,
  bytesFromRemote: "0",
  bytesToRemote: "0",
});

export function SessionTerminalPanel({
  onPopOut,
  preferredResourceId,
  presentation = "embedded",
  route,
  session,
}: SessionTerminalPanelProps): React.JSX.Element {
  const applicationSettings = useApplicationSettings();
  const routeIdentity = terminalRouteIdentity(route);
  const routeIdentityRef = useRef(routeIdentity);
  routeIdentityRef.current = routeIdentity;
  const lifecycleGenerationRef = useRef(0);
  const inventoryRequestSequenceRef = useRef(0);
  const runtimeRef = useRef<TerminalRuntimeAsset | undefined>(undefined);
  const inventoryRef = useRef<SessionShellResourceList | undefined>(undefined);
  const attachedTerminalsRef = useRef(new Map<string, AttachedTerminal>());
  const selectedResourceIdRef = useRef<string | undefined>(undefined);
  const desiredAttachmentResourceIdRef = useRef<string | undefined>(undefined);
  const attachmentPumpRef = useRef<AttachmentPumpRun | undefined>(undefined);
  const startAttachmentPumpRef = useRef<((expectedIdentity: string, generation: number) => void) | undefined>(undefined);
  const preferredAttachmentKeyRef = useRef<string | undefined>(undefined);
  const pendingTerminalFocusResourceIdRef = useRef<string | undefined>(undefined);
  const pendingPasteRef = useRef<PendingPaste | undefined>(undefined);

  const [panelStatus, setPanelStatus] = useState<PanelStatus>("loading");
  const [error, setError] = useState<string>();
  const [inventory, setInventory] = useState<SessionShellResourceList>();
  const [selectedResourceId, setSelectedResourceId] = useState<string>();
  const [isStarting, setIsStarting] = useState(false);
  const [isAttaching, setIsAttaching] = useState(false);
  const [isPoppingOut, setIsPoppingOut] = useState(false);
  const [activeAction, setActiveAction] = useState<SessionShellResourceAction>();
  const [pendingResourceAction, setPendingResourceAction] = useState<PendingResourceAction>();
  const [pasteReview, setPasteReview] = useState<PasteReview>();
  const [transportSnapshot, setTransportSnapshot] = useState(initialTransportSnapshot);
  const [attachedTerminalsRevision, setAttachedTerminalsRevision] = useState(0);
  const [isShellListOpen, setIsShellListOpen] = useState(false);
  const [transferredPreferredResourceId, setTransferredPreferredResourceId] = useState<string>();
  const isWide = useMediaQuery(WIDE_SHELL_WORKSPACE_QUERY, true);

  const isCurrent = useCallback((expectedIdentity = routeIdentity) => (
    routeIdentityRef.current === expectedIdentity
  ), [routeIdentity]);

  const focusAttachedResource = useCallback((entry: AttachedTerminal): void => {
    entry.terminalRef.current?.focus();
  }, []);

  const releaseTransport = useCallback((
    resourceId: string,
    disposition?: "detach" | "close",
  ) => {
    const entry = attachedTerminalsRef.current.get(resourceId);
    if (!entry) return;
    attachedTerminalsRef.current.delete(resourceId);
    if (entry.metricsTimer) clearTimeout(entry.metricsTimer);
    entry.unsubscribeState?.();
    if (disposition === "close") entry.transport.close();
    else if (disposition === "detach") entry.transport.detach();
    if (pendingTerminalFocusResourceIdRef.current === resourceId) {
      pendingTerminalFocusResourceIdRef.current = undefined;
    }
    if (selectedResourceIdRef.current === resourceId) {
      setTransportSnapshot(initialTransportSnapshot);
    }
    setAttachedTerminalsRevision((revision) => revision + 1);
  }, []);

  const releaseAllTransports = useCallback((disposition: "detach" | "close" = "detach") => {
    for (const resourceId of [...attachedTerminalsRef.current.keys()]) {
      releaseTransport(resourceId, disposition);
    }
  }, [releaseTransport]);

  const loadInventory = useCallback(async (
    expectedIdentity = routeIdentity,
    generation = lifecycleGenerationRef.current,
  ): Promise<SessionShellResourceList | undefined> => {
    const requestSequence = ++inventoryRequestSequenceRef.current;
    try {
      const result = await window.sliver.listSessionShells({});
      if (
        requestSequence !== inventoryRequestSequenceRef.current ||
        generation !== lifecycleGenerationRef.current ||
        !isCurrent(expectedIdentity)
      ) return undefined;
      if (!result.ok || !result.value) throw new Error(result.error ?? "Managed shells are unavailable");
      inventoryRef.current = result.value;
      setInventory(result.value);
      const nextSelection = chooseSelectedResource(result.value.resources, selectedResourceIdRef.current);
      selectedResourceIdRef.current = nextSelection;
      setSelectedResourceId(nextSelection);
      setError(undefined);
      return result.value;
    } catch (caught) {
      if (
        requestSequence === inventoryRequestSequenceRef.current &&
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setError(errorMessage(caught));
      return undefined;
    }
  }, [isCurrent, routeIdentity]);

  useEffect(() => {
    const generation = ++lifecycleGenerationRef.current;
    inventoryRequestSequenceRef.current += 1;
    const expectedIdentity = routeIdentity;
    let disposed = false;
    setPanelStatus("loading");
    setError(undefined);
    inventoryRef.current = undefined;
    setInventory(undefined);
    selectedResourceIdRef.current = undefined;
    setSelectedResourceId(undefined);
    setTransferredPreferredResourceId(undefined);
    desiredAttachmentResourceIdRef.current = undefined;
    preferredAttachmentKeyRef.current = undefined;
    pendingTerminalFocusResourceIdRef.current = undefined;
    setIsStarting(false);
    setIsAttaching(false);
    setIsPoppingOut(false);
    setActiveAction(undefined);
    setPendingResourceAction(undefined);
    pendingPasteRef.current = undefined;
    setPasteReview(undefined);
    releaseAllTransports();

    void (async () => {
      try {
        const runtime = await loadCachedTerminalRuntime();
        if (
          disposed ||
          generation !== lifecycleGenerationRef.current ||
          !isCurrent(expectedIdentity)
        ) return;
        runtimeRef.current = runtime;
        await loadInventory(expectedIdentity, generation);
        if (
          disposed ||
          generation !== lifecycleGenerationRef.current ||
          !isCurrent(expectedIdentity)
        ) return;
        setPanelStatus("ready");
      } catch (caught) {
        if (
          !disposed &&
          generation === lifecycleGenerationRef.current &&
          isCurrent(expectedIdentity)
        ) {
          setError(errorMessage(caught));
          setPanelStatus("error");
        }
      }
    })();

    return () => {
      disposed = true;
      lifecycleGenerationRef.current += 1;
      inventoryRef.current = undefined;
      selectedResourceIdRef.current = undefined;
      desiredAttachmentResourceIdRef.current = undefined;
      preferredAttachmentKeyRef.current = undefined;
      pendingTerminalFocusResourceIdRef.current = undefined;
      pendingPasteRef.current = undefined;
      releaseAllTransports();
    };
  }, [isCurrent, loadInventory, releaseAllTransports, routeIdentity]);

  const subscribeToTransportState = useCallback((
    transport: SessionShellTransport,
    resourceId: string,
    expectedIdentity: string,
    generation: number,
  ) => transport.subscribeState((snapshot) => {
    const entry = attachedTerminalsRef.current.get(resourceId);
    if (
      entry?.transport !== transport ||
      generation !== lifecycleGenerationRef.current ||
      !isCurrent(expectedIdentity)
    ) return;
    const previous = entry.latestSnapshot;
    entry.latestSnapshot = snapshot;
    const urgent = snapshot.state !== previous.state || snapshot.pressure !== previous.pressure;
    if (urgent) {
      if (entry.metricsTimer) clearTimeout(entry.metricsTimer);
      delete entry.metricsTimer;
      if (selectedResourceIdRef.current === resourceId) setTransportSnapshot(snapshot);
      if (snapshot.state === "closed" || snapshot.state === "detached" || snapshot.state === "failed") {
        releaseTransport(resourceId);
        void loadInventory(expectedIdentity, generation);
      }
      return;
    }
    if (entry.metricsTimer) return;
    entry.metricsTimer = setTimeout(() => {
      delete entry.metricsTimer;
      if (
        attachedTerminalsRef.current.get(resourceId)?.transport === transport &&
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) {
        if (selectedResourceIdRef.current === resourceId) {
          setTransportSnapshot(entry.latestSnapshot);
        }
      }
    }, METRICS_UPDATE_MILLISECONDS);
  }), [isCurrent, loadInventory, releaseTransport]);

  const activateTransport = useCallback(async (
    transport: SessionShellTransport,
    resourceId: string,
    expectedIdentity: string,
    generation: number,
  ): Promise<void> => {
    const snapshot = transport.getSnapshot();
    const existing = attachedTerminalsRef.current.get(resourceId);
    if (existing) releaseTransport(resourceId, "detach");
    const entry: AttachedTerminal = {
      resourceId,
      transport,
      terminalRef: createRef<GhosttyTerminalHandle>(),
      latestSnapshot: snapshot,
    };
    attachedTerminalsRef.current.set(resourceId, entry);
    setTransportSnapshot(snapshot);
    const unsubscribeState = subscribeToTransportState(
      transport,
      resourceId,
      expectedIdentity,
      generation,
    );
    if (attachedTerminalsRef.current.get(resourceId) === entry) {
      entry.unsubscribeState = unsubscribeState;
    } else {
      unsubscribeState();
    }
    selectedResourceIdRef.current = resourceId;
    setSelectedResourceId(resourceId);
    pendingTerminalFocusResourceIdRef.current = resourceId;
    setAttachedTerminalsRevision((revision) => revision + 1);
    setIsShellListOpen(false);
    setTransferredPreferredResourceId(undefined);
    await loadInventory(expectedIdentity, generation);
  }, [loadInventory, releaseTransport, subscribeToTransportState]);

  const attachWithTicket = useCallback(async (
    resourceId: string,
    attachmentToken: string,
    canResize: boolean,
    expectedIdentity = routeIdentity,
    generation = lifecycleGenerationRef.current,
  ): Promise<void> => {
    setIsAttaching(true);
    setError(undefined);
    try {
      const transport = await SessionShellTransport.open({
        attachmentToken,
        expectedResourceId: resourceId,
        canResize,
        isCurrent: () => (
          generation === lifecycleGenerationRef.current &&
          isCurrent(expectedIdentity)
        ),
      });
      if (
        generation !== lifecycleGenerationRef.current ||
        !isCurrent(expectedIdentity)
      ) {
        transport.detach();
        return;
      }
      await activateTransport(transport, resourceId, expectedIdentity, generation);
    } catch (caught) {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setError(errorMessage(caught));
    } finally {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setIsAttaching(false);
    }
  }, [activateTransport, isCurrent, routeIdentity]);

  const startShell = useCallback(async () => {
    const generation = lifecycleGenerationRef.current;
    const expectedIdentity = routeIdentity;
    setIsStarting(true);
    setError(undefined);
    try {
      const result = await window.sliver.prepareSessionShell(defaultSessionShellInput(session.os));
      if (
        generation !== lifecycleGenerationRef.current ||
        !isCurrent(expectedIdentity)
      ) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "The shell could not be prepared");
      await attachWithTicket(
        result.value.resourceId,
        result.value.attachment.attachmentToken,
        result.value.canResize,
        expectedIdentity,
        generation,
      );
    } catch (caught) {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setError(errorMessage(caught));
    } finally {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setIsStarting(false);
    }
  }, [attachWithTicket, isCurrent, routeIdentity, session.os]);

  const startAttachmentPump = useCallback((
    expectedIdentity = routeIdentity,
    generation = lifecycleGenerationRef.current,
  ): void => {
    const existing = attachmentPumpRef.current;
    if (existing?.generation === generation) return;

    let pump!: Promise<void>;
    pump = (async () => {
      setIsAttaching(true);
      setError(undefined);
      while (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) {
        const resourceId = desiredAttachmentResourceIdRef.current;
        if (!resourceId) break;

        const attached = attachedTerminalsRef.current.get(resourceId);
        if (attached) {
          desiredAttachmentResourceIdRef.current = undefined;
          pendingTerminalFocusResourceIdRef.current = resourceId;
          setTransportSnapshot(attached.latestSnapshot);
          setIsShellListOpen(false);
          focusAttachedResource(attached);
          break;
        }

        const resource = inventoryRef.current?.resources.find((candidate) => candidate.resourceId === resourceId);
        if (!resource) {
          if (desiredAttachmentResourceIdRef.current === resourceId) {
            desiredAttachmentResourceIdRef.current = undefined;
            setError("The selected managed shell is no longer available");
          }
          continue;
        }
        if (resource.state !== "detached") {
          if (desiredAttachmentResourceIdRef.current === resourceId) {
            desiredAttachmentResourceIdRef.current = undefined;
            setError(`Only a detached shell can be attached (${shellStateLabel(resource.state)})`);
          }
          continue;
        }

        let attachmentResult;
        try {
          attachmentResult = await window.sliver.actOnSessionShell({
            resourceId,
            action: "attach",
          });
        } catch (caught) {
          if (
            generation === lifecycleGenerationRef.current &&
            isCurrent(expectedIdentity) &&
            desiredAttachmentResourceIdRef.current === resourceId
          ) {
            desiredAttachmentResourceIdRef.current = undefined;
            setError(errorMessage(caught));
          }
          continue;
        }
        if (
          generation !== lifecycleGenerationRef.current ||
          !isCurrent(expectedIdentity)
        ) break;
        if (!attachmentResult.ok || !attachmentResult.value?.attachment) {
          if (desiredAttachmentResourceIdRef.current === resourceId) {
            desiredAttachmentResourceIdRef.current = undefined;
            setError(attachmentResult.error ?? "The managed shell could not be attached");
          }
          continue;
        }

        let transport: SessionShellTransport;
        try {
          // Selection freshness is intentionally checked after open. Once main
          // has issued a one-use ticket it must be consumed even when a newer
          // row wins, otherwise the resource remains ticket-locked until TTL.
          transport = await SessionShellTransport.open({
            attachmentToken: attachmentResult.value.attachment.attachmentToken,
            expectedResourceId: resourceId,
            canResize: attachmentResult.value.resource?.canResize ?? resource.canResize,
            isCurrent: () => (
              generation === lifecycleGenerationRef.current &&
              isCurrent(expectedIdentity)
            ),
          });
        } catch (caught) {
          if (
            generation === lifecycleGenerationRef.current &&
            isCurrent(expectedIdentity) &&
            desiredAttachmentResourceIdRef.current === resourceId
          ) {
            desiredAttachmentResourceIdRef.current = undefined;
            setError(errorMessage(caught));
          }
          continue;
        }
        if (
          generation !== lifecycleGenerationRef.current ||
          !isCurrent(expectedIdentity)
        ) {
          transport.detach();
          break;
        }

        if (desiredAttachmentResourceIdRef.current !== resourceId) {
          try {
            await window.sliver.actOnSessionShell({ resourceId, action: "detach" });
          } catch {
            // The local capability is still revoked below. This stale intent
            // must never surface an error over the latest operator selection.
          } finally {
            transport.detach();
          }
          if (
            generation === lifecycleGenerationRef.current &&
            isCurrent(expectedIdentity)
          ) await loadInventory(expectedIdentity, generation);
          continue;
        }

        await activateTransport(transport, resourceId, expectedIdentity, generation);
        if (desiredAttachmentResourceIdRef.current === resourceId) {
          desiredAttachmentResourceIdRef.current = undefined;
        }
      }
    })().finally(() => {
      if (attachmentPumpRef.current?.promise !== pump) return;
      attachmentPumpRef.current = undefined;
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) {
        setIsAttaching(false);
        if (desiredAttachmentResourceIdRef.current) {
          queueMicrotask(() => startAttachmentPumpRef.current?.(expectedIdentity, generation));
        }
      }
    });
    attachmentPumpRef.current = { generation, promise: pump };
  }, [activateTransport, focusAttachedResource, isCurrent, loadInventory, routeIdentity]);
  startAttachmentPumpRef.current = startAttachmentPump;

  const selectAndAttach = useCallback((resourceId: string): void => {
    const previous = selectedResourceIdRef.current;
    if (previous && previous !== resourceId) {
      const focused = document.activeElement;
      const focusedTerminal = focused instanceof Element
        ? focused.closest<HTMLElement>("[data-shell-terminal-resource-id]")
        : null;
      if (focusedTerminal?.dataset["shellTerminalResourceId"] === previous && focused instanceof HTMLElement) {
        focused.blur();
      }
    }
    selectedResourceIdRef.current = resourceId;
    setSelectedResourceId(resourceId);

    const attached = attachedTerminalsRef.current.get(resourceId);
    if (attached) {
      pendingTerminalFocusResourceIdRef.current = resourceId;
      desiredAttachmentResourceIdRef.current = undefined;
      setTransportSnapshot(attached.latestSnapshot);
      setIsShellListOpen(false);
      focusAttachedResource(attached);
      return;
    }
    if (
      desiredAttachmentResourceIdRef.current === resourceId &&
      attachmentPumpRef.current?.generation === lifecycleGenerationRef.current
    ) return;

    const resource = inventoryRef.current?.resources.find((candidate) => candidate.resourceId === resourceId);
    if (!resource) {
      setError("The selected managed shell is no longer available");
      return;
    }
    if (resource.state !== "detached") {
      desiredAttachmentResourceIdRef.current = undefined;
      setError(`Only a detached shell can be attached (${shellStateLabel(resource.state)})`);
      return;
    }

    desiredAttachmentResourceIdRef.current = resourceId;
    setError(undefined);
    startAttachmentPump(routeIdentity, lifecycleGenerationRef.current);
  }, [focusAttachedResource, routeIdentity, startAttachmentPump]);

  useEffect(() => {
    if (!preferredResourceId || panelStatus !== "ready" || !inventory) return;
    const key = `${routeIdentity}:${preferredResourceId}`;
    if (preferredAttachmentKeyRef.current === key) return;
    if (!inventory.resources.some((resource) => resource.resourceId === preferredResourceId)) return;
    preferredAttachmentKeyRef.current = key;
    selectAndAttach(preferredResourceId);
  }, [inventory, panelStatus, preferredResourceId, routeIdentity, selectAndAttach]);

  useEffect(() => {
    if (!transferredPreferredResourceId || panelStatus !== "ready" || !inventory) return;
    if (!inventory.resources.some((resource) => resource.resourceId === transferredPreferredResourceId)) return;
    setTransferredPreferredResourceId(undefined);
    selectAndAttach(transferredPreferredResourceId);
  }, [inventory, panelStatus, selectAndAttach, transferredPreferredResourceId]);

  useEffect(() => window.sliver.onSessionShellsChanged((preferred) => {
    const generation = lifecycleGenerationRef.current;
    const expectedIdentity = routeIdentity;
    if (preferred) setTransferredPreferredResourceId(preferred);
    void loadInventory(expectedIdentity, generation);
  }), [loadInventory, routeIdentity]);

  const popOut = useCallback(async (): Promise<void> => {
    if (!onPopOut) return;
    const generation = lifecycleGenerationRef.current;
    const expectedIdentity = routeIdentity;
    setIsPoppingOut(true);
    setError(undefined);
    try {
      await onPopOut(selectedResourceIdRef.current);
    } catch (caught) {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setError(errorMessage(caught));
    } finally {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setIsPoppingOut(false);
    }
  }, [isCurrent, onPopOut, routeIdentity]);

  const runResourceAction = useCallback(async (
    resourceId: string,
    action: SessionShellResourceAction,
  ) => {
    const generation = lifecycleGenerationRef.current;
    const expectedIdentity = routeIdentity;
    setActiveAction(action);
    setError(undefined);
    try {
      const result = await window.sliver.actOnSessionShell({ resourceId, action });
      if (
        generation !== lifecycleGenerationRef.current ||
        !isCurrent(expectedIdentity)
      ) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? `The shell could not be ${action}ed`);
      if (action !== "attach") {
        releaseTransport(resourceId, action === "detach" ? "detach" : "close");
      }
      setPendingResourceAction(undefined);
      await loadInventory(expectedIdentity, generation);
    } catch (caught) {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setError(errorMessage(caught));
    } finally {
      if (
        generation === lifecycleGenerationRef.current &&
        isCurrent(expectedIdentity)
      ) setActiveAction(undefined);
    }
  }, [isCurrent, loadInventory, releaseTransport, routeIdentity]);

  const copySelection = useCallback(async () => {
    try {
      requireActiveClipboardGesture();
      const selection = selectedTerminalHandle(attachedTerminalsRef.current, selectedResourceIdRef.current)
        ?.getSelection() ?? "";
      if (!selection) {
        toast.warning("Nothing selected", { description: "Select terminal text before copying." });
        return;
      }
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard write is unavailable");
      await navigator.clipboard.writeText(selection);
      toast.success("Selection copied");
    } catch (caught) {
      toast.danger("Could not copy selection", { description: errorMessage(caught) });
    }
  }, []);

  const stagePaste = useCallback((
    text: string,
    resourceId: string,
    entry: AttachedTerminal,
    expectedIdentity: string,
  ): void => {
    if (
      !isCurrent(expectedIdentity) ||
      selectedResourceIdRef.current !== resourceId ||
      attachedTerminalsRef.current.get(resourceId) !== entry
    ) return;

    const review = inspectPaste(text);
    if (review.bytes === 0) {
      toast.warning("Clipboard is empty");
      return;
    }
    if (review.bytes > MAX_PASTE_BYTES) throw new Error(`Clipboard text exceeds ${MAX_PASTE_BYTES} bytes`);
    if (text.includes("\0")) throw new Error("Clipboard text contains a NUL byte");
    if (requiresPasteConfirmation(review)) {
      pendingPasteRef.current = { entry, resourceId, routeIdentity: expectedIdentity, text };
      setPasteReview(review);
      return;
    }
    entry.terminalRef.current?.paste(text);
    entry.terminalRef.current?.focus();
  }, [isCurrent]);

  const requestPaste = useCallback(async () => {
    const expectedIdentity = routeIdentity;
    const resourceId = selectedResourceIdRef.current;
    const entry = resourceId ? attachedTerminalsRef.current.get(resourceId) : undefined;
    if (!resourceId || !entry || !isCurrent(expectedIdentity)) return;
    try {
      requireActiveClipboardGesture();
      if (!navigator.clipboard?.readText) throw new Error("Clipboard read is unavailable");
      const text = await navigator.clipboard.readText();
      stagePaste(text, resourceId, entry, expectedIdentity);
    } catch (caught) {
      toast.danger("Could not paste", { description: errorMessage(caught) });
    }
  }, [isCurrent, routeIdentity, stagePaste]);

  const confirmPaste = useCallback(() => {
    const pending = pendingPasteRef.current;
    pendingPasteRef.current = undefined;
    setPasteReview(undefined);
    if (
      !pending ||
      !isCurrent(pending.routeIdentity) ||
      selectedResourceIdRef.current !== pending.resourceId ||
      attachedTerminalsRef.current.get(pending.resourceId) !== pending.entry
    ) return;
    try {
      pending.entry.terminalRef.current?.paste(pending.text);
      pending.entry.terminalRef.current?.focus();
    } catch (caught) {
      toast.danger("Could not paste", { description: errorMessage(caught) });
    }
  }, [isCurrent]);

  const resources = useMemo(() => (
    [...(inventory?.resources ?? [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  ), [inventory?.resources]);
  const selectedResource = resources.find((resource) => resource.resourceId === selectedResourceId);
  const isDedicated = presentation === "dedicated";
  const attachedTerminals = useMemo(
    () => [...attachedTerminalsRef.current.values()],
    [attachedTerminalsRevision],
  );
  const activeResourceId = selectedResourceId && attachedTerminalsRef.current.has(selectedResourceId)
    ? selectedResourceId
    : undefined;
  const runtime = runtimeRef.current;
  const terminalAppearance = useMemo(() => applicationSettings
    ? applicationTerminalAppearance(
        applicationSettings.settings.terminal,
        applicationSettings.resolvedTheme,
        applicationSettings.settings.reduceMotion,
        applicationSettings.ghosttyConfig,
      )
    : undefined, [applicationSettings]);
  const terminals = runtime ? attachedTerminals.map((entry) => {
    const isSelected = entry.resourceId === selectedResourceId;
    return (
      <div
        key={entry.resourceId}
        aria-hidden={!isSelected}
        className={isSelected
          ? "relative h-full min-h-0 w-full"
          : "pointer-events-none invisible absolute inset-0 h-full min-h-0 w-full"}
        data-shell-terminal-resource-id={entry.resourceId}
        inert={isSelected ? undefined : true}
      >
        <GhosttyTerminal
          ref={entry.terminalRef}
          {...(terminalAppearance ? { appearance: terminalAppearance } : {})}
          ariaLabel={`Interactive shell for ${session.name || session.hostname || session.id}`}
          enableClipboard
          pipedWindowsInput={isWindows(session.os)}
          transport={entry.transport}
          wasmBytes={runtime.bytes}
          onClipboardPaste={(text) => {
            stagePaste(text, entry.resourceId, entry, routeIdentity);
          }}
          onReady={() => {
            if (
              pendingTerminalFocusResourceIdRef.current !== entry.resourceId ||
              selectedResourceIdRef.current !== entry.resourceId ||
              attachedTerminalsRef.current.get(entry.resourceId) !== entry ||
              !isCurrent()
            ) return;
            pendingTerminalFocusResourceIdRef.current = undefined;
            focusAttachedResource(entry);
          }}
          onError={(terminalError) => {
            if (!isCurrent() || attachedTerminalsRef.current.get(entry.resourceId) !== entry) return;
            setError(terminalError.message);
            // A verified-runtime or terminal initialization failure leaves no
            // usable operator surface. Close only the exact attached capability;
            // sibling managed terminals remain mounted and isolated.
            releaseTransport(entry.resourceId, "close");
          }}
        />
      </div>
    );
  }) : null;

  const shellList = (
    <ShellList
      aggregate={inventory}
      isLoading={panelStatus === "loading"}
      resources={resources}
      selectedResourceId={selectedResourceId}
      isInteractionDisabled={isStarting}
      onSelect={selectAndAttach}
    />
  );

  const terminalSurface = (
    <TerminalSurface
      activeResourceId={activeResourceId}
      error={error}
      isAttaching={isAttaching}
      isStarting={isStarting}
      isWide={isWide}
      panelStatus={panelStatus}
      selectedResource={selectedResource}
      session={session}
      terminals={terminals}
      transportSnapshot={transportSnapshot}
      onCopy={() => void copySelection()}
      onDetach={() => {
        if (selectedResource) void runResourceAction(selectedResource.resourceId, "detach");
      }}
      onOpenShellList={() => setIsShellListOpen(true)}
      onPaste={() => void requestPaste()}
      onRequestClose={(resourceId) => setPendingResourceAction({ resourceId, action: "close" })}
      onRequestKill={(resourceId) => setPendingResourceAction({ resourceId, action: "kill" })}
      onStart={() => void startShell()}
    />
  );

  return (
    <section
      aria-labelledby="session-shells-heading"
      className={isDedicated
        ? "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface"
        : "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl bg-surface"}
      data-presentation={presentation}
    >
      <div className="flex shrink-0 flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="section-icon"><FontAwesomeIcon aria-hidden icon={faTerminal} /></span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground" id="session-shells-heading">Managed Shells</h2>
            <p className="text-xs text-muted">Bounded, session-only interactive streams owned by this window.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onPopOut && !isDedicated ? (
            <Tooltip delay={250}>
              <Button
                aria-label="Pop out managed shells"
                isDisabled={isStarting || isAttaching}
                isIconOnly
                isPending={isPoppingOut}
                size="sm"
                variant="ghost"
                onPress={() => void popOut()}
              >
                <FontAwesomeIcon aria-hidden icon={faUpRightFromSquare} />
              </Button>
              <Tooltip.Content>Pop out managed shells</Tooltip.Content>
            </Tooltip>
          ) : null}
          <Button
            isDisabled={isAttaching || isPoppingOut}
            isPending={isStarting}
            size="sm"
            variant="primary"
            onPress={() => void startShell()}
          >
            New shell
          </Button>
        </div>
      </div>

      {error ? (
        <div className="bg-danger-soft px-5 py-3 text-xs text-danger-soft-foreground sm:px-6" role="alert">
          {error}
        </div>
      ) : null}

      {isWide ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-background">
          <Resizable autoSaveId="sliver:session-shell-workspace" orientation="horizontal">
            <Resizable.Panel
              defaultSize="288px"
              groupResizeBehavior="preserve-pixel-size"
              maxSize="420px"
              minSize="240px"
            >
              {shellList}
            </Resizable.Panel>
            <Resizable.Handle type="line" variant="secondary" withIndicator />
            <Resizable.Panel minSize={45}>{terminalSurface}</Resizable.Panel>
          </Resizable>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden bg-background">
          {terminalSurface}
        </div>
      )}

      {!isWide ? (
        <Sheet isOpen={isShellListOpen} placement="right" onOpenChange={setIsShellListOpen}>
          <Sheet.Backdrop variant="blur">
            <Sheet.Content className="h-full w-[min(88vw,360px)]">
              <Sheet.Dialog className="h-full">
                <Sheet.CloseTrigger />
                <Sheet.Header>
                  <Sheet.Heading>Managed Shells</Sheet.Heading>
                </Sheet.Header>
                <Sheet.Body className="min-h-0 p-0">{shellList}</Sheet.Body>
              </Sheet.Dialog>
            </Sheet.Content>
          </Sheet.Backdrop>
        </Sheet>
      ) : null}

      <ResourceActionDialog
        action={pendingResourceAction}
        isPending={activeAction === pendingResourceAction?.action}
        onCancel={() => {
          if (!activeAction) setPendingResourceAction(undefined);
        }}
        onConfirm={(pending) => void runResourceAction(pending.resourceId, pending.action)}
      />
      <PasteReviewDialog
        review={pasteReview}
        onCancel={() => {
          pendingPasteRef.current = undefined;
          setPasteReview(undefined);
        }}
        onConfirm={confirmPaste}
      />
    </section>
  );
}

function ShellList({
  aggregate,
  isInteractionDisabled,
  isLoading,
  resources,
  selectedResourceId,
  onSelect,
}: {
  aggregate: SessionShellResourceList | undefined;
  isInteractionDisabled: boolean;
  isLoading: boolean;
  resources: readonly SessionShellResource[];
  selectedResourceId: string | undefined;
  onSelect: (resourceId: string) => void;
}): React.JSX.Element {
  const selection = useMemo<Selection>(() => (
    selectedResourceId ? new Set([selectedResourceId]) : new Set()
  ), [selectedResourceId]);
  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface-secondary" aria-label="Managed shell inventory">
      <div className="px-4 pb-3 pt-4">
        <p className="text-sm font-medium text-foreground">Shells</p>
        <p className="mt-0.5 text-xs tabular-nums text-muted">
          {aggregate ? `${aggregate.metrics.activeStreams} active · ${aggregate.metrics.detachedStreams} detached` : "Window-scoped inventory"}
        </p>
      </div>
      <ScrollShadow className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" hideScrollBar={false}>
        <ListView
          aria-label="Managed shells"
          disabledKeys={isInteractionDisabled ? resources.map((resource) => resource.resourceId) : []}
          items={resources}
          renderEmptyState={() => (
            <EmptyState className="min-h-64 px-4 py-10" size="sm">
              <EmptyState.Header>
                <EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faTerminal} /></EmptyState.Media>
                <EmptyState.Title>{isLoading ? "Loading shells" : "No managed shells"}</EmptyState.Title>
                <EmptyState.Description>
                  {isLoading ? "Reading this window’s bounded stream inventory…" : "Start a shell to create a session-only managed stream."}
                </EmptyState.Description>
              </EmptyState.Header>
            </EmptyState>
          )}
          selectedKeys={selection}
          selectionBehavior="replace"
          selectionMode="single"
          variant="secondary"
          onAction={(key) => onSelect(String(key))}
          onSelectionChange={(keys) => {
            if (keys === "all") return;
            const key = [...keys][0];
            if (key !== undefined) onSelect(String(key));
          }}
        >
          {(resource) => (
            <ListView.Item
              id={resource.resourceId}
              textValue={shellListTitle(resources, resource)}
              onPress={() => onSelect(resource.resourceId)}
            >
              <ListView.ItemContent>
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${shellStateDot(resource.state)}`} />
                <div className="flex min-w-0 flex-col">
                  <ListView.Title>{shellListTitle(resources, resource)}</ListView.Title>
                  <ListView.Description>
                    {shellStateLabel(resource.state)} · {ptyLabel(resource.pty)}
                  </ListView.Description>
                </div>
              </ListView.ItemContent>
              <ListView.ItemAction>
                <span className="text-[11px] tabular-nums text-muted">{formatShortTime(resource.lastActivityAt)}</span>
              </ListView.ItemAction>
            </ListView.Item>
          )}
        </ListView>
      </ScrollShadow>
      <p className="px-4 py-3 text-[11px] leading-relaxed text-muted">
        Payload bytes stay inside the terminal transport and are never added to activity history.
      </p>
    </aside>
  );
}

function TerminalSurface({
  activeResourceId,
  error,
  isAttaching,
  isStarting,
  isWide,
  panelStatus,
  selectedResource,
  session,
  terminals,
  transportSnapshot,
  onCopy,
  onDetach,
  onOpenShellList,
  onPaste,
  onRequestClose,
  onRequestKill,
  onStart,
}: {
  activeResourceId: string | undefined;
  error: string | undefined;
  isAttaching: boolean;
  isStarting: boolean;
  isWide: boolean;
  panelStatus: PanelStatus;
  selectedResource: SessionShellResource | undefined;
  session: SessionSummary;
  terminals: React.ReactNode;
  transportSnapshot: SessionShellTransportSnapshot;
  onCopy: () => void;
  onDetach: () => void;
  onOpenShellList: () => void;
  onPaste: () => void;
  onRequestClose: (resourceId: string) => void;
  onRequestKill: (resourceId: string) => void;
  onStart: () => void;
}): React.JSX.Element {
  const isAttached = Boolean(selectedResource && activeResourceId === selectedResource.resourceId);
  const isBusy = isStarting || isAttaching;
  const [isStatisticsOpen, setIsStatisticsOpen] = useState(false);
  const statisticsTriggerRef = useRef<HTMLButtonElement>(null);
  const updateStatisticsOpen = useCallback((open: boolean) => {
    setIsStatisticsOpen(open);
    if (!open) {
      window.requestAnimationFrame(() => statisticsTriggerRef.current?.focus());
    }
  }, []);
  useEffect(() => setIsStatisticsOpen(false), [selectedResource?.resourceId]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background" data-terminal-surface>
      <div className="flex shrink-0 flex-col gap-3 bg-surface px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          {!isWide ? (
            <Button size="sm" variant="secondary" onPress={onOpenShellList}>Shells</Button>
          ) : null}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-medium text-foreground">
                {selectedResource ? "Interactive Session Shell" : "Terminal"}
              </p>
              {selectedResource ? (
                <Chip
                  color={shellStateColor(isAttached ? transportSnapshot.state : isAttaching ? "connecting" : selectedResource.state)}
                  size="sm"
                  variant="soft"
                >
                  {isAttached
                    ? transportStateLabel(transportSnapshot.state)
                    : isAttaching
                      ? "Connecting"
                      : shellStateLabel(selectedResource.state)}
                </Chip>
              ) : null}
              {isAttached && transportSnapshot.pressure === "high" ? (
                <Chip color="warning" size="sm" variant="soft">Backpressure</Chip>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {selectedResource ? `${ptyLabel(selectedResource.pty)} · ${resizeLabel(session, selectedResource)}` : "Select a managed shell or start a new one."}
            </p>
          </div>
        </div>
        <Toolbar aria-label="Terminal actions" className="flex-wrap gap-1">
          {selectedResource ? (
            <Button ref={statisticsTriggerRef} size="sm" variant="ghost" onPress={() => setIsStatisticsOpen(true)}>Stats</Button>
          ) : null}
          {isAttached ? (
            <>
              <Button size="sm" variant="ghost" onPress={onCopy}>Copy</Button>
              <Button size="sm" variant="ghost" onPress={onPaste}>Paste</Button>
              <Button isDisabled={isBusy} size="sm" variant="secondary" onPress={onDetach}>Detach</Button>
            </>
          ) : null}
          {selectedResource ? (
            <>
              <Button
                isDisabled={isBusy}
                size="sm"
                variant="danger-soft"
                onPress={() => onRequestClose(selectedResource.resourceId)}
              >
                Close
              </Button>
              <Button
                isDisabled={isBusy || !selectedResource.canKill}
                size="sm"
                variant="danger-soft"
                onPress={() => onRequestKill(selectedResource.resourceId)}
              >
                Kill
              </Button>
            </>
          ) : null}
        </Toolbar>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          {terminals}
          {!isAttached ? (
            <EmptyState className="h-full min-h-0 px-6 py-12">
              <EmptyState.Header>
                <EmptyState.Media variant="icon">
                  <FontAwesomeIcon aria-hidden icon={error || panelStatus === "error" ? faTriangleExclamation : faTerminal} />
                </EmptyState.Media>
                <EmptyState.Title>
                  {panelStatus === "loading"
                    ? "Loading terminal runtime"
                    : isAttaching && selectedResource
                      ? "Attaching shell"
                      : selectedResource
                      ? "Shell is not attached"
                      : "No shell selected"}
                </EmptyState.Title>
                <EmptyState.Description className="max-w-md text-pretty">
                  {panelStatus === "loading"
                    ? "Verifying the pinned Ghostty runtime and this window’s managed streams…"
                    : isAttaching && selectedResource
                      ? "Opening the selected managed shell and its bounded terminal stream…"
                      : selectedResource
                      ? "Select this shell again from the managed shell inventory to retry attachment."
                      : "Start a session shell or select an existing detached shell from the inventory."}
                </EmptyState.Description>
              </EmptyState.Header>
              <EmptyState.Content>
                {!selectedResource && panelStatus !== "loading" ? (
                  <Button isPending={isStarting} onPress={onStart}>New shell</Button>
                ) : null}
              </EmptyState.Content>
            </EmptyState>
          ) : null}
        </div>
      </div>

      <Modal.Backdrop isOpen={isStatisticsOpen && selectedResource !== undefined} variant="blur" onOpenChange={updateStatisticsOpen}>
        <Modal.Container placement="center" size="sm">
          <Modal.Dialog className="sm:max-w-[420px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Shell statistics</Modal.Heading>
              <p className="mt-1 text-sm text-muted">Live, metadata-only counters for the selected managed shell.</p>
            </Modal.Header>
            <Modal.Body>
              {selectedResource ? (
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
                  <Metric label="Input queued" value={formatBytes(isAttached ? transportSnapshot.queuedInputBytes : selectedResource.metrics.queuedInputBytes)} />
                  <Metric label="Output queued" value={formatBytes(isAttached ? transportSnapshot.queuedOutputBytes : selectedResource.metrics.queuedOutputBytes)} />
                  <Metric label="Bytes in" value={formatCount(isAttached ? transportSnapshot.bytesFromRemote : selectedResource.metrics.bytesToRenderer)} />
                  <Metric label="Bytes out" value={formatCount(isAttached ? transportSnapshot.bytesToRemote : selectedResource.metrics.bytesFromRenderer)} />
                </dl>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" size="sm" variant="secondary">Close</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}

function ResourceActionDialog({
  action,
  isPending,
  onCancel,
  onConfirm,
}: {
  action: PendingResourceAction | undefined;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: (action: PendingResourceAction) => void;
}): React.JSX.Element {
  return (
    <AlertDialog.Backdrop
      isOpen={action !== undefined}
      variant="blur"
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog className="sm:max-w-[420px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /></AlertDialog.Icon>
            <AlertDialog.Heading>{action?.action === "kill" ? "Kill this shell process?" : "Close this managed shell?"}</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm leading-relaxed text-muted">
              {action?.action === "kill"
                ? "This requests termination of the remote shell process. Its exit outcome may be unknown if the session disconnects."
                : "This closes the local managed stream and sends bounded best-effort exit and logout requests before closing the transport. It does not confirm remote process termination. Detached scrollback cannot be recovered."}
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={isPending} size="sm" variant="tertiary" onPress={onCancel}>Cancel</Button>
            <Button
              isPending={isPending}
              size="sm"
              variant="danger"
              onPress={() => {
                if (action) onConfirm(action);
              }}
            >
              {action?.action === "kill" ? "Kill process" : "Close shell"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function PasteReviewDialog({
  review,
  onCancel,
  onConfirm,
}: {
  review: PasteReview | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog.Backdrop
      isOpen={review !== undefined}
      variant="blur"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog className="sm:max-w-[420px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /></AlertDialog.Icon>
            <AlertDialog.Heading>Paste reviewed clipboard text?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm leading-relaxed text-muted">
              The clipboard contains {review?.lines ?? 0} lines and {review?.controlCharacters ?? 0} control characters ({formatBytes(review?.bytes ?? 0)}). Its contents are intentionally hidden. Pasting may execute multiple commands.
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button size="sm" variant="tertiary" onPress={onCancel}>Cancel</Button>
            <Button size="sm" variant="primary" onPress={onConfirm}>Paste anyway</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

export function defaultSessionShellInput(os: string): PrepareSessionShellInput {
  if (isWindows(os)) return Object.freeze({ requestPty: false });
  return Object.freeze({
    requestPty: true,
    rows: DEFAULT_ROWS,
    columns: DEFAULT_COLUMNS,
  });
}

export function inspectPaste(text: string): PasteReview {
  const controlCharacters = [...text].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  }).length;
  return Object.freeze({
    bytes: new TextEncoder().encode(text).byteLength,
    lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
    controlCharacters,
  });
}

export function requiresPasteConfirmation(review: PasteReview): boolean {
  return review.lines > 1 || review.controlCharacters > 0;
}

async function loadCachedTerminalRuntime(): Promise<TerminalRuntimeAsset> {
  if (cachedTerminalRuntime) return cachedTerminalRuntime;
  if (pendingTerminalRuntime) return pendingTerminalRuntime;

  const request = window.sliver.getTerminalRuntime()
    .then((result) => {
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "Terminal runtime is unavailable");
      }
      const source = result.value.bytes;
      const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
      bytes.set(source);
      cachedTerminalRuntime = Object.freeze({
        version: result.value.version,
        sha256: result.value.sha256,
        bytes,
      });
      return cachedTerminalRuntime;
    })
    .catch((error: unknown) => {
      cachedTerminalRuntime = undefined;
      throw error;
    })
    .finally(() => {
      if (pendingTerminalRuntime === request) pendingTerminalRuntime = undefined;
    });
  pendingTerminalRuntime = request;
  return request;
}

/** Renderer-window cache control for isolated tests. Production retains the
 * verified inert WASM for the lifetime of this renderer document. */
export function clearSessionTerminalRuntimeCacheForTests(): void {
  cachedTerminalRuntime = undefined;
  pendingTerminalRuntime = undefined;
}

function terminalRouteIdentity(route: SessionTerminalRoute): string {
  return `${route.backendEpoch}:${route.connectionIncarnation}:session:${route.sessionId}:${route.targetFingerprint}`;
}

function chooseSelectedResource(
  resources: readonly SessionShellResource[],
  current: string | undefined,
): string | undefined {
  if (current && resources.some((resource) => resource.resourceId === current)) return current;
  return undefined;
}

function selectedTerminalHandle(
  terminals: ReadonlyMap<string, AttachedTerminal>,
  resourceId: string | undefined,
): GhosttyTerminalHandle | null | undefined {
  return resourceId ? terminals.get(resourceId)?.terminalRef.current : undefined;
}

function shellListTitle(resources: readonly SessionShellResource[], resource: SessionShellResource): string {
  return `Shell ${Math.max(1, resources.findIndex((candidate) => candidate.resourceId === resource.resourceId) + 1)}`;
}

function shellStateLabel(state: SessionShellResource["state"]): string {
  switch (state) {
    case "prepared": return "Prepared";
    case "handshaking": return "Handshaking";
    case "opening": return "Opening";
    case "attached": return "Attached";
    case "detached": return "Detached";
    case "closing": return "Closing";
  }
}

function transportStateLabel(state: SessionShellTransportSnapshot["state"]): string {
  switch (state) {
    case "connecting": return "Connecting";
    case "opening": return "Opening";
    case "attached": return "Attached";
    case "detached": return "Detached";
    case "closed": return "Closed";
    case "failed": return "Failed";
  }
}

function shellStateColor(
  state: SessionShellResource["state"] | SessionShellTransportSnapshot["state"],
): "default" | "success" | "warning" | "danger" {
  if (state === "attached") return "success";
  if (state === "closing" || state === "opening" || state === "handshaking" || state === "connecting") return "warning";
  if (state === "failed") return "danger";
  return "default";
}

function shellStateDot(state: SessionShellResource["state"]): string {
  if (state === "attached") return "bg-success";
  if (state === "closing" || state === "opening" || state === "handshaking") return "bg-warning";
  return "bg-muted";
}

function ptyLabel(pty: SessionShellResource["pty"]): string {
  return pty === "requested-unconfirmed" ? "PTY requested · unconfirmed" : "Non-PTY";
}

function resizeLabel(session: SessionSummary, resource: SessionShellResource): string {
  if (isWindows(session.os)) return "Windows resize unavailable";
  return resource.canResize ? "Resize requested · unconfirmed" : "Resize unavailable";
}

function isWindows(os: string): boolean {
  return os.toLocaleLowerCase().includes("windows");
}

function requireActiveClipboardGesture(): void {
  if (navigator.userActivation && !navigator.userActivation.isActive) {
    throw new Error("Clipboard access requires an explicit operator action");
  }
}

function formatShortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function formatCount(value: string): string {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) return value;
  return new Intl.NumberFormat().format(count);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useMediaQuery(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query]);
  return matches;
}
