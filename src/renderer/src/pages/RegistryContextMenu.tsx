import { useState, type ReactNode } from "react";
import { faFolderPlus, faPen, faTrash } from "@fortawesome/free-solid-svg-icons";

import type { SessionRegistryHive } from "../../../shared/session-contracts";
import {
  useApplicationContextMenuScope,
  type ApplicationContextMenuAction,
} from "../components/ApplicationContextMenu";

export type RegistryContextTarget =
  | { kind: "key"; hive: SessionRegistryHive; path: string }
  | { kind: "value"; hive: SessionRegistryHive; path: string; key: string };

export type RegistryContextAction = "create-key" | "write-value" | "modify-value" | "delete-key";

interface RegistryContextMenuProps {
  children: ReactNode;
  hive: SessionRegistryHive;
  path: string;
  valueNames: readonly string[];
  disabled: boolean;
  onAction: (target: RegistryContextTarget, action: RegistryContextAction) => void;
}

interface CapturedRegistryContext {
  target: RegistryContextTarget;
  onAction: RegistryContextMenuProps["onAction"];
}

export function RegistryContextMenu({
  children,
  hive,
  path,
  valueNames,
  disabled,
  onAction,
}: RegistryContextMenuProps): React.JSX.Element {
  const [context, setContext] = useState<CapturedRegistryContext>();
  const actions: ApplicationContextMenuAction[] = [];
  if (context) {
    const { target, onAction: capturedAction } = context;
    if (target.kind === "value") {
      actions.push({
        id: "modify-value",
        label: "Modify value",
        icon: faPen,
        isDisabled: disabled,
        onAction: () => capturedAction(target, "modify-value"),
      });
    }
    actions.push({
      id: "create-key",
      label: "Create key",
      icon: faFolderPlus,
      isDisabled: disabled,
      onAction: () => capturedAction(target, "create-key"),
    }, {
      id: "write-value",
      label: "Write value",
      icon: faPen,
      isDisabled: disabled,
      onAction: () => capturedAction(target, "write-value"),
    });
    if (target.kind === "key" && target.path) {
      actions.push({
        id: "delete-key",
        label: "Delete key",
        icon: faTrash,
        isDisabled: disabled,
        separatorBefore: true,
        variant: "danger",
        onAction: () => capturedAction(target, "delete-key"),
      });
    }
  }
  const scope = useApplicationContextMenuScope({ actions });

  return (
    <div
      {...scope}
      className="contents"
      onContextMenuCapture={(event) => {
        const element = event.target instanceof Element ? event.target : undefined;
        const keyRow = element?.closest<HTMLElement>("[data-registry-hive][data-registry-path]");
        const keyHive = keyRow?.dataset["registryHive"];
        const keyPath = keyRow?.dataset["registryPath"];
        let target: RegistryContextTarget | undefined;
        if (keyRow && event.currentTarget.contains(keyRow) && isRegistryHive(keyHive) && keyPath !== undefined) {
          target = { kind: "key", hive: keyHive, path: keyPath };
        } else {
          const valueRow = element?.closest<HTMLElement>('[role="row"][data-key]');
          const grid = valueRow?.closest<HTMLElement>('[aria-label^="Registry values in "]');
          const rowKey = valueRow?.dataset["key"];
          const name = valueNames.find((value) => `value:${value}` === rowKey);
          if (
            grid && event.currentTarget.contains(grid) &&
            grid.getAttribute("aria-label") === `Registry values in ${hive} ${path}` &&
            name !== undefined
          ) {
            target = { kind: "value", hive, path, key: name };
          }
        }
        // Keep the click-time callback so the panel's navigation guard also
        // applies when a menu outlives the location from which it was opened.
        setContext(target ? { target, onAction } : undefined);
      }}
    >
      {children}
    </div>
  );
}

function isRegistryHive(hive: string | undefined): hive is SessionRegistryHive {
  return hive === "HKCR" || hive === "HKCU" || hive === "HKLM" || hive === "HKU" || hive === "HKCC";
}
