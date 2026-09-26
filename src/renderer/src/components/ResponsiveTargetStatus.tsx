import { useLayoutEffect, useRef, useState } from "react";
import { Chip } from "@heroui/react";

interface ResponsiveTargetStatusProps {
  label: string;
  color: "success" | "danger" | "warning" | "default";
}

export function ResponsiveTargetStatus({ label, color }: ResponsiveTargetStatusProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const [isCompact, setIsCompact] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const badge = badgeRef.current;
    if (!container || !badge) return;
    const measure = () => {
      const availableWidth = container.getBoundingClientRect().width;
      const badgeWidth = badge.getBoundingClientRect().width;
      if (availableWidth > 0 && badgeWidth > 0) setIsCompact(badgeWidth > availableWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(badge);
    return () => observer.disconnect();
  }, [label, color]);

  return (
    <div className="target-status-cell" data-compact={isCompact} ref={containerRef}>
      <Chip
        aria-hidden={isCompact || undefined}
        className="target-status-cell__badge"
        color={color}
        ref={badgeRef}
        size="sm"
        variant="soft"
      >
        {label}
      </Chip>
      {isCompact ? (
        <span aria-label={label} className="target-status-cell__dot" data-color={color} role="img" title={label} />
      ) : null}
    </div>
  );
}
