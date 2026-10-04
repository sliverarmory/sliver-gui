export interface ApplicationShutdownServices {
  readonly stopReleaseDownloads: () => void;
  readonly disposeApplicationUpdater: () => void;
}

/**
 * Coordinates application shutdown without tearing down electron-updater too
 * early. Its autoInstallOnAppQuit path runs on Electron's `quit` event, after
 * `before-quit`, and can still emit an error that needs the backend listener.
 */
export class ApplicationShutdownCoordinator {
  readonly #services: ApplicationShutdownServices;
  #stopping = false;
  #disposed = false;

  constructor(services: ApplicationShutdownServices) {
    this.#services = services;
  }

  get isStopping(): boolean {
    return this.#stopping;
  }

  beginQuit(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#services.stopReleaseDownloads();
  }

  disposeForEmbedding(): void {
    this.beginQuit();
    if (this.#disposed) return;
    this.#disposed = true;
    this.#services.disposeApplicationUpdater();
  }
}
