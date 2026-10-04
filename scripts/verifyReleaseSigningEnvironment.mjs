import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readUpdateSigningAssets, releaseSigningProfile } from "./releaseSigning.mjs";

const profile = releaseSigningProfile();
const platform = argumentValue("--platform");
const requiredVariables = {
  macos: profile === "self-signed" ? ["MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD"] : [
    "MAC_CSC_LINK",
    "MAC_CSC_KEY_PASSWORD",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ],
  windows: ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "WIN_CSC_PUBLISHER_NAME"],
};

if (!platform || !(platform in requiredVariables)) {
  throw new Error("--platform must be macos or windows");
}

const missing = requiredVariables[platform].filter(
  (name) => typeof process.env[name] !== "string" || process.env[name].trim().length === 0,
);
if (missing.length > 0) {
  throw new Error(
    `Release ${platform} signing is missing required GitHub Actions environment value(s): ${missing.join(", ")}`,
  );
}

if (platform === "windows" && (!process.env.WIN_CSC_PUBLISHER_NAME.includes("=") || /[\r\n\0]/u.test(process.env.WIN_CSC_PUBLISHER_NAME))) {
  throw new Error("WIN_CSC_PUBLISHER_NAME must be the certificate Subject distinguished name");
}

if (profile === "self-signed") {
  const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { manifest } = await readUpdateSigningAssets(rootDirectory);
  if (platform === "windows" && process.env.WIN_CSC_PUBLISHER_NAME !== manifest.windows.subject) {
    throw new Error("WIN_CSC_PUBLISHER_NAME does not match the pinned Windows certificate Subject");
  }
}

if (platform === "macos" && profile === "developer-id") {
  if (!/^[A-Z0-9]{10}$/u.test(process.env.APPLE_TEAM_ID)) {
    throw new Error("APPLE_TEAM_ID must be a 10-character Apple team identifier");
  }
  if (!process.env.APPLE_ID.includes("@")) {
    throw new Error("APPLE_ID must be the email address used for notarization");
  }
}

console.log(`Validated required ${platform} ${profile} release signing environment`);

function argumentValue(name) {
  const indexes = process.argv.flatMap((argument, index) => argument === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be specified only once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
