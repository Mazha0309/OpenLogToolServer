import { isIP } from 'net';
import IP2Region, { IP2RegionResult } from 'ip2region';

const MAX_CACHE_ENTRIES = 20_000;
const offlineSearcher = new IP2Region({ disableIpv6: true });

export interface IpAdministrativeLocation {
  country: string | null;
  province: string | null;
  city: string | null;
  isp: string | null;
  displayName: string;
  source: 'ip2region';
}

type IpSearcher = (ipAddress: string) => IP2RegionResult | null;

function normalizedPublicIpv4(value: string): string | null {
  const normalized = value.trim().replace(/^::ffff:/i, '');
  if (isIP(normalized) !== 4) return null;
  const octets = normalized.split('.').map(Number);
  const [a, b] = octets;
  const privateOrReserved =
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113);
  return privateOrReserved ? null : normalized;
}

function optionalRegionPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized !== '0' && normalized.length <= 128
    ? normalized
    : null;
}

function parsedLocation(value: IP2RegionResult | null): IpAdministrativeLocation | null {
  if (!value) return null;
  const country = optionalRegionPart(value.country);
  const province = optionalRegionPart(value.province);
  const city = optionalRegionPart(value.city);
  const isp = optionalRegionPart(value.isp);
  const parts = [country, province, city, isp].filter((part, index, values): part is string => (
    part !== null && values.indexOf(part) === index
  ));
  if (parts.length === 0) return null;
  return {
    country,
    province,
    city,
    isp,
    displayName: parts.join(' '),
    source: 'ip2region',
  };
}

export class IpGeolocationResolver {
  private readonly cache = new Map<string, IpAdministrativeLocation | null>();

  constructor(
    private readonly searcher: IpSearcher = (ipAddress) => offlineSearcher.search(ipAddress),
  ) {}

  async resolve(ipAddress: string | null): Promise<IpAdministrativeLocation | null> {
    const ip = ipAddress ? normalizedPublicIpv4(ipAddress) : null;
    if (!ip) return null;
    if (this.cache.has(ip)) return this.cache.get(ip) ?? null;

    let location: IpAdministrativeLocation | null;
    try {
      location = parsedLocation(this.searcher(ip));
    } catch {
      location = null;
    }
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(ip, location);
    return location;
  }
}
