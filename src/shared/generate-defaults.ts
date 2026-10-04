import type { GenerateInput } from "./contracts.js";

export const defaultGenerateInput: GenerateInput = {
  name: "",
  implantType: "session",
  os: "windows",
  arch: "amd64",
  format: "executable",
  templateName: "sliver",
  c2: "mtls://127.0.0.1:8888",
  connectionStrategy: "",
  reconnectSeconds: 60,
  pollTimeoutSeconds: 360,
  maxConnectionErrors: 1000,
  beaconIntervalSeconds: 60,
  beaconJitterSeconds: 30,
  debug: false,
  evasion: false,
  obfuscateSymbols: true,
  netGo: true,
  runAtLoad: false,
  exports: "",
  canaryDomains: "",
  httpC2Profile: "",
  wgPeerTunIp: "",
  wgKeyExchangePort: 1337,
  wgTcpCommsPort: 8888,
  limitDomainJoined: false,
  limitDatetime: "",
  limitHostname: "",
  limitUsername: "",
  limitFileExists: "",
  limitLocale: "",
  shellcode: {
    compress: true,
    entropy: 3,
    exitOption: 1,
    bypass: 3,
    headers: 1,
    runInThread: false,
    unicode: false,
    originalEntryPoint: 0,
  },
};

export function cloneGenerateInput(input: GenerateInput): GenerateInput {
  return {
    ...input,
    shellcode: { ...input.shellcode },
  };
}
