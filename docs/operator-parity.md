# Operator parity report

Baseline: `9ff9b55352eb1c8f2ff6a906bb691e9cee5bcaa9` (tree `62d00f3225977ecbcc723f847f2df2bcd14549cb`)

This report merges deterministic command discovery with reviewed product annotations. Third-party alias and extension names are audited dynamically and are not static requirements. `parity-contract:*`, `scope-denial:*`, and `upstream-regression:*` values are stable test contract IDs; their presence assigns coverage and does not claim the test has passed.

## Scope decisions

- **operator-transport.wireguard** — deferred (post-M0): WireGuard-enabled operator configurations and packaged helper certification are explicitly deferred; mTLS remains the M0 operator transport baseline. Implant-side WireGuard workflows retain their independently assigned roadmap status.

## Dynamic audit

Representative alias `parity-alias` and extension `parity-extension` registered 2 dynamic nodes without entering the static command inventory.

## Reachable command inventory

| ID | Status | Milestone | Target modes | Target OS | GUI surface | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| `implant.ai` | planned | M8 | session, beacon | windows, linux, darwin | extensions | parity-contract:implant.ai |
| `implant.aka` | planned | M8 | session, beacon | windows, linux, darwin | extensions | parity-contract:implant.aka |
| `implant.aka.create` | planned | M8 | session, beacon | windows, linux, darwin | extensions | parity-contract:implant.aka.create |
| `implant.aka.delete` | planned | M8 | session, beacon | windows, linux, darwin | extensions | parity-contract:implant.aka.delete |
| `implant.backdoor` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.backdoor |
| `implant.background` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.background |
| `implant.cat` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.cat |
| `implant.cd` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.cd |
| `implant.chmod` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.chmod |
| `implant.chown` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.chown |
| `implant.chtimes` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.chtimes |
| `implant.close` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.close |
| `implant.cp` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.cp |
| `implant.cursed` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed |
| `implant.cursed.chrome` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed.chrome |
| `implant.cursed.console` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed.console |
| `implant.cursed.cookies` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed.cookies |
| `implant.cursed.edge` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed.edge |
| `implant.cursed.electron` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed.electron |
| `implant.cursed.rm` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed.rm |
| `implant.cursed.screenshot` | deferred | M9 | session | windows, linux, darwin | long-tail | parity-contract:implant.cursed.screenshot |
| `implant.dllhijack` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.dllhijack |
| `implant.docs` | planned | M8 | session, beacon | windows, linux, darwin | extensions | parity-contract:implant.docs |
| `implant.download` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.download |
| `implant.edit` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.edit |
| `implant.env` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.env |
| `implant.env.set` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.env.set |
| `implant.env.unset` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.env.unset |
| `implant.execute` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.execute |
| `implant.execute-assembly` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.execute-assembly |
| `implant.execute-shellcode` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.execute-shellcode |
| `implant.execute.children` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.execute.children |
| `implant.extensions` | planned | M8 | session | windows, linux, darwin | extensions | parity-contract:implant.extensions |
| `implant.extensions.list` | planned | M8 | session | windows, linux, darwin | extensions | parity-contract:implant.extensions.list |
| `implant.getgid` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.getgid |
| `implant.getpid` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.getpid |
| `implant.getprivs` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.getprivs |
| `implant.getsystem` | planned | M4 | session | windows | execution | parity-contract:implant.getsystem |
| `implant.getuid` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.getuid |
| `implant.grep` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.grep |
| `implant.head` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.head |
| `implant.hex-edit` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.hex-edit |
| `implant.ifconfig` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.ifconfig |
| `implant.impersonate` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.impersonate |
| `implant.info` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.info |
| `implant.interactive` | complete | M1 | beacon | windows, linux, darwin | targets | parity-contract:implant.interactive |
| `implant.kill` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.kill |
| `implant.ls` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.ls |
| `implant.make-token` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.make-token |
| `implant.memfiles` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.memfiles |
| `implant.memfiles.add` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.memfiles.add |
| `implant.memfiles.rm` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.memfiles.rm |
| `implant.migrate` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.migrate |
| `implant.mkdir` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.mkdir |
| `implant.mount` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.mount |
| `implant.msf` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.msf |
| `implant.msf-inject` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.msf-inject |
| `implant.mv` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.mv |
| `implant.netstat` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.netstat |
| `implant.ping` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.ping |
| `implant.pivots` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.pivots |
| `implant.pivots.details` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.pivots.details |
| `implant.pivots.graph` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.pivots.graph |
| `implant.pivots.named-pipe` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.pivots.named-pipe |
| `implant.pivots.stop` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.pivots.stop |
| `implant.pivots.tcp` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.pivots.tcp |
| `implant.portfwd` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.portfwd |
| `implant.portfwd.add` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.portfwd.add |
| `implant.portfwd.rm` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.portfwd.rm |
| `implant.procdump` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.procdump |
| `implant.ps` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.ps |
| `implant.psexec` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.psexec |
| `implant.pwd` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.pwd |
| `implant.reconfig` | complete | M1 | beacon | windows, linux, darwin | targets | parity-contract:implant.reconfig |
| `implant.registry` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry |
| `implant.registry.create` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry.create |
| `implant.registry.delete` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry.delete |
| `implant.registry.list-subkeys` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry.list-subkeys |
| `implant.registry.list-values` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry.list-values |
| `implant.registry.read` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry.read |
| `implant.registry.read.hive` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry.read.hive |
| `implant.registry.write` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.registry.write |
| `implant.rename` | complete | M1 | session, beacon | windows, linux, darwin | targets | parity-contract:implant.rename |
| `implant.rev2self` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.rev2self |
| `implant.rm` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.rm |
| `implant.rportfwd` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.rportfwd |
| `implant.rportfwd.add` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.rportfwd.add |
| `implant.rportfwd.rm` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.rportfwd.rm |
| `implant.runas` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.runas |
| `implant.screenshot` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.screenshot |
| `implant.services` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.services |
| `implant.services.info` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.services.info |
| `implant.services.start` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.services.start |
| `implant.services.stop` | planned | M2 | session, beacon | windows | target-workbench | parity-contract:implant.services.stop |
| `implant.shell` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.shell |
| `implant.shell.attach` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.shell.attach |
| `implant.shell.kill` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.shell.kill |
| `implant.shell.ls` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.shell.ls |
| `implant.sideload` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.sideload |
| `implant.socks5` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.socks5 |
| `implant.socks5.start` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.socks5.start |
| `implant.socks5.stop` | planned | M3 | session | windows, linux, darwin | streams | parity-contract:implant.socks5.stop |
| `implant.spawndll` | planned | M4 | session, beacon | windows | execution | parity-contract:implant.spawndll |
| `implant.ssh` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.ssh |
| `implant.tail` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.tail |
| `implant.tasks` | complete | M1 | beacon | windows, linux, darwin | targets | parity-contract:implant.tasks |
| `implant.tasks.cancel` | complete | M1 | beacon | windows, linux, darwin | targets | parity-contract:implant.tasks.cancel |
| `implant.tasks.fetch` | complete | M1 | beacon | windows, linux, darwin | targets | parity-contract:implant.tasks.fetch |
| `implant.terminate` | planned | M4 | session, beacon | windows, linux, darwin | execution | parity-contract:implant.terminate |
| `implant.upload` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.upload |
| `implant.wasm` | planned | M8 | session, beacon | windows, linux, darwin | extensions | parity-contract:implant.wasm |
| `implant.wasm.ls` | planned | M8 | session, beacon | windows, linux, darwin | extensions | parity-contract:implant.wasm.ls |
| `implant.wg-portfwd` | planned | M5 | session | windows, linux, darwin | networking | parity-contract:implant.wg-portfwd |
| `implant.wg-portfwd.add` | planned | M5 | session | windows, linux, darwin | networking | parity-contract:implant.wg-portfwd.add |
| `implant.wg-portfwd.rm` | planned | M5 | session | windows, linux, darwin | networking | parity-contract:implant.wg-portfwd.rm |
| `implant.wg-socks` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.wg-socks |
| `implant.wg-socks.start` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.wg-socks.start |
| `implant.wg-socks.stop` | planned | M5 | session, beacon | windows, linux, darwin | networking | parity-contract:implant.wg-socks.stop |
| `implant.whoami` | planned | M2 | session, beacon | windows, linux, darwin | target-workbench | parity-contract:implant.whoami |
| `root.console` | complete | M0 | not-applicable | operator-host | connection | parity-contract:root.console |
| `root.default-console` | complete | M0 | not-applicable | operator-host | connection | parity-contract:root.default-console |
| `root.implant` | operator-out-of-scope | none | not-applicable | operator-host | none | scope-denial:root.implant |
| `root.import` | in-progress | M0 | not-applicable | operator-host | connection | parity-contract:root.import, saved-config-catalog, connection-registry-saved-config |
| `root.mcp` | planned | M8 | not-applicable | operator-host | integrations | parity-contract:root.mcp |
| `root.version` | in-progress | M0 | not-applicable | operator-host | connection | parity-contract:root.version |
| `server.ai` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.ai |
| `server.aka` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.aka |
| `server.aka.create` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.aka.create |
| `server.aka.delete` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.aka.delete |
| `server.aliases` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.aliases |
| `server.aliases.install` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.aliases.install |
| `server.aliases.load` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.aliases.load |
| `server.aliases.rm` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.aliases.rm |
| `server.armory` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory |
| `server.armory.add` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.add |
| `server.armory.disable` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.disable |
| `server.armory.enable` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.enable |
| `server.armory.info` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.info |
| `server.armory.install` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.install |
| `server.armory.modify` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.modify |
| `server.armory.refresh` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.refresh |
| `server.armory.reset` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.reset |
| `server.armory.rm` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.rm |
| `server.armory.save` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.save |
| `server.armory.search` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.search |
| `server.armory.update` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.armory.update |
| `server.beacons` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.beacons |
| `server.beacons.prune` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.beacons.prune |
| `server.beacons.rm` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.beacons.rm |
| `server.beacons.watch` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.beacons.watch |
| `server.builders` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.builders |
| `server.c2profiles` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.c2profiles |
| `server.c2profiles.export` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.c2profiles.export |
| `server.c2profiles.generate` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.c2profiles.generate |
| `server.c2profiles.import` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.c2profiles.import |
| `server.certificates` | operator-out-of-scope | none | not-applicable | not-applicable | none | scope-denial:server.certificates |
| `server.certificates.authorities` | operator-out-of-scope | none | not-applicable | not-applicable | none | scope-denial:server.certificates.authorities |
| `server.clean` | operator-out-of-scope | none | not-applicable | not-applicable | none | scope-denial:server.clean |
| `server.crack` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack |
| `server.crack.hcstat2` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.hcstat2 |
| `server.crack.hcstat2.add` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.hcstat2.add |
| `server.crack.hcstat2.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.hcstat2.rm |
| `server.crack.rules` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.rules |
| `server.crack.rules.add` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.rules.add |
| `server.crack.rules.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.rules.rm |
| `server.crack.stations` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.stations |
| `server.crack.wordlists` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.wordlists |
| `server.crack.wordlists.add` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.wordlists.add |
| `server.crack.wordlists.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.crack.wordlists.rm |
| `server.creds` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.creds |
| `server.creds.add` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.creds.add |
| `server.creds.add.file` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.creds.add.file |
| `server.creds.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.creds.rm |
| `server.dns` | in-progress | M0 | not-applicable | not-applicable | jobs-listeners | parity-contract:server.dns |
| `server.docs` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.docs |
| `server.exit` | operator-out-of-scope | none | not-applicable | not-applicable | none | scope-denial:server.exit |
| `server.extensions` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.extensions |
| `server.extensions.install` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.extensions.install |
| `server.extensions.load` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.extensions.load |
| `server.extensions.rm` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.extensions.rm |
| `server.generate` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.generate, generate-page, implant-config |
| `server.generate.beacon` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.generate.beacon, generate-page, implant-config |
| `server.generate.info` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.generate.info, generate-page, implant-config |
| `server.generate.traffic-encoders` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.generate.traffic-encoders, generate-page, implant-config |
| `server.generate.traffic-encoders.add` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.generate.traffic-encoders.add, generate-page, implant-config |
| `server.generate.traffic-encoders.rm` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.generate.traffic-encoders.rm, generate-page, implant-config |
| `server.hosts` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.hosts |
| `server.hosts.ioc` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.hosts.ioc |
| `server.hosts.ioc.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.hosts.ioc.rm |
| `server.hosts.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.hosts.rm |
| `server.http` | in-progress | M0 | not-applicable | not-applicable | jobs-listeners | parity-contract:server.http |
| `server.https` | in-progress | M0 | not-applicable | not-applicable | jobs-listeners | parity-contract:server.https |
| `server.implants` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.implants |
| `server.implants.rm` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.implants.rm |
| `server.implants.stage` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.implants.stage |
| `server.info` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.info |
| `server.jobs` | in-progress | M0 | not-applicable | not-applicable | jobs-listeners | parity-contract:server.jobs, operations-job, operations-page |
| `server.licenses` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.licenses |
| `server.loot` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.loot |
| `server.loot.fetch` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.loot.fetch |
| `server.loot.local` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.loot.local |
| `server.loot.remote` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.loot.remote |
| `server.loot.rename` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.loot.rename |
| `server.loot.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.loot.rm |
| `server.mcp` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.mcp |
| `server.mcp.console` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.mcp.console |
| `server.mcp.start` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.mcp.start |
| `server.mcp.stop` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.mcp.stop |
| `server.monitor` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.monitor |
| `server.monitor.start` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.monitor.start |
| `server.monitor.stop` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.monitor.stop |
| `server.mtls` | in-progress | M0 | not-applicable | not-applicable | jobs-listeners | parity-contract:server.mtls |
| `server.operators` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.operators |
| `server.profiles` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.profiles |
| `server.profiles.generate` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.profiles.generate |
| `server.profiles.info` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.profiles.info |
| `server.profiles.new` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.profiles.new |
| `server.profiles.new.beacon` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.profiles.new.beacon |
| `server.profiles.rm` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.profiles.rm |
| `server.profiles.stage` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.profiles.stage |
| `server.reaction` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.reaction |
| `server.reaction.reload` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.reaction.reload |
| `server.reaction.save` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.reaction.save |
| `server.reaction.set` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.reaction.set |
| `server.reaction.unset` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.reaction.unset |
| `server.regenerate` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.regenerate |
| `server.sessions` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.sessions |
| `server.sessions.prune` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.sessions.prune |
| `server.settings` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings |
| `server.settings.always-overflow` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.always-overflow |
| `server.settings.autoadult` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.autoadult |
| `server.settings.beacon-autoresults` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.beacon-autoresults |
| `server.settings.console-logs` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.console-logs |
| `server.settings.readline` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.readline |
| `server.settings.readline.bind` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.readline.bind |
| `server.settings.readline.set` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.readline.set |
| `server.settings.save` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.save |
| `server.settings.small-terminal` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.small-terminal |
| `server.settings.tables` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.tables |
| `server.settings.user-connect` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.settings.user-connect |
| `server.shellcode-encoders` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.shellcode-encoders |
| `server.shellcode-encoders.encode` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.shellcode-encoders.encode |
| `server.shikata-ga-nai` | planned | M7 | not-applicable | not-applicable | payloads | parity-contract:server.shikata-ga-nai |
| `server.socks5` | planned | M5 | session | not-applicable | networking | parity-contract:server.socks5 |
| `server.socks5.stop` | planned | M5 | session | not-applicable | networking | parity-contract:server.socks5.stop |
| `server.stage-listener` | in-progress | M0 | not-applicable | not-applicable | jobs-listeners | parity-contract:server.stage-listener |
| `server.taskmany` | upstream-blocked | M9 | not-applicable | not-applicable | none | upstream-regression:server.taskmany |
| `server.update` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.update |
| `server.use` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.use |
| `server.use.beacons` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.use.beacons |
| `server.use.sessions` | complete | M1 | not-applicable | not-applicable | targets | parity-contract:server.use.sessions |
| `server.version` | planned | M8 | not-applicable | not-applicable | extensions | parity-contract:server.version |
| `server.websites` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.websites |
| `server.websites.add-content` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.websites.add-content |
| `server.websites.content-type` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.websites.content-type |
| `server.websites.list` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.websites.list |
| `server.websites.rm` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.websites.rm |
| `server.websites.rm-content` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.websites.rm-content |
| `server.websites.show` | planned | M6 | not-applicable | not-applicable | operator-data | parity-contract:server.websites.show |
| `server.wg` | in-progress | M0 | not-applicable | not-applicable | jobs-listeners | parity-contract:server.wg |
| `server.wg-config` | planned | M5 | not-applicable | not-applicable | networking | parity-contract:server.wg-config |
