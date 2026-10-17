import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PluginContext } from '../src/sdk/server-api.js';
import plugin from '../src/server.js';
import { _resetSourceCachesForTesting } from '../src/server/sources.js';
import { parseContextQuery, QueryError } from '../src/server/context.js';

const SECRET = 'openaip-secret-key-123456';

type Handler = (req: unknown, res: unknown) => unknown;

interface Reply {
  status: number;
  body: any;
}

/** A plugin context with a recording router, an in-memory SQLite and a scripted network. */
function harness(opts: { signedIn?: boolean; settings?: Record<string, unknown>; net?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const routes = new Map<string, Handler>();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drone-plugin-'));
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const ctx = {
    router: { get: (p: string, h: Handler) => void routes.set(p, h) },
    auth: {
      requireUser: (_req: unknown, res: any) => {
        if (opts.signedIn) return true;
        res.status(401).json({ error: 'Sign in required' });
        return false;
      },
      requireAdmin: () => false,
    },
    settings: { get: () => opts.settings ?? {}, onChange: () => () => {} },
    tasks: { register: () => {} },
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return opts.net ? opts.net(url, init) : new Response('{}', { status: 404 });
    },
    db: new DatabaseSync(':memory:'),
    dataDir,
    log: { info() {}, warn() {}, error() {} },
    services: { url: () => null },
    areas: () => [],
    manifest: {},
  } as unknown as PluginContext;
  plugin.activate(ctx);
  const call = async (route: string, query: Record<string, string>): Promise<Reply> => {
    const handler = routes.get(route);
    assert.ok(handler, `no route ${route}`);
    let reply: Reply = { status: 200, body: undefined };
    const res = {
      status(code: number) {
        reply.status = code;
        return res;
      },
      json(body: unknown) {
        reply.body = body;
        return res;
      },
    };
    await handler({ query }, res);
    return reply;
  };
  return { ctx, call, dataDir, calls, routes };
}

const BATHURST = { lat: '-33.4190', lng: '149.5770', radiusM: '5000' };
const MELBOURNE = { lat: '-37.8136', lng: '144.9631', radiusM: '5000' };

/** A small dataset: one controlled aerodrome with a verified east-west runway. */
function writeDataset(dir: string, lat: number, lng: number) {
  fs.writeFileSync(
    path.join(dir, 'aerodromes.json'),
    JSON.stringify({
      schemaVersion: '1.0',
      datasetId: 'test',
      name: 'Test aerodromes',
      publishedAt: '2026-10-01',
      effectiveDate: '2026-10-01',
      licence: 'test',
      authority: 'test',
      records: [
        {
          id: 'YTST',
          name: 'Test Airport',
          icaoCode: 'YTST',
          controlled: true,
          geometry: { type: 'Point', coordinates: [lng, lat] },
          runways: [{ designator: '09/27', thresholdEndpoints: [[lng - 0.01, lat], [lng + 0.01, lat]] }],
          provenance: { source: 'test', licence: 'test', authority: 'test', effectiveDate: '2026-10-01' },
        },
      ],
    })
  );
}

/** Network for the context route: every public source answers, OpenAIP says nothing. */
function publicNet(url: string): Response {
  if (url.includes('open-meteo')) return new Response(JSON.stringify({ current: { time: 1_760_000_000, wind_speed_10m: 12, wind_gusts_10m: 20, visibility: 30000, temperature_2m: 20, cloud_cover: 10 } }));
  if (url.includes('adsb')) return new Response(JSON.stringify({ ac: [] }));
  if (url.includes('overpass') || url.includes('kumi') || url.includes('coffee')) return new Response(JSON.stringify({ elements: [{ type: 'count', tags: { ways: '2' } }] }));
  if (url.includes('rfs.nsw.gov.au')) return new Response(JSON.stringify({ features: [] }));
  if (url.includes('openaip')) return new Response(JSON.stringify({ items: [], totalPages: 1 }));
  return new Response('not found', { status: 404 });
}

test('manifest: only the local aerodrome route is public', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.public, ['/aerodromes']);
  assert.ok(manifest.settings.some((s: { key: string; type: string }) => s.key === 'openaipApiKey' && s.type === 'secret'));
});

test('query: empty, repeated and out-of-range values are rejected (an empty lat used to become 0)', () => {
  assert.throws(() => parseContextQuery({ lat: '', lng: '' }), QueryError);
  assert.throws(() => parseContextQuery({ lat: ['1', '2'], lng: '3' }), QueryError);
  assert.throws(() => parseContextQuery({ lat: '91', lng: '0' }), QueryError);
  assert.throws(() => parseContextQuery({ lat: '0', lng: '0', radiusM: '60000' }), QueryError);
  assert.throws(() => parseContextQuery({ lat: '0', lng: '0', radiusM: '' }), QueryError);
  assert.deepEqual(parseContextQuery({ lat: '-33.4', lng: '149.6' }), { lat: -33.4, lng: 149.6, radiusM: 5000 });
});

test('/aerodromes: public, 400 on a bad query, "unavailable" with no dataset installed', async () => {
  const { call } = harness();
  assert.equal((await call('/aerodromes', { lat: '', lng: '' })).status, 400);
  const res = await call('/aerodromes', BATHURST);
  assert.equal(res.status, 200);
  assert.equal(res.body.available, false);
  assert.equal(res.body.status, 'unavailable');
});

test('/aerodromes: serves the dataset from the plugin data folder and rereads it when the file changes', async () => {
  const { call, dataDir } = harness();
  writeDataset(dataDir, -33.419, 149.577);
  const first = await call('/aerodromes', BATHURST);
  assert.equal(first.body.status, 'ok');
  assert.equal(first.body.airports.length, 1);
  assert.ok(first.body.airports[0].controlledBuffer, 'a verified controlled aerodrome gets its 3 NM zone');

  const changed = JSON.parse(fs.readFileSync(path.join(dataDir, 'aerodromes.json'), 'utf8'));
  changed.records[0].name = 'Renamed Airport';
  fs.writeFileSync(path.join(dataDir, 'aerodromes.json'), JSON.stringify(changed, null, 1));
  const second = await call('/aerodromes', BATHURST);
  assert.equal(second.body.airports[0].name, 'Renamed Airport');
});

test('/context: needs a session', async () => {
  const { call } = harness({ signedIn: false });
  const res = await call('/context', BATHURST);
  assert.equal(res.status, 401);
});

test('/context without an OpenAIP key: not configured, and no call goes to OpenAIP', async () => {
  _resetSourceCachesForTesting();
  const { call, calls } = harness({ signedIn: true, net: publicNet });
  const res = await call('/context', BATHURST);
  assert.equal(res.status, 200);
  assert.equal(res.body.configured, false);
  assert.equal(res.body.weather.windKmh, 12);
  assert.ok(!calls.some((c) => c.url.includes('openaip')));
  const gateIds = res.body.assessment.notChecked.map((g: { id: string }) => g.id);
  assert.ok(gateIds.includes('gate-notam') && gateIds.includes('gate-emergency'), 'NOTAM and emergency gates are always present');
});

test('/context: a controlled aerodrome from the local dataset counts towards the verdict without an OpenAIP key', async () => {
  _resetSourceCachesForTesting();
  const { call, dataDir } = harness({ signedIn: true, net: publicNet });
  writeDataset(dataDir, -33.419, 149.577);
  const res = await call('/context', BATHURST);
  const ids = res.body.assessment.evidence.map((e: { id: string }) => e.id);
  assert.ok(ids.includes('airport-YTST'), ids.join(','));
  assert.equal(res.body.assessment.overallSeverity, 'caution');
});

test('/context outside NSW: the fire check says the feed does not cover it, and the feed is not asked', async () => {
  _resetSourceCachesForTesting();
  const { call, calls } = harness({ signedIn: true, net: publicNet });
  const res = await call('/context', MELBOURNE);
  assert.ok(!calls.some((c) => c.url.includes('rfs.nsw.gov.au')));
  const fire = res.body.assessment.evidence.find((e: { id: string }) => e.id === 'gate-fire-status');
  assert.ok(fire, 'a not-checked fire gate');
  assert.match(fire.explanation, /outside NSW/);
});

test('/context with a key: the key goes only in the OpenAIP header, and never comes back in a reply', async () => {
  _resetSourceCachesForTesting();
  const { call, calls } = harness({
    signedIn: true,
    settings: { openaipApiKey: SECRET },
    net: (url) => (url.includes('openaip') ? new Response(`bad key ${SECRET}`, { status: 401 }) : publicNet(url)),
  });
  const res = await call('/context', BATHURST);
  assert.equal(res.body.configured, true);
  const oaip = calls.filter((c) => c.url.includes('openaip'));
  assert.ok(oaip.length > 0);
  for (const c of oaip) {
    assert.equal(c.headers['x-openaip-api-key'], SECRET);
    assert.ok(!c.url.includes(SECRET));
  }
  assert.ok(!JSON.stringify(res.body).includes(SECRET));
  assert.ok(!calls.filter((c) => !c.url.includes('openaip')).some((c) => JSON.stringify(c.headers).includes(SECRET)), 'other hosts never see the key');
});

test('/context: a full OpenAIP page set marks the airspace list as incomplete', async () => {
  _resetSourceCachesForTesting();
  const { call } = harness({
    signedIn: true,
    settings: { openaipApiKey: SECRET },
    net: (url) => {
      if (!url.includes('openaip')) return publicNet(url);
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify({ items: [{ _id: `${url.includes('/airports') ? 'ap' : 'as'}${page}${new URL(url).searchParams.get('bbox')}`, name: 'Z', type: 4, geometry: { type: 'Polygon', coordinates: [[[149.5, -33.5], [149.7, -33.5], [149.7, -33.3], [149.5, -33.3], [149.5, -33.5]]] } }], totalPages: 40 }));
    },
  });
  const res = await call('/context', BATHURST);
  assert.equal(res.body.sources.openaip.truncated, true);
  assert.ok(res.body.assessment.evidence.some((e: { id: string }) => e.id === 'gate-openaip-truncated'));
});

test('the plugin cache stays bounded: old and surplus rows are dropped', async () => {
  _resetSourceCachesForTesting();
  const { call, ctx } = harness({ signedIn: true, settings: { openaipApiKey: SECRET }, net: publicNet });
  for (let i = 0; i < 230; i++) {
    // Points a degree apart land in different cache cells.
    await call('/context', { lat: String(-20 - (i % 15) * 0.5), lng: String(120 + Math.floor(i / 15) * 1.0), radiusM: '1000' });
  }
  const { n } = ctx.db.prepare('SELECT COUNT(*) AS n FROM kv').get() as { n: number };
  assert.ok(n <= 200, `${n} rows`);
  assert.ok(n > 100, 'but the cache is still doing its job');
});
