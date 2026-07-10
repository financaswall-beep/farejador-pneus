import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type PushDnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemLookup: PushDnsLookup = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function publicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  if (a >= 224) return false;
  return true;
}

function publicIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('::ffff:')) return false;
  if (/^f[cd]/.test(normalized)) return false; // unique-local fc00::/7
  if (/^fe[89ab]/.test(normalized)) return false; // link-local fe80::/10
  if (normalized.startsWith('ff')) return false; // multicast
  if (normalized.startsWith('2001:db8:')) return false; // documentacao
  if (normalized.startsWith('64:ff9b:')) return false; // NAT64, evita pivot indireto
  return true;
}

export function isPublicNetworkAddress(address: string): boolean {
  const version = isIP(address.replace(/^\[|\]$/g, ''));
  if (version === 4) return publicIpv4(address);
  if (version === 6) return publicIpv6(address);
  return false;
}

/**
 * Valida endpoint antes de persistir e novamente antes do envio.
 * Bloqueia protocolo/porta inesperados e destinos internos resolvidos por DNS.
 */
export async function isAllowedPushEndpoint(
  rawEndpoint: string,
  dnsLookup: PushDnsLookup = systemLookup,
): Promise<boolean> {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    return false;
  }

  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return false;
  if (endpoint.port && endpoint.port !== '443') return false;

  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) {
    return false;
  }

  if (isIP(hostname)) return isPublicNetworkAddress(hostname);

  try {
    const addresses = await dnsLookup(hostname);
    return addresses.length > 0 && addresses.every(({ address }) => isPublicNetworkAddress(address));
  } catch {
    return false;
  }
}
