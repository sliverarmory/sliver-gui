import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";

import { isAwsRegion } from "../../shared/cloud-deployment-contracts.js";
import type { AwsEc2CredentialSource } from "./aws-ec2-provider.js";

interface PricingClientLike {
  send(command: unknown): Promise<unknown>;
}

interface PricingProduct {
  product?: { attributes?: Record<string, unknown> };
  terms?: { OnDemand?: Record<string, { priceDimensions?: Record<string, { unit?: string; pricePerUnit?: { USD?: string } }> }> };
}

export interface AwsGpuPricingOptions {
  readonly client?: PricingClientLike;
}

/** Retrieves an exact, region-specific Linux/Shared EC2 On-Demand compute rate. */
export class AwsGpuPricing {
  readonly #client: PricingClientLike;

  constructor(credentials: AwsEc2CredentialSource, options: AwsGpuPricingOptions = {}) {
    // Pricing is a global catalog whose Query API has a us-east-1 endpoint.
    this.#client = options.client ?? new PricingClient({ region: "us-east-1", credentials });
  }

  async hourlyUsd(region: string, instanceType: string): Promise<number | null> {
    if (!isAwsRegion(region) || !/^[a-z][a-z0-9-]*\.[a-z0-9]+$/u.test(instanceType)) {
      throw new TypeError("Invalid EC2 pricing lookup");
    }
    const filters = [
      { Type: "TERM_MATCH" as const, Field: "regionCode", Value: region },
      { Type: "TERM_MATCH" as const, Field: "instanceType", Value: instanceType },
      { Type: "TERM_MATCH" as const, Field: "operatingSystem", Value: "Linux" },
      { Type: "TERM_MATCH" as const, Field: "tenancy", Value: "Shared" },
      { Type: "TERM_MATCH" as const, Field: "preInstalledSw", Value: "NA" },
      { Type: "TERM_MATCH" as const, Field: "capacitystatus", Value: "Used" },
    ];
    const rates = new Set<number>();
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const response = await this.#client.send(new GetProductsCommand({
        ServiceCode: "AmazonEC2", Filters: filters, MaxResults: 100,
        ...(nextToken ? { NextToken: nextToken } : {}),
      })) as { PriceList?: unknown; NextToken?: unknown };
      if (!Array.isArray(response.PriceList)) throw new Error("AWS Pricing returned an invalid price list");
      for (const item of response.PriceList) {
        const product = typeof item === "string" ? JSON.parse(item) as unknown : item;
        const rate = parseHourlyRate(product, region, instanceType);
        if (rate !== null) rates.add(rate);
      }
      if (response.NextToken === undefined || response.NextToken === null) break;
      if (typeof response.NextToken !== "string" || response.NextToken.length > 4_096 || seenTokens.has(response.NextToken)) {
        throw new Error("AWS Pricing returned an invalid pagination token");
      }
      seenTokens.add(response.NextToken);
      nextToken = response.NextToken;
      if (page === 7) throw new Error("AWS Pricing returned too many pages");
    }
    // A missing or ambiguous rate is never silently replaced with a price from
    // another region, OS, or purchase model.
    return rates.size === 1 ? [...rates][0]! : null;
  }
}

export function parseHourlyRate(value: unknown, region: string, instanceType: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const product = value as PricingProduct;
  const attributes = product.product?.attributes;
  if (!attributes || attributes["regionCode"] !== region || attributes["instanceType"] !== instanceType ||
      attributes["operatingSystem"] !== "Linux" || attributes["tenancy"] !== "Shared" ||
      attributes["preInstalledSw"] !== "NA" || attributes["capacitystatus"] !== "Used") return null;
  const rates: number[] = [];
  for (const offer of Object.values(product.terms?.OnDemand ?? {})) {
    for (const dimension of Object.values(offer.priceDimensions ?? {})) {
      if (dimension.unit !== "Hrs") continue;
      const text = dimension.pricePerUnit?.USD;
      if (typeof text !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) continue;
      const rate = Number(text);
      if (Number.isFinite(rate) && rate > 0) rates.push(rate);
    }
  }
  return rates.length === 1 ? rates[0]! : null;
}
