import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AlertDialog, Button, ProgressBar, toast } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowsRotate,
  faCircleCheck,
  faCircleInfo,
  faDownload,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";

import {
  parseApplicationUpdateState,
  type ApplicationUpdateState,
} from "../../../shared/application-update-contracts";

export interface ApplicationUpdateStatusProps {
  /** Keep passive controls in the primary workspace, but out of dedicated operator windows. */
  readonly showIdleControl?: boolean;
}

export function ApplicationUpdateStatus({
  showIdleControl = false,
}: ApplicationUpdateStatusProps): React.JSX.Element | null {
  const [state, setState] = useState<ApplicationUpdateState>();
  const [isChecking, setIsChecking] = useState(false);
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [toastStore] = useState(createUpdateToastStore);
  const highestRevision = useRef(-1);
  const updateToastId = useRef<string | undefined>(undefined);
  const displayedStatus = useRef<ApplicationUpdateState["status"] | undefined>(undefined);
  const dismissedStatus = useRef<ApplicationUpdateState["status"] | undefined>(undefined);
  const unavailableToastId = useRef<string | undefined>(undefined);

  const showUnavailableToast = useCallback((disabledReason: string): void => {
    if (unavailableToastId.current) toast.close(unavailableToastId.current);
    const toastId = toast.info("Updates unavailable", {
      description: disabledReason,
      timeout: 0,
      onClose: () => {
        if (unavailableToastId.current === toastId) unavailableToastId.current = undefined;
      },
    });
    unavailableToastId.current = toastId;
  }, []);

  const acceptState = useCallback((value: unknown, isExplicitCheck = false): boolean => {
    let next: ApplicationUpdateState;
    try {
      next = parseApplicationUpdateState(value);
    } catch {
      return false;
    }
    if (isExplicitCheck && next.status === "disabled") {
      showUnavailableToast(next.disabledReason);
    }
    if (next.revision <= highestRevision.current) return false;
    highestRevision.current = next.revision;
    setState(next);
    return true;
  }, [showUnavailableToast]);

  const checkForUpdates = useCallback(async (): Promise<void> => {
    setIsChecking(true);
    try {
      const result = await window.sliver.checkForApplicationUpdates();
      if (!result.ok || !result.value) {
        toast.danger("Update check failed", {
          description: "Sliver Desktop could not check for an update.",
        });
        return;
      }
      acceptState(result.value);
    } catch {
      toast.danger("Update check failed", {
        description: "Sliver Desktop could not check for an update.",
      });
    } finally {
      setIsChecking(false);
    }
  }, [acceptState]);

  useEffect(() => {
    let mounted = true;
    // Subscribe before reading the snapshot so an event that races the invoke
    // cannot be overwritten by an older get result.
    const unsubscribe = window.sliver.onApplicationUpdateChanged((next) => {
      if (mounted) acceptState(next, true);
    });
    void window.sliver.getApplicationUpdateState().then((next) => {
      if (mounted) acceptState(next);
    }).catch(() => {
      // A missing snapshot is not a reason to widen the renderer contract with
      // an untrusted transport error. A later valid event can still recover it.
    });
    return () => {
      mounted = false;
      unsubscribe();
      if (updateToastId.current) toast.close(updateToastId.current);
      updateToastId.current = undefined;
      if (unavailableToastId.current) toast.close(unavailableToastId.current);
      unavailableToastId.current = undefined;
    };
  }, [acceptState]);

  useEffect(() => {
    toastStore.update(state, isChecking);
  }, [isChecking, state, toastStore]);

  useEffect(() => {
    // HeroUI removes the toast before calling onClose on the next animation
    // frame. Reconcile the queue here so a newer update state is not lost in
    // that interval after the user dismisses the toast.
    if (updateToastId.current &&
        !toast.getQueue().visibleToasts.some(({ key }) => key === updateToastId.current)) {
      updateToastId.current = undefined;
      dismissedStatus.current = displayedStatus.current;
    }
    if (!state || state.status === "disabled" || (!showIdleControl && isPassiveState(state))) {
      if (updateToastId.current) toast.close(updateToastId.current);
      updateToastId.current = undefined;
      return;
    }
    if (updateToastId.current) {
      displayedStatus.current = state.status;
      return;
    }
    if (dismissedStatus.current === state.status) return;

    dismissedStatus.current = undefined;
    const toastId = toast(
      <UpdateToastHeading
        store={toastStore}
        onCheck={() => void checkForUpdates()}
        onRestart={() => setIsRestartDialogOpen(true)}
      />,
      {
        indicator: <UpdateToastIndicator store={toastStore} />,
        description: <UpdateToastContent store={toastStore} />,
        timeout: 0,
        onClose: () => {
          if (updateToastId.current !== toastId) return;
          updateToastId.current = undefined;
          dismissedStatus.current = displayedStatus.current;
        },
      },
    );
    updateToastId.current = toastId;
    displayedStatus.current = state.status;
  }, [checkForUpdates, showIdleControl, state, toastStore]);

  useEffect(() => {
    if (state?.status !== "ready") setIsRestartDialogOpen(false);
  }, [state?.status]);

  const restartToUpdate = useCallback(async (): Promise<void> => {
    setIsRestarting(true);
    try {
      const result = await window.sliver.restartToApplyApplicationUpdate();
      if (!result.ok) {
        toast.danger("Restart failed", {
          description: "Sliver Desktop could not restart to apply the update.",
        });
        return;
      }
      setIsRestartDialogOpen(false);
    } catch {
      toast.danger("Restart failed", {
        description: "Sliver Desktop could not restart to apply the update.",
      });
    } finally {
      setIsRestarting(false);
    }
  }, []);

  if (state?.status !== "ready") return null;

  return (
    <AlertDialog.Backdrop
      isKeyboardDismissDisabled={false}
      isOpen={isRestartDialogOpen}
      onOpenChange={(open) => {
        if (!isRestarting) setIsRestartDialogOpen(open);
      }}
      variant="blur"
    >
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog className="sm:max-w-[440px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning">
              <FontAwesomeIcon aria-hidden className="size-5" icon={faTriangleExclamation} />
            </AlertDialog.Icon>
            <AlertDialog.Heading>Restart to apply the update?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm leading-6 text-muted">
              Restarting closes every Sliver Desktop window and all managed shells. Save any
              terminal output and finish in-flight work before continuing.
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button
              isDisabled={isRestarting}
              size="sm"
              variant="tertiary"
              onPress={() => setIsRestartDialogOpen(false)}
            >
              Later
            </Button>
            <Button
              isPending={isRestarting}
              size="sm"
              variant="danger"
              onPress={() => void restartToUpdate()}
            >
              Restart and update
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

interface UpdateToastStore {
  getSnapshot(): { readonly state: ApplicationUpdateState | undefined; readonly isChecking: boolean };
  subscribe(listener: () => void): () => void;
  update(state: ApplicationUpdateState | undefined, isChecking: boolean): void;
}

function createUpdateToastStore(): UpdateToastStore {
  let snapshot = { state: undefined as ApplicationUpdateState | undefined, isChecking: false };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update: (state, isChecking) => {
      if (snapshot.state === state && snapshot.isChecking === isChecking) return;
      snapshot = { state, isChecking };
      for (const listener of listeners) listener();
    },
  };
}

function UpdateToastHeading({
  store,
  onCheck,
  onRestart,
}: {
  readonly store: UpdateToastStore;
  readonly onCheck: () => void;
  readonly onRestart: () => void;
}): React.JSX.Element {
  const { state, isChecking } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <span className="flex min-w-0 items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>Application update</span>
        {state ? (
          <span className="truncate text-xs font-normal text-muted tabular-nums">
            {updateSubtitle(state)}
          </span>
        ) : null}
      </span>
      {state ? (
        <UpdateToastAction state={state} isChecking={isChecking} onCheck={onCheck} onRestart={onRestart} />
      ) : null}
    </span>
  );
}

function UpdateToastIndicator({ store }: { readonly store: UpdateToastStore }): React.JSX.Element {
  const { state } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const status = state?.status;
  const icon = status === "error" ? faTriangleExclamation
    : status === "trust-required" ? faCircleInfo
    : status === "ready" ? faCircleCheck
    : status === "available" || status === "downloading" ? faDownload
    : faArrowsRotate;
  const color = status === "error" ? "text-danger"
    : status === "trust-required" ? "text-warning"
    : status === "ready" ? "text-success"
    : status === "idle" || status === "up-to-date" ? "text-muted" : "text-accent";
  return (
    <>
      <FontAwesomeIcon
        aria-hidden
        className={`size-4 ${color}${status === "checking" ? " motion-safe:animate-spin" : ""}`}
        icon={icon}
      />
      <span className="sr-only" aria-atomic="true" aria-live="polite" role="status">
        {state ? updateAnnouncement(state) : ""}
      </span>
    </>
  );
}

function UpdateToastContent({ store }: { readonly store: UpdateToastStore }): React.JSX.Element | null {
  const { state } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (!state) return null;
  const hasProgress = state.status === "downloading" || state.status === "available";
  const detail = state.status === "trust-required" ? state.message
    : state.status === "error" ? state.error
    : state.status === "ready" ? "Restart when your operator work is safe." : undefined;
  return (
    <div
      className="application-update-toast min-w-0"
      data-layout={hasProgress ? "progress" : detail ? "expanded" : "compact"}
    >
      {hasProgress ? (
        <ProgressBar
          aria-label={`${state.status === "available" ? "Preparing" : "Downloading"} application update ${state.availableVersion}`}
          className="w-full gap-0"
          isIndeterminate={state.status === "available"}
          maxValue={100}
          size="sm"
          value={state.status === "downloading" ? state.progressPercent : 0}
        >
          <ProgressBar.Track className="h-1.5 rounded-full">
            <ProgressBar.Fill className="rounded-full" />
          </ProgressBar.Track>
        </ProgressBar>
      ) : detail ? (
        <p className="text-xs leading-5 text-muted [overflow-wrap:anywhere]">{detail}</p>
      ) : null}
    </div>
  );
}

function UpdateToastAction({
  state,
  isChecking,
  onCheck,
  onRestart,
}: {
  readonly state: ApplicationUpdateState;
  readonly isChecking: boolean;
  readonly onCheck: () => void;
  readonly onRestart: () => void;
}): React.JSX.Element | null {
  if (state.status === "idle") {
    return (
      <Button
        aria-label="Check for updates"
        className="shrink-0 rounded-lg"
        isPending={isChecking}
        size="sm"
        variant="secondary"
        onPress={onCheck}
      >
        <span className="hidden sm:inline">Check for updates</span>
        <span className="sm:hidden">Check now</span>
      </Button>
    );
  }
  if (state.status === "up-to-date") {
    return (
      <Button
        aria-label={`Up to date · ${state.currentVersion}. Check again`}
        className="shrink-0 rounded-lg text-success"
        isPending={isChecking}
        size="sm"
        variant="tertiary"
        onPress={onCheck}
      >
        <FontAwesomeIcon aria-hidden className="size-3.5 shrink-0" icon={faCircleCheck} />
        Up to date
      </Button>
    );
  }
  if (state.status === "checking" || state.status === "available" || state.status === "downloading") {
    return (
      <span className="shrink-0 rounded-lg bg-default px-3 py-1.5 text-sm font-medium text-accent tabular-nums">
        {state.status === "checking" ? "Checking…"
          : state.status === "available" ? "Preparing…" : `${Math.round(state.progressPercent)}%`}
      </span>
    );
  }
  if (state.status === "trust-required") {
    return (
      <Button
        className="shrink-0 rounded-lg"
        isPending={isChecking}
        size="sm"
        variant="secondary"
        onPress={onCheck}
      >
        Set up trust
      </Button>
    );
  }
  if (state.status === "ready") {
    return (
      <Button className="shrink-0 rounded-lg" size="sm" variant="danger-soft" onPress={onRestart}>
        Restart
      </Button>
    );
  }
  if (state.status === "error") {
    return (
      <Button className="shrink-0 rounded-lg" isPending={isChecking} size="sm" variant="secondary" onPress={onCheck}>
        Retry
      </Button>
    );
  }
  return null;
}

function updateSubtitle(state: ApplicationUpdateState): string {
  if (state.status === "trust-required") return "Trust setup required";
  if (state.status === "available") return `Update ${state.availableVersion} found`;
  if (state.status === "downloading") return `Downloading ${state.availableVersion}`;
  if (state.status === "ready") return `Update ${state.availableVersion} ready`;
  if (state.status === "error") return "Update failed";
  return `Version ${state.currentVersion}`;
}

function isPassiveState(state: ApplicationUpdateState): boolean {
  return state.status === "disabled" || state.status === "idle" || state.status === "up-to-date";
}

function updateAnnouncement(state: ApplicationUpdateState): string {
  if (state.status === "disabled") return `Application updates unavailable. ${state.disabledReason}`;
  if (state.status === "idle") return "Application updater ready.";
  if (state.status === "checking") return "Checking for application updates.";
  if (state.status === "trust-required") return `Update trust setup required. ${state.message}`;
  if (state.status === "available") return `Application update ${state.availableVersion} found.`;
  if (state.status === "downloading") {
    return `Downloading application update ${state.availableVersion}: ${Math.round(state.progressPercent)} percent.`;
  }
  if (state.status === "ready") return `Application update ${state.availableVersion} is ready to install.`;
  if (state.status === "up-to-date") return `Sliver Desktop ${state.currentVersion} is up to date.`;
  return `Application update failed. ${state.error}`;
}
