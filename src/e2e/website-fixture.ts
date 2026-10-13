import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { clientpb } from "sliver-script";

/** A copy-owning fixture matching the pinned server's website RPC behavior. */
export function createWebsiteFixture(
  record: (method: string) => void,
  changed: () => void,
  beforeAddContent?: () => Promise<void>,
) {
  const sites = new Map<string, clientpb.Website>();
  const clone = (site: clientpb.Website) => clientpb.Website.create({
    ...site,
    Contents: Object.fromEntries(Object.entries(site.Contents).map(([path, content]) => [path, {
      ...content, Content: Buffer.from(content.Content),
    }])),
  });
  const requireSite = (name: string) => {
    const site = sites.get(name);
    if (!site) throw new Error("Unknown website");
    return site;
  };
  const ensureSite = (name: string) => {
    if (!sites.has(name)) sites.set(name, clientpb.Website.create({ ID: randomUUID(), Name: name }));
    return requireSite(name);
  };
  const store = (site: clientpb.Website, input: clientpb.WebContent) => {
    const current = site.Contents[input.Path];
    const bytes = input.Content.byteLength > 0 ? Buffer.from(input.Content) : Buffer.from(current?.Content ?? []);
    site.Contents[input.Path] = clientpb.WebContent.create({
      ...current,
      ID: current?.ID ?? randomUUID(), WebsiteID: site.ID, Path: input.Path,
      ContentType: input.ContentType || current?.ContentType || detectedContentType(input.Path),
      OriginalFile: input.OriginalFile || current?.OriginalFile || input.Path.split("/").at(-1) || "content",
      Content: bytes, Size: String(bytes.byteLength),
      Sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  };
  store(ensureSite("landing"), clientpb.WebContent.create({
    Path: "/index.html", ContentType: "text/html", Content: Buffer.from("<!doctype html><h1>Welcome</h1>"),
  }));
  return {
    async websites() { record("websites"); return [...sites.values()].map(clone); },
    async website(name: string) { record("website"); return clone(requireSite(name)); },
    async websiteAddContent(name: string, contents: Record<string, clientpb.WebContent>) {
      await beforeAddContent?.();
      record("websiteAddContent");
      const site = ensureSite(name);
      for (const content of Object.values(contents)) store(site, content);
      changed();
      return clone(site);
    },
    async websiteUpdateContent(name: string, contents: Record<string, clientpb.WebContent>) {
      record("websiteUpdateContent");
      const site = requireSite(name);
      for (const content of Object.values(contents)) store(site, content);
      changed();
      return clone(site);
    },
    async websiteRemoveContent(name: string, paths: string[]) {
      record("websiteRemoveContent");
      const site = requireSite(name);
      for (const path of paths) delete site.Contents[path];
      changed();
      return clone(site);
    },
    async websiteRemove(name: string) {
      record("websiteRemove"); requireSite(name); sites.delete(name); changed();
    },
  };
}

/** The pinned RPC chooses MIME by extension when upload ContentType is blank. */
function detectedContentType(path: string): string {
  switch (posix.extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "text/html; charset=utf-8";
  }
}
