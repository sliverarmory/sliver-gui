import { BEAGLE_PROJECT_ID, parseBeagleJson, type BeagleAPI } from "./beagle-contracts.js";
import { BEAGLE_WORKSPACE_MAX_BYTES, parseBeagleCustomQueries, parseBeagleResultSnapshot, parseBeagleWorkspace } from "./beagle-workspace.js";

function request(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const parsed = parseBeagleJson(value, 1_000_000);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => !fields.includes(key))) throw new TypeError("Invalid investigation request");
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > BEAGLE_WORKSPACE_MAX_BYTES) throw new TypeError("Investigation request exceeds 16 MiB");
  return parsed;
}
export function parseBeagleSaveWorkspaceInput(value: unknown): Parameters<BeagleAPI["saveWorkspace"]>[0] {
  const input = request(value, ["projectId", "workspace"]);
  const workspace = parseBeagleWorkspace(input["workspace"]);
  if (typeof input["projectId"] !== "string" || input["projectId"] !== workspace.projectId) throw new TypeError("Investigation belongs to another project");
  return { projectId: input["projectId"], workspace };
}
export function parseBeagleExportQueriesInput(value: unknown): Parameters<BeagleAPI["exportQueries"]>[0] {
  const input = request(value, ["queries"]);
  return { queries: parseBeagleCustomQueries(input["queries"]) };
}
export function parseBeagleExportResultInput(value: unknown): Parameters<BeagleAPI["exportResult"]>[0] {
  const input = request(value, ["format", "title", "result", "columns", "sort"]);
  if (input["format"] !== "json" && input["format"] !== "csv") throw new TypeError("Choose JSON or CSV export");
  if (typeof input["title"] !== "string" || !input["title"].trim() || input["title"].length > 512 || /[\x00-\x1f\x7f]/u.test(input["title"])) throw new TypeError("Invalid result title");
  const result = parseBeagleResultSnapshot(input["result"]);
  const available = result.columns.length ? result.columns : [...new Set(result.rows.flatMap((row) => Object.keys(row)))];
  const columns = input["columns"];
  if (columns !== undefined && (!Array.isArray(columns) || columns.length > 256 || columns.some((entry) => typeof entry !== "string" || !available.includes(entry)) || new Set(columns).size !== columns.length)) throw new TypeError("Invalid result export columns");
  const sort = input["sort"];
  let order: { column: string; direction: "asc" | "desc" } | undefined;
  if (sort !== undefined) {
    const item = request(sort, ["column", "direction"]);
    if (typeof item["column"] !== "string" || !available.includes(item["column"]) || (item["direction"] !== "asc" && item["direction"] !== "desc")) throw new TypeError("Invalid result sort");
    order = { column: item["column"], direction: item["direction"] };
  }
  return { format: input["format"], title: input["title"], result, ...(columns === undefined ? {} : { columns: columns as string[] }), ...(order ? { sort: order } : {}) };
}
export function parseBeagleCancelOperationInput(value: unknown): { id: string } {
  const input = request(value, ["id"]);
  if (typeof input["id"] !== "string" || !BEAGLE_PROJECT_ID.test(input["id"])) throw new TypeError("Invalid operation ID");
  return { id: input["id"] };
}
