import { isUtf8 } from "node:buffer";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import {
  AuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type AuthorizeResponse,
  type Configuration,
  type ILoopbackClient,
  type INetworkModule,
  type NetworkRequestOptions,
  type NetworkResponse,
} from "@azure/msal-node";

import { parseAzureBrowserLoginSession, type AzureBrowserLoginSession, type AzureCliAccountSummary } from "../../shared/cloud-deployment-contracts.js";

export type { AzureBrowserLoginSession } from "../../shared/cloud-deployment-contracts.js";

/** Microsoft's developer application, also the default in @azure/identity. */
export const AZURE_DEVELOPER_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
export const AZURE_MANAGEMENT_SCOPE = "https://management.azure.com/.default";
const AUTHORITY_ORIGIN = "https://login.microsoftonline.com";
const MANAGEMENT_ORIGIN = "https://management.azure.com";
const SUBSCRIPTIONS_PATH = "/subscriptions";
const SUBSCRIPTIONS_URL = `${MANAGEMENT_ORIGIN}${SUBSCRIPTIONS_PATH}?api-version=2022-12-01`;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_SUBSCRIPTIONS = 512;
const PUBLIC_ACCOUNT_ENVIRONMENTS = new Set(["login.microsoftonline.com", "login.windows.net", "login.microsoft.com", "sts.windows.net"]);

export type AzureBrowserLoginErrorCode =
  | "invalid-input" | "cancelled" | "timeout" | "browser-open-failed"
  | "callback-unavailable" | "authorization-failed" | "login-required"
  | "token-request-failed" | "subscription-discovery-failed";

export class AzureBrowserLoginError extends Error {
  readonly code: AzureBrowserLoginErrorCode;

  constructor(code: AzureBrowserLoginErrorCode, message: string) {
    super(message);
    this.name = "AzureBrowserLoginError";
    this.code = code;
  }
}

export type AzureMsalClient = Pick<PublicClientApplication, "acquireTokenInteractive" | "acquireTokenSilent"> & {
  getTokenCache(): Pick<ReturnType<PublicClientApplication["getTokenCache"]>, "serialize" | "deserialize" | "getAllAccounts">;
};

export interface AzureBrowserLoginOptions {
  readonly openExternal: (url: string) => Promise<unknown>;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Test seam; production always uses the official MSAL public client. */
  readonly msalFactory?: (configuration: Configuration) => AzureMsalClient;
}

export interface AzureBrowserLoginResult {
  readonly session: AzureBrowserLoginSession;
  readonly subscriptions: readonly AzureCliAccountSummary[];
}

export interface AzureBrowserTokenResult {
  readonly session: AzureBrowserLoginSession;
  readonly token: string;
  readonly expiresOnTimestamp: number;
}

/**
 * Main-process native browser login and silent ARM token refresh. MSAL owns
 * PKCE, token exchange and cache rotation. Its serialized cache is secret and
 * must only be persisted through the encrypted credential vault.
 */
export class AzureBrowserLogin {
  readonly #openExternal: AzureBrowserLoginOptions["openExternal"];
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #msalFactory: NonNullable<AzureBrowserLoginOptions["msalFactory"]>;

  constructor(options: AzureBrowserLoginOptions) {
    this.#openExternal = options.openExternal;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? MAX_TIMEOUT_MS;
    this.#msalFactory = options.msalFactory ?? ((configuration) => new PublicClientApplication(configuration));
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > MAX_TIMEOUT_MS) throw invalidInput();
  }

  async login(tenantId: string | null, clientId: string | null, signal?: AbortSignal): Promise<AzureBrowserLoginResult> {
    const tenant = tenantId === null ? "common" : checkedGuid(tenantId);
    const client = clientId === null ? AZURE_DEVELOPER_CLIENT_ID : checkedGuid(clientId);
    const scope = deadline(signal, this.#timeoutMs);
    const state = randomUUID();
    const loopback = new AzureLoopbackClient(state, scope.signal);
    try {
      throwIfAborted(scope.signal);
      const app = this.#createClient(client, tenant, scope.signal);
      const result = await abortable(app.acquireTokenInteractive({
        scopes: [AZURE_MANAGEMENT_SCOPE],
        authority: `${AUTHORITY_ORIGIN}/${tenant}`,
        state,
        prompt: "select_account",
        responseMode: "query",
        // Pinned MSAL 5.x supports this adapter. It gives the application a
        // strict callback boundary and cancellation absent from the built-in
        // server; revisit the deprecated extension when updating major MSAL.
        loopbackClient: loopback,
        openBrowser: async (url) => {
          throwIfAborted(scope.signal);
          validateAuthorizationUrl(url, tenant, client, state, loopback.getRedirectUri());
          try {
            await abortable(this.#openExternal(url), scope.signal);
          } catch {
            throwIfAborted(scope.signal);
            throw new AzureBrowserLoginError("browser-open-failed", "Could not open the Azure sign-in page in your browser.");
          }
        },
      }), scope.signal);
      const account = checkedResult(result);
      if (tenant !== "common" && account.tenantId.toLowerCase() !== tenant) throw loginRequired();
      const session = sessionFromAccount(client, account, app);
      const subscriptions = await this.#subscriptions(session, result.accessToken, scope.signal);
      throwIfAborted(scope.signal);
      return Object.freeze({ session, subscriptions });
    } catch (error) {
      throwIfAborted(scope.signal);
      throw sanitizedError(error);
    } finally {
      loopback.closeServer();
      scope.dispose();
    }
  }

  async getToken(session: AzureBrowserLoginSession, signal?: AbortSignal): Promise<AzureBrowserTokenResult> {
    let checked: AzureBrowserLoginSession;
    try { checked = parseAzureBrowserLoginSession(session); } catch { throw invalidInput(); }
    const scope = deadline(signal, Math.min(this.#timeoutMs, REQUEST_TIMEOUT_MS));
    try {
      throwIfAborted(scope.signal);
      const app = this.#createClient(checked.clientId, checked.tenantId, scope.signal);
      app.getTokenCache().deserialize(checked.cache);
      const accounts = await abortable(app.getTokenCache().getAllAccounts(), scope.signal);
      if (!Array.isArray(accounts) || accounts.length > MAX_SUBSCRIPTIONS) throw loginRequired();
      const matches = accounts.filter((account) => accountMatches(account, checked));
      if (matches.length !== 1 || !matches[0]) throw loginRequired();
      const result = await abortable(app.acquireTokenSilent({
        scopes: [AZURE_MANAGEMENT_SCOPE],
        account: matches[0],
        authority: `${AUTHORITY_ORIGIN}/${checked.tenantId}`,
      }), scope.signal);
      const account = checkedResult(result);
      if (!accountMatches(account, checked)) throw loginRequired();
      const updated = sessionFromAccount(checked.clientId, account, app);
      throwIfAborted(scope.signal);
      return Object.freeze({ session: updated, token: result.accessToken, expiresOnTimestamp: result.expiresOn!.getTime() });
    } catch (error) {
      throwIfAborted(scope.signal);
      throw sanitizedError(error);
    } finally {
      scope.dispose();
    }
  }

  #createClient(clientId: string, tenant: string, signal: AbortSignal): AzureMsalClient {
    return this.#msalFactory({
      auth: { clientId, authority: `${AUTHORITY_ORIGIN}/${tenant}` },
      system: {
        networkClient: this.#networkClient(signal),
        disableInternalRetries: true,
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => undefined },
      },
    });
  }

  #networkClient(signal: AbortSignal): INetworkModule {
    const send = async <T>(method: "GET" | "POST", url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
      assertUrlOrigin(url, AUTHORITY_ORIGIN);
      const response = await this.#request(method, url, options?.headers ?? {}, options?.body, signal);
      return { status: response.status, headers: response.headers, body: response.body as T };
    };
    return {
      sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => send<T>("GET", url, options),
      sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => send<T>("POST", url, options),
    };
  }

  async #request(method: "GET" | "POST", url: string, headers: Readonly<Record<string, string>>, body: string | undefined, signal: AbortSignal): Promise<NetworkResponse<unknown>> {
    const scope = deadline(signal, REQUEST_TIMEOUT_MS);
    try {
      throwIfAborted(scope.signal);
      const response = await abortable(this.#fetch(url, {
        method,
        headers: { ...headers, Accept: "application/json" },
        ...(body !== undefined ? { body } : {}),
        signal: scope.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }), scope.signal);
      if (response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        throw tokenRequestFailed();
      }
      const data = await readBoundedJson(response, scope.signal);
      throwIfAborted(scope.signal);
      return { status: response.status, headers: Object.fromEntries(response.headers), body: data };
    } finally {
      scope.dispose();
    }
  }

  async #subscriptions(session: AzureBrowserLoginSession, token: string, signal: AbortSignal): Promise<readonly AzureCliAccountSummary[]> {
    const subscriptions: AzureCliAccountSummary[] = [];
    const seenIds = new Set<string>();
    const visited = new Set<string>();
    let next: string | null = SUBSCRIPTIONS_URL;
    try {
      while (next !== null) {
        assertUrlOrigin(next, MANAGEMENT_ORIGIN);
        if (new URL(next).pathname !== SUBSCRIPTIONS_PATH || visited.has(next) || visited.size >= 16) throw discoveryFailed();
        visited.add(next);
        const response = await this.#request("GET", next, { Authorization: `Bearer ${token}` }, undefined, signal);
        if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body["value"])) throw discoveryFailed();
        for (const entry of response.body["value"]) {
          if (!isRecord(entry)) throw discoveryFailed();
          if (entry["state"] !== "Enabled") continue;
          const subscriptionId = checkedGuid(entry["subscriptionId"]);
          const tenantId = checkedGuid(entry["tenantId"]);
          if (tenantId !== session.tenantId.toLowerCase() || !boundedText(entry["displayName"], 256) || seenIds.has(subscriptionId)) throw discoveryFailed();
          seenIds.add(subscriptionId);
          if (subscriptions.length >= MAX_SUBSCRIPTIONS) throw discoveryFailed();
          const homeTenantId = session.homeAccountId.split(".").at(-1);
          subscriptions.push(Object.freeze({
            subscriptionId, tenantId, name: entry["displayName"],
            homeTenantId: homeTenantId && GUID.test(homeTenantId) ? homeTenantId.toLowerCase() : null,
            isDefault: false, cloudName: "AzureCloud",
          }));
        }
        const nextLink = response.body["nextLink"];
        if (nextLink === null || nextLink === undefined) next = null;
        else if (boundedText(nextLink, 8192)) next = nextLink;
        else throw discoveryFailed();
      }
    } catch {
      throwIfAborted(signal);
      throw discoveryFailed();
    }
    if (subscriptions.length === 0) {
      throw new AzureBrowserLoginError("subscription-discovery-failed", "No enabled Azure subscriptions were found in this directory. Enter the correct Directory (Tenant) ID and sign in again.");
    }
    subscriptions.sort((left, right) => left.name.localeCompare(right.name) || left.subscriptionId.localeCompare(right.subscriptionId));
    return Object.freeze(subscriptions);
  }
}

class AzureLoopbackClient implements ILoopbackClient {
  readonly #state: string;
  readonly #signal: AbortSignal;
  #server: Server | undefined;
  #redirectUri: string | undefined;
  #settled = false;
  #reject: ((error: Error) => void) | undefined;
  readonly #onAbort = () => { this.#reject?.(abortedError(this.#signal)); this.closeServer(); };

  constructor(state: string, signal: AbortSignal) { this.#state = state; this.#signal = signal; }

  listenForAuthCode(): Promise<AuthorizeResponse> {
    if (this.#server || this.#settled) return Promise.reject(callbackUnavailable());
    const promise = new Promise<AuthorizeResponse>((resolve, reject) => {
      this.#reject = reject;
      const server = createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
        if (this.#settled) return reply(response, 410, "This Azure sign-in request has finished.");
        if (request.method !== "GET") return reply(response, 405, "Invalid Azure sign-in callback.");
        if (!this.#redirectUri || !request.url || request.url.length > 32 * 1024 || request.headers.host !== new URL(this.#redirectUri).host || !request.url.startsWith("/?")) {
          return reply(response, 400, "Invalid Azure sign-in callback.");
        }
        const url = new URL(request.url, this.#redirectUri);
        if (url.pathname !== "/" || url.hash || url.origin !== this.#redirectUri) return reply(response, 400, "Invalid Azure sign-in callback.");
        const states = url.searchParams.getAll("state");
        if (states.length !== 1 || !sameState(states[0] ?? "", this.#state)) return reply(response, 400, "Invalid Azure sign-in callback.");
        const codes = url.searchParams.getAll("code");
        const errors = url.searchParams.getAll("error");
        if (errors.length === 1 && !codes.length) {
          this.#settled = true;
          reply(response, 400, "Azure sign-in was not completed. Return to the application and try again.");
          reject(new AzureBrowserLoginError("authorization-failed", "Azure sign-in was not completed. Please try again."));
          server.close();
          return;
        }
        const code = codes[0];
        const clientInfo = url.searchParams.getAll("client_info");
        if (errors.length || codes.length !== 1 || !boundedText(code, 16 * 1024) || clientInfo.length > 1 || (clientInfo.length && !boundedText(clientInfo[0], 8192))) {
          return reply(response, 400, "Invalid Azure sign-in callback.");
        }
        this.#settled = true;
        reply(response, 200, "Azure authorization received. Return to the application to finish signing in.");
        resolve({ code, state: this.#state, ...(clientInfo[0] ? { client_info: clientInfo[0] } : {}) });
        server.close();
      });
      this.#server = server;
      server.maxConnections = 8;
      server.on("clientError", (_error, socket) => socket.destroy());
      server.once("error", () => { reject(callbackUnavailable()); this.closeServer(); });
      this.#signal.addEventListener("abort", this.#onAbort, { once: true });
      if (this.#signal.aborted) { this.#onAbort(); return; }
      server.listen(0, "127.0.0.1", () => {
        if (this.#signal.aborted || this.#settled) { this.closeServer(); return; }
        const address = server.address();
        if (!address || typeof address === "string") { reject(callbackUnavailable()); this.closeServer(); return; }
        // Entra's native application registration uses http://localhost;
        // MSAL and Entra ignore the ephemeral port for this registered URI.
        this.#redirectUri = `http://localhost:${address.port}`;
      });
    });
    // MSAL may still be acquiring metadata when a cancellation occurs.
    void promise.catch(() => undefined);
    return promise;
  }

  getRedirectUri(): string {
    throwIfAborted(this.#signal);
    if (!this.#redirectUri) {
      if (this.#settled) throw callbackUnavailable();
      // MSAL's startup polling retries this documented loopback error code.
      throw new AuthError("no_loopback_server_exists", "");
    }
    return this.#redirectUri;
  }

  closeServer(): void {
    if (!this.#settled) this.#reject?.(cancelled());
    this.#settled = true;
    this.#signal.removeEventListener("abort", this.#onAbort);
    this.#server?.closeAllConnections();
    this.#server?.close();
    this.#server?.unref();
  }
}

function validateAuthorizationUrl(value: string, tenant: string, clientId: string, state: string, redirectUri: string): void {
  assertUrlOrigin(value, AUTHORITY_ORIGIN);
  const url = new URL(value);
  if (url.pathname.toLowerCase() !== `/${tenant}/oauth2/v2.0/authorize`
    || url.searchParams.get("client_id") !== clientId || url.searchParams.get("state") !== state
    || url.searchParams.get("redirect_uri") !== redirectUri || url.searchParams.get("response_type") !== "code"
    || url.searchParams.get("code_challenge_method") !== "S256") throw tokenRequestFailed();
}

function assertUrlOrigin(value: string, origin: string): void {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.hash) throw tokenRequestFailed();
  } catch { throw tokenRequestFailed(); }
}

function checkedResult(result: AuthenticationResult): AccountInfo {
  if (!result || !result.account || !PUBLIC_ACCOUNT_ENVIRONMENTS.has(result.account.environment)
    || !boundedText(result.accessToken, 128 * 1024) || result.tokenType.toLowerCase() !== "bearer"
    || !(result.expiresOn instanceof Date) || !Number.isFinite(result.expiresOn.getTime()) || result.expiresOn.getTime() <= Date.now()
    || checkedGuid(result.tenantId) !== checkedGuid(result.account.tenantId)) throw tokenRequestFailed();
  return result.account;
}

function accountMatches(account: AccountInfo, session: AzureBrowserLoginSession): boolean {
  return !!account && PUBLIC_ACCOUNT_ENVIRONMENTS.has(account.environment)
    && account.homeAccountId === session.homeAccountId && account.localAccountId === session.localAccountId
    && account.tenantId?.toLowerCase() === session.tenantId.toLowerCase();
}

function sessionFromAccount(clientId: string, account: AccountInfo, app: AzureMsalClient): AzureBrowserLoginSession {
  try {
    return Object.freeze(parseAzureBrowserLoginSession({
      clientId, homeAccountId: account.homeAccountId, localAccountId: account.localAccountId,
      tenantId: checkedGuid(account.tenantId), username: account.username,
      cache: app.getTokenCache().serialize(),
    }));
  } catch { throw tokenRequestFailed(); }
}

function checkedGuid(value: unknown): string {
  if (typeof value !== "string" || !GUID.test(value)) throw invalidInput();
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw tokenRequestFailed();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let complete = false;
  try {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const length = response.headers.get("content-length");
    if ((contentType && contentType !== "application/json") || (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_JSON_BYTES))) throw tokenRequestFailed();
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) { complete = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_JSON_BYTES) throw tokenRequestFailed();
      chunks.push(Buffer.from(chunk.value));
    }
    const body = Buffer.concat(chunks, bytes);
    try {
      if (!isUtf8(body)) throw tokenRequestFailed();
      return JSON.parse(body.toString("utf8")) as unknown;
    } finally { body.fill(0); }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", Connection: "close",
  });
  response.end(message);
}

function sameState(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function deadline(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent ? abortedError(parent) : cancelled());
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timedOut()), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); } };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortedError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortedError(signal); }
function abortedError(signal: AbortSignal): AzureBrowserLoginError {
  return signal.reason instanceof AzureBrowserLoginError && signal.reason.code === "timeout" ? timedOut() : cancelled();
}
function cancelled(): AzureBrowserLoginError { return new AzureBrowserLoginError("cancelled", "Azure sign-in was cancelled."); }
function timedOut(): AzureBrowserLoginError { return new AzureBrowserLoginError("timeout", "Azure sign-in timed out. Please try again."); }
function invalidInput(): AzureBrowserLoginError { return new AzureBrowserLoginError("invalid-input", "The Azure sign-in application, directory, or session is invalid."); }
function callbackUnavailable(): AzureBrowserLoginError { return new AzureBrowserLoginError("callback-unavailable", "Could not start the local Azure sign-in callback."); }
function tokenRequestFailed(): AzureBrowserLoginError { return new AzureBrowserLoginError("token-request-failed", "Azure could not complete the sign-in request. Please try again."); }
function discoveryFailed(): AzureBrowserLoginError { return new AzureBrowserLoginError("subscription-discovery-failed", "Azure subscriptions could not be read. Sign in to the correct directory and try again."); }
function loginRequired(): AzureBrowserLoginError { return new AzureBrowserLoginError("login-required", "Your Azure session needs authentication. Use Azure Login to sign in again."); }

function sanitizedError(error: unknown): AzureBrowserLoginError {
  if (error instanceof AzureBrowserLoginError) return error;
  if (isRecord(error) && typeof error["errorCode"] === "string"
    && /^(?:interaction_required|login_required|consent_required|invalid_grant|no_tokens_found|no_account_in_silent_request)$/u.test(error["errorCode"])) return loginRequired();
  return tokenRequestFailed();
}
