import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BeagleService } from "../main/beagle-service.js";
import { createBeagleRuntime, type BeagleRuntimeClient } from "../main/beagle-runtime.js";
import { captureBeagleExecutable } from "../main/beagle-runtime-loader.js";
import type { BeagleRuntimeCommand } from "../shared/beagle-runtime-contracts.js";

test("real persistent helper preserves typed data, project isolation and database state", { timeout: 120_000 }, async () => {
  const binary = process.env["SLIVER_BEAGLE_E2E_BINARY"];
  assert.ok(binary, "Set SLIVER_BEAGLE_E2E_BINARY to an absolute Beagle executable with helper-stdio");
  const identity = await captureBeagleExecutable(binary);
  const root = await mkdtemp(join(tmpdir(), "beagle-helper-e2e-"));
  const clients: BeagleRuntimeClient[] = [];
  const commands: BeagleRuntimeCommand[] = [];
  const service = new BeagleService({
    userDataPath: root,
    environment: { SLIVER_BEAGLE_BINARY: identity.path, SLIVER_BEAGLE_SHA256: identity.sha256,
      AWS_SECRET_ACCESS_KEY: "must-not-reach-helper", GRAPHQLITE_EXTENSION: "/not-an-extension", NODE_OPTIONS: "--invalid" },
    createRuntime(executable, options) {
      for (const key of ["AWS_SECRET_ACCESS_KEY", "GRAPHQLITE_EXTENSION", "NODE_OPTIONS", "PATH", "SLIVER_BEAGLE_BINARY", "SLIVER_BEAGLE_SHA256"]) {
        assert.equal(options.env[key], undefined);
      }
      const client = createBeagleRuntime(executable, options);
      clients.push(client);
      return { ready: client.ready, get closed() { return client.closed; }, stop: () => client.stop(),
        request(command, requestOptions) { commands.push(command); return client.request(command, requestOptions); } };
    },
  });
  try {
    const initial = await service.getState();
    assert.equal(initial.runtime.available, true, initial.runtime.error ?? "Beagle must be available");
    assert.equal(initial.stats?.nodes, 0);
    assert.equal(clients.length, 2, "one disposable capability probe and one project helper");
    assert.equal(clients[0]!.closed, true);
    const catalog = await service.getQueries();
    assert.equal(catalog.length, 177);
    assert.deepEqual(await service.getQueries(), catalog);
    assert.equal(commands.filter((command) => command.type === "catalog").length, 1);
    const literal = "'; --db=/somewhere $(echo never)\nUnicode: λ";
    assert.deepEqual((await service.query({ cypher: "RETURN $value AS value", parameters: { value: literal } })).rows, [{ value: literal }]);
    await assert.rejects(service.query({ cypher: "THIS IS NOT CYPHER" }));
    await assert.rejects(service.query({ cypher: "CREATE (n:Unwanted) RETURN n" }));
    assert.throws(() => service.query({ cypher: "LOAD CSV FROM '/private/file' AS row RETURN row" }), /File access/u);
    assert.equal((await service.getState()).stats?.nodes, 0);
    await service.runSavedQuery({ id: catalog[0]!.id, parameters: {} });

    const users = join(root, "users.json");
    const groups = join(root, "groups.json");
    await writeFile(users, JSON.stringify({ meta: { type: "users", version: 6, count: 1 }, data: [
      { ObjectIdentifier: "USER", Properties: { name: "ALICE@LAB.LOCAL", enabled: true } },
    ] }));
    await writeFile(groups, JSON.stringify({ meta: { type: "groups", version: 6, count: 1 }, data: [
      { ObjectIdentifier: "GROUP", Properties: { name: "TEAM@LAB.LOCAL" }, Members: [{ ObjectIdentifier: "USER", ObjectType: "User" }] },
    ] }));
    assert.equal((await service.importFiles([users, groups])).state.stats?.nodes, 2);
    const entity = await service.entity({ objectid: "USER" });
    assert.equal(entity.graph.nodes[0]?.objectid, "USER", JSON.stringify(entity));
    assert.equal((await service.search({ term: "ALICE" })).totalRows, 1);
    assert.equal((await service.paths({ source: "USER", target: "GROUP", maxHops: 3 })).totalRows, 1);
    assert.equal((await service.compose({ source: "USER", target: "GROUP", kind: "MemberOf" })).graph.edges.length, 0);
    await service.tag({ objectid: "USER", tag: "owned", enabled: true });
    await service.analyze();
    assert.deepEqual((await service.query({ cypher: "MATCH (n:Tag_Owned) RETURN n.objectid AS id" })).rows, [{ id: "USER" }]);
    const snapshot = await service.exportGraph();
    assert.equal(snapshot.nodes.length, 2);
    assert.equal(snapshot.edges.length, 1);
    assert.equal(clients.length, 2, "all operations reuse the active project helper");

    const other = await service.createProject({ name: "Isolated project" });
    assert.equal(other.stats?.nodes, 0);
    assert.equal(clients[1]!.closed, true, "the old helper exits before opening the next database");
    assert.equal(clients.length, 3);
    await service.selectProject({ id: initial.selectedProjectId });
    assert.equal(clients[2]!.closed, true);
    assert.deepEqual(await service.exportGraph(), snapshot);
    assert.equal(clients.length, 4);
    // An exited helper is replaced for the next explicit request without replaying earlier work.
    await clients[3]!.stop();
    assert.deepEqual(await service.exportGraph(), snapshot);
    assert.equal(clients.length, 5);
    assert.equal(commands.filter((command) => command.type === "ingest").length, 1);
    assert.equal(commands.filter((command) => command.type === "tag").length, 1);
    await service.dispose();
    assert.ok(clients.every((client) => client.closed));
    const configuration = JSON.parse(await readFile(join(root, "beagle", "projects.json"), "utf8")) as { version: number; projects: unknown[] };
    assert.equal(configuration.version, 2);
    assert.equal(configuration.projects.length, 2);
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
