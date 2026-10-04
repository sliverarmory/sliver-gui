import { describe, expect, it, vi } from "vitest";

import { ApplicationShutdownCoordinator } from "./application-shutdown.js";

describe("ApplicationShutdownCoordinator", () => {
  it("keeps updater error handling alive through a real quit", () => {
    const stopReleaseDownloads = vi.fn();
    const disposeApplicationUpdater = vi.fn();
    const shutdown = new ApplicationShutdownCoordinator({
      stopReleaseDownloads,
      disposeApplicationUpdater,
    });

    shutdown.beginQuit();
    shutdown.beginQuit();

    expect(shutdown.isStopping).toBe(true);
    expect(stopReleaseDownloads).toHaveBeenCalledOnce();
    expect(disposeApplicationUpdater).not.toHaveBeenCalled();
  });

  it("fully disposes once for an embedding or test teardown", () => {
    const stopReleaseDownloads = vi.fn();
    const disposeApplicationUpdater = vi.fn();
    const shutdown = new ApplicationShutdownCoordinator({
      stopReleaseDownloads,
      disposeApplicationUpdater,
    });

    shutdown.disposeForEmbedding();
    shutdown.disposeForEmbedding();

    expect(stopReleaseDownloads).toHaveBeenCalledOnce();
    expect(disposeApplicationUpdater).toHaveBeenCalledOnce();
  });
});
