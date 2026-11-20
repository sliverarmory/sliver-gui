import { createHash } from "node:crypto";

/** The exact executable from the official SharpHound CE v2.17.1 Windows x86
 * release ZIP. Its GOAD schema-v6 output was imported by the bundled Beagle
 * workflow. Name, Armory manifest metadata, and PE headers are not evidence of
 * Beagle compatibility. Add a new digest only after a real collection/import.
 * Release ZIP SHA-256: 638d6d408f87067a664b381efc11dae5d76bcbfb451452453145f963c709b24a.
 */
export const VERIFIED_SHARPHOUND_CE = Object.freeze({
  version: "2.17.1",
  executableSha256: "23e7bc671921d86ce5d78e47fc5c0baafe1633cfa477637e7635fa76462c9d05",
  scriptSha256: "83b964ec3848609ed7ac81ed103e0664860c86b499b3f151365a283b359f7fe9",
  releaseUrl: "https://github.com/SpecterOps/SharpHound/releases/tag/v2.17.1",
});

export function isVerifiedSharpHoundCeExecutable(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a &&
    createHash("sha256").update(bytes).digest("hex") === VERIFIED_SHARPHOUND_CE.executableSha256;
}

/** The official Invoke-BloodHound script from the same release ZIP; its
 * schema-v6 output was imported from a live GOAD session through Electron. */
export function isVerifiedSharpHoundCeScript(bytes: Buffer): boolean {
  return bytes.length > 0 && createHash("sha256").update(bytes).digest("hex") === VERIFIED_SHARPHOUND_CE.scriptSha256;
}
