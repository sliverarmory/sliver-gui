import { useMemo } from "react";

import type { WebsiteContentDetail } from "../../../shared/website-contracts";
import { websitePreviewLanguage } from "../editor/website-preview-languages";
import { WebsiteSourceEditor } from "./WebsiteSourceEditor";
import { createWebsiteContentPreview } from "./website-content-preview";

/** Source uses a read-only syntax viewer. Rendered content belongs in the isolated native window. */
export function WebsiteContentPreview({ content }: { readonly content: WebsiteContentDetail }): React.JSX.Element {
  const preview = useMemo(() => createWebsiteContentPreview(content), [content]);

  return (
    <section aria-label="Website content preview" className="min-w-0 space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{preview.mode === "hex" ? "Hex Preview" : "Source Preview"}</h3>
        <p className="text-xs leading-5 text-muted">Read-only source with syntax highlighting. Scripts, links, styles, and embedded resources stay inactive.</p>
      </div>
      {preview.mode === "source" || preview.mode === "hex" ? (
        <>
          {preview.mode === "source" ? <WebsiteSourceEditor
            ariaLabel="Website content source"
            language={websitePreviewLanguage(content.item.contentType, content.item.path)}
            text={preview.text}
          /> : <pre
            aria-label="Website content hex"
            className="max-h-[52vh] overflow-auto whitespace-pre rounded-xl border border-separator bg-surface-secondary p-4 font-mono text-xs leading-5 text-foreground"
            dir="ltr"
            tabIndex={0}
          >{preview.text}</pre>}
          {preview.truncated ? (
            <p className="text-xs tabular-nums text-muted" role="status">Preview limited to the first {preview.shownBytes.toLocaleString()} bytes. The hosted content is unchanged.</p>
          ) : null}
        </>
      ) : (
        <p className="rounded-xl bg-surface-secondary p-4 text-sm text-muted" role="status">
          {preview.mode === "empty" ? "This file is empty." : preview.mode === "too-large"
            ? "This file exceeds the preview size limit. Export it to inspect the complete content."
            : "The server did not return content bytes for this file. Its metadata can still be managed."}
        </p>
      )}
    </section>
  );
}
