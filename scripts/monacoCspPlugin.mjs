import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Monaco's generated layout markup is trusted package code, but its original
// inline style attributes are incompatible with strict CSP. Guard every source
// seam by its pinned 0.56.0 contents before adapting those attribute emitters.
export const MONACO_CSP_SOURCE_HASHES = {
  "base/browser/domStylesheets.js": "d75d479eba46e53fe9c230958a9fdafc871218d6879c79f95ba4a2a5aed760c5",
  "base/browser/ui/contextview/contextview.js": "02fa681986193a16bf184f511bfb8528f135b9d2c73877ce18b8deb45ac2ae38",
  "editor/browser/view/viewLayer.js": "47df5b51f88619a7ed310087703a986ad39fee79108322369a2cb9427af68370",
  "editor/browser/view/viewOverlays.js": "02d1e4769506d0778716f75cbafc9641242fd52cba08213aea77b297971960bb",
  "editor/browser/view/domLineBreaksComputer.js": "52cb9e5b400a7a317d695a1bc59017fc5e1e5e4faab7b0a7046a432662d03bfb",
  "editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js": "27ad6e124e1dc70c868062f92a8fcb1f32b8d5d9a6904d3f7546597b74e12a15",
  "editor/standalone/browser/colorizer.js": "42bc7a97dabddd0c27ebc90dbdd35ebcda04733d2547c190c7992aa1510b27e7",
  "editor/common/viewLayout/viewLineRenderer.js": "91f068e663d6ade4d62a4cd7a5aff9e03fbcdeb3e858cbdbd8246985e9e5eb52",
  "editor/browser/viewParts/marginDecorations/marginDecorations.js": "2a5d690a6f0c53a51c68cf21ca7d0879c5c8c7417bfd9c28de05dd31d8470c53",
  "editor/browser/viewParts/currentLineHighlight/currentLineHighlight.js": "bf81f14a1ac9343b1f3c0f81ff1a6ae692fdc9757291268d1ee2d07f410748f4",
  "editor/browser/viewParts/selections/selections.js": "9de809cad373c5b339ba174c42124e9402ce668ce9faebe83a7825fbaca69a00",
  "editor/browser/viewParts/lineNumbers/lineNumbers.js": "1ec7e3be24743bcc7a4930d6bcd36eb7434bfb79ce1441bf76fb4748081aea13",
  "editor/browser/viewParts/viewLines/viewLine.js": "1483a04e95f9963797abd5425d63fea662295a1f8642e617703c4d35d270fcfd",
  "editor/browser/viewParts/indentGuides/indentGuides.js": "603452d331348a12ee97999abeddcba1ed25c4a6b7815e2c81483f07c0f2815f",
  "editor/browser/viewParts/whitespace/whitespace.js": "37975d394550244aa90647beb8e9f098beadf67e83f019ec34550724b51c70dd",
  "editor/browser/viewParts/linesDecorations/linesDecorations.js": "8760dd3f7519acaa8f1e5ed263be4231c53703e0be324477a27c23b681f5c3c5",
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
 * Keep Monaco 0.56's trusted dynamic styles compatible with the existing CSP.
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
