export const TERMINAL_TAB_LABEL_MAX_LENGTH = 128 as const;

const CONTROL_OR_LINE_SEPARATOR_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const FORMAT_CHARACTER_PATTERN = /\p{Cf}/gu;
const VISIBLE_CHARACTER_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u;
const ALLOWED_JOINERS = new Set(["\u200c", "\u200d"]);

/**
 * Produces the canonical label accepted by every terminal-tab boundary.
 * Joiners remain available for scripts and emoji sequences, but cannot form a
 * label by themselves. Other format characters include direction overrides
 * and invisible separators, so they are rejected.
 */
export function normalizeTerminalTabLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > TERMINAL_TAB_LABEL_MAX_LENGTH ||
    CONTROL_OR_LINE_SEPARATOR_PATTERN.test(normalized) ||
    !VISIBLE_CHARACTER_PATTERN.test(normalized)
  ) return undefined;
  const formatCharacters = normalized.match(FORMAT_CHARACTER_PATTERN) ?? [];
  return formatCharacters.every((character) => ALLOWED_JOINERS.has(character))
    ? normalized
    : undefined;
}

export function isTerminalTabLabel(value: unknown): value is string {
  return typeof value === "string" && normalizeTerminalTabLabel(value) === value;
}
