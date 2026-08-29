import { useEffect, useMemo, useState } from "react";
import { Button, Card, Checkbox, Chip, Spinner, toast } from "@heroui/react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faAndroid,
  faApple,
  faAppStoreIos,
  faFreebsd,
  faJs,
  faLinux,
  faWindows,
} from "@fortawesome/free-brands-svg-icons";
import {
  faArrowRight,
  faArrowRotateLeft,
  faBan,
  faBolt,
  faBoxArchive,
  faCarrot,
  faChevronRight,
  faCircleExclamation,
  faCircleNotch,
  faCircleXmark,
  faCode,
  faCodeBranch,
  faCopy,
  faCube,
  faDesktop,
  faDice,
  faDownload,
  faDragon,
  faEraser,
  faFileCode,
  faFishFins,
  faFlag,
  faFloppyDisk,
  faGaugeHigh,
  faGaugeSimple,
  faGear,
  faGears,
  faGlobe,
  faListOl,
  faMicrochip,
  faPlus,
  faPuzzlePiece,
  faSatelliteDish,
  faServer,
  faShieldHalved,
  faShuffle,
  faSun,
  faTerminal,
} from "@fortawesome/free-solid-svg-icons";
import type {
  ArtifactFormat,
  CompilerTargetSummary,
  GenerateInput,
  SliverSnapshot,
} from "../../../shared/contracts";
import {
  AreaField,
  Field,
  SelectField,
  SwitchRow,
  type SelectFieldOption,
} from "../components/FormControls";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ListenerEndpointSelector } from "../components/ListenerEndpointSelector";
import { cloneGenerateInput, defaultGenerateInput } from "../../../shared/generate-defaults";
import {
  firstGenerateInputError,
  validateGenerateInput,
} from "../../../shared/generate-validation";
import { appendListenerEndpoint } from "./generate-listener-endpoint";

interface GeneratePageProps {
  snapshot: SliverSnapshot;
}

const formatLabels: Record<ArtifactFormat, string> = {
  executable: "Executable",
  service: "Windows service",
  shared: "Shared library",
  shellcode: "Shellcode",
  archive: "Go archive",
};

const operatingSystemIcons: Record<string, IconDefinition> = {
  aix: faServer,
  android: faAndroid,
  darwin: faApple,
  dragonfly: faDragon,
  freebsd: faFreebsd,
  illumos: faSun,
  ios: faAppStoreIos,
  js: faJs,
  linux: faLinux,
  netbsd: faFlag,
  openbsd: faFishFins,
  plan9: faCarrot,
  solaris: faSun,
  wasip1: faCube,
  windows: faWindows,
};

const operatingSystemLabels: Record<string, string> = {
  aix: "AIX",
  android: "Android",
  windows: "Windows",
  darwin: "macOS",
  dragonfly: "DragonFly BSD",
  freebsd: "FreeBSD",
  illumos: "illumos",
  ios: "iOS",
  js: "JavaScript",
  linux: "Linux",
  netbsd: "NetBSD",
  openbsd: "OpenBSD",
  plan9: "Plan 9",
  solaris: "Solaris",
  wasip1: "WebAssembly (WASI)",
};

const operatingSystemPriority = ["windows", "linux", "darwin"] as const;

const formatPriority = [
  "executable",
  "service",
  "shared",
  "shellcode",
  "archive",
] as const satisfies readonly ArtifactFormat[];

const implantTypeOptions = [
  { value: "session", label: "Interactive session", icon: faTerminal },
  { value: "beacon", label: "Asynchronous beacon", icon: faSatelliteDish },
] satisfies readonly SelectFieldOption<GenerateInput["implantType"]>[];

const connectionStrategyOptions = [
  { value: "", label: "Sequential", icon: faListOl },
  { value: "s", label: "Random start", icon: faShuffle },
  { value: "r", label: "Random", icon: faDice },
  { value: "rd", label: "Random domain", icon: faGlobe },
] satisfies readonly SelectFieldOption<GenerateInput["connectionStrategy"]>[];

const ONE_TO_THREE_VALUES = {
  "1": 1,
  "2": 2,
  "3": 3,
} as const;

const ONE_TO_TWO_VALUES = {
  "1": 1,
  "2": 2,
} as const;

type OneToThreeSelection = keyof typeof ONE_TO_THREE_VALUES;
type OneToTwoSelection = keyof typeof ONE_TO_TWO_VALUES;

const entropyOptions = [
  { value: "1", label: "None", icon: faBan },
  { value: "2", label: "Low", icon: faGaugeSimple },
  { value: "3", label: "High", icon: faGaugeHigh },
] satisfies readonly SelectFieldOption<OneToThreeSelection>[];

const exitBehaviorOptions = [
  { value: "1", label: "Thread", icon: faCodeBranch },
  { value: "2", label: "Process", icon: faGear },
  { value: "3", label: "SEH", icon: faShieldHalved },
] satisfies readonly SelectFieldOption<OneToThreeSelection>[];

const bypassOptions = [
  { value: "1", label: "None", icon: faBan },
  { value: "2", label: "Abort on failure", icon: faCircleXmark },
  { value: "3", label: "Continue on failure", icon: faArrowRight },
] satisfies readonly SelectFieldOption<OneToThreeSelection>[];

const headerOptions = [
  { value: "1", label: "Overwrite", icon: faEraser },
  { value: "2", label: "Copy", icon: faCopy },
] satisfies readonly SelectFieldOption<OneToTwoSelection>[];

const formatIcons: Record<ArtifactFormat, IconDefinition> = {
  executable: faFileCode,
  service: faGears,
  shared: faPuzzlePiece,
  shellcode: faCode,
  archive: faBoxArchive,
};

function operatingSystemOption(os: string): SelectFieldOption {
  return {
    value: os,
    label: operatingSystemLabels[os] ?? os,
    icon: operatingSystemIcons[os] ?? faDesktop,
  };
}

function architectureOption(arch: string): SelectFieldOption {
  const normalized = arch.toLowerCase();
  return {
    value: arch,
    label:
      normalized === "386"
        ? "x86 (386)"
        : normalized === "wasm"
          ? "WebAssembly"
          : arch.toUpperCase(),
    icon: normalized.includes("arm") || normalized.includes("riscv") ? faMicrochip : faDesktop,
  };
}

function formatOption(format: ArtifactFormat): SelectFieldOption<ArtifactFormat> {
  return { value: format, label: formatLabels[format], icon: formatIcons[format] };
}

function prioritizedUnique<Value extends string>(
  values: readonly Value[],
  priority: readonly string[] = [],
): Value[] {
  return [...new Set(values)].sort((left, right) => {
    const leftPriority = priority.indexOf(left);
    const rightPriority = priority.indexOf(right);
    if (leftPriority >= 0 || rightPriority >= 0) {
      if (leftPriority < 0) return 1;
      if (rightPriority < 0) return -1;
      return leftPriority - rightPriority;
    }
    return left.localeCompare(right);
  });
}

function preferredArchitecture(
  os: string,
  targets: readonly CompilerTargetSummary[],
): string | undefined {
  const priority = os === "darwin" ? ["arm64", "amd64"] : ["amd64", "arm64", "386"];
  return prioritizedUnique(
    targets.filter((target) => target.os === os).map((target) => target.arch),
    priority,
  )[0];
}

function preferredFormat(
  os: string,
  arch: string,
  targets: readonly CompilerTargetSummary[],
): ArtifactFormat | undefined {
  return prioritizedUnique(
    targets
      .filter((target) => target.os === os && target.arch === arch)
      .map((target) => target.format),
    formatPriority,
  )[0];
}

function normalizeGenerateTarget(
  input: GenerateInput,
  targets: readonly CompilerTargetSummary[],
): GenerateInput {
  if (
    targets.some(
      (target) =>
        target.os === input.os && target.arch === input.arch && target.format === input.format,
    )
  ) {
    return input;
  }

  const operatingSystems = prioritizedUnique(
    targets.map((target) => target.os),
    operatingSystemPriority,
  );
  const os = targets.some((target) => target.os === input.os)
    ? input.os
    : targets.some((target) => target.os === defaultGenerateInput.os)
      ? defaultGenerateInput.os
      : operatingSystems[0];
  if (!os) return input;

  const arch = targets.some((target) => target.os === os && target.arch === input.arch)
    ? input.arch
    : preferredArchitecture(os, targets);
  if (!arch) return input;

  const format = preferredFormat(os, arch, targets);
  return format ? { ...input, os, arch, format } : input;
}

type KeysWithValue<T, Value> = {
  [Key in keyof T]-?: T[Key] extends Value ? Key : never;
}[keyof T];

type NumericGenerateInputKey = KeysWithValue<GenerateInput, number>;

export function parseNumberInput(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function oneToThreeSelection(value: 1 | 2 | 3): OneToThreeSelection {
  if (value === 1) return "1";
  if (value === 2) return "2";
  return "3";
}

function oneToTwoSelection(value: 1 | 2): OneToTwoSelection {
  return value === 1 ? "1" : "2";
}

export function GeneratePage({ snapshot }: GeneratePageProps) {
  const [form, setForm] = useState<GenerateInput>(() => cloneGenerateInput(defaultGenerateInput));
  const [profileName, setProfileName] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [isListenerSelectorOpen, setIsListenerSelectorOpen] = useState(false);
  const [showAllPlatforms, setShowAllPlatforms] = useState(false);

  const compilerDomain = snapshot.domains.compiler;
  const commonTargets = useMemo(
    () => compilerDomain.items.filter((target) => target.supported),
    [compilerDomain.items],
  );
  const targets = showAllPlatforms ? compilerDomain.items : commonTargets;
  const compilerReady = compilerDomain.status === "ready" && targets.length > 0;
  const hasExtendedTargets = compilerDomain.items.some((target) => !target.supported);
  const profileInventory = snapshot.domains.profiles;
  const profileInventoryAuthoritative =
    (profileInventory.status === "ready" || profileInventory.status === "empty") &&
    !profileInventory.page.truncated;

  useEffect(() => {
    if (targets.length === 0) return;
    setForm((current) => normalizeGenerateTarget(current, targets));
  }, [targets]);

  const operatingSystems = prioritizedUnique(
    targets.map((target) => target.os),
    operatingSystemPriority,
  );
  const architectures = prioritizedUnique(
    targets.filter((target) => target.os === form.os).map((target) => target.arch),
    form.os === "darwin" ? ["arm64", "amd64"] : ["amd64", "arm64", "386"],
  );
  const formats = prioritizedUnique(
    targets
      .filter((target) => target.os === form.os && target.arch === form.arch)
      .map((target) => target.format),
    formatPriority,
  );
  const selectedTarget = targets.find(
    (target) =>
      target.os === form.os && target.arch === form.arch && target.format === form.format,
  );
  const formErrors = useMemo(() => {
    const errors = validateGenerateInput(form);
    const targetSupported = targets.some(
      (target) =>
        target.os === form.os && target.arch === form.arch && target.format === form.format,
    );
    if (compilerReady && !targetSupported) {
      errors.target = "Select a target and output format advertised by the connected server.";
    }
    return errors;
  }, [compilerReady, form, targets]);
  const formValidationError = firstGenerateInputError(formErrors);
  const formIsValid = formValidationError === undefined;
  const hardeningErrorCount = [
    formErrors.maxConnectionErrors,
    formErrors.exports,
    formErrors.wgKeyExchangePort,
    formErrors.wgTcpCommsPort,
  ].filter(Boolean).length;

  function update<K extends keyof GenerateInput>(key: K, value: GenerateInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateNumber(key: NumericGenerateInputKey, value: string) {
    const parsed = parseNumberInput(value);
    if (parsed === undefined) return;
    setForm((current) => ({ ...current, [key]: parsed }));
  }

  function updateShellcode<K extends keyof GenerateInput["shellcode"]>(
    key: K,
    value: GenerateInput["shellcode"][K],
  ) {
    setForm((current) => ({
      ...current,
      shellcode: { ...current.shellcode, [key]: value },
    }));
  }

  function addListenerEndpoint(endpoint: string) {
    setForm((current) => {
      const result = appendListenerEndpoint(current.c2, endpoint, current.os);
      return result.added ? { ...current, c2: result.value } : current;
    });
  }

  function resetForm() {
    const next = cloneGenerateInput(defaultGenerateInput);
    setForm(normalizeGenerateTarget(next, targets));
  }

  function changeOperatingSystem(os: string) {
    const nextArch = preferredArchitecture(os, targets);
    if (!nextArch) return;
    const nextFormat = preferredFormat(os, nextArch, targets);
    if (!nextFormat) return;
    setForm((current) => ({ ...current, os, arch: nextArch, format: nextFormat }));
  }

  function changeArchitecture(arch: string) {
    const nextFormat = preferredFormat(form.os, arch, targets);
    if (!nextFormat) return;
    setForm((current) => ({ ...current, arch, format: nextFormat }));
  }

  async function generate() {
    if (!compilerReady) {
      toast.danger("Generation unavailable", {
        description: "Wait for the connected server to advertise a supported compiler target.",
      });
      return;
    }
    if (!formIsValid) {
      toast.danger("Invalid generation settings", {
        description: formValidationError ?? "Fix the indicated fields before generating.",
      });
      return;
    }
    setIsGenerating(true);
    try {
      const result = await window.sliver.generate(form);
      if (!result.ok || !result.value) {
        toast.danger("Generation failed", { description: result.error ?? "The server rejected the request." });
        return;
      }
      if (result.value.saved) {
        toast.success("Artifact generated", {
          description: `${result.value.fileName} · ${formatBytes(result.value.size)}`,
        });
      } else {
        toast.info("Artifact generated", { description: "Saving was cancelled; the build remains archived on the server." });
      }
    } finally {
      setIsGenerating(false);
    }
  }

  async function saveProfile(overwrite: boolean) {
    if (!compilerReady) {
      toast.danger("Profile unavailable", {
        description: "A supported compiler target must be loaded before saving this profile.",
      });
      return;
    }
    if (!formIsValid) {
      toast.danger("Invalid profile settings", {
        description: formValidationError ?? "Fix the indicated fields before saving this profile.",
      });
      return;
    }
    const trimmed = profileName.trim();
    if (!trimmed) {
      toast.warning("Profile name required", { description: "Name the reusable configuration before saving it." });
      return;
    }
    setIsSaving(true);
    try {
      const result = await window.sliver.saveProfile({ profileName: trimmed, config: form, overwrite });
      if (!result.ok) {
        toast.danger("Could not save profile", { description: result.error });
        return;
      }
      toast.success("Profile saved", { description: `${trimmed} is ready for future builds.` });
    } finally {
      setIsSaving(false);
    }
  }

  function requestProfileSave() {
    if (!profileInventoryAuthoritative) {
      toast.danger("Profile inventory incomplete", {
        description: "Refresh the complete profile inventory before creating or replacing a profile.",
      });
      return;
    }
    const exists = snapshot.profiles.some((profile) => profile.name === profileName.trim());
    if (exists) {
      setConfirmOverwrite(true);
    } else {
      void saveProfile(false);
    }
  }

  return (
    <div className="generate-page">
      <fieldset
        aria-busy={isGenerating}
        aria-label="Implant generation configuration"
        className="contents"
        disabled={isGenerating}
      >
      <div className="generate-page__content">
        <div className="page-stack">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><FontAwesomeIcon icon={faBolt} /> Build pipeline</div>
              <h1>Generate implant</h1>
              <p>Configure a reproducible artifact, compile it on the connected server, and save it locally.</p>
            </div>
            <Chip size="sm" variant="soft" color="accent">
              {targets.length} compiler targets
            </Chip>
          </section>

          {!compilerReady ? (
            <div
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
                compilerDomain.status === "error" || compilerDomain.status === "unsupported"
                  ? "border-danger/25 bg-danger-soft text-danger-soft-foreground"
                  : "border-warning/25 bg-warning-soft text-warning-soft-foreground"
              }`}
              role={compilerDomain.status === "error" || compilerDomain.status === "unsupported" ? "alert" : "status"}
            >
              <FontAwesomeIcon
                aria-hidden
                icon={compilerDomain.status === "loading" ? faCircleNotch : faCircleExclamation}
                className={`mt-0.5 size-4 shrink-0 ${compilerDomain.status === "loading" ? "animate-spin" : ""}`}
              />
              <div>
                <p className="font-medium">{compilerStatusTitle(compilerDomain.status, targets.length)}</p>
                <p className="mt-0.5 text-xs opacity-80">
                  {compilerDomain.error ?? compilerStatusDescription(compilerDomain.status, targets.length)}
                </p>
              </div>
            </div>
          ) : null}

      <Card variant="secondary">
        <Card.Header className="flex-row items-center gap-3">
          <span aria-hidden="true" className="section-icon"><FontAwesomeIcon icon={faCode} /></span>
          <div className="min-w-0 flex-1">
            <Card.Title>Artifact</Card.Title>
            <Card.Description>Choose the build identity, target, and output container.</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="form-grid">
          <Field
            label="Build name"
            value={form.name}
            onChange={(value) => update("name", value.toLowerCase())}
            placeholder="Random if left blank"
            description="Letters, numbers, dots, dashes, and underscores."
            error={formErrors.name}
          />
          <SelectField
            label="Implant type"
            value={form.implantType}
            onChange={(value) => update("implantType", value)}
            options={implantTypeOptions}
          />
          <div className="col-span-full flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted">
              Common targets are shown by default. Extended targets may have limited command support.
            </p>
            <Checkbox
              aria-label="All platforms"
              isDisabled={compilerDomain.status !== "ready" || !hasExtendedTargets}
              isSelected={showAllPlatforms}
              variant="secondary"
              onChange={setShowAllPlatforms}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                All platforms
              </Checkbox.Content>
            </Checkbox>
          </div>
          <SelectField
            label="Operating system"
            value={form.os}
            onChange={changeOperatingSystem}
            options={operatingSystems.map(operatingSystemOption)}
            disabled={!compilerReady}
            error={formErrors.os}
          />
          <SelectField
            label="Architecture"
            value={form.arch}
            onChange={changeArchitecture}
            options={architectures.map(architectureOption)}
            disabled={!compilerReady}
            error={formErrors.arch}
          />
          <SelectField
            label="Output format"
            value={form.format}
            onChange={(value) => update("format", value)}
            options={formats.map(formatOption)}
            disabled={!compilerReady}
            error={formErrors.format ?? formErrors.target}
          />
          <Field
            label="Template"
            value={form.templateName}
            onChange={(value) => update("templateName", value)}
            placeholder="sliver"
          />
          {selectedTarget && !selectedTarget.supported ? (
            <div
              className="col-span-full flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground"
              role="status"
            >
              <FontAwesomeIcon aria-hidden icon={faCircleExclamation} className="mt-0.5 size-3.5 shrink-0" />
              This is an extended platform target. The server can compile it, but some commands and features may be unavailable.
            </div>
          ) : null}
        </Card.Content>
      </Card>

      <Card variant="secondary">
        <Card.Header className="flex-row items-center gap-3">
          <span aria-hidden="true" className="section-icon"><FontAwesomeIcon icon={faGlobe} /></span>
          <div className="min-w-0 flex-1">
            <Card.Title>Command and control</Card.Title>
            <Card.Description>Endpoints are attempted in the listed order unless a strategy is selected.</Card.Description>
          </div>
        </Card.Header>
        <Card.Content className="space-y-6">
          <AreaField
            label="C2 endpoints"
            value={form.c2}
            onChange={(value) => update("c2", value)}
            placeholder={"mtls://team.example:8888\nhttps://fallback.example"}
            description="One URL per line or comma-separated. Endpoints without a scheme default to mTLS."
            error={formErrors.c2}
            mono
            required
            action={
              <Button
                aria-haspopup="dialog"
                size="sm"
                variant="secondary"
                onPress={() => setIsListenerSelectorOpen(true)}
              >
                <FontAwesomeIcon aria-hidden icon={faPlus} className="size-3" />
                Add listener
              </Button>
            }
          />
          <div className="form-grid form-grid--three">
            <SelectField
              label="Connection strategy"
              value={form.connectionStrategy}
              onChange={(value) => update("connectionStrategy", value)}
              description="Sequential is the deterministic default."
              options={connectionStrategyOptions}
            />
            <Field
              label="Reconnect delay (seconds)"
              type="number"
              min={0}
              value={String(form.reconnectSeconds)}
              onChange={(value) => updateNumber("reconnectSeconds", value)}
              error={formErrors.reconnectSeconds}
            />
            <Field
              label="Poll timeout (seconds)"
              type="number"
              min={0}
              value={String(form.pollTimeoutSeconds)}
              onChange={(value) => updateNumber("pollTimeoutSeconds", value)}
              error={formErrors.pollTimeoutSeconds}
            />
          </div>
          {form.implantType === "beacon" ? (
            <div className="form-grid">
              <Field
                label="Beacon interval (seconds)"
                type="number"
                min={5}
                value={String(form.beaconIntervalSeconds)}
                onChange={(value) => updateNumber("beaconIntervalSeconds", value)}
                error={formErrors.beaconIntervalSeconds}
              />
              <Field
                label="Beacon jitter (seconds)"
                type="number"
                min={0}
                value={String(form.beaconJitterSeconds)}
                onChange={(value) => updateNumber("beaconJitterSeconds", value)}
                error={formErrors.beaconJitterSeconds}
              />
            </div>
          ) : null}
        </Card.Content>
      </Card>

      <details className="advanced-section">
        <summary>
          <span>
            <FontAwesomeIcon icon={faShieldHalved} /> Build hardening
            {hardeningErrorCount > 0 ? (
              <span className="ml-2 text-xs font-medium text-danger">
                {hardeningErrorCount} {hardeningErrorCount === 1 ? "invalid field" : "invalid fields"}
              </span>
            ) : null}
          </span>
          <FontAwesomeIcon icon={faChevronRight} className="advanced-chevron" />
        </summary>
        <div className="advanced-content grid gap-x-8 gap-y-4 md:grid-cols-2">
          <SwitchRow label="Obfuscate symbols" description="Randomize identifiers in the generated source." selected={form.obfuscateSymbols} onChange={(value) => update("obfuscateSymbols", value)} />
          <SwitchRow label="Pure Go networking" description="Prefer the portable Go resolver and networking stack." selected={form.netGo} onChange={(value) => update("netGo", value)} />
          <SwitchRow label="Evasion" description="Enable target-specific defensive evasion at compile time." selected={form.evasion} onChange={(value) => update("evasion", value)} />
          <SwitchRow label="Debug build" description="Retain diagnostic information and verbose runtime logging." selected={form.debug} onChange={(value) => update("debug", value)} />
          <SwitchRow label="Run at load" description="Invoke shared-library entry behavior when the module loads." selected={form.runAtLoad} onChange={(value) => update("runAtLoad", value)} disabled={form.format !== "shared"} />
          <Field label="Maximum connection errors" type="number" min={0} value={String(form.maxConnectionErrors)} onChange={(value) => updateNumber("maxConnectionErrors", value)} error={formErrors.maxConnectionErrors} />
          <Field label="Exported symbols" value={form.exports} onChange={(value) => update("exports", value)} placeholder="SymbolOne, SymbolTwo" description="Comma-separated; shared libraries only." error={formErrors.exports} />
          <Field label="HTTP C2 profile" value={form.httpC2Profile} onChange={(value) => update("httpC2Profile", value)} placeholder="default" />
          <AreaField label="Canary domains" value={form.canaryDomains} onChange={(value) => update("canaryDomains", value)} placeholder="example.net" description="One domain per line; trailing dots are normalized." rows={3} />
          <div className="form-grid self-start">
            <Field label="WireGuard peer IP" value={form.wgPeerTunIp} onChange={(value) => update("wgPeerTunIp", value)} placeholder="Assigned automatically" />
            <Field label="WG key exchange port" type="number" min={1} max={65535} value={String(form.wgKeyExchangePort)} onChange={(value) => updateNumber("wgKeyExchangePort", value)} error={formErrors.wgKeyExchangePort} />
            <Field label="WG TCP comms port" type="number" min={1} max={65535} value={String(form.wgTcpCommsPort)} onChange={(value) => updateNumber("wgTcpCommsPort", value)} error={formErrors.wgTcpCommsPort} />
          </div>
        </div>
      </details>

      <details className="advanced-section">
        <summary>
          <span><FontAwesomeIcon icon={faShieldHalved} /> Execution limits</span>
          <FontAwesomeIcon icon={faChevronRight} className="advanced-chevron" />
        </summary>
        <div className="advanced-content">
          <SwitchRow label="Require domain membership" description="Run only when the endpoint is joined to a domain." selected={form.limitDomainJoined} onChange={(value) => update("limitDomainJoined", value)} />
          <div className="form-grid mt-5">
            <Field label="Not after" type="datetime-local" value={form.limitDatetime} onChange={(value) => update("limitDatetime", value)} />
            <Field label="Hostname" value={form.limitHostname} onChange={(value) => update("limitHostname", value)} />
            <Field label="Username" value={form.limitUsername} onChange={(value) => update("limitUsername", value)} />
            <Field label="Required file" value={form.limitFileExists} onChange={(value) => update("limitFileExists", value)} placeholder="C:\\ProgramData\\marker" />
            <Field label="Locale" value={form.limitLocale} onChange={(value) => update("limitLocale", value)} placeholder="en-US" />
          </div>
        </div>
      </details>

          {form.format === "shellcode" ? (
            <details className="advanced-section" open>
              <summary>
                <span><FontAwesomeIcon icon={faCode} /> Shellcode</span>
                <FontAwesomeIcon icon={faChevronRight} className="advanced-chevron" />
              </summary>
              <div className="advanced-content">
                <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
                  <SwitchRow label="Compress shellcode" description="Reduce the local payload size." selected={form.shellcode.compress} onChange={(value) => updateShellcode("compress", value)} />
                  <SwitchRow label="Run in a new thread" description="Transfer control through a newly created thread." selected={form.shellcode.runInThread} onChange={(value) => updateShellcode("runInThread", value)} />
                  <SwitchRow label="Unicode" description="Use the Unicode-compatible execution path." selected={form.shellcode.unicode} onChange={(value) => updateShellcode("unicode", value)} />
                </div>
                <div className="form-grid form-grid--three mt-5">
                  <SelectField
                    label="Entropy"
                    value={oneToThreeSelection(form.shellcode.entropy)}
                    onChange={(value) => updateShellcode("entropy", ONE_TO_THREE_VALUES[value])}
                    options={entropyOptions}
                  />
                  <SelectField
                    label="Exit behavior"
                    value={oneToThreeSelection(form.shellcode.exitOption)}
                    onChange={(value) => updateShellcode("exitOption", ONE_TO_THREE_VALUES[value])}
                    options={exitBehaviorOptions}
                  />
                  <SelectField
                    label="Bypass"
                    value={oneToThreeSelection(form.shellcode.bypass)}
                    onChange={(value) => updateShellcode("bypass", ONE_TO_THREE_VALUES[value])}
                    options={bypassOptions}
                  />
                  <SelectField
                    label="Headers"
                    value={oneToTwoSelection(form.shellcode.headers)}
                    onChange={(value) => updateShellcode("headers", ONE_TO_TWO_VALUES[value])}
                    options={headerOptions}
                  />
                  <Field
                    label="Original entry point"
                    type="number"
                    min={0}
                    value={String(form.shellcode.originalEntryPoint)}
                    onChange={(value) => {
                      const parsed = parseNumberInput(value);
                      if (parsed !== undefined) updateShellcode("originalEntryPoint", parsed);
                    }}
                    error={formErrors.shellcode}
                  />
                </div>
              </div>
            </details>
          ) : null}
        </div>
      </div>

      <footer aria-label="Generate actions" className="generate-page__footer">
        <div className="generate-page__footer-content">
          <div className="generate-page__footer-field">
            <Field
              label="Reusable profile name"
              value={profileName}
              onChange={setProfileName}
              placeholder="production-windows"
              description={
                profileInventoryAuthoritative
                  ? "Saving an existing name requires explicit replacement confirmation."
                  : "Saving is unavailable while the profile inventory is incomplete or stale."
              }
            />
          </div>
          <div className="generate-page__footer-actions">
            <Button variant="tertiary" onPress={resetForm}>
              <FontAwesomeIcon icon={faArrowRotateLeft} /> Reset
            </Button>
            <Button
              isDisabled={!compilerReady || !profileInventoryAuthoritative || !formIsValid}
              variant="secondary"
              isPending={isSaving}
              onPress={requestProfileSave}
            >
              <FontAwesomeIcon icon={faFloppyDisk} /> Save profile
            </Button>
            <Button isDisabled={!compilerReady || !formIsValid} isPending={isGenerating} onPress={() => void generate()}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : <FontAwesomeIcon icon={faDownload} />}
                  Generate and save
                </>
              )}
            </Button>
          </div>
        </div>
      </footer>
      </fieldset>

      <ConfirmDialog
        isOpen={confirmOverwrite}
        onOpenChange={setConfirmOverwrite}
        title={`Replace ${profileName.trim()}?`}
        description="This replaces the saved server-side profile configuration. Existing builds are not modified."
        confirmLabel="Replace profile"
        isPending={isSaving}
        onConfirm={() => saveProfile(true)}
      />
      <ListenerEndpointSelector
        connectionIncarnation={snapshot.connection.incarnation}
        connectionServer={snapshot.connection.server}
        currentC2={form.c2}
        isOpen={isListenerSelectorOpen}
        jobs={snapshot.domains.jobs}
        targetOs={form.os}
        onAddEndpoint={addListenerEndpoint}
        onOpenChange={setIsListenerSelectorOpen}
      />
    </div>
  );
}

function compilerStatusTitle(status: SliverSnapshot["domains"]["compiler"]["status"], supportedCount: number): string {
  if (status === "loading") return "Loading compiler targets";
  if (status === "error") return "Compiler targets could not be loaded";
  if (status === "unsupported") return "Generation is unsupported by this server";
  if (status === "empty" || (status === "ready" && supportedCount === 0)) return "No supported compiler targets";
  return "Compiler targets are not loaded";
}

function compilerStatusDescription(
  status: SliverSnapshot["domains"]["compiler"]["status"],
  supportedCount: number,
): string {
  if (status === "loading") return "The connected server is advertising its compiler capabilities.";
  if (status === "empty" || (status === "ready" && supportedCount === 0)) {
    return "The server returned no supported target combinations; no fallback targets were fabricated.";
  }
  if (status === "unsupported") return "Connect to a compatible Sliver server to generate implants.";
  return "Refresh the server state or reconnect before generating or saving a profile.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
