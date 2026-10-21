// Native RDP's framebuffer budget is slightly lower than the transport limit.
const MAX_RESIZE_PIXELS = 16_000_000;
const MAX_EDGE = 8192;

export interface RdpWindowResize {
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

export function rdpWindowResize(bounds: { readonly width: number; readonly height: number }, highDpi: boolean, devicePixelRatio: number): RdpWindowResize | undefined {
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width < 200 || bounds.height < 200) return undefined;
  const density = highDpi && Number.isFinite(devicePixelRatio) ? Math.max(1, Math.min(5, devicePixelRatio)) : 1;
  const targetWidth = Math.round(bounds.width * density);
  const targetHeight = Math.round(bounds.height * density);
  const fit = Math.min(1, MAX_EDGE / targetWidth, MAX_EDGE / targetHeight, Math.sqrt(MAX_RESIZE_PIXELS / (targetWidth * targetHeight)));
  // Match the native display-control channel's even-width requirement. Flooring
  // both axes also keeps rounding from exceeding the framebuffer budget.
  const width = Math.max(200, Math.floor(targetWidth * fit / 2) * 2);
  const height = Math.max(200, Math.floor(targetHeight * fit));
  const scaleFactor = highDpi ? Math.max(100, Math.min(500, Math.round(Math.min(width / bounds.width, height / bounds.height) * 100))) : 100;
  return { width, height, scaleFactor };
}
