// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  CURRENT_EGRESS_IPV4_MAX_RESPONSE_BYTES,
  CURRENT_EGRESS_IPV4_URL,
  CurrentEgressIpv4Error,
  detectCurrentEgressIpv4,
} from "./current-egress-ipv4.js";

describe("current public IPv4 lookup", () => {
  it("returns an exact IPv4 address and its /32 CIDR from the fixed endpoint", async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response("203.0.113.42\r\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }));

    const result = await detectCurrentEgressIpv4(fetchImpl);

    expect(result).toEqual({ address: "203.0.113.42", cidr: "203.0.113.42/32" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(CURRENT_EGRESS_IPV4_URL, expect.objectContaining({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ Accept: "text/plain" }),
    }));
  });

  it.each([
    ["IPv6", "2001:db8::1\n"],
    ["CIDR suffix", "203.0.113.42/32\n"],
    ["additional text", "public address: 203.0.113.42\n"],
    ["empty content", "\n"],
  ])("rejects %s instead of accepting it as an IPv4 response", async (_label, body) => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(body, {
      headers: { "Content-Type": "text/plain" },
    }));

    await expect(detectCurrentEgressIpv4(fetchImpl)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("rejects unsuccessful and unexpected content responses without exposing their bodies", async () => {
    const secret = "DO_NOT_EXPOSE_RESPONSE_BODY";
    for (const response of [
      new Response(secret, { status: 503, headers: { "Content-Type": "text/plain" } }),
      new Response(secret, { status: 200, headers: { "Content-Type": "text/html" } }),
    ]) {
      const error = await detectCurrentEgressIpv4(async () => response).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(CurrentEgressIpv4Error);
      expect(error).toMatchObject({ code: "invalid-response" });
      expect(String(error)).not.toContain(secret);
    }
  });

  it("bounds streamed response bodies even without a Content-Length header", async () => {
    const secret = "S".repeat(CURRENT_EGRESS_IPV4_MAX_RESPONSE_BYTES + 1);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(secret));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/plain" } });

    const error = await detectCurrentEgressIpv4(async () => response).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "invalid-response" });
    expect(String(error)).not.toContain(secret);
  });

  it("rejects an advertised oversized body before reading it", async () => {
    const response = new Response("203.0.113.42\n", {
      headers: {
        "Content-Type": "text/plain",
        "Content-Length": String(CURRENT_EGRESS_IPV4_MAX_RESPONSE_BYTES + 1),
      },
    });

    await expect(detectCurrentEgressIpv4(async () => response)).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("aborts a stalled lookup and returns a stable request error", async () => {
    const providerDetail = "DO_NOT_EXPOSE_PROVIDER_ERROR";
    const fetchImpl: typeof fetch = vi.fn((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(providerDetail)), { once: true });
    }));

    const error = await detectCurrentEgressIpv4(fetchImpl, { timeoutMs: 5 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: "request-failed" });
    expect(String(error)).not.toContain(providerDetail);
  });
});
