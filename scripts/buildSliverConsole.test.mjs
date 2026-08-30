import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSliverConsole,
  goBuildArguments,
  hermeticGoEnvironment,
  ROOT_DIRECTORY,
  SLIVER_CLIENT_LINKER_DEFAULTS,
  SOURCE_MANIFEST_PATH,
  targetForHost,
  targetSlices,
  validateGoBuildInfo,
  validateMinisignPublicKey,
  validatePinnedClientLinkerDefaults,
  verifyPackagedSourceOverlayFiles,
  verifyPinnedCheckout,
  verifySourceOverlay,
  verifySourceOverlayReplacements,
} from "./buildSliverConsole.mjs";

const SLIVER_PUBLIC_KEY = "RWTZPg959v3b7tLG7VzKHRB1/QT+d3c71Uzetfa44qAoX5rH7mGoQTTR";
const ARMORY_PUBLIC_KEY = "RWSBpxpRWDrD7Fe+VvRE3c2VEDC2NK80rlNCj+BX0gz44Xw07r6KQD9L";
const ARMORY_REPOSITORY = "https://api.github.com/repos/sliverarmory/armory/releases";
const CLIENT_MAKEFILE_DEFAULTS = [
  `SLIVER_PUBLIC_KEY ?= ${SLIVER_PUBLIC_KEY}`,
  `ARMORY_PUBLIC_KEY ?= ${ARMORY_PUBLIC_KEY}`,
  `ARMORY_REPO_URL ?= ${ARMORY_REPOSITORY}`,
  "",
].join("\n");
const GUI_CORRESPONDING_SOURCE = {
  repository: "https://github.com/sliverarmory/sliver-gui",
  packageVersion: "0.1.0",
  tag: "v0.1.0",
  archive: "https://github.com/sliverarmory/sliver-gui/archive/refs/tags/v0.1.0.tar.gz",
};

const manifest = {
  source: {
    commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tree: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
};

test("maps supported package hosts to exact native targets", () => {
  assert.equal(targetForHost("darwin"), "darwin-universal");
  assert.equal(targetForHost("linux"), "linux-amd64");
  assert.equal(targetForHost("win32"), "windows-amd64");
  assert.deepEqual(targetSlices("darwin-universal"), [
    { goos: "darwin", goarch: "amd64" },
    { goos: "darwin", goarch: "arm64" },
  ]);
  assert.throws(() => targetForHost("freebsd"), /does not support/u);
});

test("build arguments retain upstream client tags, vendoring, stripping, and entrypoint", () => {
  const overlayPath = join(tmpdir(), "verified-sliver-console-overlay.json");
  const args = goBuildArguments("/tmp/output/sliver-client", overlayPath);
  assert.deepEqual(args.slice(0, 7), [
    "build",
    "-mod=vendor",
    "-trimpath",
    "-overlay",
    overlayPath,
    "-tags",
    "go_sqlite,client",
  ]);
  assert.equal(args.at(-1), "./client");
  assert.equal(args.at(-2), "/tmp/output/sliver-client");
  const linkerFlags = args[args.indexOf("-ldflags") + 1];
  assert.ok(linkerFlags.includes(`DefaultArmoryPublicKey=${ARMORY_PUBLIC_KEY}`));
  assert.ok(linkerFlags.includes(`DefaultArmoryRepoURL=${ARMORY_REPOSITORY}`));
  assert.ok(linkerFlags.includes(`SliverPublicKey=${SLIVER_PUBLIC_KEY}`));
  assert.throws(() => goBuildArguments("/tmp/output/sliver-client"), /requires an absolute verified Go overlay/u);
});

test("checked-in overlays retain the reviewed explicit-profile and private-transcript contracts", async () => {
  const sourceManifest = JSON.parse(await readFile(SOURCE_MANIFEST_PATH, "utf8"));
  const packageManifest = JSON.parse(await readFile(join(ROOT_DIRECTORY, "package.json"), "utf8"));
  const verified = await verifySourceOverlayReplacements({ sourceManifest });
  assert.equal(verified.record.correspondingSource.packageVersion, packageManifest.version);
  assert.deepEqual(verified.record.files.map(({ sourcePath }) => sourcePath), [
    "client/cli/config.go",
    "client/cli/console.go",
    "client/console/console.go",
  ]);

  const [configOverlay, runnerOverlay, consoleOverlay] = await Promise.all(
    verified.record.files.map(({ replacementPath }) => readFile(join(ROOT_DIRECTORY, replacementPath), "utf8")),
  );
  assert.ok(configOverlay.indexOf('os.Getenv(sliverClientConfigEnv)') < configOverlay.indexOf("assets.GetConfigs()"));
  assert.match(configOverlay, /const sliverClientConfigEnv = "SLIVER_CLIENT_CONFIG"/u);
  assert.match(
    runnerOverlay,
    /if os\.Getenv\(sliverClientConfigEnv\) == "" \{\s+configs := assets\.GetConfigs\(\)/u,
  );
  assert.match(consoleOverlay, /os\.Getenv\("SLIVER_CLIENT_DISABLE_CONSOLE_LOGS"\) == "1"/u);
  assert.match(consoleOverlay, /historyFile := os\.Getenv\("SLIVER_CLIENT_HISTORY_FILE"\)/u);
});

test("rejects malformed Minisign keys and linker defaults that drift from pinned Sliver", () => {
  assert.equal(validateMinisignPublicKey(ARMORY_PUBLIC_KEY), ARMORY_PUBLIC_KEY);
  assert.throws(
    () => validateMinisignPublicKey("RWSBpxpRWDr7Fe+VvRE3c2VEDC2NK80rlNCj+BX0gz44Xw07r6KQD9L"),
    /canonical 42-byte Minisign public key/u,
  );
  assert.doesNotThrow(() => validatePinnedClientLinkerDefaults(CLIENT_MAKEFILE_DEFAULTS));
  assert.throws(
    () => validatePinnedClientLinkerDefaults(CLIENT_MAKEFILE_DEFAULTS.replace("RWDrD7Fe", "RWDr7Fe")),
    /ARMORY_PUBLIC_KEY/u,
  );
});

test("clears hostile inherited Go configuration and workspace overrides", () => {
  const environment = hermeticGoEnvironment({
    PATH: "/trusted/bin",
    GOCACHE: "/trusted/cache",
    GOENV: "/tmp/hostile-go-env",
    GOEXPERIMENT: "fieldtrack",
    GOFLAGS: "-overlay=/tmp/hostile-overlay.json -toolexec=/tmp/hostile-tool",
    GOTOOLCHAIN: "auto",
    GOWORK: "/tmp/hostile.work",
  }, { goos: "linux", goarch: "amd64" });
  assert.deepEqual(environment, {
    PATH: "/trusted/bin",
    GOCACHE: "/trusted/cache",
    CGO_ENABLED: "0",
    GOENV: "off",
    GOFLAGS: "",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
    GOARCH: "amd64",
    GOOS: "linux",
  });
});

test("requires exact module, VCS, target, and build settings", () => {
  const sourceManifest = {
    source: {
      commandPackage: "github.com/bishopfox/sliver/client",
      commit: "ca685f5eed64c3327c0e57504928cfd2d2e96bea",
      module: "github.com/bishopfox/sliver",
    },
    build: { tags: ["go_sqlite", "client"] },
  };
  const slice = { goos: "linux", goarch: "amd64" };
  const buildInfo = [
    "/tmp/sliver-client: go1.26.6",
    "\tpath\tgithub.com/bishopfox/sliver/client",
    "\tmod\tgithub.com/bishopfox/sliver\tv1.7.7",
    "\tbuild\t-tags=go_sqlite,client",
    "\tbuild\t-trimpath=true",
    "\tbuild\tCGO_ENABLED=0",
    "\tbuild\tGOARCH=amd64",
    "\tbuild\tGOOS=linux",
    "\tbuild\tvcs=git",
    `\tbuild\tvcs.revision=${sourceManifest.source.commit}`,
    "\tbuild\tvcs.modified=false",
    "",
  ].join("\n");
  assert.deepEqual(validateGoBuildInfo(buildInfo, { sourceManifest, slice }), {
    commandPackage: sourceManifest.source.commandPackage,
    module: sourceManifest.source.module,
    vcsRevision: sourceManifest.source.commit,
    vcsModified: false,
  });
  assert.throws(
    () => validateGoBuildInfo(buildInfo.replace("GOARCH=amd64", "GOARCH=arm64"), { sourceManifest, slice }),
    /GOARCH is arm64, expected amd64/u,
  );
  assert.throws(
    () => validateGoBuildInfo(buildInfo.replace("vcs.modified=false", "vcs.modified=true"), { sourceManifest, slice }),
    /vcs.modified is true, expected false/u,
  );
});

test("accepts only the exact clean pinned source checkout", async () => {
  const replies = new Map([
    ["rev-parse --show-toplevel", "/checkout/sliver\n"],
    ["rev-parse HEAD", `${manifest.source.commit}\n`],
    ["rev-parse HEAD^{tree}", `${manifest.source.tree}\n`],
    ["status --porcelain=v1 --untracked-files=all", ""],
  ]);
  const run = async (_command, args) => replies.get(args.join(" ")) ?? "";
  await verifyPinnedCheckout({ sourceDirectory: "/checkout/sliver", sourceManifest: manifest, run });
});

test("rejects source drift and dirty source", async () => {
  const runWith = (overrides) => async (_command, args) => {
    const defaults = {
      "rev-parse --show-toplevel": "/checkout/sliver\n",
      "rev-parse HEAD": `${manifest.source.commit}\n`,
      "rev-parse HEAD^{tree}": `${manifest.source.tree}\n`,
      "status --porcelain=v1 --untracked-files=all": "",
    };
    return { ...defaults, ...overrides }[args.join(" ")] ?? "";
  };

  await assert.rejects(
    verifyPinnedCheckout({
      sourceDirectory: "/checkout/sliver",
      sourceManifest: manifest,
      run: runWith({ "rev-parse HEAD": "cccccccccccccccccccccccccccccccccccccccc\n" }),
    }),
    /expected a{40}/u,
  );
  await assert.rejects(
    verifyPinnedCheckout({
      sourceDirectory: "/checkout/sliver",
      sourceManifest: manifest,
      run: runWith({ "status --porcelain=v1 --untracked-files=all": " M client/main.go\n" }),
    }),
    /must be clean/u,
  );
});

test("verifies digest-bound source overlay inputs without modifying the pinned checkout", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-console-overlay-test-"));
  const sourceDirectory = join(temporaryDirectory, "source");
  const repositoryDirectory = join(temporaryDirectory, "repository");
  const sourcePath = "client/cli/config.go";
  const replacementPath = "protocol/sliver-console-overlay/client/cli/config.go";
  const baseContent = Buffer.from("package cli\n\nfunc selectConfig() {}\n");
  const replacementContent = Buffer.from("package cli\n\nfunc selectConfig() { useExplicitConfig() }\n");
  const absoluteSourcePath = join(sourceDirectory, sourcePath);
  const absoluteReplacementPath = join(repositoryDirectory, replacementPath);
  const overlay = {
    format: "go-build-overlay-v1",
    correspondingSource: GUI_CORRESPONDING_SOURCE,
    files: [{
      sourcePath,
      replacementPath,
      baseSha256: createHash("sha256").update(baseContent).digest("hex"),
      sha256: createHash("sha256").update(replacementContent).digest("hex"),
      review: "Test reviewed overlay",
    }],
  };

  try {
    await Promise.all([
      mkdir(join(sourceDirectory, "client/cli"), { recursive: true }),
      mkdir(join(repositoryDirectory, "protocol/sliver-console-overlay/client/cli"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(absoluteSourcePath, baseContent),
      writeFile(absoluteReplacementPath, replacementContent),
    ]);
    const verified = await verifySourceOverlay({
      sourceDirectory,
      repositoryDirectory,
      sourceManifest: { build: { overlay } },
    });
    assert.deepEqual(verified.record, overlay);
    assert.deepEqual(verified.replacements, { [absoluteSourcePath]: absoluteReplacementPath });

    await writeFile(absoluteReplacementPath, "drifted replacement\n");
    await assert.rejects(
      verifySourceOverlay({
        sourceDirectory,
        repositoryDirectory,
        sourceManifest: { build: { overlay } },
      }),
      /replacement hash drifted/u,
    );
    await writeFile(absoluteReplacementPath, replacementContent);
    await assert.rejects(
      verifySourceOverlay({
        sourceDirectory,
        repositoryDirectory,
        sourceManifest: {
          build: {
            overlay: {
              ...overlay,
              files: [{ ...overlay.files[0], replacementPath: "../outside.go" }],
            },
          },
        },
      }),
      /escapes its trusted root/u,
    );
    await assert.rejects(
      verifySourceOverlay({
        sourceDirectory,
        repositoryDirectory,
        sourceManifest: {
          build: {
            overlay: {
              ...overlay,
              files: [...overlay.files, { ...overlay.files[0] }],
            },
          },
        },
      }),
      /duplicate path/u,
    );
    await writeFile(absoluteSourcePath, "drifted base\n");
    await assert.rejects(
      verifySourceOverlay({
        sourceDirectory,
        repositoryDirectory,
        sourceManifest: { build: { overlay } },
      }),
      /base hash drifted/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("requires exact packaged corresponding-source files for the Sliver console overlay", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-console-packaged-overlay-test-"));
  const packagedDirectory = join(temporaryDirectory, "sliver-console");
  const sourcePath = "client/cli/config.go";
  const replacementPath = `protocol/sliver-console-overlay/${sourcePath}`;
  const content = Buffer.from("package cli\n\n// Reviewed packaged source overlay.\n");
  const overlay = {
    format: "go-build-overlay-v1",
    correspondingSource: GUI_CORRESPONDING_SOURCE,
    files: [{
      sourcePath,
      replacementPath,
      baseSha256: "a".repeat(64),
      sha256: createHash("sha256").update(content).digest("hex"),
      review: "Test packaged source overlay",
    }],
  };
  const packagedSourcePath = join(packagedDirectory, "source-overlay", ...sourcePath.split("/"));

  try {
    await mkdir(join(packagedDirectory, "source-overlay", "client", "cli"), { recursive: true });
    await writeFile(packagedSourcePath, content);
    await verifyPackagedSourceOverlayFiles({
      packagedDirectory,
      sourceOverlay: overlay,
      buildOverlay: overlay,
    });

    await writeFile(packagedSourcePath, "tampered source overlay\n");
    await assert.rejects(
      verifyPackagedSourceOverlayFiles({
        packagedDirectory,
        sourceOverlay: overlay,
        buildOverlay: overlay,
      }),
      /source overlay digest changed/u,
    );

    await rm(packagedSourcePath, { force: true });
    await assert.rejects(
      verifyPackagedSourceOverlayFiles({
        packagedDirectory,
        sourceOverlay: overlay,
        buildOverlay: overlay,
      }),
      /missing source overlay file/u,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("emits a digest-bound native artifact and build record", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-console-script-test-"));
  const sourceDirectory = join(temporaryDirectory, "source");
  const repositoryDirectory = join(temporaryDirectory, "repository");
  const outputDirectory = join(temporaryDirectory, "output");
  await mkdir(sourceDirectory);
  const license = Buffer.from("test Sliver license\n");
  const overlayBase = Buffer.from("package cli\n\nfunc selectConfig() {}\n");
  const overlayReplacement = Buffer.from("package cli\n\nfunc selectConfig() { useExplicitConfig() }\n");
  const overlaySourcePath = "client/cli/config.go";
  const overlayReplacementPath = "protocol/sliver-console-overlay/client/cli/config.go";
  const sourceOverlay = {
    format: "go-build-overlay-v1",
    correspondingSource: GUI_CORRESPONDING_SOURCE,
    files: [{
      sourcePath: overlaySourcePath,
      replacementPath: overlayReplacementPath,
      baseSha256: createHash("sha256").update(overlayBase).digest("hex"),
      sha256: createHash("sha256").update(overlayReplacement).digest("hex"),
      review: "Test reviewed overlay",
    }],
  };
  await Promise.all([
    mkdir(join(sourceDirectory, "client/cli"), { recursive: true }),
    mkdir(join(repositoryDirectory, "protocol/sliver-console-overlay/client/cli"), { recursive: true }),
  ]);
  await writeFile(join(sourceDirectory, "LICENSE"), license);
  await writeFile(join(sourceDirectory, "Makefile"), CLIENT_MAKEFILE_DEFAULTS);
  await writeFile(join(sourceDirectory, overlaySourcePath), overlayBase);
  await writeFile(join(repositoryDirectory, overlayReplacementPath), overlayReplacement);
  await writeFile(join(repositoryDirectory, "package.json"), '{"version":"0.1.0"}\n');

  const pinnedCommit = "ca685f5eed64c3327c0e57504928cfd2d2e96bea";
  const pinnedTree = "25e1385fa1fe6e0a7e41606e426b1c1d0cd320b1";
  const goEnvironments = [];
  const goOverlays = [];
  const run = async (command, args, options = {}) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "git rev-parse --show-toplevel") return `${sourceDirectory}\n`;
    if (key === "git rev-parse HEAD") return `${pinnedCommit}\n`;
    if (key === "git rev-parse HEAD^{tree}") return `${pinnedTree}\n`;
    if (key === "git status --porcelain=v1 --untracked-files=all") return "";
    if (command === "go") goEnvironments.push(options.env);
    if (key === "go env GOVERSION") return "go1.26.6\n";
    if (command === "go" && args[0] === "build") {
      const overlayPath = args[args.indexOf("-overlay") + 1];
      goOverlays.push(JSON.parse(await readFile(overlayPath, "utf8")));
      const outputPath = args[args.indexOf("-o") + 1];
      await writeFile(outputPath, "pinned-linux-client", { mode: 0o755 });
      await chmod(outputPath, 0o755);
      return "";
    }
    if (command === "go" && args[0] === "version" && args[1] === "-m") {
      return [
        `${args[2]}: go1.26.6`,
        "\tpath\tgithub.com/bishopfox/sliver/client",
        "\tmod\tgithub.com/bishopfox/sliver\tv1.7.7",
        "\tbuild\t-tags=go_sqlite,client",
        "\tbuild\t-trimpath=true",
        "\tbuild\tCGO_ENABLED=0",
        "\tbuild\tGOARCH=amd64",
        "\tbuild\tGOOS=linux",
        "\tbuild\tvcs=git",
        `\tbuild\tvcs.revision=${pinnedCommit}`,
        "\tbuild\tvcs.modified=false",
        "",
      ].join("\n");
    }
    throw new Error(`Unexpected command: ${key}`);
  };

  try {
    const { finalPath, record } = await buildSliverConsole({
      platform: "linux",
      sourceDirectory,
      repositoryDirectory,
      outputDirectory,
      goBinary: "go",
      environment: {
        PATH: "/trusted/bin",
        GOCACHE: "/trusted/cache",
        GOENV: "/tmp/hostile-go-env",
        GOEXPERIMENT: "fieldtrack",
        GOFLAGS: "-overlay=/tmp/hostile-overlay.json -toolexec=/tmp/hostile-tool",
        GOTOOLCHAIN: "auto",
        GOWORK: "/tmp/hostile.work",
      },
      run,
      sourceManifest: {
        schemaVersion: 1,
        source: {
          commit: pinnedCommit,
          tree: pinnedTree,
          module: "github.com/bishopfox/sliver",
          commandPackage: "github.com/bishopfox/sliver/client",
          licenseFile: "LICENSE",
          licenseSha256: createHash("sha256").update(license).digest("hex"),
        },
        toolchain: { go: "go1.26.6" },
        build: { tags: ["go_sqlite", "client"], overlay: sourceOverlay },
      },
    });
    const bytes = await readFile(finalPath);
    const writtenRecord = JSON.parse(await readFile(join(outputDirectory, "provenance.json"), "utf8"));
    assert.equal(record.artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(record.artifact.size, bytes.byteLength);
    assert.equal(record.build.target, "linux-amd64");
    assert.deepEqual(record.build.overlay, sourceOverlay);
    assert.deepEqual(record.build.linkerDefaults, SLIVER_CLIENT_LINKER_DEFAULTS);
    assert.equal(record.build.slices[0].buildInfo.vcsRevision, pinnedCommit);
    assert.deepEqual(writtenRecord, record);
    assert.deepEqual(goOverlays, [{
      Replace: {
        [join(sourceDirectory, overlaySourcePath)]: join(repositoryDirectory, overlayReplacementPath),
      },
    }]);
    assert.ok(goEnvironments.length >= 3);
    for (const environment of goEnvironments) {
      assert.equal(environment.GOENV, "off");
      assert.equal(environment.GOFLAGS, "");
      assert.equal(environment.GOTOOLCHAIN, "local");
      assert.equal(environment.GOWORK, "off");
      assert.equal(environment.GOEXPERIMENT, undefined);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
