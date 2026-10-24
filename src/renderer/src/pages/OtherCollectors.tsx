import { Button, Chip, Disclosure } from "@heroui/react";
import type { AdCollectorSummary } from "../../../shared/ad-explorer-contracts";

interface OtherCollectorsProps {
  collectors: readonly AdCollectorSummary[];
  selectedCollectorId: string;
  isExpanded: boolean;
  isBusy: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  onSelect: (collectorId: string) => void;
}

function collectorChoice(collector: AdCollectorSummary): { label: string; title: string; detail: string } {
  if (collector.id === "sharphound:custom:script") {
    return {
      label: "Use your own Invoke-BloodHound .ps1",
      title: "Invoke-BloodHound .ps1",
      detail: "PowerShell script with Invoke-BloodHound.",
    };
  }
  if (collector.id === "sharphound:custom:file") {
    return {
      label: "Use your own SharpHound-compatible .exe",
      title: "SharpHound .exe",
      detail: "SharpHound-compatible Windows executable.",
    };
  }
  return { label: collector.name, title: collector.name, detail: collector.description };
}

export function OtherCollectors({ collectors, selectedCollectorId, isExpanded, isBusy,
  onExpandedChange, onSelect }: OtherCollectorsProps): React.JSX.Element | null {
  if (!collectors.length) return null;
  const selectedCollector = collectors.find((collector) => collector.id === selectedCollectorId);

  return (
    <Disclosure className="border-t border-separator/70 pt-4" isExpanded={isExpanded} onExpandedChange={onExpandedChange}>
      <Disclosure.Heading>
        <Button slot="trigger" variant="ghost" className="-ml-3 h-auto min-h-10 flex-wrap justify-start text-left"
          aria-label="Other collectors" {...(selectedCollector && !isExpanded ? { "aria-describedby": "other-collectors-selected-summary" } : {})}>
          Other collectors <Disclosure.Indicator />
          {selectedCollector && !isExpanded ? <Chip id="other-collectors-selected-summary" size="sm" variant="soft" color="accent">
            Selected: {collectorChoice(selectedCollector).title}
          </Chip> : null}
        </Button>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="space-y-3 pt-3">
          <p className="text-sm text-muted">Bring a local SharpHound collector. These files are operator supplied and their compatibility is not verified.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {collectors.map((collector) => {
              const choice = collectorChoice(collector);
              const selected = selectedCollectorId === collector.id;
              const detailId = `other-collector-${collector.id.replace(/[^a-z0-9-]/giu, "-")}`;
              return (
                <div key={collector.id} className="min-w-0 space-y-1">
                  <Button
                    aria-label={choice.label}
                    aria-describedby={detailId}
                    aria-pressed={selected}
                    className="h-auto min-h-20 w-full justify-start whitespace-normal px-4 py-3 text-left"
                    variant={selected ? "secondary" : "outline"}
                    isDisabled={!collector.available || isBusy}
                    onPress={() => onSelect(collector.id)}
                  >
                    <span className="flex w-full min-w-0 items-start justify-between gap-3">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">{choice.title}</span>
                        <span className="mt-1 block text-xs text-muted">{choice.detail}</span>
                      </span>
                      <Chip className="shrink-0" size="sm" variant="soft" color={!collector.available ? "danger" : selected ? "accent" : "default"}>
                        {!collector.available ? "Unavailable" : selected ? "Selected" : "Available"}
                      </Chip>
                    </span>
                  </Button>
                  {!collector.available && collector.reason ? <p id={detailId} className="text-xs text-muted">{collector.reason}</p> :
                    <span id={detailId} className="sr-only">Choose the local file when you run this collector.</span>}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted">Choose the file when you run. It must accept the selected domain, collection method, and output path. The saved ZIP is checked before import.</p>
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}
