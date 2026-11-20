import { useCallback, useState } from "react";
import { Kbd } from "@heroui/react";
import { Command } from "@heroui-pro/react/command";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

import { useMessages } from "../i18n/ApplicationLocaleProvider";
import { CommandPaletteShortcutKbd } from "./CommandPaletteShortcut";

export type AppCommandGroup = "Navigate" | "Sessions" | "Beacons" | "Server" | "Windows";

export interface AppCommandPaletteCommand {
  readonly id: string;
  readonly group: AppCommandGroup;
  readonly icon: IconDefinition;
  readonly label: string;
  readonly description: string;
  readonly keywords?: readonly string[];
  readonly shortcut?: string;
  readonly isCurrent?: boolean;
  readonly isDisabled?: boolean;
  readonly onAction: () => void;
}

export interface AppCommandPaletteProps {
  readonly commands: readonly AppCommandPaletteCommand[];
  readonly hasMoreTargets?: boolean;
  readonly isOpen: boolean;
  readonly shortcut: string;
  readonly onOpenChange: (isOpen: boolean) => void;
}

const COMMAND_GROUPS: readonly AppCommandGroup[] = ["Navigate", "Sessions", "Beacons", "Server", "Windows"];

export function AppCommandPalette({
  commands,
  hasMoreTargets = false,
  isOpen,
  shortcut,
  onOpenChange,
}: AppCommandPaletteProps): React.JSX.Element {
  const { palette: copy, paletteGroups, shell } = useMessages();
  const [inputValue, setInputValue] = useState("");

  const setOpen = useCallback((next: boolean): void => {
    if (!next) setInputValue("");
    onOpenChange(next);
  }, [onOpenChange]);

  const runCommand = (key: React.Key): void => {
    const command = commands.find((candidate) => candidate.id === String(key));
    if (!command || command.isDisabled) return;
    setOpen(false);
    command.onAction();
  };

  return (
    <Command>
      <Command.Backdrop isOpen={isOpen} variant="blur" onOpenChange={setOpen}>
        <Command.Container size="lg">
          <Command.Dialog
            aria-label={shell.commandPalette}
            inputValue={inputValue}
            onInputChange={setInputValue}
          >
            <Command.InputGroup aria-label={copy.search} autoFocus>
              <Command.InputGroup.Prefix>
                <FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} />
              </Command.InputGroup.Prefix>
              <Command.InputGroup.Input
                aria-label={copy.search}
                placeholder={copy.searchPlaceholder}
              />
              <Command.InputGroup.ClearButton />
              <Command.InputGroup.Suffix>
                <Kbd className="text-xs">
                  <Kbd.Abbr keyValue="escape" />
                </Kbd>
              </Command.InputGroup.Suffix>
            </Command.InputGroup>
            {hasMoreTargets ? (
              <p className="text-muted px-4 py-2 text-xs">
                {copy.moreTargets}
              </p>
            ) : null}
            <Command.List
              aria-label={copy.applicationCommands}
              renderEmptyState={() => (
                <div className="text-muted flex h-20 items-center justify-center px-4 text-sm">
                  {copy.noResults}
                </div>
              )}
              onAction={runCommand}
            >
              {COMMAND_GROUPS.map((group) => {
                const groupCommands = commands.filter((command) => command.group === group);
                if (groupCommands.length === 0) return null;
                return (
                  <Command.Group key={group} heading={paletteGroups[group]}>
                    {groupCommands.map((command) => (
                      <Command.Item
                        key={command.id}
                        id={command.id}
                        textValue={[
                          command.label,
                          command.description,
                          ...(command.keywords ?? []),
                        ].join(" ")}
                        {...(command.isDisabled === undefined ? {} : { isDisabled: command.isDisabled })}
                      >
                        <FontAwesomeIcon aria-hidden icon={command.icon} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate font-medium">{command.label}</span>
                          <span className="text-muted truncate text-xs">{command.description}</span>
                        </span>
                        {command.isCurrent ? (
                          <span className="text-muted shrink-0 text-xs">{copy.current}</span>
                        ) : null}
                        {command.shortcut ? (
                          <CommandPaletteShortcutKbd
                            className="shrink-0 text-xs"
                            shortcut={command.shortcut}
                          />
                        ) : null}
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
            </Command.List>
            <Command.Footer className="justify-between">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5">
                  <Kbd className="text-xs"><Kbd.Abbr keyValue="up" /></Kbd>
                  <Kbd className="text-xs"><Kbd.Abbr keyValue="down" /></Kbd>
                  <span>{copy.navigate}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Kbd className="text-xs"><Kbd.Abbr keyValue="enter" /></Kbd>
                  <span>{copy.run}</span>
                </span>
              </div>
              <span className="hidden items-center gap-2 sm:flex">
                <span>{copy.toggle}</span>
                <CommandPaletteShortcutKbd className="text-xs" shortcut={shortcut} />
              </span>
            </Command.Footer>
          </Command.Dialog>
        </Command.Container>
      </Command.Backdrop>
    </Command>
  );
}
