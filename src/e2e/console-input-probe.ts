interface ConsoleInputProbe {
  readonly readlineReady: boolean;
  readonly commandEchoed: boolean;
  readonly outputBytes: number;
}

interface ConsoleProbePort {
  addEventListener(type: "message", listener: (message: {
    data: { type?: string; data?: ArrayBuffer };
  }) => void): void;
}

export interface ConsoleProbeBrowser {
  __SLIVER_GUI_PACKAGED_CONSOLE_INPUT__?: ConsoleInputProbe;
  addEventListener(type: "message", listener: (event: {
    data?: { source?: string; type?: string };
    ports: ConsoleProbePort[];
  }) => void): void;
}

// Keep this function self-contained: Playwright serializes it as an init script.
export function observeConsoleInput(
  browser: ConsoleProbeBrowser = globalThis as unknown as ConsoleProbeBrowser,
): void {
  const probe = { readlineReady: false, commandEchoed: false, outputBytes: 0 };
  browser.__SLIVER_GUI_PACKAGED_CONSOLE_INPUT__ = probe;
  let outputTail = "";
  const decoder = new TextDecoder();
  browser.addEventListener("message", (event) => {
    if (event.data?.source !== "sliver-preload" || event.data.type !== "console-stream-port") return;
    // Observe before the normal transport consumes and scrubs each frame.
    // Leave port activation, credit and all input/output handling to the app.
    event.ports[0]?.addEventListener("message", ({ data: frame }) => {
      if (frame.type !== "data" || !(frame.data instanceof ArrayBuffer)) return;
      probe.outputBytes += frame.data.byteLength;
      outputTail = `${outputTail}${decoder.decode(frame.data, { stream: true })}`.slice(-16_384);
      // Retain cursor-visible controls while removing SGR and other CSI
      // controls. Readline shows its cursor only after finishing the query.
      const text = outputTail.replace(/\u001b\[(?!\?25h)[0-?]*[ -/]*[@-~]/gu, "");
      probe.readlineReady ||= /sliver > [\s\S]*\u001b\[\?25h/u.test(text);
      probe.commandEchoed ||= text.includes("sliver > version");
    });
  });
}
