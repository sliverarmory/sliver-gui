import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Monaco's generated layout markup is trusted package code, but its original
// inline style attributes are incompatible with strict CSP. Guard every source
// seam by its pinned 0.57.0 contents before adapting those attribute emitters.
export const MONACO_CSP_SOURCE_HASHES = {
  "base/browser/domStylesheets.js": "d75d479eba46e53fe9c230958a9fdafc871218d6879c79f95ba4a2a5aed760c5",
  "base/browser/ui/contextview/contextview.js": "db02377f0d7ae080d6bea102bcb52a8b81eb8630b31885e7cfbe51c3784916a0",
  "editor/browser/view/viewLayer.js": "c0ce32a0030014328b6f9045e96a0163ae85bda0317c3db2e4e32c881e54e485",
  "editor/browser/view/viewOverlays.js": "15a3fdf4481cdd3ceef42894c642ff2a067ac3c5fce3cf2f94488248feb078c5",
  "editor/browser/view/domLineBreaksComputer.js": "2e3dd59bce1534d2201eec7686f789dd4d6713dfdb4b5bb9e725c788f47c9010",
  "editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js": "1a9d5eb1e7a0937208f811c36dc502d8b69cafa16bcd97c7bacc808854abd518",
  "editor/standalone/browser/colorizer.js": "42bc7a97dabddd0c27ebc90dbdd35ebcda04733d2547c190c7992aa1510b27e7",
  "editor/common/viewLayout/viewLineRenderer.js": "cef419ca552fab3310ebb8556cf8b7ca32c4beaacab2fe7d82836256eb7b7908",
  "editor/browser/viewParts/marginDecorations/marginDecorations.js": "2a5d690a6f0c53a51c68cf21ca7d0879c5c8c7417bfd9c28de05dd31d8470c53",
  "editor/browser/viewParts/currentLineHighlight/currentLineHighlight.js": "64dae706f05f8306ad503b8f39fad58369f54d3739bd18216b9974fbc1c21e95",
  "editor/browser/viewParts/selections/selections.js": "9de809cad373c5b339ba174c42124e9402ce668ce9faebe83a7825fbaca69a00",
  "editor/browser/viewParts/lineNumbers/lineNumbers.js": "8cca6be5800e6b290b9a437eddd5be800b6db6f5fadcbf60b6e177edaf4ea1f4",
  "editor/browser/viewParts/viewLines/viewLine.js": "1877fdcbd8d4b6838767763ee7d9b0e30bb7d24cc8877008f5b5bc378b02b72d",
  "editor/browser/viewParts/indentGuides/indentGuides.js": "df4076613b97998a0f07e582641d1874cce4bda5eaa185c54db1ca1b2259d462",
  "editor/browser/viewParts/whitespace/whitespace.js": "b6c1f88a038bfa6b4c2fe5f315aa94ecf1b4439fe79c7fe78b28fb9ba403c134",
  "editor/browser/viewParts/linesDecorations/linesDecorations.js": "a4766e1c30db6764f535ee3913998a8126f9e6c2e1f9f7949e5f2154f3ca7979",
  "editor/browser/viewParts/decorations/decorations.js": "b843de573e3bb03654e552a85c8b8420c5984fa3944a568cd8612d0e3653f4dd",
};

const STYLESHEET_CREATION = `    const style = document.createElement('style');
    style.type = 'text/css';
    style.media = 'screen';
    beforeAppend?.(style);
    container.appendChild(style);`;

const SHADOW_STYLESHEET_CREATION = `                const style = document.createElement('style');
                style.textContent = SHADOW_ROOT_CSS;
                this.shadowRoot.appendChild(style);`;

/**
 * Keep Monaco 0.57's trusted dynamic styles compatible with the existing CSP.
 * @returns {import("vite").Plugin}
 */
export function monacoCspPlugin() {
  const adapter = resolve("src/renderer/src/editor/monaco-csp-styles.ts");
  return {
    name: "monaco-strict-csp-styles",
    enforce: "pre",
    transform(source, id) {
      const path = id.replaceAll("\\", "/").split("?")[0];
      const prefix = "/monaco-editor/esm/vs/";
      const suffix = path?.includes(prefix) ? path.slice(path.indexOf(prefix) + prefix.length) : undefined;
      const expectedHash = suffix && MONACO_CSP_SOURCE_HASHES[suffix];
      if (!expectedHash) return null;
      if (createHash("sha256").update(source).digest("hex") !== expectedHash) {
        this.error("Monaco's stylesheet source changed; review its strict CSP adapter before upgrading");
      }
      let code = source;
      const replaceOnce = (expected, replacement) => {
        if (code.split(expected).length !== 2) this.error("Monaco's strict CSP adapter no longer matches its source");
        code = code.replace(expected, replacement);
      };
      if (suffix === "base/browser/domStylesheets.js") {
        replaceOnce(STYLESHEET_CREATION, `    const style = createMonacoStyleElement(container);
    beforeAppend?.(style);`);
        replaceOnce(`    const clone = globalStylesheet.cloneNode(true);
    targetWindow.document.head.appendChild(clone);`, `    const clone = createMonacoStyleElement(targetWindow.document.head);`);
        replaceOnce(`    disposables.add(sharedMutationObserver.observe(globalStylesheet, disposables, { childList: true, subtree: isFirefox, characterData: isFirefox })(() => {
        clone.textContent = globalStylesheet.textContent;
    }));`, `    disposables.add(observeMonacoStyle(globalStylesheet, clone));`);
      } else if (suffix === "base/browser/ui/contextview/contextview.js") {
        replaceOnce(SHADOW_STYLESHEET_CREATION, `                const style = createMonacoStyleElement(this.shadowRoot);
                style.textContent = SHADOW_ROOT_CSS;`);
      } else {
        // Change only the reviewed package's literal attribute emitters. User
        // source is never rewritten, interpolated into code, or evaluated.
        code = code.replaceAll('style="', 'data-monaco-style="');
        if (suffix === "editor/browser/view/viewLayer.js") {
          replaceOnce("this._domNode.innerHTML = newLinesHTML;", "this._domNode.replaceChildren(createMonacoMarkupFragment(newLinesHTML));");
          replaceOnce("lastChild.insertAdjacentHTML('afterend', newLinesHTML);", "lastChild.after(createMonacoMarkupFragment(newLinesHTML));");
          replaceOnce("hugeDomNode.innerHTML = invalidLinesHTML;", "hugeDomNode.appendChild(createMonacoMarkupFragment(invalidLinesHTML));");
        } else if (suffix === "editor/browser/view/domLineBreaksComputer.js") {
          replaceOnce("containerDomNode.innerHTML = trustedhtml;", "containerDomNode.replaceChildren(createMonacoMarkupFragment(trustedhtml));");
        } else if (suffix === "editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js" || suffix === "editor/standalone/browser/colorizer.js") {
          replaceOnce("domNode.innerHTML = trustedhtml;", "domNode.replaceChildren(createMonacoMarkupFragment(trustedhtml));");
        }
      }
      return {
        code: `import { createMonacoStyleElement, createMonacoMarkupFragment, observeMonacoStyle } from ${JSON.stringify(adapter)};\n${code}`,
        map: null,
      };
    },
  };
}
