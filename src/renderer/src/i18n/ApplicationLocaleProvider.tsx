import { I18nProvider } from "@react-aria/i18n";
import { createContext, useContext, useLayoutEffect, type ReactNode } from "react";
import {
  DEFAULT_APPLICATION_LANGUAGE,
  type ApplicationLanguage,
} from "../../../shared/application-settings-contracts";
import { messagesForLanguage } from "./messages";

const LanguageContext = createContext<ApplicationLanguage>(DEFAULT_APPLICATION_LANGUAGE);

export function ApplicationLocaleProvider({ children, language }: {
  readonly children: ReactNode;
  readonly language: ApplicationLanguage;
}): React.JSX.Element {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const previousLanguage = html.lang;
    html.lang = language;
    return () => { html.lang = previousLanguage; };
  }, [language]);

  return (
    <LanguageContext.Provider value={language}>
      <I18nProvider locale={language}>{children}</I18nProvider>
    </LanguageContext.Provider>
  );
}

export function useApplicationLanguage(): ApplicationLanguage {
  return useContext(LanguageContext);
}

export function useMessages(): ReturnType<typeof messagesForLanguage> {
  return messagesForLanguage(useApplicationLanguage());
}
