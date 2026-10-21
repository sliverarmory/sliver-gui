// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, type RdpClipboardFile, type RdpFileTransferProgress } from "../shared/rdp-contracts.js";
import { createRdpClipboardStaging, type RdpClipboardStaging, type RdpLocalClipboardFiles } from "./rdp-file-clipboard.js";
import { RdpFileTransfer } from "./rdp-file-transfer.js";

vi.mock("./rdp-file-clipboard.js", () => ({ createRdpClipboardStaging: vi.fn() }));

interface Command {
  type: string;
  requestId?: string;
  offerId?: string;
  clipboardId?: string;
  index?: number;
  offset?: number;
  length?: number;
  data?: string;
  error?: boolean;
  files?: readonly RdpClipboardFile[];
}

const transfers: RdpFileTransfer[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(() => { for (const transfer of transfers.splice(0)) transfer.cancel(); vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(): {
  transfer: RdpFileTransfer;
  sent: Command[];
  requireActive: ReturnType<typeof vi.fn<() => void>>;
  retain: ReturnType<typeof vi.fn<(staging: RdpClipboardStaging) => void>>;
  staging: RdpClipboardStaging;
  writes: { index: number; offset: number; bytes: Buffer }[];
  progress: RdpFileTransferProgress[];
} {
  const sent: Command[] = [], writes: { index: number; offset: number; bytes: Buffer }[] = [];
  const progress: RdpFileTransferProgress[] = [];
  const requireActive = vi.fn<() => void>();
  const retain = vi.fn<(staging: RdpClipboardStaging) => void>();
  const staging: RdpClipboardStaging = {
    write: vi.fn(async (index, offset, bytes) => { writes.push({ index, offset, bytes: Buffer.from(bytes) }); }),
    publish: vi.fn(async (beforeWrite) => { await beforeWrite?.(); return "published-files-signature"; }),
    dispose: vi.fn(async () => {}),
  };
  vi.mocked(createRdpClipboardStaging).mockResolvedValue(staging);
  const transfer = new RdpFileTransfer((command) => sent.push(command as Command), requireActive, retain, undefined, (value) => progress.push(value));
  transfers.push(transfer);
  return { transfer, sent, requireActive, retain, staging, writes, progress };
}

function localFiles(): RdpLocalClipboardFiles {
  return { files: [{ name: "local.txt", size: 4 }], signature: "local-files-signature",
    read: vi.fn(async () => Buffer.from("data")), close: vi.fn(async () => {}) };
}

async function request(sent: Command[], type: string, count = 1): Promise<Command & { requestId: string }> {
  await vi.waitFor(() => expect(sent.filter((command) => command.type === type)).toHaveLength(count));
  const command = sent.filter((value) => value.type === type).at(-1)!;
  if (!command.requestId) throw new Error(`Missing request identifier for ${type}`);
  return command as Command & { requestId: string };
}

function observe<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}

async function startDownload(f: ReturnType<typeof fixture>, size = 4, beforePublish = vi.fn(async () => {})) {
  const result = observe(f.transfer.download(beforePublish));
  const list = await request(f.sent, "clipboardFilesRequest");
  f.transfer.receive({ type: "clipboardFiles", requestId: list.requestId, clipboardId: "remote-copy", files: [{ name: "remote.txt", size }] });
  const read = size ? await request(f.sent, "clipboardFileRead") : undefined;
  return { result, list, read, beforePublish };
}

describe("RdpFileTransfer", () => {
  it("advertises only an explicitly offered file list and serves it while active", async () => {
    const f = fixture(), files = localFiles();
    f.transfer.offer(files);
    const offer = f.sent.find((command) => command.type === "clipboardFilesOffer")!;
    expect(offer.files).toEqual(files.files);
    expect(offer).not.toHaveProperty("signature");
    expect(offer.offerId).toBeTruthy();
    f.transfer.receive({ type: "clipboardFileRequest", requestId: "upload", offerId: offer.offerId!, index: 0, offset: 0, length: 4 });
    const reply = await request(f.sent, "clipboardFileResponse");
    expect(reply).toEqual({ type: "clipboardFileResponse", requestId: "upload", data: Buffer.from("data").toString("base64") });
    expect(files.read).toHaveBeenCalledWith(0, 0, 4);
    expect(f.requireActive).toHaveBeenCalledTimes(3);
  });

  it.each(["unoffered", "inactive"])("rejects an %s upload request without reading files", async (condition) => {
    const f = fixture(), files = localFiles();
    f.transfer.offer(files);
    const offerId = f.sent.find((command) => command.type === "clipboardFilesOffer")!.offerId!;
    if (condition === "inactive") f.requireActive.mockImplementation(() => { throw new Error("Focus changed"); });
    f.transfer.receive({ type: "clipboardFileRequest", requestId: "rejected", offerId: condition === "unoffered" ? "stale-offer" : offerId, index: 0, offset: 0, length: 4 });
    expect(await request(f.sent, "clipboardFileResponse")).toEqual({ type: "clipboardFileResponse", requestId: "rejected", error: true });
    expect(files.read).not.toHaveBeenCalled();
  });

  it("requires active focus before taking ownership of local files", () => {
    const f = fixture(), files = localFiles();
    f.requireActive.mockImplementation(() => { throw new Error("Focus changed"); });
    expect(() => f.transfer.offer(files)).toThrow("Focus changed");
    expect(f.sent).toEqual([]);
    expect(files.close).not.toHaveBeenCalled();
  });

  it("correlates offer errors without treating stale request IDs as failures of a replacement offer", () => {
    const f = fixture(), original = localFiles(), replacement = localFiles();
    f.transfer.offer(original);
    const previousId = f.sent.find((command) => command.type === "clipboardFilesOffer")!.offerId!;
    expect(f.transfer.ownsOffer(previousId)).toBe(true);
    f.transfer.offer(replacement);
    const currentId = f.sent.filter((command) => command.type === "clipboardFilesOffer").at(-1)!.offerId!;
    for (const requestId of [undefined, "local-1", previousId]) expect(f.transfer.ownsOffer(requestId)).toBe(false);
    f.transfer.receive({ type: "clipboardFilesError", requestId: previousId, code: "clipboard-files-rejected" });
    f.transfer.receive({ type: "clipboardFilesError", requestId: "local-1", code: "clipboard-files-stale-request" });
    expect(f.transfer.ownsOffer(currentId)).toBe(true);
    expect(replacement.close).not.toHaveBeenCalled();
    f.transfer.receive({ type: "clipboardFilesError", requestId: currentId, code: "clipboard-files-rejected" });
    expect(f.transfer.ownsOffer(currentId)).toBe(false);
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("discards a disk read that completes after cancellation and closes the offer", async () => {
    const f = fixture(), files = localFiles(), read = deferred<Buffer>();
    vi.mocked(files.read).mockReturnValue(read.promise);
    f.transfer.offer(files);
    const offerId = f.sent.find((command) => command.type === "clipboardFilesOffer")!.offerId!;
    f.transfer.receive({ type: "clipboardFileRequest", requestId: "late-upload", offerId, index: 0, offset: 0, length: 4 });
    expect(files.read).toHaveBeenCalledOnce();
    f.transfer.cancel();
    const bytes = Buffer.from("data");
    read.resolve(bytes);
    await vi.waitFor(() => expect(bytes).toEqual(Buffer.alloc(4)));
    expect(f.sent.filter((command) => command.type === "clipboardFileResponse")).toEqual([]);
    expect(files.close).toHaveBeenCalledOnce();
    expect(bytes).toEqual(Buffer.alloc(4));
  });

  it("waits for offered file handles to close during disposal", async () => {
    const f = fixture(), files = localFiles(), closed = deferred<void>();
    vi.mocked(files.close).mockReturnValue(closed.promise);
    f.transfer.offer(files);
    const finished = vi.fn();
    const cleanup = f.transfer.dispose().then(finished);
    await Promise.resolve();
    expect(files.close).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    closed.resolve();
    await cleanup;
    expect(finished).toHaveBeenCalledOnce();
  });

  it("downloads bounded chunks in order and publishes only the complete file set", async () => {
    const f = fixture(), beforePublish = vi.fn(async () => {});
    const result = observe(f.transfer.download(beforePublish));
    const list = await request(f.sent, "clipboardFilesRequest");
    const size = RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES + 3;
    const files = [{ name: "empty.txt", size: 0 }, { name: "large.bin", size }];
    f.transfer.receive({ type: "clipboardFiles", requestId: list.requestId, clipboardId: "remote-copy", files });
    const first = await request(f.sent, "clipboardFileRead");
    expect(first).toMatchObject({ clipboardId: "remote-copy", index: 1, offset: 0, length: RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES });
    const chunk = Buffer.alloc(RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, 0x42);
    f.transfer.receive({ type: "clipboardFileChunk", requestId: first.requestId, error: false, data: chunk });
    const second = await request(f.sent, "clipboardFileRead", 2);
    expect(second).toMatchObject({ clipboardId: "remote-copy", index: 1, offset: RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, length: 3 });
    expect(beforePublish).not.toHaveBeenCalled();
    expect(f.staging.publish).not.toHaveBeenCalled();
    f.transfer.receive({ type: "clipboardFileChunk", requestId: second.requestId, error: false, data: Buffer.from("end") });
    expect(await result).toEqual({ value: "published-files-signature" });
    expect(f.writes).toEqual([{ index: 1, offset: 0, bytes: Buffer.alloc(RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, 0x42) },
      { index: 1, offset: RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, bytes: Buffer.from("end") }]);
    expect(chunk).toEqual(Buffer.alloc(chunk.length));
    expect(createRdpClipboardStaging).toHaveBeenCalledWith(files);
    expect(beforePublish).toHaveBeenCalledTimes(2);
    expect(f.staging.publish).toHaveBeenCalledOnce();
    expect(f.retain).toHaveBeenCalledExactlyOnceWith(f.staging);
    expect(f.staging.dispose).not.toHaveBeenCalled();
  });

  it("ignores unsolicited chunks and stale list replies after cancellation", async () => {
    const f = fixture();
    f.transfer.receive({ type: "clipboardFileChunk", requestId: "unsolicited", error: false, data: Buffer.from("ignored") });
    expect(f.sent).toEqual([]);
    const first = observe(f.transfer.download(async () => {}));
    const oldList = await request(f.sent, "clipboardFilesRequest");
    f.transfer.cancel();
    expect(await first).toEqual({ error: expect.objectContaining({ message: "Clipboard file transfer was canceled" }) });
    const second = observe(f.transfer.download(async () => {}));
    const currentList = await request(f.sent, "clipboardFilesRequest", 2);
    f.transfer.receive({ type: "clipboardFiles", requestId: oldList.requestId, clipboardId: "old-copy", files: [{ name: "old.txt", size: 1 }] });
    expect(createRdpClipboardStaging).not.toHaveBeenCalled();
    f.transfer.receive({ type: "clipboardFiles", requestId: currentList.requestId, clipboardId: "current-copy", files: [{ name: "empty.txt", size: 0 }] });
    expect(await second).toEqual({ value: "published-files-signature" });
    expect(createRdpClipboardStaging).toHaveBeenCalledExactlyOnceWith([{ name: "empty.txt", size: 0 }]);
  });

  it.each(["empty", "oversized", "remote-error"])("disposes an incomplete download after an %s response", async (kind) => {
    const f = fixture(), download = await startDownload(f);
    f.transfer.receive({ type: "clipboardFileChunk", requestId: download.read!.requestId, error: kind === "remote-error",
      data: Buffer.alloc(kind === "oversized" ? 5 : 0) });
    expect(await download.result).toEqual({ error: expect.any(Error) });
    expect(f.staging.dispose).toHaveBeenCalledOnce();
    expect(f.staging.publish).not.toHaveBeenCalled();
    expect(f.retain).not.toHaveBeenCalled();
  });

  it("continues a short positive read but rejects an early end without publishing partial files", async () => {
    const f = fixture(), download = await startDownload(f);
    f.transfer.receive({ type: "clipboardFileChunk", requestId: download.read!.requestId, error: false, data: Buffer.from("ab") });
    const remainder = await request(f.sent, "clipboardFileRead", 2);
    expect(remainder).toMatchObject({ offset: 2, length: 2 });
    f.transfer.receive({ type: "clipboardFileChunk", requestId: remainder.requestId, error: false, data: Buffer.alloc(0) });
    expect(await download.result).toEqual({ error: expect.any(Error) });
    expect(f.writes).toEqual([{ index: 0, offset: 0, bytes: Buffer.from("ab") }]);
    expect(f.staging.dispose).toHaveBeenCalledOnce();
    expect(f.staging.publish).not.toHaveBeenCalled();
  });

  it.each(["cancel", "remote-copy"])("disposes staged files when %s invalidates a pending chunk", async (reason) => {
    const f = fixture(), download = await startDownload(f);
    if (reason === "cancel") f.transfer.cancel();
    else f.transfer.receive({ type: "clipboardFilesAvailable", available: true });
    expect(await download.result).toEqual({ error: expect.objectContaining({ message: "Clipboard file transfer was canceled" }) });
    f.transfer.receive({ type: "clipboardFileChunk", requestId: download.read!.requestId, error: false, data: Buffer.from("late") });
    expect(f.writes).toEqual([]);
    expect(f.staging.dispose).toHaveBeenCalledOnce();
    expect(f.staging.publish).not.toHaveBeenCalled();
  });

  it("checks cancellation again after the final local clipboard check", async () => {
    const f = fixture(), gate = deferred<void>(), beforePublish = vi.fn(() => gate.promise);
    const download = await startDownload(f, 4, beforePublish);
    f.transfer.receive({ type: "clipboardFileChunk", requestId: download.read!.requestId, error: false, data: Buffer.from("data") });
    await vi.waitFor(() => expect(beforePublish).toHaveBeenCalledOnce());
    f.transfer.cancel();
    gate.resolve();
    expect(await download.result).toEqual({ error: expect.any(Error) });
    expect(f.staging.dispose).toHaveBeenCalledOnce();
    expect(f.staging.publish).not.toHaveBeenCalled();
  });

  it("rechecks focus after file finalization before publishing local file paths", async () => {
    const f = fixture(), sealed = deferred<void>(), wroteClipboard = vi.fn();
    vi.mocked(f.staging.publish).mockImplementation(async (beforeWrite) => {
      await sealed.promise;
      await beforeWrite?.();
      wroteClipboard();
      return "published-files-signature";
    });
    const download = await startDownload(f, 0);
    await vi.waitFor(() => expect(f.staging.publish).toHaveBeenCalledOnce());
    f.requireActive.mockImplementation(() => { throw new Error("Focus changed"); });
    sealed.resolve();
    expect(await download.result).toEqual({ error: expect.objectContaining({ message: "Focus changed" }) });
    expect(wroteClipboard).not.toHaveBeenCalled();
    expect(f.staging.dispose).toHaveBeenCalledOnce();
    expect(f.retain).not.toHaveBeenCalled();
  });

  it("disposes staging when publishing fails and allows a later transfer", async () => {
    const f = fixture();
    vi.mocked(f.staging.publish).mockRejectedValueOnce(new Error("Local clipboard unavailable"));
    const first = await startDownload(f, 0);
    expect(await first.result).toEqual({ error: expect.objectContaining({ message: "Local clipboard unavailable" }) });
    expect(f.staging.dispose).toHaveBeenCalledOnce();
    expect(f.retain).not.toHaveBeenCalled();
    const second = observe(f.transfer.download(async () => {}));
    const list = await request(f.sent, "clipboardFilesRequest", 2);
    f.transfer.receive({ type: "clipboardFiles", requestId: list.requestId, clipboardId: "retry", files: [{ name: "empty.txt", size: 0 }] });
    expect(await second).toEqual({ value: "published-files-signature" });
  });

  it("times out stalled file reads and disposes partial staging", async () => {
    const f = fixture(), download = await startDownload(f);
    vi.useFakeTimers();
    // Start another request under the fake clock after accepting a short chunk.
    f.transfer.receive({ type: "clipboardFileChunk", requestId: download.read!.requestId, error: false, data: Buffer.from("a") });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await download.result).toEqual({ error: expect.objectContaining({ message: "The clipboard file transfer timed out" }) });
    expect(f.staging.dispose).toHaveBeenCalledOnce();
    expect(f.staging.publish).not.toHaveBeenCalled();
    expect(f.progress.at(-1)).toMatchObject({ phase: "failed", transferredBytes: 1, totalBytes: 4 });
  });

  it("reports unknown totals while preparing, persisted bytes while transferring, and completion only after publishing", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), written = deferred<void>(), published = deferred<void>();
    vi.mocked(f.staging.write).mockImplementationOnce(async () => { await written.promise; });
    vi.mocked(f.staging.publish).mockImplementation(async () => { await published.promise; return "published"; });
    const result = observe(f.transfer.download(async () => {}));
    expect(f.progress).toEqual([{ id: expect.any(String), direction: "receive", phase: "preparing", transferredBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0 }]);
    const list = await request(f.sent, "clipboardFilesRequest");
    f.transfer.receive({ type: "clipboardFiles", requestId: list.requestId, clipboardId: "copy", files: [{ name: "empty.txt", size: 0 }, { name: "data.txt", size: 4 }] });
    const first = await request(f.sent, "clipboardFileRead");
    expect(f.progress.at(-1)).toMatchObject({ phase: "transferring", totalBytes: 4, totalFiles: 2, transferredBytes: 0 });
    now += 200;
    f.transfer.receive({ type: "clipboardFileChunk", requestId: first.requestId, error: false, data: Buffer.from("ab") });
    await vi.waitFor(() => expect(f.staging.write).toHaveBeenCalledOnce());
    expect(f.progress.at(-1)?.transferredBytes).toBe(0);
    written.resolve();
    const next = await request(f.sent, "clipboardFileRead", 2);
    expect(f.progress.at(-1)).toMatchObject({ transferredBytes: 2, completedFiles: 1 });
    now += 200;
    f.transfer.receive({ type: "clipboardFileChunk", requestId: next.requestId, error: false, data: Buffer.from("cd") });
    await vi.waitFor(() => expect(f.staging.publish).toHaveBeenCalledOnce());
    expect(f.progress.at(-1)).toMatchObject({ phase: "transferring", transferredBytes: 4 });
    expect(f.progress.some(({ phase }) => phase === "completed")).toBe(false);
    published.resolve(); expect(await result).toEqual({ value: "published" });
    expect(f.progress.at(-1)).toMatchObject({ phase: "completed", transferredBytes: 4, totalBytes: 4, completedFiles: 2, totalFiles: 2 });
    expect(new Set(f.progress.map(({ id }) => id)).size).toBe(1);
    expect(f.progress.map(({ transferredBytes }) => transferredBytes)).toEqual([...f.progress.map(({ transferredBytes }) => transferredBytes)].sort((a, b) => a - b));
    f.transfer.cancel(); expect(f.progress.filter(({ phase }) => phase === "completed" || phase === "canceled")).toHaveLength(1);
  });

  it("reports a zero-byte download as complete only once its files are published", async () => {
    const f = fixture(), download = await startDownload(f, 0);
    expect(await download.result).toEqual({ value: "published-files-signature" });
    expect(f.progress.at(-1)).toMatchObject({ direction: "receive", phase: "completed", transferredBytes: 0, totalBytes: 0, completedFiles: 1, totalFiles: 1 });
  });

  it("reports cancellation once and suppresses a late canceled download after a newer upload starts", async () => {
    const f = fixture(), written = deferred<void>();
    vi.mocked(f.staging.write).mockImplementationOnce(async () => { await written.promise; });
    const download = await startDownload(f);
    const downloadId = f.progress[0]!.id;
    f.transfer.receive({ type: "clipboardFileChunk", requestId: download.read!.requestId, error: false, data: Buffer.from("data") });
    await vi.waitFor(() => expect(f.staging.write).toHaveBeenCalledOnce());
    f.transfer.cancel(); f.transfer.cancel();
    expect(f.progress.filter(({ id, phase }) => id === downloadId && phase === "canceled")).toHaveLength(1);
    f.transfer.offer(localFiles());
    const offerId = f.sent.find((command) => command.type === "clipboardFilesOffer")!.offerId!;
    f.transfer.receive({ type: "clipboardFileUploadProgress", offerId, transferId: "upload-1", phase: "transferring", transferredBytes: 0, totalBytes: 4, completedFiles: 0, totalFiles: 1 });
    const count = f.progress.length;
    written.resolve(); expect(await download.result).toEqual({ error: expect.any(Error) });
    expect(f.progress).toHaveLength(count);
    expect(f.progress.at(-1)).toMatchObject({ direction: "send", phase: "transferring" });
  });

  it("reports one sanitized failure when local staging fails", async () => {
    const f = fixture();
    vi.mocked(createRdpClipboardStaging).mockRejectedValueOnce(new Error("EACCES /private/local-user/secret"));
    const result = observe(f.transfer.download(async () => {}));
    const list = await request(f.sent, "clipboardFilesRequest");
    f.transfer.receive({ type: "clipboardFiles", requestId: list.requestId, clipboardId: "copy", files: [{ name: "file.txt", size: 4 }] });
    expect(await result).toEqual({ error: expect.any(Error) });
    expect(f.progress.at(-1)).toMatchObject({ phase: "failed", error: "The file transfer failed. Copy the files again and retry." });
    expect(JSON.stringify(f.progress)).not.toContain("secret");
    f.transfer.cancel(); expect(f.progress.filter(({ phase }) => phase === "failed" || phase === "canceled")).toHaveLength(1);
  });

  it("throttles monotonic upload progress while preserving starts, terminal events, and new paste identity", () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(); f.transfer.offer(localFiles());
    const offerId = f.sent.find((command) => command.type === "clipboardFilesOffer")!.offerId!;
    const update = (transferId: string, phase: "transferring" | "completed" | "failed" | "canceled", transferredBytes: number) => f.transfer.receive({
      type: "clipboardFileUploadProgress", offerId, transferId, phase, transferredBytes, totalBytes: 4, completedFiles: transferredBytes === 4 ? 1 : 0, totalFiles: 1,
    });
    update("upload-1", "transferring", 0);
    now += 10; update("upload-1", "transferring", 1);
    now += 10; update("upload-1", "transferring", 2);
    expect(f.progress).toHaveLength(1);
    now += 100; update("upload-1", "transferring", 3);
    expect(f.progress.at(-1)).toMatchObject({ transferredBytes: 3 });
    update("upload-1", "transferring", 1); expect(f.progress).toHaveLength(2);
    update("upload-1", "completed", 4); update("upload-1", "completed", 4);
    expect(f.progress).toHaveLength(3);
    expect(f.progress.at(-1)).toMatchObject({ id: `${offerId}:upload-1`, direction: "send", phase: "completed", transferredBytes: 4, completedFiles: 1 });
    update("upload-2", "transferring", 0); const count = f.progress.length;
    update("upload-1", "transferring", 0); update("upload-1", "failed", 4);
    expect(f.progress).toHaveLength(count);
    expect(f.progress.at(-1)?.id).toBe(`${offerId}:upload-2`);
    f.transfer.cancel(); f.transfer.cancel();
    expect(f.progress.filter(({ id, phase }) => id === `${offerId}:upload-2` && phase === "canceled")).toHaveLength(1);
  });

  it("ignores upload progress with an obsolete offer, mismatched totals, or no matching transfer", () => {
    const f = fixture(); f.transfer.offer(localFiles());
    const offerId = f.sent.find((command) => command.type === "clipboardFilesOffer")!.offerId!;
    const update = { type: "clipboardFileUploadProgress" as const, offerId, transferId: "upload-1", phase: "transferring" as const, transferredBytes: 0, totalBytes: 4, completedFiles: 0, totalFiles: 1 };
    f.transfer.receive({ ...update, offerId: "old-offer" });
    f.transfer.receive({ ...update, totalBytes: 5 });
    f.transfer.receive({ ...update, totalFiles: 2 });
    f.transfer.receive({ ...update, phase: "completed", transferredBytes: 4, completedFiles: 1 });
    expect(f.progress).toEqual([]);
    f.transfer.receive(update);
    const initial = f.progress.length;
    f.transfer.receive({ ...update, phase: "completed", transferredBytes: 2 });
    f.transfer.receive({ ...update, transferredBytes: 5 });
    expect(f.progress).toHaveLength(initial);
    f.transfer.offer(localFiles());
    const count = f.progress.length;
    f.transfer.receive({ ...update, phase: "completed", transferredBytes: 4, completedFiles: 1 });
    expect(f.progress).toHaveLength(count);
  });
});
