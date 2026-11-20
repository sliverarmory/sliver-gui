import type { BeagleComposeInput, BeagleQueryInput } from "../shared/beagle-contracts.js";

/** CE v9.8.0 queries.go FetchACLInheritancePath. All Contains parents must be
 * Domain/OU/Site/Container. Protection on the origin itself does not block its
 * inheritance; protection anywhere below it, including the target, does.
 * Values are parameters; the selected relationship is re-read from the graph.
 */
export function buildBeagleAclOriginsQuery(input: BeagleComposeInput): BeagleQueryInput {
  return {
    cypher: "MATCH (source {objectid: $source})-[acl]->(target {objectid: $target}) " +
      "WHERE type(acl) = $kind AND acl.isacl = true AND acl.isinherited = true AND coalesce(acl.inheritancehash, '') <> '' " +
      "MATCH p=(origin)-[:Contains*1..]->(target) " +
      "WHERE acl.inheritancehash IN coalesce(origin.inheritancehashes, []) " +
      "AND all(n IN nodes(p)[0..-1] WHERE n:Domain OR n:OU OR n:Site OR n:Container) " +
      "AND all(n IN nodes(p)[1..] WHERE NOT coalesce(n.isaclprotected, false)) " +
      "AND all(n IN nodes(p) WHERE single(m IN nodes(p) WHERE m = n)) " +
      "RETURN p, source, acl, target LIMIT 5001",
    parameters: { source: input.source, target: input.target, kind: input.kind },
  };
}
