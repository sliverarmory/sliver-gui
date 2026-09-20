const EXPORT_EXTENSION = ".js";
const EXPORT_BASENAME_MAX_BYTES = 180;
const EXPORT_STEM_MAX_BYTES = EXPORT_BASENAME_MAX_BYTES - EXPORT_EXTENSION.length;
const UNSAFE_FILENAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff<>:"/\\|?*]/gu;
const WINDOWS_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/iu;

/** Produces a suggested filename only; the native save dialog chooses its directory. */
export function safeScriptExportBasename(name: string): string {
  // Normalize before extracting the leaf so compatibility separators and device
  // names (for example, COM followed by a superscript digit) stay portable.
  const leaf = name.normalize("NFKC").replaceAll("\\", "/").split("/").at(-1) ?? "";
  const withoutDrive = leaf.replace(/^[a-z]:/iu, "");
  const stem = trimFilenameEdges(withoutDrive.replace(/[. ]+$/gu, "").replace(/\.js$/iu, ""));
  const meaningful = trimFilenameEdges(stem.replace(UNSAFE_FILENAME_CHARACTERS, ""));
  let safe = meaningful ? stem.replace(UNSAFE_FILENAME_CHARACTERS, "_") : "script";

  safe = trimFilenameEdges(truncateUtf8(safe, EXPORT_STEM_MAX_BYTES));
  const deviceStem = (safe.split(".", 1)[0] ?? "").replace(/[ ]+$/gu, "");
  if (WINDOWS_DEVICE_STEM.test(deviceStem)) safe = `_${safe}`;
  safe = trimFilenameEdges(truncateUtf8(safe, EXPORT_STEM_MAX_BYTES)) || "script";
  return `${safe}${EXPORT_EXTENSION}`;
}

/** Imports derive display text from the selected leaf, never a destination path. */
export function scriptImportDisplayName(pathBasename: string): string {
  return safeScriptExportBasename(pathBasename).slice(0, -EXPORT_EXTENSION.length);
}

function trimFilenameEdges(value: string): string {
  return value.replace(/^[. ]+|[. ]+$/gu, "");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    result += character;
    bytes += nextBytes;
  }
  return result;
}
