import { nativeImage } from "electron";
import type { RdpPreview } from "../shared/rdp-contracts.js";
import { parseRdpPreview, rdpPreviewDimensions } from "../shared/rdp-validation.js";

/** Re-encode only bounded raster pixels; never persist renderer-controlled metadata. */
export function normalizeRdpPreview(dataUrl: string): RdpPreview {
  const expected = rdpPreviewDimensions(dataUrl);
  const image = nativeImage.createFromDataURL(dataUrl);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== expected.width || size.height !== expected.height) throw new Error("Invalid RDP preview image");
  const bytes = image.toJPEG(75);
  try {
    return parseRdpPreview({ dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`, width: size.width, height: size.height, capturedAt: new Date().toISOString() });
  } finally { bytes.fill(0); }
}
