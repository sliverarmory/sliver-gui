import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = await readJSON("protocol/sliver-baseline.json");
const generated = await readJSON("docs/operator-parity.generated.json");
const annotations = await readJSON("docs/operator-parity.annotations.json");
const arguments_ = parseArguments(process.argv.slice(2));
assert(baseline.schemaVersion === 2, `Unsupported Sliver baseline schema: ${baseline.schemaVersion}`);
const allowedStatuses = new Set([
  "planned", "in-progress", "complete", "deferred", "operator-out-of-scope", "upstream-blocked", "unreachable",
]);

if (arguments_.regenerate) {
  assert(arguments_.source, "--regenerate requires --source");
  execFileSync(process.execPath, [join(repositoryRoot, "scripts/parity-generate.mjs"), "--source", resolve(arguments_.source), "--check"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

assert(generated.schemaVersion === 1, "Unsupported generated schema version");
assert(annotations.schemaVersion === 1, "Unsupported annotation schema version");
assert(generated.baseline.commit === baseline.commit, "Generated inventory baseline commit drifted");
assert(generated.baseline.tree === baseline.tree, "Generated inventory baseline tree drifted");
assert(annotations.baselineCommit === baseline.commit, "Annotation baseline commit drifted");

const generatedById = uniqueMap(generated.commands, "generated command");
const annotationById = uniqueMap(annotations.commands, "annotation");
const generatedIds = [...generatedById.keys()].sort();
const annotationIds = [...annotationById.keys()].sort();
assert(JSON.stringify(generatedIds) === JSON.stringify(annotationIds),
  describeSetDifference(generatedIds, annotationIds, "generated", "annotated"));

const sourceKeys = new Set();
for (const command of generated.commands) {
  assert(command.baselineCommit === baseline.commit, `${command.id}: baseline commit mismatch`);
  assert(command.id === `${command.surface}.${command.path.map(slug).join(".")}`, `${command.id}: unstable ID`);
  assert(Array.isArray(command.aliases), `${command.id}: aliases must be an array`);
  assert(Array.isArray(command.options), `${command.id}: options must be an array`);
  assert(command.source?.file && command.source?.key, `${command.id}: missing source provenance`);
  assert(!sourceKeys.has(command.source.key), `${command.id}: duplicate source key ${command.source.key}`);
  sourceKeys.add(command.source.key);
  assert(!command.path.includes("_carapace"), `${command.id}: generated completion helper entered inventory`);
  validateRestrictions(command.id, command.restrictions);
  validateRestrictionEvidence(command.id, command.restrictionEvidence);
  if (arguments_.source) {
    assert(existsSync(join(resolve(arguments_.source), command.source.file)),
      `${command.id}: source path does not exist at baseline: ${command.source.file}`);
  }

  const annotation = annotationById.get(command.id);
  assert(allowedStatuses.has(annotation.status), `${command.id}: invalid status ${annotation.status}`);
  assert(typeof annotation.operatorScope === "boolean", `${command.id}: operatorScope must be boolean`);
  assert(typeof annotation.milestone === "string" && annotation.milestone !== "", `${command.id}: missing milestone`);
  assert(typeof annotation.guiSurface === "string" && annotation.guiSurface !== "", `${command.id}: missing GUI surface`);
  assert(Array.isArray(annotation.dependencies), `${command.id}: dependencies must be an array`);
  assert(Array.isArray(annotation.meaningfulModes), `${command.id}: meaningfulModes must be an array`);
  assert(Array.isArray(annotation.meaningfulOptions), `${command.id}: meaningfulOptions must be an array`);
  assert(Array.isArray(annotation.testIds) && annotation.testIds.length > 0, `${command.id}: testIds must be non-empty`);
  const contractPrefix = annotation.status === "upstream-blocked"
    ? "upstream-regression:"
    : annotation.operatorScope ? "parity-contract:" : "scope-denial:";
  assert(annotation.testIds.includes(`${contractPrefix}${command.id}`), `${command.id}: stable test contract ID is missing`);
  assert(typeof annotation.notes === "string" && annotation.notes !== "", `${command.id}: missing review notes`);
  validateRestrictions(command.id, annotation.restrictionReview);
  validateRestrictionEvidence(command.id, annotation.restrictionEvidenceReview);
  assert(stable(annotation.restrictionReview) === stable(command.restrictions),
    `${command.id}: reviewed restrictions drifted from discovered restrictions`);
  assert(stable(annotation.restrictionEvidenceReview) === stable(command.restrictionEvidence),
    `${command.id}: reviewed restriction evidence drifted from discovered evidence`);
  const optionNames = command.options.map((option) => option.name).sort();
  assert(stable([...annotation.meaningfulOptions].sort()) === stable(optionNames),
    `${command.id}: meaningful option review does not cover every discovered option`);
  if (annotation.status === "operator-out-of-scope") {
    assert(annotation.operatorScope === false, `${command.id}: out-of-scope command cannot set operatorScope=true`);
  }
}

const dynamicIds = generated.dynamicAudit.addedNodes.map((command) => command.id).sort();
assert(stable(dynamicIds) === stable(["implant.parity-alias", "implant.parity-extension"]),
  `Dynamic audit was contaminated by unexpected nodes: ${dynamicIds.join(", ")}`);
assert(!generatedIds.some((id) => id.includes("parity-alias") || id.includes("parity-extension")),
  "Third-party fixture names entered the static parity requirements");
assert(generated.discoveryRules.thirdPartyNamesAreStaticRequirements === false,
  "Dynamic third-party names must not become static requirements");

for (const decision of annotations.scopeDecisions ?? []) {
  assert(allowedStatuses.has(decision.status), `${decision.id}: invalid scope-decision status`);
  assert(typeof decision.notes === "string" && decision.notes !== "", `${decision.id}: missing scope-decision notes`);
}

console.log(`Parity validation passed: ${generated.commands.length} reachable static nodes, ${annotations.commands.length} reviewed annotations`);

async function readJSON(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

function uniqueMap(entries, label) {
  const result = new Map();
  for (const entry of entries) {
    assert(typeof entry.id === "string" && entry.id !== "", `${label} is missing an ID`);
    assert(!result.has(entry.id), `Duplicate ${label} ID: ${entry.id}`);
    result.set(entry.id, entry);
  }
  return result;
}

function validateRestrictions(id, restrictions) {
  assert(restrictions && typeof restrictions === "object", `${id}: missing restrictions`);
  for (const field of ["targetModes", "targetOperatingSystems", "transports"]) {
    assert(Array.isArray(restrictions[field]) && restrictions[field].length > 0, `${id}: ${field} must be non-empty`);
    assert(new Set(restrictions[field]).size === restrictions[field].length, `${id}: duplicate ${field}`);
  }
}

function validateRestrictionEvidence(id, evidence) {
  assert(evidence && typeof evidence === "object", `${id}: missing restriction evidence`);
  for (const field of ["targetModes", "targetOperatingSystems", "transports"]) {
    assert(typeof evidence[field] === "string" && evidence[field] !== "", `${id}: ${field} evidence is missing`);
  }
}

function describeSetDifference(left, right, leftName, rightName) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const onlyLeft = left.filter((value) => !rightSet.has(value));
  const onlyRight = right.filter((value) => !leftSet.has(value));
  return `${leftName}/${rightName} command sets differ; only ${leftName}: ${onlyLeft.join(", ") || "none"}; only ${rightName}: ${onlyRight.join(", ") || "none"}`;
}

function parseArguments(values) {
  const result = { source: undefined, regenerate: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--source") result.source = values[++index];
    else if (values[index] === "--regenerate") result.regenerate = true;
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  return result;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function stable(value) {
  return JSON.stringify(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
