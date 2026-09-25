import { Resolver } from "node:dns/promises";

const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"] as const;

interface PublicDnsResolver {
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

type PublicDnsResolverFactory = (server: string) => PublicDnsResolver;

function createPublicDnsResolver(server: string): PublicDnsResolver {
  const resolver = new Resolver({ timeout: 2_500, tries: 1 });
  resolver.setServers([server]);
  return resolver;
}

async function resolveAddresses(query: Promise<string[]>): Promise<readonly string[]> {
  try {
    return await query;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    throw error;
  }
}

/** Check public recursive DNS without relying on the host's negative DNS cache. */
export async function publicDnsPointsToServer(
  domain: string,
  publicIp: string,
  resolverFactory: PublicDnsResolverFactory = createPublicDnsResolver,
): Promise<boolean> {
  const observations = await Promise.all(PUBLIC_DNS_SERVERS.map(async (server) => {
    const resolver = resolverFactory(server);
    const [ipv4, ipv6] = await Promise.allSettled([
      resolveAddresses(resolver.resolve4(domain)),
      resolveAddresses(resolver.resolve6(domain)),
    ]);
    return { ipv4, ipv6 };
  }));

  let confirmed = false;
  for (const { ipv4, ipv6 } of observations) {
    for (const answer of [ipv4, ipv6]) {
      if (answer.status === "fulfilled" && answer.value.some((address) => address !== publicIp)) {
        throw new Error(`${domain} must resolve only to this server's public IPv4 address before HTTPS can be enabled`);
      }
    }
    // A server is conclusive only when both A and AAAA queries answered.
    if (ipv4.status === "fulfilled" && ipv6.status === "fulfilled" && ipv4.value.includes(publicIp)) {
      confirmed = true;
    }
  }
  return confirmed;
}
