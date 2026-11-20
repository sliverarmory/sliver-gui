import { GhosttyThemeSettings } from "../components/GhosttyThemeSettings";
import { useEffect, useRef, useState } from "react";
import { Button, Card, Description, Label, ListBox, Select, Tabs, toast } from "@heroui/react";
import { Segment } from "@heroui-pro/react/segment";

import {
  APPLICATION_LANGUAGES,
  isApplicationLanguagePreference,
  type ApplicationIcon,
  type ApplicationLanguagePreference,
  type ApplicationSettingsState,
  type ApplicationTheme,
} from "../../../shared/application-settings-contracts";
import { useMessages } from "../i18n/ApplicationLocaleProvider";
import { KeyboardShortcutsSettings } from "../components/KeyboardShortcutsSettings";
import type { KeyboardShortcutAction } from "../../../shared/keyboard-shortcuts";
import { SwitchRow } from "../components/FormControls";
import {
  DEFAULT_CONSOLE_TERMINAL_SETTINGS,
  type ConsoleTerminalSettings,
} from "../components/console-terminal-settings";
import {
  isValidTerminalSettings,
  TerminalSettingsFields,
} from "../components/TerminalSettingsFields";

export interface SettingsPageProps {
  readonly settings: ApplicationSettingsState;
  readonly isSaving?: boolean;
  readonly onLanguageChange: (language: ApplicationLanguagePreference) => void;
  readonly onAppIconChange: (appIcon: ApplicationIcon) => void;
  readonly onThemeChange: (theme: ApplicationTheme) => void;
  readonly onReduceMotionChange: (value: boolean) => void;
  readonly onDisableWindowTransparencyChange: (value: boolean) => void;
  readonly onReportScreenshotDirectoryChange: (directory: string | null) => void;
  readonly onKeyboardShortcutChange: (action: KeyboardShortcutAction, shortcut: string | undefined) => void;
  readonly onResetKeyboardShortcuts: () => void;
  readonly onTerminalChange: (value: ConsoleTerminalSettings) => void;
}

export function SettingsPage({
  settings,
  isSaving = false,
  onLanguageChange,
  onAppIconChange,
  onThemeChange,
  onReduceMotionChange,
  onDisableWindowTransparencyChange,
  onReportScreenshotDirectoryChange,
  onKeyboardShortcutChange,
  onResetKeyboardShortcuts,
  onTerminalChange,
}: SettingsPageProps): React.JSX.Element {
  const { settings: copy, terminal: terminalCopy } = useMessages();
  const selectedLanguage = APPLICATION_LANGUAGES.find(({ id }) => id === settings.language);
  const [terminalDraft, setTerminalDraft] = useState<ConsoleTerminalSettings>(() =>
    copyTerminalSettings(settings.terminal));
  const previousSavedTerminal = useRef<ConsoleTerminalSettings>(settings.terminal);
  const scrollMarker = useRef<HTMLDivElement>(null);
  const [shortcutToolbar, setShortcutToolbar] = useState<HTMLDivElement | null>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isChoosingScreenshotDirectory, setIsChoosingScreenshotDirectory] = useState(false);

  useEffect(() => {
    const marker = scrollMarker.current;
    const viewport = marker?.closest(".app-content");
    if (!marker || !viewport) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setIsScrolled(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, { root: viewport, threshold: [0, 1] });
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = previousSavedTerminal.current;
    previousSavedTerminal.current = settings.terminal;
    setTerminalDraft((current) => terminalSettingsEqual(current, previous)
      ? copyTerminalSettings(settings.terminal)
      : current);
  }, [settings.terminal]);

  const terminalIsDirty = !terminalSettingsEqual(terminalDraft, settings.terminal);
  const terminalIsValid = isValidTerminalSettings(terminalDraft);

  const chooseScreenshotDirectory = async (): Promise<void> => {
    setIsChoosingScreenshotDirectory(true);
    try {
      const result = await window.sliver.chooseReportScreenshotDirectory();
      if (result.ok) {
        onReportScreenshotDirectoryChange(result.value.directory);
      } else if (result.error !== "cancelled") {
        toast.danger(copy.screenshotFolderError, { description: result.error });
      }
    } catch (error: unknown) {
      toast.danger(copy.screenshotFolderError, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsChoosingScreenshotDirectory(false);
    }
  };

  return (
    <section className="settings-page page-stack max-w-4xl" aria-labelledby="settings-page-heading">
      <header className="page-heading">
        <div>
          <h1 id="settings-page-heading">{copy.heading}</h1>
          <p>{copy.description}</p>
        </div>
      </header>

      <Tabs className="settings-page__tabs" defaultSelectedKey="general" variant="secondary">
        <div aria-hidden="true" className="settings-page__scroll-marker" ref={scrollMarker} />
        <div className="settings-page__controls tabs--secondary" data-orientation="horizontal" data-scrolled={isScrolled}>
          <Tabs.ListContainer className="w-fit max-w-full">
            <Tabs.List aria-label={copy.sections}>
              <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="general">
                {copy.general}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="keyboard">
                {copy.keyboard}
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="terminal">
                {copy.terminal}
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <div ref={setShortcutToolbar} />
        </div>

        <Tabs.Panel className="space-y-6 pt-6" id="general">
          <Card variant="secondary">
            <Card.Content>
              <Select
                className="w-full sm:max-w-xs"
                isDisabled={isSaving}
                value={settings.language}
                variant="secondary"
                onChange={(value) => {
                  if (isApplicationLanguagePreference(value)) onLanguageChange(value);
                }}
              >
                <Label>{copy.language}</Label>
                <Select.Trigger>
                  <Select.Value>
                    <span lang={selectedLanguage?.id}>{selectedLanguage?.label ?? copy.systemLanguage}</span>
                  </Select.Value>
                  <Select.Indicator />
                </Select.Trigger>
                <Description>
                  <span className="block">{copy.languageDescription}</span>
                  {settings.language === "system" ? <span className="block">{copy.systemLanguageDescription}</span> : null}
                </Description>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="system" textValue={copy.systemLanguage}>
                      {copy.systemLanguage}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    {APPLICATION_LANGUAGES.map(({ id, label }) => (
                      <ListBox.Item id={id} key={id} textValue={label}>
                        <span lang={id}>{label}</span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </Card.Content>
          </Card>

          <Card variant="secondary">
            <Card.Header>
              <div>
                <Card.Title>{copy.appearance}</Card.Title>
                <Card.Description>{copy.appearanceDescription}</Card.Description>
              </div>
            </Card.Header>
            <Card.Content className="space-y-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{copy.theme}</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {copy.themeDescription}
                  </p>
                </div>
                <Segment
                  aria-label={copy.theme}
                  className="w-fit shrink-0"
                  isDisabled={isSaving}
                  selectedKey={settings.theme}
                  onSelectionChange={(key) => {
                    const theme = applicationThemeFromKey(key);
                    if (theme) onThemeChange(theme);
                  }}
                >
                  <Segment.Item id="system">{copy.system}</Segment.Item>
                  <Segment.Item id="light">{copy.light}</Segment.Item>
                  <Segment.Item id="dark">{copy.dark}</Segment.Item>
                </Segment>
              </div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{copy.icon}</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {copy.iconDescription}
                  </p>
                </div>
                <Segment
                  aria-label={copy.icon}
                  className="w-fit shrink-0"
                  isDisabled={isSaving}
                  selectedKey={settings.appIcon}
                  onSelectionChange={(key) => {
                    const appIcon = applicationIconFromKey(key);
                    if (appIcon) onAppIconChange(appIcon);
                  }}
                >
                  <Segment.Item id="auto">{copy.auto}</Segment.Item>
                  <Segment.Item id="light">{copy.light}</Segment.Item>
                  <Segment.Item id="dark">{copy.dark}</Segment.Item>
                  <Segment.Item id="passion">{copy.passion}</Segment.Item>
                </Segment>
              </div>
              <SwitchRow
                disabled={isSaving}
                label={copy.disableTransparency}
                description={copy.disableTransparencyDescription}
                selected={settings.disableWindowTransparency}
                onChange={onDisableWindowTransparencyChange}
              />
            </Card.Content>
          </Card>

          <Card variant="secondary">
            <Card.Header>
              <div>
                <Card.Title>{copy.accessibility}</Card.Title>
                <Card.Description>{copy.accessibilityDescription}</Card.Description>
              </div>
            </Card.Header>
            <Card.Content className="p-1">
              <SwitchRow
                disabled={isSaving}
                label={copy.reduceMotion}
                description={copy.reduceMotionDescription}
                selected={settings.reduceMotion}
                onChange={onReduceMotionChange}
              />
            </Card.Content>
          </Card>

          <Card variant="secondary">
            <Card.Header>
              <div>
                <Card.Title>{copy.screenshots}</Card.Title>
                <Card.Description>{copy.screenshotsDescription}</Card.Description>
              </div>
            </Card.Header>
            <Card.Content className="space-y-4">
              <div>
                <p className="text-sm font-medium text-foreground">{copy.screenshotLocation}</p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {copy.screenshotLocationDescription}
                </p>
                <p aria-label={copy.screenshotLocationLabel} className="mt-3 break-all rounded-lg bg-surface-secondary px-3 py-2 font-mono text-xs text-foreground">
                  {settings.reportScreenshotDirectory ?? copy.screenshotLocationDefault}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  isDisabled={isSaving}
                  isPending={isChoosingScreenshotDirectory}
                  size="sm"
                  variant="secondary"
                  onPress={() => void chooseScreenshotDirectory()}
                >
                  {copy.browse}
                </Button>
                <Button
                  isDisabled={isSaving || isChoosingScreenshotDirectory || settings.reportScreenshotDirectory === null}
                  size="sm"
                  variant="tertiary"
                  onPress={() => onReportScreenshotDirectoryChange(null)}
                >
                  {copy.useDesktop}
                </Button>
              </div>
            </Card.Content>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel className="settings-page__keyboard-panel" id="keyboard">
          <KeyboardShortcutsSettings settings={settings} isSaving={isSaving} toolbarContainer={shortcutToolbar}
            onShortcutChange={onKeyboardShortcutChange} onReset={onResetKeyboardShortcuts} />
        </Tabs.Panel>

        <Tabs.Panel className="space-y-6 pt-6" id="terminal">
          <GhosttyThemeSettings />
          <Card variant="secondary">
            <Card.Header>
              <div>
                <Card.Title>{terminalCopy.appearance}</Card.Title>
                <Card.Description>{terminalCopy.appearanceDescription}</Card.Description>
              </div>
            </Card.Header>
            <Card.Content>
              <div className="grid gap-5 md:grid-cols-2">
                <TerminalSettingsFields settings={terminalDraft} onChange={setTerminalDraft} />
              </div>
            </Card.Content>
            <Card.Footer className="flex flex-col items-stretch justify-between gap-3 border-t border-separator sm:flex-row sm:items-center">
              <Button
                isDisabled={isSaving || terminalSettingsEqual(terminalDraft, DEFAULT_CONSOLE_TERMINAL_SETTINGS)}
                size="sm"
                variant="tertiary"
                onPress={() => setTerminalDraft(copyTerminalSettings(DEFAULT_CONSOLE_TERMINAL_SETTINGS))}
              >
                {copy.resetDefaults}
              </Button>
              <div className="flex items-center justify-end gap-2">
                <Button
                  isDisabled={isSaving || !terminalIsDirty}
                  size="sm"
                  variant="secondary"
                  onPress={() => setTerminalDraft(copyTerminalSettings(settings.terminal))}
                >
                  {copy.discard}
                </Button>
                <Button
                  isDisabled={!terminalIsDirty || !terminalIsValid}
                  isPending={isSaving}
                  size="sm"
                  onPress={() => onTerminalChange(copyTerminalSettings(terminalDraft))}
                >
                  {copy.save}
                </Button>
              </div>
            </Card.Footer>
          </Card>
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}

function applicationThemeFromKey(key: React.Key): ApplicationTheme | undefined {
  const value = String(key);
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

function applicationIconFromKey(key: React.Key): ApplicationIcon | undefined {
  const value = String(key);
  return value === "auto" || value === "light" || value === "dark" || value === "passion"
    ? value
    : undefined;
}

function copyTerminalSettings(settings: ConsoleTerminalSettings): ConsoleTerminalSettings {
  return { ...settings };
}

function terminalSettingsEqual(
  left: ConsoleTerminalSettings,
  right: ConsoleTerminalSettings,
): boolean {
  return left.fontId === right.fontId &&
    left.fontSize === right.fontSize &&
    left.cursorStyle === right.cursorStyle &&
    left.cursorBlink === right.cursorBlink &&
    left.smoothScrolling === right.smoothScrolling &&
    left.transparentWindows === right.transparentWindows;
}
