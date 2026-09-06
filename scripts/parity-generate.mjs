import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedPath = join(repositoryRoot, "docs/operator-parity.generated.json");
const annotationsPath = join(repositoryRoot, "docs/operator-parity.annotations.json");
const reportPath = join(repositoryRoot, "docs/operator-parity.md");
const baseline = JSON.parse(await readFile(join(repositoryRoot, "protocol/sliver-baseline.json"), "utf8"));
const arguments_ = parseArguments(process.argv.slice(2));

if (baseline.schemaVersion !== 2) {
  throw new Error(`Unsupported Sliver baseline schema: ${baseline.schemaVersion}`);
}

if (!arguments_.source) {
  throw new Error("Pass --source with a checkout created by protocol-fetch-baseline.mjs");
}

const source = resolve(arguments_.source);
await verifySource(source);
verifyGoToolchain();
const workspace = await mkdtemp(join(tmpdir(), "sliver-parity-generate-"));
const stagedSource = join(workspace, "sliver");
stageSource(source, stagedSource);
await mkdir(join(stagedSource, "tools/parity-dump"), { recursive: true });
await copyFile(join(repositoryRoot, "tools/parity-dump/main.go"), join(stagedSource, "tools/parity-dump/main.go"));

const cleanRoot = join(workspace, "client-clean");
const dynamicRoot = join(workspace, "client-dynamic");
await mkdir(cleanRoot, { recursive: true });
await createDynamicFixtures(dynamicRoot);

const cleanDump = runDump(stagedSource, cleanRoot, join(workspace, "go-cache"));
const dynamicDump = runDump(stagedSource, dynamicRoot, join(workspace, "go-cache"));
const generated = buildGenerated(cleanDump, dynamicDump);
const generatedText = stableJSON(generated);

let annotations;
if (arguments_.bootstrapAnnotations) {
  if (existsSync(annotationsPath) && !arguments_.force) {
    throw new Error(`Refusing to replace reviewed annotations without --force: ${annotationsPath}`);
  }
  annotations = bootstrapAnnotations(generated.commands);
} else if (existsSync(annotationsPath)) {
  annotations = JSON.parse(await readFile(annotationsPath, "utf8"));
} else {
  throw new Error("Reviewed annotations are missing; use --bootstrap-annotations for the initial review file");
}

const reportText = renderReport(generated, annotations);

if (arguments_.check) {
  await assertSame(generatedPath, generatedText, "generated parity inventory");
  await assertSame(reportPath, reportText, "human parity report");
} else {
  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(generatedPath, generatedText, "utf8");
  if (arguments_.bootstrapAnnotations) {
    await writeFile(annotationsPath, stableJSON(annotations), "utf8");
  }
  await writeFile(reportPath, reportText, "utf8");
}

if (arguments_.compare) {
  const previous = JSON.parse(await readFile(resolve(arguments_.compare), "utf8"));
  console.log(JSON.stringify(compareInventories(previous, generated), null, 2));
} else {
  console.log(`${generated.commands.length} static command nodes; dynamic fixture audit passed`);
}

function buildGenerated(cleanDump, dynamicDump) {
  const cleanKeys = new Set(cleanDump.commands.map(commandKey));
  const dynamicAdded = dynamicDump.commands
    .filter((command) => !cleanKeys.has(commandKey(command)))
    .map((command) => normalizeCommand(command))
    .sort(compareCommands);
  const expectedDynamic = new Set(["parity-alias", "parity-extension"]);
  const receivedDynamic = new Set(dynamicAdded.map((command) => command.path.at(-1)));
  if (dynamicAdded.length !== expectedDynamic.size) {
    throw new Error(`Dynamic fixture audit added unexpected nodes: ${dynamicAdded.map((command) => command.id).join(", ")}`);
  }
  for (const expected of expectedDynamic) {
    if (!receivedDynamic.has(expected)) throw new Error(`Dynamic fixture did not register ${expected}`);
  }

  const commands = [
    ...rootModes(),
    ...cleanDump.commands.map((command) => normalizeCommand(command)),
  ].sort(compareCommands);
  const ids = new Set();
  for (const command of commands) {
    if (ids.has(command.id)) throw new Error(`Duplicate generated command ID: ${command.id}`);
    ids.add(command.id);
  }

  return {
    schemaVersion: 1,
    generatorVersion: 1,
    baseline: {
      repository: baseline.repository,
      commit: baseline.commit,
      tree: baseline.tree,
      sources: baseline.commandSources,
    },
    discoveryRules: {
      roots: ["ServerCommands(client, nil)", "SliverCommands(client)", "client/cli root modes"],
      excludedGeneratedNodes: ["help", "completion", "_carapace", "__*"],
      thirdPartyNamesAreStaticRequirements: false,
      restrictionModel: {
        implantDefault: "The upstream console exposes unannotated SliverCommands nodes for session and beacon targets on Windows, Linux, and Darwin; console-hidden annotations narrow that visibility and inherit through command parents.",
        serverDefault: "ServerCommands nodes are not target-bound unless an upstream console-hidden annotation says otherwise.",
        runtimeCaveat: "These are command-tree visibility gates. Main-process capability checks may be stricter and remain authoritative at invocation time.",
      },
    },
    dynamicAudit: {
      fixtureVersion: 1,
      representativeAlias: "parity-alias",
      representativeExtension: "parity-extension",
      addedNodes: dynamicAdded,
    },
    commands,
  };
}

function normalizeCommand(command) {
  const id = `${command.surface}.${command.path.map(slug).join(".")}`;
  const source = {
    file: command.source.file,
    line: command.source.line,
    symbol: command.source.symbol,
    key: `${command.source.file}:${command.source.line}#${id}`,
  };
  return {
    id,
    baselineCommit: baseline.commit,
    surface: command.surface,
    path: command.path,
    use: command.use,
    aliases: command.aliases,
    summary: command.short,
    hidden: command.hidden,
    deprecated: command.deprecated ?? "",
    source,
    restrictions: command.restrictions,
    options: command.options,
    upstreamAnnotations: command.annotations,
    restrictionEvidence: command.restrictionEvidence,
    fingerprint: command.fingerprint,
    gateFingerprint: digest(command.restrictions),
  };
}

function rootModes() {
  const anyRestriction = {
    targetModes: ["not-applicable"],
    targetOperatingSystems: ["operator-host"],
    transports: ["local"],
  };
  const mode = (id, path, use, file, line, summary, options = [], transports = ["local"]) => ({
    id,
    baselineCommit: baseline.commit,
    surface: "root",
    path,
    use,
    aliases: [],
    summary,
    hidden: false,
    deprecated: "",
    source: { file, line, symbol: `client/cli.${id}`, key: `${file}:${line}#${id}` },
    restrictions: { ...anyRestriction, transports },
    options: options.map((name) => ({
      name, type: "string", default: "", usage: "See pinned root command source", required: false,
      persistent: false,
    })),
    upstreamAnnotations: {},
    restrictionEvidence: {
      targetModes: "separately-audited-root-mode",
      targetOperatingSystems: "separately-audited-root-mode",
      transports: "separately-audited-root-mode",
    },
    fingerprint: digest({ id, use, options, transports }),
    gateFingerprint: digest({ ...anyRestriction, transports }),
  });
  return [
    mode("root.default-console", ["default-console"], "sliver-client", "client/cli/cli.go", 86,
      "Start the interactive console when no subcommand is supplied", ["rc", "enable-wg", "disable-wg"], ["mtls", "wireguard"]),
    mode("root.import", ["import"], "import", "client/cli/import.go", 30,
      "Import an operator configuration", ["path"]),
    mode("root.version", ["version"], "version", "client/cli/version.go", 28,
      "Print the local client version"),
    mode("root.console", ["console"], "console", "client/cli/console.go", 35,
      "Start the interactive console explicitly", ["rc", "enable-wg", "disable-wg"], ["mtls", "wireguard"]),
    mode("root.mcp", ["mcp"], "mcp", "client/cli/mcp.go", 33,
      "Start the client MCP stdio server", ["config", "enable-wg", "disable-wg"], ["mtls", "wireguard"]),
    mode("root.implant", ["implant"], "implant", "client/cli/implant.go", 33,
      "Invoke an implant command from the operator shell", ["use", "enable-wg", "disable-wg"], ["mtls", "wireguard"]),
  ];
}

function bootstrapAnnotations(commands) {
  return {
    schemaVersion: 1,
    baselineCommit: baseline.commit,
    reviewVersion: 1,
    reviewPolicy: "Every generated reachable node has an explicit product classification. Regeneration never edits this file.",
    scopeDecisions: [
      {
        id: "operator-transport.wireguard",
        status: "deferred",
        milestone: "post-M0",
        operatorScope: true,
        notes: "WireGuard-enabled operator configurations and packaged helper certification are explicitly deferred; mTLS remains the M0 operator transport baseline. Implant-side WireGuard workflows retain their independently assigned roadmap status."
      }
    ],
    commands: commands.map(annotationFor),
  };
}

function annotationFor(command) {
  const classification = classify(command);
  return {
    id: command.id,
    operatorScope: classification.operatorScope,
    status: classification.status,
    milestone: classification.milestone,
    restrictionReview: command.restrictions,
    restrictionEvidenceReview: command.restrictionEvidence,
    meaningfulModes: command.restrictions.targetModes,
    meaningfulOptions: command.options.map((option) => option.name),
    dependencies: dependenciesFor(command),
    guiSurface: classification.guiSurface,
    testIds: testIdsFor(command),
    notes: classification.notes,
  };
}

function classify(command) {
  const id = command.id;
  const top = command.path[0] ?? "";
  if (id === "server.clean" || id.startsWith("server.certificates")) {
    return decision(false, "operator-out-of-scope", "none", "none",
      "Administrative security inventory or bulk destructive cleanup is excluded by the operator scope contract.");
  }
  if (id.startsWith("server.taskmany")) {
    return decision(false, "upstream-blocked", "M9", "none",
      "The registered upstream taskmany tree is currently nonfunctional and is not reproduced as a GUI command passthrough.");
  }
  if (id === "root.implant" || id === "server.exit") {
    return decision(false, "operator-out-of-scope", "none", "none",
      "Terminal invocation and shell lifecycle behavior are not GUI parity requirements; underlying workflows are classified separately.");
  }
  if (id === "root.default-console" || id === "root.console") {
    return decision(true, "complete", "M0", "connection", "The GUI replaces the interactive-console entry mode with a native application shell.");
  }
  if (id === "root.import" || id === "root.version") {
    return decision(true, "in-progress", "M0", "connection", "Current M0 local-client workflow requires final lifecycle or compatibility coverage.");
  }
  if (id === "root.mcp") return decision(true, "planned", "M8", "integrations", "Client MCP parity is planned as a policy-gated integration.");

  const m1OperationOverrides = new Map([
    ["implant.ping", "Pulled forward into M1 as the closed target.ping representative read for synchronous sessions and asynchronous beacon tasks."],
    ["implant.env.set", "Pulled forward into M1 as a closed environment-mutation proof; the broader environment listing workflow remains assigned to M2."],
    ["implant.env.unset", "Pulled forward into M1 as a closed environment-mutation proof; the broader environment listing workflow remains assigned to M2."],
    ["implant.interactive", "M1 exposes the typed beacon.open-session operation only; it does not provide an arbitrary implant RPC selector."],
    ["implant.reconfig", "M1 exposes the typed beacon.reconfigure operation only; it does not provide an arbitrary implant RPC selector."],
  ]);
  const m1OperationNote = m1OperationOverrides.get(id);
  if (m1OperationNote) {
    return decision(true, "in-progress", "M1", "targets", m1OperationNote);
  }

  const current = new Set(["jobs", "dns", "http", "https", "mtls", "stage-listener", "wg"]);
  if (command.surface === "server" && current.has(top)) {
    return decision(true, "in-progress", "M0", "jobs-listeners",
      "A current GUI slice exists but remains subject to M0 safety and application-coverage gates.");
  }

  const mappings = command.surface === "server" ? serverMilestone(top) : implantMilestone(top);
  if (mappings.status === "deferred") {
    return decision(true, "deferred", mappings.milestone, mappings.surface, mappings.notes);
  }
  return decision(true, "planned", mappings.milestone, mappings.surface, mappings.notes);
}

function serverMilestone(top) {
  const groups = [
    ["M1", "targets", ["sessions", "beacons", "use", "info"]],
    ["M5", "networking", ["wireguard", "socks", "socks5", "wg-config"]],
    ["M6", "operator-data", ["loot", "creds", "hosts", "reaction", "monitor", "crack", "websites", "c2profiles", "operators"]],
    ["M7", "payloads", ["generate", "profiles", "implants", "builders", "regenerate", "shellcode-encoders", "shikata-ga-nai", "c2profiles"]],
    ["M8", "extensions", ["alias", "aliases", "extensions", "armory", "aka", "ai", "mcp", "settings", "docs", "licenses", "update", "version"]],
  ];
  for (const [milestone, surface, names] of groups) {
    if (names.includes(top)) return { milestone, surface, status: "planned", notes: `Registered server workflow assigned to ${milestone}.` };
  }
  return { milestone: "M9", surface: "long-tail", status: "deferred", notes: "Reachable long-tail server workflow requires explicit M9 implementation and certification." };
}

function implantMilestone(top) {
  const groups = [
    ["M1", "targets", ["background", "close", "info", "interactive", "kill", "reconfig", "rename", "tasks"]],
    ["M2", "target-workbench", ["cat", "cd", "chmod", "chown", "chtimes", "cp", "download", "edit", "env", "getgid", "getpid", "getuid", "grep", "head", "hex-edit", "ifconfig", "ls", "memfiles", "mkdir", "mount", "mv", "netstat", "ping", "procdump", "ps", "pwd", "registry", "rm", "screenshot", "services", "tail", "upload", "whoami"]],
    ["M3", "streams", ["shell", "portfwd", "rportfwd", "socks5"]],
    ["M4", "execution", ["backdoor", "dllhijack", "execute", "execute-assembly", "execute-shellcode", "getprivs", "getsystem", "impersonate", "make-token", "migrate", "msf", "msf-inject", "psexec", "rev2self", "runas", "sideload", "spawndll", "ssh", "terminate"]],
    ["M5", "networking", ["pivots", "wg-portfwd", "wg-socks"]],
    ["M8", "extensions", ["extensions", "wasm", "aka", "ai", "docs"]],
  ];
  for (const [milestone, surface, names] of groups) {
    if (names.includes(top)) return { milestone, surface, status: "planned", notes: `Registered implant workflow assigned to ${milestone}.` };
  }
  return { milestone: "M9", surface: "long-tail", status: "deferred", notes: "Reachable long-tail implant workflow requires explicit M9 implementation and certification." };
}

function decision(operatorScope, status, milestone, guiSurface, notes) {
  return { operatorScope, status, milestone, guiSurface, notes };
}

function dependenciesFor(command) {
  if (command.surface === "root") {
    return command.id === "root.version" ? ["local-client-state"] : ["operator-config"];
  }
  const dependencies = ["compatible-server"];
  if (command.surface === "implant") dependencies.push("active-target");
  if (command.restrictions.targetModes.length === 1 && command.restrictions.targetModes[0] !== "not-applicable") {
    dependencies.push(`${command.restrictions.targetModes[0]}-target`);
  }
  if (command.restrictions.targetOperatingSystems.length === 1 && command.restrictions.targetOperatingSystems[0] !== "not-applicable") {
    dependencies.push(`${command.restrictions.targetOperatingSystems[0]}-target`);
  }
  if (command.restrictions.transports.length === 1 && command.restrictions.transports[0] !== "any") {
    dependencies.push(`${command.restrictions.transports[0]}-transport`);
  }
  return [...new Set(dependencies)].sort();
}

function testIdsFor(command) {
  const prefix = command.id.startsWith("server.taskmany")
    ? "upstream-regression"
    : command.id === "server.clean" || command.id.startsWith("server.certificates") ||
      command.id === "root.implant" || command.id === "server.exit"
      ? "scope-denial"
      : "parity-contract";
  const contract = `${prefix}:${command.id}`;
  if (command.id === "root.import") return [contract, "saved-config-catalog", "connection-registry-saved-config"];
  if (command.id.startsWith("server.jobs")) return [contract, "operations-job", "operations-page"];
  if (command.id.startsWith("server.generate")) return [contract, "generate-page", "implant-config"];
  return [contract];
}

function renderReport(generated, annotations) {
  const byId = new Map(annotations.commands.map((entry) => [entry.id, entry]));
  const lines = [
    "# Operator parity report",
    "",
    `Baseline: \`${generated.baseline.commit}\` (tree \`${generated.baseline.tree}\`)`,
    "",
    "This report merges deterministic command discovery with reviewed product annotations. Third-party alias and extension names are audited dynamically and are not static requirements. `parity-contract:*`, `scope-denial:*`, and `upstream-regression:*` values are stable test contract IDs; their presence assigns coverage and does not claim the test has passed.",
    "",
    "## Scope decisions",
    "",
  ];
  for (const decision_ of annotations.scopeDecisions ?? []) {
    lines.push(`- **${decision_.id}** — ${decision_.status} (${decision_.milestone}): ${decision_.notes}`);
  }
  lines.push("", "## Dynamic audit", "",
    `Representative alias \`${generated.dynamicAudit.representativeAlias}\` and extension \`${generated.dynamicAudit.representativeExtension}\` registered ${generated.dynamicAudit.addedNodes.length} dynamic nodes without entering the static command inventory.`,
    "", "## Reachable command inventory", "",
    "| ID | Status | Milestone | Target modes | Target OS | GUI surface | Tests |",
    "| --- | --- | --- | --- | --- | --- | --- |");
  for (const command of generated.commands) {
    const annotation = byId.get(command.id);
    if (!annotation) throw new Error(`Missing reviewed annotation for report: ${command.id}`);
    lines.push(`| \`${command.id}\` | ${annotation.status} | ${annotation.milestone} | ${annotation.restrictionReview.targetModes.join(", ")} | ${annotation.restrictionReview.targetOperatingSystems.join(", ")} | ${annotation.guiSurface} | ${annotation.testIds.join(", ") || "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function compareInventories(previous, candidate) {
  const oldById = new Map(previous.commands.map((command) => [command.id, command]));
  const newById = new Map(candidate.commands.map((command) => [command.id, command]));
  const added = [...newById.keys()].filter((id) => !oldById.has(id)).sort();
  const removed = [...oldById.keys()].filter((id) => !newById.has(id)).sort();
  const renamed = [];
  const removedBySymbol = new Map(removed.map((id) => [oldById.get(id).source.symbol, id]));
  for (const id of added) {
    const oldId = removedBySymbol.get(newById.get(id).source.symbol);
    if (oldId) renamed.push({ from: oldId, to: id });
  }
  const reGated = [...newById.keys()].filter((id) => oldById.has(id) &&
    oldById.get(id).gateFingerprint !== newById.get(id).gateFingerprint).sort();
  return { added, removed, renamed, reGated };
}

function runDump(stagedSource, clientRoot, goCache) {
  const stdout = execFileSync("go", ["run", "-mod=vendor", "./tools/parity-dump"], {
    cwd: stagedSource,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      GOCACHE: goCache,
      GOTOOLCHAIN: `go${baseline.toolchain.go}`,
      SLIVER_CLIENT_ROOT_DIR: clientRoot,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(stdout);
}

function verifyGoToolchain() {
  const version = execFileSync("go", ["version"], {
    encoding: "utf8",
    env: { ...process.env, GOTOOLCHAIN: `go${baseline.toolchain.go}` },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!version.startsWith(`go version go${baseline.toolchain.go} `)) {
    throw new Error(`Go toolchain drift: expected ${baseline.toolchain.go}, received ${version}`);
  }
}

function stageSource(source, destination) {
  execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", source, destination], { stdio: "inherit" });
  execFileSync("git", ["checkout", "--quiet", "--detach", baseline.commit], { cwd: destination, stdio: "inherit" });
}

async function createDynamicFixtures(root) {
  const aliasDirectory = join(root, "aliases/parity-alias");
  const extensionDirectory = join(root, "extensions/parity-extension");
  await mkdir(join(aliasDirectory, "payload"), { recursive: true });
  await mkdir(join(extensionDirectory, "payload"), { recursive: true });
  await writeFile(join(aliasDirectory, "payload/parity.dll"), "fixture", "utf8");
  await writeFile(join(extensionDirectory, "payload/parity.dll"), "fixture", "utf8");
  await writeFile(join(aliasDirectory, "alias.json"), JSON.stringify({
    name: "parity-alias", command_name: "parity-alias", version: "1.0.0",
    help: "Parity generator fixture", entrypoint: "ParityAlias", allow_args: true,
    files: [{ os: "windows", arch: "amd64", path: "payload/parity.dll" }],
  }), "utf8");
  await writeFile(join(extensionDirectory, "extension.json"), JSON.stringify({
    name: "parity-extension", version: "1.0.0", extension_author: "sliver-gui",
    original_author: "sliver-gui", repo_url: "https://example.invalid/parity-fixture",
    commands: [{ command_name: "parity-extension", help: "Parity generator fixture",
      entrypoint: "ParityExtension", files: [{ os: "windows", arch: "amd64", path: "payload/parity.dll" }] }],
  }), "utf8");
}

async function verifySource(source) {
  const commit = git(source, ["rev-parse", "HEAD"]);
  const tree = git(source, ["rev-parse", "HEAD^{tree}"]);
  if (commit !== baseline.commit || tree !== baseline.tree) {
    throw new Error(`Source is not the locked Sliver baseline: ${commit} ${tree}`);
  }
  const dirty = git(source, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (dirty) throw new Error(`Pinned source has tracked changes:\n${dirty}`);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function assertSame(path, expected, label) {
  const actual = await readFile(path, "utf8").catch(() => undefined);
  if (actual !== expected) {
    if (path === generatedPath && actual) {
      try {
        console.error(JSON.stringify(compareInventories(JSON.parse(actual), JSON.parse(expected)), null, 2));
      } catch {
        // The byte-level error below remains authoritative when a malformed file cannot be compared.
      }
    }
    throw new Error(`${label} drifted; regenerate ${basename(path)}`);
  }
}

function commandKey(command) {
  return `${command.surface}.${command.path.join(".")}`;
}

function compareCommands(left, right) {
  return left.id.localeCompare(right.id);
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableJSON(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseArguments(values) {
  const result = { source: undefined, check: false, bootstrapAnnotations: false, force: false, compare: undefined };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source") result.source = values[++index];
    else if (value === "--check") result.check = true;
    else if (value === "--bootstrap-annotations") result.bootstrapAnnotations = true;
    else if (value === "--force") result.force = true;
    else if (value === "--compare") result.compare = values[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}
