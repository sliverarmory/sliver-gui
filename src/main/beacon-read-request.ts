import { sliverpb } from "sliver-script";

import type { TargetOperationInput } from "../shared/operation-contracts.js";

/**
 * Verify the server-saved request against the exact locally submitted M2 operation.
 * DownloadReq is shared by cat, head, and tail, so its description alone is
 * never enough to choose a decoder or claim the task as this operation.
 * The server clears the nested BeaconID and SessionID before saving the task;
 * the caller separately verifies and claims the task's authoritative BeaconID.
 */
export function verifyBeaconReadRequest(
  expected: TargetOperationInput,
  bytes: Buffer,
): void {
  const messageType = beaconReadMessageType(expected.operationId);
  const envelope = sliverpb.Envelope.decode(bytes);
  try {
    if (envelope.Type !== messageType || envelope.UnknownMessageType || envelope.Data.length === 0) {
      throw new Error("Task request envelope did not match the command");
    }
    verifyNestedRequest(expected, envelope.Data);
  } finally {
    envelope.Data.fill(0);
  }
}

function beaconReadMessageType(operationId: TargetOperationInput["operationId"]): number {
  switch (operationId) {
    case "beacon.filesystem.pwd": return 12;
    case "beacon.filesystem.ls": return 5;
    case "beacon.process.list": return 18;
    case "beacon.network.interfaces": return 42;
    case "beacon.environment.list": return 66;
    case "beacon.identity.whoami": return 100;
    case "beacon.network.netstat": return 49;
    case "beacon.filesystem.mount": return 134;
    case "beacon.filesystem.memfiles": return 115;
    case "beacon.filesystem.cat":
    case "beacon.filesystem.head":
    case "beacon.filesystem.tail": return 7;
    case "beacon.filesystem.grep": return 129;
    case "beacon.registry.read": return 71;
    case "beacon.registry.write": return 72;
    case "beacon.registry.create": return 73;
    case "beacon.registry.list-subkeys": return 88;
    case "beacon.registry.list-values": return 89;
    case "beacon.registry.delete": return 97;
    case "beacon.service.stop": return 62;
    case "beacon.service.list": return 130;
    case "beacon.service.info": return 131;
    case "beacon.service.start": return 132;
    default: throw new Error("This operation has no reviewed M2 request verifier");
  }
}

function verifyNestedRequest(expected: TargetOperationInput, bytes: Buffer): void {
  let request: { Async: boolean; BeaconID: string; SessionID: string } | undefined;
  switch (expected.operationId) {
    case "beacon.filesystem.pwd":
      request = sliverpb.PwdReq.decode(bytes).Request;
      break;
    case "beacon.filesystem.ls": {
      const decoded = sliverpb.LsReq.decode(bytes);
      request = decoded.Request;
      if (decoded.Path !== expected.path) throw new Error("Directory request path did not match");
      break;
    }
    case "beacon.process.list": {
      const decoded = sliverpb.PsReq.decode(bytes);
      request = decoded.Request;
      if (decoded.FullInfo !== expected.fullInfo) throw new Error("Process request option did not match");
      break;
    }
    case "beacon.network.interfaces":
      request = sliverpb.IfconfigReq.decode(bytes).Request;
      break;
    case "beacon.environment.list": {
      const decoded = sliverpb.EnvReq.decode(bytes);
      request = decoded.Request;
      if (decoded.Name !== (expected.name ?? "")) throw new Error("Environment request name did not match");
      break;
    }
    case "beacon.identity.whoami":
      request = sliverpb.CurrentTokenOwnerReq.decode(bytes).Request;
      break;
    case "beacon.network.netstat": {
      const decoded = sliverpb.NetstatReq.decode(bytes);
      request = decoded.Request;
      if (decoded.TCP !== expected.tcp || decoded.UDP !== expected.udp ||
        decoded.IP4 !== expected.ip4 || decoded.IP6 !== expected.ip6 ||
        decoded.Listening !== expected.listen) throw new Error("Netstat request options did not match");
      break;
    }
    case "beacon.filesystem.mount":
      request = sliverpb.MountReq.decode(bytes).Request;
      break;
    case "beacon.filesystem.memfiles":
      request = sliverpb.MemfilesListReq.decode(bytes).Request;
      break;
    case "beacon.filesystem.cat":
    case "beacon.filesystem.head":
    case "beacon.filesystem.tail": {
      const decoded = sliverpb.DownloadReq.decode(bytes);
      request = decoded.Request;
      const maxBytes = expected.operationId === "beacon.filesystem.cat" ||
        (expected.operationId === "beacon.filesystem.head" && expected.lines !== undefined)
        ? "65537"
        : expected.operationId === "beacon.filesystem.tail"
          ? `-${expected.bytes}`
          : String(expected.bytes);
      const maxLines = expected.operationId === "beacon.filesystem.head" && expected.lines !== undefined
        ? String(expected.lines) : "0";
      if (decoded.Path !== expected.path || decoded.MaxBytes !== maxBytes || decoded.MaxLines !== maxLines ||
        decoded.Recurse || !decoded.RestrictedToFile || decoded.Start !== "0" || decoded.Stop !== "0") {
        throw new Error("File read request did not match the selected command");
      }
      break;
    }
    case "beacon.filesystem.grep": {
      const decoded = sliverpb.GrepReq.decode(bytes);
      request = decoded.Request;
      if (decoded.Path !== expected.path || decoded.SearchPattern !== expected.pattern ||
        decoded.Recursive !== expected.recursive || decoded.LinesBefore !== expected.before ||
        decoded.LinesAfter !== expected.after) throw new Error("Grep request did not match");
      break;
    }
    case "beacon.registry.read": {
      const decoded = sliverpb.RegistryReadReq.decode(bytes);
      request = decoded.Request;
      verifyRegistryLocation(decoded, expected);
      if (decoded.Key !== expected.key) throw new Error("Registry value name did not match");
      break;
    }
    case "beacon.registry.list-subkeys": {
      const decoded = sliverpb.RegistrySubKeyListReq.decode(bytes);
      request = decoded.Request;
      verifyRegistryLocation(decoded, expected);
      break;
    }
    case "beacon.registry.list-values": {
      const decoded = sliverpb.RegistryListValuesReq.decode(bytes);
      request = decoded.Request;
      verifyRegistryLocation(decoded, expected);
      break;
    }
    case "beacon.registry.write": {
      const decoded = sliverpb.RegistryWriteReq.decode(bytes);
      request = decoded.Request;
      verifyRegistryLocation(decoded, expected);
      if (decoded.Key !== expected.key || !registryWriteMatches(decoded, expected.value)) {
        throw new Error("Registry write request did not match the reviewed value");
      }
      break;
    }
    case "beacon.registry.create": {
      const decoded = sliverpb.RegistryCreateKeyReq.decode(bytes);
      request = decoded.Request;
      verifyRegistryLocation(decoded, expected);
      if (decoded.Key !== expected.key) throw new Error("Registry key name did not match");
      break;
    }
    case "beacon.registry.delete": {
      const decoded = sliverpb.RegistryDeleteKeyReq.decode(bytes);
      request = decoded.Request;
      verifyRegistryLocation(decoded, expected);
      if (decoded.Key !== expected.key) throw new Error("Registry key name did not match");
      break;
    }
    case "beacon.service.list": {
      const decoded = sliverpb.ServicesReq.decode(bytes);
      request = decoded.Request;
      if (decoded.Hostname !== (expected.hostname ?? "")) throw new Error("Service hostname did not match");
      break;
    }
    case "beacon.service.info": {
      const decoded = sliverpb.ServiceDetailReq.decode(bytes);
      request = decoded.Request;
      verifyServiceInfo(decoded.ServiceInfo, expected);
      break;
    }
    case "beacon.service.start": {
      const decoded = sliverpb.StartServiceByNameReq.decode(bytes);
      request = decoded.Request;
      verifyServiceInfo(decoded.ServiceInfo, expected);
      break;
    }
    case "beacon.service.stop": {
      const decoded = sliverpb.StopServiceReq.decode(bytes);
      request = decoded.Request;
      verifyServiceInfo(decoded.ServiceInfo, expected);
      break;
    }
    default:
      throw new Error("This operation has no reviewed M2 request verifier");
  }
  if (request?.Async !== true || request.BeaconID !== "" || request.SessionID !== "") {
    throw new Error("Task request did not match the server's saved beacon task shape");
  }
}

function verifyRegistryLocation(
  decoded: { Hive: string; Path: string; Hostname: string },
  expected: Extract<TargetOperationInput, { operationId: `beacon.registry.${string}` }>,
): void {
  if (decoded.Hive !== expected.hive || decoded.Path !== expected.path ||
    decoded.Hostname !== (expected.hostname ?? "")) {
    throw new Error("Registry hive, path, or hostname did not match");
  }
}

function registryWriteMatches(
  decoded: sliverpb.RegistryWriteReq,
  value: Extract<TargetOperationInput, { operationId: "beacon.registry.write" }>["value"],
): boolean {
  switch (value.type) {
    case "string":
      return decoded.Type === sliverpb.RegistryType.String && decoded.StringValue === value.value &&
        decoded.ByteValue.length === 0 && decoded.DWordValue === 0 && decoded.QWordValue === "0";
    case "binary": {
      const expectedBytes = Buffer.from(value.hex, "hex");
      try {
        return decoded.Type === sliverpb.RegistryType.Binary && decoded.StringValue === "" &&
          Buffer.from(decoded.ByteValue).equals(expectedBytes) && decoded.DWordValue === 0 &&
          decoded.QWordValue === "0";
      } finally {
        expectedBytes.fill(0);
        decoded.ByteValue.fill(0);
      }
    }
    case "dword":
      return decoded.Type === sliverpb.RegistryType.DWORD && decoded.StringValue === "" &&
        decoded.ByteValue.length === 0 && decoded.DWordValue === value.value && decoded.QWordValue === "0";
    case "qword":
      return decoded.Type === sliverpb.RegistryType.QWORD && decoded.StringValue === "" &&
        decoded.ByteValue.length === 0 && decoded.DWordValue === 0 && decoded.QWordValue === value.value;
  }
}

function verifyServiceInfo(
  decoded: sliverpb.ServiceInfoReq | undefined,
  expected: Extract<TargetOperationInput, { operationId: "beacon.service.info" | "beacon.service.start" | "beacon.service.stop" }>,
): void {
  if (!decoded || decoded.ServiceName !== expected.name || decoded.Hostname !== (expected.hostname ?? "")) {
    throw new Error("Service name or hostname did not match");
  }
}
