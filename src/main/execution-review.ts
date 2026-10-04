import type {
  ExecutionActionDraft,
  ExecutionArtifactRole,
  ExecutionReviewField,
} from "../shared/execution-contracts.js";

export interface ExecutionArtifactSelection {
  role: ExecutionArtifactRole;
  title: string;
  maximumBytes: number;
  extensions: string[];
}

const MIB = 1_024 * 1_024;

export function executionArtifactSelections(draft: ExecutionActionDraft): ExecutionArtifactSelection[] {
  switch (draft.operationId) {
    case "execution.assembly":
      return [selection("assembly", "Choose a .NET assembly", 64 * MIB, ["exe", "dll"])];
    case "execution.shellcode":
      return [selection("shellcode", "Choose raw shellcode", 64 * MIB, ["bin", "raw", "shellcode"])];
    case "execution.sideload":
      return [selection("shared-library", "Choose a shared library", 64 * MIB, ["dll", "so", "dylib"])];
    case "execution.spawn-dll":
      return [selection("reflective-dll", "Choose a reflective DLL", 64 * MIB, ["dll"])];
    case "execution.psexec":
      return draft.source.kind === "native-file"
        ? [selection("service-executable", "Choose a Windows service executable", 64 * MIB, ["exe"])]
        : [];
    case "execution.ssh":
      if (draft.authentication.kind === "private-key") {
        return [selection("ssh-private-key", "Choose an SSH private key", 1 * MIB, ["pem", "key"])];
      }
      if (draft.authentication.kind === "kerberos") {
        return [selection("kerberos-keytab", "Choose a Kerberos keytab", 4 * MIB, ["keytab"])];
      }
      return [];
    case "execution.dll-hijack": {
      const selections: ExecutionArtifactSelection[] = [];
      if (draft.includeReferenceDll) {
        selections.push(selection("hijack-reference-dll", "Choose the reference DLL", 64 * MIB, ["dll"]));
      }
      if (draft.source.kind === "native-file") {
        selections.push(selection("hijack-target-dll", "Choose the replacement DLL", 64 * MIB, ["dll"]));
      }
      return selections;
    }
    default:
      return [];
  }
}

export function executionReviewFields(draft: ExecutionActionDraft): ExecutionReviewField[] {
  const field = (label: string, value: string | number | boolean): ExecutionReviewField => ({
    label,
    value: typeof value === "boolean" ? (value ? "Yes" : "No") : String(value),
    sensitive: false,
  });
  switch (draft.operationId) {
    case "execution.process":
      return [
        field("Executable", draft.path),
        field("Arguments", draft.args.length),
        field("Environment entries", draft.environment.length),
        field("Capture output", draft.captureOutput),
        field("Background", draft.background),
        ...(draft.parentPid === undefined ? [] : [field("Parent PID", draft.parentPid)]),
      ];
    case "execution.assembly":
      return [field("Architecture", draft.architecture), field("Host process", draft.process), field("In process", draft.inProcess), field("Arguments", draft.args.length)];
    case "execution.shellcode":
      return [field("Declared architecture", draft.declaredArchitecture), field("PID", draft.pid === 0 ? "Current process" : draft.pid), field("RWX pages", draft.rwxPages)];
    case "execution.sideload":
      return [field("Host process", draft.process), field("Entry point", draft.entryPoint || "Default"), field("Keep host alive", draft.keepAlive), field("Arguments", draft.args.length)];
    case "execution.spawn-dll":
      return [field("Host process", draft.process), field("Export", draft.entryPoint), field("Keep host alive", draft.keepAlive), field("Arguments", draft.args.length)];
    case "execution.migrate":
      return draft.pid === undefined ? [field("Process name", draft.processName ?? "")] : [field("PID", draft.pid)];
    case "execution.msf":
      return [field("Payload", draft.payload), field("Listener", `${draft.lhost}:${draft.lport}`), field("Iterations", draft.iterations)];
    case "execution.msf-inject":
      return [field("PID", draft.pid), field("Payload", draft.payload), field("Listener", `${draft.lhost}:${draft.lport}`), field("Iterations", draft.iterations)];
    case "execution.psexec":
      return [field("Remote host", draft.hostname), field("Service", draft.serviceName), field("Remote upload directory", draft.remotePath), field("Source", draft.source.kind === "profile" ? `Profile ${draft.source.profileName}` : "Selected executable")];
    case "execution.ssh":
      return [field("Remote host", `${draft.hostname}:${draft.port}`), field("Username", draft.username), field("Authentication", sshAuthenticationLabel(draft.authentication.kind)), field("Command arguments", draft.command.length)];
    case "execution.backdoor":
      return [field("Remote executable", draft.remotePath), field("Profile", draft.profileName), field("Implant name", draft.name)];
    case "execution.dll-hijack":
      return [field("Reference path", draft.referenceDllPath), field("Target location", draft.targetLocation), field("Source", draft.source.kind === "profile" ? `Profile ${draft.source.profileName}` : "Selected DLL"), field("Implant name", draft.name)];
    case "privilege.run-as":
      return [field("Requested identity", requestedExecutionIdentity(draft) ?? draft.username), field("Process", draft.process), field("Network only", draft.netOnly), field("Show window", draft.showWindow)];
    case "privilege.make-token":
      return [field("Requested identity", requestedExecutionIdentity(draft) ?? draft.username), field("Logon type", draft.logonType)];
    case "privilege.impersonate":
      return [field("Requested identity", draft.username)];
    case "privilege.revert":
      return [field("Identity action", "Revert to the process token")];
    case "privilege.get-system":
      return [field("Hosting process", draft.hostingProcess), field("Requested identity", "NT AUTHORITY\\SYSTEM")];
  }
}

export function executionWarning(draft: ExecutionActionDraft): string {
  switch (draft.operationId) {
    case "execution.process":
      return "This starts an arbitrary process on the selected target. Its behavior and side effects are operator-controlled.";
    case "execution.assembly":
      return "This loads and runs a .NET assembly on the selected Windows target.";
    case "execution.shellcode":
      return "This executes raw shellcode using the declared architecture. Incorrect input can crash the target process.";
    case "execution.sideload":
      return "This loads a native library into a target process and invokes its entry point.";
    case "execution.spawn-dll":
      return "This reflectively loads a DLL into a target process and invokes the reviewed export.";
    case "execution.migrate":
      return "This moves the implant into another process. A failed or partial migration can terminate access.";
    case "execution.msf":
    case "execution.msf-inject":
      return "This generates and executes a Metasploit payload, creating a separate remote connection.";
    case "execution.psexec":
      return "This uploads a generated-name executable to the reviewed remote directory, starts a service, and removes the service. The uploaded executable remains on the remote host; partial completion can leave additional service state.";
    case "execution.ssh":
      return "This sends one-operation credentials to the selected session and executes a command on the reviewed remote host.";
    case "execution.backdoor":
      return "This modifies a remote Windows executable to include a Sliver implant and cannot be automatically undone.";
    case "execution.dll-hijack":
      return "This writes a DLL hijack payload to the reviewed remote location and cannot be automatically undone.";
    case "privilege.run-as":
      return "This sends one-operation credentials to start a process under the reviewed Windows identity.";
    case "privilege.make-token":
      return "This sends one-operation credentials and changes the token available to subsequent target operations.";
    case "privilege.impersonate":
      return "This changes the token identity used by subsequent target operations.";
    case "privilege.revert":
      return "This discards the current impersonation token and restores the process token.";
    case "privilege.get-system":
      return "This requests a new SYSTEM session through a privileged service workflow.";
  }
}

export function requestedExecutionIdentity(draft: ExecutionActionDraft): string | undefined {
  switch (draft.operationId) {
    case "privilege.run-as":
    case "privilege.make-token":
      return draft.domain ? `${draft.domain}\\${draft.username}` : draft.username;
    case "privilege.impersonate":
      return draft.username;
    case "privilege.revert":
      return "Process token";
    case "privilege.get-system":
      return "NT AUTHORITY\\SYSTEM";
    default:
      return undefined;
  }
}

export function clearExecutionDraftSecrets(draft: ExecutionActionDraft): void {
  if (draft.operationId === "privilege.run-as" || draft.operationId === "privilege.make-token") {
    draft.password.fill(0);
  } else if (draft.operationId === "execution.ssh" && draft.authentication.kind === "password") {
    draft.authentication.password.fill(0);
  }
}

function selection(
  role: ExecutionArtifactRole,
  title: string,
  maximumBytes: number,
  extensions: string[],
): ExecutionArtifactSelection {
  return { role, title, maximumBytes, extensions };
}

function sshAuthenticationLabel(kind: "password" | "private-key" | "kerberos"): string {
  switch (kind) {
    case "password": return "Password";
    case "private-key": return "Private key";
    case "kerberos": return "Kerberos keytab";
  }
}
