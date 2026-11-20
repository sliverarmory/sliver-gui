import { BEAGLE_DRILLDOWNS } from "../shared/beagle-investigations.js";
import type { BeagleJsonObject } from "../shared/beagle-contracts.js";

/** CE v9.8.0 (1759e163): packages/go/analysis/ad/{queries,filters}.go.
 * These queries select distinct investigation targets, not graph node counts.
 * One shortest qualifying evidence path is returned per target. Pagination is
 * applied after target grouping; intermediate evidence nodes do not consume it.
 */
export interface BeagleNeighborhoodQuery {
  countCypher: string;
  pageCypher: string;
}

export const isBeagleForeignInvestigation = (view: string): boolean => view === "domain-foreign_admins" || view === "domain-foreign_gpo_controllers";

const ACL = "AllExtendedRights|ForceChangePassword|AddMember|AddAllowedToAct|GenericAll|WriteDacl|WriteOwner|GenericWrite|ReadLAPSPassword|ReadGMSAPassword|Owns|AddSelf|WriteSPN|AddKeyCredentialLink|GetChanges|GetChangesAll|GetChangesInFilteredSet|WriteAccountRestrictions|WriteGPLink|SyncLAPSPassword|DCSync|ManageCertificates|ManageCA|Enroll|WritePKIEnrollmentFlag|WritePKINameFlag|WriteOwnerLimitedRights|OwnsLimitedRights|WriteAltSecurityIdentities|WritePublicInformation";
const PKI_IN = "EnterpriseCAFor|HostsCAService|IssuedSignedBy";
const PKI_OUT = "EnterpriseCAFor|TrustedForNTAuth|IssuedSignedBy|RootCAFor|NTAuthStoreFor";
const ADCS = "GoldenCert|ADCSESC1|ADCSESC3|ADCSESC4|ADCSESC6a|ADCSESC6b|ADCSESC9a|ADCSESC9b|ADCSESC10a|ADCSESC10b";
const ROOT = "MATCH (root {objectid: $objectid})";
const ACYCLIC = "all(n IN nodes(p) WHERE single(m IN nodes(p) WHERE m = n))";
const TIER_ZERO = "(target:Tag_Tier_Zero OR coalesce(target.system_tags, '') CONTAINS 'admin_tier_0')";

interface Branch { match: string; where?: string; nodes?: string; edges?: string }
const branch = (match: string, where?: string): Branch => ({ match, ...(where ? { where } : {}) });
const out = (kinds: string, where?: string): Branch => branch(`MATCH p=(root)-[:${kinds}*1..]->(target)`, where);
const incoming = (kinds: string, where?: string): Branch => branch(`MATCH p=(root)<-[:${kinds}*1..]-(target)`, where);
const interior = (predicate: string): string => `all(n IN nodes(p)[1..-1] WHERE ${predicate})`;

interface TerminalPlan {
  kinds: string;
  direction: "in" | "out";
  branchKind?: string;
  stopKinds?: readonly string[];
  resultKind?: string;
  resultEdge?: string;
}

/** Mirrors the pinned CE delegates using ops.AcyclicTraverseTerminals. */
function terminalPlan(view: string): TerminalPlan | undefined {
  const privileges = [
    ["local_admin_privileges", "AdminTo"], ["rdp_privileges", "CanRDP"],
    ["psremote_rights", "CanPSRemote"], ["psremote_privileges", "CanPSRemote"], ["dcom_privileges", "ExecuteDCOM"],
  ] as const;
  for (const [suffix, kind] of privileges) if (view.endsWith(`-${suffix}`)) {
    return { kinds: `MemberOf|${kind}`, direction: "out", stopKinds: ["Computer"], resultKind: "Computer" };
  }
  const inbound = new Map([
    ["computer-local_admins", "AdminTo"], ["computer-rdp_users", "CanRDP"],
    ["computer-psremote_users", "CanPSRemote"], ["computer-dcom_users", "ExecuteDCOM"],
  ]);
  if (inbound.has(view)) return { kinds: `MemberOf|${inbound.get(view)}`, direction: "in", stopKinds: ["User", "Computer"] };
  switch (view) {
    case "computer-sql_admin_users": return { kinds: "SQLAdmin", direction: "in" };
    case "user-sql_admin_rights": return { kinds: "SQLAdmin", direction: "out" };
    // Despite the CE panel's "Users" label, its endpoint is outbound rights.
    case "computer-constrained_delegation_users":
    case "user-constrained_delegation_privileges": return { kinds: "AllowedToDelegate", direction: "out" };
    case "computer-sessions": return { kinds: "HasSession", direction: "out" };
    case "user-sessions": return { kinds: "HasSession", direction: "in" };
    case "group-sessions": return { kinds: "MemberOf|HasSession", direction: "in", resultKind: "Computer", resultEdge: "HasSession" };
    case "site-linked_gpos": return { kinds: "GPLink", direction: "in", branchKind: "GPO" };
    case "site-linked_siteservers": return { kinds: "Contains", direction: "out", resultKind: "SiteServer" };
    case "site-linked_sitesubnets": return { kinds: "Contains", direction: "out", resultKind: "SiteSubnet" };
    case "ou-users": return { kinds: "Contains", direction: "out", resultKind: "User" };
    case "ou-computers": return { kinds: "Contains", direction: "out", resultKind: "Computer" };
    case "ou-groups": return { kinds: "Contains", direction: "out", resultKind: "Group" };
    default: return undefined;
  }
}

export const isBeagleTraversalInvestigation = (view: string): boolean =>
  BEAGLE_DRILLDOWNS.some((entry) => entry.id === view) && (isBeagleForeignInvestigation(view) || terminalPlan(view) !== undefined);

function objectControl(inbound: boolean): Branch {
  // One ACL edge only; membership may precede it, never follow it.
  return branch(inbound
    ? `MATCH p=(root)<-[:${ACL}]-(controller)<-[:MemberOf*0..]-(target)`
    : `MATCH p=(root)-[:MemberOf*0..]->(controller)-[:${ACL}]->(target)`);
}

function gpoAffected(kind: string): Branch {
  const candidate = kind === "tier_zero_objects" ? `(NOT target:Group) AND ${TIER_ZERO}`
    : kind === "ous" ? "(target:OU OR target:Domain)" : `target:${kind === "users" ? "User" : "Computer"}`;
  // CE includes the linked container itself. Its descent gate blocks OU->OU
  // transitions from a blocking OU; it does not block that OU's direct users.
  return branch("MATCH p=(root)-[link:GPLink]->(linked)-[:Contains*0..]->(target)",
    `(linked:Domain OR linked:OU OR linked:Site) AND ${candidate} AND ` +
    "(coalesce(link.enforced, false) OR all(i IN range(2, length(p)) WHERE NOT ('OU' IN labels(nodes(p)[i]) AND 'OU' IN labels(nodes(p)[i - 1]) AND coalesce(nodes(p)[i - 1].blocksinheritance, false))))");
}

function branchesFor(view: string): Branch[] {
  if (view.endsWith("-inbound_object_control") || view === "domain-controllers") return [objectControl(true)];
  if (view.endsWith("-outbound_object_control")) return [objectControl(false)];
  if (view.endsWith("-member_of")) return [out("MemberOf")];
  if (view === "group-members") return [incoming("MemberOf", interior("n:Group"))];
  switch (view) {
    case "domain-inbound_trusts": return [incoming("SameForestTrust|CrossForestTrust", "target:Domain")];
    case "domain-outbound_trusts": return [out("SameForestTrust|CrossForestTrust", "target:Domain")];
    case "domain-adcs_escalations": return [incoming(ADCS)];
    case "domain-foreign_users":
    case "domain-foreign_groups": return [branch(`MATCH p=(target:${view.endsWith("users") ? "User" : "Group"})-[:MemberOf*1..]->(local:Group)`,
      "local.domainsid = coalesce(root.domainsid, root.objectid) AND target.domainsid <> coalesce(root.domainsid, root.objectid)")];
    case "rootca-pki_hierarchy": return [incoming(PKI_IN)];
    case "aiaca-pki_hierarchy":
    case "enterpriseca-pki_hierarchy": return [incoming(PKI_IN), out(PKI_OUT)];
    case "enterpriseca-published_templates": return [incoming("PublishedTo")];
    case "certtemplate-published_to_cas": return [out("PublishedTo")];
    case "ntauthstore-trusted_cas": return [incoming("TrustedForNTAuth")];
    case "issuancepolicy-linked_certificate_templates": return [incoming("ExtendedByPolicy", "all(n IN nodes(p)[1..] WHERE n:CertTemplate)")];
    case "gpo-sites": return [branch("MATCH p=(root)-[:GPLink]->(target:Site)")];
    case "gpo-ous": return [gpoAffected("ous")];
    case "gpo-computers": return [gpoAffected("computers")];
    case "gpo-users": return [gpoAffected("users")];
    case "gpo-tier_zero_objects": return [gpoAffected("tier_zero_objects")];
    case "ou-affecting_gpos": return [branch("MATCH p=(target:GPO)-[link:GPLink]->(linked)-[:Contains*0..]->(root)",
      "all(n IN nodes(p)[1..] WHERE n:OU OR n:Domain OR n:Site) AND (coalesce(link.enforced, false) OR all(i IN range(1, length(p) - 1) WHERE NOT (coalesce(nodes(p)[i].blocksinheritance, false) AND any(n IN nodes(p)[i + 1..] WHERE n:OU))))")];
    default: throw new TypeError("Unknown Beagle investigation view");
  }
}

function matchBranch(value: Branch): string {
  const patterns = value.match.split("\n").filter((line) => line.startsWith("MATCH ")).join("\n");
  const variables = new Set(["root", "target", "p", ...Array.from(patterns.matchAll(/[(\[]([a-z][a-zA-Z0-9_]*)(?=[:)\] ])/gu), (match) => match[1]!)]);
  const materializeTrail = value.where?.includes("trail") ? `\nWITH ${Array.from(variables).join(", ")}, nodes(p) AS trail` : "";
  return `${ROOT}\n${value.match}${materializeTrail}\nWHERE target <> root AND ${ACYCLIC}${value.where ? ` AND (${value.where})` : ""}`;
}

export function buildBeagleNeighborhoodQuery(view: string): BeagleNeighborhoodQuery {
  if (!BEAGLE_DRILLDOWNS.some((entry) => entry.id === view)) throw new TypeError("Unknown Beagle investigation view");
  if (isBeagleTraversalInvestigation(view)) throw new TypeError("This investigation requires the bounded traversal runner");
  if (view === "relationships") {
    const match = `${ROOT}\nMATCH (root)-[edge]-(target)`;
    return {
      countCypher: `${match}\nRETURN count(DISTINCT edge) AS total`,
      pageCypher: `${match}\nWITH DISTINCT root, edge, target\nRETURN root, edge, target ORDER BY type(edge), target.objectid, id(edge) SKIP $offset LIMIT $limit`,
    };
  }
  const branches = branchesFor(view);
  const selection = branches.length === 1 ? matchBranch(branches[0]!) :
    `CALL {\n${branches.map((value) => `${matchBranch(value)}\nRETURN target`).join("\nUNION\n")}\n}`;
  const evidence = branches.length === 1 ? `${matchBranch(branches[0]!)}\nWITH target, nodes(p) AS nodes, relationships(p) AS edges, length(p) AS depth` :
    `CALL {\n${branches.map((value) => `${matchBranch(value)}\nRETURN target, ${value.nodes ?? "nodes(p)"} AS nodes, ${value.edges ?? "relationships(p)"} AS edges, length(p) AS depth`).join("\nUNION\n")}\n}`;
  return {
    countCypher: `${selection}\nRETURN count(DISTINCT target) AS total`,
    // Aggregate entity lists rather than paths: this native engine serializes
    // head(collect(path)) as numeric IDs, losing the metadata needed by the UI.
    pageCypher: `${evidence}\nWITH target, nodes, edges, depth ORDER BY depth, [n IN nodes | n.objectid], [r IN edges | type(r)]\n` +
      "WITH target, head(collect(nodes)) AS nodes, head(collect(edges)) AS edges\n" +
      "RETURN target, nodes, edges ORDER BY target.name, target.objectid SKIP $offset LIMIT $limit",
  };
}

type InvestigationQuery = (cypher: string, parameters: BeagleJsonObject) => Promise<BeagleJsonObject[]>;
interface Evidence { id: string; node: BeagleJsonObject; parent?: Evidence; edge?: BeagleJsonObject; depth: number }
interface TraversalLimits { nodes: number; edges: number; depth: number; milliseconds: number }
const TRAVERSAL_LIMITS: TraversalLimits = { nodes: 20_000, edges: 100_000, depth: 4_096, milliseconds: 30_000 };

function record(value: unknown): BeagleJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Beagle traversal entity");
  return value as BeagleJsonObject;
}
function identity(node: BeagleJsonObject): string {
  const id = record(node["properties"])["objectid"];
  if (typeof id !== "string" || !id) throw new Error("Invalid Beagle traversal identity");
  return id;
}

/**
 * CE's foreign delegates traverse any incoming edge through Groups or foreign
 * nodes, with a global visited set per controlling Group. Cypher enumeration of
 * every valid path is exponential on cyclic ACL graphs. Read bounded adjacency
 * pages instead and run the same visited/terminal algorithm in main. Hitting a
 * resource limit errors the whole request; no partial count is presented.
 */
export async function runBeagleTraversalInvestigation(
  view: string, objectid: string, offset: number, limit: number, query: InvestigationQuery,
  limits: TraversalLimits = TRAVERSAL_LIMITS,
): Promise<{ rows: BeagleJsonObject[]; total: number; hasMore: boolean }> {
  if (!isBeagleTraversalInvestigation(view)) throw new TypeError("Unknown traversal investigation");
  const plan = terminalPlan(view);
  const startedAt = performance.now();
  const gpo = view === "domain-foreign_gpo_controllers";
  const kinds = gpo ? ACL : "AdminTo";
  const destination = gpo ? "GPO" : "Computer";
  const domain = "coalesce(root.domainsid, root.objectid)";
  const seedsQuery = `${ROOT}\nMATCH (source)-[edge:${kinds}]->(target:${destination})\n` +
    `WHERE target.domainsid = ${domain} AND (source:Group OR source.domainsid <> ${domain})\n` +
    `RETURN source, edge, target, source:Group AS traverse, source.domainsid <> ${domain} AS foreign ORDER BY id(edge) SKIP $offset LIMIT $limit`;
  const adjacencyQuery = plan
    ? `MATCH (target {objectid:$current})\nMATCH ${plan.direction === "in" ? `(source)-[edge:${plan.kinds}]->(target)` : `(target)-[edge:${plan.kinds}]->(source)`}\n` +
      `${plan.branchKind ? `WHERE source:${plan.branchKind}\n` : ""}RETURN source, edge, target ORDER BY id(edge) SKIP $offset LIMIT $limit`
    : `${ROOT}\nMATCH (target {objectid:$current})\nMATCH (source)-[edge]->(target)\n` +
      `WHERE source:Group OR source.domainsid <> ${domain}\nRETURN source, edge, target ORDER BY id(edge) SKIP $offset LIMIT $limit`;
  let edgeCount = 0;
  let evidenceCount = 0;
  let visitedCount = 0;
  const check = (): void => {
    if (edgeCount > limits.edges || evidenceCount > limits.edges || visitedCount > limits.nodes || performance.now() - startedAt > limits.milliseconds) {
      throw new Error("Beagle investigation exceeded its traversal resource limit; no partial result was returned");
    }
  };
  const pages = async (cypher: string, current?: string): Promise<BeagleJsonObject[]> => {
    const rows: BeagleJsonObject[] = [];
    for (let skip = 0; ; skip += 100) {
      check();
      const page = await query(cypher, { objectid, offset: skip, limit: 100, ...(current ? { current } : {}) });
      edgeCount += page.length;
      check();
      rows.push(...page);
      if (page.length < 100) return rows;
    }
  };
  const results = new Map<string, Evidence>();
  const cache = new Map<string, BeagleJsonObject[]>();
  const traversedGroups = new Set<string>();
  const add = (evidence: Evidence): void => {
    const previous = results.get(evidence.id);
    if (!previous || evidence.depth < previous.depth) results.set(evidence.id, evidence);
  };
  const extend = (node: BeagleJsonObject, edge: BeagleJsonObject, parent: Evidence): Evidence => {
    // A shared parent link costs one record per traversal step. Copying full
    // paths here makes a deep chain followed by a wide fan-out quadratic.
    evidenceCount++;
    check();
    const depth = parent.depth + 1;
    if (depth > limits.depth) throw new Error("Beagle investigation exceeded its traversal depth limit; no partial result was returned");
    return { id: identity(node), node, parent, edge, depth };
  };
  const seeds = plan ? await query(`${ROOT}\nRETURN root`, { objectid }) : await pages(seedsQuery);
  const hasKind = (node: BeagleJsonObject, kind: string): boolean => Array.isArray(node["labels"]) && node["labels"].includes(kind);
  for (const seed of seeds) {
    const source = record(seed[plan ? "root" : "source"]);
    const id = identity(source);
    const initial: Evidence = plan ? { id, node: source, depth: 0 }
      : extend(source, record(seed["edge"]), { id: identity(record(seed["target"])), node: record(seed["target"]), depth: -1 });
    if (!plan && seed["foreign"] === true) add(initial);
    if ((!plan && seed["traverse"] !== true) || traversedGroups.has(id)) continue;
    traversedGroups.add(id);
    const visited = new Set<string>();
    const stack: Evidence[] = [initial];
    while (stack.length) {
      check();
      const current = stack.pop()!;
      let children: BeagleJsonObject[] = [];
      if (!visited.has(current.id)) {
        visited.add(current.id);
        visitedCount++;
        check();
        // CE's descent filter rejects every child of a stop-kind node after
        // the root. The current node then becomes a terminal.
        if (!(current.depth > 0 && plan?.stopKinds?.some((kind) => hasKind(current.node, kind)))) {
          const cached = cache.get(current.id);
          if (cached) children = cached;
          else { children = await pages(adjacencyQuery, current.id); cache.set(current.id, children); }
        }
      }
      if (!children.length && current.depth > 0 && (!plan?.resultKind || hasKind(current.node, plan.resultKind)) &&
        (!plan?.resultEdge || current.edge?.["type"] === plan.resultEdge)) add(current);
      for (const child of children) {
        const node = record(child["source"]);
        stack.push(extend(node, record(child["edge"]), current));
      }
    }
  }
  const ordered = [...results.values()].sort((left, right) => {
    const a = record(left.node["properties"])["name"];
    const b = record(right.node["properties"])["name"];
    const nameA = typeof a === "string" ? a : "\uffff";
    const nameB = typeof b === "string" ? b : "\uffff";
    return nameA < nameB ? -1 : nameA > nameB ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return {
    rows: ordered.slice(offset, offset + limit).map((value) => {
      const nodes: BeagleJsonObject[] = [];
      const edges: BeagleJsonObject[] = [];
      for (let current: Evidence | undefined = value; current; current = current.parent) {
        nodes.push(current.node);
        if (current.edge) edges.push(current.edge);
      }
      return { target: value.node, nodes: nodes.reverse(), edges: edges.reverse() };
    }),
    total: ordered.length, hasMore: offset + limit < ordered.length,
  };
}

/** Compatibility entry point for the two foreign-principal delegates. */
export async function runBeagleForeignInvestigation(
  view: string, objectid: string, offset: number, limit: number, query: InvestigationQuery, limits: TraversalLimits = TRAVERSAL_LIMITS,
): Promise<{ rows: BeagleJsonObject[]; total: number; hasMore: boolean }> {
  if (!isBeagleForeignInvestigation(view)) throw new TypeError("Unknown foreign-principal investigation");
  return runBeagleTraversalInvestigation(view, objectid, offset, limit, query, limits);
}
