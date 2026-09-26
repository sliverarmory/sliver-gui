import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Chip, Disclosure, Tooltip } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faApple, faLinux, faWindows } from "@fortawesome/free-brands-svg-icons";
import { faChevronDown, faComputer } from "@fortawesome/free-solid-svg-icons";

import type { BeaconSummary } from "../../../shared/target-contracts";
import { beaconCheckinTiming, formatTimestamp } from "./target-page-model";

const operatingSystemIcons = new Map([
  ["windows", faWindows],
  ["linux", faLinux],
  ["darwin", faApple],
  ["macos", faApple],
]);

export function BeaconWorkspaceHeader({
  beacon,
  nowMs,
  details,
  children,
}: {
  beacon: BeaconSummary;
  nowMs: number;
  details: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const name = beacon.name || beacon.hostname || "Unnamed beacon";
  const hostUser = `${beacon.username || "Unknown user"} on ${beacon.hostname || "unknown host"}`;
  const timing = beaconCheckinTiming(beacon, nowMs);
  const status = timing.status;
  const markerRef = useRef<HTMLDivElement>(null);
  const [isStuck, setIsStuck] = useState(false);

  useEffect(() => {
    const marker = markerRef.current;
    const viewport = marker?.closest(".app-content, .interaction-window__content");
    if (!marker || !viewport) return;
    viewport.scrollTop = 0;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setIsStuck(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, { root: viewport, threshold: [0, 1] });
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);

  return (
    <Disclosure className="beacon-workspace__interaction min-w-0">
      {({ isExpanded }) => (
        <>
          <div aria-hidden="true" className="beacon-workspace__scroll-marker" ref={markerRef} />
          <div className="beacon-workspace__sticky" data-stuck={isStuck}>
            <div className="beacon-workspace__summary-frame">
              <header aria-label="Beacon summary" className="beacon-workspace__summary flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl bg-surface px-4 py-3">
                <div className="flex min-w-0 flex-1 basis-80 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-default text-muted">
                    <FontAwesomeIcon aria-hidden icon={operatingSystemIcons.get(beacon.os.trim().toLowerCase()) ?? faComputer} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <h1 className="truncate text-base font-semibold text-foreground" id="beacon-workspace-heading" title={name}>{name}</h1>
                      <Chip className="shrink-0" color={status.color} size="sm" variant="soft">{status.label}</Chip>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                      <p className="min-w-0 truncate" title={hostUser}>{hostUser}</p>
                      <p className="min-w-0 truncate font-mono text-[11px]" title={beacon.id}>{beacon.id}</p>
                    </div>
                  </div>
                </div>
                <dl className="flex max-w-full flex-wrap items-center gap-x-5 gap-y-2">
                  <SummaryDetail label="Platform" value={`${beacon.os || "unknown"}/${beacon.arch || "unknown"}`} mono />
                  <SummaryDetail label="Process" value={beacon.pid === undefined ? "Not reported" : String(beacon.pid)} mono />
                  <SummaryDetail label="Last check-in" value={formatTimestamp(beacon.lastCheckinAt)} />
                  <div className="min-w-0">
                    <dt className="text-[11px] text-muted">Next check-in</dt>
                    <dd
                      className={`mt-0.5 truncate font-mono text-xs tabular-nums ${status.color === "warning" ? "text-warning" : "text-foreground"}`}
                      title={timing.countdown === "Not reported" ? undefined : formatTimestamp(beacon.nextCheckinAt)}
                    >
                      {timing.countdown.replace(/^In /u, "")}
                    </dd>
                  </div>
                </dl>
                <Disclosure.Heading className="ml-auto shrink-0">
                  <Tooltip delay={250}>
                    <Button aria-label="Beacon details" isIconOnly size="sm" slot="trigger" variant="ghost">
                      <Disclosure.Indicator>
                        <FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} />
                      </Disclosure.Indicator>
                    </Button>
                    <Tooltip.Content>{isExpanded ? "Hide beacon details" : "Show beacon details"}</Tooltip.Content>
                  </Tooltip>
                </Disclosure.Heading>
              </header>
            </div>
          </div>
          <div className="beacon-workspace__body-frame page-stack">
            <Disclosure.Content className="rounded-2xl bg-surface">{details}</Disclosure.Content>
            {children}
          </div>
        </>
      )}
    </Disclosure>
  );
}

function SummaryDetail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={`mt-0.5 truncate text-xs text-foreground ${mono ? "font-mono tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}
