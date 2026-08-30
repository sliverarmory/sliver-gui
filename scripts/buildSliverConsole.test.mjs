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
  targetForHost,
  targetSlices,
  validateGoBuildInfo,
  verifyPinnedCheckout,
} from "./buildSliverConsole.mjs";

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
  const args = goBuildArguments("/tmp/output/sliver-client");
  assert.deepEqual(args.slice(0, 5), ["build", "-mod=vendor", "-trimpath", "-tags", "go_sqlite,client"]);
  assert.equal(args.at(-1), "./client");
  assert.equal(args.at(-2), "/tmp/output/sliver-client");
  assert.match(args[6], /DefaultArmoryPublicKey/u);
  assert.match(args[6], /DefaultArmoryRepoURL/u);
  assert.match(args[6], /SliverPublicKey/u);
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

test("emits a digest-bound native artifact and build record", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-console-script-test-"));
  const sourceDirectory = join(temporaryDirectory, "source");
  const outputDirectory = join(temporaryDirectory, "output");
  await mkdir(sourceDirectory);
  const license = Buffer.from("test Sliver license\n");
  await writeFile(join(sourceDirectory, "LICENSE"), license);

  const pinnedCommit = "ca685f5eed64c3327c0e57504928cfd2d2e96bea";
  const pinnedTree = "25e1385fa1fe6e0a7e41606e426b1c1d0cd320b1";
  const goEnvironments = [];
  const run = async (command, args, options = {}) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "git rev-parse --show-toplevel") return `${sourceDirectory}\n`;
    if (key === "git rev-parse HEAD") return `${pinnedCommit}\n`;
    if (key === "git rev-parse HEAD^{tree}") return `${pinnedTree}\n`;
    if (key === "git status --porcelain=v1 --untracked-files=all") return "";
    if (command === "go") goEnvironments.push(options.env);
    if (key === "go env GOVERSION") return "go1.26.6\n";
    if (command === "go" && args[0] === "build") {
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
        build: { tags: ["go_sqlite", "client"] },
      },
    });
    const bytes = await readFile(finalPath);
    const writtenRecord = JSON.parse(await readFile(join(outputDirectory, "provenance.json"), "utf8"));
    assert.equal(record.artifact.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(record.artifact.size, bytes.byteLength);
    assert.equal(record.build.target, "linux-amd64");
    assert.equal(record.build.slices[0].buildInfo.vcsRevision, pinnedCommit);
    assert.deepEqual(writtenRecord, record);
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
