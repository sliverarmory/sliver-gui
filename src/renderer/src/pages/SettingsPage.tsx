import { useEffect, useRef, useState } from "react";
import { Button, Card, Tabs } from "@heroui/react";
import { Segment } from "@heroui-pro/react/segment";

import type {
  ApplicationIcon,
  ApplicationSettingsState,
  ApplicationTheme,
} from "../../../shared/application-settings-contracts";
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
  readonly onAppIconChange: (appIcon: ApplicationIcon) => void;
  readonly onThemeChange: (theme: ApplicationTheme) => void;
  readonly onReduceMotionChange: (value: boolean) => void;
  readonly onKeyboardShortcutChange: (action: KeyboardShortcutAction, shortcut: string | undefined) => void;
  readonly onResetKeyboardShortcuts: () => void;
  readonly onTerminalChange: (value: ConsoleTerminalSettings) => void;
}

export function SettingsPage({
  settings,
  isSaving = false,
  onAppIconChange,
  onThemeChange,
  onReduceMotionChange,
  onKeyboardShortcutChange,
  onResetKeyboardShortcuts,
  onTerminalChange,
}: SettingsPageProps): React.JSX.Element {
  const [terminalDraft, setTerminalDraft] = useState<ConsoleTerminalSettings>(() =>
    copyTerminalSettings(settings.terminal));
  const previousSavedTerminal = useRef<ConsoleTerminalSettings>(settings.terminal);
  const scrollMarker = useRef<HTMLDivElement>(null);
  const [shortcutToolbar, setShortcutToolbar] = useState<HTMLDivElement | null>(null);
  const [isScrolled, setIsScrolled] = useState(false);

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

  return (
    <section className="settings-page page-stack max-w-4xl" aria-labelledby="settings-page-heading">
      <header className="page-heading">
        <div>
          <h1 id="settings-page-heading">Settings</h1>
          <p>Customize Sliver Desktop across application and terminal windows.</p>
        </div>
      </header>

      <Tabs className="settings-page__tabs" defaultSelectedKey="general" variant="secondary">
        <div aria-hidden="true" className="settings-page__scroll-marker" ref={scrollMarker} />
        <div className="settings-page__controls tabs--secondary" data-orientation="horizontal" data-scrolled={isScrolled}>
          <Tabs.ListContainer className="w-fit max-w-full">
            <Tabs.List aria-label="Settings sections">
              <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="general">
                General
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="keyboard">
                Keyboard Shortcuts
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="w-auto shrink-0 whitespace-nowrap" id="terminal">
                Terminal
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <div ref={setShortcutToolbar} />
        </div>

        <Tabs.Panel className="space-y-6 pt-6" id="general">
          <Card variant="secondary">
            <Card.Header>
              <div>
                <Card.Title>Appearance</Card.Title>
                <Card.Description>Choose how the app and its icon appear.</Card.Description>
              </div>
            </Card.Header>
            <Card.Content className="space-y-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Color theme</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Follow the operating system or keep a consistent light or dark appearance.
                  </p>
                </div>
                <Segment
                  aria-label="Color theme"
                  className="w-fit shrink-0"
                  isDisabled={isSaving}
                  selectedKey={settings.theme}
                  onSelectionChange={(key) => {
                    const theme = applicationThemeFromKey(key);
                    if (theme) onThemeChange(theme);
                  }}
                >
                  <Segment.Item id="system">System</Segment.Item>
                  <Segment.Item id="light">Light</Segment.Item>
                  <Segment.Item id="dark">Dark</Segment.Item>
                </Segment>
              </div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">App icon</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Auto follows the system appearance. Some launchers always use the dark icon.
                  </p>
                </div>
                <Segment
                  aria-label="App icon"
                  className="w-fit shrink-0"
                  isDisabled={isSaving}
                  selectedKey={settings.appIcon}
                  onSelectionChange={(key) => {
                    const appIcon = applicationIconFromKey(key);
                    if (appIcon) onAppIconChange(appIcon);
                  }}
                >
                  <Segment.Item id="auto">Auto</Segment.Item>
                  <Segment.Item id="light">Light</Segment.Item>
                  <Segment.Item id="dark">Dark</Segment.Item>
                  <Segment.Item id="passion">Passion</Segment.Item>
                </Segment>
              </div>
            </Card.Content>
          </Card>

          <Card variant="secondary">
            <Card.Header>
              <div>
                <Card.Title>Accessibility</Card.Title>
                <Card.Description>Limit motion without changing the information shown.</Card.Description>
              </div>
            </Card.Header>
            <Card.Content className="p-1">
              <SwitchRow
                disabled={isSaving}
                label="Reduce motion"
                description="Minimize non-essential animation and smooth scrolling throughout the app."
                selected={settings.reduceMotion}
                onChange={onReduceMotionChange}
              />
            </Card.Content>
          </Card>
        </Tabs.Panel>

        <Tabs.Panel className="settings-page__keyboard-panel" id="keyboard">
          <KeyboardShortcutsSettings settings={settings} isSaving={isSaving} toolbarContainer={shortcutToolbar}
            onShortcutChange={onKeyboardShortcutChange} onReset={onResetKeyboardShortcuts} />
        </Tabs.Panel>

        <Tabs.Panel className="pt-6" id="terminal">
          <Card variant="secondary">
            <Card.Header>
              <div>
                <Card.Title>Terminal Appearance</Card.Title>
                <Card.Description>Applied to every console and managed shell window.</Card.Description>
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
                Reset defaults
              </Button>
              <div className="flex items-center justify-end gap-2">
                <Button
                  isDisabled={isSaving || !terminalIsDirty}
                  size="sm"
                  variant="secondary"
                  onPress={() => setTerminalDraft(copyTerminalSettings(settings.terminal))}
                >
                  Discard
                </Button>
                <Button
                  isDisabled={!terminalIsDirty || !terminalIsValid}
                  isPending={isSaving}
                  size="sm"
                  onPress={() => onTerminalChange(copyTerminalSettings(terminalDraft))}
                >
                  Save
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
    left.smoothScrolling === right.smoothScrolling;
}
