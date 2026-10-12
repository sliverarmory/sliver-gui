import { useEffect, useRef, useState } from "react";
import { Button, Description, Label, ListBox, Select } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown, faGlobe, faRotate } from "@fortawesome/free-solid-svg-icons";

import { WEBSITE_LIMITS, type WebsiteSummary } from "../../../shared/website-contracts";

interface WebsitePreviewSelectProps {
  identity: string;
  connected: boolean;
  websiteEventId: string | undefined;
  currentName: string | undefined;
  disabled: boolean;
  onChange: (name: string) => void;
}

interface WebsiteOptions {
  context: string;
  status: "loading" | "ready" | "error";
  items: WebsiteSummary[];
  error?: string;
}

const OPTION_PREFIX = "website:";

export function WebsitePreviewSelect({ identity, connected, websiteEventId, currentName, disabled, onChange }: WebsitePreviewSelectProps): React.JSX.Element {
  const [reload, setReload] = useState(0);
  const context = JSON.stringify([identity, websiteEventId, reload]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const [options, setOptions] = useState<WebsiteOptions>({ context: "", status: "loading", items: [] });
  const visible: WebsiteOptions = options.context === context ? options : { context, status: "loading", items: [] };

  useEffect(() => {
    let cancelled = false;
    const isCurrent = () => !cancelled && contextRef.current === context;
    setOptions({ context, status: connected ? "loading" : "ready", items: [] });
    if (!connected) return;
    void (async () => {
      const websites = new Map<string, WebsiteSummary>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        do {
          const result = await window.sliver.listWebsites({ limit: WEBSITE_LIMITS.maxPageSize, ...(cursor ? { cursor } : {}) });
          if (!isCurrent()) return;
          if (!result.ok) throw new Error(result.error);
          for (const site of result.value.items) websites.set(site.name, site);
          cursor = result.value.page.nextCursor;
          if (result.value.page.truncated && !cursor) throw new Error("The server returned an incomplete website list.");
          if (cursor && cursors.has(cursor)) throw new Error("The server returned a repeated website page.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        setOptions({ context, status: "ready", items: [...websites.values()].sort((left, right) => left.name.localeCompare(right.name)) });
      } catch (error) {
        if (isCurrent()) setOptions({ context, status: "error", items: [], error: error instanceof Error ? error.message : "Unable to load websites." });
      }
    })();
    return () => { cancelled = true; };
  }, [connected, context]);

  return <div className="min-w-0">
    <Select
      fullWidth
      variant="secondary"
      placeholder="Choose a website"
      value={currentName === undefined ? null : `${OPTION_PREFIX}${currentName}`}
      isDisabled={disabled || !connected || visible.status !== "ready" || visible.items.length === 0}
      onChange={(key) => {
        if (typeof key !== "string" || !key.startsWith(OPTION_PREFIX)) return;
        const name = key.slice(OPTION_PREFIX.length);
        if (name !== currentName && visible.items.some((site) => site.name === name && site.contentCount > 0)) onChange(name);
      }}
    >
      <Label>Preview website</Label>
      <Select.Trigger>
        <Select.Value>
          <span className="flex min-w-0 items-center gap-2">
            <FontAwesomeIcon aria-hidden icon={faGlobe} className="size-3.5 shrink-0 text-muted" />
            <span className="truncate">{currentName ?? "Choose a website"}</span>
          </span>
        </Select.Value>
        <Select.Indicator><FontAwesomeIcon aria-hidden icon={faChevronDown} className="size-3" /></Select.Indicator>
      </Select.Trigger>
      <Description>{!connected ? "Connect to a server to choose a website." : visible.status === "loading" ? "Loading websites…" : visible.status === "error" ? "Unable to load websites." : visible.items.length === 0 ? "No websites are stored on this server." : "Choose a website to start or switch the local preview."}</Description>
      <Select.Popover>
        <ListBox className="max-h-64 overflow-y-auto" aria-label="Server websites">
          {currentName !== undefined && !visible.items.some((site) => site.name === currentName) ? <ListBox.Item id={`${OPTION_PREFIX}${currentName}`} textValue={currentName} isDisabled><Label className="break-all">{currentName}</Label><ListBox.ItemIndicator /></ListBox.Item> : null}
          {visible.items.map((site) => <ListBox.Item key={site.name} id={`${OPTION_PREFIX}${site.name}`} textValue={site.name} isDisabled={site.contentCount === 0}>
            <FontAwesomeIcon aria-hidden icon={faGlobe} className="size-3.5 shrink-0 text-muted" />
            <Label className="break-all">{site.name}</Label>
            {site.contentCount === 0 ? <Description>No content</Description> : null}
            <ListBox.ItemIndicator />
          </ListBox.Item>)}
        </ListBox>
      </Select.Popover>
    </Select>
    {visible.status === "error" ? <div className="mt-2 flex items-start gap-2">
      <p role="alert" className="min-w-0 flex-1 break-words text-xs text-danger">{visible.error}</p>
      <Button size="sm" variant="tertiary" onPress={() => setReload((value) => value + 1)}><FontAwesomeIcon aria-hidden icon={faRotate} /> Retry website list</Button>
    </div> : null}
  </div>;
}
