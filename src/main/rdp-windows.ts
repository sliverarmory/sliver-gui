import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { BrowserWindow, clipboard, ipcMain, nativeTheme, type IpcMainEvent, type IpcMainInvokeEvent, type MessagePortMain } from "electron";
import { parseApplicationSettingsUpdateInput, type ApplicationSettingsState, type ApplicationSettingsUpdateInput } from "../shared/application-settings-contracts.js";
import type { OperationResult } from "../shared/contracts.js";
import { RDP_IPC, RDP_MAX_CLIPBOARD_BYTES, RDP_MAX_CONTROL_BYTES, RDP_MAX_DISPLAY_CREDIT_BYTES, RDP_MAX_SESSIONS, type RdpAttachment, type RdpConnectInput, type RdpCursor, type RdpCursorDelivery, type RdpTab, type RdpWindowState } from "../shared/rdp-contracts.js";
import { parseRdpConnect, parseRdpOptions, parseRdpProfile, parseRdpSavePreview, parseRdpViewerMessage, rdpBoolean, rdpPassword, rdpRecord, rdpString } from "../shared/rdp-validation.js";
import { normalizeRdpPreview } from "./rdp-preview.js";
import { RdpRuntime, type RdpRuntimeEvent } from "./rdp-runtime.js";
import { RdpStore } from "./rdp-store.js";
import { isSameRendererDocument } from "./security.js";
import { rdpWindowOptions } from "./window-options.js";

interface RdpWindowsOptions {
  rendererUrl: string;
  preloadPath: string;
  icon?: string;
  store: RdpStore;
  resolveRuntime: () => Promise<string>;
  getApplicationSettings: () => ApplicationSettingsState;
  updateApplicationSettings: (input: ApplicationSettingsUpdateInput) => Promise<OperationResult<ApplicationSettingsState>>;
  prepareWindow: (window: BrowserWindow) => void;
  isQuitting?: () => boolean;
}
interface Session {
  tab: RdpTab;
  runtime?: RdpRuntime;
  port?: MessagePortMain;
  captured: boolean;
  outstanding: Map<number, number>;
  displayBytes: number;
  lastSeq: number;
  cursor: { shape?: RdpCursor; position?: RdpCursor; shapeDirty: boolean; positionDirty: boolean; sequence: number;
    outstanding?: number; lastKind?: "shape" | "position" };
  reconnectSize?: { width: number; height: number };
  lastResize?: { width: number; height: number; scaleFactor: number };
  clipboardSync: { generation: number; remoteRevision: number; receivedRevision: number; localSignature?: string; busy: boolean; draining?: boolean };
  pendingClipboard?: { attempt: number; expires: number; timer: ReturnType<typeof setTimeout>; resolve: () => void; reject: (error: Error) => void;
    automatic: boolean; localSignature?: string; remoteRevision: number; receiving?: boolean };
  certificate?: { requestId: string; fingerprint: string; timer: ReturnType<typeof setTimeout> };
  connectTimer?: ReturnType<typeof setTimeout>;
}
interface AttachmentTicket extends RdpAttachment { expires: number; frameToken: string; contentsId: number }
const channels = Object.values(RDP_IPC).filter((channel) => channel !== RDP_IPC.stateChanged && channel !== RDP_IPC.applicationSettingsChanged && channel !== RDP_IPC.openStream);
const overridableCertificateReasons = new Set(["unknownIssuer", "expired", "notValidYet", "nameMismatch", "pinMismatch"]);
const certificateReasons: Record<string, string> = {
  unknownIssuer: "The server certificate is self-signed or its issuer is not trusted.",
  expired: "The server certificate has expired.", notValidYet: "The server certificate is not yet valid.",
  nameMismatch: "The certificate name does not match the requested host.",
  pinMismatch: "The server certificate has changed since it was trusted.",
  hardFailure: "The server certificate failed cryptographic validation and cannot be accepted.",
};
const clipboardErrors: Record<string, string> = {
  "clipboard-unavailable": "The remote clipboard changed or its text is no longer available. Copy the remote text again, then retry Receive.",
  "clipboard-invalid": "The remote clipboard did not return valid Unicode text. Copy the remote text again, then retry Receive.",
  "clipboard-too-large": "The remote clipboard text exceeds the 1 MiB limit. Copy a smaller selection, then retry Receive.",
};
function token(): string { return randomBytes(32).toString("base64url"); }
function clipboardSignature(text: string): string { return createHash("sha256").update(text).digest("base64"); }

/** Standalone sessions are owned by main, independent of operator connections. */
export class RdpWindows {
  readonly #options: RdpWindowsOptions;
  readonly #sessions = new Map<string, Session>();
  readonly #tickets = new Map<string, AttachmentTicket>();
  #window: BrowserWindow | undefined;
  #activeTabId: string | undefined;
  #disposed = false;
  #connectBusy = false;
  #clipboardTimer: ReturnType<typeof setInterval> | undefined;
  readonly #streamListener = (event: IpcMainEvent, raw: unknown): void => {
    try { this.#openStream(event, raw); } catch { for (const port of event.ports) port.close(); }
  };

  constructor(options: RdpWindowsOptions) {
    this.#options = options;
    for (const channel of channels) ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        this.#requireSender(event);
        if (channel === RDP_IPC.getApplicationSettings) {
          if (args.length) throw new Error("Invalid RDP request");
          return options.getApplicationSettings();
        }
        if (channel === RDP_IPC.updateApplicationSettings) {
          if (args.length !== 1) throw new Error("Invalid RDP request");
          return await options.updateApplicationSettings(parseApplicationSettingsUpdateInput(args[0]));
        }
        const value = await this.#invoke(channel, event, args);
        return value === undefined ? { ok: true } : { ok: true, value };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "RDP operation failed" };
      }
    });
    ipcMain.on(RDP_IPC.openStream, this.#streamListener);
  }

  async open(): Promise<void> {
    if (this.#disposed) throw new Error("RDP is shutting down");
    if (this.#window && !this.#window.isDestroyed()) { this.#window.show(); this.#window.focus(); return; }
    const window = new BrowserWindow(rdpWindowOptions(this.#options.preloadPath, process.platform, this.#options.icon, nativeTheme.shouldUseDarkColors));
    this.#window = window;
    this.#options.prepareWindow(window);
    window.on("blur", () => this.#releaseInputs());
    window.on("minimize", () => this.#releaseInputs());
    window.on("close", (event) => {
      if (this.#disposed || this.#options.isQuitting?.() || ![...this.#sessions.values()].some((session) => session.runtime)) return;
      // Preserve explicit disconnect semantics and make sessions reachable from File > RDP.
      event.preventDefault(); this.#detachAll(); window.hide();
    });
    window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (!isInPlace && isMainFrame) this.#detachAll();
    });
    window.webContents.on("render-process-gone", () => this.#detachAll());
    window.webContents.on("before-input-event", (_event, input) => {
      // Always leave an escape route and let the renderer release remote modifiers.
      const escapeCapture = input.control && input.alt && input.key === "Escape";
      if (escapeCapture) this.#releaseInputs();
      window.webContents.setIgnoreMenuShortcuts(!escapeCapture && [...this.#sessions.values()].some((session) => session.captured));
    });
    window.once("closed", () => { this.#detachAll(); if (this.#window === window) this.#window = undefined; });
    window.once("ready-to-show", () => window.show());
    try { await window.loadURL(this.#options.rendererUrl); } catch (error) { window.destroy(); throw error; }
  }

  restoreRetainedWindow(): boolean {
    const window = this.#window;
    if (this.#disposed || !window || window.isDestroyed() || window.isVisible()) return false;
    window.show(); window.focus(); return true;
  }

  state(): RdpWindowState {
    return { tabs: [...this.#sessions.values()].map((session) => session.tab), profiles: this.#options.store.profiles(),
      ...(this.#activeTabId === undefined ? {} : { activeTabId: this.#activeTabId }),
      maxSessions: RDP_MAX_SESSIONS, securePersistenceAvailable: this.#options.store.securePersistenceAvailable() };
  }

  async #invoke(channel: string, event: IpcMainInvokeEvent, args: unknown[]): Promise<unknown> {
    const noArgs = channel === RDP_IPC.getState || channel === RDP_IPC.toggleFullscreen;
    if (args.length !== (noArgs ? 0 : 1)) throw new Error("Invalid RDP request");
    const raw = args[0];
    switch (channel) {
      case RDP_IPC.getState: return this.state();
      case RDP_IPC.connect: return this.#connect(parseRdpConnect(raw), event);
      case RDP_IPC.reconnect: {
        const input = rdpRecord(raw), session = this.#session(input["tabId"]);
        if (session.runtime) throw new Error("Disconnect this RDP session before reconnecting");
        const password = input["password"] === undefined ? undefined : rdpPassword(input["password"]);
        return this.#start(session, password, event);
      }
      case RDP_IPC.disconnect: this.#disconnect(this.#session(raw)); return undefined;
      case RDP_IPC.closeTab: {
        const session = this.#session(raw); this.#disconnect(session); this.#sessions.delete(session.tab.id);
        this.#options.store.forgetSessionCredential(session.tab.id);
        if (this.#activeTabId === session.tab.id) this.#activeTabId = this.#sessions.keys().next().value;
        this.#publish(); return undefined;
      }
      case RDP_IPC.selectTab: {
        const session = this.#session(raw); this.#releaseInputs(); this.#activeTabId = session.tab.id; this.#publish(); return undefined;
      }
      case RDP_IPC.renameTab: {
        const input = rdpRecord(raw), session = this.#session(input["tabId"]);
        session.tab = { ...session.tab, label: rdpString(input["label"], 120) }; this.#publish(); return undefined;
      }
      case RDP_IPC.saveProfile: { const profile = await this.#options.store.saveProfile(parseRdpProfile(raw)); this.#publish(); return profile; }
      case RDP_IPC.savePreview: {
        const input = parseRdpSavePreview(raw), session = this.#session(input.tabId), profileId = session.tab.profileId;
        const requireCurrent = (): void => {
          this.#requireSender(event);
          if (this.#sessions.get(input.tabId) !== session || session.tab.attempt !== input.attempt || session.lastSeq === 0 ||
            !["active", "disconnected", "failed"].includes(session.tab.state)) throw new Error("RDP preview connection changed");
        };
        requireCurrent();
        if (!profileId) throw new Error("Save the RDP connection before its preview");
        await this.#options.store.savePreview(profileId, session.tab, normalizeRdpPreview(input.dataUrl), requireCurrent);
        this.#publish(); return undefined;
      }
      case RDP_IPC.deleteProfile: await this.#options.store.deleteProfile(rdpString(raw, 80)); this.#publish(); return undefined;
      case RDP_IPC.respondToCertificate: return this.#certificateDecision(raw);
      case RDP_IPC.attach: {
        const session = this.#session(raw), attachmentToken = token();
        for (const [key, ticket] of this.#tickets) if (ticket.expires < Date.now() || ticket.tabId === session.tab.id) this.#tickets.delete(key);
        const attachment = { tabId: session.tab.id, attempt: session.tab.attempt, attachmentToken };
        this.#tickets.set(attachmentToken, { ...attachment, expires: Date.now() + 15_000, frameToken: event.sender.mainFrame.frameToken, contentsId: event.sender.id });
        return attachment;
      }
      case RDP_IPC.setInputCapture: {
        const input = rdpRecord(raw), session = this.#session(input["tabId"]), captured = rdpBoolean(input["captured"]);
        if (captured) { this.#requireActive(session); if (!session.port) throw new Error("RDP viewer is not attached"); }
        session.captured = captured;
        if (!captured && session.tab.state === "active") session.runtime?.send({ type: "releaseAll" });
        this.#window?.webContents.setIgnoreMenuShortcuts(captured); return undefined;
      }
      case RDP_IPC.clipboard: {
        const input = rdpRecord(raw), session = this.#session(input["tabId"]);
        this.#requireActive(session);
        if (!session.tab.clipboard || !session.tab.clipboardReady) throw new Error("Clipboard is not available for this connection");
        if (input["direction"] === "send") {
          const attempt = session.tab.attempt;
          const text = await clipboard.readText();
          this.#requireSender(event); this.#requireActive(session);
          if (session.tab.attempt !== attempt) throw new Error("RDP connection changed");
          this.#sendClipboard(session, text);
        } else if (input["direction"] === "receive") {
          if (!session.tab.clipboardAvailable) throw new Error("The remote clipboard does not contain text");
          if (session.pendingClipboard || session.clipboardSync.draining) throw new Error("A clipboard request is already pending");
          await this.#requestClipboard(session, false);
        } else throw new Error("Invalid clipboard direction");
        return undefined;
      }
      case RDP_IPC.toggleFullscreen: {
        const window = this.#requireSender(event); this.#releaseInputs(); window.setFullScreen(!window.isFullScreen()); return undefined;
      }
      default: throw new Error("Unknown RDP operation");
    }
  }

  async #connect(input: RdpConnectInput, event: IpcMainInvokeEvent): Promise<RdpTab> {
    if (this.#connectBusy) throw new Error("An RDP connection is already being prepared");
    if (this.#sessions.size >= RDP_MAX_SESSIONS) throw new Error("Close an RDP tab before opening another connection");
    this.#connectBusy = true;
    try {
      let profileId = input.profileId;
      if (profileId && !this.#options.store.profile(profileId)) throw new Error("RDP profile no longer exists");
      if (input.persistence === "secure" && !profileId) {
        profileId = (await this.#options.store.saveProfile({ ...parseRdpOptions(input), label: input.label, scaleMode: input.scaleMode })).id;
      }
      this.#requireSender(event);
      const id = randomUUID();
      const session: Session = { tab: { ...parseRdpOptions(input), id, attempt: 0, label: input.label, scaleMode: input.scaleMode,
        ...(profileId === undefined ? {} : { profileId }), state: "disconnected", clipboardReady: false, clipboardAvailable: false }, captured: false, outstanding: new Map(), displayBytes: 0, lastSeq: 0,
        cursor: { shapeDirty: false, positionDirty: false, sequence: 0 },
        clipboardSync: { generation: 0, remoteRevision: 0, receivedRevision: 0, busy: false } };
      if (input.password !== undefined) await this.#options.store.saveCredential(profileId ?? id, session.tab, input.password, input.persistence);
      this.#requireSender(event);
      this.#sessions.set(id, session); this.#activeTabId = id;
      const initialAttempt = session.tab.attempt + 1;
      try { return await this.#start(session, input.password, event); }
      catch (error) {
        // Credential lookup may fail before the first attempt increments.
        // Preserve a newer reconnect if its earlier startup completes later.
        if (this.#sessions.get(id) === session && session.tab.attempt <= initialAttempt) {
          this.#sessions.delete(id); this.#options.store.forgetSessionCredential(id);
          if (this.#activeTabId === id) this.#activeTabId = this.#sessions.keys().next().value;
        }
        this.#publish(); throw error;
      }
    } finally { this.#connectBusy = false; }
  }

  async #start(session: Session, suppliedPassword: string | undefined, event: IpcMainInvokeEvent): Promise<RdpTab> {
    if (session.runtime || session.tab.state === "connecting") throw new Error("RDP connection is already starting");
    let password = suppliedPassword ?? this.#options.store.credential(session.tab.profileId ?? session.tab.id, session.tab);
    if (password === undefined) throw new Error("Enter the password to connect");
    this.#detach(session);
    session.lastSeq = 0;
    delete session.lastResize;
    session.cursor = { shapeDirty: false, positionDirty: false, sequence: 0 };
    session.clipboardSync = { generation: session.clipboardSync.generation + 1, remoteRevision: 0, receivedRevision: 0, busy: false };
    const { review: _review, error: _error, ...previous } = session.tab;
    session.tab = { ...previous, ...session.reconnectSize, attempt: previous.attempt + 1, state: "connecting", clipboardReady: false, clipboardAvailable: false };
    this.#publish();
    const attempt = session.tab.attempt;
    try {
      const executable = await this.#options.resolveRuntime();
      this.#requireSender(event);
      if (this.#disposed || !this.#sessions.has(session.tab.id) || session.tab.attempt !== attempt || session.tab.state !== "connecting") throw new Error("RDP connection was canceled");
      const runtime = new RdpRuntime(executable, (message) => {
        if (session.tab.attempt !== attempt || session.runtime !== runtime) return;
        if (message.type === "ready") {
          const pinnedFingerprint = this.#options.store.pin(session.tab);
          runtime.send({ type: "connect", ...parseRdpOptions(session.tab), password,
            ...(pinnedFingerprint === undefined ? {} : { pinnedFingerprint }) });
          password = undefined;
          return;
        }
        this.#receive(session, message);
      }, (code) => {
        password = undefined;
        if (session.tab.attempt !== attempt || session.runtime !== runtime) return;
        delete session.runtime;
        this.#finish(session, code);
      });
      session.runtime = runtime;
      session.connectTimer = setTimeout(() => {
        if (session.tab.state === "active" || session.tab.attempt !== attempt) return;
        this.#disconnect(session, "Connection timed out");
      }, 90_000);
      session.connectTimer.unref();
      return session.tab;
    } catch (error) {
      password = undefined;
      if (session.tab.attempt === attempt && session.tab.state === "connecting") {
        session.tab = { ...session.tab, state: "failed", error: "RDP runtime could not start" }; this.#publish();
      }
      throw error;
    }
  }

  #receive(session: Session, message: RdpRuntimeEvent): void {
    switch (message.type) {
      case "frame": {
        if (message.seq <= session.lastSeq) throw new Error("RDP frame sequence repeated");
        session.lastSeq = message.seq;
        if (!session.port) { session.runtime?.send({ type: "ack", seq: message.seq }); return; }
        session.displayBytes += message.data.byteLength;
        if (session.displayBytes > RDP_MAX_DISPLAY_CREDIT_BYTES) throw new Error("RDP display credit exceeded");
        session.outstanding.set(message.seq, message.data.byteLength);
        session.port.postMessage(message); return;
      }
      case "cursor": {
        if (message.kind === "position") { session.cursor.position = message; session.cursor.positionDirty = true; }
        else { session.cursor.shape = message; session.cursor.shapeDirty = true; }
        this.#flushCursor(session); return;
      }
      case "state":
        if (message.state === "failed") { this.#disconnect(session, runtimeError(message.code ?? "session-failed")); return; }
        if (message.state === "disconnected") { this.#disconnect(session); return; }
        if (session.tab.state === message.state) return;
        session.tab = { ...session.tab, state: message.state };
        if (message.state === "active") { clearTimeout(session.connectTimer); session.runtime?.send({ type: "snapshot" }); }
        this.#publish(); return;
      case "certificate": {
        if (!message.requestId) throw new Error("Missing certificate challenge identity");
        const certificate = new X509Certificate(Buffer.from(message.certificateDer, "base64"));
        const fingerprint = certificate.fingerprint256.replaceAll(":", "").toLowerCase();
        if (fingerprint !== message.fingerprint) throw new Error("Certificate fingerprint mismatch");
        const canOverride = message.canOverride && overridableCertificateReasons.has(message.validationKind);
        clearTimeout(session.certificate?.timer);
        const timer = setTimeout(() => this.#disconnect(session, "Certificate approval expired"), 60_000); timer.unref();
        session.certificate = { requestId: message.requestId, fingerprint, timer };
        session.tab = { ...session.tab, state: "certificate-review", review: { token: token(), host: session.tab.host, port: session.tab.port,
          fingerprint, subject: certificate.subject, issuer: certificate.issuer, validFrom: certificate.validFrom, validTo: certificate.validTo,
          reason: certificateReasons[message.validationKind] ?? "The server certificate could not be verified.", canOverride, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
        this.#publish(); return;
      }
      case "peerCertificate": return;
      case "clipboardReady":
        if (session.tab.clipboardReady) return;
        session.tab = { ...session.tab, clipboardReady: true }; this.#publish(); return;
      case "resizeFallback": {
        const size = session.reconnectSize;
        this.#disconnect(session, size
          ? `This server could not resize the desktop. Reconnect to apply the requested ${size.width}×${size.height} desktop size.`
          : "This server could not resize the desktop. Reconnect to try again.");
        return;
      }
      case "clipboardAvailable":
        if (message.available) session.clipboardSync.remoteRevision++;
        if (session.tab.clipboardAvailable === message.available) return;
        session.tab = { ...session.tab, clipboardAvailable: message.available }; this.#publish(); return;
      case "clipboard": {
        if (session.clipboardSync.draining) { delete session.clipboardSync.draining; return; }
        const request = session.pendingClipboard;
        if (!request || request.receiving) return;
        request.receiving = true;
        void this.#writeClipboard(session, request, message.text);
        return;
      }
      case "error": {
        const reason = Object.hasOwn(clipboardErrors, message.code) ? clipboardErrors[message.code] : undefined;
        if (reason !== undefined) {
          if (session.pendingClipboard) session.pendingClipboard.receiving = true;
          delete session.clipboardSync.draining;
          this.#cancelClipboard(session, reason);
          if (session.tab.clipboardAvailable) { session.tab = { ...session.tab, clipboardAvailable: false }; this.#publish(); }
          return;
        }
        this.#disconnect(session, runtimeError(message.code)); return;
      }
      case "terminated": this.#disconnect(session, message.code === "disconnected" ? undefined : runtimeError(message.code)); return;
      case "ready": return;
    }
  }

  async #certificateDecision(raw: unknown): Promise<void> {
    const input = rdpRecord(raw), reviewToken = rdpString(input["token"], 64), decision = input["decision"];
    if (decision !== "reject" && decision !== "once" && decision !== "pin") throw new Error("Invalid certificate decision");
    const session = [...this.#sessions.values()].find((item) => item.tab.review?.token === reviewToken);
    const review = session?.tab.review, challenge = session?.certificate;
    if (!session || !review || !challenge || !session.runtime || Date.parse(review.expiresAt) < Date.now()) throw new Error("Certificate approval expired");
    if (decision !== "reject" && !review.canOverride) throw new Error("This certificate cannot be accepted");
    clearTimeout(challenge.timer); delete session.certificate;
    const { review: _review, ...tab } = session.tab;
    session.tab = { ...tab, state: decision === "reject" ? "disconnected" : "authenticating" };
    if (decision === "pin") {
      try { await this.#options.store.savePin(session.tab, challenge.fingerprint); }
      catch { this.#disconnect(session, "The certificate pin could not be saved"); throw new Error("The certificate pin could not be saved. Reconnect and review the certificate again."); }
    }
    // Consume the review once, then recheck the exact connection attempt after persistence.
    if (session.tab.attempt !== tab.attempt || !session.runtime || this.#disposed) throw new Error("Certificate approval expired");
    session.runtime.send({ type: "trustDecision", requestId: challenge.requestId, accept: decision !== "reject" });
    if (decision === "reject") this.#disconnect(session);
    this.#publish();
  }

  #openStream(event: IpcMainEvent, raw: unknown): void {
    this.#requireSender(event);
    const input = rdpRecord(raw), attachmentToken = rdpString(input["attachmentToken"], 64), ticket = this.#tickets.get(attachmentToken);
    this.#tickets.delete(attachmentToken);
    if (event.ports.length !== 1 || !ticket || ticket.expires < Date.now() || ticket.contentsId !== event.sender.id || ticket.frameToken !== event.sender.mainFrame.frameToken) throw new Error("RDP attachment expired");
    const session = this.#session(ticket.tabId);
    if (session.tab.attempt !== ticket.attempt) throw new Error("RDP connection changed");
    this.#detach(session);
    const port = event.ports[0]!;
    session.port = port;
    port.on("message", ({ data }: { data: unknown }) => {
      if (session.port !== port || session.tab.attempt !== ticket.attempt) return;
      try {
        const message = parseRdpViewerMessage(data);
        if (message.type === "ack") {
          const bytes = session.outstanding.get(message.seq);
          if (bytes === undefined) throw new Error("Invalid RDP frame acknowledgment");
          session.outstanding.delete(message.seq); session.displayBytes -= bytes;
          session.runtime?.send(message); return;
        }
        if (message.type === "cursorAck") {
          if (session.cursor.outstanding !== message.seq) throw new Error("Invalid RDP cursor acknowledgment");
          delete session.cursor.outstanding;
          this.#flushCursor(session); return;
        }
        if (message.type === "releaseAll") { session.captured = false; if (session.tab.state === "active") session.runtime?.send(message); return; }
        if (message.type === "input") { this.#requireActive(session); if (!session.captured) return; }
        if (message.type === "resize") {
          this.#requireActive(session);
          session.reconnectSize = { width: message.width, height: message.height };
          const previous = session.lastResize;
          if (previous?.width === message.width && previous.height === message.height && previous.scaleFactor === message.scaleFactor) return;
          // Viewer reattachment and session state updates must not replay a resize.
          // A new explicit connection attempt resets this request history.
          session.lastResize = { width: message.width, height: message.height, scaleFactor: message.scaleFactor };
        }
        session.runtime?.send(message);
      } catch { this.#detach(session); }
    });
    port.on("close", () => { if (session.port === port) this.#detach(session); });
    port.start(); port.postMessage({ type: "ready", protocol: 1 });
    this.#flushCursor(session);
    session.runtime?.send({ type: "snapshot" });
    if (!this.#clipboardTimer) {
      this.#clipboardTimer = setInterval(() => this.#pollClipboard(), 500);
      this.#clipboardTimer.unref();
    }
  }

  #flushCursor(session: Session): void {
    const cursor = session.cursor;
    if (!session.port || cursor.outstanding !== undefined) return;
    // Retain one latest shape and one latest position; alternate under sustained
    // changes so neither component starves behind the single delivery credit.
    const kind = cursor.positionDirty && (!cursor.shapeDirty || cursor.lastKind === "shape") ? "position" : "shape";
    if (!(kind === "shape" ? cursor.shapeDirty : cursor.positionDirty)) return;
    const message = cursor[kind];
    if (!message) return;
    if (cursor.sequence === Number.MAX_SAFE_INTEGER) throw new Error("RDP cursor sequence exhausted");
    cursor.outstanding = ++cursor.sequence;
    cursor.lastKind = kind;
    if (kind === "shape") cursor.shapeDirty = false; else cursor.positionDirty = false;
    session.port.postMessage({ ...message, seq: cursor.sequence } satisfies RdpCursorDelivery);
  }

  #session(raw: unknown): Session {
    const session = this.#sessions.get(rdpString(raw, 80));
    if (!session) throw new Error("RDP session no longer exists");
    return session;
  }
  #requireSender(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow {
    const window = this.#window, frame = event.senderFrame, sender = event.sender;
    if (this.#disposed || !window || window.isDestroyed() || sender.isDestroyed() || window.webContents !== sender ||
      !frame || frame.isDestroyed() || sender.mainFrame.isDestroyed() || frame.processId !== sender.mainFrame.processId ||
      frame.frameToken !== sender.mainFrame.frameToken || !isSameRendererDocument(sender.getURL(), this.#options.rendererUrl) ||
      !isSameRendererDocument(frame.url, this.#options.rendererUrl)) throw new Error("RDP request was rejected");
    return window;
  }
  #requireActive(session: Session): void {
    if (!this.#window?.isFocused() || !this.#window.isVisible() || this.#activeTabId !== session.tab.id || session.tab.state !== "active") throw new Error("Focus the active RDP tab first");
  }
  #releaseInputs(): void {
    for (const session of this.#sessions.values()) { session.captured = false; session.clipboardSync.generation++; this.#cancelClipboard(session); if (session.tab.state === "active") session.runtime?.send({ type: "releaseAll" }); }
    if (this.#window && !this.#window.isDestroyed()) this.#window.webContents.setIgnoreMenuShortcuts(false);
  }
  #detach(session: Session): void {
    session.captured = false; session.clipboardSync.generation++; this.#cancelClipboard(session);
    if (this.#activeTabId === session.tab.id && this.#window && !this.#window.isDestroyed()) this.#window.webContents.setIgnoreMenuShortcuts(false);
    const port = session.port; delete session.port;
    if (![...this.#sessions.values()].some((item) => item.port)) { clearInterval(this.#clipboardTimer); this.#clipboardTimer = undefined; }
    delete session.cursor.outstanding; delete session.cursor.lastKind;
    session.cursor.shapeDirty = session.cursor.shape !== undefined;
    session.cursor.positionDirty = session.cursor.position !== undefined;
    if (port) { try { port.postMessage({ type: "closed", reason: "detached" }); port.close(); } catch { /* Already closed. */ } }
    for (const seq of session.outstanding.keys()) session.runtime?.send({ type: "ack", seq });
    session.outstanding.clear(); session.displayBytes = 0;
    if (session.tab.state === "active") session.runtime?.send({ type: "releaseAll" });
    for (const [key, ticket] of this.#tickets) if (ticket.tabId === session.tab.id) this.#tickets.delete(key);
  }
  #detachAll(): void {
    this.#releaseInputs(); this.#tickets.clear();
    for (const session of this.#sessions.values()) {
      this.#detach(session);
      if (session.certificate) this.#disconnect(session, "Certificate approval canceled when the viewer closed");
    }
  }
  #disconnect(session: Session, error?: string): void {
    this.#detach(session);
    const runtime = session.runtime; delete session.runtime; runtime?.stop();
    this.#finish(session, error ?? "disconnected");
  }
  #finish(session: Session, code: string): void {
    clearTimeout(session.connectTimer); delete session.connectTimer;
    clearTimeout(session.certificate?.timer); delete session.certificate;
    this.#detach(session);
    delete session.clipboardSync.localSignature;
    const { review: _review, error: _error, ...tab } = session.tab;
    session.tab = { ...tab, state: code === "disconnected" ? "disconnected" : "failed", clipboardReady: false, clipboardAvailable: false,
      ...(code === "disconnected" ? {} : { error: code.startsWith("runtime-") ? runtimeError(code) : code }) };
    this.#publish();
  }
  #publish(): void {
    const window = this.#window;
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(RDP_IPC.stateChanged, this.state());
  }
  #cancelClipboard(session: Session, reason = "Clipboard request canceled when focus changed"): void {
    const request = session.pendingClipboard; delete session.pendingClipboard;
    if (request) {
      if (!request.receiving) {
        // CLIPRDR has no request IDs. Drain the old reply before allowing another
        // request, and retain the remote offer for when this tab is focused again.
        session.clipboardSync.draining = true;
      }
      if (request.automatic) {
        session.clipboardSync.receivedRevision = Math.min(session.clipboardSync.receivedRevision, request.remoteRevision - 1);
      }
      clearTimeout(request.timer); request.reject(new Error(reason));
    }
  }

  #canSyncClipboard(session: Session): boolean {
    const window = this.#window;
    return !this.#disposed && this.#options.getApplicationSettings().rdp.transparentClipboard &&
      !!window && !window.isDestroyed() && !window.webContents.isDestroyed() && window.isFocused() && window.isVisible() &&
      isSameRendererDocument(window.webContents.getURL(), this.#options.rendererUrl) &&
      this.#sessions.get(session.tab.id) === session && this.#activeTabId === session.tab.id &&
      session.tab.state === "active" && session.tab.clipboard && session.tab.clipboardReady && !!session.runtime && !!session.port;
  }

  #pollClipboard(): void {
    for (const session of this.#sessions.values()) {
      if (!this.#canSyncClipboard(session)) {
        if (session.pendingClipboard?.automatic) this.#cancelClipboard(session);
        if (!this.#options.getApplicationSettings().rdp.transparentClipboard) delete session.clipboardSync.localSignature;
        continue;
      }
      if (!session.clipboardSync.busy && !session.pendingClipboard) void this.#syncClipboard(session);
    }
  }

  async #syncClipboard(session: Session): Promise<void> {
    const sync = session.clipboardSync, generation = sync.generation;
    sync.busy = true;
    try {
      const text = await clipboard.readText();
      if (!this.#canSyncClipboard(session) || sync !== session.clipboardSync || generation !== sync.generation || session.pendingClipboard) return;
      const signature = clipboardSignature(text), changed = signature !== sync.localSignature;
      const hadLocal = sync.localSignature !== undefined;
      // Remember unsupported local text too, so it cannot starve a fresh remote
      // copy. Keep only a digest rather than retaining system clipboard content.
      sync.localSignature = signature;
      // A local copy since the last transfer takes precedence over an older
      // remote offer, including when returning from another application.
      if (hadLocal && changed) this.#sendClipboard(session, text);
      else if (!sync.draining && session.tab.clipboardAvailable && sync.receivedRevision !== sync.remoteRevision) {
        sync.receivedRevision = sync.remoteRevision;
        await this.#requestClipboard(session, true, signature);
      } else if (changed) this.#sendClipboard(session, text);
    } catch { /* A fresh clipboard change or explicit action can retry the transfer. */ }
    finally { sync.busy = false; }
  }

  #sendClipboard(session: Session, text: string): void {
    if (Buffer.byteLength(text) > RDP_MAX_CLIPBOARD_BYTES) throw new Error("Clipboard text exceeds 1 MiB");
    if (text.includes("\0")) throw new Error("Clipboard text contains an unsupported NUL character");
    const command = { type: "clipboardSend", text };
    if (Buffer.byteLength(JSON.stringify(command)) + 1 > RDP_MAX_CONTROL_BYTES) throw new Error("Encoded clipboard text exceeds the transfer limit");
    this.#cancelClipboard(session, "The remote clipboard request was canceled because local text was sent.");
    delete session.clipboardSync.draining;
    // Local copy takes ownership until another remote format announcement.
    if (session.tab.clipboardAvailable) { session.tab = { ...session.tab, clipboardAvailable: false }; this.#publish(); }
    session.clipboardSync.localSignature = clipboardSignature(text);
    session.clipboardSync.generation++;
    session.runtime?.send(command);
  }

  #requestClipboard(session: Session, automatic: boolean, localSignature?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.#cancelClipboard(session, "The remote clipboard request timed out"), 10_000); timer.unref();
      session.pendingClipboard = { attempt: session.tab.attempt, expires: Date.now() + 10_000, timer, resolve, reject,
        automatic, remoteRevision: session.clipboardSync.remoteRevision, ...(localSignature === undefined ? {} : { localSignature }) };
      session.runtime?.send({ type: "clipboardRequest" });
    });
  }

  async #writeClipboard(session: Session, request: NonNullable<Session["pendingClipboard"]>, text: string): Promise<void> {
    const sync = session.clipboardSync;
    try {
      if (request.automatic && !this.#canSyncClipboard(session)) throw new Error("Clipboard request expired");
      // Do not overwrite a local copy made while the remote reply was in flight.
      const localChanged = request.automatic && clipboardSignature(await clipboard.readText()) !== request.localSignature;
      if (session.pendingClipboard !== request || request.attempt !== session.tab.attempt || request.expires < Date.now() ||
          !session.tab.clipboard || (request.automatic && !this.#canSyncClipboard(session))) throw new Error("Clipboard request expired");
      this.#requireActive(session);
      if (!localChanged) {
        await clipboard.writeText(text);
        if (request.attempt === session.tab.attempt) {
          session.clipboardSync.localSignature = clipboardSignature(text);
          session.clipboardSync.generation++;
        }
      }
      if (request.attempt === session.tab.attempt) sync.receivedRevision = Math.max(sync.receivedRevision, request.remoteRevision);
      request.resolve();
    } catch {
      if (request.automatic && sync === session.clipboardSync) sync.receivedRevision = Math.min(sync.receivedRevision, request.remoteRevision - 1);
      request.reject(new Error("The system clipboard could not be updated"));
    }
    finally {
      clearTimeout(request.timer);
      if (session.pendingClipboard === request) delete session.pendingClipboard;
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.removeListener(RDP_IPC.openStream, this.#streamListener);
    for (const session of this.#sessions.values()) this.#disconnect(session);
    this.#sessions.clear(); this.#options.store.dispose();
    if (this.#window && !this.#window.isDestroyed()) this.#window.destroy();
  }
}

function runtimeError(code: string): string {
  const messages: Record<string, string> = {
    "authentication-failed": "Authentication failed. Check the account and password before trying again.",
    "authentication-error": "Network Level Authentication could not complete. Check the account, domain, and server authentication policy.",
    "access-denied": "The server denied this account Remote Desktop access.",
    "nla-required": "This server did not negotiate required Network Level Authentication.",
    "security-negotiation-failed": "The server and client could not negotiate compatible RDP security settings.",
    "connection-failed": "RDP connection failed. Check the destination, certificate, and credentials.",
    "connection-refused": "The destination refused the RDP connection. Check the hostname, port, and Remote Desktop service.",
    "connection-timeout": "The RDP connection timed out. Check network reachability and the destination port.",
    "connection-denied": "The operating system denied the RDP network connection.",
    "transport-failed": "The RDP network transport failed. Check connectivity before reconnecting.",
    "session-failed": "The RDP session ended unexpectedly.",
    "session-closed": "The remote RDP session closed while processing an action.",
    "closed": "The RDP runtime closed the connection.",
    "remote-disconnect": "The remote server disconnected the RDP session.",
    "display-limit": "The remote desktop exceeds the supported display dimensions or pixel limit.",
    "invalid-config": "The RDP runtime rejected the connection configuration.",
    "invalid-connect": "The RDP runtime rejected the connection parameters.",
    "invalid-command": "The RDP runtime rejected an invalid command.",
    "invalid-command-state": "The RDP runtime could not apply an action in the current session state.",
    "not-connected": "The RDP runtime received an action before connecting.",
    "not-active": "The RDP runtime received an action before the desktop became active.",
    "invalid-key": "The RDP runtime rejected an invalid keyboard scan code.",
    "invalid-unicode": "The RDP runtime rejected invalid Unicode input.",
    "invalid-pointer": "The RDP runtime rejected invalid pointer coordinates.",
    "missing-button-state": "The RDP runtime rejected an incomplete pointer button event.",
    "input-backpressure": "The remote session stopped accepting input. Reconnect to recover.",
    "runtime-unavailable": "The bundled RDP runtime is unavailable. Rebuild or reinstall the application.",
    "runtime-protocol-error": "The RDP runtime sent an invalid protocol message. Reconnect or reinstall the application if this repeats.",
    "runtime-pipe-closed": "Communication with the RDP runtime closed unexpectedly.",
    "runtime-truncated": "The RDP runtime stopped in the middle of a protocol message.",
    "runtime-input-limit": "The RDP runtime input queue exceeded its limit. Reconnect to recover.",
    "runtime-exited": "The RDP runtime exited unexpectedly. Reconnect to recover.",
  };
  return Object.hasOwn(messages, code) ? messages[code]! : "The RDP connection ended. Reconnect explicitly to try again.";
}
