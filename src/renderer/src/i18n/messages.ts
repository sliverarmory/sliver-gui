import {
  DEFAULT_APPLICATION_LANGUAGE,
  isApplicationLanguage,
  type ApplicationLanguage,
} from "../../../shared/application-settings-contracts";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ja from "./locales/ja.json";
import uk from "./locales/uk.json";

const catalogs = { en, es, fr, ja, uk } satisfies Record<ApplicationLanguage, typeof en>;

export function messagesForLanguage(language: string): typeof en {
  return catalogs[isApplicationLanguage(language) ? language : DEFAULT_APPLICATION_LANGUAGE];
}

/** Substitute named values for React text content and accessible labels. */
export function formatMessage(message: string, values: Readonly<Record<string, string>>): string {
  return message.replace(/\{([a-zA-Z]+)\}/gu, (placeholder: string, name: string) =>
    Object.hasOwn(values, name) ? values[name] ?? placeholder : placeholder);
}
