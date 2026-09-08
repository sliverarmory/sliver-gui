import { isUtf8 } from "node:buffer";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";

import { parseAwsConsoleLoginSession, type AwsConsoleLoginSession } from "../../shared/cloud-deployment-contracts.js";

export type { AwsConsoleLoginSession } from "../../shared/cloud-deployment-contracts.js";

const CLIENT_ID = "arn:aws:signin:::devtools/same-device";
const SIGV4_TOKEN_TYPE = "urn:aws:params:oauth:token-type:access_token_sigv4";
const CALLBACK_PATH = "/oauth/callback";
// Authorization codes are opaque. The AWS CLI accepts codes beyond the
// service model's max:512; allow them with a separate bounded HTTP budget.
const MAX_AUTHORIZATION_CODE_BYTES = 16 * 1024;
const MAX_CALLBACK_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 30_000;

export type AwsConsoleLoginErrorCode =
  | "invalid-input" | "cancelled" | "timeout" | "browser-open-failed"
  | "callback-unavailable" | "authorization-failed" | "insufficient-permissions"
  | "login-required" | "token-request-failed";

export class AwsConsoleLoginError extends Error {
  readonly code: AwsConsoleLoginErrorCode;

  constructor(code: AwsConsoleLoginErrorCode, message: string) {
    super(message);
    this.name = "AwsConsoleLoginError";
    this.code = code;
  }
}

export interface AwsConsoleLoginOptions {
  readonly openExternal: (url: string) => Promise<unknown>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * AWS Management Console's public desktop OAuth flow. Credentials and proof
 * keys stay in the main process; the browser only receives the authorization
 * URL. The wire format follows aws/aws-cli's customizations/login/utils.py.
 */
export class AwsConsoleLogin {
  readonly #openExternal: AwsConsoleLoginOptions["openExternal"];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(options: AwsConsoleLoginOptions) {
    this.#openExternal = options.openExternal;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? MAX_LOGIN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > MAX_LOGIN_TIMEOUT_MS) {
      throw invalidInput();
    }
  }

  async login(region: string, signal?: AbortSignal): Promise<AwsConsoleLoginSession> {
    const endpoint = signInEndpoint(region);
    const scope = deadline(signal, this.#timeoutMs);
    let callback: Awaited<ReturnType<typeof openCallbackServer>> | undefined;
    try {
      throwIfAborted(scope.signal);
      const state = randomUUID();
      const verifier = randomBytes(48).toString("base64url");
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const privateKeyPem = privateKey.export({ type: "sec1", format: "pem" }).toString();
      callback = await openCallbackServer(state, scope.signal);
      const authorizationUrl = new URL(`${endpoint}/v1/authorize`);
      authorizationUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        state,
        // AWS uses this literal spelling rather than the usual PKCE "S256".
        code_challenge_method: "SHA-256",
        scope: "openid",
        redirect_uri: callback.redirectUri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      }).toString();
      try {
        await abortable(this.#openExternal(authorizationUrl.toString()), scope.signal);
      } catch {
        throwIfAborted(scope.signal);
        throw new AwsConsoleLoginError("browser-open-failed", "Could not open the AWS sign-in page in your browser.");
      }
      const code = await callback.code;
      const output = await this.#requestToken(endpoint, privateKeyPem, {
        clientId: CLIENT_ID,
        grantType: "authorization_code",
        code,
        codeVerifier: verifier,
        redirectUri: callback.redirectUri,
      }, scope.signal);
      const loginSessionArn = identityFromIdToken(output["idToken"], region);
      return sessionFromResponse(output, { loginSessionArn, region, privateKey: privateKeyPem }, this.#now());
    } catch (error) {
      throwIfAborted(scope.signal);
      if (error instanceof AwsConsoleLoginError) throw error;
      throw tokenRequestFailed();
    } finally {
      callback?.close();
      scope.dispose();
    }
  }

  async refresh(session: AwsConsoleLoginSession, signal?: AbortSignal): Promise<AwsConsoleLoginSession> {
    let checkedSession: AwsConsoleLoginSession;
    try {
      checkedSession = parseAwsConsoleLoginSession(session);
    } catch {
      throw invalidInput();
    }
    const endpoint = signInEndpoint(checkedSession.region);
    assertIdentityPartition(checkedSession.loginSessionArn, checkedSession.region);
    const scope = deadline(signal, Math.min(this.#timeoutMs, TOKEN_TIMEOUT_MS));
    try {
      throwIfAborted(scope.signal);
      const output = await this.#requestToken(endpoint, checkedSession.privateKey, {
        clientId: CLIENT_ID,
        grantType: "refresh_token",
        refreshToken: checkedSession.refreshToken,
      }, scope.signal);
      return sessionFromResponse(output, checkedSession, this.#now());
    } catch (error) {
      throwIfAborted(scope.signal);
      if (error instanceof AwsConsoleLoginError) throw error;
      throw tokenRequestFailed();
    } finally {
      scope.dispose();
    }
  }

  async #requestToken(
    endpoint: string,
    privateKey: string,
    input: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const scope = deadline(signal, TOKEN_TIMEOUT_MS);
    try {
      throwIfAborted(scope.signal);
      const url = `${endpoint}/v1/token`;
      const response = await abortable(this.#fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          DPoP: dpopProof(privateKey, url, this.#now()),
        },
        body: JSON.stringify(input),
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: scope.signal,
      }), scope.signal);
      if (response.redirected || (response.url && response.url !== url)) {
        void response.body?.cancel().catch(() => undefined);
        throw tokenRequestFailed();
      }
      const output = await readBoundedJson(response, scope.signal);
      if (!response.ok) throw serviceError(output["error"]);
      throwIfAborted(scope.signal);
      return output;
    } catch (error) {
      throwIfAborted(scope.signal);
      if (error instanceof AwsConsoleLoginError) throw error;
      throw tokenRequestFailed();
    } finally {
      scope.dispose();
    }
  }
}

function signInEndpoint(region: string): string {
  // Restricted and sovereign partitions have separate endpoint rules. Do not
  // guess a commercial endpoint for them or accept a caller-supplied URL.
  if (/^cn-(?:north|northwest)-[1-9]\d?$/u.test(region)) return `https://${region}.signin.amazonaws.cn`;
  if (/^us-gov-(?:east|west)-[1-9]\d?$/u.test(region)) return `https://${region}.signin.amazonaws-us-gov.com`;
  if (/^(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9]\d?$/u.test(region)) {
    return `https://${region}.signin.aws.amazon.com`;
  }
  throw invalidInput();
}

function dpopProof(pem: string, url: string, now: number): string {
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw invalidInput();
    }
    const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
    const header = Buffer.from(JSON.stringify({
      typ: "dpop+jwt", alg: "ES256",
      jwk: { kty: "EC", crv: "P-256", x: publicKey.x, y: publicKey.y },
    })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      htm: "POST", htu: url, iat: Math.floor(now / 1000), jti: randomUUID(),
    })).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${signingInput}.${signature.toString("base64url")}`;
  } catch {
    throw invalidInput();
  }
}

async function openCallbackServer(state: string, signal: AbortSignal): Promise<{
  readonly redirectUri: string;
  readonly code: Promise<string>;
  readonly close: () => void;
}> {
  throwIfAborted(signal);
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // The callback may arrive or be cancelled while openExternal is pending.
  void code.catch(() => undefined);
  let expectedHost = "";
  let settled = false;
  const server = createServer({ maxHeaderSize: MAX_CALLBACK_REQUEST_BYTES, requestTimeout: 5_000, headersTimeout: 5_000 }, (request, response) => {
    if (settled) return reply(response, 410, "This sign-in request has finished.");
    if (request.method !== "GET") return reply(response, 405, "Invalid sign-in callback.");
    if (request.headers.host !== expectedHost || !request.url || Buffer.byteLength(request.url, "utf8") > MAX_CALLBACK_REQUEST_BYTES || !request.url.startsWith(`${CALLBACK_PATH}?`)) {
      return reply(response, 400, "Invalid sign-in callback.");
    }
    const url = new URL(request.url, `http://${expectedHost}`);
    if (url.pathname !== CALLBACK_PATH || url.origin !== `http://${expectedHost}` || url.hash) {
      return reply(response, 400, "Invalid sign-in callback.");
    }
    const receivedState = url.searchParams.getAll("state");
    if (receivedState.length !== 1 || !sameState(receivedState[0] ?? "", state)) {
      return reply(response, 400, "Invalid sign-in callback.");
    }
    const errors = url.searchParams.getAll("error");
    const codes = url.searchParams.getAll("code");
    if (errors.length === 1 && codes.length === 0) {
      settled = true;
      reply(response, 400, "AWS sign-in was not completed. Return to the application and try again.");
      rejectCode(new AwsConsoleLoginError("authorization-failed", "AWS sign-in was not completed. Please try again."));
      server.close();
      return;
    }
    const authorizationCode = codes[0];
    if (errors.length || codes.length !== 1 || !boundedText(authorizationCode, MAX_AUTHORIZATION_CODE_BYTES)) {
      return reply(response, 400, "Invalid sign-in callback.");
    }
    settled = true;
    reply(response, 200, "AWS authorization received. Return to the application to finish signing in.");
    resolveCode(authorizationCode);
    server.close();
  });
  server.maxConnections = 8;
  server.on("clientError", (_error, socket) => socket.destroy());
  const close = () => {
    if (!settled) {
      settled = true;
      rejectCode(cancelled());
    }
    signal.removeEventListener("abort", onAbort);
    closeServer(server);
  };
  const onAbort = () => {
    settled = true;
    rejectCode(abortedError(signal));
    closeServer(server);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await abortable(new Promise<void>((resolve, reject) => {
      server.once("error", () => {
        const error = new AwsConsoleLoginError("callback-unavailable", "Could not start the local AWS sign-in callback.");
        rejectCode(error);
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        if (signal.aborted) closeServer(server);
        resolve();
      });
    }), signal);
    throwIfAborted(signal);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("callback unavailable");
    expectedHost = `127.0.0.1:${address.port}`;
    return { redirectUri: `http://${expectedHost}${CALLBACK_PATH}`, code, close };
  } catch (error) {
    close();
    throwIfAborted(signal);
    if (error instanceof AwsConsoleLoginError) throw error;
    throw new AwsConsoleLoginError("callback-unavailable", "Could not start the local AWS sign-in callback.");
  }
}

function closeServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

function reply(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    Connection: "close",
  });
  response.end(message);
}

function sameState(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw tokenRequestFailed();
  const chunks: Buffer[] = [];
  let total = 0;
  let complete = false;
  try {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType && contentType !== "application/json") throw tokenRequestFailed();
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
      throw tokenRequestFailed();
    }
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) { complete = true; break; }
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw tokenRequestFailed();
      chunks.push(Buffer.from(chunk.value));
    }
    const body = Buffer.concat(chunks, total);
    try {
      if (!isUtf8(body)) throw tokenRequestFailed();
      const output: unknown = JSON.parse(body.toString("utf8"));
      if (!isRecord(output)) throw tokenRequestFailed();
      return output;
    } finally {
      body.fill(0);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}

function identityFromIdToken(value: unknown, region: string): string {
  if (!boundedText(value, 16_384)) throw tokenRequestFailed();
  const parts = value.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))) throw tokenRequestFailed();
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (!isRecord(claims) || typeof claims["sub"] !== "string") throw tokenRequestFailed();
    assertIdentityPartition(claims["sub"], region);
    return claims["sub"];
  } catch {
    throw tokenRequestFailed();
  }
}

function assertIdentityPartition(arn: string, region: string): void {
  const partition = region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  if (!/^arn:(aws|aws-cn|aws-us-gov):(iam|sts)::\d{12}:[A-Za-z0-9_+=,.@:/-]{1,2048}$/u.test(arn) || !arn.startsWith(`arn:${partition}:`)) {
    throw invalidInput();
  }
}

function sessionFromResponse(
  output: Record<string, unknown>,
  identity: Pick<AwsConsoleLoginSession, "region" | "loginSessionArn" | "privateKey">,
  now: number,
): AwsConsoleLoginSession {
  const accessToken = output["accessToken"];
  const expiresIn = output["expiresIn"];
  // AWS returns the registered URN. Some SDK models document the short
  // aws_sigv4 spelling, which we also retain for compatibility.
  const sigv4Token = output["tokenType"] === SIGV4_TOKEN_TYPE || output["tokenType"] === "aws_sigv4";
  if (!isRecord(accessToken) || !sigv4Token || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 900) {
    throw tokenRequestFailed();
  }
  try {
    return Object.freeze(parseAwsConsoleLoginSession({
      loginSessionArn: identity.loginSessionArn,
      region: identity.region,
      privateKey: identity.privateKey,
      accessKeyId: accessToken["accessKeyId"],
      secretAccessKey: accessToken["secretAccessKey"],
      sessionToken: accessToken["sessionToken"],
      refreshToken: output["refreshToken"],
      expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    }));
  } catch {
    throw tokenRequestFailed();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function deadline(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent ? abortedError(parent) : cancelled());
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new AwsConsoleLoginError("timeout", "AWS sign-in timed out. Please try again.")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", onAbort); },
  };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortedError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortedError(signal);
}

function abortedError(signal: AbortSignal): AwsConsoleLoginError {
  if (signal.reason instanceof AwsConsoleLoginError && signal.reason.code === "timeout") {
    return new AwsConsoleLoginError("timeout", "AWS sign-in timed out. Please try again.");
  }
  return cancelled();
}

function cancelled(): AwsConsoleLoginError {
  return new AwsConsoleLoginError("cancelled", "AWS sign-in was cancelled.");
}

function invalidInput(): AwsConsoleLoginError {
  return new AwsConsoleLoginError("invalid-input", "The AWS sign-in region or session is invalid or unsupported.");
}

function tokenRequestFailed(): AwsConsoleLoginError {
  return new AwsConsoleLoginError("token-request-failed", "AWS could not complete the sign-in request. Please try again.");
}

function serviceError(code: unknown): AwsConsoleLoginError {
  if (code === "INSUFFICIENT_PERMISSIONS") return new AwsConsoleLoginError("insufficient-permissions", "This AWS identity needs the SignInLocalDevelopmentAccess policy to sign in.");
  if (code === "TOKEN_EXPIRED" || code === "USER_CREDENTIALS_CHANGED") return new AwsConsoleLoginError("login-required", "Your AWS session has expired. Sign in to AWS again.");
  if (code === "AUTHCODE_EXPIRED") return new AwsConsoleLoginError("authorization-failed", "The AWS authorization has expired. Sign in to AWS again.");
  return tokenRequestFailed();
}
