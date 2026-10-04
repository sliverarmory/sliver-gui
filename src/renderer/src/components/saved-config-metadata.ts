const MODIFIED_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Prevent a backend path from leaking through a renderer label. */
export function safeConfigFilename(value: string): string {
  const withoutControlCharacters = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const segments = withoutControlCharacters.split(/[\\/]/);
  const filename = segments.at(-1)?.trim();
  return filename || "Unnamed configuration";
}

export function configEndpoint(host: string, port: number): string {
  const normalizedHost = host.trim();
  const displayHost = normalizedHost.includes(":") && !normalizedHost.startsWith("[")
    ? `[${normalizedHost}]`
    : normalizedHost;
  return `${displayHost || "Unknown host"}:${port}`;
}

export function formatConfigModifiedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "Modified time unavailable" : MODIFIED_TIME.format(timestamp);
}
