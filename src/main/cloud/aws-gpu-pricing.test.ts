import { describe, expect, it, vi } from "vitest";

import { AwsGpuPricing, parseHourlyRate } from "./aws-gpu-pricing.js";

const product = {
  product: { attributes: {
    regionCode: "us-east-1", instanceType: "g4dn.xlarge", operatingSystem: "Linux",
    tenancy: "Shared", preInstalledSw: "NA", capacitystatus: "Used",
  } },
  terms: { OnDemand: { sku: { priceDimensions: { hourly: {
    unit: "Hrs", pricePerUnit: { USD: "0.5260000000" },
  } } } } },
};

describe("AWS GPU On-Demand pricing", () => {
  it("accepts only the exact region, type, and Linux shared compute rate", () => {
    expect(parseHourlyRate(product, "us-east-1", "g4dn.xlarge")).toBe(0.526);
    expect(parseHourlyRate(product, "us-west-2", "g4dn.xlarge")).toBeNull();
    expect(parseHourlyRate(product, "us-east-1", "g6.xlarge")).toBeNull();
    expect(parseHourlyRate({ ...product, product: { attributes: { ...product.product.attributes, tenancy: "Dedicated" } } }, "us-east-1", "g4dn.xlarge")).toBeNull();
  });

  it("does not invent a price when AWS returns ambiguous rates", async () => {
    const client = { send: vi.fn(async () => ({ PriceList: [product, {
      ...product, terms: { OnDemand: { sku: { priceDimensions: { hourly: { unit: "Hrs", pricePerUnit: { USD: "0.600" } } } } } },
    }] })) };
    const pricing = new AwsGpuPricing({ accessKeyId: "test", secretAccessKey: "test" }, { client });
    expect(await pricing.hourlyUsd("us-east-1", "g4dn.xlarge")).toBeNull();
    expect(client.send).toHaveBeenCalledOnce();
  });
});
