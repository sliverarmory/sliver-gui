// @vitest-environment node

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { parseListeningSockets } from "./local-redirector-deployer.js";
import {
  renderLocalRedirectorRecipe,
  renderLocalRedirectorRemoval,
  type LocalRedirectorRecipeInput,
} from "./local-redirector-recipes.js";

const installationId = "214f139e-83c2-478a-946c-a52dc9d394b9";

function input(recipeId: "caddy" | "nginx", domains: readonly string[]): LocalRedirectorRecipeInput {
  return {
    installationId,
    recipeId,
    domains,
    publicIp: "203.0.113.10",
    backendKind: "http",
    backendPort: 8000,
    serviceName: `sliver-gui-${recipeId}-${installationId}.service`,
  };
}

function assertShellSyntax(script: string): void {
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function embeddedFile(script: string, suffix: string): string {
  const files = [...script.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > '([^']+)'/gu)];
  const match = files.findLast(([, , path]) => path?.endsWith(suffix));
  if (!match?.[1]) throw new Error(`Missing embedded file ${suffix}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("versioned local redirector recipes", () => {
  it.each(["caddy", "nginx"] as const)("renders %s domain HTTPS and a bounded deployment script", (recipeId) => {
    const recipe = renderLocalRedirectorRecipe(input(recipeId, ["c2.example.org", "other.example.org"]));
    expect(recipe.publicUrl).toBe("https://c2.example.org");
    expect(recipe.frontendPorts).toEqual([80, 443]);
    const config = embeddedFile(recipe.installScript, recipeId === "caddy" ? "/Caddyfile" : "/nginx.conf");
    expect(config).toContain("127.0.0.1:8000");
    if (recipeId === "caddy") {
      expect(config).toContain("default_bind 0.0.0.0");
      expect(config).toContain("http:// {\n}");
    }
    expect(config).toContain(recipeId === "caddy" ? "header_up Host {http.request.hostport}" : "proxy_set_header Host $http_host;");
    expect(recipe.installScript).toContain("'https://c2.example.org/'");
    expect(recipe.installScript).toContain("'https://other.example.org/'");
    expect(recipe.verifyScript).toContain("--resolve 'c2.example.org:443:127.0.0.1'");
    expect(recipe.verifyScript).not.toContain("--insecure");
    expect(recipe.installScript).not.toContain("tls_insecure_skip_verify");
    assertShellSyntax(recipe.installScript);
    assertShellSyntax(recipe.verifyScript);
    assertShellSyntax(recipe.removeScript);
  });

  it("uses Caddy's automatic public certificate management with an isolated service", () => {
    const script = renderLocalRedirectorRecipe(input("caddy", ["c2.example.org"])).installScript;
    expect(script).toContain("caddy_2.11.4_linux_${arch}.tar.gz");
    expect(script).toContain("sha256sum --check --status");
    expect(script).toContain("sliver-gui-caddy-214f139e-83c2-478a-946c-a52dc9d394b9.service");
    expect(script).not.toContain("/etc/caddy/Caddyfile");
    expect(script).not.toContain("systemctl stop caddy.service");
  });

  it("uses Certbot webroot issuance and a dedicated Nginx renewal timer", () => {
    const script = renderLocalRedirectorRecipe(input("nginx", ["c2.example.org"])).installScript;
    expect(script).toContain("certbot certonly --webroot");
    expect(script).toContain("--cert-name sliver-gui-214f139e-83c2-478a-946c-a52dc9d394b9");
    expect(embeddedFile(script, "/nginx.conf")).toContain("ssl_certificate /etc/letsencrypt/live/sliver-gui-");
    expect(script).toContain("sliver-gui-nginx-214f139e-83c2-478a-946c-a52dc9d394b9-renew.timer");
    expect(script).not.toContain("/etc/nginx/nginx.conf");
  });

  it.each(["caddy", "nginx"] as const)("renders %s IP-only HTTP without ACME", (recipeId) => {
    const recipe = renderLocalRedirectorRecipe(input(recipeId, []));
    expect(recipe.publicUrl).toBe("http://203.0.113.10");
    expect(recipe.frontendPorts).toEqual([80]);
    expect(recipe.installScript).not.toContain("certbot certonly");
    if (recipeId === "caddy") {
      const config = embeddedFile(recipe.installScript, "/Caddyfile");
      expect(config).toContain("default_bind 0.0.0.0");
      expect(config).toContain("http://:80 {");
      expect(config).not.toContain("http:// {\n}");
    }
    assertShellSyntax(recipe.installScript);
  });

  it("rejects untrusted HTTPS upstreams and unsafe manifest inputs before rendering", () => {
    expect(() => renderLocalRedirectorRecipe({ ...input("caddy", ["c2.example.org"]), backendKind: "https" })).toThrow(/trusted CA/u);
    expect(() => renderLocalRedirectorRecipe({ ...input("nginx", ["c2.example.org"]), domains: ["x.example.org; touch /tmp/x"] })).toThrow(/domains/u);
    expect(() => renderLocalRedirectorRecipe({ ...input("nginx", []), backendPort: 80 })).toThrow(/listener port/u);
    expect(() => renderLocalRedirectorRecipe({ ...input("caddy", []), publicIp: "2001:db8::10" })).toThrow(/IPv4/u);
    expect(() => renderLocalRedirectorRemoval({ installationId, recipeId: "nginx", serviceName: "nginx.service" })).toThrow(/service name/u);
  });

  it("makes removal retryable after cleanup while refusing orphaned managed units", () => {
    const script = renderLocalRedirectorRemoval({
      installationId,
      recipeId: "nginx",
      serviceName: `sliver-gui-nginx-${installationId}.service`,
    });
    expect(script).toContain("Redirector ownership marker is missing while a managed unit remains");
    expect(script).toContain("if systemctl is-active --quiet \"$SERVICE\"; then exit 75; fi");
    expect(script.indexOf("certbot delete")).toBeGreaterThan(script.indexOf("systemctl disable --now \"$SERVICE\""));
    assertShellSyntax(script);
  });

  it("parses exact socket bindings and process names for loopback checks", () => {
    expect(parseListeningSockets(`LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:* users:(("sliver-server",pid=41,fd=12))\nLISTEN 0 4096 [::]:443 [::]:* users:(("caddy",pid=42,fd=10))`)).toEqual([
      { address: "127.0.0.1", port: 8000, process: "sliver-server" },
      { address: "::", port: 443, process: "caddy" },
    ]);
  });
});
