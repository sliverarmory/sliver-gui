import { DescribeCertificateCommand, ListCertificatesCommand } from "@aws-sdk/client-acm";
import { describe, expect, it, vi } from "vitest";

import { AwsAcmCertificateDiscovery } from "./aws-acm-certificates.js";

const arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555";

describe("ACM certificate discovery", () => {
  it("returns only issued certificates from the selected region", async () => {
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListCertificatesCommand) return { CertificateSummaryList: [
        { CertificateArn: arn },
        { CertificateArn: arn.replace("us-east-1", "us-west-2") },
      ] };
      if (command instanceof DescribeCertificateCommand) return { Certificate: {
        CertificateArn: arn, Status: "ISSUED", DomainName: "c2.example.test",
        SubjectAlternativeNames: ["c2.example.test", "edge.example.test"],
      } };
      throw new Error("Unexpected ACM command");
    });
    const discovery = new AwsAcmCertificateDiscovery("us-east-1", {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    }, { client: { send } });
    expect(await discovery.listIssued()).toEqual([{
      arn, domainName: "c2.example.test", subjectAlternativeNames: ["c2.example.test", "edge.example.test"],
    }]);
    expect(send.mock.calls.filter(([command]) => command instanceof DescribeCertificateCommand)).toHaveLength(1);
  });
});
