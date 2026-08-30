// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../..");

describe("repository licensing", () => {
  it("keeps the project GPL-only while separately scoping compatible licenses", async () => {
    const [projectLicense, gplLicense, mitLicense, apacheLicense, oflLicense, licensingGuide, notices, builder] =
      await Promise.all([
        readFile(resolve(rootDir, "LICENSE"), "utf8"),
        readFile(resolve(rootDir, "LICENSES/GPL-3.0-or-later.txt"), "utf8"),
        readFile(resolve(rootDir, "LICENSES/MIT.txt"), "utf8"),
        readFile(resolve(rootDir, "LICENSES/Apache-2.0.txt"), "utf8"),
        readFile(resolve(rootDir, "LICENSES/OFL-1.1.txt"), "utf8"),
        readFile(resolve(rootDir, "LICENSING.md"), "utf8"),
        readFile(resolve(rootDir, "THIRD_PARTY_NOTICES.md"), "utf8"),
        readFile(resolve(rootDir, "electron-builder.yml"), "utf8"),
      ]);

    expect(projectLicense).toBe(gplLicense);
    expect(projectLicense).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(projectLicense).not.toContain("Permission is hereby granted");
    expect(projectLicense).not.toContain("Angular Electron");
    expect(mitLicense).toContain("Permission is hereby granted");
    expect(mitLicense).toContain("Copyright (c) 2018 Maxime Gris");
    expect(mitLicense).toContain("Copyright (c) 2025 Coder");
    expect(mitLicense).not.toContain("<copyright holders>");
    expect(apacheLicense).toContain("Apache License");
    expect(apacheLicense).toContain("Copyright 2025 NextUI Inc.");
    expect(oflLicense).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(oflLicense).toContain("Reserved Font Name");
    expect(licensingGuide).toContain("not dual-license Sliver GUI");
    expect(licensingGuide).toContain("protocol/terminal-fonts-provenance.json");
    expect(notices).toContain("not dual-licensed under MIT or");
    expect(notices).toContain("Fira Code 6.2");
    expect(notices).toContain("JetBrains Mono 2.304");
    expect(notices).toContain("Cascadia Mono 2407.24");
    expect(notices).toContain("Source Code Pro 2.042R-u/1.062R-i/1.026R-vf");
    expect(builder).toContain("- LICENSING.md");
    expect(builder).toContain("- LICENSES/**");
    expect(builder).toContain("- protocol/terminal-fonts-provenance.json");
    expect(builder).toContain("from: LICENSES");
    expect(builder).toContain("to: licenses/THIRD_PARTY_LICENSES.txt");
  });
});
