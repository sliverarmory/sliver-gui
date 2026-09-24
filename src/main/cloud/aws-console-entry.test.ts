// @vitest-environment node

import { describe, expect, it } from "vitest";

import { awsConsoleEntryUrl } from "./aws-console-entry.js";

describe("AWS Console entry points", () => {
  it.each([
    ["us-west-2", "https://console.aws.amazon.com/"],
    ["eu-central-1", "https://console.aws.amazon.com/"],
    ["ap-southeast-2", "https://console.aws.amazon.com/"],
    ["cn-north-1", "https://console.amazonaws.cn/"],
    ["cn-northwest-1", "https://console.amazonaws.cn/"],
    ["us-gov-east-1", "https://console.amazonaws-us-gov.com/"],
    ["us-gov-west-1", "https://console.amazonaws-us-gov.com/"],
  ])("maps %s to its fixed partition entry point", (region, expected) => {
    const result = awsConsoleEntryUrl(region);
    expect(result).toBe(expected);
    const url = new URL(result);
    expect([url.username, url.password, url.search, url.hash]).toEqual(["", "", "", ""]);
    expect(url.pathname).toBe("/");
  });

  it.each([
    "", " us-west-2", "us-west-2 ", "us-west-2\n", "US-WEST-2", "us-west-0",
    "us-west-2/", "us-west-2?region=cn-north-1", "../us-west-2",
    "https://console.aws.amazon.com/", "https://example.test/", "us-west-2.example.test",
    "us-iso-east-1", "us-isob-east-1", "us-isof-east-1", "eu-isoe-west-1", "eusc-de-east-1",
  ])("rejects invalid or unsupported region %j", (region) => {
    expect(() => awsConsoleEntryUrl(region)).toThrow("The AWS Console region is invalid or unsupported.");
  });
});
