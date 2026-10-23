import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, Input, Label, ScrollShadow, TextArea, TextField } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import type { OperationResult } from "../../../shared/contracts";
import type { BeagleMutationResult } from "../../../shared/beagle-contracts";
import { beagleRuleLabels, parseBeagleRuleConfiguration, type BeagleAssetGroup, type BeagleRuleConfiguration, type BeagleRuleExpansion, type BeagleRulePreview, type BeagleRulesInput } from "../../../shared/beagle-rules";

export interface BeagleRulesPanelProps {
  api: {
    getRules(): Promise<OperationResult<BeagleRuleConfiguration>>;
    previewRules(input: BeagleRulesInput): Promise<OperationResult<BeagleRulePreview>>;
    applyRules(input: BeagleRulesInput): Promise<OperationResult<BeagleMutationResult>>;
  };
  projectId: string;
  labels: string[];
  disabled?: boolean;
  onApplied: (value: BeagleMutationResult) => void;
  onInspectObject: (objectid: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

export function BeagleRulesPanel({ api, projectId, labels, disabled = false, onApplied, onInspectObject, onBusyChange }: BeagleRulesPanelProps) {
  const [configuration, setConfiguration] = useState<BeagleRuleConfiguration>({ groups: [] });
  const [label, setLabel] = useState("Tag_Tier_Zero");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<BeagleRulePreview>();
  const [status, setStatus] = useState<string>();
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const available = beagleRuleLabels(labels, configuration);
  const rule = configuration.groups.find((entry) => entry.label === label);
  const locked = disabled || busy || !loaded;

  useEffect(() => {
    const request = ++sequence.current;
    setLoaded(false); setConfiguration({ groups: [] }); setLabel("Tag_Tier_Zero"); setError(undefined); setPreview(undefined); setStatus(undefined); setBusy(false);
    void api.getRules().then((response) => {
      if (request !== sequence.current || currentProject.current !== projectId) return;
      if (!response.ok) throw new Error(response.error);
      setConfiguration(response.value); setLoaded(true);
    }).catch((cause: unknown) => {
      if (request === sequence.current) setError(cause instanceof Error ? cause.message : "Could not load label rules.");
    });
    return () => { sequence.current++; };
  }, [api, projectId, reload]);

  function edit(next: BeagleRuleConfiguration) {
    setConfiguration(next); setPreview(undefined); setError(undefined); setStatus("Unsaved rule changes");
  }
  function update(values: Partial<BeagleAssetGroup>) {
    edit({ groups: configuration.groups.map((entry) => entry.label === label ? { ...entry, ...values } : entry) });
  }
  async function run(apply: boolean) {
    if (locked) return;
    let validated: BeagleRuleConfiguration;
    try { validated = parseBeagleRuleConfiguration({ groups: configuration.groups.map((group) => ({ ...group,
      seeds: group.seeds.filter((seed) => seed.type !== "objectid" || seed.value.trim()).map((seed) => seed.type === "objectid" ? { ...seed, value: seed.value.trim() } : seed),
      exclusions: group.exclusions.map((id) => id.trim()).filter(Boolean),
    })) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid label rules."); return; }
    const request = ++sequence.current;
    setBusy(true); setError(undefined); setStatus(undefined); setPreview(undefined);
    onBusyChange?.(true);
    try {
      if (apply) {
        const response = await api.applyRules({ configuration: validated });
        if (request !== sequence.current || currentProject.current !== projectId) return;
        if (!response.ok) throw new Error(response.error);
        if (response.value.state.selectedProjectId !== projectId) return;
        setConfiguration(validated); setStatus("Rules saved and applied. They will run again on analysis and import.");
        onApplied(response.value);
      } else {
        const response = await api.previewRules({ configuration: validated });
        if (request !== sequence.current || currentProject.current !== projectId) return;
        if (!response.ok) throw new Error(response.error);
        setPreview(response.value); setStatus("Preview only. The project and saved rules have not changed.");
      }
    } catch (cause) {
      if (request === sequence.current) setError(cause instanceof Error ? cause.message : "Could not evaluate label rules.");
    } finally { if (request === sequence.current) setBusy(false); onBusyChange?.(false); }
  }

  return <section aria-label="Label rules" className="flex min-w-0 flex-col gap-4 text-sm">
    <p className="text-muted">Manage rules for labels already in this project. Enabled rules replace the selected label’s membership after analysis. Per-object tag overrides apply afterward.</p>
    <NativeSelect variant="secondary"><Label>Rule label</Label><NativeSelect.Trigger aria-label="Rule label" value={label} disabled={locked} onChange={(event) => setLabel(event.target.value)}>
      {available.map((entry) => <NativeSelect.Option key={entry} value={entry}>{entry}{configuration.groups.some((group) => group.label === entry) ? " · rule" : ""}</NativeSelect.Option>)}<NativeSelect.Indicator />
    </NativeSelect.Trigger></NativeSelect>
    {!loaded && !error ? <p role="status" className="text-muted">{disabled ? "Select an available project to edit rules." : "Loading label rules…"}</p> : null}
    {!rule && loaded ? <Button size="sm" variant="secondary" isDisabled={locked || configuration.groups.length >= 32} onPress={() => edit({ groups: [...configuration.groups, { label, seeds: [], exclusions: [], expansion: "none", tier: label.startsWith("Tag_Tier_"), enabled: true, priority: configuration.groups.length }] })}>Add rule for {label}</Button> : null}
    {rule ? <div className="flex flex-col gap-4">
      <Checkbox isSelected={rule.enabled} isDisabled={locked} onChange={(enabled) => update({ enabled })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Enable rule</Checkbox.Content></Checkbox>
      <p className="text-xs text-muted">Disabling a rule preserves its settings and restores analysis defaults for that label.</p>
      <TextField value={rule.seeds.filter((seed) => seed.type === "objectid").map((seed) => seed.value).join("\n")} onChange={(value) => update({ seeds: [...(value ? value.split("\n") : []).map((value) => ({ type: "objectid" as const, value })), ...rule.seeds.filter((seed) => seed.type === "cypher")] })} isDisabled={locked}>
        <Label>Object ID selectors (one per line)</Label><TextArea rows={3} />
      </TextField>
      {rule.seeds.filter((seed) => seed.type === "cypher").map((seed, index) => <div className="flex flex-col gap-2" key={index}>
        <TextField value={seed.value} isDisabled={locked} onChange={(value) => {
          let current = -1;
          update({ seeds: rule.seeds.map((entry) => entry.type === "cypher" && ++current === index ? { ...entry, value } : entry) });
        }}><Label>Cypher selector {index + 1}</Label><TextArea rows={4} className="font-mono" /></TextField>
        <Button size="sm" variant="tertiary" isDisabled={locked} onPress={() => { let current = -1; update({ seeds: rule.seeds.filter((entry) => entry.type !== "cypher" || ++current !== index) }); }}>Remove Cypher selector {index + 1}</Button>
      </div>)}
      <Button size="sm" variant="tertiary" isDisabled={locked || rule.seeds.length >= 128} onPress={() => update({ seeds: [...rule.seeds, { type: "cypher", value: "MATCH (n:User) RETURN n LIMIT 100" }] })}>Add Cypher selector</Button>
      <p className="text-xs text-muted">Selectors return nodes or object ID strings. Preview evaluates selectors without saving. Missing object IDs are reported.</p>
      <NativeSelect variant="secondary"><Label>Expansion direction</Label><NativeSelect.Trigger aria-label="Expansion direction" value={rule.expansion} disabled={locked} onChange={(event) => update({ expansion: event.target.value as BeagleRuleExpansion })}>
        <NativeSelect.Option value="none">Selected objects only</NativeSelect.Option><NativeSelect.Option value="children">Children</NativeSelect.Option><NativeSelect.Option value="parents">Parents</NativeSelect.Option><NativeSelect.Option value="all">Children and parents</NativeSelect.Option><NativeSelect.Indicator />
      </NativeSelect.Trigger></NativeSelect>
      <p className="text-xs text-muted">Children include group members and contained objects. Parents include applicable containers and linked GPOs; parent expansion does not add siblings.</p>
      <TextField value={rule.exclusions.join("\n")} onChange={(value) => update({ exclusions: value ? value.split("\n") : [] })} isDisabled={locked}><Label>Excluded object IDs (one per line)</Label><TextArea rows={3} /></TextField>
      <Checkbox isSelected={rule.tier} isDisabled={locked} onChange={(tier) => update({ tier })}><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>Use tier precedence</Checkbox.Content></Checkbox>
      <TextField value={String(rule.priority)} onChange={(value) => update({ priority: value === "" ? 0 : Number(value) })} isDisabled={locked}><Label>Priority</Label><Input type="number" min={0} max={1_000_000} /></TextField>
      <p className="text-xs text-muted">Lower priority numbers claim overlapping tier objects first. Equal priorities use rule list order. Non-tier rules may overlap.</p>
      <Button size="sm" variant="danger-soft" isDisabled={locked} onPress={() => edit({ groups: configuration.groups.filter((entry) => entry.label !== label) })}>Remove rule for {label}</Button>
    </div> : null}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" isDisabled={locked} onPress={() => { void run(false); }}>Preview all rules</Button><Button size="sm" isDisabled={locked} onPress={() => { void run(true); }}>Save and apply rules</Button></div>
    {busy ? <p role="status" className="text-muted">Evaluating label rules…</p> : status ? <p role="status" className="text-muted">{status}</p> : null}
    {error ? <div className="flex flex-col gap-2"><p role="alert" className="text-danger">{error}</p>{!loaded ? <Button size="sm" variant="secondary" isDisabled={disabled || busy} onPress={() => setReload((value) => value + 1)}>Reload label rules</Button> : null}</div> : null}
    {preview ? <div aria-label="Rule preview" className="flex flex-col gap-3">
      <p className="font-medium">Rule-selected objects before per-object tag overrides</p>
      {Object.entries(preview.counts).map(([name, total]) => <div key={name} className="flex flex-col gap-2 border-t border-separator pt-3">
        <p>{name}: {total.toLocaleString()} {total === 1 ? "object" : "objects"}</p>
        <ScrollShadow className="max-h-40 overflow-y-auto"><div className="flex flex-col items-start gap-1">{preview.selected[name]?.map((id) => <Button key={id} variant="tertiary" size="sm" className="max-w-full" isDisabled={locked} onPress={() => onInspectObject(id)}><span className="truncate">{id}</span></Button>)}</div></ScrollShadow>
      </div>)}
      {preview.missingTotal > 0 ? <div role="alert" className="text-warning"><p>{preview.missingTotal.toLocaleString()} selector object IDs were not found.</p><ScrollShadow className="max-h-32 overflow-y-auto"><ul>{preview.missingObjectids.map((id) => <li key={id} className="break-all">{id}</li>)}</ul></ScrollShadow></div> : null}
      {preview.truncated ? <p className="text-muted">Counts are complete. Only the first 100 object IDs per label and the first 100 missing IDs are shown.</p> : null}
    </div> : null}
  </section>;
}
