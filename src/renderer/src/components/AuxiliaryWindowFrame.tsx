import type { ReactNode } from "react";

/** Keeps auxiliary window content below the macOS hiddenInset controls. */
export function AuxiliaryWindowFrame({ children, className = "", ariaLabel }: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly ariaLabel?: string;
}): React.JSX.Element {
  const inset = globalThis.navigator?.platform.startsWith("Mac") ?? false;
  return (
    <div
      className="auxiliary-window-frame flex h-screen flex-col overflow-hidden bg-background"
      data-titlebar-style={inset ? "hiddenInset" : "default"}
    >
      {inset ? <div aria-hidden="true" className="auxiliary-window-titlebar" /> : null}
      <main aria-label={ariaLabel} className={`min-h-0 flex-1 ${className}`}>{children}</main>
    </div>
  );
}
