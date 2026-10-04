import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8"));
const terminalFonts = JSON.parse(
  await readFile(join(rootDir, "protocol/terminal-fonts-provenance.json"), "utf8"),
);
const openFontLicense = (
  await readFile(join(rootDir, "LICENSES/OFL-1.1.txt"), "utf8")
).trim();
const x11ColorLicense = (
  await readFile(join(rootDir, "LICENSES/X11-rgb.txt"), "utf8")
).trim();
const packagePaths = Object.keys(lock.packages ?? {})
  .filter((packagePath) => packagePath.includes("node_modules/"))
  .sort();

const packages = new Map();

for (const packagePath of packagePaths) {
  const installedPath = resolve(rootDir, ...packagePath.split("/"));
  let packageDir;
  let manifest;

  try {
    packageDir = await realpath(installedPath);
    manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }

  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    continue;
  }

  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) {
    continue;
  }

  const directoryEntries = await readdir(packageDir, { withFileTypes: true });
  const licenseFileNames = directoryEntries
    .filter(
      (entry) =>
        entry.isFile() && /^(licen[cs]e|copying|notice)(?:\..*)?$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const licenseFiles = [];

  for (const fileName of licenseFileNames) {
    licenseFiles.push({
      fileName,
      text: (await readFile(join(packageDir, fileName), "utf8")).trim(),
    });
  }

  const declaredLicense =
    typeof manifest.license === "string"
      ? manifest.license
      : manifest.license
        ? JSON.stringify(manifest.license)
        : "Not declared";

  packages.set(key, {
    declaredLicense,
    licenseFiles,
    name: manifest.name,
    version: manifest.version,
  });
}

const divider = "=".repeat(80);
const output = [
  "THIRD-PARTY SOFTWARE LICENSES",
  "",
  "Generated from package-lock.json, the exact dependency tree installed for this build,",
  "and protocol/terminal-fonts-provenance.json. Packages unavailable on the build platform are omitted.",
  "",
];

output.push(
  divider,
  "X11 RGB color database (Ghostty theme compatibility)",
  "Source: https://gitlab.freedesktop.org/xorg/app/rgb",
  "",
  x11ColorLicense,
  "",
);

for (const entry of [...packages.values()].sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
)) {
  output.push(divider, `${entry.name}@${entry.version}`, `Declared license: ${entry.declaredLicense}`, "");

  if (entry.licenseFiles.length === 0) {
    output.push("No standalone license or notice file was present in the installed package.", "");
    continue;
  }

  for (const licenseFile of entry.licenseFiles) {
    output.push(`--- ${licenseFile.fileName} ---`, licenseFile.text, "");
  }
}

if (terminalFonts.schemaVersion !== 1 || !Array.isArray(terminalFonts.fonts)) {
  throw new Error("Invalid terminal font provenance manifest");
}
for (const font of terminalFonts.fonts) {
  if (
    typeof font.family !== "string" ||
    typeof font.version !== "string" ||
    font.license !== "OFL-1.1" ||
    typeof font.copyrightNotice !== "string" ||
    typeof font.repository !== "string" ||
    !Array.isArray(font.files) ||
    font.files.length === 0
  ) {
    throw new Error("Invalid terminal font provenance entry");
  }
  output.push(
    divider,
    `${font.family}@${font.version} (embedded terminal font)`,
    "Declared license: OFL-1.1",
    font.copyrightNotice,
    `Source: ${font.repository}`,
    "",
    "--- OFL-1.1.txt ---",
    openFontLicense,
    "",
  );
}

output.push(
  divider,
  `Inventory entries: ${packages.size + terminalFonts.fonts.length}`,
  `Package entries: ${packages.size}`,
  `Embedded terminal font entries: ${terminalFonts.fonts.length}`,
  "",
);
await mkdir(join(rootDir, "dist"), { recursive: true });
await writeFile(join(rootDir, "dist", "THIRD_PARTY_LICENSES.txt"), output.join("\n"), "utf8");
