# License and source notice

Sliver GUI is copyright (C) 2026 Sliver GUI contributors.

Sliver GUI is distributed under the GNU General Public License, version 3 or
later. The canonical license text is in `LICENSE`, with an SPDX-named copy in
`LICENSES/GPL-3.0-or-later.txt`. Sliver GUI is not dual-licensed under MIT or
Apache-2.0; those texts apply only to the separately identified third-party
components described below.

Portions of Sliver GUI originated from Angular Electron, copyright (c) 2018
Maxime Gris, and were provided under the MIT License. The MIT license text is
reproduced in `LICENSES/MIT.txt`; that attribution does not change the license
of the combined Sliver GUI application.

The application bundles `sliver-script` version 2.0.0-rc.2, the TypeScript
client for the Sliver Implant Framework, copyright Bishop Fox. It is
distributed under GPL-3.0-or-later. Native packages retain the exact published
npm package's license, source, build metadata, and protobuf/integration locks
under `node_modules/sliver-script/`; registry and source-tag provenance are
pinned in `protocol/sliver-script-provenance.json`.

The application bundles `ghostty-web` version 0.4.0, including its
`ghostty-vt.wasm` terminal runtime. Ghostty Web is copyright (c) 2025 Coder and
is distributed under the MIT License. Its package, source commit, npm integrity,
upstream Ghostty submodule commit, runtime size, and SHA-256 are pinned in
`protocol/ghostty-web-provenance.json`; the complete MIT license text is
available in `LICENSES/MIT.txt`, the retained package license, and the generated
`dist/THIRD_PARTY_LICENSES.txt` shipped with native packages. Source:
https://github.com/coder/ghostty-web

The application bundles `node-pty` version 1.1.0 to run the native Sliver
client inside a main-process-owned pseudoterminal. Node-pty is copyright
Microsoft Corporation and other contributors and is distributed under the MIT
License. Its retained package license and the complete MIT text are included in
the native package and generated dependency inventory. Source:
https://github.com/microsoft/node-pty

The renderer embeds the following unmodified terminal font files under the SIL
Open Font License, Version 1.1. The complete OFL text is reproduced in
`LICENSES/OFL-1.1.txt`, and exact source tags, commits, URLs, sizes, and SHA-256
digests are pinned in `protocol/terminal-fonts-provenance.json`:

- Fira Code 6.2: Copyright (c) 2014, The Fira Code Project Authors
  (https://github.com/tonsky/FiraCode).
- JetBrains Mono 2.304: Copyright 2020 The JetBrains Mono Project Authors
  (https://github.com/JetBrains/JetBrainsMono).
- Cascadia Mono 2407.24: Copyright (c) 2019 - Present, Microsoft Corporation,
  with Reserved Font Name Cascadia Code.
- Source Code Pro 2.042R-u/1.062R-i/1.026R-vf: © 2023 Adobe
  (http://www.adobe.com/), with Reserved Font Name 'Source'. All Rights
  Reserved. Source is a trademark of Adobe in the United States and/or other
  countries.

These font notices and the OFL terms apply only to the named font files and do
not dual-license Sliver GUI. Source repositories:
https://github.com/tonsky/FiraCode,
https://github.com/JetBrains/JetBrainsMono,
https://github.com/microsoft/cascadia-code, and
https://github.com/adobe-fonts/source-code-pro.

The application uses the open-source `@heroui/react` and `@heroui/styles`
packages. Version 3.2.4 has conflicting upstream metadata: the package
manifests declare MIT, while the bundled licenses and upstream release history
identify Apache-2.0. Sliver GUI preserves the bundled Apache-2.0 text in
`LICENSES/Apache-2.0.txt` and the generated dependency inventory without
interpreting the metadata discrepancy as an additional license grant.

The complete corresponding source for a released binary is the Sliver GUI
repository at the matching version tag together with the retained source for
the exact published `sliver-script` package:

https://github.com/sliverarmory/sliver-gui
https://github.com/sliverarmory/sliver-script/tree/v2.0.0-rc.2

GitHub release pages provide source archives for the matching tag alongside
the native application packages. Build instructions are in `README.md`.

Electron and Chromium license notices are also included by Electron in each
native application package. Each package also exposes
`resources/licenses/THIRD_PARTY_LICENSES.txt`, generated from the exact
installed dependency tree, with declared license identifiers and available
license/notice texts.

HeroUI Pro is currently included only as compiled application code under the
separate HeroUI Pro License Agreement; it is not covered by the GPL, MIT, or
Apache-2.0 license texts above. Its source code, CI token, and licensed package
are not distributed. A valid HeroUI Pro license is required to build or
redistribute the current application. Adding the open-source license texts does
not resolve that separate compatibility issue.
