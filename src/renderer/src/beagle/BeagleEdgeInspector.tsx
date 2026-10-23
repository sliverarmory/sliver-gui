import { useEffect, useRef, useState } from "react";
import { Button, Chip, Disclosure } from "@heroui/react";
import type { BeagleAPI, BeagleEdge, BeagleJsonObject, BeagleQueryResult } from "../../../shared/beagle-contracts";
import { BEAGLE_PATH_EDGE_CATEGORIES } from "../../../shared/beagle-investigations";
import { displayValue, nodeName } from "./beagle-model";

const relayKinds = new Set(["CoerceAndRelayNTLMToSMB", "CoerceAndRelayNTLMToLDAP", "CoerceAndRelayNTLMToLDAPS", "CoerceAndRelayNTLMToADCS"]);
const explanations: Record<string, string> = {
  MemberOf: "The source is a direct member of the target group. Nested membership may extend the group's permissions to the source.",
  HasSession: "The source computer has a collected session for the target identity. Session evidence is time sensitive; the session may no longer exist.",
  GenericAll: "The source has broad control over the target object. The available actions depend on whether the target is a user, group, computer, policy, or certificate object.",
  GenericWrite: "The source can write selected properties of the target. Inspect the object type and effective attributes to understand the resulting control.",
  WriteDacl: "The source can change the target's discretionary access control list and may be able to grant additional rights.",
  WriteOwner: "The source can change the target's owner. Ownership and effective owner rights determine whether further permission changes are possible.",
  Owns: "The source owns the target. Owner rights may permit changes to its permissions; inspect any owner-rights restrictions.",
  ForceChangePassword: "The source has the right to reset the target's password without knowing the current password.",
  AddMember: "The source can modify the target group's membership.",
  AddSelf: "The source can add itself to the target group under the validated self-membership right.",
  AdminTo: "The source has collected local administrator rights on the target computer, directly or through group membership.",
  CanRDP: "The source has collected remote desktop access rights. Logon policy, deny rights, and service reachability still determine effective access.",
  CanPSRemote: "The source has collected PowerShell remoting rights. The endpoint configuration and service reachability still apply.",
  ExecuteDCOM: "The source has collected DCOM execution rights. Effective access depends on the target's configuration and available COM objects.",
  SQLAdmin: "The source has administrative rights in SQL Server on the target. Server configuration determines any further operating-system access.",
  DCSync: "The source has the combination of directory replication rights needed to request domain credential data.",
  ReadLAPSPassword: "The source can read a collected LAPS-managed local administrator password attribute. Password rotation and encryption policy affect its usefulness.",
  ReadGMSAPassword: "The source can retrieve the target group managed service account's managed password.",
  Contains: "The source directory container contains the target. Containment describes hierarchy; effective inherited rights depend on ACL protection and inheritance flags.",
  GPLink: "The source group policy object is linked to the target directory scope. Link enablement, enforcement, blocking, and filtering affect its application.",
  AllowedToAct: "The source is allowed by the target's resource-based constrained delegation configuration to act on its behalf.",
  AllowedToDelegate: "The source has constrained delegation rights to a service associated with the target. Service principal names and delegation restrictions determine scope.",
};
const familyGuidance: Record<string, string> = {
  "object-control": "Review the exact ACL or writable attribute, the target's object type, inherited permissions, and any explicit restrictions before treating this as effective control.",
  execution: "Review group membership and collected local access rights. Confirm the target service, logon restrictions, and collection age; a graph edge does not test live connectivity.",
  membership: "Follow membership and identity evidence to determine which security context receives the target's effective permissions.",
  delegation: "Inspect composition and relevant account configuration. Relay and delegation depend on protocol protections, authentication prerequisites, and the target service.",
  credentials: "Review the source's effective rights and the target's credential management settings. Collection evidence can become stale after permissions or credentials change.",
  adcs: "Inspect composition to see the certificate template, CA, account, and configuration evidence. Enrollment rights and issuance requirements determine the effective certificate path.",
  directory: "Inspect directory hierarchy and trust direction. Trust attributes, selective authentication, SID filtering, and policy scope can restrict the apparent route.",
};
export function edgeGuidance(kind: string): { explanation: string; review: string; reference?: string } {
  const family = BEAGLE_PATH_EDGE_CATEGORIES.find((category) => category.kinds.includes(kind));
  const explanation = explanations[kind] ?? (relayKinds.has(kind)
    ? `This derived ${kind.replace("CoerceAndRelayNTLMTo", "")} relationship combines authentication coercion and NTLM relay prerequisites. Inspect its supporting composition and candidate relay targets.`
    : kind.startsWith("ADCSESC") ? `This derived ${kind} relationship represents an AD CS escalation condition. Its composition identifies the specific objects and prerequisites used by analysis.`
      : family ? `${kind} is a ${family.label.toLowerCase()} relationship. The direction runs from the source identity or object to the target.`
        : "No built-in interpretation is available for this relationship type. Inspect its collected properties and supporting graph before drawing a conclusion.");
  return { explanation, review: familyGuidance[family?.id ?? ""] ?? "Check the collection source, relationship direction, and current configuration of both endpoints.",
    ...(family ? { reference: `https://github.com/SpecterOps/BloodHound/tree/1759e1638435595def27eb3ff3c5a6fc32832ddc/packages/javascript/bh-shared-ui/src/components/HelpTexts/${encodeURIComponent(kind)}` } : {}) };
}
export function BeagleProperties({ values }: { values: BeagleJsonObject }) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? <dl className="beagle-properties">{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}</dl> : <p className="beagle-muted">No additional properties.</p>;
}
export function BeagleEdgeInspector({ edge, result, api, disabled, onOpen, onInspectObject }: {
  edge: BeagleEdge; result: BeagleQueryResult; api: BeagleAPI; disabled: boolean;
  onOpen: (value: BeagleQueryResult, title: string) => void; onInspectObject: (objectid: string) => void;
}) {
  const [details, setDetails] = useState<{ title: string; value: BeagleQueryResult }>();
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  useEffect(() => { sequence.current++; setDetails(undefined); setError(undefined); setLoading(undefined); return () => { sequence.current++; }; }, [edge.id, result.projectId]);
  const source = result.graph.nodes.find((node) => node.objectid === edge.source);
  const target = result.graph.nodes.find((node) => node.objectid === edge.target);
  const guidance = edgeGuidance(edge.kind);
  async function load(action: "compose" | "relayTargets" | "aclOrigins", title: string) {
    const request = ++sequence.current;
    setLoading(title); setError(undefined); setDetails(undefined);
    try {
      const response = await api[action]({ source: edge.source, target: edge.target, kind: edge.kind });
      if (request !== sequence.current) return;
      if (!response.ok) throw new Error(response.error);
      if (response.value.projectId !== result.projectId) throw new Error("The active project changed. Select the relationship again.");
      setDetails({ title, value: response.value });
    } catch (cause) { if (request === sequence.current) setError(cause instanceof Error ? cause.message : "Relationship details failed."); }
    finally { if (request === sequence.current) setLoading(undefined); }
  }
  const inherited = edge.properties["isacl"] === true && edge.properties["isinherited"] === true && typeof edge.properties["inheritancehash"] === "string" && Boolean(edge.properties["inheritancehash"]);
  return <>
    <h3 className="beagle-edge-kind">{edge.kind}</h3><Chip size="sm" variant="soft">{edge.derived === true ? "Derived relationship" : edge.derived === false ? "Collected relationship" : "Relationship"}</Chip>
    <div className="beagle-edge-endpoints"><Button variant="ghost" onPress={() => onInspectObject(edge.source)}>{source ? nodeName(source) : edge.source}</Button><span aria-hidden="true">→</span><Button variant="ghost" onPress={() => onInspectObject(edge.target)}>{target ? nodeName(target) : edge.target}</Button></div>
    <section className="beagle-edge-guidance"><h3 className="beagle-section-label">Meaning and investigation</h3><p>{guidance.explanation}</p><p>{guidance.review}</p>
      {guidance.reference ? <a href={guidance.reference} target="_blank" rel="noreferrer">BloodHound CE relationship reference</a> : null}</section>
    <Disclosure><Disclosure.Heading><Button slot="trigger" size="sm" variant="tertiary">Relationship properties<Disclosure.Indicator /></Button></Disclosure.Heading><Disclosure.Content><Disclosure.Body><BeagleProperties values={edge.properties} /></Disclosure.Body></Disclosure.Content></Disclosure>
    <h3 className="beagle-section-label">Supporting evidence</h3>
    <div className="beagle-edge-actions"><Button size="sm" variant="secondary" isDisabled={disabled || Boolean(loading)} onPress={() => { void load("compose", "Composition"); }}>Show composition</Button>
      {relayKinds.has(edge.kind) ? <Button size="sm" variant="secondary" isDisabled={disabled || Boolean(loading)} onPress={() => { void load("relayTargets", "Relay targets"); }}>Show relay targets</Button> : null}
      {inherited ? <Button size="sm" variant="secondary" isDisabled={disabled || Boolean(loading)} onPress={() => { void load("aclOrigins", "ACL origins"); }}>Show ACL origins</Button> : null}</div>
    {loading ? <p role="status" className="beagle-muted">Loading {loading.toLowerCase()}…</p> : null}
    {error ? <p role="alert" className="text-danger text-sm">{error}</p> : null}
    {details ? <section className="beagle-composition"><h3>{details.title}</h3><p>{details.value.graph.nodes.length} objects · {details.value.graph.edges.length} relationships</p>
      {details.value.truncated ? <p role="status" className="beagle-limit-warning">Evidence reached a display limit. This is a partial result.</p> : null}
      {details.value.graph.nodes.slice(0, 50).map((node) => <Button key={node.objectid} variant="ghost" size="sm" onPress={() => onInspectObject(node.objectid)}>{nodeName(node)}</Button>)}
      {details.value.graph.nodes.length > 50 ? <p className="beagle-muted">Showing the first 50 names. Open the graph to inspect all returned objects.</p> : null}
      {details.value.graph.nodes.length ? <Button size="sm" variant="secondary" onPress={() => onOpen(details.value, `${edge.kind} ${details.title.toLowerCase()}`)}>Open {details.title.toLowerCase()} graph</Button> : <p className="beagle-muted">No supporting evidence was returned.</p>}
    </section> : null}
  </>;
}
