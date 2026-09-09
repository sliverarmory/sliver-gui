/** Validate the supplied URL without relying on the URL parser's repair rules. */
export function externalWebHref(value: string): string | undefined {
  const candidate = value.trim();
  if (/[\u0000-\u0020\u007f\\]/u.test(candidate)) return undefined;
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
