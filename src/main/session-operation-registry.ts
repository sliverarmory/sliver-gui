import {
  SESSION_DESTRUCTIVE_ACTION_IDS,
  SESSION_WORKBENCH_ARTIFACT_IDS,
  SESSION_WORKBENCH_MUTATION_IDS,
  SESSION_WORKBENCH_QUERY_IDS,
  type SessionWorkbenchOperationId,
} from "../shared/session-contracts.js";

export const SESSION_OPERATION_CATEGORIES = Object.freeze([
  "read",
  "direct-mutation",
  "artifact",
  "reviewed-mutation",
] as const);

export type SessionOperationCategory = (typeof SESSION_OPERATION_CATEGORIES)[number];

export interface SessionOperationDescriptor {
  readonly id: SessionWorkbenchOperationId;
  readonly category: SessionOperationCategory;
  readonly cancellation: "not-supported";
  /** Whether loss of a dispatched response can leave remote state uncertain. */
  readonly outcomeUnknownAfterSubmission: boolean;
  /** Generic journal text. These strings never interpolate renderer input or results. */
  readonly startMessage: string;
  readonly completionMessage: string;
}

const SESSION_OPERATION_LABELS = {
  "session.identity.current-token-owner": "Read current token owner",
  "session.environment.list": "List environment variables",
  "session.environment.reveal": "Reveal environment variable",
  "session.network.interfaces": "List network interfaces",
  "session.network.connections": "List network connections",
  "session.filesystem.pwd": "Read working directory",
  "session.filesystem.ls": "List directory",
  "session.filesystem.cat": "Read file",
  "session.filesystem.head": "Read file head",
  "session.filesystem.tail": "Read file tail",
  "session.filesystem.read-hex": "Read file as hex",
  "session.filesystem.grep": "Search files",
  "session.filesystem.mounts": "List mounts",
  "session.filesystem.memfiles.list": "List memory files",
  "session.process.list": "List processes",
  "session.service.list": "List services",
  "session.service.detail": "Read service details",
  "session.registry.read": "Read registry value",
  "session.registry.list-subkeys": "List registry subkeys",
  "session.registry.list-values": "List registry values",
  "session.filesystem.cd": "Change working directory",
  "session.filesystem.mkdir": "Create directory",
  "session.filesystem.memfiles.add": "Add memory file",
  "session.filesystem.chmod": "Change file mode",
  "session.filesystem.chown": "Change file ownership",
  "session.filesystem.chtimes": "Change file timestamps",
  "session.service.start": "Start service",
  "session.screenshot.capture": "Capture screenshot",
  "session.artifact.save": "Save captured artifact",
  "session.filesystem.download": "Download file",
  "session.filesystem.upload-open": "Upload file",
  "session.filesystem.stage-text": "Stage text changes",
  "session.filesystem.stage-hex": "Stage hex changes",
  "session.process.dump": "Dump process",
  "session.registry.read-hive": "Save registry hive",
  "session.filesystem.cp": "Copy file",
  "session.filesystem.mv": "Move file",
  "session.filesystem.rm": "Remove file",
  "session.filesystem.chmod-recursive": "Change file modes recursively",
  "session.filesystem.chown-recursive": "Change file ownership recursively",
  "session.filesystem.memfiles.rm": "Remove memory file",
  "session.filesystem.upload-overwrite": "Overwrite file",
  "session.filesystem.edit-text-overwrite": "Save text file",
  "session.filesystem.patch-hex": "Save hex changes",
  "session.process.terminate": "Terminate process",
  "session.service.stop": "Stop service",
  "session.registry.write": "Write registry value",
  "session.registry.create-key": "Create registry key",
  "session.registry.delete-key": "Delete registry key",
} as const satisfies Readonly<Record<SessionWorkbenchOperationId, string>>;

const categoryByOperationId = Object.freeze({
  ...categoryEntries(SESSION_WORKBENCH_QUERY_IDS, "read"),
  ...categoryEntries(SESSION_WORKBENCH_MUTATION_IDS, "direct-mutation"),
  ...categoryEntries(SESSION_WORKBENCH_ARTIFACT_IDS, "artifact"),
  ...categoryEntries(SESSION_DESTRUCTIVE_ACTION_IDS, "reviewed-mutation"),
} satisfies Readonly<Record<SessionWorkbenchOperationId, SessionOperationCategory>>);

export const SESSION_OPERATION_DESCRIPTORS = Object.freeze(
  Object.fromEntries(
    Object.entries(SESSION_OPERATION_LABELS).map(([id, label]) => {
      const operationId = id as SessionWorkbenchOperationId;
      const category = categoryByOperationId[operationId];
      return [
        operationId,
        Object.freeze({
          id: operationId,
          category,
          cancellation: "not-supported" as const,
          outcomeUnknownAfterSubmission:
            category === "direct-mutation" ||
            category === "reviewed-mutation" ||
            operationId === "session.filesystem.upload-open",
          startMessage: `${label} in progress`,
          completionMessage: `${label} completed`,
        }),
      ];
    }),
  ),
) as Readonly<Record<SessionWorkbenchOperationId, Readonly<SessionOperationDescriptor>>>;

export function getSessionOperationDescriptor(
  operationId: SessionWorkbenchOperationId,
): Readonly<SessionOperationDescriptor> {
  const descriptor = SESSION_OPERATION_DESCRIPTORS[operationId];
  if (!descriptor) throw new Error("Unknown session operation descriptor");
  return descriptor;
}

function categoryEntries<const Ids extends readonly SessionWorkbenchOperationId[]>(
  ids: Ids,
  category: SessionOperationCategory,
): { [Id in Ids[number]]: SessionOperationCategory } {
  return Object.fromEntries(ids.map((id) => [id, category])) as {
    [Id in Ids[number]]: SessionOperationCategory;
  };
}
