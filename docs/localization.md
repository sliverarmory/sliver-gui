# Application localization

Choose a language in **Settings → General → Application language**. English is the default. The list shows English, Español, Français, 日本語, and Українська in their own languages. Settings, the main sidebar, window navigation, the command palette, and the terminal settings dialog use the selected language. Feature-page copy, the connection picker, native menus, and raw backend diagnostics still use English.

## Design

The application settings store persists a validated language tag alongside the other revisioned preferences. Older settings migrate to English and keep their saved preferences. The existing settings broadcast updates open renderer windows that subscribe to application settings.

The renderer bundles one catalog per language under [locales](../src/renderer/src/i18n/locales). The English catalog defines the TypeScript shape. Tests check for the same keys and named placeholders in all five catalogs. React Aria’s locale provider and the document’s `lang` attribute follow the saved preference. The UI can switch offline under the existing Content Security Policy. [React Aria I18nProvider](https://react-aria.adobe.com/I18nProvider), [W3C language tags](https://www.w3.org/International/articles/language-tags/)

Add complete phrases in the catalog, including accessible names and validation messages. Use stable IDs for routes, actions, option values, and protocol fields. Treat filenames, paths, shortcut keys, product names, and server-provided data as values. Use the selected locale with `Intl` for displayed dates and numbers. For counts that change a noun or sentence, use complete plural messages selected with `Intl.PluralRules`. Japanese uses one cardinal form, while Ukrainian distinguishes `one`, `few`, `many`, and `other`. [ECMA-402](https://tc39.es/ecma402/), [Unicode CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html)

## Translation choices

| English concept | Spanish | French | Japanese | Ukrainian |
| --- | --- | --- | --- | --- |
| Settings | Configuración | Paramètres | 設定 | Налаштування |
| Keyboard shortcuts | Atajos de teclado | Raccourcis clavier | キーボードショートカット | Клавіатурні скорочення |
| Credentials | Credenciales | Identifiants | 資格情報 | Облікові дані |
| Loot | Archivos recopilados | Fichiers collectés | 収集ファイル | Зібрані файли |

- **Spanish** uses neutral vocabulary, sentence case, and infinitives for button actions. A network listener is a *servicio de escucha*. *Archivos recopilados* describes the contents of the Loot view. [Microsoft neutral Spanish style guide](https://aka.ms/spanish-neutral-styleguide), [KDE Spanish glossary](https://es.l10n.kde.org/glosario_new.php), [Microsoft networking terminology](https://learn.microsoft.com/es-es/azure/app-service/configure-gateway-required-vnet-integration)
- **French** uses short labels and French punctuation spacing. *Services d’écoute* describes network services. *Réduire les animations* follows familiar OS accessibility wording. [Microsoft French style guide](https://aka.ms/french-france-styleguide), [Microsoft networking terminology](https://learn.microsoft.com/fr-fr/azure/container-apps/deployment-errors), [Apple accessibility terminology](https://support.apple.com/fr-fr/guide/mac-help/mchl67c83f41/27/mac/27)
- **Japanese** uses short noun labels and polite sentences for help and errors. リスナー and 資格情報 follow familiar technical usage. ビーコン is the established transliteration. [Microsoft localization guides](https://learn.microsoft.com/en-us/globalization/reference/microsoft-style-guides), [Microsoft listener terminology](https://learn.microsoft.com/ja-jp/troubleshoot/windows-server/remote/remote-desktop-listener-certificate-configurations), [Microsoft beacon terminology](https://learn.microsoft.com/ja-jp/azure/network-watcher/traffic-analytics-sentinel)
- **Ukrainian** uses Ukrainian UI terms such as Знімок екрана and Робочий стіл. *Beacon* stays recognizable as a Sliver term. The accompanying description explains that it is an asynchronous agent. [Microsoft Ukrainian style guide](https://download.microsoft.com/download/6/4/a/64a8b98e-e69f-47c9-96dd-f8bc55c176c6/ukr-ukr-StyleGuide.pdf), [Apple screenshot terminology](https://support.apple.com/uk-ua/guide/mac-help/cpmh0038/27/mac/27), [Ukrainian Cyber Police usage](https://cyberpolice.gov.ua/news/kiberataka-na-derzhavni-organy-ukrayiny-z-vykorystannyam-shkidlyvoyi-programy-cobalt-strike-beacon-cert-ua-8864/)
