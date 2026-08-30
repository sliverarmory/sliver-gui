import { useEffect, useState } from "react";
import { Chip, Spinner } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCircleCheck,
  faPlugCircleXmark,
  faTerminal,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";

import type { OperationResult } from "../../shared/contracts";
import type { ConsoleWindowLaunchContext } from "../../shared/console-contracts";
import type { TerminalRuntimeAsset } from "../../shared/stream-contracts";
import { GhosttyTerminal } from "./components/GhosttyTerminal";
import { ConsoleTerminalTransport } from "./components/console-terminal-transport";

type ConsoleWindowPhase = "claiming" | "starting" | "ready";

interface ReadyConsoleWindow {
  readonly context: ConsoleWindowLaunchContext;
  readonly runtime: TerminalRuntimeAsset;
  readonly transport: ConsoleTerminalTransport;
}

interface ConsoleWindowAPI {
  claimConsoleWindow(): Promise<OperationResult<ConsoleWindowLaunchContext>>;
  getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>>;
}

let pendingConsoleLaunchContext: Promise<OperationResult<ConsoleWindowLaunchContext>> | undefined;
let cachedConsoleTerminalRuntime: TerminalRuntimeAsset | undefined;
let pendingConsoleTerminalRuntime: Promise<TerminalRuntimeAsset> | undefined;

export function ConsoleWindowApp(): React.JSX.Element {
  const [phase, setPhase] = useState<ConsoleWindowPhase>("claiming");
  const [ready, setReady] = useState<ReadyConsoleWindow>();
  const [error, setError] = useState<string>();
  const [exitMessage, setExitMessage] = useState<string>();

  useEffect(() => {
    let mounted = true;
    let transportPromise: Promise<ConsoleTerminalTransport> | undefined;

    void claimConsoleLaunchContext()
      .then(async (result) => {
        if (!mounted) return;
        if (!result.ok || !result.value || result.value.kind !== "console") {
          throw new Error(result.error ?? "This window is not authorized to host a Sliver console");
        }
        const context = result.value;
        setPhase("starting");
        document.title = `Sliver console — ${context.configName}`;
        transportPromise = ConsoleTerminalTransport.open({ attachmentToken: context.attachmentToken });
        const [runtime, transport] = await Promise.all([
          loadConsoleTerminalRuntime(),
          transportPromise,
        ]);
        if (!mounted) {
          transport.close();
          return;
        }
        setReady({ context, runtime, transport });
        setPhase("ready");
        setError(undefined);
      })
      .catch(async (caught: unknown) => {
        if (transportPromise) {
          await transportPromise
            .then((transport) => transport.close())
            .catch(() => undefined);
        }
        if (mounted) setError(errorMessage(caught));
      });

    return () => {
      mounted = false;
      if (transportPromise) {
        void transportPromise.then((transport) => transport.close()).catch(() => undefined);
      }
    };
  }, []);

  if (error) {
    return (
      <ConsoleWindowState
        title="Sliver console unavailable"
        description={error}
        icon={faTriangleExclamation}
      />
    );
  }
  if (!ready) {
    return (
      <main className="grid min-h-screen place-items-center bg-background" aria-busy="true">
        <div className="flex items-center gap-3 text-sm text-muted" role="status">
          <Spinner size="sm" />
          <span>{phase === "claiming" ? "Claiming console window…" : "Starting Sliver console…"}</span>
        </div>
      </main>
    );
  }

  return (
    <main
      className="flex h-screen min-h-0 flex-col overflow-hidden bg-background"
      aria-label="Sliver client console window"
    >
      <header className="flex min-h-16 flex-none items-center justify-between gap-4 border-b border-border bg-surface px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 flex-none place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground">
            <FontAwesomeIcon aria-hidden icon={faTerminal} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-foreground">Sliver client console</h1>
            <p className="truncate text-xs text-muted" title={ready.context.configName}>
              Active configuration: {ready.context.configName}
            </p>
          </div>
        </div>
        <Chip color={exitMessage ? "default" : "success"} size="sm" variant="soft">
          <FontAwesomeIcon aria-hidden icon={exitMessage ? faPlugCircleXmark : faCircleCheck} />
          <Chip.Label>{exitMessage ? "Exited" : "Connected"}</Chip.Label>
        </Chip>
      </header>

      <section className="relative min-h-0 flex-1 bg-surface-secondary p-2" aria-label="Console terminal">
        <div className="h-full min-h-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
          <GhosttyTerminal
            ariaLabel={`Sliver client console using ${ready.context.configName}`}
            className="h-full min-h-0"
            transport={ready.transport}
            wasmBytes={ready.runtime.bytes}
            onClose={(reason) => setExitMessage(reason ?? "Sliver client exited")}
            onError={(terminalError) => {
              ready.transport.close();
              setError(terminalError.message);
            }}
          />
        </div>
        {exitMessage ? (
          <div
            className="absolute inset-x-5 bottom-5 flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-warning-soft-foreground shadow-lg"
            role="alert"
          >
            <FontAwesomeIcon aria-hidden className="mt-0.5 flex-none" icon={faTriangleExclamation} />
            <div className="min-w-0">
              <p className="text-sm font-medium">Console process exited</p>
              <p className="mt-0.5 break-words text-xs opacity-80">{exitMessage}</p>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function claimConsoleLaunchContext(): Promise<OperationResult<ConsoleWindowLaunchContext>> {
  pendingConsoleLaunchContext ??= (window.sliver as unknown as ConsoleWindowAPI).claimConsoleWindow();
  return pendingConsoleLaunchContext;
}

async function loadConsoleTerminalRuntime(): Promise<TerminalRuntimeAsset> {
  if (cachedConsoleTerminalRuntime) return cachedConsoleTerminalRuntime;
  if (pendingConsoleTerminalRuntime) return pendingConsoleTerminalRuntime;
  const api = window.sliver as unknown as ConsoleWindowAPI;
  const request = api.getTerminalRuntime()
    .then((result) => {
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "Terminal runtime is unavailable");
      }
      const source = result.value.bytes;
      const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
      bytes.set(source);
      cachedConsoleTerminalRuntime = Object.freeze({
        version: result.value.version,
        sha256: result.value.sha256,
        bytes,
      });
      return cachedConsoleTerminalRuntime;
    })
    .catch((caught: unknown) => {
      cachedConsoleTerminalRuntime = undefined;
      throw caught;
    })
    .finally(() => {
      if (pendingConsoleTerminalRuntime === request) pendingConsoleTerminalRuntime = undefined;
    });
  pendingConsoleTerminalRuntime = request;
  return request;
}

function ConsoleWindowState({
  title,
  description,
  icon,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: typeof faTerminal;
}): React.JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-8">
      <section className="w-full max-w-xl rounded-2xl bg-surface px-6 py-12" aria-label={title}>
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <FontAwesomeIcon aria-hidden icon={icon} />
            </EmptyState.Media>
            <EmptyState.Title>{title}</EmptyState.Title>
            <EmptyState.Description className="max-w-md text-pretty">{description}</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resetConsoleWindowStateForTest(): void {
  pendingConsoleLaunchContext = undefined;
  cachedConsoleTerminalRuntime = undefined;
  pendingConsoleTerminalRuntime = undefined;
}
