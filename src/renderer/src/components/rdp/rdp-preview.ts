import {
  RDP_PREVIEW_MAX_DATA_URL_LENGTH,
  RDP_PREVIEW_MAX_HEIGHT,
  RDP_PREVIEW_MAX_WIDTH,
} from "../../../../shared/rdp-contracts";

const SAVE_INTERVAL_MS = 15_000;

/**
 * Keep a small copy of each completed desktop frame. The display canvas can
 * already contain the next batch's unfinished incremental tiles when a timer
 * fires or the viewer closes, so it must never be encoded directly then.
 */
export class RdpPreview {
  readonly #save: (dataUrl: string) => Promise<unknown>;
  #canvas: HTMLCanvasElement | undefined;
  #context: CanvasRenderingContext2D | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #lastSave = -Infinity;
  #dirty = false;
  #saving = false;
  #pendingSave: Promise<void> | undefined;
  #stopped = false;
  #flushPending = false;

  constructor(save: (dataUrl: string) => Promise<unknown>) {
    this.#save = save;
  }

  completedFrame(source: HTMLCanvasElement): void {
    if (this.#stopped || source.width < 1 || source.height < 1) return;
    try {
      const scale = Math.min(1, RDP_PREVIEW_MAX_WIDTH / source.width, RDP_PREVIEW_MAX_HEIGHT / source.height);
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      if (!this.#canvas) {
        this.#canvas = document.createElement("canvas");
        this.#context = this.#canvas.getContext("2d", { alpha: false }) ?? undefined;
      }
      if (!this.#context) return;
      if (this.#canvas.width !== width) this.#canvas.width = width;
      if (this.#canvas.height !== height) this.#canvas.height = height;
      this.#context.drawImage(source, 0, 0, width, height);
      this.#dirty = true;
      this.#schedule();
    } catch {
      // A thumbnail failure must not detach the viewer or interrupt its ACKs.
    }
  }

  flush(): Promise<void> {
    this.#flush();
    if (!this.#pendingSave) return Promise.resolve();
    // Closing a desktop should normally wait for its final saved image, but
    // must remain possible if the persistence bridge stops answering.
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1_500);
      const wait = async (): Promise<void> => {
        while (this.#pendingSave) await this.#pendingSave;
      };
      void wait().finally(() => { clearTimeout(timer); resolve(); });
    });
  }

  #flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#dirty || !this.#canvas) return;
    if (this.#saving) {
      this.#flushPending = true;
      return;
    }
    this.#flushPending = false;
    this.#dirty = false;
    this.#lastSave = Date.now();
    let dataUrl: string | undefined;
    try {
      // High-detail desktops can exceed the payload limit at the initial
      // quality. Keep both the dimensions and the encoded IPC payload bounded.
      for (const quality of [0.72, 0.5, 0.3]) {
        const candidate = this.#canvas.toDataURL("image/jpeg", quality);
        if (candidate.startsWith("data:image/jpeg;base64,") && candidate.length <= RDP_PREVIEW_MAX_DATA_URL_LENGTH) {
          dataUrl = candidate;
          break;
        }
      }
    } catch { return; }
    if (!dataUrl) return;
    this.#saving = true;
    try {
      this.#pendingSave = this.#save(dataUrl).catch(() => undefined).then(() => {
        this.#saving = false;
        this.#pendingSave = undefined;
        if (this.#flushPending || this.#stopped) this.#flush();
        else this.#schedule();
      });
    } catch {
      this.#saving = false;
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#flush();
  }

  #schedule(): void {
    if (!this.#dirty || this.#saving || this.#stopped || this.#timer !== undefined) return;
    const delay = Math.max(0, this.#lastSave + SAVE_INTERVAL_MS - Date.now());
    if (delay === 0) this.#flush();
    else this.#timer = setTimeout(() => { this.#timer = undefined; this.#flush(); }, delay);
  }
}
