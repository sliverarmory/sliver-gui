import { useMemo, useState } from "react";
import { Button, Card, Chip, toast } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRotateLeft,
  faBolt,
  faChevronRight,
  faCode,
  faDownload,
  faFloppyDisk,
  faGlobe,
  faShieldHalved,
} from "@fortawesome/free-solid-svg-icons";
import type {
  ArtifactFormat,
  GenerateInput,
  SliverSnapshot,
} from "../../../shared/contracts";
import { AreaField, Field, SelectField, SwitchRow } from "../components/FormControls";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { cloneGenerateInput, defaultGenerateInput } from "../../../shared/generate-defaults";

interface GeneratePageProps {
  snapshot: SliverSnapshot;
}

const fallbackTargets = [
  { os: "windows", arch: "amd64", format: "executable" as const },
  { os: "windows", arch: "amd64", format: "service" as const },
  { os: "windows", arch: "amd64", format: "shared" as const },
  { os: "windows", arch: "amd64", format: "shellcode" as const },
  { os: "linux", arch: "amd64", format: "executable" as const },
  { os: "linux", arch: "arm64", format: "executable" as const },
  { os: "darwin", arch: "arm64", format: "executable" as const },
];

const formatLabels: Record<ArtifactFormat, string> = {
  executable: "Executable",
  service: "Windows service",
  shared: "Shared library",
  shellcode: "Shellcode",
  archive: "Go archive",
};

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function GeneratePage({ snapshot }: GeneratePageProps) {
  const [form, setForm] = useState<GenerateInput>(() => cloneGenerateInput(defaultGenerateInput));
  const [profileName, setProfileName] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const targets = useMemo(() => {
    const advertised = snapshot.compilerTargets.filter((target) => target.supported);
    return advertised.length > 0 ? advertised : fallbackTargets;
  }, [snapshot.compilerTargets]);

  const operatingSystems = unique(targets.map((target) => target.os));
  const architectures = unique(
    targets.filter((target) => target.os === form.os).map((target) => target.arch),
  );
  const formats = unique(
    targets
      .filter((target) => target.os === form.os && target.arch === form.arch)
      .map((target) => target.format),
  ) as ArtifactFormat[];

  function update<K extends keyof GenerateInput>(key: K, value: GenerateInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateNumber<K extends keyof GenerateInput>(key: K, value: string) {
    update(key, Number(value) as GenerateInput[K]);
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

  function changeOperatingSystem(os: string) {
    const nextArch = targets.find((target) => target.os === os)?.arch ?? form.arch;
    const nextFormat =
      targets.find((target) => target.os === os && target.arch === nextArch)?.format ?? form.format;
    setForm((current) => ({ ...current, os, arch: nextArch, format: nextFormat }));
  }

  function changeArchitecture(arch: string) {
    const nextFormat =
      targets.find((target) => target.os === form.os && target.arch === arch)?.format ?? form.format;
    setForm((current) => ({ ...current, arch, format: nextFormat }));
  }

  async function generate() {
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

  async function saveProfile() {
    const trimmed = profileName.trim();
    if (!trimmed) {
      toast.warning("Profile name required", { description: "Name the reusable configuration before saving it." });
      return;
    }
    setIsSaving(true);
    try {
      const result = await window.sliver.saveProfile({ profileName: trimmed, config: form });
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
    const exists = snapshot.profiles.some((profile) => profile.name === profileName.trim());
    if (exists) {
      setConfirmOverwrite(true);
    } else {
      void saveProfile();
    }
  }

  return (
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

      <Card variant="secondary">
        <Card.Header>
          <div className="section-icon"><FontAwesomeIcon icon={faCode} /></div>
          <div>
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
          />
          <SelectField
            label="Implant type"
            value={form.implantType}
            onChange={(value) => update("implantType", value as GenerateInput["implantType"])}
          >
            <NativeSelect.Option value="session">Interactive session</NativeSelect.Option>
            <NativeSelect.Option value="beacon">Asynchronous beacon</NativeSelect.Option>
          </SelectField>
          <SelectField label="Operating system" value={form.os} onChange={changeOperatingSystem}>
            {operatingSystems.map((os) => <NativeSelect.Option key={os} value={os}>{os}</NativeSelect.Option>)}
          </SelectField>
          <SelectField label="Architecture" value={form.arch} onChange={changeArchitecture}>
            {architectures.map((arch) => <NativeSelect.Option key={arch} value={arch}>{arch}</NativeSelect.Option>)}
          </SelectField>
          <SelectField
            label="Output format"
            value={form.format}
            onChange={(value) => update("format", value as ArtifactFormat)}
          >
            {formats.map((format) => (
              <NativeSelect.Option key={format} value={format}>{formatLabels[format]}</NativeSelect.Option>
            ))}
          </SelectField>
          <Field
            label="Template"
            value={form.templateName}
            onChange={(value) => update("templateName", value)}
            placeholder="sliver"
          />
        </Card.Content>
      </Card>

      <Card variant="secondary">
        <Card.Header>
          <div className="section-icon"><FontAwesomeIcon icon={faGlobe} /></div>
          <div>
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
            description="One URL per line or comma-separated. Bare HTTP hosts default to HTTPS."
            mono
            required
          />
          <div className="form-grid form-grid--three">
            <SelectField
              label="Connection strategy"
              value={form.connectionStrategy}
              onChange={(value) => update("connectionStrategy", value as GenerateInput["connectionStrategy"])}
              description="Sequential is the deterministic default."
            >
              <NativeSelect.Option value="">Sequential</NativeSelect.Option>
              <NativeSelect.Option value="s">Random start</NativeSelect.Option>
              <NativeSelect.Option value="r">Random</NativeSelect.Option>
              <NativeSelect.Option value="rd">Random domain</NativeSelect.Option>
            </SelectField>
            <Field
              label="Reconnect delay (seconds)"
              type="number"
              min={1}
              value={String(form.reconnectSeconds)}
              onChange={(value) => updateNumber("reconnectSeconds", value)}
            />
            <Field
              label="Poll timeout (seconds)"
              type="number"
              min={1}
              value={String(form.pollTimeoutSeconds)}
              onChange={(value) => updateNumber("pollTimeoutSeconds", value)}
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
              />
              <Field
                label="Beacon jitter (seconds)"
                type="number"
                min={0}
                value={String(form.beaconJitterSeconds)}
                onChange={(value) => updateNumber("beaconJitterSeconds", value)}
              />
            </div>
          ) : null}
        </Card.Content>
      </Card>

      <details className="advanced-section">
        <summary>
          <span><FontAwesomeIcon icon={faShieldHalved} /> Build hardening</span>
          <FontAwesomeIcon icon={faChevronRight} className="advanced-chevron" />
        </summary>
        <div className="advanced-content grid gap-x-8 md:grid-cols-2">
          <SwitchRow label="Obfuscate symbols" description="Randomize identifiers in the generated source." selected={form.obfuscateSymbols} onChange={(value) => update("obfuscateSymbols", value)} />
          <SwitchRow label="Pure Go networking" description="Prefer the portable Go resolver and networking stack." selected={form.netGo} onChange={(value) => update("netGo", value)} />
          <SwitchRow label="Evasion" description="Enable target-specific defensive evasion at compile time." selected={form.evasion} onChange={(value) => update("evasion", value)} />
          <SwitchRow label="Debug build" description="Retain diagnostic information and verbose runtime logging." selected={form.debug} onChange={(value) => update("debug", value)} />
          <SwitchRow label="Run at load" description="Invoke shared-library entry behavior when the module loads." selected={form.runAtLoad} onChange={(value) => update("runAtLoad", value)} disabled={form.format !== "shared"} />
          <Field label="Maximum connection errors" type="number" min={1} value={String(form.maxConnectionErrors)} onChange={(value) => updateNumber("maxConnectionErrors", value)} />
          <Field label="Exported symbols" value={form.exports} onChange={(value) => update("exports", value)} placeholder="SymbolOne, SymbolTwo" description="Comma-separated; shared libraries only." />
          <Field label="HTTP C2 profile" value={form.httpC2Profile} onChange={(value) => update("httpC2Profile", value)} placeholder="default" />
          <AreaField label="Canary domains" value={form.canaryDomains} onChange={(value) => update("canaryDomains", value)} placeholder="example.net" description="One domain per line; trailing dots are normalized." rows={3} />
          <div className="form-grid self-start">
            <Field label="WireGuard peer IP" value={form.wgPeerTunIp} onChange={(value) => update("wgPeerTunIp", value)} placeholder="Assigned automatically" />
            <Field label="WG key exchange port" type="number" min={1} max={65534} value={String(form.wgKeyExchangePort)} onChange={(value) => updateNumber("wgKeyExchangePort", value)} />
            <Field label="WG TCP comms port" type="number" min={1} max={65534} value={String(form.wgTcpCommsPort)} onChange={(value) => updateNumber("wgTcpCommsPort", value)} />
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
            <div className="grid gap-x-8 md:grid-cols-2">
              <SwitchRow label="Compress shellcode" description="Reduce the local payload size." selected={form.shellcode.compress} onChange={(value) => updateShellcode("compress", value)} />
              <SwitchRow label="Run in a new thread" description="Transfer control through a newly created thread." selected={form.shellcode.runInThread} onChange={(value) => updateShellcode("runInThread", value)} />
              <SwitchRow label="Unicode" description="Use the Unicode-compatible execution path." selected={form.shellcode.unicode} onChange={(value) => updateShellcode("unicode", value)} />
            </div>
            <div className="form-grid form-grid--three mt-5">
              <SelectField label="Entropy" value={String(form.shellcode.entropy)} onChange={(value) => updateShellcode("entropy", Number(value) as 1 | 2 | 3)}>
                <NativeSelect.Option value="1">None</NativeSelect.Option><NativeSelect.Option value="2">Low</NativeSelect.Option><NativeSelect.Option value="3">High</NativeSelect.Option>
              </SelectField>
              <SelectField label="Exit behavior" value={String(form.shellcode.exitOption)} onChange={(value) => updateShellcode("exitOption", Number(value) as 1 | 2 | 3)}>
                <NativeSelect.Option value="1">Thread</NativeSelect.Option><NativeSelect.Option value="2">Process</NativeSelect.Option><NativeSelect.Option value="3">SEH</NativeSelect.Option>
              </SelectField>
              <SelectField label="Bypass" value={String(form.shellcode.bypass)} onChange={(value) => updateShellcode("bypass", Number(value) as 1 | 2 | 3)}>
                <NativeSelect.Option value="1">None</NativeSelect.Option><NativeSelect.Option value="2">Abort on failure</NativeSelect.Option><NativeSelect.Option value="3">Continue on failure</NativeSelect.Option>
              </SelectField>
              <SelectField label="Headers" value={String(form.shellcode.headers)} onChange={(value) => updateShellcode("headers", Number(value) as 1 | 2)}>
                <NativeSelect.Option value="1">Overwrite</NativeSelect.Option><NativeSelect.Option value="2">Copy</NativeSelect.Option>
              </SelectField>
              <Field label="Original entry point" type="number" min={0} value={String(form.shellcode.originalEntryPoint)} onChange={(value) => updateShellcode("originalEntryPoint", Number(value))} />
            </div>
          </div>
        </details>
      ) : null}

      <Card variant="secondary" className="action-card">
        <Card.Content className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1">
            <Field
              label="Reusable profile name"
              value={profileName}
              onChange={setProfileName}
              placeholder="production-windows"
              description="Saving an existing name replaces its configuration."
            />
          </div>
          <div className="flex flex-wrap gap-3 lg:justify-end">
            <Button variant="tertiary" onPress={() => setForm(cloneGenerateInput(defaultGenerateInput))}>
              <FontAwesomeIcon icon={faArrowRotateLeft} /> Reset
            </Button>
            <Button variant="secondary" isPending={isSaving} onPress={requestProfileSave}>
              <FontAwesomeIcon icon={faFloppyDisk} /> Save profile
            </Button>
            <Button isPending={isGenerating} onPress={() => void generate()}>
              <FontAwesomeIcon icon={faDownload} /> Generate and save
            </Button>
          </div>
        </Card.Content>
      </Card>

      <ConfirmDialog
        isOpen={confirmOverwrite}
        onOpenChange={setConfirmOverwrite}
        title={`Replace ${profileName.trim()}?`}
        description="This replaces the saved server-side profile configuration. Existing builds are not modified."
        confirmLabel="Replace profile"
        isPending={isSaving}
        onConfirm={saveProfile}
      />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
