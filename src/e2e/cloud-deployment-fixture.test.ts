import { describe, expect, it } from "vitest";

import { parseCloudDeploymentRecord } from "../shared/cloud-deployment-contracts.js";
import {
  E2E_AZURE_DEPLOYMENT,
  E2E_AZURE_FIREWALL,
} from "./cloud-deployment-fixture.js";

describe("Cloud Deployment E2E fixtures", () => {
  it("keeps the Azure deployment renderer-safe and provider-tagged", () => {
    expect(parseCloudDeploymentRecord(E2E_AZURE_DEPLOYMENT)).toEqual(E2E_AZURE_DEPLOYMENT);
    expect(E2E_AZURE_DEPLOYMENT.managedAssets).not.toHaveLength(0);
    expect(E2E_AZURE_DEPLOYMENT.managedAssets.every(({ tagged }) => tagged)).toBe(true);
    expect(E2E_AZURE_FIREWALL).toMatchObject({
      provider: "azure",
      networkSecurityGroupId: E2E_AZURE_DEPLOYMENT.runtime.networkSecurityGroupId,
    });
  });
});
