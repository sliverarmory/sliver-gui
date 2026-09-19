import { describe, expect, it } from "vitest";

import {
  CLOUD_DEPLOYMENT_STATE_VERSION,
  parseAzureFirewallRuleSpec,
  parseAzureBrowserLoginSession,
  parseAzureCliCredentialSecret,
  parseBeginAzureLoginInput,
  parseAwsConsoleLoginSession,
  parseAwsFirewallRuleSpec,
  parseCloudCredentialSummary,
  parseCloudDeploymentActionInput,
  parseCloudDeploymentRecord,
  parseCloudDeploymentState,
  parseCreateAwsFirewallRuleInput,
  parseCreateCloudCredentialInput,
  parseCreateCloudDeploymentInput,
  parseDeleteAwsFirewallRuleInput,
  parseListAwsFirewallRulesInput,
  parseResolvedCloudCredentialInput,
  parseRenameCloudDeploymentInput,
  parseUpdateAwsFirewallRuleInput,
  parseUpdateCloudFirewallInput,
} from "./cloud-deployment-contracts.js";

const CREDENTIAL_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const KEY_TOKEN = "33333333-3333-4333-8333-333333333333";
const FIREWALL_RULE_ID = "sgr-0123456789abcdef0";
const AZURE_SUBSCRIPTION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";

describe("cloud deployment contracts", () => {
  it("normalizes a bounded deployment rename without changing its identity or revision", () => {
    const input = { deploymentId: DEPLOYMENT_ID, expectedRevision: 7, name: "  Production Control  " };
    const parsed = parseRenameCloudDeploymentInput(input);
    expect(parsed).toEqual({ deploymentId: DEPLOYMENT_ID, expectedRevision: 7, name: "Production Control" });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(input.name).toBe("  Production Control  ");
    expect(parseRenameCloudDeploymentInput({ ...input, name: "x".repeat(120) }).name).toHaveLength(120);
  });

  it("rejects malformed deployment renames, oversized names, controls, and extra authority", () => {
    const input = { deploymentId: DEPLOYMENT_ID, expectedRevision: 0, name: "Production Control" };
    for (const value of [
      null, [], {}, { ...input, deploymentId: "not-a-uuid" },
      { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 0.5 },
      { ...input, expectedRevision: "0" }, { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, name: "" }, { ...input, name: "   " }, { ...input, name: "x".repeat(121) },
      { ...input, name: "\nProduction" }, { ...input, name: "Production\r" },
      { ...input, name: "Production\tControl" }, { ...input, name: "Production\0Control" },
      { ...input, name: "Production\u007fControl" }, { ...input, name: "Production\u0085Control" },
      { ...input, name: 123 },
      { ...input, provider: "aws" }, { ...input, command: "arbitrary" },
    ]) expect(() => parseRenameCloudDeploymentInput(value)).toThrow(/Invalid cloud deployment rename/u);
  });

  it("accepts only native Azure login capabilities and bounded main-process session caches", () => {
    expect(parseBeginAzureLoginInput({ tenantId: null, clientId: null })).toEqual({ tenantId: null, clientId: null });
    expect(() => parseBeginAzureLoginInput({ tenantId: "common", clientId: null })).toThrow(/Invalid/u);
    const input = { provider: "azure", authentication: "login", loginToken: KEY_TOKEN, label: "Azure Login", defaultLocation: "eastus",
      subscriptionId: AZURE_SUBSCRIPTION_ID, tenantId: AZURE_TENANT_ID, sshUsername: "azureuser", sshPrivateKeyToken: null, sshPassphrase: null };
    expect(parseCreateCloudCredentialInput(input)).toEqual(input);
    expect(() => parseCreateCloudCredentialInput({ ...input, cache: "secret" })).toThrow(/Invalid/u);
    expect(() => parseCreateCloudCredentialInput({ ...input, loginToken: "not-a-capability" })).toThrow(/Invalid/u);
    const session = { clientId: AZURE_SUBSCRIPTION_ID, tenantId: AZURE_TENANT_ID, homeAccountId: "home", localAccountId: "local", username: "", cache: "{}" };
    expect(parseAzureBrowserLoginSession(session)).toEqual(session);
    for (const cache of ["[]", "null", "not-json", "x".repeat(1024 * 1024 + 1)]) {
      expect(() => parseAzureBrowserLoginSession({ ...session, cache })).toThrow(/Invalid/u);
    }
    const secret = { subscriptionId: AZURE_SUBSCRIPTION_ID, tenantId: AZURE_TENANT_ID, authentication: "login", loginSession: session,
      sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-key\n-----END OPENSSH PRIVATE KEY-----", sshPassphrase: null };
    expect(parseAzureCliCredentialSecret(secret)).toEqual(secret);
    expect(() => parseAzureCliCredentialSecret({ ...secret, tenantId: AZURE_SUBSCRIPTION_ID })).toThrow(/tenant/u);
    const { loginSession: _session, ...missingSession } = secret;
    expect(() => parseAzureCliCredentialSecret(missingSession)).toThrow(/Invalid/u);
  });

  it("accepts an explicit browser login request while rejecting session secrets and mixed sources at IPC", () => {
    const input = { provider: "aws", authentication: "login", label: "AWS Login", defaultRegion: "us-west-2",
      sshUsername: "ubuntu", sshPrivateKeyToken: null, sshPassphrase: null };
    expect(parseCreateCloudCredentialInput(input)).toEqual(input);
    for (const addition of [{ refreshToken: "secret" }, { loginSession: {} }, { profileName: "default" }, { authentication: "sso" }]) {
      expect(() => parseCreateCloudCredentialInput({ ...input, ...addition })).toThrow(/Invalid/u);
    }
    const session = { loginSessionArn: "arn:aws:iam::123456789012:root", region: "us-west-2",
      accessKeyId: "ASIAEXAMPLE00000001", secretAccessKey: "secret", sessionToken: "session", refreshToken: "refresh",
      privateKey: "-----BEGIN EC PRIVATE KEY-----\nproof-key\n-----END EC PRIVATE KEY-----", expiresAt: "2026-09-08T20:00:00.000Z" };
    expect(parseAwsConsoleLoginSession(session)).toEqual(session);
    expect(() => parseAwsConsoleLoginSession({ ...session, expiresAt: "tomorrow" })).toThrow(/Invalid/u);
    expect(() => parseAwsConsoleLoginSession({ ...session, loginSessionArn: "https://example.com" })).toThrow(/Invalid/u);
    expect(() => parseCloudCredentialSummary({ id: CREDENTIAL_ID, provider: "aws", label: "AWS Login", persistence: "secure",
      createdAt: "2026-09-08T20:00:00.000Z", defaultRegion: "us-west-2", sshUsername: "ubuntu", ...session })).toThrow(/Invalid/u);
  });

  it("parses a renderer-safe AWS credential with an opaque private-key token", () => {
    const parsed = parseCreateCloudCredentialInput(awsCredentialInput());

    expect(parsed).toMatchObject({
      provider: "aws",
      sshPrivateKeyToken: KEY_TOKEN,
      defaultRegion: "us-west-2",
    });
    expect(JSON.stringify(parsed)).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("accepts an explicit generated-key request and rejects ambiguous passphrase input", () => {
    const generated = parseCreateCloudCredentialInput({
      ...awsCredentialInput(),
      sshPrivateKeyToken: null,
    });

    expect(generated).toMatchObject({
      provider: "aws",
      sshPrivateKeyToken: null,
      sshPassphrase: null,
    });
    expect(() => parseCreateCloudCredentialInput({
      ...awsCredentialInput(),
      sshPrivateKeyToken: null,
      sshPassphrase: "unused-passphrase",
    })).toThrow(/Invalid/u);
    const { sshPrivateKeyToken: _token, ...missingToken } = awsCredentialInput();
    expect(() => parseCreateCloudCredentialInput(missingToken)).toThrow(/Invalid/u);

    expect(parseCreateCloudCredentialInput({
      provider: "azure",
      label: "Azure CLI",
      defaultLocation: "westus2",
      sshUsername: "azureuser",
      sshPrivateKeyToken: null,
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
      sshPassphrase: null,
    })).toMatchObject({ provider: "azure", sshPrivateKeyToken: null });
  });

  it("accepts an exact AWS CLI profile reference without AWS secret fields", () => {
    const parsed = parseCreateCloudCredentialInput({
      provider: "aws",
      label: "Local AWS profile",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: KEY_TOKEN,
      profileName: "generals-network",
      sshPassphrase: null,
    });

    expect(parsed).toEqual({
      provider: "aws",
      label: "Local AWS profile",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: KEY_TOKEN,
      profileName: "generals-network",
      sshPassphrase: null,
    });
    expect(parsed).not.toHaveProperty("accessKeyId");
    expect(parsed).not.toHaveProperty("secretAccessKey");
    expect(() => parseCreateCloudCredentialInput({
      ...parsed,
      secretAccessKey: "must-not-cross-ipc",
    })).toThrow(/Invalid/u);

    const resolved = parseResolvedCloudCredentialInput({
      provider: "aws",
      label: "Local AWS profile",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
      secret: {
        profileName: "generals-network",
        sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
        sshPassphrase: null,
      },
    });
    expect(resolved.secret).toMatchObject({ profileName: "generals-network" });

    expect(parseCreateCloudCredentialInput({
      ...parsed,
      defaultRegion: "us-iso-east-1",
    })).toMatchObject({ defaultRegion: "us-iso-east-1" });
  });

  it("rejects raw private-key paths, extra keys, and unbounded credential values", () => {
    expect(() => parseCreateCloudCredentialInput({
      ...awsCredentialInput(),
      sshPrivateKeyPath: "/tmp/id_ed25519",
    })).toThrow(/Invalid/u);
    expect(() => parseCreateCloudCredentialInput({
      ...awsCredentialInput(),
      sshPrivateKeyToken: "/tmp/id_ed25519",
    })).toThrow(/Invalid/u);
    expect(() => parseCreateCloudCredentialInput({
      ...awsCredentialInput(),
      label: "x".repeat(121),
    })).toThrow(/Invalid/u);
  });

  it("parses resolved Azure CLI material without accepting access tokens", () => {
    const parsed = parseResolvedCloudCredentialInput(azureResolvedCredential());

    expect(parsed.provider).toBe("azure");
    expect(parsed.secret).toMatchObject({
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
    });
    expect(Object.isFrozen(parsed.secret)).toBe(true);
    expect(() => parseResolvedCloudCredentialInput({
      ...azureResolvedCredential(),
      secret: { ...azureResolvedCredential().secret, accessToken: "must-not-be-stored" },
    })).toThrow(/Invalid/u);
  });

  it("parses redacted provider-specific summaries and requires UUIDv4 identifiers", () => {
    const summary = parseCloudCredentialSummary({
      id: CREDENTIAL_ID,
      provider: "aws",
      label: "Production AWS",
      persistence: "secure",
      createdAt: "2026-09-06T18:00:00.000Z",
      defaultRegion: "us-west-2",
      sshUsername: "ubuntu",
    });

    expect(summary.provider).toBe("aws");
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(() => parseCloudCredentialSummary({ ...summary, id: "not-a-uuid" })).toThrow(/Invalid/u);

    expect(parseCloudCredentialSummary({ ...summary, profileName: "generals-network" }))
      .toMatchObject({ provider: "aws", profileName: "generals-network" });
  });

  it("parses exact AWS deployment specs with separate firewall scopes and Elastic IP policy", () => {
    const parsed = parseCreateCloudDeploymentInput(awsDeploymentInput());

    expect(parsed.provider).toBe("aws");
    expect(parsed.spec).toMatchObject({
      useElasticIp: true,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
      sshPort: 22,
      multiplayerPort: 31337,
    });
    expect(Object.isFrozen(parsed.spec.sshCidrs)).toBe(true);
    expect(parseCreateCloudDeploymentInput({
      ...awsDeploymentInput(),
      spec: { ...awsDeploymentInput().spec, sshPort: 2_222 },
    }).spec.sshPort).toBe(2_222);
    expect(() => parseCreateCloudDeploymentInput({
      ...awsDeploymentInput(),
      spec: { ...awsDeploymentInput().spec, sshCidrs: ["192.0.2.10/32", "192.0.2.10/32"] },
    })).toThrow(/Invalid/u);
    for (const cidr of ["0.0.0.0/0", "::/0", "::::/64", "192.168.001.1/32"]) {
      expect(() => parseCreateCloudDeploymentInput({
        ...awsDeploymentInput(),
        spec: { ...awsDeploymentInput().spec, sshCidrs: [cidr] },
      })).toThrow(/Invalid/u);
    }
    expect(parseCreateCloudDeploymentInput({
      ...awsDeploymentInput(),
      spec: { ...awsDeploymentInput().spec, sshCidrs: ["2001:db8::1/128"] },
    }).spec.sshCidrs).toEqual(["2001:db8::1/128"]);
    expect(() => parseCreateCloudDeploymentInput({
      ...awsDeploymentInput(),
      spec: { ...awsDeploymentInput().spec, instanceType: "m7i.large" },
    })).toThrow(/Invalid/u);
  });

  it("parses explicit AWS network/key modes and normalizes legacy v1 specs", () => {
    const legacy = parseCreateCloudDeploymentInput(awsDeploymentInput());
    expect(legacy.spec).toMatchObject({
      networkMode: "existing",
      managedVpcCidr: null,
      managedSubnetCidr: null,
      sshKeyMode: "managed",
      existingKeyPairName: null,
      sshUsername: null,
    });

    const managed = parseCreateCloudDeploymentInput({
      ...awsDeploymentInput(),
      spec: {
        ...awsDeploymentInput().spec,
        vpcId: null,
        subnetId: null,
        networkMode: "managed",
        managedVpcCidr: "10.42.0.0/16",
        managedSubnetCidr: "10.42.1.0/24",
        sshKeyMode: "managed",
        existingKeyPairName: null,
        sshUsername: "ubuntu",
        keyPairName: "managed-by-sliver-gui",
      },
    });
    expect(managed.spec).toMatchObject({
      networkMode: "managed",
      managedVpcCidr: "10.42.0.0/16",
      managedSubnetCidr: "10.42.1.0/24",
      sshUsername: "ubuntu",
    });

    expect(() => parseCreateCloudDeploymentInput({
      ...managed,
      spec: { ...managed.spec, managedSubnetCidr: "10.43.1.0/24" },
    })).toThrow(/Invalid/u);
    expect(() => parseCreateCloudDeploymentInput({
      ...managed,
      spec: { ...managed.spec, managedVpcCidr: "10.42.0.1/16" },
    })).toThrow(/Invalid/u);

    expect(parseCreateCloudDeploymentInput({
      ...managed,
      spec: {
        ...managed.spec,
        networkMode: "existing",
        vpcId: "vpc-0123456789abcdef0",
        subnetId: "subnet-0123456789abcdef0",
        managedVpcCidr: null,
        managedSubnetCidr: null,
        sshKeyMode: "existing",
        existingKeyPairName: "team-key",
        keyPairName: "team-key",
      },
    }).spec).toMatchObject({ sshKeyMode: "existing", existingKeyPairName: "team-key" });

    for (const incompleteNetwork of [
      { vpcId: null, subnetId: "subnet-0123456789abcdef0" },
      { vpcId: "vpc-0123456789abcdef0", subnetId: null },
    ]) {
      expect(() => parseCreateCloudDeploymentInput({
        ...managed,
        spec: {
          ...managed.spec,
          networkMode: "existing",
          ...incompleteNetwork,
          managedVpcCidr: null,
          managedSubnetCidr: null,
        },
      })).toThrow(/Invalid/u);
    }
  });

  it("parses exact Azure managed-network deployment specs", () => {
    const parsed = parseCreateCloudDeploymentInput(azureDeploymentInput());
    const managedImageId = `/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/images/providers/Microsoft.Compute/images/sliver-ubuntu`;

    expect(parsed).toMatchObject({
      provider: "azure",
      spec: {
        location: "westus2",
        vmSize: "Standard_B2s",
        networkMode: "managed",
        managedVnetCidr: "10.42.0.0/16",
        managedSubnetCidr: "10.42.1.0/24",
      },
    });
    expect(() => parseCreateCloudDeploymentInput({
      ...azureDeploymentInput(),
      spec: { ...azureDeploymentInput().spec, multiplayerPort: 22 },
    })).toThrow(/Invalid/u);
    expect(() => parseCreateCloudDeploymentInput({
      ...azureDeploymentInput(),
      spec: { ...azureDeploymentInput().spec, sshPort: 2_222 },
    })).toThrow(/Invalid/u);
    const managedImage = parseCreateCloudDeploymentInput({
      ...azureDeploymentInput(),
      spec: { ...azureDeploymentInput().spec, imageReference: managedImageId },
    });
    expect(managedImage.provider).toBe("azure");
    if (managedImage.provider !== "azure") throw new Error("Expected an Azure deployment input");
    expect(managedImage.spec.imageReference).toBe(managedImageId);
    expect(() => parseCreateCloudDeploymentInput({
      ...azureDeploymentInput(),
      spec: {
        ...azureDeploymentInput().spec,
        imageReference: `/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/images/providers/Microsoft.Compute/galleries/team/images/sliver/versions/1.0.0`,
      },
    })).toThrow(/Invalid/u);
    for (const sshUsername of ["a", "admin", "guest", "support_388945a0", "test", "user5", "video"]) {
      expect(() => parseCreateCloudDeploymentInput({
        ...azureDeploymentInput(),
        spec: { ...azureDeploymentInput().spec, sshUsername },
      })).toThrow(/Invalid/u);
    }
    for (const osDiskSizeGiB of [29, 4_096]) {
      expect(() => parseCreateCloudDeploymentInput({
        ...azureDeploymentInput(),
        spec: { ...azureDeploymentInput().spec, osDiskSizeGiB },
      })).toThrow(/Invalid/u);
    }
  });

  it("parses and deeply freezes redacted deployment records and state", () => {
    const record = parseCloudDeploymentRecord(awsDeploymentRecord());
    const state = parseCloudDeploymentState({
      v: CLOUD_DEPLOYMENT_STATE_VERSION,
      revision: 3,
      deployments: [record],
    });

    expect(state.deployments[0]).toMatchObject({
      id: DEPLOYMENT_ID,
      operatorConfigFileName: "11111111-1111-4111-8111-111111111111.cfg",
      operatorConfigDigest: "a".repeat(64),
      runtime: {
        instanceState: "unknown",
        instanceHealth: "unknown",
        systemHealth: "unknown",
      },
    });
    expect(JSON.stringify(state)).not.toContain("/Users/");
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.deployments)).toBe(true);
    expect(Object.isFrozen(state.deployments[0]?.managedAssets)).toBe(true);
  });

  it("parses persisted AWS status checks and rejects unknown health values", () => {
    const legacy = parseCloudDeploymentRecord(awsDeploymentRecord());
    if (legacy.provider !== "aws") throw new Error("Expected AWS deployment");
    const withStatus = {
      ...legacy,
      runtime: {
        ...legacy.runtime,
        instanceState: "running",
        instanceHealth: "ok",
        systemHealth: "ok",
      },
    } as const;

    expect(parseCloudDeploymentRecord(withStatus)).toMatchObject({
      runtime: { instanceState: "running", instanceHealth: "ok", systemHealth: "ok" },
    });
    expect(() => parseCloudDeploymentRecord({
      ...withStatus,
      runtime: { ...withStatus.runtime, systemHealth: "passing" },
    })).toThrow(/Invalid/u);
  });

  it("rejects config path disclosure, mismatched config metadata, and cross-provider assets", () => {
    expect(() => parseCloudDeploymentRecord({
      ...awsDeploymentRecord(),
      operatorConfigFileName: "/Users/alice/.sliver-client/configs/operator.cfg",
    })).toThrow(/Invalid/u);
    expect(() => parseCloudDeploymentRecord({
      ...awsDeploymentRecord(),
      operatorConfigDigest: null,
    })).toThrow(/Invalid/u);
    expect(() => parseCloudDeploymentRecord({
      ...awsDeploymentRecord(),
      managedAssets: [{ resourceType: "azure-virtual-machine", resourceId: "/subscriptions/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/resourceGroups/foreign/providers/Microsoft.Compute/virtualMachines/foreign", displayName: null, tagged: true }],
    })).toThrow(/Invalid/u);
  });

  it("rejects duplicate deployment identities and all unknown persisted keys", () => {
    expect(() => parseCloudDeploymentState({
      v: 1,
      revision: 1,
      deployments: [awsDeploymentRecord(), awsDeploymentRecord()],
    })).toThrow(/Invalid/u);
    expect(() => parseCloudDeploymentState({
      v: 1,
      revision: 1,
      deployments: [],
      unknown: true,
    })).toThrow(/Invalid/u);
  });

  it("parses bounded lifecycle and firewall commands with optimistic revisions", () => {
    expect(parseCloudDeploymentActionInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 4,
      action: "reboot",
    })).toEqual({ deploymentId: DEPLOYMENT_ID, expectedRevision: 4, action: "reboot" });
    expect(parseUpdateCloudFirewallInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 4,
      sshCidrs: ["203.0.113.2/32"],
      operatorCidrs: ["2001:db8::/48"],
    })).toMatchObject({ expectedRevision: 4, operatorCidrs: ["2001:db8::/48"] });
    expect(() => parseCloudDeploymentActionInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 4,
      action: "terminate",
    })).toThrow(/Invalid/u);
  });

  it("parses exact AWS firewall rule requests and permits intentional internet-wide peers", () => {
    const rule = parseAwsFirewallRuleSpec({
      ...awsFirewallRule(),
      peer: "0.0.0.0/0",
    });
    const listed = parseListAwsFirewallRulesInput({ deploymentId: DEPLOYMENT_ID });
    const created = parseCreateAwsFirewallRuleInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 4,
      rule,
    });
    const updated = parseUpdateAwsFirewallRuleInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 5,
      ruleId: FIREWALL_RULE_ID,
      rule: {
        direction: "egress",
        protocol: "icmpv6",
        fromPort: -1,
        toPort: -1,
        peerType: "ipv6",
        peer: "::/0",
        description: null,
      },
    });
    const deleted = parseDeleteAwsFirewallRuleInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 6,
      ruleId: FIREWALL_RULE_ID,
    });

    expect(rule.peer).toBe("0.0.0.0/0");
    expect(listed).toEqual({ deploymentId: DEPLOYMENT_ID });
    expect(created).toMatchObject({ expectedRevision: 4, rule: { protocol: "tcp" } });
    expect(updated).toMatchObject({ ruleId: FIREWALL_RULE_ID, rule: { peer: "::/0" } });
    expect(deleted).toEqual({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 6,
      ruleId: FIREWALL_RULE_ID,
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.rule)).toBe(true);

    expect(parseAwsFirewallRuleSpec({
      direction: "egress",
      protocol: "6",
      fromPort: null,
      toPort: null,
      peerType: "prefix-list",
      peer: "pl-0123456789abcdef0",
      description: "AWS service prefix list",
    })).toMatchObject({ protocol: "6", peerType: "prefix-list" });
    expect(parseAwsFirewallRuleSpec({
      direction: "ingress",
      protocol: "udp",
      fromPort: 0,
      toPort: 65_535,
      peerType: "security-group",
      peer: "sg-0123456789abcdef0",
      description: "Allowed punctuation: ._-:/()#,@[]+=&;{}!$*",
    })).toMatchObject({ fromPort: 0, toPort: 65_535 });
  });

  it("rejects malformed AWS firewall rules before they cross the IPC boundary", () => {
    const invalidRules = [
      { ...awsFirewallRule(), extra: true },
      { ...awsFirewallRule(), direction: "both" },
      { ...awsFirewallRule(), protocol: "256", fromPort: null, toPort: null },
      { ...awsFirewallRule(), protocol: "06", fromPort: null, toPort: null },
      { ...awsFirewallRule(), fromPort: 8444, toPort: 8443 },
      { ...awsFirewallRule(), protocol: "icmp", fromPort: -1, toPort: 0 },
      { ...awsFirewallRule(), protocol: "17", fromPort: 53, toPort: 53 },
      { ...awsFirewallRule(), peer: "203.0.113.0/024" },
      { ...awsFirewallRule(), peerType: "ipv6", peer: "203.0.113.0/24" },
      { ...awsFirewallRule(), peerType: "prefix-list", peer: "pl-not-hex" },
      { ...awsFirewallRule(), peerType: "security-group", peer: "sg-not-hex" },
      { ...awsFirewallRule(), description: "question marks are not allowed?" },
      { ...awsFirewallRule(), description: "x".repeat(256) },
    ];
    for (const rule of invalidRules) {
      expect(() => parseAwsFirewallRuleSpec(rule)).toThrow(/Invalid AWS firewall rule/u);
    }
    expect(() => parseListAwsFirewallRulesInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 0,
    })).toThrow(/Invalid/u);
    expect(() => parseCreateAwsFirewallRuleInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: -1,
      rule: awsFirewallRule(),
    })).toThrow(/Invalid/u);
    expect(() => parseUpdateAwsFirewallRuleInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 0,
      ruleId: "bad rule id!",
      rule: awsFirewallRule(),
    })).toThrow(/Invalid/u);
    expect(() => parseDeleteAwsFirewallRuleInput({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 0,
      ruleId: FIREWALL_RULE_ID,
      unexpected: true,
    })).toThrow(/Invalid/u);
  });

  it("parses Azure NSG rules with priorities, access, service tags, and port ranges", () => {
    const rule = parseAzureFirewallRuleSpec({
      name: "allow-sliver-operator",
      priority: 1_200,
      direction: "ingress",
      access: "allow",
      protocol: "tcp",
      sourceAddressPrefixes: ["Internet", "203.0.113.0/24"],
      sourcePortRanges: ["*"],
      destinationAddressPrefixes: ["*"],
      destinationPortRanges: ["31337", "8443"],
      description: "Sliver operator access",
    });
    expect(rule).toMatchObject({
      priority: 1_200,
      sourceAddressPrefixes: ["Internet", "203.0.113.0/24"],
      destinationPortRanges: ["31337", "8443"],
    });
    expect(Object.isFrozen(rule)).toBe(true);
    expect(Object.isFrozen(rule.sourceAddressPrefixes)).toBe(true);
    expect(() => parseAzureFirewallRuleSpec({ ...rule, priority: 99 })).toThrow(/Invalid Azure/u);
    expect(() => parseAzureFirewallRuleSpec({ ...rule, priority: 1_000 })).toThrow(/Invalid Azure/u);
    expect(() => parseAzureFirewallRuleSpec({ ...rule, destinationPortRanges: ["65536"] })).toThrow(/Invalid Azure/u);
    expect(() => parseAzureFirewallRuleSpec({ ...rule, sourceAddressPrefixes: [] })).toThrow(/Invalid Azure/u);
    expect(() => parseAzureFirewallRuleSpec({
      ...rule,
      sourceAddressPrefixes: Array.from({ length: 1_001 }, () => "Internet"),
    })).toThrow(/Invalid Azure/u);
    expect(() => parseAzureFirewallRuleSpec({ ...rule, name: "bad rule name" })).toThrow(/Invalid Azure/u);
  });
});

function awsCredentialInput() {
  return {
    provider: "aws" as const,
    label: "Production AWS",
    defaultRegion: "us-west-2",
    sshUsername: "ubuntu",
    sshPrivateKeyToken: KEY_TOKEN,
    accessKeyId: "AKIAEXAMPLE00000001",
    secretAccessKey: "correct horse battery staple",
    sessionToken: null,
    sshPassphrase: null,
  };
}

function azureCredentialSecret() {
  return {
    subscriptionId: AZURE_SUBSCRIPTION_ID,
    tenantId: AZURE_TENANT_ID,
    sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
    sshPassphrase: null,
  };
}

function azureResolvedCredential() {
  return {
    provider: "azure" as const,
    label: "Azure CLI",
    defaultLocation: "westus2",
    sshUsername: "azureuser",
    secret: azureCredentialSecret(),
  };
}

function awsDeploymentInput() {
  return {
    provider: "aws" as const,
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver AWS",
    spec: {
      region: "us-west-2",
      imageId: "ami-0123456789abcdef0",
      instanceType: "t3.small",
      subnetId: "subnet-0123456789abcdef0",
      vpcId: "vpc-0123456789abcdef0",
      keyPairName: "sliver-gui-key",
      operatorName: "operator",
      sshPort: 22,
      multiplayerPort: 31337,
      volumeSizeGiB: 16,
      useElasticIp: true,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function azureDeploymentInput() {
  return {
    provider: "azure" as const,
    expectedRevision: 0,
    credentialId: CREDENTIAL_ID,
    name: "Sliver Azure",
    spec: {
      location: "westus2",
      imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
      vmSize: "Standard_B2s",
      networkMode: "managed" as const,
      vnetId: null,
      subnetId: null,
      managedVnetCidr: "10.42.0.0/16",
      managedSubnetCidr: "10.42.1.0/24",
      sshUsername: "azureuser",
      operatorName: "operator",
      sshPort: 22,
      multiplayerPort: 31337,
      osDiskSizeGiB: 32,
      usePublicIp: true,
      sshCidrs: ["192.0.2.10/32"],
      operatorCidrs: ["198.51.100.0/24"],
    },
  };
}

function awsDeploymentRecord() {
  return {
    id: DEPLOYMENT_ID,
    provider: "aws" as const,
    name: "Sliver AWS",
    credentialId: CREDENTIAL_ID,
    status: "running" as const,
    phase: "ready" as const,
    createdAt: "2026-09-06T18:00:00.000Z",
    updatedAt: "2026-09-06T18:10:00.000Z",
    operatorConfigFileName: `${DEPLOYMENT_ID}.cfg`,
    operatorConfigDigest: "a".repeat(64),
    remoteHost: "203.0.113.40",
    lastError: null,
    managedAssets: [
      { resourceType: "ec2-instance" as const, resourceId: "i-0123456789abcdef0", displayName: "Sliver AWS", tagged: true },
    ],
    spec: awsDeploymentInput().spec,
    runtime: {
      instanceId: "i-0123456789abcdef0",
      securityGroupIds: ["sg-0123456789abcdef0"],
      volumeIds: ["vol-0123456789abcdef0"],
      networkInterfaceIds: ["eni-0123456789abcdef0"],
      publicIpAddress: "203.0.113.40",
      privateIpAddress: "10.0.0.4",
      availabilityZone: "us-west-2a",
      elasticIpAllocationId: "eipalloc-0123456789abcdef0",
    },
  };
}

function awsFirewallRule() {
  return {
    direction: "ingress" as const,
    protocol: "tcp",
    fromPort: 8443,
    toPort: 8443,
    peerType: "ipv4" as const,
    peer: "203.0.113.0/24",
    description: "Operator API",
  };
}
