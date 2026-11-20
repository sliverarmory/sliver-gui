import { useState } from "react";
import { Button, Label } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import type { BeagleNeighborhoodResult, BeagleNode } from "../../../shared/beagle-contracts";
import { getBeagleDrilldowns } from "../../../shared/beagle-investigations";

export function BeagleNeighborhoodControls({ node, result, loading, disabled, onLoad }: {
  node: BeagleNode; result: BeagleNeighborhoodResult | undefined; loading: boolean; disabled: boolean;
  onLoad: (view: string, offset: number) => void;
}) {
  const [view, setView] = useState("relationships");
  const views = getBeagleDrilldowns(node.labels);
  const selected = views.find((item) => item.id === view) ?? views[0]!;
  const page = result?.objectid === node.objectid && result.view === view ? result.page : undefined;
  const count = page ? Math.max(0, Math.min(result!.totalRows, page.total - page.offset)) : 0;
  const unit = view === "relationships" ? "Relationships" : "Objects";
  return <section className="beagle-neighborhood" aria-label="Related objects">
    <NativeSelect variant="secondary"><Label>Investigation</Label><NativeSelect.Trigger aria-label="Investigation" value={view} disabled={disabled || loading} onChange={(event) => setView(event.target.value)}>
      {views.map((item) => <NativeSelect.Option key={item.id} value={item.id}>{item.label}</NativeSelect.Option>)}<NativeSelect.Indicator />
    </NativeSelect.Trigger></NativeSelect>
    <Button size="sm" variant="secondary" isDisabled={disabled || loading} isPending={loading} onPress={() => onLoad(view, 0)}>{view === "relationships" ? "Expand relationships" : `Show ${selected.label.toLowerCase()}`}</Button>
    {page ? <nav aria-label="Investigation pages" className="beagle-search-pagination">
      <p role="status" className="beagle-muted">{count ? `${unit} ${(page.offset + 1).toLocaleString()}–${(page.offset + count).toLocaleString()} of ${page.total.toLocaleString()}` : `No results on this page · ${page.total.toLocaleString()} ${unit.toLowerCase()} total`} · {page.hasMore ? "More available" : "End of results"}</p>
      <div><Button size="sm" variant="tertiary" aria-label="Previous investigation results" isDisabled={disabled || loading || page.offset === 0} onPress={() => onLoad(view, Math.max(0, page.offset - page.limit))}>Previous</Button>
        <Button size="sm" variant="tertiary" aria-label="Next investigation results" isDisabled={disabled || loading || !page.hasMore} onPress={() => onLoad(view, page.offset + page.limit)}>Next</Button></div>
      <p className="beagle-muted">This page is added to the graph, which keeps earlier results. {view === "relationships" ? "" : "Each object includes one supporting path."}</p>
    </nav> : null}
  </section>;
}
