# License and source notice

Sliver GUI is distributed under the GNU General Public License, version 3 or
later. The complete license text is in `LICENSE`.

The application bundles `sliver-script`, the TypeScript client for the Sliver
Implant Framework. It is distributed under GPL-3.0-or-later; its original
license, retained source, exact Git provenance bundle, and reconstruction
patches are under `vendor/sliver-script/` in this distribution.

The application bundles `ghostty-web` version 0.4.0, including its
`ghostty-vt.wasm` terminal runtime. Ghostty Web is copyright (c) 2025 Coder and
is distributed under the MIT License. Its package, source commit, npm integrity,
upstream Ghostty submodule commit, runtime size, and SHA-256 are pinned in
`protocol/ghostty-web-provenance.json`; the complete MIT license text is
included in the generated `dist/THIRD_PARTY_LICENSES.txt` shipped with native
packages. Source: https://github.com/coder/ghostty-web

The complete corresponding source for a released binary is the Sliver GUI
repository at the matching version tag, including the vendored client source:

https://github.com/sliverarmory/sliver-gui

GitHub release pages provide source archives for the matching tag alongside
the native application packages. Build instructions are in `README.md`.

Electron and Chromium license notices are also included by Electron in each
native application package. Each package also contains
`dist/THIRD_PARTY_LICENSES.txt`, generated from the exact installed dependency
tree, with declared license identifiers and available license/notice texts.

HeroUI Pro is included only as compiled application code under the separate
HeroUI Pro License Agreement; it is not covered by the GPL license grant above.
Its source code, CI token, and licensed package are not distributed. A valid
HeroUI Pro license is required to build or redistribute the application.
