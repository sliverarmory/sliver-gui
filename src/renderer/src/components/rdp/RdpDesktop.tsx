import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@heroui/react";
import type { RdpCursor, RdpInputEvent, RdpScaleMode, RdpTab, RdpWindowAPI } from "../../../../shared/rdp-contracts";
import { RdpDisplay } from "./rdp-display";
import { DesktopKeyboard, desktopPoint, specialKeyInputs, unicodeInputs } from "./rdp-input";
import { isRdpReady, RdpTransport } from "./rdp-transport";

export interface RdpDesktopHandle {
  focus(): void;
  release(): void;
  specialKey(kind: "ctrl-alt-delete" | "windows"): void;
  resizeToWindow(): void;
}

interface Props {
  readonly api: RdpWindowAPI;
  readonly tab: RdpTab;
  readonly active: boolean;
  readonly inputEnabled: boolean;
  readonly scaleMode: RdpScaleMode;
  readonly autoResize: boolean;
}

export const RdpDesktop = forwardRef<RdpDesktopHandle, Props>(function RdpDesktop({ api, tab, active, inputEnabled, scaleMode, autoResize }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transportRef = useRef<RdpTransport | undefined>(undefined);
  const initialSize = useRef({ width: tab.width, height: tab.height });
  const captureRef = useRef({ generation: 0, captured: false, pending: false });
  const queuedInput = useRef<RdpInputEvent[]>([]);
  const pressedButtons = useRef(new Set<number>());
  const keyboardRef = useRef(new DesktopKeyboard());
  const composingRef = useRef(false);
  const cursorBitmapRef = useRef<HTMLCanvasElement | undefined>(undefined);
  const cursorHotspotRef = useRef({ x: 0, y: 0 });
  const pointerRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const [cursorKind, setCursorKind] = useState<"default" | "hidden" | "bitmap">("default");
  const [error, setError] = useState<string>();
  const [attached, setAttached] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  const [captureState, setCaptureState] = useState<"released" | "pending" | "captured">("released");
  const [retry, setRetry] = useState(0);
  const allowedRef = useRef(false);
  allowedRef.current = attached && active && inputEnabled && tab.state === "active";

  const resizeAllowedRef = useRef(false);
  resizeAllowedRef.current = attached && active && tab.state === "active";
  const lastResizeRef = useRef<{ width: number; height: number; scaleFactor: number } | undefined>(undefined);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const sendInputs = useCallback((events: readonly RdpInputEvent[]): void => {
    if (!allowedRef.current || !transportRef.current || events.length === 0) return;
    if (!captureRef.current.captured) {
      if (captureRef.current.pending && queuedInput.current.length + events.length <= 256) queuedInput.current.push(...events);
      return;
    }
    // Composition can deliver many characters at once. Keep each control frame bounded.
    for (let offset = 0; offset < events.length; offset += 64) transportRef.current.send({ type: "input", events: events.slice(offset, offset + 64) });
  }, []);

  const release = useCallback((): void => {
    captureRef.current = { generation: captureRef.current.generation + 1, captured: false, pending: false };
    setCaptureState("released");
    queuedInput.current = [];
    pressedButtons.current.clear();
    keyboardRef.current.releaseAll();
    composingRef.current = false;
    if (inputRef.current) inputRef.current.value = "";
    transportRef.current?.send({ type: "releaseAll" });
    void api.setInputCapture({ tabId: tab.id, captured: false }).catch(() => undefined);
  }, [api, tab.id]);

  const capture = useCallback((): void => {
    if (!allowedRef.current || captureRef.current.captured || captureRef.current.pending) return;
    const generation = captureRef.current.generation;
    captureRef.current.pending = true;
    setCaptureState("pending");
    void api.setInputCapture({ tabId: tab.id, captured: true }).then((result) => {
      if (generation !== captureRef.current.generation || !allowedRef.current || document.activeElement !== inputRef.current) return;
      captureRef.current.pending = false;
      if (!result.ok) { queuedInput.current = []; setCaptureState("released"); setError(result.error); return; }
      captureRef.current.captured = true;
      setCaptureState("captured");
      const queued = queuedInput.current.splice(0);
      if (queued.length) sendInputs(queued);
    }).catch(() => {
      if (generation === captureRef.current.generation) {
        captureRef.current.pending = false; queuedInput.current = []; setCaptureState("released");
        setError("Keyboard capture could not be established. Click the desktop to retry.");
      }
    });
  }, [api, sendInputs, tab.id]);

  const focus = useCallback((): void => {
    if (!allowedRef.current) return;
    inputRef.current?.focus({ preventScroll: true });
    // Window blur releases capture without changing the focused DOM element.
    capture();
  }, [capture]);

  const resize = useCallback((): void => {
    const bounds = hostRef.current?.getBoundingClientRect();
    if (!bounds || !resizeAllowedRef.current || bounds.width < 200 || bounds.height < 200) return;
    const width = Math.min(8192, Math.max(200, Math.round(bounds.width)));
    const height = Math.min(8192, Math.max(200, Math.round(bounds.height)));
    if (width * height > 16_777_216) return;
    const scaleFactor = Math.max(100, Math.min(500, Math.round(window.devicePixelRatio * 100)));
    const previous = lastResizeRef.current;
    if (!transportRef.current || previous?.width === width && previous.height === height && previous.scaleFactor === scaleFactor) return;
    transportRef.current.send({ type: "resize", width, height, scaleFactor });
    // Keep this across reattachment and server reactivation. ResizeObserver emits
    // an initial notification whenever observation resumes, even at the same size.
    lastResizeRef.current = { width, height, scaleFactor };
  }, []);

  const cancelResize = useCallback((): void => {
    clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = undefined;
  }, []);
  const scheduleResize = useCallback((): void => {
    cancelResize();
    resizeTimerRef.current = setTimeout(() => { resizeTimerRef.current = undefined; resize(); }, 350);
  }, [cancelResize, resize]);

  useImperativeHandle(ref, () => ({ focus, release, resizeToWindow: resize, specialKey: (kind) => {
    focus();
    sendInputs(specialKeyInputs(kind));
  } }), [focus, release, resize, sendInputs]);

  const drawCursor = useCallback((): void => {
    const canvas = cursorRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const bitmap = cursorBitmapRef.current;
    const pointer = pointerRef.current;
    if (bitmap && pointer) context.drawImage(bitmap, pointer.x - cursorHotspotRef.current.x, pointer.y - cursorHotspotRef.current.y);
  }, []);

  const acceptCursor = useCallback((cursor: RdpCursor): void => {
    if (cursor.kind === "position") {
      if (!Number.isSafeInteger(cursor.x) || !Number.isSafeInteger(cursor.y) || cursor.x! < 0 || cursor.y! < 0 || cursor.x! > 8191 || cursor.y! > 8191) throw new Error("Invalid remote cursor position");
      pointerRef.current = { x: cursor.x!, y: cursor.y! };
    } else if (cursor.kind === "bitmap") {
      const { width, height, hotspotX, hotspotY, data } = cursor;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! < 1 || height! < 1 || width! > 256 || height! > 256 ||
        !Number.isSafeInteger(hotspotX) || !Number.isSafeInteger(hotspotY) || hotspotX! < 0 || hotspotY! < 0 || hotspotX! >= width! || hotspotY! >= height! ||
        !(data instanceof ArrayBuffer) || data.byteLength !== width! * height! * 4) throw new Error("Invalid remote cursor");
      const bitmap = document.createElement("canvas");
      bitmap.width = width!;
      bitmap.height = height!;
      const context = bitmap.getContext("2d");
      if (!context) throw new Error("Cursor rendering is unavailable");
      context.putImageData(new ImageData(new Uint8ClampedArray(data), width!, height!), 0, 0);
      cursorBitmapRef.current = bitmap;
      cursorHotspotRef.current = { x: hotspotX!, y: hotspotY! };
      setCursorKind("bitmap");
    } else if (cursor.kind === "default" || cursor.kind === "hidden") {
      cursorBitmapRef.current = undefined;
      setCursorKind(cursor.kind);
    } else throw new Error("Invalid remote cursor");
    drawCursor();
  }, [drawCursor]);

  const live = tab.state !== "disconnected" && tab.state !== "failed";
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !live) return;
    const controller = new AbortController();
    let transport: RdpTransport | undefined;
    let lastCursorSequence: number | undefined;
    setError(undefined);
    setAttached(false);
    setHasFrame(false);
    setFrameCount(0);
    let display: RdpDisplay;
    try { display = new RdpDisplay(canvas); }
    catch { setError("This device could not initialize the remote desktop canvas."); return; }
    void RdpTransport.open(api, tab.id, tab.attempt, controller.signal, (message) => {
      if (controller.signal.aborted) return;
      if (message.type === "ready") {
        if (!isRdpReady(message)) throw new Error("Unsupported remote desktop protocol");
        setAttached(true);
        transportRef.current?.send({ type: "snapshot" });
      } else if (message.type === "frame") {
        const committed = display.apply(message);
        transportRef.current?.send({ type: "ack", seq: message.seq });
        if (committed) {
          if (cursorRef.current && (cursorRef.current.width !== canvas.width || cursorRef.current.height !== canvas.height)) {
            cursorRef.current.width = canvas.width;
            cursorRef.current.height = canvas.height;
            drawCursor();
          }
          setHasFrame(true);
          setFrameCount((count) => count + 1);
        }
      } else if (message.type === "cursor") {
        if (!Number.isSafeInteger(message.seq) || message.seq < 1 || (lastCursorSequence !== undefined && message.seq !== lastCursorSequence + 1)) throw new Error("Invalid remote cursor sequence");
        acceptCursor(message);
        lastCursorSequence = message.seq;
        transportRef.current?.send({ type: "cursorAck", seq: message.seq });
      }
      else if (message.type === "closed") { setError("Viewer detached. Reattach to resume this remote desktop."); setAttached(false); release(); }
      else throw new Error("Unsupported remote desktop message");
    }, (message) => { if (!controller.signal.aborted) { setError(message); setAttached(false); release(); } }).then((connected) => {
      if (controller.signal.aborted) { connected.close(); return; }
      transport = connected;
      transportRef.current = connected;
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The remote desktop viewer could not attach.");
    });
    return () => {
      controller.abort();
      release();
      transport?.close();
      if (transportRef.current === transport) transportRef.current = undefined;
    };
  }, [acceptCursor, api, drawCursor, live, release, retry, tab.attempt, tab.id]);

  useEffect(() => {
    if (!active || !inputEnabled) { release(); inputRef.current?.blur(); }
  }, [active, inputEnabled, release]);

  useEffect(() => {
    window.addEventListener("blur", release);
    const visibility = (): void => { if (document.hidden) release(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", release); document.removeEventListener("visibilitychange", visibility); };
  }, [release]);

  useEffect(() => {
    if (!autoResize || !active || !attached || !hostRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(hostRef.current);
    return () => { cancelResize(); observer.disconnect(); };
  }, [active, attached, autoResize, cancelResize, scheduleResize]);

  useEffect(() => {
    // A window may have changed size while the server was reconnecting. Apply
    // that latest size once active without replacing the observer for each phase.
    if (autoResize && active && attached && tab.state === "active") scheduleResize();
    else cancelResize();
    return cancelResize;
  }, [active, attached, autoResize, cancelResize, scheduleResize, tab.state]);

  const point = useCallback((event: { clientX: number; clientY: number }): { x: number; y: number } | undefined => {
    const canvas = canvasRef.current;
    if (!canvas || !allowedRef.current) return undefined;
    const box = canvas.getBoundingClientRect();
    const ratio = scaleMode === "fit" ? Math.min(box.width / canvas.width, box.height / canvas.height) : 1;
    const bounds = { left: box.left + (box.width - canvas.width * ratio) / 2, top: box.top + (box.height - canvas.height * ratio) / 2,
      width: canvas.width * ratio, height: canvas.height * ratio };
    return desktopPoint(event.clientX, event.clientY, bounds, canvas.width, canvas.height);
  }, [scaleMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const wheel = (event: WheelEvent): void => {
      const position = point(event);
      if (!position) return;
      // React's wheel listener is passive; prevent the local actual-size viewport
      // from scrolling alongside the remote application.
      event.preventDefault();
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
      const vertical = Math.round(Math.max(-32767, Math.min(32767, -event.deltaY * multiplier)));
      const horizontal = Math.round(Math.max(-32767, Math.min(32767, event.deltaX * multiplier)));
      if (vertical) sendInputs([{ kind: "mouse", ...position, wheel: vertical, horizontal: false }]);
      if (horizontal) sendInputs([{ kind: "mouse", ...position, wheel: horizontal, horizontal: true }]);
    };
    host.addEventListener("wheel", wheel, { passive: false });
    return () => host.removeEventListener("wheel", wheel);
  }, [point, sendInputs]);

  return <div className="rdp-viewer" data-active={active}>
    <div className="rdp-screen" data-application-context-menu-policy="inspect-only" data-scale={scaleMode} data-cursor={cursorKind} data-frame-count={frameCount} data-input-capture={captureState} ref={hostRef}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        const position = point(event);
        const button = pointerButton(event.button);
        if (!position || !button) return;
        event.preventDefault();
        pressedButtons.current.add(event.button);
        focus();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        sendInputs([{ kind: "mouse", ...position, button, down: true }]);
      }}
      onPointerUp={(event) => {
        pressedButtons.current.delete(event.button);
        const position = point(event);
        const button = pointerButton(event.button);
        if (position && button) sendInputs([{ kind: "mouse", ...position, button, down: false }]);
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={release}
      onLostPointerCapture={() => { if (pressedButtons.current.size) release(); }}
      onPointerMove={(event) => {
        const position = point(event);
        if (!position) return;
        pointerRef.current = position;
        drawCursor();
        sendInputs([{ kind: "mouse", ...position }]);
      }}
      onPointerLeave={() => { pointerRef.current = undefined; drawCursor(); }}>
      <canvas aria-label={`Remote desktop for ${tab.label}`} className="rdp-screen__canvas" ref={canvasRef} width={initialSize.current.width} height={initialSize.current.height} />
      <canvas aria-hidden className="rdp-screen__cursor" ref={cursorRef} width={initialSize.current.width} height={initialSize.current.height} />
      <textarea aria-label={`Keyboard input for ${tab.label}`} className="rdp-screen__input" ref={inputRef} autoCapitalize="off" autoComplete="off" spellCheck={false}
        tabIndex={active && inputEnabled ? 0 : -1}
        onFocus={capture}
        onBlur={release}
        onKeyDown={(event) => {
          if (!allowedRef.current) return;
          if (event.ctrlKey && event.altKey && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); release(); inputRef.current?.blur(); return; }
          if (event.nativeEvent.isComposing || composingRef.current || event.key === "Dead" || event.key === "Process") return;
          event.preventDefault();
          event.stopPropagation();
          sendInputs(keyboardRef.current.keyDown(event.nativeEvent));
        }}
        onKeyUp={(event) => { event.preventDefault(); event.stopPropagation(); sendInputs(keyboardRef.current.keyUp(event.nativeEvent)); }}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(event) => { composingRef.current = false; sendInputs(unicodeInputs(event.data)); event.currentTarget.value = ""; }}
        onInput={(event) => { if (!composingRef.current && event.currentTarget.value) { sendInputs(unicodeInputs(event.currentTarget.value)); event.currentTarget.value = ""; } }} />
      {(!hasFrame || error || !live) && <div className="rdp-screen__message" role={error ? "alert" : "status"}>
        <p className="text-sm">{live ? error ?? tab.error ?? (tab.state === "active" ? "Waiting for the remote desktop…" : phaseLabel(tab.state)) : tab.error ?? phaseLabel(tab.state)}</p>
        {error && live ? <Button size="sm" variant="secondary" onPress={() => setRetry((value) => value + 1)}>Reattach viewer</Button> : null}
      </div>}
    </div>
  </div>;
});

function pointerButton(button: number): "left" | "middle" | "right" | "back" | "forward" | undefined {
  return (["left", "middle", "right", "back", "forward"] as const)[button];
}

export function phaseLabel(phase: RdpTab["state"]): string {
  switch (phase) {
    case "connecting": return "Connecting…";
    case "certificate-review": return "Review the server certificate";
    case "authenticating": return "Signing in…";
    case "active": return "Connected";
    case "disconnected": return "Disconnected";
    case "failed": return "Connection failed";
  }
}
