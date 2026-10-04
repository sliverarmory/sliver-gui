import { useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { useSidebar } from "@heroui-pro/react/sidebar";
import type { ApplicationZoomAPI } from "../../../shared/application-zoom-contracts";

export function SidebarZoomControls({ api = window.applicationZoom }: { api?: ApplicationZoomAPI }) {
  const [zoomFactor, setZoomFactor] = useState(() => api?.getFactor() ?? 1);
  const { collapsible, isMobile, isOpen } = useSidebar();
  const isIconCollapsed = collapsible === "icon" && !isMobile && !isOpen;

  useEffect(() => {
    if (!api) return;
    const unsubscribe = api.onChanged(setZoomFactor);
    setZoomFactor(api.getFactor());
    return unsubscribe;
  }, [api]);

  if (!api || Math.abs(zoomFactor - 1) < 0.0001) return null;

  return (
    <div
      aria-label="Window zoom"
      className={`flex items-center text-[11px] text-muted ${isIconCollapsed
        ? "flex-col gap-0.5"
        : "justify-between gap-2 px-3"}`}
      role="group"
    >
      <span aria-live="polite" aria-atomic="true" className="whitespace-nowrap tabular-nums">
        <span className={isIconCollapsed ? "sr-only" : undefined}>Zoom </span>
        {Math.round(zoomFactor * 100)}%
      </span>
      <Button
        aria-label="Reset zoom"
        className="h-6 min-w-0 shrink-0 px-2 text-[11px] font-normal text-muted"
        onPress={() => {
          api.reset();
          setZoomFactor(api.getFactor());
        }}
        size="sm"
        variant="ghost"
      >
        Reset
      </Button>
    </div>
  );
}
