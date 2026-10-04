import ELK from "elkjs/lib/elk.bundled.js";
import { createElkGraph, extractTopologyLayout } from "./topology-layout-input";
import type { LayoutNode, TopologyLayoutInput } from "./topology-layout-input";

/** In-process engine helper for layout tests. Browser UI uses the native worker. */
export async function layoutTopology(input: TopologyLayoutInput): Promise<LayoutNode[]> {
  if (!input.nodes.length) return [];
  const engine = new ELK({ algorithms: ["layered"] });
  // The bundled in-process shim has no native worker or terminate method.
  return extractTopologyLayout(await engine.layout(createElkGraph(input)));
}
