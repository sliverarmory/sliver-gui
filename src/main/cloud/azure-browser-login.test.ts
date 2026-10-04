// @vitest-environment node

import { request } from "node:http";

import type { AccountInfo, AuthenticationResult, Configuration, InteractiveRequest } from "@azure/msal-node";
import { describe, expect, it, vi } from "vitest";

import { AZURE_DEVELOPER_CLIENT_ID, AZURE_MANAGEMENT_SCOPE, AzureBrowserLogin, type AzureBrowserLoginSession, type AzureMsalClient } from "./azure-browser-login.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "22222222-2222-3333-4444-555555555555";
const SUBSCRIPTION = "33333333-2222-3333-4444-555555555555";
const CLIENT = "44444444-2222-3333-4444-555555555555";
const ACCOUNT: AccountInfo = {
  homeAccountId: `test-user.${TENANT}`,
  localAccountId: "test-local-user",
  tenantId: TENANT,
  username: "test@example.test",
  environment: "login.windows.net",
};

function authResult(overrides: Partial<AuthenticationResult> = {}): AuthenticationResult {
  return {
    authority: `https://login.microsoftonline.com/${TENANT}`,
    uniqueId: ACCOUNT.localAccountId,
    tenantId: TENANT,
    scopes: [AZURE_MANAGEMENT_SCOPE],
    account: ACCOUNT,
    idToken: "private-id-token",
    idTokenClaims: {},
    accessToken: "private-access-token",
    fromCache: false,
    expiresOn: new Date(Date.now() + 60 * 60_000),
    tokenType: "Bearer",
    correlationId: "test-correlation",
    ...overrides,
  };
}

function session(overrides: Partial<AzureBrowserLoginSession> = {}): AzureBrowserLoginSession {
  return {
    clientId: AZURE_DEVELOPER_CLIENT_ID,
    homeAccountId: ACCOUNT.homeAccountId,
    localAccountId: ACCOUNT.localAccountId,
    tenantId: TENANT,
    username: ACCOUNT.username,
    cache: '{"RefreshToken":{"secret":"private-refresh-token"}}',
    ...overrides,
  };
}

function subscriptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { value: [{ subscriptionId: SUBSCRIPTION, tenantId: TENANT, displayName: "Test subscription", state: "Enabled" }], ...overrides };
}

function callback(url: string, params: Record<string, string>, options: { method?: string; host?: string; path?: string } = {}): Promise<{ status: number; body: string }> {
  const target = new URL(url);
  target.search = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = request(target, {
      hostname: "127.0.0.1",
      method: options.method ?? "GET",
      headers: { Host: options.host ?? target.host },
      ...(options.path ? { path: options.path } : {}),
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (data: string) => { body += data; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.setTimeout(2000, () => req.destroy(new Error("test timeout")));
    req.on("error", reject);
    req.end();
  });
}

function callbackInfo(value: string): { redirectUri: string; state: string } {
  const url = new URL(value);
  return { redirectUri: url.searchParams.get("redirect_uri") ?? "", state: url.searchParams.get("state") ?? "" };
}

function fixture(options: {
  openExternal?: (url: string) => Promise<unknown>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  accounts?: AccountInfo[];
  result?: AuthenticationResult;
  interactive?: (request: InteractiveRequest, config: Configuration) => Promise<AuthenticationResult>;
} = {}) {
  let configuration!: Configuration;
  const cache = {
    serialize: vi.fn(() => session().cache),
    deserialize: vi.fn((_cache: string) => undefined),
    getAllAccounts: vi.fn(async () => options.accounts ?? [ACCOUNT]),
  };
  const acquireTokenInteractive = vi.fn<AzureMsalClient["acquireTokenInteractive"]>(async (input) => {
    if (options.interactive) return options.interactive(input, configuration);
    const loopback = input.loopbackClient!;
    const code = loopback.listenForAuthCode();
    let redirectUri = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      try { redirectUri = loopback.getRedirectUri(); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 1)); }
    }
    if (!redirectUri) throw new Error("test listener unavailable");
    const url = new URL(`${configuration.auth.authority}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: configuration.auth.clientId, state: input.state ?? "",
      redirect_uri: redirectUri, response_type: "code", code_challenge_method: "S256",
    }).toString();
    try {
      await input.openBrowser(url.toString());
      await code;
      return options.result ?? authResult();
    } finally { loopback.closeServer(); }
  });
  const acquireTokenSilent = vi.fn<AzureMsalClient["acquireTokenSilent"]>(async () => options.result ?? authResult());
  const msalFactory = vi.fn((config: Configuration): AzureMsalClient => {
    configuration = config;
    return { getTokenCache: () => cache, acquireTokenInteractive, acquireTokenSilent };
  });
  const fetchImpl = options.fetch ?? vi.fn<typeof fetch>(async () => Response.json(subscriptions()));
  const openExternal = options.openExternal ?? (async (url) => {
    const { redirectUri, state } = callbackInfo(url);
    expect((await callback(redirectUri, { state, code: "valid-authorization" })).status).toBe(200);
  });
  const login = new AzureBrowserLogin({ openExternal, fetch: fetchImpl, msalFactory, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  return { login, msalFactory, cache, acquireTokenInteractive, acquireTokenSilent, fetchImpl, config: () => configuration };
}

describe("native Azure login", () => {
  it("delegates PKCE to MSAL, uses Microsoft's developer client by default, and returns safe subscription summaries", async () => {
    const f = fixture();
    const result = await f.login.login(null, null);
    expect(f.config().auth).toEqual({ clientId: AZURE_DEVELOPER_CLIENT_ID, authority: "https://login.microsoftonline.com/common" });
    expect(f.acquireTokenInteractive.mock.calls[0]?.[0]).toMatchObject({ scopes: [AZURE_MANAGEMENT_SCOPE], prompt: "select_account", responseMode: "query" });
    expect(result.session).toEqual(session());
    expect(result.subscriptions).toEqual([{ subscriptionId: SUBSCRIPTION, tenantId: TENANT, homeTenantId: TENANT, name: "Test subscription", isDefault: false, cloudName: "AzureCloud" }]);
    expect(JSON.stringify(result.subscriptions)).not.toMatch(/private|accessToken|RefreshToken/u);
    expect(f.fetchImpl).toHaveBeenCalledWith("https://management.azure.com/subscriptions?api-version=2022-12-01", expect.objectContaining({ method: "GET", redirect: "error", credentials: "omit", headers: expect.objectContaining({ Authorization: "Bearer private-access-token" }) }));
    expect(Object.isFrozen(result.session)).toBe(true);
  });

  it("accepts a selected Entra registration and exact tenant", async () => {
    const f = fixture();
    const result = await f.login.login(TENANT, CLIENT);
    expect(f.config().auth).toEqual({ clientId: CLIENT, authority: `https://login.microsoftonline.com/${TENANT}` });
    expect(result.session.clientId).toBe(CLIENT);
  });

  it("ignores wrong state, duplicate state, bad method/path/Host and accepts only the valid one", async () => {
    let redirectUri = "";
    const f = fixture({ openExternal: async (url) => {
      const info = callbackInfo(url);
      redirectUri = info.redirectUri;
      expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/u);
      expect((await callback(redirectUri, { state: "wrong", code: "invalid" })).status).toBe(400);
      expect((await callback(redirectUri, { state: info.state, code: "invalid" }, { method: "POST" })).status).toBe(405);
      expect((await callback(redirectUri, { state: info.state, code: "invalid" }, { host: "attacker.test" })).status).toBe(400);
      expect((await callback(redirectUri, {}, { path: `/other?state=${info.state}&code=invalid` })).status).toBe(400);
      expect((await callback(redirectUri, {}, { path: `/?state=${info.state}&state=${info.state}&code=invalid` })).status).toBe(400);
      const response = await callback(redirectUri, { state: info.state, code: "valid-code" });
      expect(response.status).toBe(200);
      expect(response.body).not.toContain("valid-code");
    } });
    await expect(f.login.login(null, null)).resolves.toMatchObject({ session: { tenantId: TENANT } });
    await expect(callback(redirectUri, { state: "late", code: "late" })).rejects.toThrow();
  });

  it("sanitizes user denial and browser launch failure", async () => {
    const denied = fixture({ openExternal: async (url) => {
      const { redirectUri, state } = callbackInfo(url);
      const response = await callback(redirectUri, { state, error: "access_denied", error_description: "PRIVATE_DESCRIPTION" });
      expect(response.body).not.toContain("PRIVATE_DESCRIPTION");
    } });
    await expect(denied.login.login(null, null)).rejects.toMatchObject({ code: "authorization-failed" });
    const failed = fixture({ openExternal: async () => { throw new Error("PRIVATE_BROWSER_DETAILS"); } });
    const error = await failed.login.login(null, null).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "browser-open-failed" });
    expect(String(error)).not.toContain("PRIVATE_BROWSER_DETAILS");
  });

  it("closes its callback listener on timeout and cancellation", async () => {
    let redirectUri = "";
    const timed = fixture({ timeoutMs: 50, openExternal: async (url) => { redirectUri = callbackInfo(url).redirectUri; } });
    await expect(timed.login.login(null, null)).rejects.toMatchObject({ code: "timeout" });
    await expect(callback(redirectUri, { state: "late", code: "late" })).rejects.toThrow();
    const controller = new AbortController();
    const cancelled = fixture({ openExternal: async (url) => {
      redirectUri = callbackInfo(url).redirectUri;
      controller.abort(new Error("PRIVATE_CANCEL_REASON"));
      return new Promise(() => undefined);
    } });
    const error = await cancelled.login.login(null, null, controller.signal).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(String(error)).not.toContain("PRIVATE_CANCEL_REASON");
    await expect(callback(redirectUri, { state: "late", code: "late" })).rejects.toThrow();
  });

  it("does not start an already cancelled or invalid login", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.login.login(null, null, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    await expect(f.login.login("https://attacker.test", null)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(f.login.login(null, "not-an-app-id")).rejects.toMatchObject({ code: "invalid-input" });
    expect(f.msalFactory).not.toHaveBeenCalled();
  });

  it("rejects another tenant's authentication result", async () => {
    const f = fixture();
    await expect(f.login.login(OTHER_TENANT, null)).rejects.toMatchObject({ code: "login-required" });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { value: [{ subscriptionId: SUBSCRIPTION, tenantId: OTHER_TENANT, displayName: "Other tenant", state: "Enabled" }] },
    { value: [{ subscriptionId: SUBSCRIPTION, tenantId: TENANT, displayName: "x".repeat(257), state: "Enabled" }] },
    subscriptions({ nextLink: "https://attacker.test/subscriptions" }),
    subscriptions({ nextLink: "https://management.azure.com/other" }),
    subscriptions({ nextLink: "https://management.azure.com/subscriptions?api-version=2022-12-01" }),
  ])("rejects malformed or untrusted subscription discovery", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(body));
    const f = fixture({ fetch: fetchImpl });
    await expect(f.login.login(null, null)).rejects.toMatchObject({ code: "subscription-discovery-failed" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("gives actionable feedback for no enabled subscriptions", async () => {
    const f = fixture({ fetch: async () => Response.json({ value: [] }) });
    await expect(f.login.login(null, null)).rejects.toMatchObject({ code: "subscription-discovery-failed", message: expect.stringContaining("Directory (Tenant) ID") });
  });

  it("follows bounded same-origin subscription pages and skips disabled entries", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(subscriptions({ nextLink: "https://management.azure.com/subscriptions?api-version=2022-12-01&skiptoken=next" })))
      .mockResolvedValueOnce(Response.json({ value: [{ state: "Disabled" }] }));
    const f = fixture({ fetch: fetchImpl });
    expect((await f.login.login(null, null)).subscriptions).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("native Azure token cache and network boundary", () => {
  it("uses only the exact cached account, silently refreshes, and exports the rotated cache", async () => {
    const f = fixture({ accounts: [{ ...ACCOUNT, homeAccountId: "other-account" }, ACCOUNT] });
    f.cache.serialize.mockReturnValue('{"RefreshToken":{"secret":"rotated-refresh-token"}}');
    const result = await f.login.getToken(session());
    expect(f.cache.deserialize).toHaveBeenCalledWith(session().cache);
    expect(f.acquireTokenInteractive).not.toHaveBeenCalled();
    expect(f.acquireTokenSilent).toHaveBeenCalledWith({ scopes: [AZURE_MANAGEMENT_SCOPE], account: ACCOUNT, authority: `https://login.microsoftonline.com/${TENANT}` });
    expect(result.session).toMatchObject({ homeAccountId: ACCOUNT.homeAccountId, localAccountId: ACCOUNT.localAccountId, tenantId: TENANT, cache: '{"RefreshToken":{"secret":"rotated-refresh-token"}}' });
    expect(result.token).toBe("private-access-token");
    expect(result.expiresOnTimestamp).toBeGreaterThan(Date.now());
  });

  it.each([
    [],
    [{ ...ACCOUNT, homeAccountId: "wrong" }],
    [{ ...ACCOUNT, localAccountId: "wrong" }],
    [{ ...ACCOUNT, tenantId: OTHER_TENANT }],
    [{ ...ACCOUNT, environment: "login.microsoftonline.us" }],
    [ACCOUNT, ACCOUNT],
  ].map((accounts) => ({ accounts })))("rejects absent, ambiguous, or mismatched cached identities", async ({ accounts }) => {
    const f = fixture({ accounts });
    await expect(f.login.getToken(session())).rejects.toMatchObject({ code: "login-required" });
    expect(f.acquireTokenSilent).not.toHaveBeenCalled();
  });

  it("rejects a changed identity after silent refresh", async () => {
    const f = fixture({ result: authResult({ account: { ...ACCOUNT, localAccountId: "changed" } }) });
    await expect(f.login.getToken(session())).rejects.toMatchObject({ code: "login-required" });
  });

  it.each(["interaction_required", "invalid_grant", "consent_required"])("maps %s without returning MSAL details", async (code) => {
    const f = fixture();
    f.acquireTokenSilent.mockRejectedValueOnce({ errorCode: code, errorMessage: "PRIVATE_MSAL_DETAILS" });
    const error = await f.login.getToken(session()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "login-required", name: "AzureBrowserLoginError" });
    expect(String(error)).not.toContain("PRIVATE_MSAL_DETAILS");
  });

  it("bounds and pins MSAL HTTP requests, sanitizing failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("PRIVATE_BODY", { headers: { "content-length": "1048577" } }));
    const f = fixture({ fetch: fetchImpl });
    await f.login.getToken(session());
    const network = f.config().system!.networkClient!;
    await expect(network.sendPostRequestAsync("https://attacker.test/token", { body: "private-refresh-token" })).rejects.toMatchObject({ code: "token-request-failed" });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(network.sendPostRequestAsync("https://login.microsoftonline.com/common/oauth2/v2.0/token", { body: "private-refresh-token" })).rejects.toMatchObject({ code: "token-request-failed" });
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" }));
  });

  it("aborts stalled network streams during token refresh", async () => {
    const cancel = vi.fn();
    const f = fixture({ timeoutMs: 50, fetch: async () => new Response(new ReadableStream({ cancel })) });
    f.acquireTokenSilent.mockImplementationOnce(async () => {
      await f.config().system!.networkClient!.sendPostRequestAsync("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      return authResult();
    });
    await expect(f.login.getToken(session())).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects malformed cache and expired or missing token output", async () => {
    const f = fixture();
    await expect(f.login.getToken(session({ cache: "[]" }))).rejects.toMatchObject({ code: "invalid-input" });
    f.acquireTokenSilent.mockResolvedValueOnce(authResult({ expiresOn: new Date(0) }));
    await expect(f.login.getToken(session())).rejects.toMatchObject({ code: "token-request-failed" });
    f.acquireTokenSilent.mockResolvedValueOnce(authResult({ accessToken: "" }));
    await expect(f.login.getToken(session())).rejects.toMatchObject({ code: "token-request-failed" });
  });
});
