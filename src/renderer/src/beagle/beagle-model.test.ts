import { beforeEach, describe, expect, it } from "vitest";
import { nodeKind, nodeName, nodeTagged, parseParameters, readCustomQueries, saveCustomQueries } from "./beagle-model";

beforeEach(() => localStorage.clear());
describe("AD graph presentation", () => {
  it("uses typed labels and property names while preserving object identity", () => {
    const node = { objectid: "S-1-5-21-1", labels: ["Base", "User"], properties: { name: "ARYA", system_tags: "owned admin_tier_0" } };
    expect(nodeKind(node)).toBe("User");
    expect(nodeName(node)).toBe("ARYA");
    expect(nodeTagged(node, "owned")).toBe(true);
    expect(nodeTagged(node, "admin_tier_0")).toBe(true);
    expect(nodeName({ ...node, properties: {} })).toBe(node.objectid);
  });
  it("validates parameter object structure without transforming Cypher values", () => {
    expect(parseParameters('{"name":"a\\\"b","enabled":false,"count":0,"labels":["User"]}')).toEqual({ name: 'a"b', enabled: false, count: 0, labels: ["User"] });
    expect(() => parseParameters("null")).toThrow("JSON object");
    expect(() => parseParameters("[]")).toThrow("JSON object");
  });
  it("respects cleared canonical tags over imported legacy booleans", () => {
    expect(nodeTagged({ objectid: "1", labels: ["User"], properties: { owned: true, system_tags: "" } }, "owned")).toBe(false);
    expect(nodeTagged({ objectid: "1", labels: ["User", "Tag_Tier_Zero"], properties: {} }, "admin_tier_0")).toBe(true);
  });
  it("isolates saved query storage by project and tolerates malformed records", () => {
    saveCustomQueries("one", [{ id: "1", name: "Users", cypher: "MATCH (n:User) RETURN n", parameters: "{}" }]);
    expect(readCustomQueries("one")).toHaveLength(1);
    expect(readCustomQueries("two")).toEqual([]);
    localStorage.setItem("beagle.custom-queries.v1:one", '{"unexpected":true}');
    expect(readCustomQueries("one")).toEqual([]);
  });
});
