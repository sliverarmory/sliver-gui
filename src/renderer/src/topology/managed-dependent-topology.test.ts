import { describe, expect, it } from "vitest";
import { disconnectedSnapshot, type SliverSnapshot } from "../../../shared/contracts";
import { createOverviewTopology } from "./overview-topology";
import { layoutTopology } from "./topology-layout";
import { topologyLayoutInput } from "./topology-layout-input";

const updatedAt = "2026-11-19T12:00:00.000Z";

function snapshot(): SliverSnapshot {
  const source = disconnectedSnapshot();
  source.connection = {
    status: "connected", server: "server.example.test:31337", configName: "managed.cfg", epoch: 1,
    managedServer: {
      provider: "aws", deploymentId: "server-one", name: "Server one",
      overview: {
        region: "us-east-1", size: "t3.small", instanceState: "running",
        publicIpAddress: "203.0.113.10", privateIpAddress: "10.0.0.10", updatedAt,
        cloud: { provider: "aws", vpcId: "vpc-123" },
        dependentDeployments: [
          {
            kind: "crackstation", id: "gpu-one", name: "GPU worker", serverDeploymentId: "server-one",
            status: "running", phase: "ready", updatedAt, instanceId: "i-gpu", instanceType: "g4dn.xlarge",
            hostUuid: "host-gpu", privateIpAddress: "10.0.1.20",
          },
          {
            kind: "alb-redirector", id: "alb-one", name: "Edge redirector", serverDeploymentId: "server-one",
            status: "running", phase: "ready", updatedAt, loadBalancerArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/test/123",
            dnsName: "test.us-east-1.elb.amazonaws.com", domain: "c2.example.test", backendPort: 8080,
            listenerJobId: 8, targetHealth: "healthy",
          },
        ],
      },
    },
  };
  source.eventStream = { status: "connected", attempt: 0 };
  source.infrastructureServices = {
    builders: { status: "empty", revision: 1, items: [], updatedAt, page: { limit: 500, total: 0, truncated: false } },
    crackstations: {
      status: "ready", revision: 1, updatedAt,
      items: [
        { id: "host-gpu", name: "GPU worker", os: "linux", arch: "amd64", operatorName: "crackstation", version: "1.0.0" },
        { id: "other-host", name: "Unmanaged worker", os: "linux", arch: "amd64", operatorName: "other" },
      ],
      page: { limit: 500, total: 2, truncated: false },
    },
  };
  return source;
}

describe("managed dependent topology", () => {
  it("places distinct Crackstation and ALB nodes in the server VPC without duplicating a matched live worker", () => {
    const document = createOverviewTopology(snapshot());
    const cloud = document.nodes.find(({ kind }) => kind === "cloud")!;
    const server = document.nodes.find(({ kind }) => kind === "server")!;
    const station = document.nodes.find(({ kind, label }) => kind === "crackstation" && label === "GPU worker")!;
    const alb = document.nodes.find(({ kind }) => kind === "alb-redirector")!;
    expect(station).toMatchObject({ parentId: cloud.id, icon: "crackstation", statusLabel: "Connected", freshness: "current" });
    expect(alb).toMatchObject({ parentId: cloud.id, icon: "alb-redirector", subtitle: "c2.example.test", statusLabel: "Targets healthy (cached)" });
    expect(document.nodes.filter(({ kind }) => kind === "crackstation")).toHaveLength(2);
    expect(document.edges.find(({ kind }) => kind === "managed-crackstation-server")).toMatchObject({ source: station.id, target: server.id });
    expect(document.edges.find(({ kind }) => kind === "alb-forwarding")).toMatchObject({ source: alb.id, target: server.id, label: "HTTP :8080" });
    expect(alb.properties).toContainEqual({ label: "Target health (cached)", value: "healthy" });
  });

  it("keeps the managed worker visible when its server-reported registration is absent", () => {
    const source = snapshot();
    source.infrastructureServices!.crackstations.items = [];
    source.infrastructureServices!.crackstations.status = "empty";
    const document = createOverviewTopology(source);
    const station = document.nodes.find(({ kind }) => kind === "crackstation")!;
    expect(station).toMatchObject({ label: "GPU worker", statusLabel: "Running (cached)", freshness: "stale" });
    expect(document.edges.find(({ kind }) => kind === "managed-crackstation-server")?.label).toBe("Configured server");
  });

  it("lays out both dependent nodes inside the VPC", async () => {
    const document = createOverviewTopology(snapshot());
    const layout = await layoutTopology(topologyLayoutInput(document));
    const find = (kind: string) => layout.find(({ id }) => id === document.nodes.find((node) => node.kind === kind)?.id)!;
    const cloud = find("cloud");
    for (const kind of ["server", "crackstation", "alb-redirector"]) {
      const child = find(kind);
      expect(child.x).toBeGreaterThanOrEqual(0);
      expect(child.y).toBeGreaterThanOrEqual(0);
      expect(child.x + child.width).toBeLessThanOrEqual(cloud.width);
      expect(child.y + child.height).toBeLessThanOrEqual(cloud.height);
    }
  });
});
