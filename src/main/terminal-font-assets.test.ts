// @vitest-environment node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../..");

interface FontFileProvenance {
  readonly path: string;
  readonly sourcePath?: string;
  readonly sourceUrl?: string;
  readonly size: number;
  readonly sha256: string;
}

interface FontProvenance {
  readonly id: string;
  readonly family: string;
  readonly version: string;
  readonly license: string;
  readonly copyrightNotice: string;
  readonly licenseUrl: string;
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly archive?: {
    readonly url: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly files: readonly FontFileProvenance[];
}

interface TerminalFontProvenance {
  readonly schemaVersion: number;
  readonly defaultFontId: string;
  readonly fonts: readonly FontProvenance[];
}

describe("embedded terminal fonts", () => {
  it("pins the approved unmodified OFL font inventory and its renderer declarations", async () => {
    const [manifestText, styles, builder, verifier, oflLicense, notices] = await Promise.all([
      readFile(resolve(rootDir, "protocol/terminal-fonts-provenance.json"), "utf8"),
      readFile(resolve(rootDir, "src/renderer/src/styles.css"), "utf8"),
      readFile(resolve(rootDir, "electron-builder.yml"), "utf8"),
      readFile(resolve(rootDir, "scripts/verifyReleaseContent.mjs"), "utf8"),
      readFile(resolve(rootDir, "LICENSES/OFL-1.1.txt"), "utf8"),
      readFile(resolve(rootDir, "THIRD_PARTY_NOTICES.md"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as TerminalFontProvenance;

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.defaultFontId).toBe("fira-code");
    expect(manifest.fonts.map(({ id }) => id).sort()).toEqual([
      "cascadia-mono",
      "fira-code",
      "jetbrains-mono",
      "source-code-pro",
    ]);
    expect(manifest.fonts.map(({ family }) => family)).toEqual([
      "Fira Code",
      "JetBrains Mono",
      "Cascadia Mono",
      "Source Code Pro",
    ]);
    expect(manifest.fonts.flatMap(({ files }) => files)).toHaveLength(9);
    expect(styles).toContain('--font-mono: "Fira Code"');
    expect(builder).toContain("- protocol/terminal-fonts-provenance.json");
    expect(verifier).toContain("assertExactTerminalFonts(packagedFonts");
    expect(oflLicense).toContain("SIL OPEN FONT LICENSE Version 1.1");

    const seenPaths = new Set<string>();
    for (const font of manifest.fonts) {
      expect(font.license).toBe("OFL-1.1");
      expect(font.commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(font.licenseUrl).toContain(font.commit);
      expect(font.repository).toMatch(/^https:\/\/github\.com\//u);
      expect(font.copyrightNotice).not.toHaveLength(0);
      expect(styles).toContain(`font-family: "${font.family}"`);
      expect(notices).toContain(`${font.family} ${font.version}`);

      for (const file of font.files) {
        expect(file.path).toMatch(
          /^src\/renderer\/src\/assets\/fonts\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.woff2$/u,
        );
        expect(seenPaths.has(file.path)).toBe(false);
        seenPaths.add(file.path);
        expect(file.sourceUrl ?? file.sourcePath).toBeTruthy();
        if (file.sourceUrl) expect(file.sourceUrl).toContain(font.commit);
        if (file.sourcePath) {
          expect(font.archive?.url).toContain(font.tag);
          expect(font.archive?.size).toBeGreaterThan(0);
          expect(font.archive?.sha256).toMatch(/^[0-9a-f]{64}$/u);
        }

        const content = await readFile(resolve(rootDir, file.path));
        const metadata = await stat(resolve(rootDir, file.path));
        expect(metadata.isFile()).toBe(true);
        expect(content.byteLength).toBe(file.size);
        expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256);
        expect(styles).toContain(
          `url("./${file.path.slice("src/renderer/src/".length)}")`,
        );
      }
    }
  });
});
