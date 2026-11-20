import { useMemo, useState } from "react";
import { Button, Card, Description, Label, ListBox, Select } from "@heroui/react";

import type { GhosttySettingsSnapshot } from "../../../shared/ghostty-settings-contracts";
import { useCollator } from "@react-aria/i18n";
import { useMessages } from "../i18n/ApplicationLocaleProvider";
import { useApplicationSettings } from "./ApplicationSettingsProvider";
import { applicationTerminalAppearance } from "./application-terminal-appearance";

const DEFAULT_THEME_KEY = "application-default";
const ANSI_THEME_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

export function GhosttyThemeSettings(): React.JSX.Element {
  const { terminal: copy } = useMessages();
  const collator = useCollator();
  const applicationSettings = useApplicationSettings();
  const bridge = window.ghosttySettings;
  const [lastSaved, setLastSaved] = useState<GhosttySettingsSnapshot>();
  const [pendingAction, setPendingAction] = useState<"theme" | "edit" | "reload">();
  const [error, setError] = useState<string>();
  const shared = applicationSettings?.ghosttyConfig;
  const config = lastSaved && (!shared || lastSaved.revision > shared.revision) ? lastSaved : shared;
  const themeNames = useMemo(() => {
    const names = new Set(config?.themes.map(({ name }) => name) ?? []);
    if (config?.theme) names.add(config.theme);
    return [...names].sort(collator.compare);
  }, [collator, config]);
  const preview = applicationSettings && applicationTerminalAppearance(
    applicationSettings.settings.terminal,
    applicationSettings.resolvedTheme,
    applicationSettings.settings.reduceMotion,
    config,
  );

  const performAction = async (action: "theme" | "edit" | "reload", theme?: string): Promise<void> => {
    if (!bridge || pendingAction) return;
    setPendingAction(action);
    setError(undefined);
    try {
      if (action === "reload") {
        setLastSaved(await bridge.reloadConfig());
      } else if (action === "theme") {
        const result = await bridge.setTheme(theme ?? "");
        if (!result.ok || !result.value) throw new Error(result.error ?? copy.saveThemeFailed);
        setLastSaved(result.value);
      } else {
        const result = await bridge.editConfig();
        if (!result.ok) throw new Error(result.error ?? copy.openConfigFailed);
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingAction(undefined);
    }
  };

  return (
    <Card variant="secondary">
      <Card.Header>
        <div>
          <Card.Title>{copy.ghosttyThemes}</Card.Title>
          <Card.Description>{copy.ghosttyThemesDescription}</Card.Description>
        </div>
      </Card.Header>
      <Card.Content className="space-y-5">
        <Select
          fullWidth
          isDisabled={!config || !bridge || pendingAction !== undefined}
          value={config?.theme ? `theme:${config.theme}` : DEFAULT_THEME_KEY}
          variant="secondary"
          onChange={(value) => {
            if (typeof value !== "string") return;
            void performAction("theme", value === DEFAULT_THEME_KEY ? "" : value.slice("theme:".length));
          }}
        >
          <Label>{copy.theme}</Label>
          <Select.Trigger>
            <Select.Value>{config?.theme || copy.defaultTheme}</Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id={DEFAULT_THEME_KEY} textValue={copy.defaultTheme}>
                {copy.defaultTheme}
                <ListBox.ItemIndicator />
              </ListBox.Item>
              {themeNames.map((name) => (
                <ListBox.Item id={`theme:${name}`} key={name} textValue={name}>
                  <span className="break-all">{name}</span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{copy.themeDescription}</Description>
        </Select>

        {preview?.theme ? (
          <div
            aria-label={copy.preview}
            className="overflow-hidden rounded-xl px-4 py-4"
            role="img"
            style={{ backgroundColor: preview.theme.background, color: preview.theme.foreground }}
          >
            <div className="space-y-1 text-xs leading-5" style={{ fontFamily: preview.fontFamily }}>
              <p><span style={{ color: preview.theme.green }}>❯</span> {copy.preview}</p>
              <p className="opacity-70">{copy.previewSample}</p>
            </div>
            <div aria-hidden className="mt-4 grid gap-1" style={{ gridTemplateColumns: "repeat(16, minmax(0, 1fr))" }}>
              {ANSI_THEME_KEYS.map((key) => <span className="h-4 rounded-xs" key={key} style={{ backgroundColor: preview.theme?.[key] }} />)}
            </div>
          </div>
        ) : null}

        {config ? (
          <div className="space-y-2 text-xs leading-5 text-muted">
            <p>{copy.themeDirectory}</p>
            <p><code className="break-all text-foreground">{config.themesDirectory}</code></p>
            <p>{copy.themeDirectoryDescription}</p>
            <p>{copy.configPath}</p>
            <p><code className="break-all text-foreground">{config.configPath}</code></p>
          </div>
        ) : (
          <p className="text-xs text-muted">
            {bridge ? copy.loadingConfig : copy.configUnavailable}
          </p>
        )}

        {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}
        {config?.diagnostics.length ? (
          <div className="space-y-2 rounded-lg bg-warning-soft p-3 text-xs text-warning-soft-foreground" role="status">
            <p className="font-medium">{copy.configNotes}</p>
            <ul className="max-h-40 space-y-2 overflow-y-auto">
              {config.diagnostics.map((diagnostic, index) => (
                <li className="break-words" key={`${diagnostic.source}:${diagnostic.line ?? 0}:${index}`}>
                  <span className="font-medium">{diagnostic.message}</span>
                  <span className="mt-0.5 block break-all opacity-70">
                    {diagnostic.source}{diagnostic.line === undefined ? "" : `:${diagnostic.line}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button
          isDisabled={!bridge || pendingAction !== undefined}
          isPending={pendingAction === "edit"}
          size="sm"
          variant="secondary"
          onPress={() => void performAction("edit")}
        >
          {copy.editConfig}
        </Button>
        <Button
          isDisabled={!bridge || pendingAction !== undefined}
          isPending={pendingAction === "reload"}
          size="sm"
          variant="tertiary"
          onPress={() => void performAction("reload")}
        >
          {copy.reloadThemes}
        </Button>
      </Card.Footer>
    </Card>
  );
}
