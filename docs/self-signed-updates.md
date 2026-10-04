# Self-signed installation and updates

Sliver GUI starts its public update sequence at `v0.0.1`. Install that version
once; subsequent higher stable semantic versions use the same GitHub Releases
feed and signing identities. Updating an existing release's files in place does
not produce a new update, and immutable releases prohibit that replacement.

The public certificate files and SHA-256 fingerprints are versioned in
[`build/update-signing`](../build/update-signing). Those files contain no private
keys. Compare fingerprints against a separately trusted copy of the repository
before granting trust on a new machine.

## macOS

1. Download the universal DMG and copy **Sliver GUI** into Applications.
2. Launch it. A self-signed app is not Apple-notarized; macOS can require an
   explicit **System Settings → Privacy & Security → Open Anyway** approval
   before its first launch. Managed machines may require administrator action.
3. Select **Check for Updates**. When the bundled signing certificate is not yet
   trusted for code signing, the app offers a native macOS certificate trust
   dialog showing its identity. Review the pinned fingerprint and approve only
   the code-signing purpose. macOS can request authentication.
4. After the helper verifies trust, the updater checks for a newer stable
   release. Downloaded updates still have to satisfy the installed application's
   signature requirements. Cancelling the trust prompt leaves updating paused.

Background checks never open the trust dialog. They report that trust setup is
required and wait for an explicit update action. Trust is requested only for
the certificate shipped with the installed app; the update server cannot
introduce a replacement key through this dialog.

Certificate trust does not replace Gatekeeper's first-launch decision or Apple
notarization. See [Apple's instructions for opening downloaded apps](https://support.apple.com/en-us/102445).
Release packaging keeps hardened runtime enabled and verifies the pinned
certificate on the app, Electron frameworks, native modules, bundled console,
and the native trust helper.

## Windows

Use the NSIS `-setup.exe` installer for automatic updates. The portable EXE is
a manual-download package.

An administrator or user must establish trust for the public `windows.cer`
certificate before Authenticode validation accepts this self-signed publisher.
Install the reviewed public certificate into the appropriate **Trusted Root
Certification Authorities** and **Trusted Publishers** stores using Windows
certificate management or the organization's certificate deployment policy.
Use the current-user stores when the application runs as that user; machine-wide
deployment requires an administrator. The published certificate permits only
code signing, and should not be granted additional certificate purposes.

The installer can still receive Windows SmartScreen reputation prompts.
Publisher trust and SmartScreen reputation are separate. The updater requires
valid Authenticode signatures and the configured complete certificate Subject;
release verification also compares the exact pinned certificate fingerprint.
Microsoft documents the [Trusted Publishers store](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/trusted-publishers-certificate-store).

## Linux

AppImage supports automatic updates; DEB packages require manual installation.
Linux update metadata contains SHA-512 checksums and release assets are listed
in `SHA256SUMS`. These checksums provide integrity but are not a separate
publisher signature: the current Linux updater relies on HTTPS and the GitHub
release account. macOS and Windows additionally verify platform code signatures.

## Release credentials and continuity

The `release` GitHub environment accepts deployments only from `main`. It holds
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `WIN_CSC_LINK`,
`WIN_CSC_KEY_PASSWORD`, and `WIN_CSC_PUBLISHER_NAME`. The certificate archives
and passwords are secrets; the public Subject does not itself require secrecy.
The release jobs set `SLIVER_GUI_SIGNING_PROFILE=self-signed` and disable
notarization explicitly for that profile. Apple Developer ID signing remains a
separate supported verification profile.

Tag pushes request a workflow dispatch on `main`. Release preflight must verify
that the signed annotated tag points at the exact reviewed `main` commit before
any signing credentials become available. Pull requests and ordinary CI builds
have no access to the release environment's signing keys.

Keep protected offline backups of both certificate archives and their
passwords. Do not regenerate certificates for each build: signer continuity is
part of installed-update verification. A lost or replaced key can require a
manual reinstall. Certificate renewal or key rotation needs a planned migration
verified against an installed old version before publishing the new signer.

To publish another build, merge its reviewed changes into protected `main`,
create a signed annotated higher `vX.Y.Z` tag on that exact commit, and push the
tag. The release workflow builds packages with the tag's version, verifies their
content and signatures, and publishes all packages plus `latest*.yml` metadata
as one immutable stable release. Drafts and prereleases do not update stable
installations.

Release CI validates signatures and package contents. An initial Gatekeeper
approval, native trust prompt, and installed update on a clean Mac still require
their own end-to-end evidence; unit tests alone do not establish that experience.
