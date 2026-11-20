// @vitest-environment node
import { expect, it } from "vitest";
import { buildBeagleAclOriginsQuery } from "./beagle-edge-details.js";

it("binds the edge identity and uses stored inheritance evidence", () => {
  const result = buildBeagleAclOriginsQuery({ source: "quoted' source", target: "target", kind: "GenericAll" });
  expect(result.parameters).toEqual({ source: "quoted' source", target: "target", kind: "GenericAll" });
  expect(result.cypher).not.toContain("quoted' source");
  expect(result.cypher).toContain("acl.inheritancehash IN coalesce(origin.inheritancehashes, [])");
  expect(result.cypher).toContain("nodes(p)[1..] WHERE NOT coalesce(n.isaclprotected, false)");
});
