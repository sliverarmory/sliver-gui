import { isIP } from "node:net";

/** Reviewed recipe version recorded on each managed host. */
export const LOCAL_REDIRECTOR_RECIPE_VERSION = 1 as const;
export type LocalRedirectorRecipeId = "caddy" | "nginx";

export interface LocalRedirectorRecipeInput {
  readonly installationId: string;
  readonly recipeId: LocalRedirectorRecipeId;
  readonly domains: readonly string[];
  readonly publicIp: string | null;
  readonly backendKind: "http" | "https";
  readonly backendPort: number;
  readonly serviceName: string;
}

export interface RenderedLocalRedirectorRecipe {
  readonly publicUrl: string;
  readonly frontendPorts: readonly number[];
  readonly installScript: string;
  readonly verifyScript: string;
  readonly removeScript: string;
}

export type LocalRedirectorRecipeIdentity = Pick<LocalRedirectorRecipeInput, "installationId" | "recipeId" | "serviceName">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CADDY_RELEASE = "2.11.4";
// SHA-256 from https://api.github.com/repos/caddyserver/caddy/releases/tags/v2.11.4,
// independently matched against both downloaded release archives.
const CADDY_SHA256 = {
  x86_64: "527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9",
  aarch64: "52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904",
} as const;

export function validateLocalRedirectorRecipeInput(input: LocalRedirectorRecipeInput): void {
  validateLocalRedirectorRecipeIdentity(input);
  if (!Array.isArray(input.domains) || input.domains.length > 8 ||
      input.domains.some((domain) => typeof domain !== "string" || !DNS_NAME.test(domain) || domain !== domain.toLowerCase()) ||
      new Set(input.domains).size !== input.domains.length) {
    throw new TypeError("Invalid redirector domains");
  }
  if (input.publicIp !== null && (typeof input.publicIp !== "string" || isIP(input.publicIp) !== 4)) {
    throw new TypeError("Invalid redirector public IPv4");
  }
  if (input.domains.length === 0 && input.publicIp === null) throw new TypeError("A domain or public IP is required");
  if (input.backendKind !== "http") {
    throw new TypeError("HTTPS loopback backends require a trusted CA and SNI input, which this recipe does not yet accept");
  }
  if (!Number.isSafeInteger(input.backendPort) || input.backendPort < 1 || input.backendPort > 65_535 ||
      input.backendPort === 80 || input.backendPort === 443) {
    throw new TypeError("Invalid or conflicting loopback listener port");
  }
}

function validateLocalRedirectorRecipeIdentity(input: LocalRedirectorRecipeIdentity): void {
  if (!UUID.test(input.installationId)) throw new TypeError("Invalid redirector installation ID");
  if (input.recipeId !== "caddy" && input.recipeId !== "nginx") throw new TypeError("Unsupported redirector recipe");
  if (input.serviceName !== `sliver-gui-${input.recipeId}-${input.installationId}.service`) {
    throw new TypeError("Redirector service name does not match its installation");
  }
}

export function renderLocalRedirectorRemoval(input: LocalRedirectorRecipeIdentity): string {
  validateLocalRedirectorRecipeIdentity(input);
  const root = `/var/lib/sliver-gui/redirectors/${input.installationId}`;
  return removeScript(input, root, `/etc/systemd/system/${input.serviceName}`);
}

export function renderLocalRedirectorRecipe(input: LocalRedirectorRecipeInput): RenderedLocalRedirectorRecipe {
  validateLocalRedirectorRecipeInput(input);
  const root = `/var/lib/sliver-gui/redirectors/${input.installationId}`;
  const unitPath = `/etc/systemd/system/${input.serviceName}`;
  const hasDomains = input.domains.length > 0;
  const publicUrl = hasDomains
    ? `https://${input.domains[0]}`
    : `http://${input.publicIp}`;
  const frontendPorts = hasDomains ? [80, 443] : [80];
  const installScript = input.recipeId === "caddy"
    ? caddyInstallScript(input, root, unitPath)
    : nginxInstallScript(input, root, unitPath);
  return {
    publicUrl,
    frontendPorts,
    installScript,
    verifyScript: verifyScript(input, root),
    removeScript: removeScript(input, root, unitPath),
  };
}

function caddyConfig(input: LocalRedirectorRecipeInput): string {
  const address = input.domains.length > 0 ? input.domains.join(", ") : "http://:80";
  // Automatic HTTPS creates the port 80 server at runtime unless one is declared here.
  // The explicit site lets default_bind constrain both 80 and 443 to IPv4.
  const httpSite = input.domains.length > 0 ? "http:// {\n}\n\n" : "";
  return `{
  admin off
  default_bind 0.0.0.0
}

${httpSite}${address} {
  reverse_proxy http://127.0.0.1:${input.backendPort} {
    header_up Host {http.request.hostport}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Host {http.request.hostport}
    header_up X-Forwarded-Proto {scheme}
    transport http {
      dial_timeout 10s
      read_timeout 10m
      write_timeout 10m
    }
  }
}
`;
}

function caddyUnit(input: LocalRedirectorRecipeInput, root: string): string {
  const stateName = `sliver-gui-caddy-${input.installationId}`;
  return `[Unit]
Description=Sliver GUI local Caddy redirector ${input.installationId}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
DynamicUser=yes
StateDirectory=${stateName}
Environment=XDG_DATA_HOME=/var/lib/${stateName}
Environment=XDG_CONFIG_HOME=/var/lib/${stateName}
ExecStart=${root}/bin/caddy run --config ${root}/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

function nginxProxy(input: LocalRedirectorRecipeInput): string {
  return `    proxy_pass http://127.0.0.1:${input.backendPort};
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_connect_timeout 10s;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_buffering off;
    proxy_request_buffering off;`;
}

function nginxConfig(input: LocalRedirectorRecipeInput, mode: "challenge" | "http" | "https"): string {
  const root = `/var/lib/sliver-gui/redirectors/${input.installationId}`;
  const names = input.domains.join(" ");
  const proxy = nginxProxy(input);
  const server = mode === "http"
    ? `  server {
    listen 0.0.0.0:80 default_server;
    server_name _;
    location / {
${proxy}
    }
  }`
    : `  server {
    listen 0.0.0.0:80 default_server;
    server_name _;
    return 444;
  }
  server {
    listen 0.0.0.0:80;
    server_name ${names};
    location ^~ /.well-known/acme-challenge/ {
      root ${root}/acme;
      try_files $uri =404;
    }
    location / { ${mode === "https" ? "return 308 https://$host$request_uri;" : "return 503;"} }
  }${mode === "https" ? `
  server {
    listen 0.0.0.0:443 ssl;
    server_name ${names};
    ssl_certificate /etc/letsencrypt/live/sliver-gui-${input.installationId}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sliver-gui-${input.installationId}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
${proxy}
    }
  }` : ""}`;
  return `user nobody;
worker_processes auto;
error_log stderr warn;
pid /run/sliver-gui-nginx-${input.installationId}.pid;
events { worker_connections 512; }
http {
  access_log off;
  server_tokens off;
${server}
}
`;
}

function nginxUnit(input: LocalRedirectorRecipeInput, root: string): string {
  return `[Unit]
Description=Sliver GUI local Nginx redirector ${input.installationId}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/sbin/nginx -p ${root}/ -c ${root}/nginx.conf -g "daemon off;"
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3
PrivateTmp=yes
ProtectHome=yes
UMask=0077

[Install]
WantedBy=multi-user.target
`;
}

function nginxRenewService(input: LocalRedirectorRecipeInput): string {
  return `[Unit]
Description=Renew Sliver GUI Nginx certificate ${input.installationId}

[Service]
Type=oneshot
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin
ExecStart=/usr/bin/env certbot renew --quiet --cert-name sliver-gui-${input.installationId}
ExecStartPost=/bin/systemctl reload ${input.serviceName}
`;
}

function nginxRenewTimer(input: LocalRedirectorRecipeInput): string {
  return `[Unit]
Description=Check Sliver GUI Nginx certificate ${input.installationId}

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true
Unit=sliver-gui-nginx-${input.installationId}-renew.service

[Install]
WantedBy=timers.target
`;
}

function shellQuote(value: string): string {
  if (value.includes("\u0000") || /[\r\n]/u.test(value)) throw new TypeError("Invalid remote argument");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function putFile(path: string, content: string, mode = "0644"): string {
  return `printf '%s' ${shellQuote(Buffer.from(content, "utf8").toString("base64"))} | base64 -d > ${shellQuote(path)}
chmod ${mode} ${shellQuote(path)}
`;
}

function commonInstallPrefix(input: LocalRedirectorRecipeInput, root: string, unitPath: string): string {
  const wantedPorts = input.domains.length > 0 ? "80|443" : "80";
  return `set -euo pipefail
ROOT=${shellQuote(root)}
UNIT=${shellQuote(unitPath)}
SERVICE=${shellQuote(input.serviceName)}
test "$(id -u)" -eq 0
test ! -e "$ROOT" && test ! -L "$ROOT"
test ! -e "$UNIT" && test ! -L "$UNIT"
command -v ss >/dev/null
if ss -H -ltn | awk '{print $4}' | grep -Eq ':(${wantedPorts})$'; then
  echo 'A public frontend port is already in use' >&2
  exit 70
fi
install -d -m 0755 /var/lib/sliver-gui /var/lib/sliver-gui/redirectors "$ROOT"
printf '%s\\n' ${shellQuote(`${input.recipeId}:${LOCAL_REDIRECTOR_RECIPE_VERSION}`)} > "$ROOT/owner"
chmod 0600 "$ROOT/owner"
`;
}

function caddyInstallScript(input: LocalRedirectorRecipeInput, root: string, unitPath: string): string {
  const config = caddyConfig(input);
  const unit = caddyUnit(input, root);
  return `${commonInstallPrefix(input, root, unitPath)}
case "$(uname -m)" in
  x86_64) arch=amd64; expected=${CADDY_SHA256.x86_64} ;;
  aarch64) arch=arm64; expected=${CADDY_SHA256.aarch64} ;;
  *) echo 'Unsupported Caddy architecture' >&2; exit 71 ;;
esac
command -v curl >/dev/null
command -v sha256sum >/dev/null
install -d -m 0755 "$ROOT/bin"
printf '%s\\n' 'Downloading Caddy release archive'
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 180 \\
  -o "$ROOT/caddy.tar.gz" "https://github.com/caddyserver/caddy/releases/download/v${CADDY_RELEASE}/caddy_${CADDY_RELEASE}_linux_\${arch}.tar.gz"
printf '%s\\n' 'Verifying Caddy release checksum'
printf '%s  %s\\n' "$expected" "$ROOT/caddy.tar.gz" | sha256sum --check --status
tar -xzOf "$ROOT/caddy.tar.gz" caddy > "$ROOT/bin/caddy"
chmod 0755 "$ROOT/bin/caddy"
rm -f "$ROOT/caddy.tar.gz"
printf '%s\\n' 'Writing Caddy configuration'
${putFile(`${root}/Caddyfile`, config)}${putFile(unitPath, unit)}
"$ROOT/bin/caddy" validate --config "$ROOT/Caddyfile" --adapter caddyfile
printf '%s\\n' 'Starting Caddy service'
systemctl daemon-reload
systemctl enable --now "$SERVICE"
${verificationBody(input)}
`;
}

function nginxInstallScript(input: LocalRedirectorRecipeInput, root: string, unitPath: string): string {
  const hasDomains = input.domains.length > 0;
  const initialConfig = nginxConfig(input, hasDomains ? "challenge" : "http");
  const certArgs = input.domains.map((name) => `-d ${shellQuote(name)}`).join(" ");
  const renewServiceName = `sliver-gui-nginx-${input.installationId}-renew.service`;
  const renewTimerName = `sliver-gui-nginx-${input.installationId}-renew.timer`;
  const osInstall = `if [ -r /etc/os-release ]; then . /etc/os-release; else exit 73; fi
case "$ID" in
  ubuntu) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq nginx ${hasDomains ? "certbot" : ""} ;;
  amzn) dnf install -y -q nginx ${hasDomains ? "certbot" : ""} ;;
  *) echo 'Nginx deployment supports Ubuntu and Amazon Linux 2023' >&2; exit 73 ;;
esac`;
  const certInstall = `if [ -r /etc/os-release ]; then . /etc/os-release; else exit 73; fi
case "$ID" in
  ubuntu) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq certbot ;;
  amzn) dnf install -y -q certbot ;;
  *) echo 'Automatic HTTPS supports Ubuntu and Amazon Linux 2023' >&2; exit 73 ;;
esac`;
  const httpsSetup = hasDomains ? `printf '%s\\n' 'Requesting HTTPS certificates with Certbot'
certbot certonly --webroot --webroot-path "$ROOT/acme" --non-interactive --agree-tos --register-unsafely-without-email \\
  --cert-name sliver-gui-${input.installationId} ${certArgs}
printf '%s\\n' 'Writing Nginx HTTPS configuration'
${putFile(`${root}/nginx.conf`, nginxConfig(input, "https"))}
/usr/sbin/nginx -t -p "$ROOT/" -c "$ROOT/nginx.conf"
systemctl reload "$SERVICE"
${putFile(`/etc/systemd/system/${renewServiceName}`, nginxRenewService(input))}${putFile(`/etc/systemd/system/${renewTimerName}`, nginxRenewTimer(input))}
systemctl daemon-reload
systemctl enable --now ${shellQuote(renewTimerName)}
` : "";
  return `${commonInstallPrefix(input, root, unitPath)}
if systemctl is-active --quiet nginx.service || systemctl is-enabled --quiet nginx.service; then
  echo 'The host Nginx service is already managed outside Sliver GUI' >&2
  exit 72
fi
if ! command -v nginx >/dev/null; then
printf '%s\\n' 'Installing Nginx package'
${osInstall}
  systemctl disable --now nginx.service >/dev/null 2>&1 || true
elif [ ${hasDomains ? "1" : "0"} -eq 1 ] && ! command -v certbot >/dev/null; then
printf '%s\\n' 'Installing Certbot package'
${certInstall}
fi
test -x /usr/sbin/nginx
install -d -m 0755 "$ROOT/acme" "$ROOT/acme/.well-known" "$ROOT/acme/.well-known/acme-challenge"
printf '%s\\n' 'Writing Nginx configuration'
${putFile(`${root}/nginx.conf`, initialConfig)}${putFile(unitPath, nginxUnit(input, root))}
/usr/sbin/nginx -t -p "$ROOT/" -c "$ROOT/nginx.conf"
printf '%s\\n' 'Starting Nginx service'
systemctl daemon-reload
systemctl enable --now "$SERVICE"
${httpsSetup}${verificationBody(input)}
`;
}

function verificationBody(input: LocalRedirectorRecipeInput, attempts = 8): string {
  const checks = input.domains.length > 0
    ? input.domains.map((name) => `  status=$(curl --noproxy '*' --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 5 \\
    --resolve ${shellQuote(`${name}:443:127.0.0.1`)} ${shellQuote(`https://${name}/`)}) || status=000
  case "$status" in 000|502|503|504) all_ok=0 ;; esac`).join("\n")
    : `  status=$(curl --noproxy '*' --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 5 \\
    -H ${shellQuote(`Host: ${input.publicIp}`)} http://127.0.0.1/) || status=000
  case "$status" in 000|502|503|504) all_ok=0 ;; esac`;
  return `systemctl is-active --quiet "$SERVICE"
for attempt in $(seq 1 ${attempts}); do
  printf 'Checking public endpoint (attempt %s/${attempts})\\n' "$attempt"
  all_ok=1
${checks}
  if [ "$all_ok" -eq 1 ]; then exit 0; fi
  if [ "$attempt" -lt ${attempts} ]; then sleep 5; fi
done
echo 'The local redirector did not present a verified public endpoint' >&2
exit 74`;
}

function verifyScript(input: LocalRedirectorRecipeInput, root: string): string {
  return `set -euo pipefail
ROOT=${shellQuote(root)}
SERVICE=${shellQuote(input.serviceName)}
test "$(cat "$ROOT/owner")" = ${shellQuote(`${input.recipeId}:${LOCAL_REDIRECTOR_RECIPE_VERSION}`)}
${verificationBody(input, 1)}
`;
}

function removeScript(input: LocalRedirectorRecipeIdentity, root: string, unitPath: string): string {
  const timer = `sliver-gui-nginx-${input.installationId}-renew.timer`;
  const renewService = `sliver-gui-nginx-${input.installationId}-renew.service`;
  return `set -euo pipefail
ROOT=${shellQuote(root)}
SERVICE=${shellQuote(input.serviceName)}
test "$(id -u)" -eq 0
if [ ! -e "$ROOT" ] && [ ! -L "$ROOT" ]; then
  if [ -e ${shellQuote(unitPath)} ] || [ -L ${shellQuote(unitPath)} ]${input.recipeId === "nginx" ? ` || [ -e ${shellQuote(`/etc/systemd/system/${timer}`)} ] || [ -L ${shellQuote(`/etc/systemd/system/${timer}`)} ] || [ -e ${shellQuote(`/etc/systemd/system/${renewService}`)} ] || [ -L ${shellQuote(`/etc/systemd/system/${renewService}`)} ]` : ""}; then
    echo 'Redirector ownership marker is missing while a managed unit remains' >&2
    exit 76
  fi
  exit 0
fi
test -f "$ROOT/owner"
test ! -L "$ROOT"
test "$(cat "$ROOT/owner")" = ${shellQuote(`${input.recipeId}:${LOCAL_REDIRECTOR_RECIPE_VERSION}`)}
${input.recipeId === "nginx" ? `systemctl disable --now ${shellQuote(timer)} >/dev/null 2>&1 || true
if systemctl is-active --quiet ${shellQuote(timer)}; then exit 75; fi
rm -f ${shellQuote(`/etc/systemd/system/${timer}`)} ${shellQuote(`/etc/systemd/system/${renewService}`)}
` : ""}systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
if systemctl is-active --quiet "$SERVICE"; then exit 75; fi
${input.recipeId === "nginx" ? `if [ -e ${shellQuote(`/etc/letsencrypt/renewal/sliver-gui-${input.installationId}.conf`)} ] || [ -e ${shellQuote(`/etc/letsencrypt/live/sliver-gui-${input.installationId}`)} ]; then
  command -v certbot >/dev/null
  certbot delete --non-interactive --cert-name ${shellQuote(`sliver-gui-${input.installationId}`)} >/dev/null
fi
` : ""}
rm -f ${shellQuote(unitPath)}
systemctl daemon-reload
${input.recipeId === "caddy" ? `rm -rf -- ${shellQuote(`/var/lib/sliver-gui-caddy-${input.installationId}`)} ${shellQuote(`/var/lib/private/sliver-gui-caddy-${input.installationId}`)}
` : ""}rm -rf -- "$ROOT"
`;
}
