import type { SessionProcess } from "./session-contracts.js";

export interface SessionProcessQuery {
  readonly valid: boolean;
  readonly pid?: number;
  readonly owners: readonly string[];
  readonly text: string;
}

export function parseSessionProcessQuery(value = ""): SessionProcessQuery {
  const query = value.trim();
  const qualifier = /(?:^|\s)(pid|owner):/giu;
  const owners: string[] = [];
  const text: string[] = [];
  let pid: number | undefined;
  let offset = 0;
  let hasQualifier = false;
  let match: RegExpExecArray | null;

  while ((match = qualifier.exec(query)) !== null) {
    hasQualifier = true;
    text.push(query.slice(offset, match.index).trim());
    const start = qualifier.lastIndex;
    const quote = query[start];
    let end = start;
    let filter: string;
    if (quote === "\"" || quote === "'") {
      const closingQuote = query.indexOf(quote, start + 1);
      if (closingQuote < 0) return { valid: false, owners: [], text: "" };
      filter = query.slice(start + 1, closingQuote);
      end = closingQuote + 1;
      if (end < query.length && !/\s/u.test(query[end]!)) {
        return { valid: false, owners: [], text: "" };
      }
    } else {
      while (end < query.length && !/\s/u.test(query[end]!)) end += 1;
      filter = query.slice(start, end);
    }
    if (!filter.trim()) return { valid: false, owners: [], text: "" };

    if (match[1]!.toLocaleLowerCase() === "pid") {
      const nextPid = Number(filter);
      if (!/^\d+$/u.test(filter) || !Number.isSafeInteger(nextPid) || (pid !== undefined && pid !== nextPid)) {
        return { valid: false, owners: [], text: "" };
      }
      pid = nextPid;
    } else {
      owners.push(filter.toLocaleLowerCase());
    }
    offset = end;
    qualifier.lastIndex = end;
  }

  text.push(query.slice(offset).trim());
  return {
    valid: true,
    ...(pid === undefined ? {} : { pid }),
    owners,
    text: (hasQualifier ? text.filter(Boolean).join(" ") : query).toLocaleLowerCase(),
  };
}

export function sessionProcessMatchesQuery(process: SessionProcess, query: SessionProcessQuery): boolean {
  if (!query.valid || (query.pid !== undefined && process.pid !== query.pid)) return false;
  const owner = process.owner.toLocaleLowerCase();
  if (!query.owners.every((value) => owner.includes(value))) return false;
  return !query.text || [
    String(process.pid),
    process.executable,
    process.owner,
    process.architecture,
    ...process.commandLine,
  ].some((value) => value.toLocaleLowerCase().includes(query.text));
}
