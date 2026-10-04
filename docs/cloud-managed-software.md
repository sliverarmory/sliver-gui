# Managed software on cloud servers

Open **Cloud Deployment → Servers**, then choose **Software** on a
running AWS or Azure server. You can also right-click its server node in
Overview and choose **Deploy Redirector (Local)** to open that view. Use
**Add software** there to install a local HTTP redirector. The first recipes are Caddy and
Nginx in **HTTP Redirectors → local**. A server can have one managed redirector
at a time because each recipe owns public port 80, and domain mode also owns
port 443.

The server needs a current public IPv4 address, a managed Sliver operator
profile, and the pinned SSH host key saved during initial provisioning. The
public IP entered in the form must match the VM's current public IPv4. Choose
public A records pointing to that IP from **Cloud DNS**, enter relative names
such as `c2` or `edge.c2` to create A records in a selected public zone during
installation, or enter domains manually. `@` selects the zone apex. New records
use a 300-second TTL and point to this server's current public IPv4. The
installation waits for those names to resolve only to that IP before starting
the redirector. Manually entered and selected existing domains must already
resolve only to that IP. DNS changes may need time to propagate.

The Cloud DNS creation path is create-only. It reuses an exact A record already
pointing only to this server's IP when an installation is retried, and refuses
to replace a conflicting record. Created DNS records remain in Cloud DNS if
installation fails or the redirector is later removed.

After **Install Caddy** or **Install Nginx**, the software view shows deployment
progress for DNS, the localhost listener, cloud firewall, SSH installation,
and public endpoint verification. The read-only terminal streams stdout and
stderr from the reviewed SSH recipe. You can return to the software list while
installation continues and reopen its progress. The bounded log is kept only
for the current app session; the managed installation state remains saved.

Both redirectors bind their public listeners on IPv4, matching the managed
cloud firewall rules. IPv6 public endpoints are not supported by these recipes.

## Listener and public endpoint

By default, installation starts a new Sliver HTTP listener on
`127.0.0.1:8000`. You can choose another backend port except 80 or 443. The
cloud firewall only opens the redirector frontend ports; it does not open the
loopback listener. The new listener has no cookie domain so the public hostname
can be forwarded without a conflicting cookie scope.

You can adopt an existing Sliver HTTP listener if an SSH check confirms that
`sliver-server` owns its socket and it is bound exclusively to `127.0.0.1`.
Listeners bound to a public or wildcard address, listeners with a cookie
domain, and HTTPS backends are ineligible. An adopted listener remains running
when the redirector is removed. A listener created by this workflow is stopped
on removal.

With a public IP alone, the redirector serves HTTP on port 80. With one or
more public domains, it serves HTTPS on port 443 and redirects port 80 to
HTTPS. Caddy manages certificates itself. Nginx uses Certbot's webroot
challenge and a dedicated renewal timer. Installation becomes **Active** only
after every domain presents a trusted certificate and the proxy reaches the
local Sliver listener. The first domain is the primary URL shown in the app.

The SSH runner accepts only typed inputs for reviewed, versioned recipes. It
pins the stored SSH host key, bounds commands and output, and does not accept a
script from the renderer. Its recipes live in
`src/main/cloud/local-redirector-recipes.ts`, separate from the initial Sliver
provisioner. Installation state lives in a separate private `software.json`
file under the Cloud Deployment data directory. New recipe kinds can reuse the
runner and store; they still need an explicit typed contract and UI entry.

## Removal and recovery

Removal stops the redirector service, stops its Sliver listener only if this
workflow created that listener, and removes cloud firewall rules created by
this installation. Rules that already covered a port are retained. A failed or
uncertain install stays visible as **Outcome unknown** so removal can be
retried. Server termination is blocked while a managed redirector record is
present.

The app saves an installation intent before starting a Sliver job and records
each frontend port before requesting a cloud firewall change. On restart, an
interrupted install or removal becomes **Outcome unknown**. If Sliver never
confirmed the new job ID, the app will not guess which job to stop. Inspect
the listener on the recorded backend port, stop it if present, then retry
removal. Firewall cleanup checks the exact managed rule identity and leaves
unrelated rules alone.

The Overview graph places operators → managed server → redirector from left
to right after the corresponding operator profile is connected. The redirector
node shows its primary configured DNS name, or its public IP for an IP-only
installation. Its inspector lists all configured domains and the public URL.
The server-to-redirector line is labeled with the selected listener protocol
and port; its inspector includes the localhost upstream and Sliver job
inventory. This is a saved association, not an observed traffic path.
Redirector status is cached configuration, not a live health measurement.

## Platform support

The recipes target systemd Linux hosts. Caddy uses a reviewed, pinned release
archive for x86_64 or arm64. The Nginx recipe installs distribution packages
on Ubuntu or Amazon Linux 2023, with Certbot for domain HTTPS. Public DNS and
inbound reachability on ports 80 and 443 are prerequisites for certificates.

Local tests cover contracts, persistence, orchestration, recipe rendering,
the UI, and graph contribution. Certificate issuance on a disposable managed
cloud server must be verified separately in a configured environment.

References: [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[Certbot renewal](https://eff-certbot.readthedocs.io/en/stable/using.html#renewal).
