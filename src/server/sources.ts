/**
 * The public data the planning context reads besides OpenAIP: the NSW RFS incident feed, Open-Meteo,
 * ADS-B aircraft and OpenStreetMap building counts. Every call goes through the host's guarded `ctx.fetch`
 * (public internet only), each answer is cached briefly in memory, and a failed refresh serves the last answer
 * marked stale rather than nothing.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const UA = 'photoscout-drone-planning/0.1';
const MAX_CACHE_ENTRIES = 100;

/** A small TTL cache that keeps the last value past its TTL, so a failed refresh can fall back to it. */
class TtlCache<T> {
  private readonly map = new Map<string, { at: number; value: T }>();
  constructor(private readonly ttlMs: number) {}
  fresh(key: string, now = Date.now()): { at: number; value: T } | null {
    const hit = this.map.get(key);
    return hit && now - hit.at < this.ttlMs ? hit : null;
  }
  any(key: string): { at: number; value: T } | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: T, now = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { at: now, value });
    while (this.map.size > MAX_CACHE_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

async function getJson(fetchFn: FetchFn, url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      ...init,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- NSW Rural Fire Service major incidents (CC BY 4.0) ------------------------------------------

export interface FireIncident {
  id: string;
  title: string;
  category: string;
  status: string;
  sizeHa?: number;
  updated: string;
  link: string;
  geometry: GeoJSON.Geometry;
}

/** Pure parser for RFS majorIncidents GeoJSON into simplified fire incidents. */
export function parseRfs(raw: unknown): FireIncident[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { features?: unknown }).features)) return [];
  const features = (raw as { features: unknown[] }).features;
  const out: FireIncident[] = [];

  for (const f of features) {
    if (!f || typeof f !== 'object') continue;
    const feat = f as { id?: string | number; properties?: Record<string, unknown>; geometry?: GeoJSON.Geometry };
    if (!feat.geometry) continue;

    const p = feat.properties ?? {};
    const title = String(p.title ?? '').trim();
    const category = String(p.category ?? 'Not Applicable').trim();
    const desc = String(p.description ?? '');

    const statusMatch = desc.match(/STATUS:\s*([^<]+)/i);
    const status = statusMatch ? statusMatch[1].trim() : '';

    const sizeMatch = desc.match(/SIZE:\s*([\d,.]+)\s*ha/i);
    const sizeHa = sizeMatch ? parseFloat(sizeMatch[1].replace(/,/g, '')) : undefined;

    const updatedMatch = desc.match(/UPDATED:\s*([^<]+)/i);
    const updated = updatedMatch ? updatedMatch[1].trim() : String(p.pubDate ?? '').trim();

    const link = String(p.link ?? '').trim();
    const guid = p.guid ? String(p.guid) : '';
    const id = guid ? guid.split('/').filter(Boolean).pop() || guid : String(feat.id ?? out.length);

    out.push({
      id,
      title,
      category,
      status,
      ...(sizeHa != null && Number.isFinite(sizeHa) ? { sizeHa } : {}),
      updated,
      link,
      geometry: feat.geometry,
    });
  }

  return out;
}

export const RFS_FEED_URL = 'https://www.rfs.nsw.gov.au/feeds/majorIncidents.json';
const RFS_TTL_MS = 5 * 60_000;
const rfsCache = new TtlCache<FireIncident[]>(RFS_TTL_MS);

export interface RfsFeedResult {
  incidents: FireIncident[];
  fetchedAt: string;
  stale: boolean;
}

export function _resetSourceCachesForTesting(): void {
  (rfsCache as unknown as { map: Map<string, unknown> }).map.clear();
  (weatherCache as unknown as { map: Map<string, unknown> }).map.clear();
  (planesCache as unknown as { map: Map<string, unknown> }).map.clear();
  (buildingsCache as unknown as { map: Map<string, unknown> }).map.clear();
}

/** The incident list. Fresh for five minutes; if a refresh fails, the last list comes back with `stale: true`. */
export async function fetchRfs(fetchFn: FetchFn, url = RFS_FEED_URL): Promise<RfsFeedResult> {
  const hit = rfsCache.fresh('rfs');
  if (hit) return { incidents: hit.value, fetchedAt: new Date(hit.at).toISOString(), stale: false };
  try {
    const incidents = parseRfs(await getJson(fetchFn, url, {}, 10_000));
    rfsCache.set('rfs', incidents);
    return { incidents, fetchedAt: new Date().toISOString(), stale: false };
  } catch (err) {
    const old = rfsCache.any('rfs');
    if (old) return { incidents: old.value, fetchedAt: new Date(old.at).toISOString(), stale: true };
    throw err;
  }
}

/**
 * Whether a point is plausibly inside New South Wales (a coarse box that includes the ACT). The RFS feed
 * covers NSW only, so outside this box "no fire incident found" means nothing and the plan says so.
 */
export function isLikelyNsw(lat: number, lng: number): boolean {
  return lat >= -37.6 && lat <= -28.1 && lng >= 140.9 && lng <= 153.7;
}

// --- Open-Meteo: the weather now ------------------------------------------------------------------

export interface WeatherNow {
  windKmh: number | null;
  gustKmh: number | null;
  visibilityM: number | null;
  tempC: number | null;
  cloudPct: number | null;
  /** When Open-Meteo says the values apply (ISO, UTC). */
  observedAt: string | null;
}

export interface WeatherResult {
  weather: WeatherNow;
  fetchedAt: string;
}

const weatherCache = new TtlCache<WeatherNow>(10 * 60_000);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Pure: Open-Meteo `current` block (requested with timeformat=unixtime) to the values the plan uses. */
export function parseWeatherNow(raw: unknown): WeatherNow {
  const cur = (raw as { current?: Record<string, unknown> } | null)?.current;
  if (!cur || typeof cur !== 'object') throw new Error('Open-Meteo answered without current conditions');
  const t = num(cur.time);
  return {
    windKmh: num(cur.wind_speed_10m),
    gustKmh: num(cur.wind_gusts_10m),
    visibilityM: num(cur.visibility),
    tempC: num(cur.temperature_2m),
    cloudPct: num(cur.cloud_cover),
    observedAt: t != null ? new Date(t * 1000).toISOString() : null,
  };
}

/**
 * The weather at the point right now. The original read the first hour of a forecast that was requested with
 * `past_days=1`, which is midnight GMT yesterday, not now; `current` is the present hour.
 */
export async function fetchWeatherNow(fetchFn: FetchFn, lat: number, lng: number, base = 'https://api.open-meteo.com'): Promise<WeatherResult> {
  const sLat = (Math.round(lat / 0.05) * 0.05).toFixed(2);
  const sLng = (Math.round(lng / 0.05) * 0.05).toFixed(2);
  const key = `${sLat},${sLng}`;
  const hit = weatherCache.fresh(key);
  if (hit) return { weather: hit.value, fetchedAt: new Date(hit.at).toISOString() };
  const url =
    `${base}/v1/forecast?latitude=${sLat}&longitude=${sLng}` +
    '&current=temperature_2m,cloud_cover,wind_speed_10m,wind_gusts_10m,visibility' +
    '&wind_speed_unit=kmh&timeformat=unixtime&timezone=GMT';
  try {
    const weather = parseWeatherNow(await getJson(fetchFn, url));
    weatherCache.set(key, weather);
    return { weather, fetchedAt: new Date().toISOString() };
  } catch (err) {
    const old = weatherCache.any(key);
    if (old) return { weather: old.value, fetchedAt: new Date(old.at).toISOString() };
    throw err;
  }
}

// --- ADS-B aircraft (adsb.lol and adsb.fi) --------------------------------------------------------

export interface Plane {
  hex: string;
  flight: string;
  lat: number;
  lon: number;
  alt_baro: number | null;
  /** Not read from the feeds; kept optional so callers and tests that carry them still type. */
  track?: number | null;
  gs?: number | null;
  t?: string;
  seen?: number;
}

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  seen?: number;
}

/** A position older than this is not shown as "nearby". */
export const MAX_PLANE_AGE_S = 60;

/** Pure: one feed's aircraft list to planes. Drops planes with no position, on the ground, or not heard recently. */
export function toPlanes(list: unknown): Plane[] {
  if (!Array.isArray(list)) return [];
  const out: Plane[] = [];
  for (const a of list as AdsbAircraft[]) {
    if (!a || typeof a.hex !== 'string' || typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
    if (a.alt_baro === 'ground') continue;
    if (typeof a.seen === 'number' && a.seen > MAX_PLANE_AGE_S) continue;
    out.push({
      hex: a.hex.toLowerCase(),
      flight: (a.flight ?? '').trim(),
      lat: a.lat,
      lon: a.lon,
      alt_baro: typeof a.alt_baro === 'number' ? a.alt_baro : null,
    });
  }
  return out;
}

const planesCache = new TtlCache<Plane[]>(15_000);

/** Aircraft within `nm` nautical miles, merged from both feeds (one per ICAO hex). Fails only if neither feed answers. */
export async function fetchPlanes(fetchFn: FetchFn, lat: number, lng: number, nm: number, base = 'https://api.adsb.lol'): Promise<Plane[]> {
  const sLat = lat.toFixed(3);
  const sLng = lng.toFixed(3);
  const key = `${sLat},${sLng},${nm}`;
  const hit = planesCache.fresh(key);
  if (hit) return hit.value;
  const urls = [`${base}/v2/point/${sLat}/${sLng}/${nm}`, `https://opendata.adsb.fi/api/v2/lat/${sLat}/lon/${sLng}/dist/${nm}`];
  const lists = await Promise.all(
    urls.map(async (url) => {
      try {
        const data = (await getJson(fetchFn, url)) as { ac?: unknown; aircraft?: unknown } | null;
        return toPlanes(data?.ac ?? data?.aircraft ?? []);
      } catch {
        return null;
      }
    })
  );
  if (lists.every((l) => l === null)) throw new Error('no aircraft feed answered');
  const byHex = new Map<string, Plane>();
  for (const list of lists) for (const p of list ?? []) if (!byHex.has(p.hex)) byHex.set(p.hex, p);
  const planes = [...byHex.values()];
  planesCache.set(key, planes);
  return planes;
}

// --- OpenStreetMap: how many buildings are nearby -------------------------------------------------

export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const buildingsCache = new TtlCache<number>(60 * 60_000);

/** Pure: an Overpass `out count` answer to the number of ways. */
export function parseOverpassCount(raw: unknown): number {
  const els = (raw as { elements?: Array<{ type?: string; tags?: Record<string, string> }> } | null)?.elements;
  const count = els?.find((e) => e.type === 'count');
  const n = Number(count?.tags?.ways ?? count?.tags?.total);
  if (!Number.isFinite(n)) throw new Error('Overpass answered without a count');
  return n;
}

/**
 * Buildings within `radiusM` of the point. Asks Overpass for a count only (`out count`), not the footprints
 * (the original downloaded every polygon just to take `.length`), and caches per ~100 m cell for an hour.
 */
export async function fetchBuildingCount(fetchFn: FetchFn, lat: number, lng: number, radiusM: number, mirrors = OVERPASS_MIRRORS): Promise<number> {
  const r = Math.round(Math.min(1000, Math.max(50, radiusM)));
  const sLat = (Math.round(lat / 0.001) * 0.001).toFixed(3);
  const sLng = (Math.round(lng / 0.001) * 0.001).toFixed(3);
  const key = `${sLat},${sLng},${r}`;
  const hit = buildingsCache.fresh(key);
  if (hit) return hit.value;
  const query = `[out:json][timeout:15];way["building"](around:${r},${sLat},${sLng});out count;`;
  const errors: string[] = [];
  for (const url of mirrors) {
    try {
      const raw = await getJson(
        fetchFn,
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` },
        20_000
      );
      const n = parseOverpassCount(raw);
      buildingsCache.set(key, n);
      return n;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(`Overpass unavailable (${errors.join('; ')})`);
}
