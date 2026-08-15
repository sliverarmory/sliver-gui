# Licensing

Copyright (C) 2026 Sliver GUI contributors.

Sliver GUI's first-party source and the combined application are licensed
under `GPL-3.0-or-later`. The canonical GPLv3 terms are in `LICENSE`, with an
SPDX-named copy at `LICENSES/GPL-3.0-or-later.txt`. The `or-later` choice is
declared by `package.json`, this notice, and the source distribution.

Separately identified third-party components retain their own licenses. The
MIT and Apache-2.0 texts under `LICENSES/` are provided for those components;
they do not dual-license Sliver GUI. Exact component attribution and source
information are in `THIRD_PARTY_NOTICES.md`, while native builds also include
an externally accessible `resources/licenses/THIRD_PARTY_LICENSES.txt`
inventory generated from `dist/THIRD_PARTY_LICENSES.txt`, plus
package-specific license files.

`@heroui/react@3.2.4` and `@heroui/styles@3.2.4` currently have conflicting
upstream metadata: their package manifests declare MIT, while their bundled
licenses and upstream release history identify Apache-2.0. This repository
preserves the bundled Apache-2.0 text and does not use that metadata
discrepancy to broaden the grant.

The current `@heroui-pro/react` dependency remains governed by the separate
HeroUI Pro License Agreement. Adding compatible open-source license texts does
not change that package's terms or resolve its compatibility with the GPL
application. Public distribution still requires removing the Pro dependency
or obtaining appropriate written permissions.
