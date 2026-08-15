// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native distribution packaging", () => {
  it("routes CI platform and publish arguments directly to electron-builder", () => {
    const rootDir = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      readFileSync(resolve(rootDir, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const workflow = readFileSync(
      resolve(rootDir, ".github/workflows/build-and-release.yml"),
      "utf8",
    );

    expect(packageJson.scripts?.["predist"]).toBe(
      "npm run build:licenses && npm run build && npm run verify:release-content",
    );
    expect(packageJson.scripts?.["dist"]).toBe("electron-builder");
    expect(packageJson.scripts?.["postdist"]).toBe("npm run verify:packaged-content");
    expect(workflow).toContain("run: npm run predist");
    expect(workflow).toContain(
      "run: node ./node_modules/electron-builder/cli.js ${{ matrix.build_args }} --publish never",
    );
    expect(workflow).toContain("run: npm run postdist");
    expect(workflow).toContain(
      "DEBUG: ${{ runner.os == 'Windows' && 'pw:browser' || '' }}",
    );
    expect(workflow).not.toContain("npm run dist --");
  });

  it("routes workflow verifier flags directly to their Node scripts", () => {
    const rootDir = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      readFileSync(resolve(rootDir, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const verifierScripts = Object.entries(packageJson.scripts ?? {})
      .filter(([name, command]) => name.startsWith("verify:") && command.startsWith("node ./scripts/"))
      .map(([name]) => name);
    const workflowsDirectory = resolve(rootDir, ".github/workflows");

    for (const workflowName of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/u.test(name))) {
      const workflow = readFileSync(resolve(workflowsDirectory, workflowName), "utf8");
      for (const scriptName of verifierScripts) {
        expect(workflow, `${workflowName} must invoke ${scriptName} directly when passing flags`).not.toMatch(
          new RegExp(`npm\\s+run\\s+${escapeRegularExpression(scriptName)}\\s+--`, "u"),
        );
      }
    }

    const releaseWorkflow = readFileSync(resolve(workflowsDirectory, "build-and-release.yml"), "utf8");
    const privateUpdaterWorkflow = readFileSync(resolve(workflowsDirectory, "private-updater-e2e.yml"), "utf8");
    expect(releaseWorkflow.match(/node \.\/scripts\/verifyReleaseVersion\.mjs/gu)).toHaveLength(3);
    expect(releaseWorkflow.match(/node \.\/scripts\/verifyReleaseSigningEnvironment\.mjs/gu)).toHaveLength(2);
    expect(releaseWorkflow.match(/node \.\/scripts\/verifyUpdateArtifacts\.mjs/gu)).toHaveLength(4);
    expect(privateUpdaterWorkflow.match(/node \.\/scripts\/verifyUpdateArtifacts\.mjs/gu)).toHaveLength(6);
  });

  it("verifies immutable private updater releases from published state", () => {
    const rootDir = resolve(import.meta.dirname, "../..");
    const workflow = readFileSync(
      resolve(rootDir, ".github/workflows/private-updater-e2e.yml"),
      "utf8",
    );

    expect(workflow).not.toContain("immutable-releases");
    expect(workflow).not.toContain("immutable_releases");
    expect(workflow).not.toMatch(/2>\/dev\/null\s*\|\|\s*echo false/gu);

    const publishedState = workflowStep(workflow, "Verify published state and exact remote inventory");
    expect(publishedState).toContain(
      "--json isDraft,isImmutable,isPrerelease,tagName,targetCommitish",
    );
    expect(publishedState).toContain(
      "--jq '[.isDraft, .isPrerelease, .isImmutable, .tagName, .targetCommitish] | @tsv'",
    );
    expect(publishedState).toContain(
      "expected_state=\"$(printf 'false\\ttrue\\ttrue\\t%s\\t%s'",
    );

    const nativeContext = workflowStep(workflow, "Build credential-free native test context");
    expect(nativeContext).toContain(
      "--json databaseId,isDraft,isImmutable,isPrerelease,publishedAt,tagName,targetCommitish,url",
    );
    const nativeVerifier = workflowStep(workflow, "Verify credential-free release context");
    expect(nativeVerifier).toContain("c.isImmutable!==true");
    expect(nativeVerifier).not.toContain("GH_TOKEN");
  });

  it("keeps private updater trust setup noninteractive and cleanup fail-closed", () => {
    const rootDir = resolve(import.meta.dirname, "../..");
    const workflow = readFileSync(
      resolve(rootDir, ".github/workflows/private-updater-e2e.yml"),
      "utf8",
    );

    expect(workflow.match(/security add-trusted-cert/gu)).toHaveLength(2);
    expect(workflow).toContain(
      'sudo -n security add-trusted-cert -d -r trustRoot -p codeSign -k "$keychain" "$signing_dir/signing.pem"',
    );
    expect(workflow).toContain(
      'sudo -n security add-trusted-cert -d -r trustRoot -p codeSign -k "$trust_keychain" "$certificate"',
    );
    expect(workflow).not.toContain("security remove-trusted-cert");
    expect(workflow).not.toMatch(/security (?:add|remove)-trusted-cert[^\n]*\|\| true/gu);

    for (const name of [
      "Generate one ephemeral self-signed macOS identity",
      "Generate one ephemeral self-signed Windows identity",
      "Trust the ephemeral macOS public certificate",
      "Trust the ephemeral Windows public certificate",
    ]) {
      expect(workflowStep(workflow, name)).toContain("timeout-minutes: 10");
    }
    expect(
      workflowStep(
        workflow.replace(/\n/gu, "\r\n"),
        "Generate one ephemeral self-signed macOS identity",
      ),
    ).toContain("timeout-minutes: 10");

    const macSigningSetup = workflowStep(workflow, "Generate one ephemeral self-signed macOS identity");
    for (const context of [
      'echo "CSC_KEYCHAIN=',
      'echo "UPDATER_E2E_PUBLIC_CERT=',
      'echo "UPDATER_E2E_SIGNING_DIR=',
      'echo "UPDATER_E2E_ORIGINAL_KEYCHAINS=',
    ]) {
      expect(macSigningSetup.indexOf(context), context).toBeGreaterThan(-1);
      expect(macSigningSetup.indexOf(context), context).toBeLessThan(
        macSigningSetup.indexOf("sudo -n security add-trusted-cert"),
      );
    }
    const macNativeSetup = workflowStep(workflow, "Trust the ephemeral macOS public certificate");
    for (const context of [
      'echo "UPDATER_E2E_TRUST_KEYCHAIN=',
      'echo "UPDATER_E2E_TRUST_ORIGINAL_KEYCHAINS=',
    ]) {
      expect(macNativeSetup.indexOf(context), context).toBeGreaterThan(-1);
      expect(macNativeSetup.indexOf(context), context).toBeLessThan(
        macNativeSetup.indexOf("sudo -n security add-trusted-cert"),
      );
    }

    for (const setup of [macSigningSetup, macNativeSetup]) {
      const guard = 'if [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then';
      const guardIndex = setup.indexOf(guard);
      const trustIndex = setup.indexOf("sudo -n security add-trusted-cert");
      expect(guardIndex).toBeGreaterThan(-1);
      expect(guardIndex).toBeLessThan(trustIndex);
      expect(setup.slice(guardIndex, trustIndex)).toContain("exit 1");
    }

    for (const name of ["Remove ephemeral private signing material", "Remove ephemeral macOS trust"]) {
      const cleanup = workflowStep(workflow, name);
      expect(cleanup).toContain("timeout-minutes: 2");
      expect(cleanup).toContain("cleanup_failed=false");
      expect(cleanup).toContain("cleanup_failed=true");
      expect(cleanup).toContain('if [ "$cleanup_failed" = true ]; then exit 1; fi');
      expect(cleanup).not.toContain("set -euo pipefail");
      expect(cleanup).not.toContain("|| true");
      expect(cleanup).not.toContain("sudo");
    }
    const macSigningCleanup = workflowStep(workflow, "Remove ephemeral private signing material");
    for (const marker of [
      "MAC_SIGNING_CLEANUP_BEGIN",
      "MAC_SIGNING_CLEANUP_RESTORE_KEYCHAINS",
      "MAC_SIGNING_CLEANUP_DELETE_KEYCHAIN",
      "MAC_SIGNING_CLEANUP_DELETE_PRIVATE_MATERIAL",
      "MAC_SIGNING_CLEANUP_END",
    ]) {
      expect(macSigningCleanup).toContain(`echo "::notice::${marker}"`);
    }
    expect(macSigningCleanup).toContain('security list-keychains -d user -s "${original_keychains[@]}"');
    expect(macSigningCleanup).toContain('security delete-keychain "$signing_keychain"');
    expect(macSigningCleanup).toContain('rm -rf -- "$signing_dir"');

    const macNativeCleanup = workflowStep(workflow, "Remove ephemeral macOS trust");
    for (const marker of [
      "MAC_NATIVE_TRUST_CLEANUP_BEGIN",
      "MAC_NATIVE_TRUST_CLEANUP_RESTORE_KEYCHAINS",
      "MAC_NATIVE_TRUST_CLEANUP_DELETE_SAVED_LIST",
      "MAC_NATIVE_TRUST_CLEANUP_DELETE_KEYCHAIN",
      "MAC_NATIVE_TRUST_CLEANUP_END",
    ]) {
      expect(macNativeCleanup).toContain(`echo "::notice::${marker}"`);
    }
    expect(macNativeCleanup).toContain('security list-keychains -d user -s "${original_keychains[@]}"');
    expect(macNativeCleanup).toContain('rm -f -- "$original_keychains_file"');
    expect(macNativeCleanup).toContain('security delete-keychain "$trust_keychain"');

    expect(workflow).not.toContain("Import-Certificate");
    expect(workflow).not.toContain("Cert:\\CurrentUser\\Root");
    expect(workflow).not.toContain("Cert:\\CurrentUser\\TrustedPublisher");
    expect(workflow.match(/& certutil\.exe -addstore -f Root \$(?:cerPath|certificatePath)/gu)).toHaveLength(2);
    expect(workflow.match(/& certutil\.exe -addstore -f TrustedPublisher \$(?:cerPath|certificatePath)/gu)).toHaveLength(2);
    expect(workflow.match(/if \(\$LASTEXITCODE -ne 0\)/gu)).toHaveLength(6);
    const windowsSigningSetup = workflowStep(workflow, "Generate one ephemeral self-signed Windows identity");
    expect(windowsSigningSetup).toContain('-CertStoreLocation "Cert:\\CurrentUser\\My"');
    expect(windowsSigningSetup.match(/& certutil\.exe -addstore -f Root/gu)).toHaveLength(1);
    expect(windowsSigningSetup.match(/& certutil\.exe -addstore -f TrustedPublisher/gu)).toHaveLength(1);
    for (const context of [
      'Add-Content -LiteralPath $env:GITHUB_ENV -Value "UPDATER_E2E_SIGNING_DIR=',
      'Add-Content -LiteralPath $env:GITHUB_ENV -Value "WINDOWS_CERT_THUMBPRINT=',
    ]) {
      expect(windowsSigningSetup.indexOf(context), context).toBeGreaterThan(-1);
      expect(windowsSigningSetup.indexOf(context), context).toBeLessThan(
        windowsSigningSetup.indexOf("& certutil.exe -addstore"),
      );
    }
    const windowsNativeSetup = workflowStep(workflow, "Trust the ephemeral Windows public certificate");
    expect(windowsNativeSetup.match(/& certutil\.exe -addstore -f Root/gu)).toHaveLength(1);
    expect(windowsNativeSetup.match(/& certutil\.exe -addstore -f TrustedPublisher/gu)).toHaveLength(1);
    expect(windowsNativeSetup.indexOf('Add-Content -LiteralPath $env:GITHUB_ENV -Value "UPDATER_E2E_TRUST_THUMBPRINT='))
      .toBeGreaterThan(-1);
    expect(windowsNativeSetup.indexOf('Add-Content -LiteralPath $env:GITHUB_ENV -Value "UPDATER_E2E_TRUST_THUMBPRINT='))
      .toBeLessThan(windowsNativeSetup.indexOf("& certutil.exe -addstore"));

    const signingCleanup = workflowStep(workflow, "Remove ephemeral Windows private signing material");
    expect(signingCleanup).toContain('foreach ($store in @("Root", "TrustedPublisher"))');
    expect(signingCleanup).toContain('"Cert:\\LocalMachine\\$store\\$($env:WINDOWS_CERT_THUMBPRINT)"');
    expect(signingCleanup).toContain("& certutil.exe -delstore $store $env:WINDOWS_CERT_THUMBPRINT");
    expect(signingCleanup).toContain('"Cert:\\CurrentUser\\My\\$($env:WINDOWS_CERT_THUMBPRINT)"');
    expect(signingCleanup).toContain("if ($LASTEXITCODE -ne 0)");
    expect(signingCleanup).toContain('$cleanupFailures = [Collections.Generic.List[string]]::new()');
    expect(signingCleanup).toContain('if ($cleanupFailures.Count -gt 0) { throw "Ephemeral Windows signing cleanup failed" }');
    expect(signingCleanup.match(/\bthrow\b/gu)).toHaveLength(1);

    const nativeCleanup = workflowStep(workflow, "Remove ephemeral Windows trust");
    expect(nativeCleanup).toContain('foreach ($store in @("Root", "TrustedPublisher"))');
    expect(nativeCleanup).toContain('"Cert:\\LocalMachine\\$store\\$($env:UPDATER_E2E_TRUST_THUMBPRINT)"');
    expect(nativeCleanup).toContain("& certutil.exe -delstore $store $env:UPDATER_E2E_TRUST_THUMBPRINT");
    expect(nativeCleanup).not.toContain("Cert:\\CurrentUser\\My");
    expect(nativeCleanup).toContain("if ($LASTEXITCODE -ne 0)");
    expect(nativeCleanup).toContain('$cleanupFailures = [Collections.Generic.List[string]]::new()');
    expect(nativeCleanup).toContain('if ($cleanupFailures.Count -gt 0) { throw "Ephemeral Windows trust cleanup failed" }');
    expect(nativeCleanup.match(/\bthrow\b/gu)).toHaveLength(1);
  });
});

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function workflowStep(workflow: string, name: string): string {
  const normalizedWorkflow = workflow.replace(/\r\n?/gu, "\n");
  const marker = `      - name: ${name}\n`;
  const start = normalizedWorkflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing workflow step: ${name}`);
  const next = normalizedWorkflow.indexOf("\n      - name: ", start + marker.length);
  return normalizedWorkflow.slice(start, next < 0 ? undefined : next);
}
