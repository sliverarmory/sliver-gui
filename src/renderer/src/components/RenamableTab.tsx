import { useMemo, type ReactNode } from "react";
import { Tabs } from "@heroui/react";
import { faPen } from "@fortawesome/free-solid-svg-icons";

import { useApplicationContextMenuScope } from "./ApplicationContextMenu";

export interface RenamableTabProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly id: string;
  readonly onRename: (id: string) => void;
}

/** A HeroUI tab that contributes actions only when its own header is right-clicked. */
export function RenamableTab({
  ariaLabel,
  children,
  className,
  id,
  onRename,
}: RenamableTabProps): React.JSX.Element {
  const scopeOptions = useMemo(() => ({
    actions: [{
      id: "terminal-tab.rename",
      label: "Rename",
      icon: faPen,
      onAction: () => onRename(id),
    }],
  }), [id, onRename]);
  const scope = useApplicationContextMenuScope(scopeOptions);

  return (
    <Tabs.Tab
      {...scope}
      aria-label={ariaLabel}
      id={id}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </Tabs.Tab>
  );
}
