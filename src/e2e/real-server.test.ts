// @vitest-environment node
import { readFile } from "node:fs/promises";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filter, firstValueFrom, timeout } from "rxjs";
import { SliverClient, clientpb, parseConfig } from "sliver-script";

import { artifactFormatFromProto, buildImplantConfig } from "../main/implant-config.js";
import { cloneGenerateInput, defaultGenerateInput } from "../shared/generate-defaults.js";

const configPath = process.env["SLIVER_GUI_E2E_CONFIG"];
const describeWithServer = configPath ? describe : describe.skip;
const listenerPort = Number(process.env["SLIVER_GUI_E2E_LISTENER_PORT"] ?? 18888);

describeWithServer("real Sliver server", () => {
  let client: SliverClient;
  const cleanupJobs = new Set<number>();
  const cleanupBuilds = new Set<string>();
  const cleanupProfiles = new Set<string>();

  beforeAll(async () => {
    const data = await readFile(configPath!);
    client = new SliverClient(parseConfig(data));
    await client.connect();
    await firstValueFrom(
      client.eventStreamState$.pipe(
        filter((state) => state.status === "connected"),
        timeout(15_000),
      ),
    );
  }, 30_000);

  afterAll(async () => {
    for (const jobId of cleanupJobs) await client.killJob(jobId).catch(() => undefined);
    await client.stageImplantBuild([]).catch(() => undefined);
    for (const profile of cleanupProfiles) await client.deleteImplantProfile(profile).catch(() => undefined);
    for (const build of cleanupBuilds) await client.deleteImplantBuild(build).catch(() => undefined);
    await client.disconnect();
  }, 60_000);

  it("observes listener lifecycle events and reconciles the jobs snapshot", async () => {
    const eventTypes: string[] = [];
    const subscription = client.event$.subscribe((event) => eventTypes.push(event.EventType));
    try {
      const started = await client.startMTLSListener("127.0.0.1", listenerPort, 30);
      cleanupJobs.add(started.JobID);

      await waitFor(async () => (await client.jobs()).some((job) => job.ID === started.JobID));
      expect((await client.jobs()).find((job) => job.ID === started.JobID)).toMatchObject({
        ID: started.JobID,
        Port: listenerPort,
      });
      await waitFor(() => eventTypes.includes("job-started"));

      const stopped = await client.killJob(started.JobID, 30);
      expect(stopped.Success).toBe(true);
      cleanupJobs.delete(started.JobID);
      await waitFor(async () => !(await client.jobs()).some((job) => job.ID === started.JobID));
      await waitFor(() => eventTypes.includes("job-stopped"));
    } finally {
      subscription.unsubscribe();
    }
  }, 60_000);

  it("discovers compiler targets and completes build, profile, and staging workflows", async () => {
    const compiler = await client.getCompiler(30);
    const target =
      compiler.Targets.find(
        (candidate) =>
          candidate.Format === clientpb.OutputFormat.EXECUTABLE &&
          candidate.GOOS === "darwin" &&
          candidate.GOARCH === "arm64",
      ) ?? compiler.Targets.find((candidate) => candidate.Format === clientpb.OutputFormat.EXECUTABLE);
    expect(target).toBeDefined();

    const suffix = Date.now().toString(36);
    const buildName = `gui-e2e-${suffix}`;
    const profileName = `gui-e2e-profile-${suffix}`;
    const input = cloneGenerateInput(defaultGenerateInput);
    input.name = buildName;
    input.os = target!.GOOS;
    input.arch = target!.GOARCH;
    input.format = artifactFormatFromProto(target!.Format);
    input.c2 = `mtls://127.0.0.1:${listenerPort}`;
    const config = buildImplantConfig(input);

    const generated = await client.generateImplant(config, buildName, 15 * 60);
    expect(generated.ImplantName).toBe(buildName);
    expect(generated.ImplantBuildID).not.toBe("");
    expect(generated.File?.Data.length).toBeGreaterThan(1_000);
    cleanupBuilds.add(generated.ImplantName);

    const builds = await client.implantBuilds();
    expect(builds.Configs[generated.ImplantName]).toBeDefined();
    await client.stageImplantBuild([generated.ImplantName]);
    expect((await client.implantBuilds()).staged[generated.ImplantName]).toBe(true);

    await client.saveImplantProfile(
      clientpb.ImplantProfile.create({ ID: "", Name: profileName, Config: config }),
      30,
    );
    cleanupProfiles.add(profileName);
    expect((await client.implantProfiles()).Profiles.some((profile) => profile.Name === profileName)).toBe(true);
  }, 20 * 60_000);
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}
