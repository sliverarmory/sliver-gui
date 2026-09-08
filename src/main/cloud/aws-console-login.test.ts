// @vitest-environment node

import { createHash, createPublicKey, generateKeyPairSync, verify, type webcrypto } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { AwsConsoleLogin, type AwsConsoleLoginSession } from "./aws-console-login.js";

const NOW = Date.parse("2026-09-08T20:00:00.000Z");
const ARN = "arn:aws:iam::123456789012:user/test-user";
const ACCESS_KEY = "ASIAIOSFODNN7EXAMPLE";

function tokenOutput(arn = ARN): Record<string, unknown> {
  return {
    accessToken: { accessKeyId: ACCESS_KEY, secretAccessKey: "test-secret-access-key", sessionToken: "test-session-token" },
    tokenType: "urn:aws:params:oauth:token-type:access_token_sigv4",
    expiresIn: 900,
    refreshToken: "test-refresh-token",
    idToken: `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: arn })).toString("base64url")}.dGVzdC1zaWduYXR1cmU`,
  };
}

function storedSession(): AwsConsoleLoginSession {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    loginSessionArn: ARN,
    region: "us-west-2",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: "test-secret-access-key",
    sessionToken: "test-session-token",
    expiresAt: new Date(NOW + 10_000).toISOString(),
    refreshToken: "test-refresh-token",
    privateKey: privateKey.export({ type: "sec1", format: "pem" }).toString(),
  };
}

function callbackInfo(authorization: string): { authorizationUrl: URL; redirectUri: string; state: string } {
  const authorizationUrl = new URL(authorization);
  return {
    authorizationUrl,
    redirectUri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
    state: authorizationUrl.searchParams.get("state") ?? "",
  };
}

function callbackRequest(
  redirectUri: string,
  query: Record<string, string>,
  options: { method?: string; host?: string; path?: string } = {},
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams(query).toString();
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method ?? "GET",
      ...(options.host ? { headers: { Host: options.host } } : {}),
      ...(options.path ? { path: options.path } : {}),
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (data: string) => { body += data; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    req.setTimeout(2_000, () => req.destroy(new Error("test callback timeout")));
    req.on("error", reject);
    req.end();
  });
}

function proofContents(options: RequestInit | undefined): {
  header: { typ: string; alg: string; jwk: webcrypto.JsonWebKey };
  payload: Record<string, unknown>;
} {
  const proof = new Headers(options?.headers).get("DPoP") ?? "";
  const [headerPart = "", payloadPart = "", signaturePart = ""] = proof.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString()) as { typ: string; alg: string; jwk: webcrypto.JsonWebKey };
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString()) as Record<string, unknown>;
  const signature = Buffer.from(signaturePart, "base64url");
  expect(signature).toHaveLength(64);
  expect(verify("sha256", Buffer.from(`${headerPart}.${payloadPart}`), {
    key: createPublicKey({ key: header.jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, signature)).toBe(true);
  return { header, payload };
}

describe("AWS console browser login", () => {
  it("exchanges a single loopback authorization with PKCE and a verifiable DPoP proof", async () => {
    let authorization: ReturnType<typeof callbackInfo> | undefined;
    let callbackResponse: Awaited<ReturnType<typeof callbackRequest>> | undefined;
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json(tokenOutput()));
    const login = new AwsConsoleLogin({
      now: () => NOW,
      fetch: tokenFetch,
      openExternal: async (url) => {
        authorization = callbackInfo(url);
        callbackResponse = await callbackRequest(authorization.redirectUri, { state: authorization.state, code: "single-use-code" });
      },
    });

    const session = await login.login("us-west-2");

    expect(authorization?.authorizationUrl.origin).toBe("https://us-west-2.signin.aws.amazon.com");
    expect(authorization?.authorizationUrl.pathname).toBe("/v1/authorize");
    const params = authorization?.authorizationUrl.searchParams;
    expect(params?.get("client_id")).toBe("arn:aws:signin:::devtools/same-device");
    expect(params?.get("code_challenge_method")).toBe("SHA-256");
    expect(params?.get("response_type")).toBe("code");
    expect(params?.get("scope")).toBe("openid");
    expect(authorization?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/u);
    expect(authorization?.state).toMatch(/^[0-9a-f-]{36}$/u);
    expect(callbackResponse?.status).toBe(200);
    expect(callbackResponse?.headers["cache-control"]).toBe("no-store");
    expect(callbackResponse?.body).not.toMatch(/single-use-code|test-session-token/u);
    expect(tokenFetch).toHaveBeenCalledOnce();
    const [url, options] = tokenFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://us-west-2.signin.aws.amazon.com/v1/token");
    expect(options).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    const input = JSON.parse(String(options?.body)) as Record<string, string>;
    expect(Object.keys(input).sort()).toEqual(["clientId", "code", "codeVerifier", "grantType", "redirectUri"]);
    expect(input).toMatchObject({ clientId: params?.get("client_id"), grantType: "authorization_code", code: "single-use-code", redirectUri: authorization?.redirectUri });
    expect(input["codeVerifier"]).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(createHash("sha256").update(input["codeVerifier"] ?? "").digest("base64url")).toBe(params?.get("code_challenge"));
    const proof = proofContents(options);
    expect(proof.header).toMatchObject({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256" } });
    expect(proof.header.jwk).not.toHaveProperty("d");
    expect(proof.payload).toMatchObject({ htm: "POST", htu: url, iat: NOW / 1000 });
    expect(proof.payload["jti"]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(session).toMatchObject({ loginSessionArn: ARN, region: "us-west-2", accessKeyId: ACCESS_KEY, expiresAt: "2026-09-08T20:15:00.000Z", refreshToken: "test-refresh-token" });
    expect(session.privateKey).toContain("BEGIN EC PRIVATE KEY");
    expect(Object.isFrozen(session)).toBe(true);
    await expect(callbackRequest(authorization?.redirectUri ?? "", { state: authorization?.state ?? "", code: "replay" })).rejects.toThrow();
  });

  it("rejects wrong state, duplicate state, method, path, and Host without consuming a valid callback", async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json(tokenOutput()));
    const login = new AwsConsoleLogin({
      fetch: tokenFetch,
      openExternal: async (url) => {
        const { redirectUri, state } = callbackInfo(url);
        expect((await callbackRequest(redirectUri, { state: "wrong-state", code: "bad" })).status).toBe(400);
        expect((await callbackRequest(redirectUri, { state, code: "bad" }, { method: "POST" })).status).toBe(405);
        expect((await callbackRequest(redirectUri, { state, code: "bad" }, { host: "attacker.example" })).status).toBe(400);
        expect((await callbackRequest(redirectUri, {}, { path: `/not-callback?state=${state}&code=bad` })).status).toBe(400);
        expect((await callbackRequest(redirectUri, {}, { path: `/oauth/callback?state=${state}&state=${state}&code=bad` })).status).toBe(400);
        expect((await callbackRequest(redirectUri, {}, { path: `/oauth/callback?state=${state}&code=a&code=b` })).status).toBe(400);
        expect(tokenFetch).not.toHaveBeenCalled();
        expect((await callbackRequest(redirectUri, { state, code: "correct-code" })).status).toBe(200);
      },
    });
    await expect(login.login("us-west-2")).resolves.toMatchObject({ loginSessionArn: ARN });
    expect(tokenFetch).toHaveBeenCalledOnce();
  });

  it.each([513, 4096, 16 * 1024])("exchanges an opaque %i-byte authorization code without truncation", async (length) => {
    // AWS CLI/SDK do not enforce the model's max:512. Include characters
    // requiring URL encoding so this covers the HTTP request limit as well.
    const authorizationCode = "+/=".repeat(Math.ceil(length / 3)).slice(0, length);
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json(tokenOutput()));
    const login = new AwsConsoleLogin({
      fetch: tokenFetch,
      timeoutMs: 1000,
      openExternal: async (url) => {
        const { redirectUri, state } = callbackInfo(url);
        const response = await callbackRequest(redirectUri, { state, code: authorizationCode });
        expect(response.status).toBe(200);
        expect(response.body).not.toContain(authorizationCode);
      },
    });
    await expect(login.login("us-west-2")).resolves.toMatchObject({ loginSessionArn: ARN });
    expect(tokenFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(tokenFetch.mock.calls[0]?.[1]?.body))).toMatchObject({ code: authorizationCode });
  });

  it("rejects oversized and control-bearing codes without consuming the pending login", async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json(tokenOutput()));
    const login = new AwsConsoleLogin({ fetch: tokenFetch, openExternal: async (url) => {
      const { redirectUri, state } = callbackInfo(url);
      for (const code of ["x".repeat(16 * 1024 + 1), "invalid\u0000code", "invalid\ncode"]) {
        expect((await callbackRequest(redirectUri, { state, code })).status).toBe(400);
      }
      expect(tokenFetch).not.toHaveBeenCalled();
      expect((await callbackRequest(redirectUri, { state, code: "valid-after-rejection" })).status).toBe(200);
    } });
    await expect(login.login("us-west-2")).resolves.toMatchObject({ loginSessionArn: ARN });
    expect(tokenFetch).toHaveBeenCalledOnce();
  });

  it("handles an AWS callback denial without echoing authorization parameters", async () => {
    const tokenFetch = vi.fn<typeof fetch>();
    const login = new AwsConsoleLogin({
      fetch: tokenFetch,
      openExternal: async (url) => {
        const { redirectUri, state } = callbackInfo(url);
        const response = await callbackRequest(redirectUri, { state, error: "access_denied", error_description: "PRIVATE_ACCOUNT_DETAILS" });
        expect(response.status).toBe(400);
        expect(response.body).not.toContain("PRIVATE_ACCOUNT_DETAILS");
      },
    });
    await expect(login.login("us-west-2")).rejects.toMatchObject({ code: "authorization-failed" });
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["cn-north-1", "https://cn-north-1.signin.amazonaws.cn", "arn:aws-cn:iam::123456789012:user/test"],
    ["us-gov-west-1", "https://us-gov-west-1.signin.amazonaws-us-gov.com", "arn:aws-us-gov:iam::123456789012:user/test"],
  ])("uses official regional endpoint rules for %s", async (region, endpoint, arn) => {
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json(tokenOutput(arn)));
    const login = new AwsConsoleLogin({ fetch: tokenFetch, openExternal: async (url) => {
      const { authorizationUrl, redirectUri, state } = callbackInfo(url);
      expect(authorizationUrl.origin).toBe(endpoint);
      expect(authorizationUrl.searchParams.get("client_id")).toBe("arn:aws:signin:::devtools/same-device");
      await callbackRequest(redirectUri, { state, code: "valid-code" });
    } });
    await expect(login.login(region)).resolves.toMatchObject({ loginSessionArn: arn });
    expect(tokenFetch.mock.calls[0]?.[0]).toBe(`${endpoint}/v1/token`);
  });

  it.each(["us-iso-east-1", "eusc-de-east-1", "us-east-1.attacker.example", "https://attacker.example", "../us-east-1"])("rejects unsupported or malformed endpoint input %s", async (region) => {
    const openExternal = vi.fn(async () => undefined);
    const tokenFetch = vi.fn<typeof fetch>();
    await expect(new AwsConsoleLogin({ openExternal, fetch: tokenFetch }).login(region)).rejects.toMatchObject({ code: "invalid-input" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it("times out while waiting for a browser callback and closes its listener", async () => {
    let redirectUri = "";
    const tokenFetch = vi.fn<typeof fetch>();
    const login = new AwsConsoleLogin({ timeoutMs: 75, fetch: tokenFetch, openExternal: async (url) => { redirectUri = callbackInfo(url).redirectUri; } });
    await expect(login.login("us-west-2")).rejects.toMatchObject({ code: "timeout" });
    expect(tokenFetch).not.toHaveBeenCalled();
    await expect(callbackRequest(redirectUri, { state: "late", code: "late" })).rejects.toThrow();
  });

  it("cancels while the browser launcher is pending and closes the listener", async () => {
    const controller = new AbortController();
    let redirectUri = "";
    const tokenFetch = vi.fn<typeof fetch>();
    const login = new AwsConsoleLogin({ fetch: tokenFetch, openExternal: async (url) => {
      redirectUri = callbackInfo(url).redirectUri;
      controller.abort(new Error("PRIVATE_CANCEL_REASON"));
      return new Promise(() => undefined);
    } });
    const error: unknown = await login.login("us-west-2", controller.signal).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(String(error)).not.toContain("PRIVATE_CANCEL_REASON");
    expect(tokenFetch).not.toHaveBeenCalled();
    await expect(callbackRequest(redirectUri, { state: "late", code: "late" })).rejects.toThrow();
  });

  it("does not open a browser for an already cancelled login", async () => {
    const controller = new AbortController();
    controller.abort();
    const openExternal = vi.fn(async () => undefined);
    await expect(new AwsConsoleLogin({ openExternal }).login("us-west-2", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("sanitizes a browser launch failure and releases the listener", async () => {
    let redirectUri = "";
    const login = new AwsConsoleLogin({ openExternal: async (url) => {
      redirectUri = callbackInfo(url).redirectUri;
      throw new Error("PRIVATE_BROWSER_ERROR");
    } });
    const error: unknown = await login.login("us-west-2").catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "browser-open-failed" });
    expect(String(error)).not.toContain("PRIVATE_BROWSER_ERROR");
    await expect(callbackRequest(redirectUri, { state: "late", code: "late" })).rejects.toThrow();
  });
});

describe("AWS console session refresh", () => {
  it("retains compatibility with the short SigV4 token type documented by SDK models", async () => {
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json({ ...tokenOutput(), tokenType: "aws_sigv4" }));
    await expect(new AwsConsoleLogin({ openExternal: async () => undefined, fetch: tokenFetch }).refresh(storedSession()))
      .resolves.toMatchObject({ loginSessionArn: ARN, accessKeyId: ACCESS_KEY });
  });

  it("rotates temporary credentials and refresh token using the original proof key without a browser", async () => {
    const session = storedSession();
    const output = tokenOutput();
    delete output["idToken"];
    output["refreshToken"] = "rotated-refresh-token";
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json(output));
    const openExternal = vi.fn(async () => undefined);
    const login = new AwsConsoleLogin({ fetch: tokenFetch, openExternal, now: () => NOW });

    const refreshed = await login.refresh(session);
    const refreshedAgain = await login.refresh(refreshed);

    expect(openExternal).not.toHaveBeenCalled();
    expect(refreshed).toMatchObject({ loginSessionArn: session.loginSessionArn, privateKey: session.privateKey, expiresAt: "2026-09-08T20:15:00.000Z", refreshToken: "rotated-refresh-token" });
    expect(refreshedAgain.loginSessionArn).toBe(ARN);
    expect(JSON.parse(String(tokenFetch.mock.calls[0]?.[1]?.body))).toEqual({ clientId: "arn:aws:signin:::devtools/same-device", grantType: "refresh_token", refreshToken: "test-refresh-token" });
    expect(JSON.parse(String(tokenFetch.mock.calls[1]?.[1]?.body))).toMatchObject({ refreshToken: "rotated-refresh-token" });
    const firstProof = proofContents(tokenFetch.mock.calls[0]?.[1]);
    const secondProof = proofContents(tokenFetch.mock.calls[1]?.[1]);
    expect(firstProof.header.jwk).toEqual(createPublicKey(session.privateKey).export({ format: "jwk" }));
    expect(secondProof.header.jwk).toEqual(firstProof.header.jwk);
    expect(firstProof.payload["jti"]).not.toBe(secondProof.payload["jti"]);
  });

  it.each([
    ["TOKEN_EXPIRED", "login-required"],
    ["USER_CREDENTIALS_CHANGED", "login-required"],
    ["INSUFFICIENT_PERMISSIONS", "insufficient-permissions"],
    ["AUTHCODE_EXPIRED", "authorization-failed"],
    ["INVALID_REQUEST", "token-request-failed"],
  ])("maps %s to a stable error without remote details", async (serviceCode, expectedCode) => {
    const tokenFetch = vi.fn<typeof fetch>(async () => Response.json({ error: serviceCode, message: "PRIVATE_TOKEN_AND_ACCOUNT_DETAILS" }, { status: 403 }));
    const error: unknown = await new AwsConsoleLogin({ openExternal: async () => undefined, fetch: tokenFetch }).refresh(storedSession()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: expectedCode });
    expect(String(error)).not.toContain("PRIVATE_TOKEN_AND_ACCOUNT_DETAILS");
  });

  it.each([
    () => Response.json({ ...tokenOutput(), expiresIn: 901 }),
    () => Response.json({ ...tokenOutput(), expiresIn: -1 }),
    () => Response.json({ ...tokenOutput(), tokenType: "Bearer" }),
    () => Response.json({ ...tokenOutput(), tokenType: "urn:aws:params:oauth:token-type:access_token_sigv4.other" }),
    () => Response.json({ ...tokenOutput(), tokenType: null }),
    () => Response.json({ ...tokenOutput(), refreshToken: "" }),
    () => Response.json({ ...tokenOutput(), accessToken: { accessKeyId: ACCESS_KEY } }),
    () => new Response("{invalid PRIVATE_TOKEN_JSON", { headers: { "content-type": "application/json" } }),
    () => new Response("PRIVATE_TOKEN_JSON", { headers: { "content-type": "text/html" } }),
    () => new Response("{}", { headers: { "content-length": "65537" } }),
    () => new Response("x".repeat(65537)),
  ])("rejects invalid or oversized token output", async (response) => {
    const tokenFetch = vi.fn<typeof fetch>(async () => response());
    const error: unknown = await new AwsConsoleLogin({ openExternal: async () => undefined, fetch: tokenFetch }).refresh(storedSession()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "token-request-failed" });
    expect(String(error)).not.toContain("PRIVATE_TOKEN");
  });

  it("times out a stalled token body and cancels the stream", async () => {
    const cancel = vi.fn();
    const tokenFetch = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })));
    await expect(new AwsConsoleLogin({ timeoutMs: 75, openExternal: async () => undefined, fetch: tokenFetch }).refresh(storedSession())).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight token request without leaking the caller's cancellation reason", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | null | undefined;
    const tokenFetch = vi.fn<typeof fetch>(async (_url, options) => {
      fetchSignal = options?.signal;
      controller.abort(new Error("PRIVATE_REASON"));
      return new Promise(() => undefined);
    });
    const error: unknown = await new AwsConsoleLogin({ openExternal: async () => undefined, fetch: tokenFetch }).refresh(storedSession(), controller.signal).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(String(error)).not.toContain("PRIVATE_REASON");
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("rejects a mismatched identity partition and a non-P256 proof key", async () => {
    const tokenFetch = vi.fn<typeof fetch>();
    const login = new AwsConsoleLogin({ openExternal: async () => undefined, fetch: tokenFetch });
    await expect(login.refresh({ ...storedSession(), region: "cn-north-1" })).rejects.toMatchObject({ code: "invalid-input" });
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    await expect(login.refresh({ ...storedSession(), privateKey: privateKey.export({ type: "sec1", format: "pem" }).toString() })).rejects.toMatchObject({ code: "invalid-input" });
    expect(tokenFetch).not.toHaveBeenCalled();
  });
});
