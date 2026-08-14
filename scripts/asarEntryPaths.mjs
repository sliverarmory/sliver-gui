export function asarEntryPaths(entry) {
  const lookupPath = entry.replace(/^[/\\]/u, "");
  return {
    lookupPath,
    normalizedPath: lookupPath.replaceAll("\\", "/"),
  };
}
