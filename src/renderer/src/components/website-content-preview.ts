import { WEBSITE_LIMITS, isWebsiteTextContentType, type WebsiteContentDetail } from "../../../shared/website-contracts";

export const WEBSITE_SOURCE_DISPLAY_BYTES = 64 * 1024;

interface WebsitePreview {
  readonly mode: "source" | "hex" | "empty" | "too-large" | "unavailable";
  readonly text: string;
  readonly shownBytes: number;
  readonly truncated: boolean;
}

/** Decode only complete content, so saving an editor cannot replace a file with a preview prefix. */
export function decodeWebsiteEditableText(content: WebsiteContentDetail): string | null {
  if (!isWebsiteTextContentType(content.item.contentType) || content.truncated || content.preview.byteLength > WEBSITE_LIMITS.previewBytes ||
      content.item.sizeBytes !== String(content.preview.byteLength)) return null;
  if (content.previewState === "empty" && content.preview.byteLength === 0) return "";
  if (content.previewState !== "text") return null;
  try {
    // Preserve a BOM for editing; removing it would change otherwise untouched content.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content.preview);
  } catch {
    return null;
  }
}

/** Untrusted bytes become display strings only. MIME types never select an HTML/media parser. */
export function createWebsiteContentPreview(content: WebsiteContentDetail): WebsitePreview {
  if (content.previewState === "unavailable" || content.previewState === "too-large") {
    return { mode: content.previewState, text: "", shownBytes: 0, truncated: false };
  }
  if (content.preview.byteLength === 0) {
    const empty = content.previewState === "empty" && content.item.sizeBytes === "0";
    return { mode: empty ? "empty" : "unavailable", text: "", shownBytes: 0, truncated: false };
  }
  if (content.previewState === "text") {
    const bytes = content.preview.subarray(0, WEBSITE_SOURCE_DISPLAY_BYTES);
    const truncated = content.truncated || content.preview.byteLength > bytes.byteLength;
    try {
      // A bounded prefix can end halfway through a UTF-8 character. Streaming omits that
      // incomplete character; malformed bytes within the prefix still fail closed to hex.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, { stream: truncated });
      return { mode: "source", text: escapeInvisibleControls(text), shownBytes: bytes.byteLength, truncated };
    } catch {
      // Text labels and remote MIME metadata are advisory, never a reason to decode lossily.
    }
  }
  const bytes = content.preview.subarray(0, WEBSITE_LIMITS.binaryPreviewBytes);
  return {
    mode: "hex",
    text: formatHex(bytes),
    shownBytes: bytes.byteLength,
    truncated: content.truncated || content.preview.byteLength > bytes.byteLength,
  };
}

function escapeInvisibleControls(text: string): string {
  // Expose terminal escapes, bidi overrides and invisible formatting controls as source
  // escapes. These replacements are only for preview; the editor retains original bytes.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu,
    (value) => `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function formatHex(bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(row, (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return rows.join("\n");
}
