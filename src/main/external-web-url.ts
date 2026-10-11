/** Validate the supplied URL without relying on the URL parser's repair rules. */
export function externalWebHref(value: string): string | undefined {
  // Check before trimming so URL parser repair cannot hide newlines or controls.
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const candidate = value.trim();
  if (/[\s\\]/u.test(candidate) || /%(?![\da-f]{2})/iu.test(candidate)) return undefined;
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(candidate)?.[1];
  if (!authority || authority.includes("@")) return undefined;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Only validated web URLs without embedded credentials may reach the browser. */
export function isSafeExternalWebUrl(value: string): boolean {
  return externalWebHref(value) !== undefined;
}

/** Share the same URL boundary for browser links and main-owned local previews. */
export async function openExternalWebUrl(
  value: string,
  openExternal: (url: string) => Promise<unknown>,
): Promise<void> {
  const href = externalWebHref(value);
  if (!href) throw new TypeError("Browser links must use an absolute HTTP or HTTPS URL without embedded credentials");
  await openExternal(href);
}
