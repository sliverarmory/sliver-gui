import { Subject, type Observable } from "rxjs";

import type { SliverRPCClient, DeepPartial } from "../pb/rpcpb/services";
import type { TunnelData } from "../pb/sliverpb/sliver";

import { AsyncQueue } from "./asyncQueue";

export class TunnelManager {
  private readonly outgoing = new AsyncQueue<DeepPartial<TunnelData>>();
  private readonly byTunnelId = new Map<string, Subject<TunnelData>>();
  private readonly abort = new AbortController();

  private running: Promise<void> | null = null;

  start(rpc: SliverRPCClient): void {
    if (this.running) return;

    this.running = (async () => {
      try {
        const stream = rpc.tunnelData(this.outgoing, { signal: this.abort.signal });
        for await (const msg of stream) {
          const tunnelId = msg.TunnelID;
          const subject = this.byTunnelId.get(tunnelId);
          if (!subject) continue;

          subject.next(msg);
          if (msg.Closed) {
            subject.complete();
            this.byTunnelId.delete(tunnelId);
          }
        }
      } catch (err) {
        for (const subject of this.byTunnelId.values()) {
          subject.error(err);
        }
        this.byTunnelId.clear();
        this.outgoing.fail(err);
      }
    })();
  }

  subscribe(tunnelId: string): Observable<TunnelData> {
    let subject = this.byTunnelId.get(tunnelId);
    if (!subject) {
      subject = new Subject<TunnelData>();
      this.byTunnelId.set(tunnelId, subject);
    }
    return subject.asObservable();
  }

  send(msg: DeepPartial<TunnelData>): void {
    this.outgoing.push(msg);
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.outgoing.close();
    if (this.running) {
      await this.running;
    }
    this.running = null;
    for (const subject of this.byTunnelId.values()) {
      subject.complete();
    }
    this.byTunnelId.clear();
  }
}
