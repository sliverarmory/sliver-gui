import { randomUUID } from "node:crypto";
import { RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, type RdpClipboardFile, type RdpFileTransferProgress } from "../shared/rdp-contracts.js";
import { createRdpClipboardStaging, type RdpLocalClipboardFiles, type RdpClipboardStaging } from "./rdp-file-clipboard.js";
import type { RdpFileRuntimeEvent } from "./rdp-runtime.js";

type FileReply = Extract<RdpFileRuntimeEvent, { type: "clipboardFiles" | "clipboardFileChunk" }>;
interface ProgressState { value: RdpFileTransferProgress; lastReported: number; terminal: boolean }
const transferFailed = "The file transfer failed. Copy the files again and retry.";

/** File bytes and local paths stay between main and the private native pipe. */
export class RdpFileTransfer {
  readonly #send: (command: object) => void;
  readonly #requireActive: () => void;
  readonly #retain: (staging: RdpClipboardStaging) => void;
  readonly #reserve: (files: readonly RdpClipboardFile[]) => () => void;
  readonly #progress: (progress: RdpFileTransferProgress) => void;
  readonly #cleanup = new Set<Promise<void>>();
  readonly #pending = new Map<string, { resolve: (event: FileReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #offer: { id: string; files: RdpLocalClipboardFiles; lastTransfer: bigint } | undefined;
  #downloadProgress: ProgressState | undefined;
  #uploadProgress: ProgressState | undefined;
  #generation = 0;
  #receiving = false;
  #reads = 0;
  #nativeActive = false;

  constructor(send: (command: object) => void, requireActive: () => void, retain: (staging: RdpClipboardStaging) => void,
    reserve: (files: readonly RdpClipboardFile[]) => () => void = () => () => {}, progress: (value: RdpFileTransferProgress) => void = () => {}) {
    this.#send = send; this.#requireActive = requireActive; this.#retain = retain;
    this.#reserve = reserve; this.#progress = progress;
  }

  offer(files: RdpLocalClipboardFiles): void {
    this.#requireActive();
    this.cancel();
    const id = randomUUID();
    this.#offer = { id, files, lastTransfer: 0n };
    this.#nativeActive = true;
    this.#send({ type: "clipboardFilesOffer", offerId: id, files: files.files });
  }

  ownsOffer(requestId: string | undefined): boolean {
    return requestId !== undefined && requestId === this.#offer?.id;
  }

  receive(event: RdpFileRuntimeEvent): void {
    if (event.type === "clipboardFileUploadProgress") { this.#upload(event); return; }
    if (event.type === "clipboardFileRequest") { void this.#read(event); return; }
    if (event.type === "clipboardFilesAvailable") {
      // A format announcement invalidates an unlocked remote clipboard stream.
      this.#cancelReceive();
      return;
    }
    if (event.type === "clipboardFilesError") {
      const request = event.requestId ? this.#pending.get(event.requestId) : undefined;
      if (request) {
        clearTimeout(request.timer); this.#pending.delete(event.requestId!);
        request.reject(new Error(fileTransferError(event.code)));
      }
      const offer = this.#offer;
      if (offer && event.requestId === offer.id) { this.#terminal(this.#uploadProgress, "failed"); this.#close(offer.files); this.#offer = undefined; }
      return;
    }
    if (event.type !== "clipboardFiles" && event.type !== "clipboardFileChunk") return;
    const request = this.#pending.get(event.requestId);
    if (!request) return;
    clearTimeout(request.timer); this.#pending.delete(event.requestId);
    if (event.type === "clipboardFileChunk" && event.error) request.reject(new Error("The remote file could not be read. Copy the files again and retry."));
    else request.resolve(event);
  }

  async download(beforePublish: () => Promise<void>): Promise<string> {
    if (this.#receiving) throw new Error("A file clipboard transfer is already pending");
    this.#requireActive();
    this.#receiving = true;
    const progress = this.#startProgress({ id: randomUUID(), direction: "receive", phase: "preparing", transferredBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 });
    this.#downloadProgress = progress;
    const generation = this.#generation;
    let staging: RdpClipboardStaging | undefined;
    let release: (() => void) | undefined;
    const current = (): void => {
      this.#requireActive();
      if (generation !== this.#generation) throw new Error("Clipboard file transfer was canceled");
    };
    try {
      const list = await this.#request({ type: "clipboardFilesRequest" });
      current();
      if (list.type !== "clipboardFiles") throw new Error("Invalid remote file list response");
      this.#report(progress, { ...progress.value, phase: "transferring", totalBytes: list.files.reduce((sum, file) => sum + file.size, 0), totalFiles: list.files.length }, true);
      release = this.#reserve(list.files);
      staging = await createRdpClipboardStaging(list.files);
      current();
      for (const [index, file] of list.files.entries()) {
        for (let offset = 0; offset < file.size;) {
          const length = Math.min(RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, file.size - offset);
          const response = await this.#request({ type: "clipboardFileRead", clipboardId: list.clipboardId, index, offset, length });
          current();
          if (response.type !== "clipboardFileChunk" || response.data.length === 0 || response.data.length > length) throw new Error("The remote file returned an invalid data range");
          try {
            await staging.write(index, offset, response.data); offset += response.data.length;
            current();
            this.#report(progress, { ...progress.value, transferredBytes: progress.value.transferredBytes + response.data.length });
          }
          finally { response.data.fill(0); }
          current();
        }
        this.#report(progress, { ...progress.value, completedFiles: index + 1 });
      }
      await beforePublish();
      current();
      const signature = await staging.publish(async () => { await beforePublish(); current(); });
      // Once the OS owns these paths they must remain valid until app shutdown.
      this.#retain(staging); staging = undefined;
      release = undefined;
      this.#terminal(progress, "completed");
      return signature;
    } catch (error) {
      this.#terminal(progress, generation === this.#generation ? "failed" : "canceled");
      throw error;
    } finally {
      try { if (staging) await staging.dispose(); }
      finally { release?.(); this.#receiving = false; if (this.#downloadProgress === progress) this.#downloadProgress = undefined; }
    }
  }

  #request(command: object): Promise<FileReply> {
    const requestId = randomUUID();
    this.#nativeActive = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId); reject(new Error("The clipboard file transfer timed out"));
      }, 30_000);
      timer.unref();
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#send({ ...command, requestId });
    });
  }

  async #read(event: Extract<RdpFileRuntimeEvent, { type: "clipboardFileRequest" }>): Promise<void> {
    const offer = this.#offer, generation = this.#generation;
    // The helper bounds its queue too. Keep disk work bounded independently.
    if (this.#reads >= 16) { this.#send({ type: "clipboardFileResponse", requestId: event.requestId, error: true }); return; }
    this.#reads++;
    let data: Buffer | undefined;
    try {
      this.#requireActive();
      if (!offer || offer.id !== event.offerId) throw new Error("Clipboard file offer expired");
      data = await offer.files.read(event.index, event.offset, event.length);
      this.#requireActive();
      if (offer !== this.#offer) throw new Error("Clipboard file offer expired");
      this.#send({ type: "clipboardFileResponse", requestId: event.requestId, data: data.toString("base64") });
    } catch {
      // Native already rejects canceled reads. Never send a late response into a
      // replacement helper, whose stream/request counter may start over at one.
      if (generation === this.#generation) this.#send({ type: "clipboardFileResponse", requestId: event.requestId, error: true });
    }
    finally { data?.fill(0); this.#reads--; }
  }

  #cancelReceive(): void {
    this.#generation++;
    this.#terminal(this.#downloadProgress, "canceled");
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Clipboard file transfer was canceled")); }
    this.#pending.clear();
  }

  cancel(): void {
    this.#cancelReceive();
    this.#terminal(this.#uploadProgress, "canceled");
    const offer = this.#offer; this.#offer = undefined;
    if (offer) this.#close(offer.files);
    if (this.#nativeActive) { this.#nativeActive = false; this.#send({ type: "clipboardFilesCancel" }); }
  }

  #close(files: RdpLocalClipboardFiles): void {
    const cleanup = files.close().catch(() => {});
    this.#cleanup.add(cleanup);
    void cleanup.finally(() => this.#cleanup.delete(cleanup));
  }

  async dispose(): Promise<void> {
    this.cancel();
    await Promise.allSettled([...this.#cleanup]);
  }

  #startProgress(value: RdpFileTransferProgress): ProgressState {
    const progress = { value, lastReported: Number.NEGATIVE_INFINITY, terminal: false };
    this.#report(progress, value, true);
    return progress;
  }

  #report(progress: ProgressState, value: RdpFileTransferProgress, force = false): void {
    if (progress.terminal) return;
    progress.value = value;
    progress.terminal = value.phase === "completed" || value.phase === "failed" || value.phase === "canceled";
    const now = Date.now();
    if (force || progress.terminal || now - progress.lastReported >= 100) {
      progress.lastReported = now;
      this.#progress({ ...value });
    }
  }

  #terminal(progress: ProgressState | undefined, phase: "completed" | "failed" | "canceled"): void {
    if (progress) this.#report(progress, { ...progress.value, phase, ...(phase === "failed" ? { error: transferFailed } : {}) }, true);
  }

  #upload(event: Extract<RdpFileRuntimeEvent, { type: "clipboardFileUploadProgress" }>): void {
    const offer = this.#offer;
    if (!offer || event.offerId !== offer.id || !/^upload-[1-9][0-9]*$/u.test(event.transferId)) return;
    const sequence = BigInt(event.transferId.slice(7));
    if (sequence < offer.lastTransfer) return;
    const totalBytes = offer.files.files.reduce((sum, file) => sum + file.size, 0);
    if (event.totalBytes !== totalBytes || event.totalFiles !== offer.files.files.length) return;
    if (event.transferredBytes > totalBytes || event.completedFiles > event.totalFiles ||
      (event.phase === "completed" && (event.transferredBytes !== totalBytes || event.completedFiles !== event.totalFiles))) return;
    const id = `${offer.id}:${event.transferId}`;
    let progress = this.#uploadProgress;
    if (sequence > offer.lastTransfer) {
      if (event.phase !== "transferring") return;
      this.#terminal(progress, "canceled");
      offer.lastTransfer = sequence;
      progress = this.#startProgress({ id, direction: "send", phase: "transferring", transferredBytes: event.transferredBytes,
        totalBytes, completedFiles: event.completedFiles, totalFiles: event.totalFiles });
      this.#uploadProgress = progress;
      return;
    }
    if (!progress || progress.value.id !== id || progress.terminal || event.transferredBytes < progress.value.transferredBytes || event.completedFiles < progress.value.completedFiles) return;
    this.#report(progress, { id, direction: "send", phase: event.phase, transferredBytes: event.transferredBytes, totalBytes,
      completedFiles: event.completedFiles, totalFiles: event.totalFiles, ...(event.phase === "failed" ? { error: transferFailed } : {}) });
  }
}

function fileTransferError(code: string): string {
  if (code === "clipboard-files-unsupported") return "The server does not support file clipboard transfers";
  if (code === "clipboard-files-limit") return "Copy up to 64 regular files totaling at most 256 MiB";
  return "The clipboard files are unavailable or unsupported. Copy regular files again and retry.";
}
