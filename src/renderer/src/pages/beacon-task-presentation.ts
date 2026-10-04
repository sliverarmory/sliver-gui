import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBan,
  faCamera,
  faCode,
  faFileArrowDown,
  faFileArrowUp,
  faFolderOpen,
  faListCheck,
  faMicrochip,
  faNetworkWired,
  faSatellite,
  faTerminal,
  faUser,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";

import type { BeaconTaskDetail, BeaconTaskSummary } from "../../../shared/operation-contracts";

export interface BeaconTaskPresentation {
  label: string;
  icon: IconDefinition;
}

function display(label: string, icon: IconDefinition): BeaconTaskPresentation {
  return { label, icon };
}

/** Presentation only: protocol descriptions remain unchanged in task contracts. */
const TASK_PRESENTATIONS: Readonly<Record<string, BeaconTaskPresentation>> = {
  Ping: display("Ping response", faSatellite),
  TaskReq: display("Payload execution", faCode),
  KillReq: display("Stop beacon", faBan),
  LsReq: display("Directory listing", faFolderOpen),
  DownloadReq: display("File contents", faFileArrowDown),
  UploadReq: display("File upload", faFileArrowUp),
  CdReq: display("Change working directory", faFolderOpen),
  PwdReq: display("Working directory", faFolderOpen),
  RmReq: display("Remove files", faFolderOpen),
  MkdirReq: display("Create directory", faFolderOpen),
  PsReq: display("Processes", faMicrochip),
  ShellReq: display("Interactive shell", faTerminal),
  ProcessDumpReq: display("Process memory dump", faMicrochip),
  ImpersonateReq: display("Impersonate identity", faUser),
  RunAsReq: display("Run as", faUser),
  RevToSelfReq: display("Revert identity", faUser),
  InvokeGetSystemReq: display("System identity", faUser),
  GetSystemReq: display("System identity", faUser),
  InvokeExecuteAssemblyReq: display("Assembly output", faCode),
  InvokeInProcExecuteAssemblyReq: display("Assembly output", faCode),
  ExecuteAssemblyReq: display("Assembly output", faCode),
  InvokeMigrateReq: display("Process migration", faMicrochip),
  MigrateReq: display("Process migration", faMicrochip),
  SideloadReq: display("Sideload output", faCode),
  InvokeSideloadReq: display("Sideload output", faCode),
  SpawnDllReq: display("DLL output", faCode),
  InvokeSpawnDllReq: display("DLL output", faCode),
  IfconfigReq: display("Network interfaces", faNetworkWired),
  ExecuteReq: display("Process execution", faTerminal),
  ExecuteWindowsReq: display("Process execution", faTerminal),
  ExecuteChildrenReq: display("Background processes", faMicrochip),
  TerminateReq: display("Terminate process", faBan),
  ScreenshotReq: display("Screenshot", faCamera),
  NetstatReq: display("Network connections", faNetworkWired),
  PivotStartListenerReq: display("Start pivot listener", faNetworkWired),
  PivotListenersReq: display("Pivot listeners", faNetworkWired),
  StartServiceReq: display("Create and start service", faWrench),
  StopServiceReq: display("Stop service", faWrench),
  RemoveServiceReq: display("Remove service", faWrench),
  MakeTokenReq: display("Create logon token", faUser),
  EnvReq: display("Environment variables", faTerminal),
  SetEnvReq: display("Set environment variable", faTerminal),
  UnsetEnvReq: display("Remove environment variable", faTerminal),
  RegistryReadReq: display("Registry value", faListCheck),
  RegistryWriteReq: display("Write registry value", faWrench),
  RegistryCreateKeyReq: display("Create registry key", faWrench),
  RegistryDeleteKeyReq: display("Delete registry entry", faWrench),
  RegistrySubKeyListReq: display("Registry subkeys", faFolderOpen),
  RegistryListValuesReq: display("Registry values", faListCheck),
  RegistryReadHiveReq: display("Registry hive", faFolderOpen),
  WGPortForwardStartReq: display("Start WireGuard port forwarding", faNetworkWired),
  WGPortForwardStopReq: display("Stop WireGuard port forwarding", faNetworkWired),
  WGSocksStartReq: display("Start WireGuard SOCKS proxy", faNetworkWired),
  WGSocksStopReq: display("Stop WireGuard SOCKS proxy", faNetworkWired),
  WGTCPForwardersReq: display("WireGuard port forwarders", faNetworkWired),
  WGSocksServersReq: display("WireGuard SOCKS proxies", faNetworkWired),
  PortfwdReq: display("Port forwarding", faNetworkWired),
  ReconfigureReq: display("Beacon configuration", faWrench),
  SSHCommandReq: display("SSH command output", faTerminal),
  GetPrivsReq: display("Windows privileges", faUser),
  RegisterExtensionReq: display("Register extension", faCode),
  CallExtensionReq: display("Extension output", faCode),
  ListExtensionsReq: display("Extensions", faCode),
  OpenSession: display("Session request", faTerminal),
  MvReq: display("Move files", faFolderOpen),
  CpReq: display("Copy files", faFolderOpen),
  CurrentTokenOwnerReq: display("Current identity", faUser),
  RportFwdStopListenerReq: display("Stop reverse port forwarding", faNetworkWired),
  RportFwdStartListenerReq: display("Start reverse port forwarding", faNetworkWired),
  RportFwdListenersReq: display("Reverse port forwarders", faNetworkWired),
  RPortfwdReq: display("Reverse port forwarding", faNetworkWired),
  ChmodReq: display("File permissions", faFolderOpen),
  ChownReq: display("File ownership", faFolderOpen),
  ChtimesReq: display("File timestamps", faFolderOpen),
  MemfilesListReq: display("Memory files", faFolderOpen),
  MemfilesAddReq: display("Add memory file", faFolderOpen),
  MemfilesRmReq: display("Remove memory file", faFolderOpen),
  RegisterWasmExtensionReq: display("Register WebAssembly extension", faCode),
  ListWasmExtensionsReq: display("WebAssembly extensions", faCode),
  ExecWasmExtensionReq: display("WebAssembly output", faCode),
  GrepReq: display("File search", faFolderOpen),
  ServicesReq: display("Services", faListCheck),
  ServiceDetailReq: display("Service details", faListCheck),
  StartServiceByNameReq: display("Start service", faWrench),
  MountReq: display("Mounted filesystems", faFolderOpen),
  MSFReq: display("Metasploit payload", faCode),
  MSFRemoteReq: display("Metasploit payload injection", faCode),
};

const OPERATION_PRESENTATIONS: Readonly<Record<string, BeaconTaskPresentation>> = {
  "target.ping": TASK_PRESENTATIONS["Ping"]!,
  "target.rename": display("Rename beacon", faWrench),
  "target.env-set": TASK_PRESENTATIONS["SetEnvReq"]!,
  "target.env-unset": TASK_PRESENTATIONS["UnsetEnvReq"]!,
  "beacon.reconfigure": TASK_PRESENTATIONS["ReconfigureReq"]!,
  "beacon.open-session": TASK_PRESENTATIONS["OpenSession"]!,
  "beacon.filesystem.pwd": TASK_PRESENTATIONS["PwdReq"]!,
  "beacon.filesystem.ls": TASK_PRESENTATIONS["LsReq"]!,
  "beacon.process.list": TASK_PRESENTATIONS["PsReq"]!,
  "beacon.network.interfaces": TASK_PRESENTATIONS["IfconfigReq"]!,
  "beacon.environment.list": TASK_PRESENTATIONS["EnvReq"]!,
  "beacon.identity.whoami": TASK_PRESENTATIONS["CurrentTokenOwnerReq"]!,
  "beacon.network.netstat": TASK_PRESENTATIONS["NetstatReq"]!,
  "beacon.filesystem.mount": TASK_PRESENTATIONS["MountReq"]!,
  "beacon.filesystem.memfiles": TASK_PRESENTATIONS["MemfilesListReq"]!,
  "beacon.filesystem.cat": TASK_PRESENTATIONS["DownloadReq"]!,
  "beacon.filesystem.head": display("File beginning", faFileArrowDown),
  "beacon.filesystem.tail": display("File ending", faFileArrowDown),
  "beacon.filesystem.grep": TASK_PRESENTATIONS["GrepReq"]!,
  "beacon.registry.read": TASK_PRESENTATIONS["RegistryReadReq"]!,
  "beacon.registry.list-subkeys": TASK_PRESENTATIONS["RegistrySubKeyListReq"]!,
  "beacon.registry.list-values": TASK_PRESENTATIONS["RegistryListValuesReq"]!,
  "beacon.registry.write": TASK_PRESENTATIONS["RegistryWriteReq"]!,
  "beacon.registry.create": TASK_PRESENTATIONS["RegistryCreateKeyReq"]!,
  "beacon.registry.delete": TASK_PRESENTATIONS["RegistryDeleteKeyReq"]!,
  "beacon.service.list": TASK_PRESENTATIONS["ServicesReq"]!,
  "beacon.service.info": TASK_PRESENTATIONS["ServiceDetailReq"]!,
  "beacon.service.start": TASK_PRESENTATIONS["StartServiceByNameReq"]!,
  "beacon.service.stop": TASK_PRESENTATIONS["StopServiceReq"]!,
  "execution.process": TASK_PRESENTATIONS["ExecuteReq"]!,
  "execution.children": TASK_PRESENTATIONS["ExecuteChildrenReq"]!,
  "execution.assembly": TASK_PRESENTATIONS["ExecuteAssemblyReq"]!,
  "execution.shellcode": display("Shellcode execution", faCode),
  "execution.sideload": TASK_PRESENTATIONS["SideloadReq"]!,
  "execution.spawn-dll": TASK_PRESENTATIONS["SpawnDllReq"]!,
  "execution.migrate": TASK_PRESENTATIONS["InvokeMigrateReq"]!,
  "execution.msf": TASK_PRESENTATIONS["MSFReq"]!,
  "execution.msf-inject": TASK_PRESENTATIONS["MSFRemoteReq"]!,
  "execution.psexec": display("Remote service execution", faTerminal),
  "execution.ssh": TASK_PRESENTATIONS["SSHCommandReq"]!,
  "execution.backdoor": display("Backdoor execution", faCode),
  "execution.dll-hijack": display("DLL hijack", faCode),
  "privilege.get": TASK_PRESENTATIONS["GetPrivsReq"]!,
  "privilege.run-as": TASK_PRESENTATIONS["RunAsReq"]!,
  "privilege.make-token": TASK_PRESENTATIONS["MakeTokenReq"]!,
  "privilege.impersonate": TASK_PRESENTATIONS["ImpersonateReq"]!,
  "privilege.revert": TASK_PRESENTATIONS["RevToSelfReq"]!,
  "privilege.get-system": TASK_PRESENTATIONS["InvokeGetSystemReq"]!,
  "bof.execute": display("BOF output", faCode),
};

const DEFAULT_PRESENTATION = display("Beacon task", faListCheck);

function lookup(
  presentations: Readonly<Record<string, BeaconTaskPresentation>>,
  key: string | undefined,
): BeaconTaskPresentation | undefined {
  return key !== undefined && Object.hasOwn(presentations, key) ? presentations[key] : undefined;
}

/** A locally correlated operation can distinguish tasks sharing one wire type. */
export function getBeaconTaskPresentation(task: BeaconTaskSummary | BeaconTaskDetail): BeaconTaskPresentation {
  const detail = task as BeaconTaskDetail;
  const known = lookup(OPERATION_PRESENTATIONS, detail.operationId)
    ?? lookup(OPERATION_PRESENTATIONS, detail.execution?.operationId)
    ?? lookup(OPERATION_PRESENTATIONS, detail.executionRead?.operationId)
    ?? lookup(TASK_PRESENTATIONS, task.description);
  if (known) return known;

  const description = task.description.trim();
  const isTechnical = /(?:Req|Request|Resp|Response)$/u.test(description)
    || /^[A-Za-z0-9_.:/-]+$/u.test(description) && (
      /[_.:/]/u.test(description) || /[a-z][A-Z]/u.test(description)
    )
    || Object.hasOwn(Object.prototype, description);
  return description && !isTechnical ? display(description, DEFAULT_PRESENTATION.icon) : DEFAULT_PRESENTATION;
}
