import type { CSSProperties, ReactNode } from "react";
import { Button, Tooltip } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faGear } from "@fortawesome/free-solid-svg-icons";

import type { GhosttyTerminalAppearance } from "./GhosttyTerminal";

export function TerminalWindowFrame({
  appearance,
  children,
  label,
  nativeChromeSupported,
  transparent,
}: {
  readonly appearance: GhosttyTerminalAppearance;
  readonly children: ReactNode;
  readonly label: string;
  readonly nativeChromeSupported: boolean;
  readonly transparent: boolean;
}): React.JSX.Element {
  const platform = navigator.platform;
  const nativeChrome = nativeChromeSupported
    ? /Mac/iu.test(platform) ? "macos" : /Win/iu.test(platform) ? "windows" : "standard"
    : "standard";
  const style = {
    "--terminal-background": appearance.theme?.background ?? "var(--color-background)",
    "--terminal-foreground": appearance.theme?.foreground ?? "var(--color-foreground)",
    "--terminal-background-opacity": `${(appearance.theme?.backgroundOpacity ?? 1) * 100}%`,
  } as CSSProperties;

  return (
    <main
      aria-label={label}
      className="terminal-window"
      data-native-chrome={nativeChrome}
      data-transparent={transparent}
      style={style}
    >
      {children}
    </main>
  );
}

export function TerminalWindowToolbar({
  actions,
  children,
  description,
  onOpenSettings,
}: {
  readonly actions: ReactNode;
  readonly children: ReactNode;
  readonly description: string;
  readonly onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <header aria-label={description} className="terminal-window__toolbar">
      {children}
      <div className="terminal-window__actions">
        {actions}
        <Tooltip delay={250}>
          <Button
            aria-label="Terminal settings"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={onOpenSettings}
          >
            <FontAwesomeIcon aria-hidden icon={faGear} />
          </Button>
          <Tooltip.Content placement="bottom">Terminal settings</Tooltip.Content>
        </Tooltip>
      </div>
    </header>
  );
}
