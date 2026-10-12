// @vitest-environment node

import { createHash } from "node:crypto";
import { request } from "node:http";

import { PublicClientApplication } from "@azure/msal-node";
import { describe, expect, it, vi } from "vitest";

import { AZURE_DEVELOPER_CLIENT_ID, AZURE_MANAGEMENT_SCOPE, AzureBrowserLogin } from "./azure-browser-login.js";

const AUTHORITY = "https://login.microsoftonline.com";
const TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ACCOUNT_ID = "11111111-2222-3333-4444-555555555555";
const SUBSCRIPTION_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const CLIENT_INFO = Buffer.from(JSON.stringify({ uid: ACCOUNT_ID, utid: TENANT_ID })).toString("base64url");

type SerializedMsalCache = Record<string, Record<string, Record<string, unknown>>>;

describe("Azure browser login with the installed MSAL public client", () => {
  it.each([
    { tenantId: TENANT_ID, scenario: "success" },
    { tenantId: null, scenario: "success" },
    { tenantId: TENANT_ID, scenario: "invalid callbacks" },
    { tenantId: TENANT_ID, scenario: "cancelled" },
    { tenantId: TENANT_ID, scenario: "timeout" },
    { tenantId: TENANT_ID, scenario: "browser-open-failed" },
    { tenantId: TENANT_ID, scenario: "wrong nonce" },
    { tenantId: TENANT_ID, scenario: "missing nonce" },
  ])("preserves the real MSAL boundary: $scenario, tenant $tenantId", async ({ tenantId, scenario }) => {
    const loginTenant = tenantId ?? "common";
    let authorizationUrl: URL | undefined;
    let callbackStatus: number | undefined;
    const tokenGrants: string[] = [];
    const unexpectedRequests: string[] = [];
    let subscriptionRequests = 0;
    const controller = new AbortController();
    const network = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      if (url.origin === AUTHORITY && url.pathname === "/common/discovery/instance") {
        return Response.json({
          tenant_discovery_endpoint: `${AUTHORITY}/${loginTenant}/v2.0/.well-known/openid-configuration`,
          metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
        });
      }
      if (url.origin === AUTHORITY && [loginTenant, TENANT_ID].some((tenant) => url.pathname === `/${tenant}/v2.0/.well-known/openid-configuration`)) {
        const metadataTenant = url.pathname.split("/")[1];
        return Response.json({
          authorization_endpoint: `${AUTHORITY}/${metadataTenant}/oauth2/v2.0/authorize`,
          token_endpoint: `${AUTHORITY}/${metadataTenant}/oauth2/v2.0/token`,
          end_session_endpoint: `${AUTHORITY}/${metadataTenant}/oauth2/v2.0/logout`,
          issuer: `${AUTHORITY}/${metadataTenant === "common" ? "{tenantid}" : metadataTenant}/v2.0`,
          jwks_uri: `${AUTHORITY}/${metadataTenant}/discovery/v2.0/keys`,
          response_types_supported: ["code"],
          subject_types_supported: ["pairwise"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      if (url.origin === AUTHORITY && [loginTenant, TENANT_ID].some((tenant) => url.pathname === `/${tenant}/oauth2/v2.0/token`)) {
        expect(init?.method).toBe("POST");
        const body = new URLSearchParams(String(init?.body));
        const grant = body.get("grant_type") ?? "";
        tokenGrants.push(grant);
        expect(body.get("client_id")).toBe(AZURE_DEVELOPER_CLIENT_ID);
        expectArmScopes(body.get("scope"));
        if (grant === "authorization_code") {
          expect(url.pathname).toBe(`/${loginTenant}/oauth2/v2.0/token`);
          expect(body.get("code")).toBe("compatibility-authorization-code");
          expect(body.get("redirect_uri")).toBe(authorizationUrl?.searchParams.get("redirect_uri"));
          const verifier = body.get("code_verifier") ?? "";
          expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/u);
          expect(createHash("sha256").update(verifier).digest("base64url"))
            .toBe(authorizationUrl?.searchParams.get("code_challenge"));
          return Response.json(tokenResponse("initial-arm-token", "initial-refresh-token", authorizationUrl,
            scenario === "wrong nonce" ? "incorrect-nonce" : scenario === "missing nonce" ? null : undefined));
        }
        expect(grant).toBe("refresh_token");
        expect(url.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/token`);
        expect(body.get("refresh_token")).toBe("initial-refresh-token");
        expect(body.has("code_verifier")).toBe(false);
        return Response.json(tokenResponse("rotated-arm-token", "rotated-refresh-token", authorizationUrl));
      }
      if (url.origin === "https://management.azure.com" && url.pathname === "/subscriptions") {
        subscriptionRequests++;
        expect(init?.method).toBe("GET");
        expect(url.searchParams.get("api-version")).toBe("2022-12-01");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer initial-arm-token");
        return Response.json({ value: [{ subscriptionId: SUBSCRIPTION_ID, tenantId: TENANT_ID, displayName: "Compatibility Subscription", state: "Enabled" }] });
      }
      unexpectedRequests.push(String(input));
      throw new Error("Unexpected compatibility fixture request");
    });
    const openExternal = vi.fn(async (value: string) => {
      authorizationUrl = new URL(value);
      expect(authorizationUrl.origin).toBe(AUTHORITY);
      expect(authorizationUrl.pathname).toBe(`/${loginTenant}/oauth2/v2.0/authorize`);
      expect(authorizationUrl.searchParams.get("client_id")).toBe(AZURE_DEVELOPER_CLIENT_ID);
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizationUrl.searchParams.get("response_mode")).toBe("form_post");
      expect(authorizationUrl.searchParams.get("nonce")).toMatch(/^[0-9a-f-]{36}$/u);
      expectArmScopes(authorizationUrl.searchParams.get("scope"));
      const redirect = authorizationUrl.searchParams.get("redirect_uri") ?? "";
      expect(redirect).toMatch(/^http:\/\/localhost:\d+$/u);
      if (scenario === "cancelled") { controller.abort(); return; }
      if (scenario === "timeout") return;
      if (scenario === "browser-open-failed") throw new Error("PRIVATE_BROWSER_FAILURE");
      if (scenario === "invalid callbacks") {
        expect(await sendLoopbackCallback(redirect, { code: "wrong-state-code", state: "wrong" })).toBe(400);
        expect(await sendLoopbackCallback(redirect, {
          code: "query-response-code", state: authorizationUrl.searchParams.get("state") ?? "",
        }, { method: "GET" })).toBe(405);
        expect(tokenGrants).toEqual([]);
      }
      callbackStatus = await sendLoopbackCallback(redirect, {
        code: "compatibility-authorization-code",
        state: authorizationUrl.searchParams.get("state") ?? "",
        client_info: CLIENT_INFO,
      });
    });
    // No msalFactory override: this exercises the package's public client,
    // authorization-code flow, callback, token exchange and cache serializer.
    const helper = new AzureBrowserLogin({ fetch: network, openExternal, timeoutMs: scenario === "timeout" ? 200 : 5_000 });
    const operation = helper.login(tenantId, null, controller.signal);
    if (["cancelled", "timeout", "browser-open-failed"].includes(scenario)) {
      await expect(operation).rejects.toMatchObject({ code: scenario });
      expect(openExternal).toHaveBeenCalledOnce();
      expect(tokenGrants).toEqual([]);
      expect(subscriptionRequests).toBe(0);
      await expect(sendLoopbackCallback(authorizationUrl!.searchParams.get("redirect_uri")!, { state: "late", code: "late" })).rejects.toThrow();
      return;
    }
    if (["wrong nonce", "missing nonce"].includes(scenario)) {
      await expect(operation).rejects.toMatchObject({ code: "token-request-failed" });
      expect(tokenGrants).toEqual(["authorization_code"]);
      expect(subscriptionRequests).toBe(0);
      return;
    }
    const signedIn = await operation;

    expect(callbackStatus).toBe(200);
    expect(openExternal).toHaveBeenCalledOnce();
    expect(signedIn.session).toMatchObject({
      clientId: AZURE_DEVELOPER_CLIENT_ID,
      homeAccountId: `${ACCOUNT_ID}.${TENANT_ID}`,
      localAccountId: ACCOUNT_ID,
      tenantId: TENANT_ID,
      username: "operator@example.test",
    });
    expect(signedIn.subscriptions).toEqual([{
      subscriptionId: SUBSCRIPTION_ID, tenantId: TENANT_ID, name: "Compatibility Subscription",
      homeTenantId: TENANT_ID, isDefault: false, cloudName: "AzureCloud",
    }]);
    const initialCache = JSON.parse(signedIn.session.cache) as SerializedMsalCache;
    const accessTokens = Object.values(initialCache["AccessToken"] ?? {});
    expect(accessTokens).toHaveLength(1);
    expect(accessTokens[0]).toMatchObject({ secret: "initial-arm-token", realm: TENANT_ID, client_id: AZURE_DEVELOPER_CLIENT_ID });
    // Expire the token in MSAL's actual serialized representation. Real timers
    // stay enabled so the localhost callback and request deadlines still run.
    for (const token of accessTokens) token["expires_on"] = String(Math.floor(Date.now() / 1_000) - 3_600);

    const refreshed = await helper.getToken({ ...signedIn.session, cache: JSON.stringify(initialCache) });

    expect(tokenGrants).toEqual(["authorization_code", "refresh_token"]);
    expect(unexpectedRequests).toEqual([]);
    expect(refreshed.token).toBe("rotated-arm-token");
    expect(refreshed.expiresOnTimestamp).toBeGreaterThan(Date.now());
    expect(refreshed.session).toMatchObject({
      clientId: signedIn.session.clientId, tenantId: signedIn.session.tenantId,
      homeAccountId: signedIn.session.homeAccountId, localAccountId: signedIn.session.localAccountId,
    });
    const refreshedCache = JSON.parse(refreshed.session.cache) as SerializedMsalCache;
    expect(Object.values(refreshedCache["RefreshToken"] ?? {}).map((token) => token["secret"]))
      .toEqual(["rotated-refresh-token"]);
    expect(Object.values(refreshedCache["AccessToken"] ?? {}).map((token) => token["secret"]))
      .toEqual(["rotated-arm-token"]);
    const cacheReader = new PublicClientApplication({ auth: { clientId: AZURE_DEVELOPER_CLIENT_ID, authority: `${AUTHORITY}/${TENANT_ID}` } });
    cacheReader.getTokenCache().deserialize(refreshed.session.cache);
    expect(await cacheReader.getTokenCache().getAllAccounts()).toMatchObject([{
      homeAccountId: signedIn.session.homeAccountId, localAccountId: ACCOUNT_ID, tenantId: TENANT_ID,
    }]);
    const cached = await helper.getToken(refreshed.session);
    expect(cached.token).toBe("rotated-arm-token");
    expect(tokenGrants).toEqual(["authorization_code", "refresh_token"]);
    expect(openExternal).toHaveBeenCalledOnce();
  });
});

function expectArmScopes(scopes: string | null): void {
  const values = (scopes ?? "").split(/\s+/u).filter(Boolean);
  expect(values).toContain(AZURE_MANAGEMENT_SCOPE);
  expect(values.filter((scope) => !["openid", "profile", "offline_access"].includes(scope))).toEqual([AZURE_MANAGEMENT_SCOPE]);
}

function tokenResponse(accessToken: string, refreshToken: string, authorization: URL | undefined, nonceOverride?: string | null): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1_000);
  const claims = {
    aud: AZURE_DEVELOPER_CLIENT_ID, iss: `${AUTHORITY}/${TENANT_ID}/v2.0`,
    iat: now, nbf: now, exp: now + 3_600, tid: TENANT_ID,
    oid: ACCOUNT_ID, sub: ACCOUNT_ID, preferred_username: "operator@example.test",
    ...(nonceOverride === null ? {} : { nonce: nonceOverride ?? authorization?.searchParams.get("nonce") }),
  };
  const idToken = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
  return { token_type: "Bearer", scope: AZURE_MANAGEMENT_SCOPE, expires_in: 3_600, ext_expires_in: 3_600,
    access_token: accessToken, refresh_token: refreshToken, id_token: idToken, client_info: CLIENT_INFO };
}

function sendLoopbackCallback(redirect: string, parameters: Record<string, string>, options: { method?: string } = {}): Promise<number> {
  const url = new URL(redirect);
  const form = new URLSearchParams(parameters).toString();
  if (options.method === "GET") url.search = form;
  return new Promise((resolve, reject) => {
    const callback = request(url, {
      hostname: "127.0.0.1", method: options.method ?? "POST",
      headers: { Host: url.host, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(form) },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    callback.setTimeout(2_000, () => callback.destroy(new Error("Compatibility callback timed out")));
    callback.once("error", reject);
    callback.end(form);
  });
}
