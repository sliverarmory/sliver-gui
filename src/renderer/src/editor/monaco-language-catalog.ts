import { SCRIPT_LANGUAGE_ID } from "./script-language-config";

export interface MonacoLanguageDefinition {
  readonly id: string;
  readonly extensions?: readonly string[];
  readonly filenames?: readonly string[];
  readonly aliases?: readonly string[];
  readonly firstLine?: string;
}

export interface MonacoLanguageOption {
  readonly id: string;
  readonly label: string;
  /** Monaco's preferred extensions, including the leading dot. */
  readonly extensions: readonly string[];
  readonly filenames: readonly string[];
  readonly firstLine?: string;
}

const LABEL_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  // Monaco calls this grammar "Shell". The standalone editor has consistently
  // presented it as Bash, which is clearer for its .sh/.bash file coverage.
  shell: "Bash",
});

/**
 * Converts Monaco's registered extension points into immutable, renderer-safe
 * selector data. The application-only script dialect is intentionally kept out
 * of the general text editor's syntax list.
 */
export function monacoLanguageOptions(
  definitions: readonly MonacoLanguageDefinition[],
): readonly MonacoLanguageOption[] {
  const entries = definitions
    .filter((definition) => definition.id !== SCRIPT_LANGUAGE_ID)
    .map((definition) => Object.freeze({
      id: definition.id,
      label: LABEL_OVERRIDES[definition.id] ?? definition.aliases?.[0] ?? definition.id,
      extensions: Object.freeze([...(definition.extensions ?? [])]),
      filenames: Object.freeze([...(definition.filenames ?? [])]),
      ...(definition.firstLine ? { firstLine: definition.firstLine } : {}),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
      left.id.localeCompare(right.id, "en"));
  return Object.freeze(entries);
}

/**
 * Matches Monaco's filename association precedence: an exact filename wins,
 * otherwise the longest case-insensitive extension wins. Later registrations
 * win ties, just as Monaco's language registry does.
 */
export function detectMonacoLanguage(
  filename: string,
  text: string,
  definitions: readonly MonacoLanguageDefinition[],
): string | undefined {
  const normalizedFilename = basename(filename).toLowerCase();
  let filenameMatch: MonacoLanguageDefinition | undefined;
  let extensionMatch: { readonly entry: MonacoLanguageDefinition; readonly length: number } | undefined;

  for (const entry of definitions) {
    if (entry.id === SCRIPT_LANGUAGE_ID) continue;
    if (entry.filenames?.some((candidate) => candidate.toLowerCase() === normalizedFilename)) {
      filenameMatch = entry;
    }
    for (const extension of entry.extensions ?? []) {
      if (normalizedFilename.endsWith(extension.toLowerCase()) &&
        (!extensionMatch || extension.length >= extensionMatch.length)) {
        extensionMatch = { entry, length: extension.length };
      }
    }
  }
  if (filenameMatch) return filenameMatch.id;
  if (extensionMatch) return extensionMatch.entry.id;

  const firstLine = text.split(/\r\n|\r|\n/u, 1)[0] ?? "";
  if (firstLine) {
    const normalizedFirstLine = firstLine.startsWith("\uFEFF") ? firstLine.slice(1) : firstLine;
    for (let index = definitions.length - 1; index >= 0; index -= 1) {
      const entry = definitions[index];
      if (entry?.id === SCRIPT_LANGUAGE_ID) continue;
      if (!entry?.firstLine) continue;
      try {
        if (new RegExp(entry.firstLine).test(normalizedFirstLine)) return entry.id;
      } catch {
        // Third-party registrations can contain an invalid expression. Ignore
        // it instead of making the entire syntax selector unavailable.
      }
    }
  }
  return undefined;
}

/** The first Monaco extension without its leading dot, suitable for model URIs. */
export function preferredMonacoExtension(
  languageId: string,
  definitions: readonly MonacoLanguageDefinition[],
): string | undefined {
  const extension = definitions.find((entry) => entry.id === languageId)?.extensions?.[0];
  return extension?.replace(/^\./u, "") || undefined;
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? "";
}
