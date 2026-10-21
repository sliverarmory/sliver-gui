import type { ApplicationSettingsState, ApplicationSettingsUpdateInput } from "./application-settings-contracts.js";
import type { OperationResult } from "./contracts.js";

export const RDP_PROTOCOL_VERSION = 1 as const;
export const RDP_MAX_SESSIONS = 4;
export const RDP_MAX_PAYLOAD_BYTES = 256 * 1024;
export const RDP_MAX_DISPLAY_CREDIT_BYTES = 8 * 1024 * 1024;
export const RDP_MAX_PIXELS = 16_777_216;
export const RDP_MAX_CLIPBOARD_BYTES = 1024 * 1024;
export const RDP_MAX_CLIPBOARD_FILES = 64;
export const RDP_MAX_CLIPBOARD_FILE_BYTES = 256 * 1024 * 1024;
export const RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES = 256 * 1024;
export interface RdpClipboardFile { readonly name: string; readonly size: number }
export interface RdpFileTransferProgress {
  readonly id: string;
  readonly direction: "send" | "receive";
  readonly phase: "preparing" | "transferring" | "completed" | "failed" | "canceled";
  readonly transferredBytes: number;
  readonly totalBytes: number;
  readonly completedFiles: number;
  readonly totalFiles: number;
  readonly error?: string;
}
export interface RdpFileTransferProgressEvent {
  readonly tabId: string;
  readonly attempt: number;
  readonly progress: RdpFileTransferProgress;
}
export const RDP_MAX_CONTROL_BYTES = 2 * 1024 * 1024;
export const RDP_PREVIEW_MAX_WIDTH = 480;
export const RDP_PREVIEW_MAX_HEIGHT = 300;
export const RDP_PREVIEW_MAX_DATA_URL_LENGTH = 128 * 1024;
export const RDP_PORT_MESSAGE = "sliver:rdp:stream";

export const RDP_IPC = Object.freeze({
  getState: "sliver:rdp:state:get",
  stateChanged: "sliver:rdp:state:changed",
  fileTransferProgress: "sliver:rdp:file-transfer:progress",
  connect: "sliver:rdp:connect",
  cancelTemporary: "sliver:rdp:temporary:cancel",
  reconnect: "sliver:rdp:reconnect",
  disconnect: "sliver:rdp:disconnect",
  closeTab: "sliver:rdp:tab:close",
  selectTab: "sliver:rdp:tab:select",
  renameTab: "sliver:rdp:tab:rename",
  saveProfile: "sliver:rdp:profile:save",
  savePreview: "sliver:rdp:preview:save",
  deleteProfile: "sliver:rdp:profile:delete",
  respondToCertificate: "sliver:rdp:certificate:respond",
  attach: "sliver:rdp:attach",
  openStream: "sliver:rdp:stream:open",
  clipboard: "sliver:rdp:clipboard",
  setInputCapture: "sliver:rdp:input:capture",
  toggleFullscreen: "sliver:rdp:fullscreen",
  getApplicationSettings: "sliver:rdp:application-settings:get",
  updateApplicationSettings: "sliver:rdp:application-settings:update",
  applicationSettingsChanged: "sliver:application-settings:changed",
});

export type RdpCredentialPersistence = "none" | "session" | "secure";
export type RdpSessionPhase = "connecting" | "certificate-review" | "authenticating" | "active" | "disconnected" | "failed";
export type RdpScaleMode = "fit" | "actual";

export interface RdpConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly domain: string;
  readonly width: number;
  readonly height: number;
  readonly clipboard: boolean;
}

export interface RdpProfile extends RdpConnectionOptions {
  readonly id: string;
  readonly label: string;
  readonly scaleMode: RdpScaleMode;
  readonly hasCredential: boolean;
  readonly credentialPersistence: RdpCredentialPersistence;
  readonly preview?: RdpPreview;
}

export interface RdpPreview {
  readonly dataUrl: string;
  readonly capturedAt: string;
  readonly width: number;
  readonly height: number;
}

export interface RdpSavePreviewInput {
  readonly tabId: string;
  readonly attempt: number;
  readonly dataUrl: string;
}

export interface RdpConnectInput extends RdpConnectionOptions {
  readonly label: string;
  readonly password?: string;
  readonly persistence: RdpCredentialPersistence;
  readonly profileId?: string;
  readonly temporaryId?: string;
  readonly scaleMode: RdpScaleMode;
}

export interface RdpSaveProfileInput extends RdpConnectionOptions {
  readonly id?: string;
  readonly label: string;
  readonly scaleMode: RdpScaleMode;
}

export interface RdpCertificateReview {
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly subject: string;
  readonly issuer: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly reason: string;
  readonly canOverride: boolean;
  readonly expiresAt: string;
}

export interface RdpTab extends RdpConnectionOptions {
  readonly id: string;
  readonly attempt: number;
  readonly label: string;
  readonly profileId?: string;
  readonly temporary?: boolean;
  readonly scaleMode: RdpScaleMode;
  readonly state: RdpSessionPhase;
  readonly error?: string;
  readonly review?: RdpCertificateReview;
  readonly clipboardReady: boolean;
  readonly clipboardAvailable: boolean;
  readonly clipboardFilesAvailable?: boolean;
  readonly clipboardFilesSupported?: boolean;
  readonly fileTransfer?: RdpFileTransferProgress;
}

export interface RdpPendingConnection {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
}

export interface RdpWindowState {
  readonly tabs: readonly RdpTab[];
  readonly profiles: readonly RdpProfile[];
  readonly activeTabId?: string;
  readonly pendingConnection?: RdpPendingConnection;
  readonly securePersistenceAvailable: boolean;
  readonly maxSessions: number;
}

export interface RdpAttachment {
  readonly tabId: string;
  readonly attempt: number;
  readonly attachmentToken: string;
}

export type RdpInputEvent =
  | { readonly kind: "key"; readonly scanCode: number; readonly extended: boolean; readonly down: boolean }
  | { readonly kind: "unicode"; readonly codePoint: number; readonly down: boolean }
  | { readonly kind: "mouse"; readonly x: number; readonly y: number;
      readonly button?: "left" | "middle" | "right" | "back" | "forward";
      readonly down?: boolean; readonly wheel?: number; readonly horizontal?: boolean };

export type RdpViewerMessage =
  | { readonly type: "ack"; readonly seq: number }
  | { readonly type: "cursorAck"; readonly seq: number }
  | { readonly type: "input"; readonly events: readonly RdpInputEvent[] }
  | { readonly type: "releaseAll" }
  | { readonly type: "resize"; readonly width: number; readonly height: number; readonly scaleFactor: number }
  | { readonly type: "snapshot" };

export interface RdpFrame {
  readonly type: "frame";
  readonly seq: number;
  readonly frameId: number;
  readonly geometry: number;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly full: boolean;
  readonly first: boolean;
  readonly last: boolean;
  readonly data: ArrayBuffer;
}

export interface RdpCursor {
  readonly type: "cursor";
  readonly kind: "default" | "hidden" | "position" | "bitmap";
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly hotspotX?: number;
  readonly hotspotY?: number;
  readonly data?: ArrayBuffer;
}

/** Main assigns a delivery sequence independently of the native frame credit. */
export type RdpCursorDelivery = RdpCursor & { readonly seq: number };

export type RdpHostMessage = RdpFrame | RdpCursorDelivery
  | { readonly type: "ready"; readonly protocol: 1 }
  | { readonly type: "closed"; readonly reason: string };

export interface RdpWindowAPI {
  getState(): Promise<OperationResult<RdpWindowState>>;
  connect(input: RdpConnectInput): Promise<OperationResult<RdpTab>>;
  cancelTemporary(id: string): Promise<OperationResult>;
  reconnect(input: { readonly tabId: string; readonly password?: string }): Promise<OperationResult<RdpTab>>;
  disconnect(tabId: string): Promise<OperationResult>;
  closeTab(tabId: string): Promise<OperationResult>;
  selectTab(tabId: string): Promise<OperationResult>;
  renameTab(input: { readonly tabId: string; readonly label: string }): Promise<OperationResult>;
  saveProfile(input: RdpSaveProfileInput): Promise<OperationResult<RdpProfile>>;
  savePreview(input: RdpSavePreviewInput): Promise<OperationResult>;
  deleteProfile(profileId: string): Promise<OperationResult>;
  respondToCertificate(input: { readonly token: string; readonly decision: "reject" | "once" | "pin" }): Promise<OperationResult>;
  attach(tabId: string): Promise<OperationResult<RdpAttachment>>;
  openRdpStream(attachmentToken: string, correlationId: string): void;
  clipboard(input: { readonly tabId: string; readonly direction: "send" | "receive" }): Promise<OperationResult>;
  setInputCapture(input: { readonly tabId: string; readonly captured: boolean }): Promise<OperationResult>;
  toggleFullscreen(): Promise<OperationResult>;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  updateApplicationSettings(input: ApplicationSettingsUpdateInput): Promise<OperationResult<ApplicationSettingsState>>;
  onStateChanged(listener: (state: RdpWindowState) => void): () => void;
  onFileTransferProgress(listener: (event: RdpFileTransferProgressEvent) => void): () => void;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
}
