import { describe, expect, it } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { DomainCollection, ManagedServerReference, SliverSnapshot } from "../../../shared/contracts";
import type { LocalRedirectorOverview } from "../../../shared/software-deployment-contracts";
import type { TopologyNode } from "../../../shared/topology-contracts";
import { createOverviewTopology } from "./overview-topology";
import { layoutTopology } from "./topology-layout";
import { topologyLayoutInput } from "./topology-layout-input";

const timestamp = "2026-09-24T12:00:00.000Z";
const installation: LocalRedirectorOverview = {
  id: "7bfdb74e-9267-4f14-a29c-c5fc858347ab",
  recipeId: "caddy", status: "active", publicUrl: "https://c2.example.test",
  publicIp: "203.0.113.10", domains: ["c2.example.test", "backup.example.test"],
  listener: { ownership: "managed", kind: "http", host: "127.0.0.1", port: 8000, jobId: 8, domain: "" },
  lastCheckedAt: timestamp,
};

function jobs(items: SliverSnapshot["domains"]["jobs"]["items"], status: DomainCollection<unknown>["status"] = "ready"): SliverSnapshot["domains"]["jobs"] {
  return { status, revision: 1, updatedAt: timestamp, items: [...items], page: { limit: 500, total: items.length, truncated: false } };
}

function snapshot(redirectors: readonly LocalRedirectorOverview[] = [installation]): SliverSnapshot {
  const source = disconnectedSnapshot();
  source.connection = {
    status: "connected", server: "server.example.test:31337", configName: "managed.cfg", epoch: 1,
    managedServer: {
      provider: "aws", deploymentId: "5d759d8a-18e4-4a8c-83bb-d618169d5bc8", name: "Managed server",
      overview: {
        region: "us-west-2", size: "t3.small", instanceState: "running", publicIpAddress: "203.0.113.10",
        privateIpAddress: "10.0.0.10", updatedAt: timestamp,
        cloud: { provider: "aws", vpcId: "vpc-test" }, redirectors,
      },
    } as ManagedServerReference,
  };
  source.eventStream = { status: "connected", attempt: 0 };
  source.domains.jobs = jobs([{ id: 8, name: "HTTP", description: "HTTP listener", protocol: "tcp", port: 8000, domains: [], profileName: "" }]);
  source.lastUpdated = timestamp;
  return source;
}

function node(nodes: readonly TopologyNode[], kind: string): TopologyNode {
  const found = nodes.find((item) => item.kind === kind);
  expect(found).toBeDefined();
  return found!;
}

describe("local redirector topology", () => {
  it("shows the redirector's primary DNS record and its relationship to the server", () => {
    const document = createOverviewTopology(snapshot());
    const redirector = node(document.nodes, "http-redirector");
    const server = node(document.nodes, "server");
    const cloud = node(document.nodes, "cloud");

    expect(redirector).toMatchObject({ label: "Caddy", icon: "caddy", parentId: cloud.id, statusLabel: "Installed (cached)", freshness: "stale" });
    expect(redirector.subtitle).toBe("DNS · c2.example.test");
    expect(redirector.properties).toContainEqual({ label: "DNS record", value: "c2.example.test" });
    expect(redirector.properties).toContainEqual({ label: "Domains", value: "c2.example.test, backup.example.test" });
    expect(redirector.properties).toContainEqual({ label: "Public URL", value: "https://c2.example.test" });
    expect(redirector.properties).toContainEqual({ label: "Public IP", value: "203.0.113.10" });
    expect(redirector.properties).toContainEqual({ label: "Last verified", value: timestamp });
    expect(redirector.properties).toContainEqual({ label: "Configured upstream", value: "127.0.0.1:8000" });
    expect(document.nodes.some(({ kind }) => kind === "public-endpoint")).toBe(false);
    expect(document.nodes.some(({ kind }) => kind === "local-listener")).toBe(false);

    const path = document.edges.filter((edge) => edge.kind === "server-redirector");
    expect(path).toHaveLength(1);
    expect(path[0]).toMatchObject({ source: server.id, target: redirector.id, role: "relationship", state: "unknown" });
    const serverPath = path[0];
    expect(serverPath?.label).toBe("HTTP :8000");
    expect(serverPath?.properties).toContainEqual({ label: "Upstream", value: "127.0.0.1:8000" });
    expect(serverPath?.properties).toContainEqual({ label: "Listener ownership", value: "managed" });
    expect(serverPath?.properties).toContainEqual({ label: "Job inventory", value: "Job reported" });
    expect(document.edges.some(({ kind }) => kind === "redirector-listener" || kind === "listener-server" || kind === "redirector-server" || kind === "endpoint-redirector" || kind === "redirector-endpoint")).toBe(false);
    expect(document.edges.filter((edge) => edge.kind === "target-communication")).toHaveLength(0);
  });

  it("lays out the actual overview from operators through server to redirector", async () => {
    const source = snapshot();
    source.domains.operators = {
      status: "ready", revision: 1, updatedAt: timestamp,
      items: [{ id: "operator-a", name: "alice", online: true }],
      page: { limit: 500, total: 1, truncated: false },
    };
    const document = createOverviewTopology(source);
    const layout = await layoutTopology(topologyLayoutInput(document));
    const positioned = (kind: string) => {
      const resource = node(document.nodes, kind);
      const result = layout.find((item) => item.id === resource.id);
      expect(result).toBeDefined();
      return result!;
    };
    const cloud = positioned("cloud");
    const server = positioned("server");
    const redirector = positioned("http-redirector");
    const operator = positioned("operator");
    const client = positioned("client");

    expect(cloud.x + server.x).toBeGreaterThan(operator.x + operator.width);
    expect(cloud.x + server.x).toBeGreaterThan(client.x + client.width);
    expect(redirector.x).toBeGreaterThan(server.x + server.width);
    expect(document.nodes.some(({ kind }) => kind === "public-endpoint")).toBe(false);
  });

  it("keeps redirector identities stable across metadata and ordering changes", () => {
    const nginx: LocalRedirectorOverview = {
      ...installation, id: "fb94b349-b76a-435c-923e-2b185b2a1dd1", recipeId: "nginx", domains: [],
      publicUrl: "http://203.0.113.10", listener: { ...installation.listener, ownership: "existing" },
    };
    const source = snapshot([installation, nginx]);
    const first = createOverviewTopology(source);
    expect(first.nodes.filter(({ kind }) => kind === "local-listener")).toHaveLength(0);
    expect(first.nodes.filter(({ kind }) => kind === "public-endpoint")).toHaveLength(0);
    expect(first.nodes.filter(({ kind }) => kind === "http-redirector")).toHaveLength(2);
    expect(first.edges.filter(({ kind }) => kind === "server-redirector")).toHaveLength(2);
    expect(first.edges.filter(({ kind }) => kind === "redirector-endpoint")).toHaveLength(0);
    expect(first.nodes.find(({ kind, label }) => kind === "http-redirector" && label === "Nginx")?.subtitle).toBe("Public IP · 203.0.113.10");

    source.connection.epoch = 2;
    source.connection.managedServer = {
      ...source.connection.managedServer!,
      overview: { ...source.connection.managedServer!.overview!, redirectors: [{ ...nginx, status: "degraded" }, installation] },
    };
    const second = createOverviewTopology(source);
    expect(new Set(second.nodes.map(({ id }) => id))).toEqual(new Set(first.nodes.map(({ id }) => id)));
    expect(new Set(second.edges.map(({ id }) => id))).toEqual(new Set(first.edges.map(({ id }) => id)));
    expect(second.nodes.find(({ kind, label }) => kind === "http-redirector" && label === "Nginx")).toMatchObject({ status: "warning", statusLabel: "Degraded (cached)" });
  });

  it("does not project current job inventory onto a cached redirector's health", () => {
    const source = snapshot();
    source.domains.jobs = jobs([], "empty");
    let document = createOverviewTopology(source);
    expect(document.nodes.some(({ kind }) => kind === "local-listener")).toBe(false);
    expect(node(document.nodes, "http-redirector")).toMatchObject({ status: "unknown", freshness: "stale" });
    expect(document.edges.find(({ kind }) => kind === "server-redirector")?.properties).toContainEqual({ label: "Job inventory", value: "Job not in inventory" });

    source.eventStream = { status: "retrying", attempt: 1 };
    document = createOverviewTopology(source);
    expect(node(document.nodes, "http-redirector")).toMatchObject({ status: "unknown", freshness: "stale" });
    expect(document.edges.find(({ kind }) => kind === "server-redirector")?.properties).toContainEqual({ label: "Job inventory", value: "Saved listener association" });

    source.connection.managedServer = {
      ...source.connection.managedServer!,
      overview: { ...source.connection.managedServer!.overview!, redirectors: [{ ...installation, lastCheckedAt: null, status: "outcome-unknown" }] },
    };
    document = createOverviewTopology(source);
    expect(node(document.nodes, "http-redirector")).toMatchObject({ status: "warning", statusLabel: "Outcome unknown", freshness: "unknown" });
  });

  it("omits an unconfirmed job ID from the direct redirector relationship", () => {
    const source = snapshot([{ ...installation, status: "outcome-unknown", lastCheckedAt: null,
      listener: { ...installation.listener, jobId: 0 } }]);
    const document = createOverviewTopology(source);
    expect(document.nodes.some(({ kind }) => kind === "local-listener")).toBe(false);
    const relationship = document.edges.find(({ kind }) => kind === "server-redirector");
    expect(relationship).toBeDefined();
    expect(relationship!.properties).toContainEqual({ label: "Job inventory", value: "Job ID unconfirmed" });
    expect(relationship!.properties).not.toContainEqual({ label: "Job ID", value: 0 });
  });

  it("removes the path when the installation disappears or the connection is not associated with a managed deployment", () => {
    const source = snapshot([]);
    expect(createOverviewTopology(source).nodes.some(({ kind }) => kind === "http-redirector")).toBe(false);
    source.connection.managedServer = null;
    expect(createOverviewTopology(source).nodes.some(({ kind }) => kind === "http-redirector")).toBe(false);
  });

  it("never renders credentials or paths from a malformed saved public URL", () => {
    const source = snapshot([{ ...installation, publicUrl: "https://user:private-token@wrong.example.test/secret?token=private-token" }]);
    const document = createOverviewTopology(source);
    expect(node(document.nodes, "http-redirector").subtitle).toBe("DNS · c2.example.test");
    expect(document.nodes.some(({ kind }) => kind === "public-endpoint")).toBe(false);
    expect(JSON.stringify(document)).not.toContain("private-token");
  });
});
