import { useEffect, useRef, useState } from "react";
import { Button, Checkbox, ComboBox, Disclosure, Input, Label, ListBox, TextField } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import type { BeagleAPI, BeagleNode, BeaglePathsInput, BeagleSearchResult } from "../../../shared/beagle-contracts";
import { BEAGLE_PATH_EDGE_CATEGORIES, BEAGLE_PATH_EDGE_KINDS } from "../../../shared/beagle-investigations";
import { nodeKind, nodeName } from "./beagle-model";

interface Props {
  api: BeagleAPI;
  projectId: string;
  source: string;
  target: string;
  onSourceChange: (value: string) => void;
  onTargetChange: (value: string) => void;
  onRun: (input: BeaglePathsInput) => void;
  disabled: boolean;
  loading: boolean;
}

export function BeaglePathControls({ api, projectId, source, target, onSourceChange, onTargetChange, onRun, disabled, loading }: Props) {
  const [via, setVia] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [maxHops, setMaxHops] = useState("12");
  const [kinds, setKinds] = useState<string[]>([...BEAGLE_PATH_EDGE_KINDS]);
  const [error, setError] = useState<string>();
  const endpoints = [source, ...via, target];
  function setEndpoints(next: string[]) {
    onSourceChange(next[0] ?? ""); onTargetChange(next.at(-1) ?? ""); setVia(next.slice(1, -1));
  }
  function move(index: number, direction: number) {
    const next = [...endpoints];
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    setEndpoints(next);
  }
  function toggleKinds(values: readonly string[], enabled: boolean) {
    setKinds((previous) => enabled ? [...new Set([...previous, ...values])] : previous.filter((kind) => !values.includes(kind)));
  }
  return <div className="beagle-path-controls">
    <p className="beagle-muted">Search by name or enter an object ID. Paths follow the endpoint order below.</p>
    {endpoints.map((value, index) => {
      const label = index === 0 ? "Source object ID" : index === endpoints.length - 1 ? "Target object ID" : `Via ${index} object ID`;
      return <div key={index} className="beagle-path-endpoint">
        <BeagleEndpointPicker api={api} projectId={projectId} label={label} value={value} disabled={disabled}
          onChange={(nextValue) => setEndpoints(endpoints.map((item, itemIndex) => itemIndex === index ? nextValue : item))} />
        <div className="beagle-path-order">
          <Button size="sm" variant="tertiary" aria-label={`Move ${label} up`} isDisabled={disabled || index === 0} onPress={() => move(index, -1)}>Up</Button>
          <Button size="sm" variant="tertiary" aria-label={`Move ${label} down`} isDisabled={disabled || index === endpoints.length - 1} onPress={() => move(index, 1)}>Down</Button>
          {index > 0 && index < endpoints.length - 1 ? <Button size="sm" variant="tertiary" aria-label={`Remove via ${index}`} isDisabled={disabled} onPress={() => setVia(via.filter((_, viaIndex) => viaIndex !== index - 1))}>Remove</Button> : null}
        </div>
      </div>;
    })}
    <div className="beagle-path-order">
      <Button size="sm" variant="secondary" isDisabled={disabled || via.length >= 2} onPress={() => setVia([...via, ""])}>Add waypoint</Button>
      <Button size="sm" variant="tertiary" isDisabled={disabled} onPress={() => setEndpoints([...endpoints].reverse())}>Reverse route</Button>
    </div>
    <Disclosure className="beagle-path-filters">
      <Disclosure.Heading><Button slot="trigger" variant="secondary" size="sm">Relationship types ({kinds.length}/{BEAGLE_PATH_EDGE_KINDS.length})<Disclosure.Indicator /></Button></Disclosure.Heading>
      <Disclosure.Content><Disclosure.Body>
        <p className="beagle-muted">Only selected relationship types are traversed.</p>
        <div className="beagle-path-order"><Button size="sm" variant="tertiary" isDisabled={disabled} onPress={() => setKinds([...BEAGLE_PATH_EDGE_KINDS])}>Select all types</Button>
          <Button size="sm" variant="tertiary" isDisabled={disabled} onPress={() => setKinds([])}>Clear types</Button></div>
        {BEAGLE_PATH_EDGE_CATEGORIES.map((category) => {
          const count = category.kinds.filter((kind) => kinds.includes(kind)).length;
          return <fieldset key={category.id} className="beagle-path-category"><legend>{category.label}</legend>
            <Checkbox aria-label={`All ${category.label} types`} isDisabled={disabled} isSelected={count === category.kinds.length} isIndeterminate={count > 0 && count < category.kinds.length} onChange={(enabled) => toggleKinds(category.kinds, enabled)}>
              <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>All in category</Checkbox.Content></Checkbox>
            {category.kinds.map((kind) => <Checkbox key={kind} isDisabled={disabled} isSelected={kinds.includes(kind)} onChange={(enabled) => toggleKinds([kind], enabled)}>
              <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{kind}</Checkbox.Content></Checkbox>)}
          </fieldset>;
        })}
      </Disclosure.Body></Disclosure.Content>
    </Disclosure>
    {!kinds.length ? <p className="beagle-muted">Select at least one relationship type.</p> : null}
    <NativeSelect variant="secondary"><Label>Path mode</Label><NativeSelect.Trigger aria-label="Path mode" value={all ? "all" : "shortest"} disabled={disabled} onChange={(event) => setAll(event.target.value === "all")}>
      <NativeSelect.Option value="shortest">Shortest path</NativeSelect.Option><NativeSelect.Option value="all">All shortest paths</NativeSelect.Option><NativeSelect.Indicator />
    </NativeSelect.Trigger></NativeSelect>
    <TextField value={maxHops} onChange={setMaxHops} isDisabled={disabled}><Label>Maximum hops per leg</Label><Input type="number" min={1} max={64} /></TextField>
    {error ? <p role="alert" className="text-danger text-sm">{error}</p> : null}
    <Button size="sm" isDisabled={disabled || loading || endpoints.some((value) => !value.trim()) || !kinds.length} onPress={() => {
      const hops = Number(maxHops);
      if (!Number.isInteger(hops) || hops < 1 || hops > 64) { setError("Maximum hops must be a whole number between 1 and 64."); return; }
      setError(undefined);
      onRun({ source: source.trim(), target: target.trim(), all, maxHops: hops,
        ...(via.length ? { via: via.map((value) => value.trim()) } : {}),
        relationshipKinds: BEAGLE_PATH_EDGE_KINDS.filter((kind) => kinds.includes(kind)) });
    }}>Find paths</Button>
  </div>;
}

export function BeagleEndpointPicker({ api, projectId, label, value, onChange, disabled }: {
  api: BeagleAPI; projectId: string; label: string; value: string; onChange: (value: string) => void; disabled: boolean;
}) {
  const [results, setResults] = useState<BeagleNode[]>([]);
  const [page, setPage] = useState<BeagleSearchResult["page"]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const sequence = useRef(0);
  const current = useRef({ projectId, value });
  current.current = { projectId, value };
  async function load(offset = 0) {
    const term = value.trim();
    if (!term || disabled) return;
    const request = ++sequence.current;
    setLoading(true); setError(undefined);
    try {
      const response = await api.search({ term, offset });
      if (request !== sequence.current || current.current.projectId !== projectId || current.current.value !== value) return;
      if (!response.ok) throw new Error(response.error);
      if (response.value.projectId !== projectId) return;
      setResults((previous) => offset ? [...new Map([...previous, ...response.value.graph.nodes].map((node) => [node.objectid, node])).values()] : response.value.graph.nodes);
      setPage(response.value.page);
    } catch (cause) { if (request === sequence.current) setError(cause instanceof Error ? cause.message : "Object search failed."); }
    finally { if (request === sequence.current) setLoading(false); }
  }
  useEffect(() => {
    sequence.current++; setPage(undefined); setLoading(false); setError(undefined);
    if (!editing) { setResults((previous) => previous.filter((node) => node.objectid === value)); return; }
    setResults([]);
    if (!value.trim() || disabled) return;
    const timer = window.setTimeout(() => { void load(); }, 250);
    return () => { window.clearTimeout(timer); sequence.current++; };
  }, [value, projectId, editing, disabled]);
  useEffect(() => () => { sequence.current++; }, []);
  return <div className="beagle-endpoint-picker">
    <ComboBox fullWidth allowsCustomValue allowsEmptyCollection inputValue={value} selectedKey={!editing && results.some((node) => node.objectid === value) ? value : null} defaultFilter={() => true}
      isDisabled={disabled} onInputChange={(text) => { if (text !== value) { sequence.current++; setEditing(true); onChange(text); } }}
      onSelectionChange={(key) => { if (key !== null) { sequence.current++; setEditing(false); onChange(String(key)); } }}>
      <Label>{label}</Label><ComboBox.InputGroup><Input placeholder="Search name or object ID" /><ComboBox.Trigger /></ComboBox.InputGroup>
      <ComboBox.Popover className="beagle-endpoint-popover"><ListBox aria-label={`${label} matches`} renderEmptyState={() => <p className="beagle-muted">{loading ? "Searching…" : value.trim() ? "No matches. Enter an exact object ID or another name." : "Type to search directory objects."}</p>}>
        {results.map((node) => <ListBox.Item key={node.objectid} id={node.objectid} textValue={node.objectid}>
          <Label>{nodeName(node)}</Label><span className="beagle-muted">{nodeKind(node)} · {node.objectid}</span><ListBox.ItemIndicator />
        </ListBox.Item>)}
      </ListBox>
      {page && editing ? <div className="beagle-endpoint-more"><span className="beagle-muted">{results.length.toLocaleString()} matches loaded</span>
      {page.hasMore ? <Button size="sm" variant="tertiary" isDisabled={loading || disabled} onPress={() => { void load(page.offset + page.limit); }}>Load more {label.toLowerCase()} matches</Button> : null}</div> : null}
      </ComboBox.Popover>
    </ComboBox>
    {!editing && results.some((node) => node.objectid === value) ? <p className="beagle-muted">{nodeName(results.find((node) => node.objectid === value)!)}</p> : null}
    {error ? <p role="alert" className="text-danger text-sm">{error}</p> : null}
  </div>;
}
