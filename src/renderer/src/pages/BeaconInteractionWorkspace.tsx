import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBan,
  faChevronDown,
  faClockRotateLeft,
  faFolderOpen,
  faListCheck,
  faMicrochip,
  faNetworkWired,
  faRotate,
  faSatellite,
  faTerminal,
  faTriangleExclamation,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";
import type { Key } from "react-aria-components";
import {
  AlertDialog,
  Autocomplete,
  Button,
  Chip,
  Label,
  ListBox,
  SearchField,
  ScrollShadow,
  Select,
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
import type { BeaconSummary, TargetCapabilityId, TargetCapabilityState, TargetRef } from "../../../shared/target-contracts";
import type { ExecutionReadResult } from "../../../shared/execution-contracts";
import type { SessionRegistryHive, SessionRegistryWriteValue } from "../../../shared/session-contracts";
import type {
  BeaconMutationPlan,
  BeaconMutationOperationInput,
  BeaconTaskDetail,
  BeaconTaskSummary,
  OperationDisposition,
  OperationScalar,
  TargetOperationInput,
  TargetOperationRecord,
} from "../../../shared/operation-contracts";
import { AreaField, Field } from "../components/FormControls";
import { BeaconExecutionCommand, type BeaconExecutionCommandState, type BeaconExecutionSelection } from "./BeaconExecutionCommand";
import { BeaconExecutionTaskOutput } from "./BeaconExecutionTaskOutput";
import { BeaconTaskDetails } from "./BeaconTaskDetails";
import { getBeaconTaskPresentation } from "./beacon-task-presentation";
import { capabilityFor, formatTimestamp, operationStateLabel, taskStateColor } from "./target-page-model";
import { useBeaconTaskOutputs, type BeaconTaskOutputEntry } from "./useBeaconTaskOutputs";

export const BEACON_INTERACTION_COMMAND_IDS = [
  "execution",
  "beacon.filesystem.pwd",
  "beacon.filesystem.ls",
  "beacon.process.list",
  "beacon.network.interfaces",
  "beacon.environment.list",
  "beacon.identity.pid",
  "beacon.identity.uid",
  "beacon.identity.gid",
  "beacon.identity.whoami",
  "beacon.network.netstat",
  "beacon.filesystem.mount",
  "beacon.filesystem.memfiles",
  "beacon.filesystem.cat",
  "beacon.filesystem.head",
  "beacon.filesystem.tail",
  "beacon.filesystem.grep",
  "beacon.registry.list-subkeys",
  "beacon.registry.list-values",
  "beacon.registry.read",
  "beacon.registry.create",
  "beacon.registry.delete",
  "beacon.registry.write",
  "beacon.service.list",
  "beacon.service.info",
  "beacon.service.start",
  "beacon.service.stop",
  "target.ping",
  "target.rename",
  "target.env-set",
  "target.env-unset",
  "beacon.reconfigure",
  "beacon.open-session",
  "execution.children",
  "privilege.get",
  "privilege.run-as",
  "privilege.make-token",
  "privilege.impersonate",
  "privilege.revert",
] as const;

export type BeaconInteractionCommandId = (typeof BEACON_INTERACTION_COMMAND_IDS)[number];

interface BeaconCommandPresentation {
  id: BeaconInteractionCommandId;
  group: "Execution" | "Filesystem" | "Processes" | "Networking" | "Identity" | "Environment" | "Registry" | "Services" | "Beacon";
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
  { id: "beacon.environment.list", group: "Environment", label: "Environment variables", description: "Read variables in the beacon process environment.", keywords: ["env", "environment", "variables"], icon: faTerminal },
  { id: "beacon.identity.pid", group: "Identity", label: "Process ID", description: "Show the PID reported in the latest beacon inventory.", keywords: ["getpid", "pid", "process"], icon: faMicrochip },
  { id: "beacon.identity.uid", group: "Identity", label: "User ID", description: "Show the UID reported in the latest beacon inventory.", keywords: ["getuid", "uid", "user"], icon: faTerminal },
  { id: "beacon.identity.gid", group: "Identity", label: "Group ID", description: "Show the GID reported in the latest beacon inventory.", keywords: ["getgid", "gid", "group"], icon: faTerminal },
  { id: "beacon.identity.whoami", group: "Identity", label: "Current identity", description: "Read the Windows token owner, or show the latest reported username.", keywords: ["whoami", "username", "token", "identity"], icon: faTerminal },
  { id: "beacon.network.netstat", group: "Networking", label: "Network connections", description: "Read a bounded network connection inventory.", keywords: ["netstat", "tcp", "udp", "sockets"], icon: faNetworkWired },
  { id: "beacon.filesystem.mount", group: "Filesystem", label: "Mounts", description: "Read mounted filesystems and volumes.", keywords: ["mount", "volumes", "drives"], icon: faFolderOpen },
  { id: "beacon.filesystem.memfiles", group: "Filesystem", label: "Memory files", description: "List memory files on a Linux beacon.", keywords: ["memfiles", "memory", "files"], icon: faFolderOpen },
  { id: "beacon.filesystem.cat", group: "Filesystem", label: "Read file", description: "Read bounded text from a file.", keywords: ["cat", "file", "text"], icon: faFolderOpen },
  { id: "beacon.filesystem.head", group: "Filesystem", label: "Read file head", description: "Read the first lines or bytes of a file.", keywords: ["head", "file", "lines", "bytes"], icon: faFolderOpen },
  { id: "beacon.filesystem.tail", group: "Filesystem", label: "Read file tail", description: "Read the last bounded bytes of a file.", keywords: ["tail", "file", "bytes"], icon: faFolderOpen },
  { id: "beacon.filesystem.grep", group: "Filesystem", label: "Search files", description: "Search files for a pattern with bounded output.", keywords: ["grep", "search", "pattern"], icon: faFolderOpen },
  { id: "beacon.registry.list-subkeys", group: "Registry", label: "List registry subkeys", description: "Read subkeys beneath a Windows registry path.", keywords: ["registry", "keys", "windows"], icon: faFolderOpen },
  { id: "beacon.registry.list-values", group: "Registry", label: "List registry values", description: "Read value names at a Windows registry path.", keywords: ["registry", "values", "windows"], icon: faListCheck },
  { id: "beacon.registry.read", group: "Registry", label: "Read registry value", description: "Read one Windows registry value.", keywords: ["registry", "read", "windows"], icon: faListCheck },
  { id: "beacon.registry.create", group: "Registry", label: "Create registry key", description: "Review a new Windows registry subkey before queueing it.", keywords: ["registry", "create", "windows"], icon: faWrench },
  { id: "beacon.registry.delete", group: "Registry", label: "Delete registry entry", description: "Review a value-first Windows Registry deletion before queueing it.", keywords: ["registry", "delete", "value", "subkey", "windows"], icon: faWrench },
  { id: "beacon.registry.write", group: "Registry", label: "Write registry value", description: "Review an encoded Windows registry value before queueing it.", keywords: ["registry", "write", "windows"], icon: faWrench },
  { id: "beacon.service.list", group: "Services", label: "List services", description: "Read the Windows service inventory.", keywords: ["services", "windows", "list"], icon: faListCheck },
  { id: "beacon.service.info", group: "Services", label: "Service information", description: "Read details of a Windows service.", keywords: ["services", "windows", "info"], icon: faListCheck },
  { id: "beacon.service.start", group: "Services", label: "Start service", description: "Review a Windows service start before queueing it.", keywords: ["services", "windows", "start"], icon: faWrench },
  { id: "beacon.service.stop", group: "Services", label: "Stop service", description: "Review a Windows service stop before queueing it.", keywords: ["services", "windows", "stop"], icon: faWrench },
  {
    id: "target.ping",
    group: "Beacon",
    label: "Ping",
    description: "Queue a beacon ping.",
    keywords: ["ping", "checkin"],
    icon: faSatellite,
  },
  {
    id: "target.rename",
    group: "Beacon",
    label: "Rename",
    description: "Rename this beacon immediately.",
    keywords: ["name", "rename"],
    icon: faWrench,
  },
  {
    id: "target.env-set",
    group: "Beacon",
    label: "Set environment variable",
    description: "Queue an environment variable update.",
    keywords: ["env", "set", "variable"],
    icon: faWrench,
  },
  {
    id: "target.env-unset",
    group: "Beacon",
    label: "Unset environment variable",
    description: "Queue removal of an environment variable.",
    keywords: ["env", "unset", "variable"],
    icon: faWrench,
  },
  {
    id: "beacon.reconfigure",
    group: "Beacon",
    label: "Reconfigure beacon",
    description: "Queue beacon timing changes.",
    keywords: ["reconfigure", "reconnect", "interval", "jitter"],
    icon: faWrench,
  },
  {
    id: "beacon.open-session",
    group: "Beacon",
    label: "Open session",
    description: "Queue a request for an interactive session.",
    keywords: ["session", "interactive"],
    icon: faTerminal,
  },
  { id: "execution.children", group: "Execution", label: "Background children", description: "Read processes started in the background by this beacon.", keywords: ["children", "process", "jobs"], icon: faMicrochip },
  { id: "privilege.get", group: "Execution", label: "Windows privileges", description: "Read the beacon process privilege inventory.", keywords: ["getprivs", "privileges", "token"], icon: faWrench },
  { id: "privilege.run-as", group: "Execution", label: "Run as", description: "Run a command under supplied Windows credentials.", keywords: ["runas", "credentials", "identity"], icon: faTerminal },
  { id: "privilege.make-token", group: "Execution", label: "Make token", description: "Create a Windows logon token from supplied credentials.", keywords: ["maketoken", "credentials", "identity"], icon: faWrench },
  { id: "privilege.impersonate", group: "Execution", label: "Impersonate", description: "Impersonate a Windows token by identity.", keywords: ["impersonate", "token", "identity"], icon: faWrench },
  { id: "privilege.revert", group: "Execution", label: "Revert identity", description: "Revert to the beacon process identity.", keywords: ["revert", "token", "identity"], icon: faWrench },
];

interface BeaconManagementDraft {
  name: string;
  value: string;
  reconnectIntervalSeconds: string;
  intervalSeconds: string;
  jitterSeconds: string;
  delaySeconds: string;
}

const DEFAULT_MANAGEMENT_DRAFT: BeaconManagementDraft = {
  name: "",
  value: "",
  reconnectIntervalSeconds: "",
  intervalSeconds: "",
  jitterSeconds: "",
  delaySeconds: "0",
};

interface BeaconReadDraft {
  environmentName: string;
  path: string;
  pattern: string;
  count: string;
  countBytes: boolean;
  recursive: boolean;
  before: string;
  after: string;
  tcp: boolean;
  udp: boolean;
  ip4: boolean;
  ip6: boolean;
  listen: boolean;
}

const DEFAULT_READ_DRAFT: BeaconReadDraft = {
  environmentName: "",
  path: "",
  pattern: "",
  count: "10",
  countBytes: false,
  recursive: false,
  before: "0",
  after: "0",
  tcp: true,
  udp: false,
  ip4: true,
  ip6: false,
  listen: false,
};

interface BeaconWindowsDraft {
  hive: SessionRegistryHive;
  path: string;
  key: string;
  hostname: string;
  serviceName: string;
  valueType: SessionRegistryWriteValue["type"];
  valueDraft: string;
}

const DEFAULT_WINDOWS_DRAFT: BeaconWindowsDraft = {
  hive: "HKCU",
  path: "",
  key: "",
  hostname: "",
  serviceName: "",
  valueType: "string",
  valueDraft: "",
};

const REGISTRY_HIVES: readonly SessionRegistryHive[] = ["HKCU", "HKLM", "HKCR", "HKU", "HKCC"];
const REGISTRY_VALUE_TYPES: readonly SessionRegistryWriteValue["type"][] = ["string", "binary", "dword", "qword"];

const NETSTAT_OPTION_LABELS = {
  tcp: "TCP",
  udp: "UDP",
  ip4: "IPv4",
  ip6: "IPv6",
  listen: "Include listening sockets",
} as const;

type BeaconMetadataCommandId = "beacon.identity.pid" | "beacon.identity.uid" | "beacon.identity.gid";

const COMMAND_CAPABILITIES: Readonly<Record<Exclude<BeaconInteractionCommandId, BeaconExecutionSelection | BeaconMetadataCommandId>, TargetCapabilityId>> = {
  "beacon.filesystem.pwd": "target.task.execute",
  "beacon.filesystem.ls": "target.task.execute",
  "beacon.process.list": "target.task.execute",
  "beacon.network.interfaces": "target.task.execute",
  "beacon.environment.list": "target.task.execute",
  "beacon.identity.whoami": "target.task.execute",
  "beacon.network.netstat": "target.task.execute",
  "beacon.filesystem.mount": "target.task.execute",
  "beacon.filesystem.memfiles": "target.task.execute",
  "beacon.filesystem.cat": "target.task.execute",
  "beacon.filesystem.head": "target.task.execute",
  "beacon.filesystem.tail": "target.task.execute",
  "beacon.filesystem.grep": "target.task.execute",
  "beacon.registry.list-subkeys": "target.task.execute",
  "beacon.registry.list-values": "target.task.execute",
  "beacon.registry.read": "target.task.execute",
  "beacon.registry.create": "target.task.execute",
  "beacon.registry.delete": "target.task.execute",
  "beacon.registry.write": "target.task.execute",
  "beacon.service.list": "target.task.execute",
  "beacon.service.info": "target.task.execute",
  "beacon.service.start": "target.task.execute",
  "beacon.service.stop": "target.task.execute",
  "target.ping": "target.ping",
  "target.rename": "target.rename",
  "target.env-set": "target.environment.write",
  "target.env-unset": "target.environment.write",
  "beacon.reconfigure": "beacon.reconfigure",
  "beacon.open-session": "beacon.open-session",
};

export interface BeaconInteractionWorkspaceProps {
  expectedTarget: TargetRef;
  beacon: BeaconSummary;
  targetIdentity: string;
  capabilities: readonly TargetCapabilityState[];
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
  operationUpdates: readonly TargetOperationRecord[];
}

export function BeaconInteractionWorkspace({
  expectedTarget,
  beacon,
  targetIdentity,
  capabilities,
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
  operationUpdates,
}: BeaconInteractionWorkspaceProps): React.JSX.Element {
  const [commandId, setCommandId] = useState<BeaconInteractionCommandId>("beacon.filesystem.pwd");
  const [path, setPath] = useState(".");
  const [fullInfo, setFullInfo] = useState(false);
  const [managementDraft, setManagementDraft] = useState<BeaconManagementDraft>(DEFAULT_MANAGEMENT_DRAFT);
  const [readDraft, setReadDraft] = useState<BeaconReadDraft>(DEFAULT_READ_DRAFT);
  const [windowsDraft, setWindowsDraft] = useState<BeaconWindowsDraft>(DEFAULT_WINDOWS_DRAFT);
  const [submitError, setSubmitError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewPlan, setReviewPlan] = useState<BeaconMutationPlan>();
  const [isExecutingMutation, setIsExecutingMutation] = useState(false);
  const [submittedOperation, setSubmittedOperation] = useState<TargetOperationRecord>();
  const [executionState, setExecutionState] = useState<BeaconExecutionCommandState>({ isPending: false, isAvailable: false });
  const executionFormId = useId();
  const [cancelingTaskIds, setCancelingTaskIds] = useState<Set<string>>(() => new Set());
  const [queuedTaskId, setQueuedTaskId] = useState<string>();
  const [taskView, setTaskView] = useState("output");
  const [outputJump, setOutputJump] = useState<{ taskId: string; sequence: number }>();
  const jumpSequence = useRef(0);
  const identityRef = useRef(targetIdentity);
  identityRef.current = targetIdentity;
  const mountedRef = useRef(true);
  const commandRef = useRef(commandId);
  commandRef.current = commandId;
  const reviewPlanRef = useRef<BeaconMutationPlan | undefined>(undefined);
  reviewPlanRef.current = reviewPlan;
  const preparingMutationRef = useRef(false);
  const executingMutationRef = useRef(false);
  const { entries: outputs, loadOutput } = useBeaconTaskOutputs(targetIdentity, tasks, taskView === "output", false);
  const { contains } = useFilter({ sensitivity: "base" });
  const command = BEACON_COMMANDS.find((item) => item.id === commandId) ?? BEACON_COMMANDS[0]!;
  const isExecutionCommand = isBeaconExecutionCommandId(commandId);
  const isManagementCommand = isBeaconManagementCommandId(commandId);
  const metadataFact = beaconMetadataFact(commandId, beacon, expectedTarget);
  const capability = isExecutionCommand || isBeaconMetadataCommandId(commandId)
    ? undefined
    : capabilityFor(capabilities, COMMAND_CAPABILITIES[commandId]);
  const commandAvailable = metadataFact === undefined && capability?.available === true &&
    beacon.id === expectedTarget.id &&
    (isManagementCommand ? expectedTarget.mode === "beacon" : canQueue) &&
    (commandId !== "beacon.filesystem.memfiles" || beacon.os.toLocaleLowerCase() === "linux") &&
    (commandId !== "beacon.identity.whoami" || beacon.os.toLocaleLowerCase() === "windows") &&
    (!isBeaconWindowsCommandId(commandId) || beacon.os.toLocaleLowerCase() === "windows");
  const updatedOperation = submittedOperation && operationUpdates.find((operation) =>
    operation.requestId === submittedOperation.requestId &&
    sameTarget(operation.target, submittedOperation.target) &&
    operation.updatedAt >= submittedOperation.updatedAt);
  const latestOperation = updatedOperation ?? submittedOperation;

  useEffect(() => {
    setCommandId("beacon.filesystem.pwd");
    setPath(".");
    setFullInfo(false);
    setManagementDraft(DEFAULT_MANAGEMENT_DRAFT);
    setReadDraft(DEFAULT_READ_DRAFT);
    setWindowsDraft(DEFAULT_WINDOWS_DRAFT);
    setSubmitError(undefined);
    setIsSubmitting(false);
    setIsExecutingMutation(false);
    preparingMutationRef.current = false;
    executingMutationRef.current = false;
    const stalePlan = reviewPlanRef.current;
    reviewPlanRef.current = undefined;
    setReviewPlan(undefined);
    if (stalePlan) discardBeaconMutationPlan(stalePlan);
    setSubmittedOperation(undefined);
    setExecutionState({ isPending: false, isAvailable: false });
    setCancelingTaskIds(new Set());
    setQueuedTaskId(undefined);
    setTaskView("output");
    setOutputJump(undefined);
  }, [targetIdentity]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const stalePlan = reviewPlanRef.current;
      reviewPlanRef.current = undefined;
      if (stalePlan) discardBeaconMutationPlan(stalePlan);
    };
  }, []);

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
    if (metadataFact || !commandAvailable || isSubmitting || isExecutingMutation || preparingMutationRef.current) return;
    const submittedIdentity = targetIdentity;
    const submittedCommand = commandId;
    let input: TargetOperationInput;
    try {
      input = beaconCommandInput(commandId, path, fullInfo, managementDraft, readDraft, windowsDraft);
      setSubmitError(undefined);
    } catch (validationError) {
      setSubmitError(errorMessage(validationError));
      return;
    }

    setIsSubmitting(true);
    if (isBeaconMutationCommandId(submittedCommand)) preparingMutationRef.current = true;
    try {
      if (isBeaconMutationCommandId(submittedCommand)) {
        const prepared = await window.sliver.prepareBeaconMutation(input as BeaconMutationOperationInput);
        if (!mountedRef.current || identityRef.current !== submittedIdentity || commandRef.current !== submittedCommand) {
          if (prepared.ok && prepared.value) discardBeaconMutationPlan(prepared.value);
          return;
        }
        if (!prepared.ok || !prepared.value) throw new Error(prepared.error ?? "The beacon mutation could not be reviewed.");
        if (prepared.value.operationId !== submittedCommand || !sameReviewTarget(prepared.value.target, expectedTarget) ||
          prepared.value.backend.epoch !== expectedTarget.backendEpoch) {
          discardBeaconMutationPlan(prepared.value);
          throw new Error("The review no longer matches this command and beacon.");
        }
        reviewPlanRef.current = prepared.value;
        setReviewPlan(prepared.value);
        return;
      }
      const result = await window.sliver.submitTargetOperation(input);
      if (identityRef.current !== submittedIdentity) return;
      if (!result.ok || !result.value) {
        setSubmitError(result.error ?? "The beacon task was rejected");
        return;
      }
      if (!onSubmitted(result.value)) return;
      if (isBeaconManagementCommandId(commandId)) {
        setSubmittedOperation(result.value);
        setManagementDraft(DEFAULT_MANAGEMENT_DRAFT);
        if (result.value.taskId) {
          setQueuedTaskId(result.value.taskId);
          onRefresh();
        } else if (result.value.state !== "completed" && result.value.state !== "failed" && result.value.state !== "target-disappeared") {
          setSubmitError(result.value.message ?? "The operation has no exact beacon task ID, so queue insertion was not confirmed.");
        }
        return;
      }
      if (!result.value.taskId) {
        setSubmitError(
          result.value.message ??
          "The operation finished without an exact beacon task ID, so queue insertion was not confirmed.",
        );
        return;
      }
      setQueuedTaskId(result.value.taskId);
      toast.success("Task queued", {
        description: `${command.label} will run after the beacon checks in.`,
      });
      onRefresh();
    } catch (submissionError) {
      if (identityRef.current === submittedIdentity && commandRef.current === submittedCommand) setSubmitError(errorMessage(submissionError));
    } finally {
      if (isBeaconMutationCommandId(submittedCommand)) preparingMutationRef.current = false;
      if (identityRef.current === submittedIdentity) setIsSubmitting(false);
    }
  };

  const dismissReview = (): void => {
    if (executingMutationRef.current) return;
    const plan = reviewPlanRef.current;
    reviewPlanRef.current = undefined;
    setReviewPlan(undefined);
    if (plan) discardBeaconMutationPlan(plan);
  };

  const confirmReview = async (): Promise<void> => {
    const plan = reviewPlanRef.current;
    if (!plan || executingMutationRef.current || !sameReviewTarget(plan.target, expectedTarget) ||
      plan.operationId !== commandId || !commandAvailable) return;
    const submittedIdentity = targetIdentity;
    executingMutationRef.current = true;
    setIsExecutingMutation(true);
    setSubmitError(undefined);
    try {
      const result = await window.sliver.executeBeaconMutation({ token: plan.token });
      if (!mountedRef.current || identityRef.current !== submittedIdentity || reviewPlanRef.current?.token !== plan.token) return;
      reviewPlanRef.current = undefined;
      setReviewPlan(undefined);
      if (!result.ok || !result.value) throw new Error(result.error ?? "The reviewed beacon mutation could not be queued.");
      if (result.value.operationId !== plan.operationId || !sameTarget(result.value.target, plan.target)) {
        throw new Error("The queued result did not match the reviewed command and beacon.");
      }
      if (!onSubmitted(result.value)) return;
      setSubmittedOperation(result.value);
      if (!result.value.taskId) {
        setSubmitError(result.value.message ?? "The operation has no exact beacon task ID, so queue insertion was not confirmed.");
        return;
      }
      setQueuedTaskId(result.value.taskId);
      toast.success("Task queued", { description: "The mutation result will appear after the beacon checks in." });
      onRefresh();
    } catch (submissionError) {
      if (reviewPlanRef.current?.token === plan.token) {
        reviewPlanRef.current = undefined;
        setReviewPlan(undefined);
        discardBeaconMutationPlan(plan);
      }
      if (identityRef.current === submittedIdentity) setSubmitError(errorMessage(submissionError));
    } finally {
      executingMutationRef.current = false;
      if (identityRef.current === submittedIdentity) setIsExecutingMutation(false);
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
              <h2 className="text-sm font-semibold text-foreground" id="beacon-command-heading">Beacon command</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">Choose a command, configure it, and follow its result.</p>
            </div>
          </div>

          <div className="flex flex-col gap-4 border-t border-separator px-5 py-5">
            {!metadataFact ? <Button
              fullWidth
              {...(isExecutionCommand ? { form: executionFormId } : {})}
              type={isExecutionCommand ? "submit" : "button"}
              isDisabled={isExecutionCommand ? !executionState.isAvailable : !commandAvailable || reviewPlan !== undefined}
              isPending={isExecutionCommand ? executionState.isPending : isSubmitting || isExecutingMutation}
              {...(isExecutionCommand ? {} : { onPress: () => void submit() })}
            >
              <FontAwesomeIcon aria-hidden icon={faListCheck} /> {commandId === "target.rename" ? "Rename beacon" : isBeaconMutationCommandId(commandId) ? "Review task" : "Queue task"}
            </Button> : null}
            <Autocomplete
              fullWidth
              placeholder="Search beacon commands"
              selectionMode="single"
              value={commandId}
              variant="secondary"
              onChange={(key: Key | Key[] | null) => {
                if (key === null || Array.isArray(key)) return;
                const nextId = String(key);
                if (!isBeaconInteractionCommandId(nextId)) return;
                dismissReview();
                setCommandId(nextId);
                setManagementDraft(DEFAULT_MANAGEMENT_DRAFT);
                setReadDraft({ ...DEFAULT_READ_DRAFT, count: nextId === "beacon.filesystem.tail" ? "4096" : "10", countBytes: nextId === "beacon.filesystem.tail" });
                setWindowsDraft(DEFAULT_WINDOWS_DRAFT);
                setExecutionState({ isPending: false, isAvailable: false });
                setSubmitError(undefined);
              }}
            >
              <Label>Command</Label>
              <Autocomplete.Trigger>
                <Autocomplete.Value />
                <Autocomplete.ClearButton />
                <Autocomplete.Indicator />
              </Autocomplete.Trigger>
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

            {isExecutionCommand ? (
              <BeaconExecutionCommand
                expectedTarget={expectedTarget}
                formId={executionFormId}
                key={`${targetIdentity}:${commandId}`}
                selection={commandId}
                targetIdentity={targetIdentity}
                onStateChange={setExecutionState}
                onQueuedTask={(taskId) => {
                  if (identityRef.current !== targetIdentity) return;
                  setQueuedTaskId(taskId);
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

              {metadataFact ? (
                <div className="mt-4 rounded-xl border border-separator bg-surface px-4 py-3" role="status">
                  <p className="text-xs text-muted">{metadataFact.label} · latest server target inventory</p>
                  <p className="mt-1 break-all font-mono text-sm text-foreground">{metadataFact.exact ? metadataFact.value ?? "Not reported" : "Waiting for selected beacon inventory"}</p>
                  {metadataFact.exact ? <p className="mt-2 text-xs text-muted">Last check-in: {formatTimestamp(beacon.lastCheckinAt)}. This value was reported by the server and is not a new task result.</p> : null}
                </div>
              ) : null}

              {commandId !== "beacon.filesystem.pwd" && commandId !== "beacon.network.interfaces" && commandId !== "target.ping" && !metadataFact ? (
                <div className="mt-4">
                  {commandId === "beacon.filesystem.ls" ? (
                    <Field
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
                      </Switch.Content>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch>
                  ) : null}
                  {commandId === "target.rename" ? (
                    <Field label="New target name" value={managementDraft.name} onChange={(name) => setManagementDraft((current) => ({ ...current, name }))} />
                  ) : null}
                  {commandId === "target.env-set" ? (
                    <div className="flex flex-col gap-3">
                      <Field label="Variable name" mono value={managementDraft.name} onChange={(name) => setManagementDraft((current) => ({ ...current, name }))} />
                      <AreaField label="Variable value" mono rows={3} value={managementDraft.value} onChange={(value) => setManagementDraft((current) => ({ ...current, value }))} />
                    </div>
                  ) : null}
                  {commandId === "target.env-unset" ? (
                    <Field label="Variable name" mono value={managementDraft.name} onChange={(name) => setManagementDraft((current) => ({ ...current, name }))} />
                  ) : null}
                  {commandId === "beacon.reconfigure" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Reconnect seconds" type="number" min={1} value={managementDraft.reconnectIntervalSeconds} onChange={(value) => setManagementDraft((current) => ({ ...current, reconnectIntervalSeconds: value }))} />
                      <Field label="Interval seconds" type="number" min={1} value={managementDraft.intervalSeconds} onChange={(value) => setManagementDraft((current) => ({ ...current, intervalSeconds: value }))} />
                      <Field label="Jitter seconds" type="number" min={1} value={managementDraft.jitterSeconds} onChange={(value) => setManagementDraft((current) => ({ ...current, jitterSeconds: value }))} />
                    </div>
                  ) : null}
                  {commandId === "beacon.open-session" ? (
                    <Field label="Delay seconds" type="number" min={0} value={managementDraft.delaySeconds} onChange={(value) => setManagementDraft((current) => ({ ...current, delaySeconds: value }))} />
                  ) : null}
                  {commandId === "beacon.environment.list" ? (
                    <div className="space-y-2">
                      <Field label="Filter by variable name (optional)" mono value={readDraft.environmentName} onChange={(environmentName) => setReadDraft((current) => ({ ...current, environmentName }))} />
                      <p className="text-xs text-muted">Variables with recognized sensitive names are masked in task history.</p>
                    </div>
                  ) : null}
                  {commandId === "beacon.filesystem.cat" || commandId === "beacon.filesystem.head" || commandId === "beacon.filesystem.tail" || commandId === "beacon.filesystem.grep" ? (
                    <Field label={commandId === "beacon.filesystem.grep" ? "Search path" : "File path"} mono required value={readDraft.path} onChange={(value) => setReadDraft((current) => ({ ...current, path: value }))} />
                  ) : null}
                  {commandId === "beacon.filesystem.head" || commandId === "beacon.filesystem.tail" ? (
                    <div className="mt-3 flex flex-col gap-3">
                      {commandId === "beacon.filesystem.head" ? (
                        <Switch aria-label="Count bytes instead of lines" isSelected={readDraft.countBytes} onChange={(countBytes) => setReadDraft((current) => ({ ...current, countBytes, count: countBytes ? "4096" : "10" }))}>
                          <Switch.Content className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Count bytes instead of lines</span></Switch.Content>
                          <Switch.Control><Switch.Thumb /></Switch.Control>
                        </Switch>
                      ) : null}
                      <Field label={commandId === "beacon.filesystem.tail" || readDraft.countBytes ? "Bytes" : "Lines"} type="number" min={1} max={commandId === "beacon.filesystem.head" && !readDraft.countBytes ? 4096 : 65536} value={readDraft.count} onChange={(value) => setReadDraft((current) => ({ ...current, count: value }))} />
                    </div>
                  ) : null}
                  {commandId === "beacon.filesystem.grep" ? (
                    <div className="mt-3 flex flex-col gap-3">
                      <Field label="Search pattern" mono required value={readDraft.pattern} onChange={(value) => setReadDraft((current) => ({ ...current, pattern: value }))} />
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Lines before" type="number" min={0} max={64} value={readDraft.before} onChange={(value) => setReadDraft((current) => ({ ...current, before: value }))} />
                        <Field label="Lines after" type="number" min={0} max={64} value={readDraft.after} onChange={(value) => setReadDraft((current) => ({ ...current, after: value }))} />
                      </div>
                      <Switch aria-label="Search recursively" isSelected={readDraft.recursive} onChange={(recursive) => setReadDraft((current) => ({ ...current, recursive }))}>
                        <Switch.Content className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">Search recursively</span></Switch.Content>
                        <Switch.Control><Switch.Thumb /></Switch.Control>
                      </Switch>
                    </div>
                  ) : null}
                  {commandId === "beacon.network.netstat" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["tcp", "udp", "ip4", "ip6", "listen"] as const).map((option) => (
                        <Switch aria-label={NETSTAT_OPTION_LABELS[option]} isSelected={readDraft[option]} key={option} onChange={(selected) => setReadDraft((current) => ({ ...current, [option]: selected }))}>
                          <Switch.Content className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{NETSTAT_OPTION_LABELS[option]}</span></Switch.Content>
                          <Switch.Control><Switch.Thumb /></Switch.Control>
                        </Switch>
                      ))}
                    </div>
                  ) : null}
                  {isBeaconWindowsCommandId(commandId) ? (
                    <BeaconWindowsFields commandId={commandId} draft={windowsDraft} onChange={setWindowsDraft} />
                  ) : null}
                </div>
              ) : null}
            </div>}

            {!isExecutionCommand && !metadataFact && !commandAvailable ? (
              <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="status">
                {beacon.id !== expectedTarget.id
                  ? "Wait for the selected beacon inventory to refresh."
                  : commandId === "beacon.filesystem.memfiles" && beacon.os.toLocaleLowerCase() !== "linux"
                  ? "Memory files require a Linux beacon."
                  : commandId === "beacon.identity.whoami" && beacon.os.toLocaleLowerCase() !== "windows"
                    ? "A token-owner task requires a Windows beacon."
                    : isBeaconWindowsCommandId(commandId) && beacon.os.toLocaleLowerCase() !== "windows"
                      ? "Registry and service commands require a Windows beacon."
                    : isManagementCommand
                  ? capability?.reason?.message ?? "This command is unavailable for the selected beacon."
                  : unavailableReason ?? capability?.reason?.message ?? "Task execution is unavailable for this beacon."}
              </p>
            ) : null}
            {submitError ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger-soft-foreground" role="alert">{submitError}</p> : null}
            {(isManagementCommand || isBeaconMutationCommandId(commandId)) && latestOperation?.operationId === commandId ? (
              <p
                aria-label="Beacon command status"
                className={`text-xs leading-relaxed ${latestOperation.state === "failed" || latestOperation.state === "target-disappeared"
                  ? "text-danger"
                  : latestOperation.state === "partial" || latestOperation.state === "outcome-unknown"
                    ? "text-warning"
                    : "text-muted"}`}
                role="status"
              >
                {command.label} · {operationStateLabel(latestOperation.state)} · Request ID: {latestOperation.requestId}
                {latestOperation.taskId ? ` · Task ID: ${latestOperation.taskId}` : ""}
                {latestOperation.message ? ` · ${latestOperation.message}` : ""}
                {isBeaconMutationCommandId(commandId) ? " · Verify the remote state after check-in." : ""}
              </p>
            ) : null}
          </div>
        </section>
      </div>

      <section aria-label="Beacon tasks" className="beacon-task-views min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface">
        <Tabs className="absolute inset-0 min-h-0 min-w-0 gap-0" selectedKey={taskView} onSelectionChange={(key) => setTaskView(String(key))}>
          <Tabs.ListContainer className="mx-5 my-3 w-fit max-w-full shrink-0">
            <Tabs.List aria-label="Beacon task views" className="p-0.5">
              <Tabs.Tab className="h-6 whitespace-nowrap px-2.5 text-xs" id="output">Task output<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab className="h-6 whitespace-nowrap px-2.5 text-xs" id="queue">Task queue<Tabs.Indicator /></Tabs.Tab>
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
              isActive={taskView === "output"}
              isLoadingMore={isLoadingMore}
              jump={outputJump}
              key={targetIdentity}
              outputs={outputs}
              page={page}
              onCancel={(task) => void cancel(task)}
              onLoadMore={onLoadMore}
              onRetry={(task) => loadOutput(task, true)}
              onVisible={loadOutput}
            />
          </Tabs.Panel>
        </Tabs>
      </section>
      <BeaconMutationReviewDialog isExecuting={isExecutingMutation} plan={reviewPlan} onCancel={dismissReview} onConfirm={() => void confirmReview()} />
    </div>
  );
}

function BeaconWindowsFields({ commandId, draft, onChange }: {
  commandId: BeaconWindowsCommandId;
  draft: BeaconWindowsDraft;
  onChange: React.Dispatch<React.SetStateAction<BeaconWindowsDraft>>;
}): React.JSX.Element {
  const registry = commandId.startsWith("beacon.registry.");
  const write = commandId === "beacon.registry.write";
  const keyName = commandId === "beacon.registry.create" ? "Subkey name" :
    commandId === "beacon.registry.delete" ? "Entry name" : "Value name";
  const showKey = commandId === "beacon.registry.read" || write ||
    commandId === "beacon.registry.create" || commandId === "beacon.registry.delete";
  return (
    <div className="space-y-3">
      {registry ? (
        <>
          <Select aria-label="Registry hive" value={draft.hive} variant="secondary" onChange={(key) => {
            const next = String(key);
            if (REGISTRY_HIVES.some((hive) => hive === next)) onChange((current) => ({ ...current, hive: next as SessionRegistryHive }));
          }}>
            <Label>Registry hive</Label>
            <Select.Trigger><Select.Value /><Select.Indicator><FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} /></Select.Indicator></Select.Trigger>
            <Select.Popover><ListBox>{REGISTRY_HIVES.map((hive) => <ListBox.Item id={hive} key={hive} textValue={hive}>{hive}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
          </Select>
          <Field label="Registry path" mono value={draft.path} onChange={(path) => onChange((current) => ({ ...current, path }))}
            description="Path below the selected hive; leave empty for its root." />
          {showKey ? <Field label={keyName} mono value={draft.key} onChange={(key) => onChange((current) => ({ ...current, key }))}
            description={write || commandId === "beacon.registry.read" ? "Leave empty for the default value." : "Name directly beneath the registry path."} /> : null}
          {commandId === "beacon.registry.delete" ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning-soft-foreground">
            Sliver deletes a value with this name first. It deletes the subkey only when no value by that name exists.
          </p> : null}
          {write ? (
            <>
              <Select aria-label="Registry value type" value={draft.valueType} variant="secondary" onChange={(key) => {
                const next = String(key);
                if (REGISTRY_VALUE_TYPES.some((type) => type === next)) onChange((current) => ({ ...current, valueType: next as SessionRegistryWriteValue["type"], valueDraft: "" }));
              }}>
                <Label>Registry value type</Label>
                <Select.Trigger><Select.Value /><Select.Indicator><FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} /></Select.Indicator></Select.Trigger>
                <Select.Popover><ListBox>{REGISTRY_VALUE_TYPES.map((type) => <ListBox.Item id={type} key={type} textValue={type}>{type === "dword" || type === "qword" ? type.toUpperCase() : type === "binary" ? "Binary" : "String"}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></Select.Popover>
              </Select>
              {draft.valueType === "string" || draft.valueType === "binary"
                ? <AreaField label={draft.valueType === "binary" ? "Hexadecimal bytes" : "String value"} mono rows={3} value={draft.valueDraft} onChange={(valueDraft) => onChange((current) => ({ ...current, valueDraft }))} />
                : <Field label={draft.valueType === "dword" ? "Unsigned 32-bit value" : "Unsigned 64-bit value"} mono value={draft.valueDraft} onChange={(valueDraft) => onChange((current) => ({ ...current, valueDraft }))} />}
            </>
          ) : null}
        </>
      ) : commandId !== "beacon.service.list" ? (
        <Field label="Service name" mono required value={draft.serviceName} onChange={(serviceName) => onChange((current) => ({ ...current, serviceName }))} />
      ) : null}
      <Field label="Host (optional)" mono value={draft.hostname} onChange={(hostname) => onChange((current) => ({ ...current, hostname }))}
        description="Leave empty to use the beacon host." />
    </div>
  );
}

function BeaconMutationReviewDialog({ plan, isExecuting, onCancel, onConfirm }: {
  plan: BeaconMutationPlan | undefined;
  isExecuting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog.Backdrop isOpen={plan !== undefined} onOpenChange={(open) => { if (!open && !isExecuting) onCancel(); }} variant="blur">
      <AlertDialog.Container placement="center" size="lg">
        <AlertDialog.Dialog className="sm:max-w-2xl">
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /></AlertDialog.Icon>
            <AlertDialog.Heading>Queue this reviewed beacon mutation?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            {plan ? <div className="space-y-4 text-sm">
              <p className="leading-6 text-foreground">{plan.summary}</p>
              {plan.operationId === "beacon.registry.delete" ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning-soft-foreground">
                Sliver deletes a value with this name first. It deletes the subkey only when no value by that name exists.
              </p> : null}
              <section aria-label="Reviewed beacon" className="rounded-xl border border-separator bg-default px-4 py-3">
                <p className="font-medium text-foreground">{plan.targetName}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted">{plan.target.mode}:{plan.target.id} · {plan.target.fingerprint}</p>
                <p className="mt-1 text-xs text-muted">{plan.backend.operator}@{plan.backend.server} · epoch {plan.backend.epoch}</p>
              </section>
              <dl aria-label="Reviewed mutation fields" className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
                {plan.fields.map((field, index) => (
                  <div className="min-w-0" key={`${field.label}-${index}`}>
                    <dt className="text-xs text-muted">{field.label}</dt>
                    <dd className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">{String(field.value ?? "")}</dd>
                  </div>
                ))}
              </dl>
              <p className="break-all font-mono text-[11px] text-muted">Payload SHA-256 {plan.payloadSha256}</p>
              <p className="text-xs text-muted">Review expires {new Date(plan.expiresAt).toLocaleTimeString()}. Queueing confirms receipt by the server; inspect the task result and requery the remote state after check-in.</p>
            </div> : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={isExecuting} size="sm" variant="tertiary" onPress={onCancel}>Cancel</Button>
            <Button isPending={isExecuting} size="sm" variant="danger" onPress={onConfirm}>Queue reviewed task</Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
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
      cell: (task) => {
        const presentation = getBeaconTaskPresentation(task);
        return (
          <div className="min-w-0 py-1">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <FontAwesomeIcon aria-hidden className="shrink-0 text-accent" icon={presentation.icon} />
              <span className="truncate">{presentation.label}</span>
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{task.taskId}</p>
          </div>
        );
      },
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
  isActive,
  page,
  isLoadingMore,
  onCancel,
  onRetry,
  onLoadMore,
  onVisible,
}: {
  outputs: BeaconTaskOutputEntry[];
  jump: { taskId: string; sequence: number } | undefined;
  cancelingTaskIds: Set<string>;
  error: string | undefined;
  isActive: boolean;
  page: PageSummary | undefined;
  isLoadingMore: boolean;
  onCancel: (task: BeaconTaskDetail) => void;
  onRetry: (task: BeaconTaskSummary) => void;
  onLoadMore: (cursor: string) => void;
  onVisible: (task: BeaconTaskSummary) => void;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const entryRefs = useRef(new Map<string, HTMLElement>());
  const entryRefCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const observerRef = useRef<IntersectionObserver | undefined>(undefined);
  const visibleTaskIds = useRef(new Set<string>());
  const requestedRevisions = useRef(new Map<string, string>());
  const canceledJumpSequence = useRef<number | undefined>(undefined);
  const outputById = useRef(new Map(outputs.map((output) => [output.task.taskId, output])));
  outputById.current = new Map(outputs.map((output) => [output.task.taskId, output]));
  const requestVisibleRef = useRef<(taskId: string) => void>(() => undefined);
  requestVisibleRef.current = (taskId) => {
    if (!isActive) return;
    const output = outputById.current.get(taskId);
    if (!output || output.detail || output.isLoading || output.error) return;
    const task = output.task;
    const revision = JSON.stringify([task.state, task.resultAvailable, task.sentAt, task.completedAt]);
    if (requestedRevisions.current.get(taskId) === revision) return;
    requestedRevisions.current.set(taskId, revision);
    onVisible(task);
  };
  const entryRef = (taskId: string): ((element: HTMLElement | null) => void) => {
    let callback = entryRefCallbacks.current.get(taskId);
    if (!callback) {
      callback = (element) => {
        const previous = entryRefs.current.get(taskId);
        if (previous && previous !== element) observerRef.current?.unobserve(previous);
        if (element) {
          entryRefs.current.set(taskId, element);
          observerRef.current?.observe(element);
        } else {
          entryRefs.current.delete(taskId);
          visibleTaskIds.current.delete(taskId);
        }
      };
      entryRefCallbacks.current.set(taskId, callback);
    }
    return callback;
  };
  const jumpIsLoading = outputs.find((entry) => entry.task.taskId === jump?.taskId)?.isLoading;
  const nextCursor = page?.nextCursor;

  useEffect(() => {
    if (!isActive || outputs.length === 0) return;
    const viewport = viewportRef.current;
    if (!viewport || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const taskId = entry.target.getAttribute("data-task-id");
        if (!taskId) continue;
        if (entry.isIntersecting) {
          visibleTaskIds.current.add(taskId);
          requestVisibleRef.current(taskId);
        } else {
          visibleTaskIds.current.delete(taskId);
        }
      }
    }, { root: viewport, rootMargin: "160px 0px", threshold: 0 });
    observerRef.current = observer;
    for (const element of entryRefs.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = undefined;
      visibleTaskIds.current.clear();
    };
  }, [isActive, outputs.length > 0]);

  useEffect(() => {
    if (!isActive) return;
    // jsdom and older runtimes have no intersection observer. Bound the
    // initial fallback instead of loading every retained server response.
    if (typeof IntersectionObserver === "undefined") {
      for (const output of outputs.slice(0, 8)) visibleTaskIds.current.add(output.task.taskId);
    }
    for (const taskId of visibleTaskIds.current) requestVisibleRef.current(taskId);
  }, [isActive, outputs]);

  useEffect(() => {
    if (!isActive || !jump || canceledJumpSequence.current === jump.sequence) return;
    const entry = entryRefs.current.get(jump.taskId);
    const viewport = viewportRef.current;
    if (!entry || !viewport) return;
    entry.focus({ preventScroll: true });
    const scrollport = viewport.closest(".app-content, .interaction-window__content");
    const summary = scrollport?.querySelector('header[aria-label="Beacon summary"]');
    const revealOutput = (): void => {
      if (!scrollport) return;
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
    const alignEntry = (): void => {
      const delta = entry.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20;
      if (Math.abs(delta) > 1) viewport.scrollTop += delta;
      revealOutput();
    };
    alignEntry();
    // Pinning the summary changes its bounds; remeasure after its scroll observer commits.
    let frame = requestAnimationFrame(() => {
      alignEntry();
      frame = requestAnimationFrame(alignEntry);
    });
    let resizeFrame = 0;
    const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(alignEntry);
    });
    if (contentRef.current) resizeObserver?.observe(contentRef.current);
    resizeObserver?.observe(viewport);
    const stopFollowing = (): void => {
      canceledJumpSequence.current = jump.sequence;
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
    };
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      // Stop pending scroll corrections before controls inside the row handle
      // the same pointer or keyboard event.
      viewport.addEventListener(event, stopFollowing, { capture: true, passive: true });
    }
    return () => {
      resizeObserver?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) {
        viewport.removeEventListener(event, stopFollowing, true);
      }
    };
  }, [isActive, jump, jumpIsLoading]);

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
          <div className="flex min-w-0 flex-col gap-5" ref={contentRef}>
            {outputs.map((output) => (
              <article
                aria-label={`Task output ${output.task.taskId}`}
                className="min-w-0 rounded-xl border-b border-separator pb-5 outline-none last:border-b-0 last:pb-0 focus-visible:ring-2 focus-visible:ring-accent"
                data-task-id={output.task.taskId}
                key={output.task.taskId}
                ref={entryRef(output.task.taskId)}
                tabIndex={-1}
              >
                <BeaconTaskOutput
                  isCanceling={cancelingTaskIds.has(output.task.taskId)}
                  output={output}
                  onCancel={onCancel}
                  onLoad={() => onVisible(output.task)}
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

export function BeaconTaskOutput({ output, isCanceling, onCancel, onLoad, onRetry }: {
  output: BeaconTaskOutputEntry;
  isCanceling: boolean;
  onCancel: (task: BeaconTaskDetail) => void;
  onLoad: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const task = output.detail;
  const presentation = getBeaconTaskPresentation(task ?? output.task);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <FontAwesomeIcon aria-hidden className="shrink-0 text-accent" icon={presentation.icon} />
            <span>{presentation.label}</span>
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <BeaconTaskDetails key={`${output.task.beaconId}:${output.task.taskId}`} task={task ?? output.task} />
          <Chip color={taskStateColor(task?.state ?? output.task.state)} size="sm" variant="soft">{stateLabel(task?.state ?? output.task.state)}</Chip>
        </div>
      </div>
      {output.isLoading ? <p className="text-xs text-muted" role="status">Loading task output…</p> : null}
      {!task && !output.isLoading && !output.error ? (
        <Button className="self-start" size="sm" variant="tertiary" onPress={onLoad}>Load task output</Button>
      ) : null}
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
  if (task.executionRead) return <BeaconExecutionReadTaskOutput key={`${task.beaconId}:${task.taskId}`} task={task} />;
  if (task.execution) return <BeaconExecutionTaskOutput key={`${task.beaconId}:${task.taskId}:${task.execution.operationId}`} task={task} />;
  if (task.error && !task.disposition) return <></>;
  const operationId = task.operationId as string | undefined;
  if (operationId === "beacon.filesystem.pwd") return <WorkingDirectoryResult disposition={task.disposition} />;
  if (operationId === "beacon.filesystem.ls") {
    return <TableResult disposition={task.disposition} emptyLabel="The directory is empty." presentation="directory" />;
  }
  if (operationId === "beacon.process.list") {
    return <TableResult disposition={task.disposition} emptyLabel="No processes were returned." presentation="processes" />;
  }
  if (operationId === "beacon.network.interfaces") return <NetworkInterfacesResult disposition={task.disposition} />;
  if (operationId === "beacon.environment.list") {
    return <TableResult description="Environment captured when the beacon executed the task." disposition={task.disposition} emptyLabel="No environment variables were returned." />;
  }
  if (operationId === "beacon.network.netstat") {
    return <TableResult description="Connection inventory captured when the beacon executed the task." disposition={task.disposition} emptyLabel="No network connections were returned." />;
  }
  if (operationId === "beacon.filesystem.mount") {
    return <TableResult description="Mounted filesystems captured when the beacon executed the task." disposition={task.disposition} emptyLabel="No mounts were returned." />;
  }
  if (operationId === "beacon.filesystem.memfiles") {
    return <TableResult description="Memory files captured when the beacon executed the task." disposition={task.disposition} emptyLabel="No memory files were returned." />;
  }
  if (operationId === "beacon.filesystem.grep") {
    return <TableResult description="Matches returned by this beacon task." disposition={task.disposition} emptyLabel="No matches were returned." />;
  }
  if (operationId === "beacon.filesystem.cat" || operationId === "beacon.filesystem.head" || operationId === "beacon.filesystem.tail") {
    return <TextResult disposition={task.disposition} title={operationResultTitle(task)} />;
  }
  if (operationId === "beacon.registry.list-subkeys" || operationId === "beacon.registry.list-values") {
    return <TableResult description="Registry entries returned by this beacon task." disposition={task.disposition}
      emptyLabel={operationId === "beacon.registry.list-subkeys" ? "No subkeys were returned." : "No values were returned."} />;
  }
  if (operationId === "beacon.service.list") {
    return <TableResult description="Windows services captured when the beacon executed the task." disposition={task.disposition}
      emptyLabel="No services were returned." />;
  }
  if (operationId === "beacon.registry.create" || operationId === "beacon.registry.delete" || operationId === "beacon.registry.write" ||
    operationId === "beacon.service.start" || operationId === "beacon.service.stop") {
    return <div className="space-y-2"><GenericDisposition disposition={task.disposition} />
      <p className="text-xs text-muted">This task result describes the reported action. Read the registry or service state again to verify the remote change.</p>
    </div>;
  }
  return <GenericDisposition disposition={task.disposition} />;
}

function BeaconExecutionReadTaskOutput({ task }: { task: BeaconTaskDetail }): React.JSX.Element {
  const [result, setResult] = useState<ExecutionReadResult>(task.executionRead!);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [pageError, setPageError] = useState<string>();
  const mounted = useRef(true);
  const pagingRef = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (task.executionRead?.state === "completed") {
      setResult(task.executionRead);
      setPageError(undefined);
    }
  }, [task.executionRead]);

  const loadMore = async (): Promise<void> => {
    if (result.state !== "completed" || !result.nextCursor || pagingRef.current) return;
    const requestedCursor = result.nextCursor;
    pagingRef.current = true;
    setIsLoadingMore(true);
    setPageError(undefined);
    try {
      const response = await window.sliver.runExecutionRead({
        operationId: result.operationId,
        taskId: task.taskId,
        cursor: requestedCursor,
        limit: 50,
      });
      if (!mounted.current) return;
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not load the next result page.");
      const next = response.value;
      if (next.state !== "completed" || next.operationId !== result.operationId || next.taskId !== task.taskId) {
        throw new Error("The next page did not match this beacon task.");
      }
      setResult((current) => current.nextCursor === requestedCursor ? appendExecutionReadPage(current, next) : current);
    } catch (error) {
      if (mounted.current) setPageError(errorMessage(error));
    } finally {
      pagingRef.current = false;
      if (mounted.current) setIsLoadingMore(false);
    }
  };

  if (result.state === "submitted") return <p className="text-xs text-muted" role="status">Waiting for the beacon read result.</p>;
  const children = result.operationId === "execution.children";
  const rows: OperationScalar[][] = children
    ? result.items.map((item) => [item.pid, item.path, item.args.join(" "), item.exited ? "Exited" : "Running", item.stdoutBytes + item.stderrBytes])
    : result.privileges.map((item) => [item.name, item.description, item.removed ? "Removed" : item.enabled ? "Enabled" : "Disabled", item.usedForAccess ? "Yes" : "No"]);
  const label = children ? "Background children" : "Windows privileges";
  return (
    <section aria-label={label} className="space-y-3" role="region">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {!children ? <p className="text-xs text-muted">{result.processName} · {result.processIntegrity}{result.currentIdentity ? ` · ${result.currentIdentity}` : ""}</p> : null}
        </div>
        <span className="text-xs text-muted">{rows.length} of {result.total}</span>
      </div>
      {rows.length ? (
        <ResultTable columns={children ? ["PID", "Process", "Arguments", "State", "Output bytes"] : ["Privilege", "Description", "State", "Used for access"]} rows={rows} />
      ) : <p className="rounded-2xl bg-default px-4 py-5 text-sm text-muted">{children ? "No tracked background children were reported." : "No Windows privileges were reported."}</p>}
      {result.truncated ? <TruncatedNotice /> : null}
      {pageError ? <InlineMessage tone="danger">{pageError}</InlineMessage> : null}
      {result.nextCursor ? <Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => void loadMore()}>Load more</Button> : null}
    </section>
  );
}

function appendExecutionReadPage(current: ExecutionReadResult, next: ExecutionReadResult): ExecutionReadResult {
  if (current.operationId === "execution.children" && next.operationId === "execution.children") {
    return { ...next, items: [...current.items, ...next.items] };
  }
  if (current.operationId === "privilege.get" && next.operationId === "privilege.get") {
    return { ...next, privileges: [...current.privileges, ...next.privileges] };
  }
  return next;
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
      <p className="break-all font-mono text-sm text-foreground">{String(path)}</p>
      {disposition?.kind === "structured-detail" && disposition.truncated ? <TruncatedNotice /> : null}
    </div>
  );
}

function TextResult({ disposition, title }: { disposition: OperationDisposition | undefined; title: string }): React.JSX.Element {
  if (disposition?.kind !== "inline-text") return <GenericDisposition disposition={disposition} />;
  return (
    <section aria-label={title} className="space-y-2" role="region">
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl bg-default p-4 font-mono text-xs leading-relaxed text-foreground">{disposition.text}</pre>
      {disposition.truncated ? <TruncatedNotice /> : null}
    </section>
  );
}

function TableResult({
  description,
  disposition,
  emptyLabel,
  presentation,
}: {
  description?: string | undefined;
  disposition: OperationDisposition | undefined;
  emptyLabel: string;
  presentation?: "directory" | "processes" | undefined;
}): React.JSX.Element {
  if (disposition?.kind !== "table") return <GenericDisposition disposition={disposition} />;
  return <PagedTableResult description={description} disposition={disposition} emptyLabel={emptyLabel} presentation={presentation} />;
}

function PagedTableResult({
  description,
  disposition,
  emptyLabel,
  presentation,
}: {
  description?: string | undefined;
  disposition: Extract<OperationDisposition, { kind: "table" }>;
  emptyLabel: string;
  presentation?: "directory" | "processes" | undefined;
}): React.JSX.Element {
  const [directorySort, setDirectorySort] = useState<"name" | "modified" | "size">("name");
  const [reverseSort, setReverseSort] = useState(false);
  const [processPid, setProcessPid] = useState("");
  const [processExecutable, setProcessExecutable] = useState("");
  const [processOwner, setProcessOwner] = useState("");
  const [processTree, setProcessTree] = useState(false);
  const [showCommandLine, setShowCommandLine] = useState(false);
  const prepared = useMemo(() => {
    if (presentation === "directory") {
      return { columns: disposition.columns, rows: sortDirectoryRows(disposition, directorySort, reverseSort) };
    }
    if (presentation === "processes") {
      return prepareProcessRows(disposition, {
        pid: processPid,
        executable: processExecutable,
        owner: processOwner,
        tree: processTree,
        commandLine: showCommandLine,
      });
    }
    return { columns: disposition.columns, rows: disposition.rows };
  }, [directorySort, disposition, presentation, processExecutable, processOwner, processPid, processTree, reverseSort, showCommandLine]);
  const preview = useTablePreview(prepared.rows);
  const hasProcessFilter = presentation === "processes" &&
    Boolean(processPid.trim() || processExecutable.trim() || processOwner.trim());
  return (
    <div>
      {description ? <p className="mb-3 text-xs text-muted">{description}</p> : null}
      {presentation === "directory" ? (
        <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Directory sort">
          <span className="text-xs text-muted">Sort decoded rows by</span>
          {(["name", "modified", "size"] as const).map((sort) => (
            <Button aria-pressed={directorySort === sort} key={sort} size="sm" variant={directorySort === sort ? "primary" : "tertiary"} onPress={() => setDirectorySort(sort)}>
              {sort === "name" ? "Name" : sort === "modified" ? "Modified" : "Size"}
            </Button>
          ))}
          <Switch aria-label="Reverse directory sort" isSelected={reverseSort} onChange={setReverseSort}>
            <Switch.Content className="min-w-0 flex-1"><span className="block text-xs text-foreground">Reverse</span></Switch.Content>
            <Switch.Control><Switch.Thumb /></Switch.Control>
          </Switch>
        </div>
      ) : null}
      {presentation === "processes" ? (
        <div className="mb-3 space-y-3 rounded-xl bg-default p-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Filter PID" type="number" min={0} value={processPid} onChange={setProcessPid} />
            <Field label="Filter executable" value={processExecutable} onChange={setProcessExecutable} />
            <Field label="Filter owner" value={processOwner} onChange={setProcessOwner} />
          </div>
          <div className="flex flex-wrap gap-4">
            <Switch aria-label="Show process tree" isSelected={processTree} onChange={setProcessTree}>
              <Switch.Content className="min-w-0 flex-1"><span className="block text-xs text-foreground">Process tree</span></Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch>
            <Switch aria-label="Show command line" isSelected={showCommandLine} onChange={setShowCommandLine}>
              <Switch.Content className="min-w-0 flex-1"><span className="block text-xs text-foreground">Command line</span></Switch.Content>
              <Switch.Control><Switch.Thumb /></Switch.Control>
            </Switch>
          </div>
          <p className="text-xs text-muted">These controls apply to decoded rows in this task. Owner and command line values require a task queued with full process details.</p>
        </div>
      ) : null}
      <TablePreviewControls preview={preview} sourceTotal={disposition.rows.length} />
      {preview.rows.length === 0 ? (
        <p className="rounded-2xl bg-default px-4 py-5 text-sm text-muted">{preview.query ? "No decoded rows match this filter." : hasProcessFilter ? "No decoded rows match the selected process filters." : emptyLabel}</p>
      ) : (
        <ResultTable columns={prepared.columns} rows={preview.rows} />
      )}
      {disposition.truncated ? <TruncatedNotice /> : null}
    </div>
  );
}

function NetworkInterfacesResult({ disposition }: { disposition: OperationDisposition | undefined }): React.JSX.Element {
  if (disposition?.kind !== "table") return <GenericDisposition disposition={disposition} />;
  return <PagedNetworkInterfacesResult disposition={disposition} />;
}

function PagedNetworkInterfacesResult({ disposition }: { disposition: Extract<OperationDisposition, { kind: "table" }> }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const visibleRows = useMemo(() => showAll ? disposition.rows : disposition.rows.flatMap((row) => {
    const addressIndex = disposition.columns.indexOf("Addresses");
    if (addressIndex < 0) return [row];
    const addresses = String(row[addressIndex] ?? "").split(", ").filter(isConsoleVisibleAddress);
    return addresses.length ? [row.map((value, index) => index === addressIndex ? addresses.join(", ") : value)] : [];
  }), [disposition, showAll]);
  const preview = useTablePreview(visibleRows);
  const valueAt = (row: OperationScalar[], label: string): string => {
    const index = disposition.columns.findIndex((column) => column.toLocaleLowerCase() === label.toLocaleLowerCase());
    return index < 0 ? "Not reported" : String(row[index] ?? "Not reported");
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Switch aria-label="Show all interface addresses" isSelected={showAll} onChange={setShowAll}>
          <Switch.Content className="min-w-0 flex-1"><span className="block text-xs text-foreground">Show all interface addresses</span></Switch.Content>
          <Switch.Control><Switch.Thumb /></Switch.Control>
        </Switch>
        {!showAll ? <span className="text-xs text-muted">{disposition.rows.length - visibleRows.length} decoded adapters hidden by the default address filter</span> : null}
      </div>
      <TablePreviewControls preview={preview} sourceTotal={disposition.rows.length} />
      {preview.rows.length === 0 ? (
        <p className="rounded-2xl bg-default px-4 py-5 text-sm text-muted">{preview.query ? "No decoded rows match this filter." : !showAll && disposition.rows.length ? "No decoded interfaces match the default address filter." : "No network interfaces were returned."}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {preview.rows.map((row, index) => (
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

function columnIndex(columns: string[], label: string): number {
  return columns.findIndex((column) => column.toLocaleLowerCase() === label.toLocaleLowerCase());
}

function sortDirectoryRows(
  disposition: Extract<OperationDisposition, { kind: "table" }>,
  sort: "name" | "modified" | "size",
  reverse: boolean,
): OperationScalar[][] {
  const nameIndex = columnIndex(disposition.columns, "Name");
  const sortIndex = columnIndex(disposition.columns, sort);
  const stringAt = (row: OperationScalar[], index: number): string => String(row[index] ?? "");
  const integerAt = (row: OperationScalar[], index: number): bigint => {
    const value = stringAt(row, index);
    return /^-?\d+$/u.test(value) ? BigInt(value) : 0n;
  };
  return [...disposition.rows].sort((left, right) => {
    let order = 0;
    if (sort !== "name" && sortIndex >= 0) {
      const leftValue = integerAt(left, sortIndex);
      const rightValue = integerAt(right, sortIndex);
      order = leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    }
    if (!order && nameIndex >= 0) {
      const leftName = stringAt(left, nameIndex).toLocaleLowerCase();
      const rightName = stringAt(right, nameIndex).toLocaleLowerCase();
      order = leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
    }
    return reverse ? -order : order;
  });
}

function prepareProcessRows(
  disposition: Extract<OperationDisposition, { kind: "table" }>,
  options: { pid: string; executable: string; owner: string; tree: boolean; commandLine: boolean },
): { columns: string[]; rows: OperationScalar[][] } {
  const pidIndex = columnIndex(disposition.columns, "PID");
  const ppidIndex = columnIndex(disposition.columns, "PPID");
  const executableIndex = columnIndex(disposition.columns, "Executable");
  const ownerIndex = columnIndex(disposition.columns, "Owner");
  const commandLineIndex = columnIndex(disposition.columns, "Command line");
  const pidFilter = options.pid.trim();
  const executableFilter = options.executable.trim().toLocaleLowerCase();
  const ownerFilter = options.owner.trim().toLocaleLowerCase();
  const valueAt = (row: OperationScalar[], index: number): string => index < 0 ? "" : String(row[index] ?? "");
  const matches = disposition.rows.filter((row) =>
    (!pidFilter || valueAt(row, pidIndex) === pidFilter) &&
    (!executableFilter || valueAt(row, executableIndex).toLocaleLowerCase().includes(executableFilter)) &&
    (!ownerFilter || valueAt(row, ownerIndex).toLocaleLowerCase().includes(ownerFilter)));
  const byPid = [...matches].sort((left, right) =>
    Number(valueAt(left, pidIndex)) - Number(valueAt(right, pidIndex)) ||
    Number(valueAt(left, ppidIndex)) - Number(valueAt(right, ppidIndex)));
  let rows = matches;
  if (options.tree && pidIndex >= 0 && ppidIndex >= 0 && executableIndex >= 0) {
    const pidToIndex = new Map(byPid.map((row, index) => [valueAt(row, pidIndex), index]));
    const children = new Map<number, number[]>();
    const roots: number[] = [];
    byPid.forEach((row, index) => {
      const parent = pidToIndex.get(valueAt(row, ppidIndex));
      if (parent === undefined || parent === index) roots.push(index);
      else children.set(parent, [...(children.get(parent) ?? []), index]);
    });
    const seen = new Set<number>();
    const ordered: OperationScalar[][] = [];
    const visit = (index: number, depth: number): void => {
      if (seen.has(index)) return;
      seen.add(index);
      const row = byPid[index]!;
      ordered.push(row.map((value, column) => column === executableIndex
        ? `${"  ".repeat(Math.min(depth, 12))}${depth ? "↳ " : ""}${String(value ?? "")}`
        : value));
      for (const child of children.get(index) ?? []) visit(child, depth + 1);
    };
    for (const root of roots) visit(root, 0);
    for (let index = 0; index < byPid.length; index += 1) visit(index, 0);
    rows = ordered;
  }
  if (options.commandLine || commandLineIndex < 0) return { columns: disposition.columns, rows };
  return {
    columns: disposition.columns.filter((_, index) => index !== commandLineIndex),
    rows: rows.map((row) => row.filter((_, index) => index !== commandLineIndex)),
  };
}

function isConsoleVisibleAddress(address: string): boolean {
  const slash = address.lastIndexOf("/");
  if (slash < 0 || address.startsWith("127") || address.startsWith("::1")) return false;
  const subnet = Number(address.slice(slash + 1));
  return Number.isInteger(subnet) && subnet > 0 && subnet <= 32;
}

interface TablePreview {
  query: string;
  setQuery: (query: string) => void;
  rows: OperationScalar[][];
  matched: number;
  total: number;
  page: number;
  pages: number;
  start: number;
  end: number;
  setPage: (page: number) => void;
}

function useTablePreview(allRows: OperationScalar[][]): TablePreview {
  const [query, setQueryValue] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? allRows.filter((row) => row.some((value) => String(value ?? "").toLocaleLowerCase().includes(needle)))
      : allRows;
  }, [allRows, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const activePage = Math.min(page, pages - 1);
  const start = activePage * 50;
  const end = Math.min(start + 50, filtered.length);
  return {
    query,
    setQuery: (value) => { setQueryValue(value.slice(0, 200)); setPage(0); },
    rows: filtered.slice(start, end),
    matched: filtered.length,
    total: allRows.length,
    page: activePage,
    pages,
    start,
    end,
    setPage,
  };
}

function TablePreviewControls({ preview, sourceTotal }: { preview: TablePreview; sourceTotal?: number }): React.JSX.Element {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="w-full max-w-xs">
        <Field label="Filter decoded rows" value={preview.query} onChange={preview.setQuery} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-muted">
          Showing {preview.matched ? preview.start + 1 : 0}–{preview.end} of {preview.matched} decoded rows
          {preview.query ? ` (${preview.total} before filter)` : ""}
          {sourceTotal !== undefined && sourceTotal !== preview.total ? ` (${sourceTotal} before command options)` : ""}
        </span>
        {preview.pages > 1 ? (
          <>
            <Button isDisabled={preview.page === 0} size="sm" variant="tertiary" onPress={() => preview.setPage(preview.page - 1)}>Previous</Button>
            <span className="text-xs tabular-nums text-muted">Page {preview.page + 1} of {preview.pages}</span>
            <Button isDisabled={preview.page + 1 >= preview.pages} size="sm" variant="tertiary" onPress={() => preview.setPage(preview.page + 1)}>Next</Button>
          </>
        ) : null}
      </div>
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
        <dl className="grid gap-3 sm:grid-cols-2">
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
  return <p className="mt-2 text-xs text-warning">Preview shortened. Open Details to view the full output.</p>;
}

function isBeaconInteractionCommandId(value: string): value is BeaconInteractionCommandId {
  return (BEACON_INTERACTION_COMMAND_IDS as readonly string[]).includes(value);
}

type BeaconWindowsCommandId = Extract<BeaconInteractionCommandId, `beacon.registry.${string}` | `beacon.service.${string}`>;
type BeaconMutationCommandId = BeaconMutationOperationInput["operationId"];

function isBeaconWindowsCommandId(commandId: BeaconInteractionCommandId): commandId is BeaconWindowsCommandId {
  return commandId.startsWith("beacon.registry.") || commandId.startsWith("beacon.service.");
}

function isBeaconMutationCommandId(commandId: BeaconInteractionCommandId): commandId is BeaconMutationCommandId {
  return commandId === "beacon.registry.write" || commandId === "beacon.registry.create" ||
    commandId === "beacon.registry.delete" || commandId === "beacon.service.start" || commandId === "beacon.service.stop";
}

function discardBeaconMutationPlan(plan: BeaconMutationPlan): void {
  void window.sliver.discardBeaconMutation({ token: plan.token }).catch(() => undefined);
}

function isBeaconExecutionCommandId(commandId: BeaconInteractionCommandId): commandId is BeaconExecutionSelection {
  return commandId === "execution" || commandId === "execution.children" || commandId === "privilege.get" ||
    commandId === "privilege.run-as" || commandId === "privilege.make-token" ||
    commandId === "privilege.impersonate" || commandId === "privilege.revert";
}

type BeaconManagementCommandId = "target.ping" | "target.rename" | "target.env-set" | "target.env-unset" |
  "beacon.reconfigure" | "beacon.open-session";

function beaconMetadataFact(commandId: BeaconInteractionCommandId, beacon: BeaconSummary, expectedTarget: TargetRef): { label: string; value: string | number | undefined; exact: boolean } | undefined {
  let fact: { label: string; value: string | number | undefined } | undefined;
  switch (commandId) {
    case "beacon.identity.pid": fact = { label: "Process ID", value: beacon.pid }; break;
    case "beacon.identity.uid": fact = { label: "User ID", value: beacon.uid }; break;
    case "beacon.identity.gid": fact = { label: "Group ID", value: beacon.gid }; break;
    case "beacon.identity.whoami":
      fact = beacon.os.toLocaleLowerCase() === "windows" ? undefined : { label: "Username", value: beacon.username };
      break;
    default: break;
  }
  return fact ? { ...fact, exact: beacon.id === expectedTarget.id } : undefined;
}

function isBeaconMetadataCommandId(commandId: BeaconInteractionCommandId): commandId is BeaconMetadataCommandId {
  return commandId === "beacon.identity.pid" || commandId === "beacon.identity.uid" || commandId === "beacon.identity.gid";
}

function isBeaconManagementCommandId(commandId: BeaconInteractionCommandId): commandId is BeaconManagementCommandId {
  return commandId === "target.ping" || commandId === "target.rename" || commandId === "target.env-set" ||
    commandId === "target.env-unset" || commandId === "beacon.reconfigure" || commandId === "beacon.open-session";
}

function sameTarget(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode && left.id === right.id &&
    left.backendEpoch === right.backendEpoch && left.fingerprint === right.fingerprint;
}

function sameReviewTarget(left: TargetRef, right: TargetRef): boolean {
  return sameTarget(left, right) && left.domainRevision === right.domainRevision;
}

function optionalInteger(value: string, label: string, minimum: number): number | undefined {
  if (!value.trim()) return undefined;
  return requiredInteger(value, label, minimum);
}

function requiredInteger(value: string, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} must be an integer of ${minimum} or greater.`);
  return parsed;
}

function beaconCommandInput(
  commandId: BeaconInteractionCommandId,
  path: string,
  fullInfo: boolean,
  management: BeaconManagementDraft,
  read: BeaconReadDraft,
  windows: BeaconWindowsDraft,
): TargetOperationInput {
  switch (commandId) {
    case "execution":
    case "execution.children":
    case "privilege.get":
    case "privilege.run-as":
    case "privilege.make-token":
    case "privilege.impersonate":
    case "privilege.revert":
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
    case "beacon.environment.list": {
      const name = read.environmentName.trim();
      return { operationId: commandId, ...(name ? { name } : {}) };
    }
    case "beacon.identity.whoami":
    case "beacon.filesystem.mount":
    case "beacon.filesystem.memfiles":
      return { operationId: commandId };
    case "beacon.identity.pid":
    case "beacon.identity.uid":
    case "beacon.identity.gid":
      throw new Error("This value comes from the latest beacon inventory, without queueing a task.");
    case "beacon.network.netstat":
      if (!read.tcp && !read.udp) throw new Error("Select TCP or UDP.");
      if (!read.ip4 && !read.ip6) throw new Error("Select IPv4 or IPv6.");
      return { operationId: commandId, tcp: read.tcp, udp: read.udp, ip4: read.ip4, ip6: read.ip6, listen: read.listen };
    case "beacon.filesystem.cat": {
      const filePath = read.path.trim();
      if (!filePath) throw new Error("Enter a file path.");
      return { operationId: commandId, path: filePath };
    }
    case "beacon.filesystem.head": {
      const filePath = read.path.trim();
      if (!filePath) throw new Error("Enter a file path.");
      const count = requiredInteger(read.count, read.countBytes ? "Bytes" : "Lines", 1);
      if (count > (read.countBytes ? 65_536 : 4_096)) throw new Error(read.countBytes ? "Bytes must be 65536 or fewer." : "Lines must be 4096 or fewer.");
      return { operationId: commandId, path: filePath, ...(read.countBytes ? { bytes: count } : { lines: count }) };
    }
    case "beacon.filesystem.tail": {
      const filePath = read.path.trim();
      if (!filePath) throw new Error("Enter a file path.");
      const bytes = requiredInteger(read.count, "Bytes", 1);
      if (bytes > 65_536) throw new Error("Bytes must be 65536 or fewer.");
      return { operationId: commandId, path: filePath, bytes };
    }
    case "beacon.filesystem.grep": {
      const filePath = read.path.trim();
      const pattern = read.pattern.trim();
      if (!filePath) throw new Error("Enter a search path.");
      if (!pattern) throw new Error("Enter a search pattern.");
      const before = requiredInteger(read.before, "Lines before", 0);
      const after = requiredInteger(read.after, "Lines after", 0);
      if (before > 64 || after > 64) throw new Error("Context must be 64 lines or fewer per side.");
      return { operationId: commandId, path: filePath, pattern, recursive: read.recursive, before, after };
    }
    case "beacon.registry.list-subkeys":
    case "beacon.registry.list-values":
      return { operationId: commandId, hive: windows.hive, path: windows.path.trim(), ...optionalBeaconHostname(windows.hostname) };
    case "beacon.registry.read":
      return { operationId: commandId, hive: windows.hive, path: windows.path.trim(), key: windows.key,
        ...optionalBeaconHostname(windows.hostname) };
    case "beacon.registry.create":
    case "beacon.registry.delete": {
      const key = windows.key.trim();
      if (!key) throw new Error(commandId === "beacon.registry.delete" ? "Enter an entry name." : "Enter a subkey name.");
      return { operationId: commandId, hive: windows.hive, path: windows.path.trim(), key,
        ...optionalBeaconHostname(windows.hostname) };
    }
    case "beacon.registry.write":
      return { operationId: commandId, hive: windows.hive, path: windows.path.trim(), key: windows.key,
        value: registryWriteValueFromDraft(windows.valueType, windows.valueDraft),
        ...optionalBeaconHostname(windows.hostname) };
    case "beacon.service.list":
      return { operationId: commandId, ...optionalBeaconHostname(windows.hostname) };
    case "beacon.service.info":
    case "beacon.service.start":
    case "beacon.service.stop": {
      const name = windows.serviceName.trim();
      if (!name) throw new Error("Enter a service name.");
      return { operationId: commandId, name, ...optionalBeaconHostname(windows.hostname) };
    }
    case "target.ping":
      return { operationId: commandId };
    case "target.rename": {
      const name = management.name.trim();
      if (!name) throw new Error("Enter a new target name.");
      return { operationId: commandId, name };
    }
    case "target.env-set": {
      const name = management.name.trim();
      if (!name) throw new Error("Enter an environment variable name.");
      return { operationId: commandId, name, value: management.value };
    }
    case "target.env-unset": {
      const name = management.name.trim();
      if (!name) throw new Error("Enter an environment variable name.");
      return { operationId: commandId, name };
    }
    case "beacon.reconfigure": {
      const reconnectIntervalSeconds = optionalInteger(management.reconnectIntervalSeconds, "Reconnect seconds", 1);
      const intervalSeconds = optionalInteger(management.intervalSeconds, "Interval seconds", 1);
      const jitterSeconds = optionalInteger(management.jitterSeconds, "Jitter seconds", 1);
      if (reconnectIntervalSeconds === undefined && intervalSeconds === undefined && jitterSeconds === undefined) {
        throw new Error("Change at least one beacon setting.");
      }
      return {
        operationId: commandId,
        ...(reconnectIntervalSeconds === undefined ? {} : { reconnectIntervalSeconds }),
        ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
        ...(jitterSeconds === undefined ? {} : { jitterSeconds }),
      };
    }
    case "beacon.open-session":
      return { operationId: commandId, delaySeconds: requiredInteger(management.delaySeconds, "Delay seconds", 0) };
  }
}

function optionalBeaconHostname(value: string): { hostname?: string } {
  const hostname = value.trim();
  return hostname ? { hostname } : {};
}

function registryWriteValueFromDraft(type: SessionRegistryWriteValue["type"], draft: string): SessionRegistryWriteValue {
  if (draft.includes("\0")) throw new Error("Registry values cannot contain null characters.");
  if (draft.length > 65_536) throw new Error("Registry values are limited to 65,536 characters.");
  switch (type) {
    case "string": return { type, value: draft };
    case "binary":
      if (!/^(?:[0-9a-f]{2})*$/iu.test(draft)) throw new Error("Binary data must be contiguous even-length hexadecimal.");
      return { type, hex: draft.toLocaleLowerCase() };
    case "dword":
      if (!/^\d+$/u.test(draft) || Number(draft) > 0xffff_ffff) throw new Error("DWORD must be an unsigned 32-bit decimal integer.");
      return { type, value: Number(draft) };
    case "qword":
      if (!/^\d{1,20}$/u.test(draft) || BigInt(draft) > 0xffff_ffff_ffff_ffffn) throw new Error("QWORD must be an unsigned 64-bit decimal integer.");
      return { type, value: draft };
  }
}

function operationResultTitle(task: BeaconTaskDetail): string {
  return getBeaconTaskPresentation(task).label;
}

function stateLabel(state: BeaconTaskSummary["state"]): string {
  return state.split("-").map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1)).join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
