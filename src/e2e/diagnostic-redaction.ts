const DEFAULT_MAX_DIAGNOSTIC_STRING_LENGTH = 4_096;

export function redactDiagnosticText(
  value: string,
  redactions: string[],
  maxLength = DEFAULT_MAX_DIAGNOSTIC_STRING_LENGTH,
): string {
  const redacted = [...redactions]
    .filter((candidate) => candidate.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((current, candidate) => current.replaceAll(candidate, "[REDACTED]"), value);
  return redacted.slice(0, maxLength);
}

export function stringifyRedactedDiagnostics(value: unknown, redactions: string[]): string {
  return JSON.stringify(
    value,
    (_key, nestedValue: unknown) =>
      typeof nestedValue === "string"
        ? redactDiagnosticText(nestedValue, redactions)
        : nestedValue,
    2,
  );
}
