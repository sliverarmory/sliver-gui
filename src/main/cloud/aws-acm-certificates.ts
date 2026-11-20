import { ACMClient, DescribeCertificateCommand, ListCertificatesCommand } from "@aws-sdk/client-acm";

import type { AwsAlbCertificateOption } from "../../shared/cloud-provider-inventory.js";
import type { AwsEc2CredentialSource } from "./aws-ec2-provider.js";

interface AcmClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface AwsAcmCertificateDiscoveryOptions {
  readonly client?: AcmClientLike;
}

/** Read-only list of issued regional certificates suitable for an ALB listener. */
export class AwsAcmCertificateDiscovery {
  readonly #client: AcmClientLike;
  readonly #region: string;

  constructor(region: string, credentials: AwsEc2CredentialSource, options: AwsAcmCertificateDiscoveryOptions = {}) {
    this.#region = region;
    this.#client = options.client ?? new ACMClient({ region, credentials });
  }

  async listIssued(): Promise<readonly AwsAlbCertificateOption[]> {
    const arns: string[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const response = await this.#client.send(new ListCertificatesCommand({
        CertificateStatuses: ["ISSUED"], MaxItems: 100,
        ...(nextToken ? { NextToken: nextToken } : {}),
      })) as { CertificateSummaryList?: { CertificateArn?: string }[]; NextToken?: unknown };
      for (const summary of response.CertificateSummaryList ?? []) {
        if (summary.CertificateArn && certificateArnInRegion(summary.CertificateArn, this.#region)) {
          arns.push(summary.CertificateArn);
        }
      }
      if (response.NextToken === undefined || response.NextToken === null) break;
      if (typeof response.NextToken !== "string" || response.NextToken.length > 4_096 || seenTokens.has(response.NextToken)) {
        throw new Error("ACM returned an invalid pagination token");
      }
      seenTokens.add(response.NextToken);
      nextToken = response.NextToken;
      if (page === 9) throw new Error("ACM returned too many certificate pages");
    }
    const uniqueArns = [...new Set(arns)];
    if (uniqueArns.length > 500) throw new Error("Too many ACM certificates to review safely");
    const certificates: AwsAlbCertificateOption[] = [];
    for (let start = 0; start < uniqueArns.length; start += 4) {
      const batch = uniqueArns.slice(start, start + 4);
      const details = await Promise.all(batch.map(async (CertificateArn) => this.#client.send(
        new DescribeCertificateCommand({ CertificateArn }),
      ) as Promise<{ Certificate?: { CertificateArn?: string; Status?: string; DomainName?: string; SubjectAlternativeNames?: string[] } }>));
      for (const detail of details) {
        const certificate = detail.Certificate;
        if (!certificate?.CertificateArn || !certificateArnInRegion(certificate.CertificateArn, this.#region) ||
            certificate.Status !== "ISSUED" || !certificate.DomainName) continue;
        certificates.push(Object.freeze({
          arn: certificate.CertificateArn,
          domainName: certificate.DomainName,
          subjectAlternativeNames: Object.freeze([...new Set(certificate.SubjectAlternativeNames ?? [])].sort()),
        }));
      }
    }
    return Object.freeze(certificates.sort((left, right) =>
      left.domainName.localeCompare(right.domainName) || left.arn.localeCompare(right.arn)));
  }
}

function certificateArnInRegion(arn: string, region: string): boolean {
  return /^arn:(?:aws|aws-us-gov|aws-cn):acm:[a-z0-9-]+:\d{12}:certificate\/[0-9a-f-]{36}$/u.test(arn) &&
    arn.split(":")[3] === region;
}
