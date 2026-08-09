# ADR 0001: Desktop platform support and certification matrix

- Status: Accepted
- Date: 2026-08-09
- Applies to: Electron 43.x packaged Sliver GUI releases

## Context

The project produces a macOS universal application, Windows x64 installers,
and Linux x64 packages. A moving CI label such as `macos-latest` proves only
that a build ran on whichever image the provider selected that day; it does
not define a product minimum or certify that an installed package works.

Electron 43 provides macOS, Windows, and Linux binaries; Electron's published
platform policy identifies macOS Ventura and later, Windows 10 and later, and
Ubuntu 22.04 as the Linux build baseline. This ADR deliberately chooses a
narrower Windows product minimum because ordinary Windows 10 editions are out
of standard support.

## Decision

“Supported” means the packaged artifact installs, launches natively, imports a
bounded mTLS operator configuration, connects to the pinned-compatible server,
performs one read and one safe current-slice mutation, disconnects cleanly, and
passes the release-content checks. A successful cross-build alone is not
support evidence.

The exact M0 release matrix is:

| Product target | Package | Minimum supported runtime | Required minimum-runtime certification image | M0 evidence at ADR acceptance |
| --- | --- | --- | --- | --- |
| macOS arm64 | universal DMG and ZIP | macOS Ventura 13.7.8, arm64 | macOS 13.7.8 arm64, native Apple Silicon; Rosetta is not a substitute | Pending |
| macOS x64 | universal DMG and ZIP | macOS Ventura 13.7.8, x86_64 | macOS 13.7.8 x86_64 on Intel hardware; an arm64 host under Rosetta is not a substitute | Pending |
| Windows x64 | NSIS and portable EXE | Windows 11 24H2, build 26100, x64 | Windows 11 24H2 x64, build 26100 with the latest security update available on the certification date | Pending |
| Linux x64 | AppImage and Debian package | Ubuntu 22.04.5 LTS, glibc 2.35, x86_64 | Ubuntu 22.04.5 LTS x86_64 with glibc 2.35, X11 session | Pending |

The current developer-host observation is macOS 26.5.2 build 25F84 on arm64.
It is useful local evidence but is not a replacement for any pending packaged
minimum-runtime lane above. The tested column may change only when evidence
records the exact OS version/build, architecture, package SHA-256, Electron
version, test IDs, and result. Evidence must never use only “latest”.

Release builds may also run on a current-platform lane to detect forward
compatibility. That lane is informative until its exact image version is
captured; it cannot replace a minimum-runtime lane. Linux Wayland is an
additional compatibility lane because Electron documents material window
management differences under Wayland. The X11 minimum remains the supported
baseline until the Wayland package smoke passes.

## Transport scope

mTLS is the packaged operator transport required by the M0 application smoke.
Packaged WireGuard operator configurations, prebuilt helper binaries, and their
cross-platform process certification are deferred beyond M0. This deferral is
not a waiver for implant-side WireGuard commands, which remain independently
classified in the operator parity inventory.

## Required evidence and CI policy

Each matrix lane must retain or report:

- the package and checksum being tested;
- `sw_vers` and `uname -m` on macOS, `Get-ComputerInfo` plus the OS build and
  process architecture on Windows, or `/etc/os-release`, `uname -m`, and the
  first line of `ldd --version` on Linux;
- native install/launch, mTLS config import, connection, read, mutation,
  disconnect, and release-content test identifiers;
- whether the run used physical hardware, a VM, or a hosted runner; and
- a terminal pass/fail result linked to immutable logs.

CI build jobs must use versioned images. If a hosted provider cannot supply an
exact minimum runtime, it may build the artifact, but a dedicated VM or
physical-host job must perform the certification smoke. Updating Electron,
raising a minimum, changing an artifact format, or adding a native helper
requires an ADR/matrix review and fresh certification.

## Consequences

- macOS universal output is one artifact, but arm64 and x64 are two independent
  installed-application certification lanes.
- Windows Server build runners do not certify the Windows 11 client runtime.
- Linux packages built on a newer distribution do not certify glibc 2.35; the
  Ubuntu 22.04.5 runtime lane is authoritative.
- M0 may complete without WireGuard operator transport only under the explicit
  scope deferral above; no UI or documentation may imply that packaged
  WireGuard connection is certified.

## References

- [Electron platform support](https://github.com/electron/electron#platform-support)
- [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)
- [Windows 10 lifecycle notice](https://learn.microsoft.com/en-us/lifecycle/announcements/windows-10-22h2-end-of-support-update)
- [macOS Ventura 13.7.8 security release](https://support.apple.com/en-us/124929)
