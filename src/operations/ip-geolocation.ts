import { isIP } from 'net';

const BAIDU_IP_ENDPOINT = 'https://api.map.baidu.com/location/ip';
const SUCCESS_CACHE_MS = 24 * 60 * 60_000;
const FAILURE_CACHE_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;
const MAX_CACHE_ENTRIES = 2_000;

export interface IpAdministrativeLocation {
  province: string | null;
  city: string | null;
  district: string | null;
  adcode: string | null;
  displayName: string;
  source: 'baidu-ip';
}

interface CacheEntry {
  expiresAt: number;
  value: IpAdministrativeLocation | null;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

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

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parsedLocation(value: unknown): IpAdministrativeLocation | null {
  const root = objectValue(value);
  if (!root || Number(root.status) !== 0) return null;
  const content = objectValue(root.content);
  const detail = objectValue(content?.address_detail);
  if (!detail) return null;
  const province = optionalText(detail.province);
  const city = optionalText(detail.city);
  const district = optionalText(detail.district);
  const parts = [province, city, district].filter((part, index, values): part is string => (
    part !== null && values.indexOf(part) === index
  ));
  if (parts.length === 0) return null;
  const adcodeValue = detail.adcode;
  const adcode = typeof adcodeValue === 'number' && Number.isSafeInteger(adcodeValue)
    ? String(adcodeValue)
    : optionalText(adcodeValue);
  return {
    province,
    city,
    district,
    adcode,
    displayName: parts.join(' '),
    source: 'baidu-ip',
  };
}

export class IpGeolocationResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<IpAdministrativeLocation | null>>();
  private providerUnavailableUntil = 0;

  constructor(
    private readonly baiduMapAk: string | undefined,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async resolve(ipAddress: string | null): Promise<IpAdministrativeLocation | null> {
    const ip = ipAddress ? normalizedPublicIpv4(ipAddress) : null;
    const key = this.baiduMapAk?.trim();
    if (!ip || !key) return null;
    const now = Date.now();
    if (this.providerUnavailableUntil > now) return null;
    const cached = this.cache.get(ip);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) this.cache.delete(ip);
    const pending = this.inFlight.get(ip);
    if (pending) return pending;

    const lookup = this.lookup(ip, key)
      .then((value) => {
        this.remember(ip, value, Date.now());
        return value;
      })
      .catch(() => {
        const failedAt = Date.now();
        this.providerUnavailableUntil = failedAt + FAILURE_CACHE_MS;
        this.remember(ip, null, failedAt);
        return null;
      })
      .finally(() => this.inFlight.delete(ip));
    this.inFlight.set(ip, lookup);
    return lookup;
  }

  private async lookup(ip: string, key: string): Promise<IpAdministrativeLocation | null> {
    const url = new URL(BAIDU_IP_ENDPOINT);
    url.searchParams.set('ip', ip);
    url.searchParams.set('coor', 'bd09ll');
    url.searchParams.set('ak', key);
    const response = await this.fetcher(url.toString(), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Baidu IP geolocation returned HTTP ${response.status}`);
    const body = await response.json();
    const root = objectValue(body);
    if (!root || Number(root.status) !== 0) {
      throw new Error('Baidu IP geolocation rejected the request');
    }
    return parsedLocation(body);
  }

  private remember(ip: string, value: IpAdministrativeLocation | null, now: number): void {
    if (!this.cache.has(ip) && this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(ip, {
      value,
      expiresAt: now + (value ? SUCCESS_CACHE_MS : FAILURE_CACHE_MS),
    });
  }
}
