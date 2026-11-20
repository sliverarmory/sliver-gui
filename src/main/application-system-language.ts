import {
  DEFAULT_APPLICATION_LANGUAGE,
  isApplicationLanguage,
  type ApplicationLanguage,
} from "../shared/application-settings-contracts.js";

export function detectApplicationSystemLanguage(
  getPreferredSystemLanguages: () => readonly string[],
): ApplicationLanguage {
  try {
    for (const locale of getPreferredSystemLanguages()) {
      const language = languageFromLocale(locale);
      if (isApplicationLanguage(language)) return language;
    }
  } catch {
    // The platform can fail to supply its preferred languages.
  }
  return DEFAULT_APPLICATION_LANGUAGE;
}

function languageFromLocale(locale: string): string | undefined {
  try {
    // Electron's Linux source emits Chromium locale names with optional @variants.
    const languageTag = locale.replace(/@[a-z0-9]+(?:_[a-z0-9]+)*$/iu, "");
    return new Intl.Locale(languageTag).language;
  } catch {
    return undefined;
  }
}
