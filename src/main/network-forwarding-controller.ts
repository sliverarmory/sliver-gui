import { isIP } from "node:net";
import type { RdpSocksProxyLease } from "./rdp-socks-transport.js";
import type {
  ForwardingAddress,
  LocalForwardState,
  PortForward,
  ReversePortForward,
  ReversePortForwardInfo,
  Socks5Proxy,
} from "sliver-script";
import type { Subscription } from "rxjs";

import type {
  ListNetworkForwardsInput,
  NetworkAddress,
  NetworkForwardingSnapshot,
  NetworkLocalForwardState,
  NetworkPortForwardSummary,
  NetworkReversePortForwardSummary,
  NetworkSocks5ProxySummary,
  StartPortForwardInput,
  StartReversePortForwardInput,
  StartSocks5ProxyInput,
} from "../shared/network-forwarding-contracts.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

const CONTROL_OPERATION_TIMEOUT_SECONDS = 30;
const CHANGE_COALESCE_MILLISECONDS = 100;
const REVERSE_INVENTORY_CONCURRENCY = 8;

/**
 * Owns sliver-script forwarding handles inside Electron main. Renderer-facing
 * callers only receive immutable, structured-clone-safe summaries.
 */
export class NetworkForwardingController {
  private readonly createdAtById = new Map<string, string>();
  private readonly socksAuthenticationById = new Map<string, "none" | "username-password">();
  private readonly socksSecrets = new Map<string, { username: Buffer; password: Buffer }>();
  private readonly socksLifetimes = new Map<string, AbortController>();
  private readonly subscriptions = new Map<string, Subscription>();
  private changeTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly client: Pick<
      SliverClientAdapter,
      | "startPortForward"
      | "listPortForwards"
      | "stopPortForward"
      | "startSocks5Proxy"
      | "listSocks5Proxies"
      | "stopSocks5Proxy"
      | "startReversePortForward"
      | "listReversePortForwards"
      | "stopReversePortForward"
    >,
    private readonly now: () => number,
    private readonly onChanged: () => void,
  ) {}

  async list(input: ListNetworkForwardsInput): Promise<NetworkForwardingSnapshot> {
    this.assertAvailable();
    const portForwards = this.client.listPortForwards();
    const socks5Proxies = this.client.listSocks5Proxies();
    this.reconcileLocalTracking(portForwards, socks5Proxies);

    const reverseTargets = input.reverseTargets ?? [];
    const reverseResults = await mapWithConcurrency(
      reverseTargets,
      REVERSE_INVENTORY_CONCURRENCY,
      async (target) => {
        try {
          const items = await this.client.listReversePortForwards(
            target.id,
            { timeoutSeconds: CONTROL_OPERATION_TIMEOUT_SECONDS },
          );
          return { items: items.map(reverseSummary) };
        } catch (error) {
          return { items: [] as NetworkReversePortForwardSummary[], error: `${target.id}: ${errorMessage(error)}` };
        }
      },
    );
    const reverseItems = reverseResults.flatMap(({ items }) => items);
    const reverseErrors = reverseResults.flatMap(({ error }) => error ? [error] : []);
    const reversePortForwards: NetworkForwardingSnapshot["reversePortForwards"] = {
      status: reverseTargets.length === 0 ? "idle" : reverseErrors.length > 0 ? "error" : "ready",
      items: reverseItems,
      ...(reverseErrors.length > 0 ? { error: reverseErrors.join("; ").slice(0, 1_024) } : {}),
    };

    return Object.freeze({
      portForwards: Object.freeze(portForwards.map((forward) => this.portSummary(forward))),
      reversePortForwards: Object.freeze({
        ...reversePortForwards,
        items: Object.freeze([...reversePortForwards.items]),
      }),
      socks5Proxies: Object.freeze(socks5Proxies.map((proxy) => this.socksSummary(proxy))),
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  async startPortForward(input: StartPortForwardInput): Promise<NetworkPortForwardSummary> {
    this.assertAvailable();
    const forward = await this.client.startPortForward(
      input.session.id,
      {
        bind: input.bind,
        target: input.destination,
        keepAliveSeconds: input.keepAliveSeconds,
        connectTimeoutSeconds: input.connectTimeoutSeconds,
        closeTimeoutSeconds: input.closeTimeoutSeconds,
        maxConnections: input.maxConnections,
        maxBufferedBytesPerConnection: input.maxBufferedBytesPerConnection,
      },
      { timeoutSeconds: CONTROL_OPERATION_TIMEOUT_SECONDS },
    );
    this.createdAtById.set(forward.id, new Date(this.now()).toISOString());
    this.trackLocal(`port:${forward.id}`, forward.state$, forward.id);
    this.notifySoon();
    return this.portSummary(forward);
  }

  async stopPortForward(id: string): Promise<void> {
    this.assertAvailable();
    if (!this.client.listPortForwards().some((forward) => forward.id === id)) {
      throw new Error("The port forward is no longer active");
    }
    await this.client.stopPortForward(id);
    this.notifySoon();
  }

  async startSocks5Proxy(input: StartSocks5ProxyInput): Promise<NetworkSocks5ProxySummary> {
    this.assertAvailable();
    const proxy = await this.client.startSocks5Proxy(
      input.session.id,
      {
        bind: input.bind,
        ...(input.authentication ? { authentication: input.authentication } : {}),
        connectTimeoutSeconds: input.connectTimeoutSeconds,
        closeTimeoutSeconds: input.closeTimeoutSeconds,
        maxConnections: input.maxConnections,
        maxBufferedBytesPerConnection: input.maxBufferedBytesPerConnection,
      },
      { timeoutSeconds: CONTROL_OPERATION_TIMEOUT_SECONDS },
    );
    if (this.disposed) { await proxy.close(); throw new Error("Networking is shutting down"); }
    this.socksLifetimes.set(proxy.id, new AbortController());
    if (input.authentication) this.socksSecrets.set(proxy.id, {
      username: Buffer.from(input.authentication.username), password: Buffer.from(input.authentication.password),
    });
    this.createdAtById.set(proxy.id, new Date(this.now()).toISOString());
    this.socksAuthenticationById.set(
      proxy.id,
      input.authentication ? "username-password" : "none",
    );
    this.trackLocal(`socks:${proxy.id}`, proxy.state$, proxy.id);
    this.notifySoon();
    return this.socksSummary(proxy);
  }

  async stopSocks5Proxy(id: string): Promise<void> {
    this.assertAvailable();
    if (!this.client.listSocks5Proxies().some((proxy) => proxy.id === id)) {
      throw new Error("The SOCKS5 proxy is no longer active");
    }
    this.invalidateSocks(id);
    await this.client.stopSocks5Proxy(id);
    this.notifySoon();
  }

  /** Only proxies started by this controller can lend their private authentication. */
  rdpProxies(): readonly NetworkSocks5ProxySummary[] {
    if (this.disposed) return [];
    const proxies = this.client.listSocks5Proxies();
    const ids = new Set(proxies.map((proxy) => proxy.id));
    for (const id of this.socksLifetimes.keys()) if (!ids.has(id)) this.invalidateSocks(id);
    return proxies.filter((proxy) => this.socksLifetimes.has(proxy.id)).map((proxy) => this.socksSummary(proxy));
  }

  leaseRdpProxy(id: string): RdpSocksProxyLease {
    this.assertAvailable();
    const proxy = this.client.listSocks5Proxies().find((candidate) => candidate.id === id);
    const lifetime = this.socksLifetimes.get(id);
    if (!proxy || !lifetime || lifetime.signal.aborted || proxy.state.status !== "listening") throw new Error("The selected SOCKS5 proxy is no longer available");
    const host = proxy.bind.host === "0.0.0.0" ? "127.0.0.1" : proxy.bind.host === "::" ? "::1" : proxy.bind.host;
    // The managed listener's numeric bind avoids accidentally resolving a different local endpoint.
    if (!isIP(host)) throw new Error("The SOCKS5 proxy must listen on an IP address");
    const secret = this.socksSecrets.get(id);
    const authentication = secret ? { username: Buffer.from(secret.username), password: Buffer.from(secret.password) } : undefined;
    const release = (): void => { authentication?.username.fill(0); authentication?.password.fill(0); lifetime.signal.removeEventListener("abort", release); };
    lifetime.signal.addEventListener("abort", release, { once: true });
    return Object.freeze({ host, port: proxy.bind.port, ...(authentication ? { authentication } : {}), signal: lifetime.signal,
      isActive: () => !this.disposed && !lifetime.signal.aborted && proxy.state.status === "listening" && this.client.listSocks5Proxies().includes(proxy), release });
  }

  private invalidateSocks(id: string): void {
    this.socksLifetimes.get(id)?.abort(); this.socksLifetimes.delete(id);
    const secret = this.socksSecrets.get(id);
    secret?.username.fill(0); secret?.password.fill(0); this.socksSecrets.delete(id);
  }

  async startReversePortForward(
    input: StartReversePortForwardInput,
  ): Promise<NetworkReversePortForwardSummary> {
    this.assertAvailable();
    const forward = await this.client.startReversePortForward(
      input.session.id,
      {
        bind: input.bind,
        target: input.destination,
        keepAliveSeconds: input.keepAliveSeconds,
      },
      { timeoutSeconds: CONTROL_OPERATION_TIMEOUT_SECONDS },
    );
    this.trackReverse(forward);
    this.notifySoon();
    return reverseSummary(forward);
  }

  async stopReversePortForward(sessionId: string, listenerId: number): Promise<void> {
    this.assertAvailable();
    await this.client.stopReversePortForward(
      sessionId,
      listenerId,
      { timeoutSeconds: CONTROL_OPERATION_TIMEOUT_SECONDS },
    );
    this.notifySoon();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.changeTimer) clearTimeout(this.changeTimer);
    delete this.changeTimer;
    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
    this.createdAtById.clear();
    this.socksAuthenticationById.clear();
    for (const id of this.socksLifetimes.keys()) this.invalidateSocks(id);
  }

  private portSummary(forward: PortForward): NetworkPortForwardSummary {
    return Object.freeze({
      kind: "port-forward",
      id: forward.id,
      sessionId: forward.sessionId,
      bind: address(forward.bind),
      destination: address(forward.target),
      state: localState(forward.state),
      createdAt: this.createdAt(forward.id),
    });
  }

  private socksSummary(proxy: Socks5Proxy): NetworkSocks5ProxySummary {
    return Object.freeze({
      kind: "socks5",
      id: proxy.id,
      sessionId: proxy.sessionId,
      bind: address(proxy.bind),
      authentication: this.socksAuthenticationById.get(proxy.id) ?? "none",
      state: localState(proxy.state),
      createdAt: this.createdAt(proxy.id),
    });
  }

  private createdAt(id: string): string {
    let createdAt = this.createdAtById.get(id);
    if (!createdAt) {
      createdAt = new Date(this.now()).toISOString();
      this.createdAtById.set(id, createdAt);
    }
    return createdAt;
  }

  private reconcileLocalTracking(
    portForwards: readonly PortForward[],
    socks5Proxies: readonly Socks5Proxy[],
  ): void {
    const liveIds = new Set<string>();
    for (const forward of portForwards) {
      liveIds.add(forward.id);
      this.createdAt(forward.id);
      this.trackLocal(`port:${forward.id}`, forward.state$, forward.id);
    }
    for (const proxy of socks5Proxies) {
      liveIds.add(proxy.id);
      this.createdAt(proxy.id);
      this.trackLocal(`socks:${proxy.id}`, proxy.state$, proxy.id);
    }
    for (const id of this.createdAtById.keys()) {
      if (!liveIds.has(id)) this.createdAtById.delete(id);
    }
    for (const id of this.socksAuthenticationById.keys()) {
      if (!liveIds.has(id)) { this.socksAuthenticationById.delete(id); this.invalidateSocks(id); }
    }
  }

  private trackLocal(
    key: string,
    state$: PortForward["state$"] | Socks5Proxy["state$"],
    id: string,
  ): void {
    if (this.subscriptions.has(key)) return;
    const subscription = state$.subscribe({
      next: (state) => {
        this.notifySoon();
        if (state.status === "closed" || state.status === "failed") {
          this.createdAtById.delete(id);
          this.socksAuthenticationById.delete(id);
          this.invalidateSocks(id);
        }
      },
      complete: () => { this.subscriptions.delete(key); if (key.startsWith("socks:")) this.invalidateSocks(id); },
    });
    this.subscriptions.set(key, subscription);
  }

  private trackReverse(forward: ReversePortForward): void {
    const key = `reverse:${forward.sessionId}:${forward.id}`;
    if (this.subscriptions.has(key)) return;
    const subscription = forward.state$.subscribe({
      next: () => this.notifySoon(),
      complete: () => this.subscriptions.delete(key),
    });
    this.subscriptions.set(key, subscription);
  }

  private notifySoon(): void {
    if (this.disposed || this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      delete this.changeTimer;
      if (!this.disposed) this.onChanged();
    }, CHANGE_COALESCE_MILLISECONDS);
    this.changeTimer.unref();
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Network forwarding is unavailable");
  }
}

function localState(state: LocalForwardState): NetworkLocalForwardState {
  return Object.freeze({
    status: state.status,
    activeConnections: state.activeConnections,
    totalConnections: state.totalConnections,
    bytesToTarget: state.bytesToTarget,
    bytesFromTarget: state.bytesFromTarget,
    ...(state.reason ? { reason: state.reason } : {}),
  });
}

function reverseSummary(forward: ReversePortForwardInfo): NetworkReversePortForwardSummary {
  return Object.freeze({
    kind: "reverse-port-forward",
    listenerId: forward.id,
    sessionId: forward.sessionId,
    bind: forward.bind ? address(forward.bind) : null,
    destination: forward.target ? address(forward.target) : null,
    status: "listening",
  });
}

function address(value: ForwardingAddress): NetworkAddress {
  return Object.freeze({ host: value.host, port: value.port });
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return (cleaned || "The reverse port forward inventory is unavailable").slice(0, 512);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
