import {
  ChangeResourceRecordSetsCommand, GetChangeCommand, GetHostedZoneCommand, ListResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";
import { describe, expect, it, vi } from "vitest";

import { AwsAlbAliasChangeAcceptedError, AwsAlbAliasProvider, type AwsAlbAliasInput } from "./aws-alb-alias.js";

const input: AwsAlbAliasInput = {
  hostedZoneId: "Z1234567890", domain: "c2.example.test",
  loadBalancerDnsName: "sliver-gui-alb-123.us-east-1.elb.amazonaws.com",
  loadBalancerHostedZoneId: "Z9876543210",
};
const connection = { region: "us-east-1", credentials: {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
} };

function client(existing: unknown[] = []) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof GetHostedZoneCommand) return { HostedZone: {
      Id: "/hostedzone/Z1234567890", Name: "example.test.", Config: { PrivateZone: false },
    } };
    if (command instanceof ListResourceRecordSetsCommand) return { ResourceRecordSets: existing };
    if (command instanceof ChangeResourceRecordSetsCommand) return { ChangeInfo: { Id: "/change/C123" } };
    if (command instanceof GetChangeCommand) return { ChangeInfo: { Status: "INSYNC" } };
    throw new Error("Unexpected Route 53 command");
  });
  return { send };
}

describe("Route 53 ALB alias", () => {
  it("creates a new exact alias without replacing another record", async () => {
    const fake = client();
    const alias = new AwsAlbAliasProvider(connection, fake);
    expect(await alias.create(input)).toEqual({ owned: true });
    const change = fake.send.mock.calls.find(([command]) => command instanceof ChangeResourceRecordSetsCommand)?.[0] as ChangeResourceRecordSetsCommand;
    expect(change.input.ChangeBatch?.Changes?.[0]).toMatchObject({ Action: "CREATE", ResourceRecordSet: {
      Name: "c2.example.test.", Type: "A", AliasTarget: {
        DNSName: "sliver-gui-alb-123.us-east-1.elb.amazonaws.com.", HostedZoneId: "Z9876543210",
      },
    } });
  });

  it("refuses to replace a conflicting hostname", async () => {
    const fake = client([{ Name: "c2.example.test.", Type: "A", ResourceRecords: [{ Value: "203.0.113.10" }], TTL: 300 }]);
    await expect(new AwsAlbAliasProvider(connection, fake).create(input)).rejects.toThrow(/conflicting record/u);
    expect(fake.send.mock.calls.some(([command]) => command instanceof ChangeResourceRecordSetsCommand)).toBe(false);
  });

  it("marks an accepted alias change as owned when Route 53 confirmation fails", async () => {
    const base = client();
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetChangeCommand) throw new Error("Route 53 status unavailable");
      return base.send(command);
    });
    await expect(new AwsAlbAliasProvider(connection, { send }).create(input))
      .rejects.toBeInstanceOf(AwsAlbAliasChangeAcceptedError);
    expect(send.mock.calls.some(([command]) => command instanceof ChangeResourceRecordSetsCommand)).toBe(true);
  });

  it("refuses deletion after the alias target changes", async () => {
    const fake = client([{ Name: "c2.example.test.", Type: "A", AliasTarget: {
      DNSName: "other.us-east-1.elb.amazonaws.com.", HostedZoneId: "Z9876543210", EvaluateTargetHealth: false,
    } }]);
    await expect(new AwsAlbAliasProvider(connection, fake).deleteIfMatches(input)).rejects.toThrow(/no longer matches/u);
    expect(fake.send.mock.calls.some(([command]) => command instanceof ChangeResourceRecordSetsCommand)).toBe(false);
  });
});
