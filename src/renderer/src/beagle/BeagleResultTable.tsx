import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, Disclosure } from "@heroui/react";
import type { BeagleJsonObject, BeagleJsonValue, BeagleQueryResult } from "../../../shared/beagle-contracts";
import type { BeagleTableView } from "../../../shared/beagle-workspace";
import { displayValue } from "./beagle-model";

export function resultColumns(result: BeagleQueryResult): string[] { return result.columns.length ? result.columns : [...new Set(result.rows.flatMap((row) => Object.keys(row)))]; }
export function normalizeTableView(result: BeagleQueryResult, view: BeagleTableView): BeagleTableView {
  const columns = resultColumns(result);
  return { columns: view.columns.filter((column) => columns.includes(column)), sort: view.sort && columns.includes(view.sort.column) ? view.sort : null };
}
export function sortResultRows(rows: BeagleJsonObject[], sort: BeagleTableView["sort"]): BeagleJsonObject[] {
  if (!sort) return rows;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  function compare(a: BeagleJsonValue | undefined, b: BeagleJsonValue | undefined): number {
    if (a == null) return b == null ? 0 : 1;
    if (b == null) return -1;
    const value = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(displayValue(a), displayValue(b));
    return sort!.direction === "asc" ? value : -value;
  }
  return rows.map((row, index) => ({ row, index })).sort((a, b) => compare(a.row[sort.column], b.row[sort.column]) || a.index - b.index).map(({ row }) => row);
}
export function BeagleResultTable({ result, view, onViewChange, onExport, disabled = false }: {
  result: BeagleQueryResult; view: BeagleTableView; onViewChange: (value: BeagleTableView) => void;
  onExport: (columns: string[], rows: BeagleJsonObject[]) => void; disabled?: boolean;
}) {
  const [page, setPage] = useState(0);
  const allColumns = resultColumns(result);
  const chosen = view.columns.filter((column) => allColumns.includes(column));
  const columns = chosen.length ? chosen : allColumns;
  const rows = useMemo(() => sortResultRows(result.rows, view.sort), [result.rows, view.sort]);
  useEffect(() => setPage(0), [result, view.sort]);
  const pageSize = 50, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  return <div className="beagle-table-wrapper">
    <div className="beagle-table-actions"><Disclosure><Disclosure.Heading><Button slot="trigger" size="sm" variant="tertiary">Columns ({columns.length}/{allColumns.length})<Disclosure.Indicator /></Button></Disclosure.Heading>
      <Disclosure.Content><Disclosure.Body className="beagle-table-columns">{allColumns.map((column) => <Checkbox key={column} isSelected={columns.includes(column)} isDisabled={columns.length === 1 && columns.includes(column)}
        onChange={(selected) => onViewChange({ ...view, columns: selected ? allColumns.filter((item) => item === column || columns.includes(item)) : columns.filter((item) => item !== column) })}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>{column}</Checkbox.Content></Checkbox>)}</Disclosure.Body></Disclosure.Content>
    </Disclosure><Button size="sm" variant="tertiary" isDisabled={disabled || !rows.length} onPress={() => onExport(columns, rows)}>Export table CSV</Button></div>
    {!rows.length ? <p className="beagle-muted p-4">No rows returned.</p> : <div className="beagle-table-scroll"><table aria-label="Cypher results"><thead><tr>{columns.map((column) => <th key={column} aria-sort={view.sort?.column === column ? view.sort.direction === "asc" ? "ascending" : "descending" : "none"}>
      <Button size="sm" variant="ghost" aria-label={`Sort by ${column}`} onPress={() => onViewChange({ ...view, sort: { column, direction: view.sort?.column === column && view.sort.direction === "asc" ? "desc" : "asc" } })}>{column}{view.sort?.column === column ? view.sort.direction === "asc" ? " ↑" : " ↓" : ""}</Button>
    </th>)}</tr></thead><tbody>{rows.slice(page * pageSize, (page + 1) * pageSize).map((row, index) => <tr key={page * pageSize + index}>{columns.map((column) => {
      const value = displayValue(row[column]);
      return <td key={column}><details className="beagle-cell-value"><summary title={value.length <= 400 ? value : undefined}>{value.length > 400 ? `${value.slice(0, 400)}…` : value}</summary>{value.length > 400 ? <pre>{value}</pre> : null}</details></td>;
    })}</tr>)}</tbody></table></div>}
    <div className="beagle-pagination"><span>{rows.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, rows.length)}` : "0"} of {rows.length.toLocaleString()} displayed rows</span>
      <Button size="sm" variant="tertiary" isDisabled={page === 0} onPress={() => setPage((current) => Math.max(0, current - 1))}>Previous</Button>
      <Button size="sm" variant="tertiary" isDisabled={page >= pageCount - 1} onPress={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>Next</Button></div>
  </div>;
}
