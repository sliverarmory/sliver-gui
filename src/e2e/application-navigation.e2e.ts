import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { _electron as electron, type ElectronApplication } from "playwright-core";

const RENDERER_URL = "sliver://app/index.html";

test("application hooks confine newly created windows and views to sliver documents", {
  timeout: 90_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-navigation-e2e-"));
  const directories = {
    saved: join(temporaryRoot, "saved-configs"),
    managed: join(temporaryRoot, "managed-configs"),
    user: join(temporaryRoot, "user-data"),
    client: join(temporaryRoot, "client-root"),
  };
  const outsideFile = join(temporaryRoot, "outside.html");
  await Promise.all([
    ...Object.values(directories).map((directory) => mkdir(directory, { recursive: true })),
    writeFile(outsideFile, "<!doctype html><title>Benign external document</title>"),
  ]);
  const requests: string[] = [];
  let connections = 0;
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Benign HTTP document</title>");
  });
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  let application: ElectronApplication | undefined;
  try {
    // fake-main imports the real application module. Do not install the guard
    // here: removing the application-wide registration must break this test.
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${directories.saved}`,
        `--managed-config-directory=${directories.managed}`,
        `--user-data-directory=${directories.user}`,
        `--console-client-root-directory=${directories.client}`,
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
      timeout: 20_000,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const electronProcess = application.process();
    context.signal.addEventListener("abort", () => { electronProcess.kill("SIGKILL"); }, { once: true });
    const mainPage = await application.firstWindow();
    await mainPage.getByRole("dialog", { name: "Saved configurations" }).waitFor({ timeout: 20_000 });
    assert.equal(mainPage.url(), RENDERER_URL);

    const surfaces = await application.evaluate(async ({ BrowserWindow, WebContentsView, session }, url) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { partition: "navigation-e2e-window", sandbox: true },
      });
      const view = new WebContentsView({
        webPreferences: { partition: "navigation-e2e-view", sandbox: true },
      });
      window.contentView.addChildView(view);
      for (const contents of [window.webContents, view.webContents]) {
        // This deliberately permissive fixture has no CSP or host filtering,
        // making document confinement depend on the global navigation hooks.
        contents.session.protocol.handle("sliver", (request) => {
          const redirect = new URL(request.url).searchParams.get("redirect");
          if (redirect) return new Response(null, { status: 302, headers: { location: redirect } });
          return new Response(
            "<!doctype html><title>Navigation fixture</title><body>Benign application document</body>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        });
        await contents.loadURL(url);
      }
      return [
        { kind: "BrowserWindow", id: window.webContents.id },
        { kind: "WebContentsView", id: view.webContents.id },
      ].map((surface) => ({
        ...surface,
        freshSession: (surface.kind === "BrowserWindow" ? window.webContents : view.webContents).session !==
          session.defaultSession,
      }));
    }, RENDERER_URL);
    assert.ok(surfaces.every((surface) => surface.freshSession));

    const blockedUrls = [
      `http://127.0.0.1:${address.port}/outside`,
      `https://127.0.0.1:${address.port}/outside`,
      pathToFileURL(outsideFile).href,
      "data:text/html,<title>Benign data document</title>",
      "about:blank",
      "sliver://other/index.html",
      "sliver://app/other.html",
      "devtools://devtools/bundled/inspector.html",
    ];

    for (const surface of surfaces) {
      const allowedUrl = `${RENDERER_URL}?surface=navigation-fixture#${surface.kind}`;
      const allowed: { url: string; title: string } = await application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents) throw new Error("Navigation fixture disappeared");
        await contents.loadURL(input.url);
        await contents.executeJavaScript("location.hash = 'in-page'; undefined");
        await new Promise<void>((accept, reject) => {
          const timeout = setTimeout(() => reject(new Error("Allowed reload timed out")), 5_000);
          contents.once("did-finish-load", () => { clearTimeout(timeout); accept(); });
          contents.reload();
        });
        return { url: contents.getURL(), title: contents.getTitle() };
      }, { id: surface.id, url: allowedUrl });
      assert.equal(allowed.url, `${RENDERER_URL}?surface=navigation-fixture#in-page`);
      assert.equal(allowed.title, "Navigation fixture");

      for (const url of blockedUrls) {
        const result: { url: string; title: string; failure: string | undefined } = await application.evaluate(async ({ webContents }, input) => {
          const contents = webContents.fromId(input.id);
          if (!contents) throw new Error("Navigation fixture disappeared");
          let failure: string | undefined;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              contents.loadURL(input.url),
              new Promise<never>((_accept, reject) => {
                timeout = setTimeout(() => reject(new Error("Navigation attempt timed out")), 5_000);
              }),
            ]);
          } catch (error) {
            failure = String(error);
          } finally {
            clearTimeout(timeout);
          }
          return { url: contents.getURL(), failure, title: contents.getTitle() };
        }, { id: surface.id, url });
        assert.ok(result.failure, `${surface.kind} must reject main-process loadURL(${url})`);
        assert.doesNotMatch(result.failure, /timed out/u, "blocking must settle the navigation promise");
        assert.equal(result.url, allowed.url, `${surface.kind} must retain its application document after ${url}`);
        assert.equal(result.title, allowed.title);
      }

      const fileNavigation: { rejected: boolean; url: string } = await application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents) throw new Error("Navigation fixture disappeared");
        let rejected = false;
        try {
          await contents.loadFile(input.path);
        } catch {
          rejected = true;
        }
        return { rejected, url: contents.getURL() };
      }, { id: surface.id, path: outsideFile });
      assert.equal(fileNavigation.rejected, true, `${surface.kind} must reject loadFile`);
      assert.equal(fileNavigation.url, allowed.url);

      for (const url of blockedUrls) {
        const result: { url: string; title: string } = await application.evaluate(async ({ webContents }, input) => {
          const contents = webContents.fromId(input.id);
          if (!contents) throw new Error("Navigation fixture disappeared");
          await contents.executeJavaScript(`(() => {
            const link = document.createElement('a');
            link.href = ${JSON.stringify(input.url)};
            document.body.append(link);
            link.click();
            link.remove();
          })()`);
          // A prevented renderer navigation has no completion event; allow one
          // bounded event-loop interval for Chromium to process the click.
          await new Promise((accept) => setTimeout(accept, 100));
          return { url: contents.getURL(), title: contents.getTitle() };
        }, { id: surface.id, url }).catch((error: unknown) => {
          throw new Error(`${surface.kind} renderer navigation failed for ${url}`, { cause: error });
        });
        assert.equal(result.url, allowed.url, `${surface.kind} must block renderer navigation to ${url}`);
        assert.equal(result.title, allowed.title);
      }

      const popup: { denied: boolean; before: number; after: number } = await application.evaluate(async ({ BrowserWindow, webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents) throw new Error("Navigation fixture disappeared");
        const before = BrowserWindow.getAllWindows().length;
        const denied = await contents.executeJavaScript(
          `window.open(${JSON.stringify(input.url)}) === null`, true,
        );
        return { denied, before, after: BrowserWindow.getAllWindows().length };
      }, { id: surface.id, url: RENDERER_URL });
      assert.equal(popup.denied, true);
      assert.equal(popup.after, popup.before);

      const frameNavigation: { url: string; frames: string[] } = await application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents) throw new Error("Navigation fixture disappeared");
        await contents.executeJavaScript(`(() => {
          for (const url of ${JSON.stringify(input.urls)}) {
            const frame = document.createElement('iframe');
            frame.src = url;
            document.body.append(frame);
          }
        })()`);
        // App documents never use iframes. The child browsing contexts may
        // exist in their initial empty state, but neither document may load.
        await new Promise((accept) => setTimeout(accept, 100));
        return { url: contents.getURL(), frames: contents.mainFrame.frames.map((frame) => frame.url) };
      }, { id: surface.id, urls: [RENDERER_URL, blockedUrls[0]!] });
      assert.equal(frameNavigation.url, allowed.url);
      assert.equal(frameNavigation.frames.length, 2);
      for (const url of frameNavigation.frames) {
        assert.ok(url === "" || url === "about:blank", `${surface.kind} must deny child-frame document loads: ${url}`);
      }

      const redirectUrl = `${RENDERER_URL}?redirect=${encodeURIComponent(blockedUrls[0]!)}`;
      const redirect: { rejected: boolean; url: string } = await application.evaluate(async ({ webContents }, input) => {
        const contents = webContents.fromId(input.id);
        if (!contents) throw new Error("Navigation fixture disappeared");
        let rejected = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            contents.loadURL(input.url),
            new Promise<never>((_accept, reject) => {
              timeout = setTimeout(() => reject(new Error("Redirect test timed out")), 5_000);
            }),
          ]);
        } catch (error) {
          if (String(error).includes("timed out")) throw error;
          rejected = true;
        } finally {
          clearTimeout(timeout);
        }
        return { rejected, url: contents.getURL() };
      }, { id: surface.id, url: redirectUrl });
      assert.equal(redirect.rejected, true, `${surface.kind} must reject an external redirect`);
      assert.ok([allowed.url, redirectUrl].includes(redirect.url), `${surface.kind} must remain on an application URL after a redirect`);
    }
    assert.deepEqual(requests, [], "blocked document requests must never reach the HTTP server");
    assert.equal(connections, 0, "blocked HTTP and HTTPS documents must never establish a connection");

    // Exercise managed application windows too: a blocked navigation must not
    // accidentally trigger the normal renderer teardown and discard its view.
    await mainPage.evaluate("location.href = 'about:blank'; undefined");
    await mainPage.waitForTimeout(100);
    assert.equal(mainPage.url(), RENDERER_URL);
    await mainPage.getByRole("dialog", { name: "Saved configurations" }).waitFor({ timeout: 5_000 });
    const cloudOpened = application.waitForEvent("window", { timeout: 10_000 });
    await mainPage.getByRole("button", { name: "Cloud Deployment", exact: true }).click();
    const cloudPage = await cloudOpened;
    await cloudPage.getByRole("heading", { name: "Managed Servers", exact: true }).waitFor({ timeout: 10_000 });
    await cloudPage.evaluate("location.href = 'about:blank'; undefined");
    await cloudPage.waitForTimeout(100);
    assert.equal(cloudPage.url(), `${RENDERER_URL}?surface=cloud-deployment`);
    await cloudPage.getByRole("heading", { name: "Managed Servers", exact: true }).waitFor({ timeout: 5_000 });

    const devTools = await application.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id);
      if (!contents) throw new Error("Navigation fixture disappeared");
      try {
        await new Promise<void>((accept, reject) => {
          const timeout = setTimeout(() => reject(new Error("DevTools failed to open")), 8_000);
          contents.once("devtools-opened", () => { clearTimeout(timeout); accept(); });
          contents.openDevTools({ mode: "detach", activate: false });
        });
        return { type: contents.devToolsWebContents?.getType(), url: contents.devToolsWebContents?.getURL() };
      } finally {
        contents.closeDevTools();
      }
    }, surfaces[0]!.id);
    assert.equal(devTools.type, "remote");
    assert.ok(devTools.url?.startsWith("devtools://devtools/"));
  } finally {
    if (application) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        application.close().then(() => true, () => false),
        new Promise<false>((accept) => { timeout = setTimeout(() => accept(false), 5_000); }),
      ]);
      clearTimeout(timeout);
      if (!closed) application.process().kill("SIGKILL");
    }
    server.closeAllConnections();
    await new Promise<void>((accept) => server.close(() => accept()));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
