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
  readonly aliases: readonly string[];
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
 * selector data for the text editor's syntax list.
 */
export function monacoLanguageOptions(
  definitions: readonly MonacoLanguageDefinition[],
): readonly MonacoLanguageOption[] {
  const entries = definitions
    .map((definition) => Object.freeze({
      id: definition.id,
      label: LABEL_OVERRIDES[definition.id] ?? definition.aliases?.[0] ?? definition.id,
      aliases: Object.freeze([...(definition.aliases ?? [])]),
      extensions: Object.freeze([...(definition.extensions ?? [])]),
      filenames: Object.freeze([...(definition.filenames ?? [])]),
      ...(definition.firstLine ? { firstLine: definition.firstLine } : {}),
    }))
    .sort((left, right) => left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
      left.id.localeCompare(right.id, "en"));
  return Object.freeze(entries);
}

/**
 * Ranks Monaco languages for the syntax autocomplete. Each whitespace-delimited
 * query token must match one catalog field. Exact, prefix, and substring matches
 * win over ordered subsequence matches, so short aliases and extensions remain
 * useful without making the result order unpredictable.
 */
export function rankMonacoLanguageOptions(
  options: readonly MonacoLanguageOption[],
  query: string,
): readonly MonacoLanguageOption[] {
  const tokens = normalizeSearchValue(query).split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return Object.freeze([...options]);

  const ranked = options.flatMap((option, index) => {
    const fields = languageSearchFields(option);
    let score = 0;
    for (const token of tokens) {
      let tokenScore: number | undefined;
      for (const field of fields) {
        const candidate = fuzzyFieldScore(field, token);
        if (candidate !== undefined && (tokenScore === undefined || candidate < tokenScore)) {
          tokenScore = candidate;
        }
      }
      if (tokenScore === undefined) return [];
      score += tokenScore;
    }
    return [{ option, score, index }];
  });

  ranked.sort((left, right) => left.score - right.score ||
    left.option.label.localeCompare(right.option.label, "en", { sensitivity: "base" }) ||
    left.option.id.localeCompare(right.option.id, "en") || left.index - right.index);
  return Object.freeze(ranked.map(({ option }) => option));
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

function languageSearchFields(option: MonacoLanguageOption): readonly string[] {
  return [
    option.label,
    option.id,
    ...option.aliases,
    ...option.extensions.flatMap((extension) => [extension, extension.replace(/^\./u, "")]),
    ...option.filenames,
  ].map(normalizeSearchValue).filter(Boolean);
}

function normalizeSearchValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").trim();
}

function fuzzyFieldScore(field: string, token: string): number | undefined {
  if (field === token) return 0;
  if (field.startsWith(token)) return 100 + field.length - token.length;

  const substringIndex = field.indexOf(token);
  if (substringIndex >= 0) return 200 + substringIndex * 4 + field.length - token.length;

  let position = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (const character of token) {
    const match = field.indexOf(character, position);
    if (match < 0) return undefined;
    if (first < 0) first = match;
    if (previous >= 0) gaps += match - previous - 1;
    previous = match;
    position = match + 1;
  }
  return 300 + first * 8 + gaps * 4 + field.length - token.length;
}
