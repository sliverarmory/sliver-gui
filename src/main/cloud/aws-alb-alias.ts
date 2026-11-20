import {
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  GetHostedZoneCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
  type ResourceRecordSet,
} from "@aws-sdk/client-route-53";

import type { AwsEc2ProviderConnection } from "./aws-ec2-provider.js";

interface Route53ClientLike {
  send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}

export interface AwsAlbAliasInput {
  readonly hostedZoneId: string;
  readonly domain: string;
  readonly loadBalancerDnsName: string;
  readonly loadBalancerHostedZoneId: string;
}

/** Route 53 accepted the change, but confirmation did not complete. */
export class AwsAlbAliasChangeAcceptedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AwsAlbAliasChangeAcceptedError";
  }
}

/** Owns one exact Route 53 A alias; it never replaces an existing DNS record. */
export class AwsAlbAliasProvider {
  readonly #client: Route53ClientLike;

  constructor(connection: AwsEc2ProviderConnection, client?: Route53ClientLike) {
    this.#client = client ?? new Route53Client({ ...connection, maxAttempts: 1 });
  }

  dispose(): void { this.#client.destroy?.(); }

  async create(input: AwsAlbAliasInput): Promise<{ readonly owned: boolean }> {
    const record = await this.#record(input);
    const existing = await this.#existing(input.hostedZoneId, record.Name!);
    if (existing.length > 0) {
      if (existing.length === 1 && aliasEquals(existing[0]!, record)) return { owned: false };
      throw new Error("The selected DNS name already has a conflicting record. Choose another name or remove the conflict in Route 53.");
    }
    let accepted = false;
    try {
      await this.#change(input.hostedZoneId, "CREATE", record, () => { accepted = true; });
    } catch (error) {
      if (accepted) {
        throw new AwsAlbAliasChangeAcceptedError(
          "Route 53 accepted the ALB alias, but propagation could not be confirmed. The alias remains owned for cleanup.",
          { cause: error },
        );
      }
      throw error;
    }
    return { owned: true };
  }

  async deleteIfMatches(input: AwsAlbAliasInput): Promise<boolean> {
    const expected = await this.#record(input);
    const existing = await this.#existing(input.hostedZoneId, expected.Name!);
    if (existing.length === 0) return false;
    if (existing.length !== 1 || !aliasEquals(existing[0]!, expected)) {
      throw new Error("Refusing to delete a Route 53 record that no longer matches the managed ALB alias.");
    }
    await this.#change(input.hostedZoneId, "DELETE", existing[0]!);
    return true;
  }

  async matches(input: AwsAlbAliasInput): Promise<boolean> {
    const expected = await this.#record(input);
    const existing = await this.#existing(input.hostedZoneId, expected.Name!);
    return existing.length === 1 && aliasEquals(existing[0]!, expected);
  }

  async #record(input: AwsAlbAliasInput): Promise<ResourceRecordSet> {
    const zoneId = normalizeZoneId(input.hostedZoneId);
    const zoneResponse = await this.#send<{ HostedZone?: { Id?: string; Name?: string; Config?: { PrivateZone?: boolean } } }>(
      new GetHostedZoneCommand({ Id: zoneId }),
    );
    const zone = zoneResponse.HostedZone;
    if (!zone?.Id || normalizeZoneId(zone.Id) !== zoneId || !zone.Name || zone.Config?.PrivateZone) {
      throw new Error("Choose a public Route 53 hosted zone in the selected AWS account.");
    }
    const zoneName = canonicalDns(zone.Name);
    const name = canonicalDns(input.domain);
    if (name !== zoneName && !name.endsWith(`.${zoneName}`)) {
      throw new Error("The ALB hostname must belong to the selected hosted zone.");
    }
    const target = canonicalDns(input.loadBalancerDnsName);
    if (!/^[a-z0-9.-]+\.elb\.amazonaws\.com(?:\.cn)?$/u.test(target)) {
      throw new Error("The ALB DNS name is invalid.");
    }
    const targetZoneId = normalizeZoneId(input.loadBalancerHostedZoneId);
    return {
      Name: `${name}.`, Type: "A",
      AliasTarget: { DNSName: `${target}.`, HostedZoneId: targetZoneId, EvaluateTargetHealth: false },
    };
  }

  async #existing(hostedZoneId: string, name: string): Promise<ResourceRecordSet[]> {
    const zoneId = normalizeZoneId(hostedZoneId);
    const response = await this.#send<{ ResourceRecordSets?: ResourceRecordSet[]; IsTruncated?: boolean; NextRecordName?: string }>(
      new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: name, MaxItems: 100 }),
    );
    const sameName = (response.ResourceRecordSets ?? []).filter((record) => record.Name?.toLowerCase() === name.toLowerCase());
    if (response.IsTruncated && response.NextRecordName?.toLowerCase() === name.toLowerCase()) {
      throw new Error("Too many DNS records share the selected ALB hostname.");
    }
    return sameName.filter((record) => record.Type === "A" || record.Type === "AAAA" || record.Type === "CNAME");
  }

  async #change(hostedZoneId: string, action: "CREATE" | "DELETE", record: ResourceRecordSet, onAccepted?: () => void): Promise<void> {
    const result = await this.#send<{ ChangeInfo?: { Id?: string } }>(new ChangeResourceRecordSetsCommand({
      HostedZoneId: normalizeZoneId(hostedZoneId),
      ChangeBatch: { Changes: [{ Action: action, ResourceRecordSet: record }] },
    }));
    const id = result.ChangeInfo?.Id;
    if (!id) throw new Error("The Route 53 alias change outcome is unknown.");
    onAccepted?.();
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const status = await this.#send<{ ChangeInfo?: { Status?: string } }>(new GetChangeCommand({ Id: id }));
      if (status.ChangeInfo?.Status === "INSYNC") return;
      if (status.ChangeInfo?.Status !== "PENDING") throw new Error("The Route 53 alias change status is unknown.");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error("The Route 53 alias change is still pending. Refresh before retrying.");
  }

  async #send<T>(command: unknown): Promise<T> {
    return this.#client.send(command, { abortSignal: AbortSignal.timeout(60_000) }) as Promise<T>;
  }
}

function normalizeZoneId(value: string): string {
  const id = value.replace(/^\/hostedzone\//u, "");
  if (!/^Z[A-Z0-9]{1,63}$/u.test(id)) throw new Error("Invalid Route 53 hosted zone ID.");
  return id;
}

function canonicalDns(value: string): string {
  const name = value.toLowerCase().replace(/\.$/u, "");
  if (name.length > 253 || !name.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) {
    throw new Error("Invalid ALB DNS name.");
  }
  return name;
}

function aliasEquals(actual: ResourceRecordSet, expected: ResourceRecordSet): boolean {
  return actual.Name?.toLowerCase() === expected.Name?.toLowerCase() && actual.Type === "A" &&
    actual.AliasTarget?.DNSName?.toLowerCase() === expected.AliasTarget?.DNSName?.toLowerCase() &&
    actual.AliasTarget?.HostedZoneId === expected.AliasTarget?.HostedZoneId &&
    actual.AliasTarget?.EvaluateTargetHealth === false && !actual.SetIdentifier && !actual.Region &&
    !actual.Failover && !actual.GeoLocation && !actual.MultiValueAnswer;
}
