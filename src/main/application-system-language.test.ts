import { describe, expect, it } from "vitest";

import { detectApplicationSystemLanguage } from "./application-system-language.js";

describe("detectApplicationSystemLanguage", () => {
  it("selects the first supported language in system preference order", () => {
    expect(detectApplicationSystemLanguage(() => ["de-DE", "fr-CA", "es-419"])).toBe("fr");
    expect(detectApplicationSystemLanguage(() => ["es-419", "fr-CA"])).toBe("es");
    expect(detectApplicationSystemLanguage(() => ["en-GB", "ja-JP"])).toBe("en");
  });

  it.each([
    ["ES-mx", "es"],
    ["ja-JP-u-ca-japanese", "ja"],
    ["uk-Cyrl-UA", "uk"],
    ["fr", "fr"],
    ["fr-FR@euro", "fr"],
    ["en-US@posix", "en"],
  ])("uses the language of %s", (locale, language) => {
    expect(detectApplicationSystemLanguage(() => [locale, "ja-JP"])).toBe(language);
  });

  it("skips malformed and unsupported preferences", () => {
    expect(detectApplicationSystemLanguage(() => ["", "C", "es--MX", "fr@!", "de-DE", "uk-UA"])).toBe("uk");
  });

  it("falls back to English when the system cannot provide a supported preference", () => {
    expect(detectApplicationSystemLanguage(() => ["de-DE", "it-IT"])).toBe("en");
    expect(detectApplicationSystemLanguage(() => [])).toBe("en");
    expect(detectApplicationSystemLanguage(() => { throw new Error("System language unavailable"); })).toBe("en");
  });
});
