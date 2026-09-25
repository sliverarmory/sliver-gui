import { useEffect, useRef, type ReactNode } from "react";
import { ScrollShadow } from "@heroui/react";

/** Keeps the history fade in sync when entries arrive without resizing the viewport. */
export function ExecutionHistoryScrollShadow({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => viewport.dispatchEvent(new Event("scroll")));
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <ScrollShadow
      ref={viewportRef}
      className="mt-1 max-h-40 min-h-0 overflow-y-auto pr-1 sm:h-0 sm:max-h-none sm:flex-1"
      hideScrollBar={false}
      orientation="vertical"
      size={24}
    >
      <div ref={contentRef}>{children}</div>
    </ScrollShadow>
  );
}
