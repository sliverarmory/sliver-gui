import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBan,
  faClockRotateLeft,
  faFolderOpen,
  faListCheck,
  faMicrochip,
  faNetworkWired,
  faRotate,
  faSatellite,
  faTerminal,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import type { Key } from "react-aria-components";
import {
  Autocomplete,
  Button,
  Chip,
  Description,
  Label,
  ListBox,
  SearchField,
  ScrollShadow,
  Switch,
  Tabs,
  Tooltip,
  toast,
  useFilter,
} from "@heroui/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";

import type { PageSummary } from "../../../shared/contracts";
import type { TargetRef } from "../../../shared/target-contracts";
import type {
  BeaconTaskDetail,
  BeaconTaskSummary,
  OperationDisposition,
  OperationScalar,
  TargetOperationInput,
  TargetOperationRecord,
} from "../../../shared/operation-contracts";
import { Field } from "../components/FormControls";
import { BeaconExecutionCommand, type BeaconExecutionCommandState } from "./BeaconExecutionCommand";
import { BeaconExecutionTaskOutput } from "./BeaconExecutionTaskOutput";
import { formatTimestamp, taskStateColor } from "./target-page-model";
import { useBeaconTaskOutputs, type BeaconTaskOutputEntry } from "./useBeaconTaskOutputs";

export const BEACON_INTERACTION_COMMAND_IDS = [
  "execution",
  "beacon.filesystem.pwd",
  "beacon.filesystem.ls",
  "beacon.process.list",
  "beacon.network.interfaces",
] as const;

export type BeaconInteractionCommandId = (typeof BEACON_INTERACTION_COMMAND_IDS)[number];

interface BeaconCommandPresentation {
  id: BeaconInteractionCommandId;
  group: "Execution" | "Filesystem" | "Processes" | "Networking";
  label: string;
  description: string;
  keywords: readonly string[];
  icon: IconDefinition;
}

const BEACON_COMMANDS: readonly BeaconCommandPresentation[] = [
  {
    id: "execution",
    group: "Execution",
    label: "Execution",
    description: "Run a process, BOF, or payload on this beacon.",
    keywords: ["execute", "run", "bof", "assembly", ".net", "shellcode", "sideload", "dll"],
    icon: faTerminal,
  },
  {
    id: "beacon.filesystem.pwd",
    group: "Filesystem",
    label: "Working directory",
    description: "Read the beacon's current working directory.",
    keywords: ["pwd", "cwd", "path"],
    icon: faTerminal,
  },
  {
    id: "beacon.filesystem.ls",
    group: "Filesystem",
    label: "List directory",
    description: "Queue a bounded directory listing.",
    keywords: ["ls", "files", "folders"],
    icon: faFolderOpen,
  },
  {
    id: "beacon.process.list",
    group: "Processes",
    label: "List processes",
    description: "Collect the current process inventory.",
    keywords: ["ps", "processes", "pid"],
    icon: faMicrochip,
  },
  {
    id: "beacon.network.interfaces",
    group: "Networking",
    label: "Network interfaces",
    description: "Collect interfaces, addresses, and MAC metadata.",
    keywords: ["ifconfig", "ipconfig", "addresses", "mac"],
    icon: faNetworkWired,
  },
];

export interface BeaconInteractionWorkspaceProps {
  expectedTarget: TargetRef;
  targetIdentity: string;
  canQueue: boolean;
  unavailableReason?: string | undefined;
  tasks: BeaconTaskSummary[];
  page: PageSummary | undefined;
  error: string | undefined;
  isLoading: boolean;
  isLoadingMore: boolean;
  watchEnabled: boolean;
  onSubmitted: (operation: TargetOperationRecord) => boolean;
  onRefresh: () => void;
  onLoadMore: (cursor: string) => void;
  onCancelTask: (task: BeaconTaskDetail) => Promise<BeaconTaskDetail | undefined>;
}

export function BeaconInteractionWorkspace({
  expectedTarget,
  targetIdentity,
  canQueue,
  unavailableReason,
  tasks,
  page,
  error,
  isLoading,
  isLoadingMore,
  watchEnabled,
  onSubmitted,
  onRefresh,
  onLoadMore,
  onCancelTask,
}: BeaconInteractionWorkspaceProps): React.JSX.Element {
  const [commandId, setCommandId] = useState<BeaconInteractionCommandId>("beacon.filesystem.pwd");
  const [path, setPath] = useState(".");
  const [fullInfo, setFullInfo] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [executionState, setExecutionState] = useState<BeaconExecutionCommandState>({ isPending: false, isAvailable: false });
  const executionFormId = useId();
  const [cancelingTaskIds, setCancelingTaskIds] = useState<Set<string>>(() => new Set());
  const [queuedTaskId, setQueuedTaskId] = useState<string>();
  const [taskView, setTaskView] = useState("queue");
  const [outputJump, setOutputJump] = useState<{ taskId: string; sequence: number }>();
  const jumpSequence = useRef(0);
  const identityRef = useRef(targetIdentity);
  identityRef.current = targetIdentity;
  const { entries: outputs, loadOutput } = useBeaconTaskOutputs(targetIdentity, tasks);
  const { contains } = useFilter({ sensitivity: "base" });
  const command = BEACON_COMMANDS.find((item) => item.id === commandId) ?? BEACON_COMMANDS[0]!;

  useEffect(() => {
    setCommandId("beacon.filesystem.pwd");
    setPath(".");
    setFullInfo(false);
    setSubmitError(undefined);
    setIsSubmitting(false);
    setExecutionState({ isPending: false, isAvailable: false });
    setCancelingTaskIds(new Set());
    setQueuedTaskId(undefined);
    setTaskView("queue");
    setOutputJump(undefined);
  }, [targetIdentity]);

  const selectTask = (task: BeaconTaskSummary): void => {
    setQueuedTaskId(undefined);
    loadOutput(task, outputs.some((entry) => entry.task.taskId === task.taskId &&
      (entry.error !== undefined || entry.detail?.errorKind === "decode-uncertain")));
    setTaskView("output");
    setOutputJump({ taskId: task.taskId, sequence: ++jumpSequence.current });
  };

  useEffect(() => {
    if (!queuedTaskId) return;
    const queuedTask = tasks.find((task) => task.taskId === queuedTaskId);
    if (!queuedTask) return;
    setQueuedTaskId(undefined);
    loadOutput(queuedTask);
  }, [queuedTaskId, loadOutput, tasks]);

  const submit = async (): Promise<void> => {
    const submittedIdentity = targetIdentity;
    let input: TargetOperationInput;
    try {
      input = beaconCommandInput(commandId, path, fullInfo);
      setSubmitError(undefined);
    } catch (validationError) {
      setSubmitError(errorMessage(validationError));
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await window.sliver.submitTargetOperation(input);
      if (identityRef.current !== submittedIdentity) return;
      if (!result.ok || !result.value) {
        setSubmitError(result.error ?? "The beacon task was rejected");
        return;
      }
      if (!onSubmitted(result.value)) return;
      if (!result.value.taskId) {
        setSubmitError(
          result.value.message ??
          "The operation finished without an exact beacon task ID, so queue insertion was not confirmed.",
        );
        return;
      }
      setQueuedTaskId(result.value.taskId);
      setTaskView("queue");
      toast.success("Task queued", {
        description: `${command.label} will run after the beacon checks in.`,
      });
      onRefresh();
    } catch (submissionError) {
      if (identityRef.current === submittedIdentity) setSubmitError(errorMessage(submissionError));
    } finally {
      if (identityRef.current === submittedIdentity) setIsSubmitting(false);
    }
  };

  const cancel = async (task: BeaconTaskDetail): Promise<void> => {
    const expectedIdentity = targetIdentity;
    setCancelingTaskIds((current) => new Set(current).add(task.taskId));
    try {
      const updated = await onCancelTask(task);
      if (updated && identityRef.current === expectedIdentity) loadOutput(updated, true);
    } finally {
      if (identityRef.current === expectedIdentity) {
        setCancelingTaskIds((current) => {
          const next = new Set(current);
          next.delete(task.taskId);
          return next;
        });
      }
    }
  };

  return (
    <div className="beacon-interaction-workspace grid min-w-0 items-stretch gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="beacon-interaction-workspace__controls flex min-w-0 flex-col gap-4">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface" aria-labelledby="beacon-command-heading">
          <div className="flex items-start gap-3 px-5 py-4">
            <span className="section-icon"><FontAwesomeIcon aria-hidden icon={faSatellite} /></span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground" id="beacon-command-heading">Queue a beacon task</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">Choose a command, configure it, and follow its result after the beacon checks in.</p>
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-separator px-5 py-5">
            <Button
              fullWidth
              {...(commandId === "execution" ? { form: executionFormId } : {})}
              type={commandId === "execution" ? "submit" : "button"}
              isDisabled={commandId === "execution" ? !executionState.isAvailable : !canQueue}
              isPending={commandId === "execution" ? executionState.isPending : isSubmitting}
              {...(commandId === "execution" ? {} : { onPress: () => void submit() })}
            >
              <FontAwesomeIcon aria-hidden icon={faListCheck} /> Queue task
            </Button>
            <Autocomplete
              fullWidth
              placeholder="Search beacon tasks"
              selectionMode="single"
              value={commandId}
              variant="secondary"
              onChange={(key: Key | Key[] | null) => {
                if (key === null || Array.isArray(key)) return;
                const nextId = String(key);
                if (!isBeaconInteractionCommandId(nextId)) return;
                setCommandId(nextId);
                setSubmitError(undefined);
              }}
            >
              <Label>Command</Label>
              <Autocomplete.Trigger>
                <Autocomplete.Value />
                <Autocomplete.ClearButton />
                <Autocomplete.Indicator />
              </Autocomplete.Trigger>
              <Description>Type a command name or browse the common beacon tasks.</Description>
              <Autocomplete.Popover>
                <Autocomplete.Filter filter={contains}>
                  <SearchField autoFocus aria-label="Search beacon commands" name="beacon-command-search" variant="secondary">
                    <SearchField.Group>
                      <SearchField.SearchIcon />
                      <SearchField.Input placeholder="Search commands…" />
                      <SearchField.ClearButton />
                    </SearchField.Group>
                  </SearchField>
                  <ListBox renderEmptyState={() => <p className="px-3 py-6 text-center text-sm text-muted">No matching beacon commands.</p>}>
                    {BEACON_COMMANDS.map((item) => (
                      <ListBox.Item
                        id={item.id}
                        key={item.id}
                        textValue={`${item.label} ${item.group} ${item.keywords.join(" ")}`}
                      >
                        <FontAwesomeIcon aria-hidden className="size-4 shrink-0 text-muted" icon={item.icon} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="text-sm font-medium text-foreground">{item.label}</span>
                          <span className="truncate text-xs text-muted">{item.group} · {item.description}</span>
                        </span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Autocomplete.Filter>
              </Autocomplete.Popover>
            </Autocomplete>

            {commandId === "execution" ? (
              <BeaconExecutionCommand
                expectedTarget={expectedTarget}
                formId={executionFormId}
                key={targetIdentity}
                targetIdentity={targetIdentity}
                onStateChange={setExecutionState}
                onQueuedTask={(taskId) => {
                  if (identityRef.current !== targetIdentity) return;
                  setQueuedTaskId(taskId);
                  setTaskView("queue");
                  onRefresh();
                }}
              />
            ) : <div className="rounded-2xl bg-default p-4">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon aria-hidden className="mt-0.5 size-4 text-accent" icon={command.icon} />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">{command.label}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{command.description}</p>
                </div>
              </div>

              <div className="mt-4">
                {commandId === "beacon.filesystem.ls" ? (
                  <Field
                    description="Absolute paths and paths relative to the beacon's working directory are accepted."
                    label="Path"
                    mono
                    required
                    value={path}
                    onChange={setPath}
                  />
                ) : null}
                {commandId === "beacon.process.list" ? (
                  <Switch aria-label="Include full process details" isSelected={fullInfo} onChange={setFullInfo}>
                    <Switch.Content className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">Include full process details</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted">Request owner, architecture, session, and command-line metadata when available.</span>
                    </Switch.Content>
                    <Switch.Control><Switch.Thumb /></Switch.Control>
                  </Switch>
                ) : null}
                {commandId === "beacon.filesystem.pwd" || commandId === "beacon.network.interfaces" ? (
                  <p className="text-xs leading-relaxed text-muted">This task has no additional options.</p>
                ) : null}
              </div>
            </div>}

            {commandId !== "execution" && !canQueue ? (
              <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="status">
                {unavailableReason ?? "Task execution is unavailable for this beacon."}
              </p>
            ) : null}
            {submitError ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger-soft-foreground" role="alert">{submitError}</p> : null}
          </div>
        </section>
      </div>

      <section aria-label="Beacon tasks" className="beacon-task-views min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface">
        <Tabs className="absolute inset-0 min-h-0 min-w-0 gap-0" selectedKey={taskView} onSelectionChange={(key) => setTaskView(String(key))}>
          <Tabs.ListContainer className="mx-5 my-4 w-fit max-w-full shrink-0">
            <Tabs.List aria-label="Beacon task views">
              <Tabs.Tab className="whitespace-nowrap" id="queue">Task queue<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab className="whitespace-nowrap" id="output">Task output<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel className="flex min-h-0 min-w-0 flex-1 flex-col p-0" id="queue">
            <BeaconTaskQueue
              error={error}
              isLoading={isLoading}
              isLoadingMore={isLoadingMore}
              page={page}
              tasks={tasks}
              watchEnabled={watchEnabled}
              onLoadMore={onLoadMore}
              onRefresh={onRefresh}
              onSelectTask={selectTask}
            />
          </Tabs.Panel>
          <Tabs.Panel className="flex min-h-0 min-w-0 flex-1 flex-col p-0" id="output">
            <BeaconTaskOutputList
              cancelingTaskIds={cancelingTaskIds}
              error={error}
              isLoadingMore={isLoadingMore}
              jump={outputJump}
              outputs={outputs}
              page={page}
              onCancel={(task) => void cancel(task)}
              onLoadMore={onLoadMore}
              onRetry={(task) => loadOutput(task, true)}
            />
          </Tabs.Panel>
        </Tabs>
      </section>
    </div>
  );
}

function BeaconTaskQueue({
  tasks,
  page,
  error,
  isLoading,
  isLoadingMore,
  watchEnabled,
  onLoadMore,
  onRefresh,
  onSelectTask,
}: {
  tasks: BeaconTaskSummary[];
  page: PageSummary | undefined;
  error: string | undefined;
  isLoading: boolean;
  isLoadingMore: boolean;
  watchEnabled: boolean;
  onLoadMore: (cursor: string) => void;
  onRefresh: () => void;
  onSelectTask: (task: BeaconTaskSummary) => void;
}): React.JSX.Element {
  const columns = useMemo<DataGridColumn<BeaconTaskSummary>[]>(() => [
    {
      id: "task",
      header: "Task",
      isRowHeader: true,
      minWidth: 220,
      cell: (task) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{task.description || "Beacon task"}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{task.taskId}</p>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      accessorKey: "state",
      minWidth: 112,
      cell: (task) => <Chip color={taskStateColor(task.state)} size="sm" variant="soft">{stateLabel(task.state)}</Chip>,
    },
    {
      id: "created",
      header: "Created",
      accessorKey: "createdAt",
      minWidth: 170,
      cell: (task) => <span className="text-xs tabular-nums text-muted">{formatTimestamp(task.createdAt)}</span>,
    },
  ], []);

  const nextCursor = page?.nextCursor;
  const total = Math.max(page?.total ?? tasks.length, tasks.length);

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-separator">
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs text-muted">Pending and completed tasks for this beacon.</p>
          {watchEnabled ? <Chip className="mt-2" color="accent" size="sm" variant="soft">Watching</Chip> : null}
        </div>
        <Tooltip delay={250}>
          <Button aria-label="Refresh task queue" isDisabled={isLoadingMore} isIconOnly isPending={isLoading} size="sm" variant="ghost" onPress={onRefresh}>
            <FontAwesomeIcon aria-hidden icon={faRotate} />
          </Button>
          <Tooltip.Content>Refresh task queue</Tooltip.Content>
        </Tooltip>
      </div>
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      <DataGrid
        aria-label="Beacon task queue"
        className="flex min-h-0 flex-1 flex-col"
        columns={columns}
        contentClassName="min-w-[520px]"
        data={tasks}
        getRowId={(task) => task.taskId}
        scrollContainerClassName="min-h-0 flex-1 overflow-auto"
        variant="secondary"
        onRowAction={(key) => {
          const task = tasks.find((item) => item.taskId === String(key));
          if (task) onSelectTask(task);
        }}
        renderEmptyState={() => (
          <EmptyState className="min-h-48 px-6 py-10" size="sm">
            <EmptyState.Media><FontAwesomeIcon aria-hidden icon={faClockRotateLeft} /></EmptyState.Media>
            <EmptyState.Content>
              <EmptyState.Title>No tasks queued</EmptyState.Title>
              <EmptyState.Description>Choose a command to queue a beacon task.</EmptyState.Description>
            </EmptyState.Content>
          </EmptyState>
        )}
      />
      {page ? (
        <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-t border-separator px-5 py-2.5">
          <p className="text-xs tabular-nums text-muted" aria-live="polite">Showing {tasks.length} of {total} tasks</p>
          {nextCursor ? (
            <Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => onLoadMore(nextCursor)}>
              Load more tasks
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BeaconTaskOutputList({
  outputs,
  jump,
  cancelingTaskIds,
  error,
  page,
  isLoadingMore,
  onCancel,
  onRetry,
  onLoadMore,
}: {
  outputs: BeaconTaskOutputEntry[];
  jump: { taskId: string; sequence: number } | undefined;
  cancelingTaskIds: Set<string>;
  error: string | undefined;
  page: PageSummary | undefined;
  isLoadingMore: boolean;
  onCancel: (task: BeaconTaskDetail) => void;
  onRetry: (task: BeaconTaskSummary) => void;
  onLoadMore: (cursor: string) => void;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef(new Map<string, HTMLElement>());
  const jumpIsLoading = outputs.find((entry) => entry.task.taskId === jump?.taskId)?.isLoading;
  const nextCursor = page?.nextCursor;

  useEffect(() => {
    if (!jump) return;
    const entry = entryRefs.current.get(jump.taskId);
    const viewport = viewportRef.current;
    if (!entry || !viewport) return;
    entry.focus({ preventScroll: true });
    viewport.scrollTop += entry.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20;
    const scrollport = viewport.closest(".app-content, .interaction-window__content");
    if (!scrollport) return;
    const summary = scrollport.querySelector('header[aria-label="Beacon summary"]');
    const revealOutput = (): void => {
      const viewportBounds = viewport.getBoundingClientRect();
      const entryBounds = entry.getBoundingClientRect();
      const scrollportBounds = scrollport.getBoundingClientRect();
      const visibleTop = Math.max(scrollportBounds.top, summary?.getBoundingClientRect().bottom ?? 0) + 16;
      const visibleBottom = scrollportBounds.bottom - 16;
      const outputTop = Math.max(entryBounds.top, viewportBounds.top + 20);
      const outputBottom = Math.min(entryBounds.bottom, viewportBounds.bottom - 20, outputTop + 240);
      if (outputTop < visibleTop || outputBottom > visibleBottom) {
        scrollport.scrollTop += outputTop - visibleTop;
      }
    };
    revealOutput();
    // Pinning the summary changes its bounds; remeasure after its scroll observer commits.
    let frame = requestAnimationFrame(() => {
      revealOutput();
      frame = requestAnimationFrame(revealOutput);
    });
    return () => cancelAnimationFrame(frame);
  }, [jump, jumpIsLoading]);

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-separator">
      {error ? <InlineMessage tone="danger">{error}</InlineMessage> : null}
      {outputs.length === 0 ? (
        <EmptyState className="min-h-0 flex-1 px-6 py-12" size="sm">
          <EmptyState.Media><FontAwesomeIcon aria-hidden icon={faListCheck} /></EmptyState.Media>
          <EmptyState.Content>
            <EmptyState.Title>No task output</EmptyState.Title>
            <EmptyState.Description>Results will appear here as the beacon completes its tasks.</EmptyState.Description>
          </EmptyState.Content>
        </EmptyState>
      ) : (
        <ScrollShadow aria-label="Beacon task outputs" className="min-h-0 flex-1 overflow-y-auto px-5 py-5" ref={viewportRef} role="region">
          <div className="flex min-w-0 flex-col gap-5">
            {outputs.map((output) => (
              <article
                aria-label={`Task output ${output.task.taskId}`}
                className="min-w-0 rounded-xl border-b border-separator pb-5 outline-none last:border-b-0 last:pb-0 focus-visible:ring-2 focus-visible:ring-accent"
                data-task-id={output.task.taskId}
                key={output.task.taskId}
                ref={(element) => {
                  if (element) entryRefs.current.set(output.task.taskId, element);
                  else entryRefs.current.delete(output.task.taskId);
                }}
                tabIndex={-1}
              >
                <BeaconTaskOutput
                  isCanceling={cancelingTaskIds.has(output.task.taskId)}
                  output={output}
                  onCancel={onCancel}
                  onRetry={() => onRetry(output.task)}
                />
              </article>
            ))}
          </div>
        </ScrollShadow>
      )}
      {nextCursor ? (
        <div className="flex shrink-0 justify-end border-t border-separator px-5 py-3">
          <Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => onLoadMore(nextCursor)}>
            Load more tasks
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function BeaconTaskOutput({ output, isCanceling, onCancel, onRetry }: {
  output: BeaconTaskOutputEntry;
  isCanceling: boolean;
  onCancel: (task: BeaconTaskDetail) => void;
  onRetry: () => void;
}): React.JSX.Element {
  const task = output.detail;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{output.task.description || (task ? operationResultTitle(task) : "Beacon task")}</h3>
          <p className="mt-1 truncate font-mono text-[11px] text-muted" title={output.task.taskId}>{output.task.taskId}</p>
        </div>
        <Chip color={taskStateColor(task?.state ?? output.task.state)} size="sm" variant="soft">{stateLabel(task?.state ?? output.task.state)}</Chip>
      </div>
      {output.isLoading ? <p className="text-xs text-muted" role="status">Loading task output…</p> : null}
      {output.error ? (
        <div className="flex flex-col gap-3">
          <InlineMessage tone="danger">{output.error}</InlineMessage>
          <Button className="self-start" size="sm" variant="tertiary" onPress={onRetry}>Retry task output</Button>
        </div>
      ) : task && !output.isLoading ? (
        <>
          {task.error ? <InlineMessage tone="danger">{task.error}</InlineMessage> : null}
          {task.errorKind === "decode-uncertain" ? (
            <Button className="self-start" size="sm" variant="tertiary" onPress={onRetry}>Retry task output</Button>
          ) : null}
          {task.state === "pending" || task.state === "sent" ? (
            <div className="rounded-2xl bg-default px-4 py-5" role="status">
              <p className="text-sm font-medium text-foreground">Waiting for the beacon</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">The task is queued and will update after the beacon checks in and returns a response.</p>
            </div>
          ) : (
            <BeaconTaskResult task={task} />
          )}

          {task.state === "pending" ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              {!task.cancellation.available && task.cancellation.reason ? (
                <p className="max-w-sm text-xs leading-relaxed text-muted">{task.cancellation.reason}</p>
              ) : <span />}
              <Button isDisabled={!task.cancellation.available} isPending={isCanceling} size="sm" variant="danger-soft" onPress={() => onCancel(task)}>
                <FontAwesomeIcon aria-hidden icon={faBan} /> Cancel task
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function BeaconTaskResult({ task }: { task: BeaconTaskDetail }): React.JSX.Element {
  if (task.execution) return <BeaconExecutionTaskOutput key={`${task.beaconId}:${task.taskId}:${task.execution.operationId}`} task={task} />;
  const operationId = task.operationId as string | undefined;
  if (operationId === "beacon.filesystem.pwd") return <WorkingDirectoryResult disposition={task.disposition} />;
  if (operationId === "beacon.filesystem.ls") {
    return <TableResult description="Filesystem metadata returned by this check-in." disposition={task.disposition} emptyLabel="The directory is empty." icon={faFolderOpen} title="Directory listing" />;
  }
  if (operationId === "beacon.process.list") {
    return <TableResult description="Process inventory captured when the beacon executed the task." disposition={task.disposition} emptyLabel="No processes were returned." icon={faMicrochip} title="Processes" />;
  }
  if (operationId === "beacon.network.interfaces") return <NetworkInterfacesResult disposition={task.disposition} />;
  return <GenericDisposition disposition={task.disposition} />;
}

function WorkingDirectoryResult({ disposition }: { disposition: OperationDisposition | undefined }): React.JSX.Element {
  const path = disposition?.kind === "structured-detail"
    ? disposition.fields.find((field) => field.label.toLocaleLowerCase() === "path")?.value
    : disposition?.kind === "inline-text"
      ? disposition.text
      : undefined;
  if (path === undefined || path === null) return <GenericDisposition disposition={disposition} />;
  return (
    <div className="rounded-2xl bg-default p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <FontAwesomeIcon aria-hidden className="text-accent" icon={faTerminal} /> Working directory
      </div>
      <p className="mt-3 break-all font-mono text-sm text-foreground">{String(path)}</p>
      {disposition?.kind === "structured-detail" && disposition.truncated ? <TruncatedNotice /> : null}
    </div>
  );
}

function TableResult({
  title,
  description,
  icon,
  disposition,
  emptyLabel,
}: {
  title: string;
  description: string;
  icon: IconDefinition;
  disposition: OperationDisposition | undefined;
  emptyLabel: string;
}): React.JSX.Element {
  if (disposition?.kind !== "table") return <GenericDisposition disposition={disposition} />;
  return (
    <div>
      <div className="mb-3 flex items-start gap-2">
        <FontAwesomeIcon aria-hidden className="mt-0.5 text-accent" icon={icon} />
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        </div>
      </div>
      {disposition.rows.length === 0 ? (
        <p className="rounded-2xl bg-default px-4 py-5 text-sm text-muted">{emptyLabel}</p>
      ) : (
        <ResultTable columns={disposition.columns} rows={disposition.rows} />
      )}
      {disposition.truncated ? <TruncatedNotice /> : null}
    </div>
  );
}

function NetworkInterfacesResult({ disposition }: { disposition: OperationDisposition | undefined }): React.JSX.Element {
  if (disposition?.kind !== "table") return <GenericDisposition disposition={disposition} />;
  const valueAt = (row: OperationScalar[], label: string): string => {
    const index = disposition.columns.findIndex((column) => column.toLocaleLowerCase() === label.toLocaleLowerCase());
    return index < 0 ? "Not reported" : String(row[index] ?? "Not reported");
  };
  return (
    <div>
      <div className="mb-3 flex items-start gap-2">
        <FontAwesomeIcon aria-hidden className="mt-0.5 text-accent" icon={faNetworkWired} />
        <div>
          <p className="text-sm font-semibold text-foreground">Network interfaces</p>
          <p className="mt-0.5 text-xs text-muted">Addresses and link-layer identity returned by the beacon.</p>
        </div>
      </div>
      {disposition.rows.length === 0 ? (
        <p className="rounded-2xl bg-default px-4 py-5 text-sm text-muted">No network interfaces were returned.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {disposition.rows.map((row, index) => (
            <article className="min-w-0 rounded-2xl bg-default p-4" key={`${valueAt(row, "Index")}:${valueAt(row, "Name")}:${index}`}>
              <div className="flex items-center justify-between gap-3">
                <p className="truncate text-sm font-semibold text-foreground">{valueAt(row, "Name")}</p>
                <Chip size="sm" variant="soft">#{valueAt(row, "Index")}</Chip>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-muted">{valueAt(row, "MAC")}</p>
              <p className="mt-3 break-words font-mono text-xs leading-relaxed text-foreground">{valueAt(row, "Addresses")}</p>
            </article>
          ))}
        </div>
      )}
      {disposition.truncated ? <TruncatedNotice /> : null}
    </div>
  );
}

function ResultTable({ columns, rows }: { columns: string[]; rows: OperationScalar[][] }): React.JSX.Element {
  return (
    <div className="max-h-[420px] overflow-auto rounded-2xl bg-default">
      <table className="w-full min-w-[620px] text-left text-xs">
        <thead className="sticky top-0 bg-default">
          <tr>{columns.map((column) => <th className="px-3 py-2 font-medium text-muted" key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>{rows.map((row, rowIndex) => (
          <tr className="border-t border-separator" key={rowIndex}>
            {row.map((value, columnIndex) => (
              <td className={`px-3 py-2 text-foreground ${columnIndex === 0 ? "font-mono" : ""}`} key={columnIndex}>{String(value ?? "")}</td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function GenericDisposition({ disposition }: { disposition: OperationDisposition | undefined }): React.JSX.Element {
  if (!disposition) return <InlineMessage tone="default">No decoded result is available for this task.</InlineMessage>;
  if (disposition.kind === "inline-text") {
    return (
      <div>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl bg-default p-4 font-mono text-xs leading-relaxed text-foreground">{disposition.text}</pre>
        {disposition.truncated ? <TruncatedNotice /> : null}
      </div>
    );
  }
  if (disposition.kind === "table") {
    return (
      <div>
        <ResultTable columns={disposition.columns} rows={disposition.rows} />
        {disposition.truncated ? <TruncatedNotice /> : null}
      </div>
    );
  }
  if (disposition.kind === "structured-detail") {
    return (
      <div className="rounded-2xl bg-default p-4">
        <p className="text-sm font-semibold text-foreground">{disposition.title}</p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {disposition.fields.map((field) => <ResultMeta key={field.label} label={field.label} value={String(field.value ?? "")} />)}
        </dl>
        {disposition.truncated ? <TruncatedNotice /> : null}
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-2xl bg-default p-4">
      <FontAwesomeIcon aria-hidden className="mt-0.5 text-warning" icon={faTriangleExclamation} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">Result retained by the main process</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">This result is available through a bounded safe handle and is not exposed as a renderer filesystem path.</p>
      </div>
    </div>
  );
}

function InlineMessage({ children, tone }: { children: React.ReactNode; tone: "default" | "danger" }): React.JSX.Element {
  return (
    <div className={tone === "danger"
      ? "bg-danger-soft px-4 py-3 text-xs leading-relaxed text-danger-soft-foreground"
      : "rounded-2xl bg-default px-4 py-4 text-sm text-muted"} role={tone === "danger" ? "alert" : "status"}>
      {children}
    </div>
  );
}

function ResultMeta({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-xs text-foreground">{value}</dd>
    </div>
  );
}

function TruncatedNotice(): React.JSX.Element {
  return <p className="mt-2 text-xs text-warning">The server result exceeded the bounded preview and was truncated.</p>;
}

function isBeaconInteractionCommandId(value: string): value is BeaconInteractionCommandId {
  return (BEACON_INTERACTION_COMMAND_IDS as readonly string[]).includes(value);
}

function beaconCommandInput(commandId: BeaconInteractionCommandId, path: string, fullInfo: boolean): TargetOperationInput {
  switch (commandId) {
    case "execution":
      throw new Error("Choose execution options before queueing this task.");
    case "beacon.filesystem.pwd":
      return { operationId: commandId };
    case "beacon.filesystem.ls": {
      const normalizedPath = path.trim();
      if (!normalizedPath) throw new Error("Enter a directory path.");
      return { operationId: commandId, path: normalizedPath };
    }
    case "beacon.process.list":
      return { operationId: commandId, fullInfo };
    case "beacon.network.interfaces":
      return { operationId: commandId };
  }
}

function operationResultTitle(task: BeaconTaskDetail): string {
  const operationId = task.operationId as string | undefined;
  return BEACON_COMMANDS.find((command) => command.id === operationId)?.label ?? "Beacon task";
}

function stateLabel(state: BeaconTaskSummary["state"]): string {
  return state.split("-").map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1)).join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
