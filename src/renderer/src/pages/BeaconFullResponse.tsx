import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, SearchField } from "@heroui/react";

import type { BeaconFullResponseModel, BeaconFullResponseSection } from "./beacon-full-response-model";

const TABLE_PAGE_SIZE = 100;
const BINARY_PAGE_BYTES = 4_096;

/** Presents complete task content in the same language as the task itself. */
export function BeaconFullResponse({ model }: { model: BeaconFullResponseModel }): React.JSX.Element {
  return (
    <div aria-label="Full task output" className="min-w-0 space-y-6" role="region">
      {model.sections.length === 0 ? <p className="py-8 text-center text-sm text-muted">No output was returned.</p> : null}
      {model.sections.map((section, index) => (
        <ResponseSection key={`${section.kind}:${section.title}:${index}`} section={section} />
      ))}
    </div>
  );
}

function ResponseSection({ section }: { section: BeaconFullResponseSection }): React.JSX.Element {
  if (section.kind === "table") return <ResponseTable section={section} />;
  if (section.kind === "text") return <ResponseText section={section} />;
  if (section.kind === "bytes") return <ResponseBytes section={section} />;
  return (
    <section aria-label={section.title} className="min-w-0 space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
      <dl className="grid gap-x-8 gap-y-4 rounded-xl bg-surface-secondary px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
        {section.fields.map((field, index) => (
          <div className="min-w-0" key={`${field.label}:${index}`}>
            <dt className="text-xs text-muted">{field.label}</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground [overflow-wrap:anywhere]">{field.value || "—"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ResponseTable({ section }: { section: Extract<BeaconFullResponseSection, { kind: "table" }> }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const statusId = useId();
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? section.rows.filter((row) => row.some((value) => value.toLocaleLowerCase().includes(needle))) : section.rows;
  }, [query, section.rows]);
  const pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  const activePage = Math.min(page, pages - 1);
  const first = activePage * TABLE_PAGE_SIZE;
  const last = Math.min(first + TABLE_PAGE_SIZE, rows.length);
  const filtered = Boolean(query.trim());

  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [activePage, query]);

  return (
    <section aria-label={section.title} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
        {section.rows.length > 0 ? (
          <SearchField
            aria-label={`Filter ${section.title}`}
            className="w-full sm:max-w-72"
            value={query}
            variant="secondary"
            onChange={(value) => { setQuery(value); setPage(0); }}
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="Filter all rows…" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <div aria-label={`${section.title} rows`} className="max-h-[52vh] min-w-0 overflow-auto rounded-xl border border-separator" ref={viewportRef} role="region" tabIndex={0}>
          <table aria-describedby={statusId} aria-label={section.title} className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-secondary">
              <tr>
                {section.columns.map((column, index) => (
                  <th className="whitespace-nowrap px-4 py-3 font-medium text-muted" key={`${column}:${index}`} scope="col">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {rows.slice(first, last).map((row, rowIndex) => (
                <tr key={first + rowIndex}>
                  {row.map((value, columnIndex) => (
                    <td className="min-w-24 max-w-md whitespace-pre-wrap break-words px-4 py-3 align-top tabular-nums text-foreground first:font-medium [overflow-wrap:anywhere]" key={columnIndex}>
                      {value || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-xl bg-surface-secondary px-4 py-8 text-center text-sm text-muted">
          {filtered ? "No rows match this filter." : "No entries were returned."}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs tabular-nums text-muted" id={statusId} role="status">
          {rows.length > 0 ? `${(first + 1).toLocaleString()}–${last.toLocaleString()} of ${rows.length.toLocaleString()} rows` : "0 rows"}
          {filtered ? ` · ${section.rows.length.toLocaleString()} total` : ""}
        </p>
        {pages > 1 ? (
          <div className="flex items-center gap-2">
            <Button isDisabled={activePage === 0} size="sm" variant="tertiary" onPress={() => setPage(activePage - 1)}>Previous</Button>
            <span className="min-w-16 text-center text-xs tabular-nums text-muted">{activePage + 1} / {pages}</span>
            <Button isDisabled={activePage === pages - 1} size="sm" variant="tertiary" onPress={() => setPage(activePage + 1)}>Next</Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ResponseText({ section }: { section: Extract<BeaconFullResponseSection, { kind: "text" }> }): React.JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => { setCopyState("idle"); }, [section.text]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(section.text);
      if (mountedRef.current) setCopyState("copied");
    } catch {
      if (mountedRef.current) setCopyState("error");
    }
  };

  return (
    <section aria-label={section.title} className="min-w-0 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
        {section.text ? <Button aria-label={`Copy ${section.title}`} size="sm" variant="ghost" onPress={() => void copy()}>{copyState === "copied" ? "Copied" : "Copy"}</Button> : null}
      </div>
      {section.text ? (
        <pre
          aria-label={section.title}
          className="max-h-[58vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-surface-secondary p-4 font-mono text-xs leading-6 text-foreground [overflow-wrap:anywhere]"
          tabIndex={0}
        >{section.text}</pre>
      ) : <p className="rounded-xl bg-surface-secondary px-4 py-8 text-center text-sm text-muted">No output was returned.</p>}
      {copyState === "copied" ? <p className="sr-only" role="status">{section.title} copied.</p> : null}
      {copyState === "error" ? <p className="text-xs text-danger" role="alert">Could not copy the output. Select the text to copy it manually.</p> : null}
    </section>
  );
}

function ResponseBytes({ section }: { section: Extract<BeaconFullResponseSection, { kind: "bytes" }> }): React.JSX.Element {
  const [page, setPage] = useState(0);
  const viewportRef = useRef<HTMLPreElement>(null);
  const byteCount = Math.floor(section.hex.length / 2);
  const pages = Math.max(1, Math.ceil(byteCount / BINARY_PAGE_BYTES));
  const activePage = Math.min(page, pages - 1);
  const start = activePage * BINARY_PAGE_BYTES;
  const end = Math.min(start + BINARY_PAGE_BYTES, byteCount);
  useEffect(() => {
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [activePage]);
  const rows: string[] = [];
  for (let offset = start; offset < end; offset += 16) {
    const octets = section.hex.slice(offset * 2, Math.min(offset + 16, end) * 2).match(/.{2}/gu) ?? [];
    const ascii = octets.map((octet) => {
      const value = Number.parseInt(octet, 16);
      return value >= 32 && value <= 126 ? String.fromCharCode(value) : ".";
    }).join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${octets.slice(0, 8).join(" ").padEnd(23)}  ${octets.slice(8).join(" ").padEnd(23)}  ${ascii}`);
  }

  return (
    <section aria-label={section.title} className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
        <p className="text-xs tabular-nums text-muted">{byteCount.toLocaleString()} bytes</p>
      </div>
      <pre aria-label={`${section.title} hex view`} className="max-h-[52vh] overflow-auto rounded-xl bg-surface-secondary p-4 font-mono text-xs leading-6 text-foreground" ref={viewportRef} tabIndex={0}>
        <span className="text-muted">{"Offset    Hexadecimal                                       Text\n"}</span>
        {rows.join("\n") || "No data was returned."}
      </pre>
      {pages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs tabular-nums text-muted" role="status">Bytes {(start + 1).toLocaleString()}–{end.toLocaleString()} of {byteCount.toLocaleString()}</p>
          <div className="flex items-center gap-2">
            <Button isDisabled={activePage === 0} size="sm" variant="tertiary" onPress={() => setPage(activePage - 1)}>Previous</Button>
            <Button isDisabled={activePage === pages - 1} size="sm" variant="tertiary" onPress={() => setPage(activePage + 1)}>Next</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
