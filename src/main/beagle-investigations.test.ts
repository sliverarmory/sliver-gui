import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BEAGLE_DRILLDOWNS } from "../shared/beagle-investigations.js";
import { buildBeagleNeighborhoodQuery, isBeagleForeignInvestigation, isBeagleTraversalInvestigation, runBeagleForeignInvestigation, runBeagleTraversalInvestigation } from "./beagle-investigations.js";
import type { BeagleJsonObject } from "../shared/beagle-contracts.js";

describe("Beagle investigation query builders", () => {
  it("binds identity and paging for every allowlisted action", () => {
    for (const action of BEAGLE_DRILLDOWNS) {
      if (isBeagleTraversalInvestigation(action.id)) continue;
      const query = buildBeagleNeighborhoodQuery(action.id);
      expect(query.countCypher).toContain("$objectid");
      expect(query.countCypher).toContain(" AS total");
      expect(query.countCypher).not.toContain("$offset");
      expect(query.pageCypher).toMatch(/ORDER BY .* SKIP \$offset LIMIT \$limit$/u);
      if (action.id !== "relationships") {
        expect(query.countCypher).toContain("count(DISTINCT target)");
        expect(query.pageCypher).toContain("head(collect(nodes))");
        expect(query.pageCypher).toContain("head(collect(edges))");
      }
    }
  });

  it("rejects unknown selectors instead of treating them as Cypher fragments", () => {
    for (const value of ["", "MemberOf", "user-member_of RETURN 1", "relationships) DELETE n"]) {
      expect(() => buildBeagleNeighborhoodQuery(value)).toThrow("Unknown Beagle investigation view");
    }
  });

  it("expands nested membership before exactly one controlling edge", () => {
    const incoming = buildBeagleNeighborhoodQuery("user-inbound_object_control").countCypher;
    const outgoing = buildBeagleNeighborhoodQuery("user-outbound_object_control").countCypher;
    expect(incoming).toContain("(controller)<-[:MemberOf*0..]-(target)");
    expect(outgoing).toContain("(root)-[:MemberOf*0..]->(controller)-[:");
    expect(outgoing).toContain("|WriteDacl|");
    expect(outgoing).not.toContain("WriteDACL");
    expect(buildBeagleNeighborhoodQuery("domain-controllers")).toEqual(buildBeagleNeighborhoodQuery("base-inbound_object_control"));
  });

  it("preserves transitive trust, PKI and group membership investigations", () => {
    expect(buildBeagleNeighborhoodQuery("domain-outbound_trusts").countCypher).toContain("SameForestTrust|CrossForestTrust*1..");
    expect(buildBeagleNeighborhoodQuery("group-members").countCypher).toContain("all(n IN nodes(p)[1..-1] WHERE n:Group)");
    expect(buildBeagleNeighborhoodQuery("enterpriseca-pki_hierarchy").countCypher).toContain("UNION");
    expect(buildBeagleNeighborhoodQuery("rootca-pki_hierarchy").countCypher).not.toContain("UNION");
  });

  it("keeps CE's GPO inheritance, linked-container and tier-zero predicates", () => {
    const gpo = buildBeagleNeighborhoodQuery("gpo-tier_zero_objects").countCypher;
    expect(gpo).toContain("[:Contains*0..]");
    expect(gpo).toContain("coalesce(link.enforced, false)");
    expect(gpo).toContain("blocksinheritance");
    expect(gpo).toContain("NOT target:Group");
    expect(gpo).toContain("target:Tag_Tier_Zero");
    expect(buildBeagleNeighborhoodQuery("ou-affecting_gpos").countCypher).toContain("any(n IN nodes(p)[i + 1..] WHERE n:OU)");
  });

  it("routes the 29 CE terminal delegates and two unrestricted foreign traversals through the bounded runner", () => {
    expect(BEAGLE_DRILLDOWNS.filter((entry) => isBeagleTraversalInvestigation(entry.id))).toHaveLength(31);
    expect(isBeagleForeignInvestigation("domain-foreign_admins")).toBe(true);
    expect(isBeagleForeignInvestigation("domain-foreign_gpo_controllers")).toBe(true);
    expect(() => buildBeagleNeighborhoodQuery("domain-foreign_admins")).toThrow("bounded traversal runner");
  });
});

describe("foreign-principal traversal", () => {
  const node = (id: string): BeagleJsonObject => ({ id, labels: ["Base", "Group"], properties: { objectid: id, name: id } });
  const relation = (source: string, target: string): BeagleJsonObject => ({ id: `${source}-${target}`, startNode: source, endNode: target, type: "GenericAll", properties: {} });
  it("follows non-membership edges and counts CE's repeated-visit terminals in converging paths", async () => {
    const nodes = Object.fromEntries(["root", "left", "right", "converged", "leaf", "host"].map((id) => [id, node(id)]));
    const incoming: Record<string, string[]> = { root: ["left", "right"], left: ["converged"], right: ["converged"], converged: ["leaf"], leaf: [] };
    const queries: string[] = [];
    const query = async (cypher: string, parameters: BeagleJsonObject): Promise<BeagleJsonObject[]> => {
      queries.push(cypher);
      if (!parameters["current"]) return [{ source: nodes["root"]!, target: nodes["host"]!, edge: relation("root", "host"), traverse: true, foreign: false }];
      const id = String(parameters["current"]);
      return (incoming[id] ?? []).map((source) => ({ source: nodes[source]!, target: nodes[id]!, edge: relation(source, id) }));
    };
    const first = await runBeagleForeignInvestigation("domain-foreign_admins", "domain", 0, 1, query);
    const second = await runBeagleForeignInvestigation("domain-foreign_admins", "domain", 1, 1, query);
    expect(first.total).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(first.rows[0]?.["target"]).toEqual(nodes["converged"]);
    expect(second.rows[0]?.["target"]).toEqual(nodes["leaf"]);
    expect(second.rows[0]?.["nodes"]).toEqual([nodes["host"], nodes["root"], nodes["right"], nodes["converged"], nodes["leaf"]]);
    expect(second.rows[0]?.["edges"]).toEqual([relation("root", "host"), relation("right", "root"), relation("converged", "right"), relation("leaf", "converged")]);
    expect(second.hasMore).toBe(false);
    expect(queries.some((cypher) => cypher.includes("MATCH (source)-[edge]->(target)"))).toBe(true);
  });

  it("fails rather than presenting a partial count when its resource budget is exceeded", async () => {
    await expect(runBeagleForeignInvestigation("domain-foreign_admins", "domain", 0, 100,
      async () => [{ source: node("group"), target: node("host"), edge: relation("group", "host"), traverse: true, foreign: false }],
      { nodes: 0, edges: 100, depth: 100, milliseconds: 1_000 },
    )).rejects.toThrow("no partial result");
  });

  it("bounds parent-linked evidence even when several controlling groups reuse cached adjacency", async () => {
    const incoming: Record<string, string[]> = { first: ["branch"], second: ["branch"], branch: ["left", "right"] };
    let fetchedEdges = 0;
    const query = async (_cypher: string, parameters: BeagleJsonObject): Promise<BeagleJsonObject[]> => {
      const current = parameters["current"];
      const rows = !current
        ? ["first", "second"].map((id) => ({ source: node(id), target: node("host"), edge: relation(id, "host"), traverse: true, foreign: false }))
        : (incoming[String(current)] ?? []).map((id) => ({ source: node(id), target: node(String(current)), edge: relation(id, String(current)) }));
      fetchedEdges += rows.length;
      return rows;
    };
    await expect(runBeagleForeignInvestigation("domain-foreign_admins", "domain", 0, 1, query,
      { nodes: 20, edges: 7, depth: 20, milliseconds: 1_000 },
    )).rejects.toThrow("no partial result");
    // Six distinct fetched edges produce eight traversal records across the
    // two roots. The independent record budget also bounds cached replays.
    expect(fetchedEdges).toBe(6);
  });
});

// Explicit native regression mode; normal unit runs do not require a platform binary.
const nativeBinary = process.env["SLIVER_BEAGLE_BINARY"];
it.skipIf(!nativeBinary)("executes bounded transitive investigations with real graph evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "beagle-investigations-"));
  const database = join(directory, "graph.db");
  const input = join(directory, "graph.json");
  const node = (id: string, kind: string, properties: Record<string, unknown> = {}) => ({ objectid: id, labels: ["Base", kind], properties: { objectid: id, name: id, ...properties } });
  const edge = (source: string, target: string, kind: string, properties: Record<string, unknown> = {}) => ({ source, target, kind, properties, derived: false });
  const graph = {
    nodes: [node("u", "User"), node("nested", "Group"), node("outer", "Group"), node("host", "Computer"),
      node("sql", "Computer"), node("controlled", "OU"), node("second-control", "OU"), node("write-dacl-only", "OU"),
      node("gpo", "GPO"), node("enforced", "GPO"), node("blocking", "OU", { blocksinheritance: true }),
      node("child", "OU"), node("direct", "User"), node("descendant", "User"),
      node("diamond", "User"), node("left", "Computer"), node("right", "Computer"), node("middle", "Computer"), node("leaf", "Computer"),
      node("cycle-root", "User"), node("cycle-next", "Computer")],
    edges: [edge("u", "nested", "MemberOf"), edge("nested", "outer", "MemberOf"), edge("outer", "host", "AdminTo"),
      edge("outer", "controlled", "GenericAll"), edge("controlled", "second-control", "GenericAll"), edge("outer", "write-dacl-only", "WriteDacl"),
      edge("host", "u", "HasSession"), edge("u", "host", "SQLAdmin"), edge("host", "sql", "SQLAdmin"),
      edge("gpo", "blocking", "GPLink", { enforced: false }), edge("enforced", "blocking", "GPLink", { enforced: true }),
      edge("blocking", "child", "Contains"), edge("blocking", "direct", "Contains"), edge("child", "descendant", "Contains"),
      edge("diamond", "left", "SQLAdmin"), edge("diamond", "right", "SQLAdmin"), edge("left", "middle", "SQLAdmin"), edge("right", "middle", "SQLAdmin"), edge("middle", "leaf", "SQLAdmin"),
      edge("cycle-root", "cycle-next", "SQLAdmin"), edge("cycle-next", "cycle-root", "SQLAdmin")],
  };
  try {
    writeFileSync(input, JSON.stringify(graph));
    execFileSync(nativeBinary!, ["--db", database, "import-snapshot", input], { timeout: 10_000 });
    const execute = (cypher: string, objectid: string, offset = 0, limit = 100) => JSON.parse(execFileSync(nativeBinary!, ["--db", database, "query", "--params", JSON.stringify({ objectid, offset, limit }), "--", cypher], { encoding: "utf8", timeout: 10_000 })) as { rows: Record<string, unknown>[] };
    const targets = async (view: string, id: string, offset = 0, limit = 100) => {
      const result = isBeagleTraversalInvestigation(view)
        ? await runBeagleTraversalInvestigation(view, id, offset, limit, async (cypher, parameters) =>
          JSON.parse(execFileSync(nativeBinary!, ["--db", database, "query", "--params", JSON.stringify(parameters), "--", cypher], { encoding: "utf8", timeout: 10_000 })).rows as BeagleJsonObject[])
        : execute(buildBeagleNeighborhoodQuery(view).pageCypher, id, offset, limit);
      for (const row of result.rows) {
        const nodes = row["nodes"] as { properties: { objectid: string } }[];
        const edges = row["edges"] as { startNode: unknown; endNode: unknown; type: string }[];
        expect(nodes.length).toBeGreaterThan(1);
        expect(edges).toHaveLength(nodes.length - 1);
        expect(edges.every((relationship) => typeof relationship.type === "string")).toBe(true);
      }
      return result.rows.map((row) => (row["target"] as { properties: { objectid: string } }).properties.objectid);
    };
    expect(await targets("user-member_of", "u")).toEqual(["nested", "outer"]);
    expect(await targets("user-member_of", "u", 1, 1)).toEqual(["outer"]);
    expect(await targets("user-local_admin_privileges", "u")).toEqual(["host"]);
    expect(await targets("computer-local_admins", "host")).toEqual(["u"]);
    expect(await targets("user-outbound_object_control", "u")).toEqual(["controlled", "write-dacl-only"]);
    expect(await targets("group-sessions", "outer")).toEqual(["host"]);
    expect(await targets("user-sql_admin_rights", "u")).toEqual(["sql"]);
    // Pinned CE AcyclicTraverseTerminals collects a globally revisited node;
    // the former per-path terminal predicate missed middle and the root cycle.
    expect(await targets("user-sql_admin_rights", "diamond")).toEqual(["leaf", "middle"]);
    expect(await targets("user-sql_admin_rights", "diamond", 1, 1)).toEqual(["middle"]);
    expect(await targets("user-sql_admin_rights", "cycle-root")).toEqual(["cycle-root"]);
    expect(await targets("gpo-users", "gpo")).toEqual(["direct"]);
    expect(await targets("gpo-users", "enforced")).toEqual(["descendant", "direct"]);
    expect(await targets("gpo-ous", "gpo")).toEqual(["blocking"]);
    expect(await targets("ou-affecting_gpos", "child")).toEqual(["enforced"]);
    expect(execute(buildBeagleNeighborhoodQuery("user-member_of").countCypher, "u").rows).toEqual([{ total: 2 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
