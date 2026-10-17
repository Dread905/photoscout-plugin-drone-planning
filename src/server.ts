import path from 'node:path';
import type { PluginContext, ServerPlugin } from './sdk/server-api.js';
import { queryLocalAerodromes } from './server/aerodromes.js';
import { buildDroneContext, parseContextQuery, QueryError } from './server/context.js';
import type { OpenAipKv } from './server/openaip.js';

/**
 * Drone Planning, server half. Two GET routes under /api/plugins/<id>/:
 *
 *   /aerodromes  public. The local aerodrome dataset (<dataDir>/aerodromes.json) around a point.
 *   /context     signed-in. Fire hazards, weather, aircraft, buildings and OpenAIP airspace for a point and
 *                radius, with the assessment. OpenAIP is read with the key the admin saved in Settings.
 *
 * Planning guidance only: nothing here says a flight is legal, safe or approved.
 */

const ONE_DAY_MS = 24 * 60 * 60_000;
const MAX_KV_ENTRIES = 200;

/** The plugin's own cache table in its own SQLite file; old and surplus rows are dropped on every write. */
function kvOver(ctx: PluginContext): OpenAipKv {
  ctx.db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL)');
  const read = ctx.db.prepare('SELECT value FROM kv WHERE key = ?');
  const write = ctx.db.prepare('INSERT INTO kv (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at');
  const dropOld = ctx.db.prepare('DELETE FROM kv WHERE at < ?');
  const dropSurplus = ctx.db.prepare('DELETE FROM kv WHERE key IN (SELECT key FROM kv ORDER BY at DESC LIMIT -1 OFFSET ?)');
  return {
    get: (key) => (read.get(key) as { value: string } | undefined)?.value ?? null,
    set: (key, value) => {
      const now = Date.now();
      write.run(key, value, now);
      dropOld.run(now - ONE_DAY_MS);
      dropSurplus.run(MAX_KV_ENTRIES);
    },
  };
}

const plugin: ServerPlugin = {
  activate(ctx) {
    const kv = kvOver(ctx);
    const fetchFn = (url: string, init?: RequestInit) => ctx.fetch(url, init);
    const aerodromesFile = path.join(ctx.dataDir, 'aerodromes.json');

    ctx.router.get('/aerodromes', (req, res) => {
      try {
        const { lat, lng, radiusM } = parseContextQuery(req.query);
        res.json(queryLocalAerodromes({ lat, lng, radiusM, filePath: aerodromesFile }));
      } catch (err) {
        if (err instanceof QueryError) {
          res.status(400).json({ error: err.message });
          return;
        }
        ctx.log.error(`aerodromes: ${(err as Error).message}`);
        res.status(500).json({ error: 'Aerodrome data is unavailable' });
      }
    });

    ctx.router.get('/context', async (req, res) => {
      if (!ctx.auth.requireUser(req, res)) return;
      try {
        const query = parseContextQuery(req.query);
        const key = ctx.settings.get().openaipApiKey;
        const local = queryLocalAerodromes({ ...query, filePath: aerodromesFile });
        const context = await buildDroneContext(
          { fetchFn, kv, openAipKey: typeof key === 'string' ? key : '', local },
          query
        );
        res.json(context);
      } catch (err) {
        if (err instanceof QueryError) {
          res.status(400).json({ error: err.message });
          return;
        }
        // The message is logged for the admin and never sent: it can hold an upstream URL.
        ctx.log.error(`context: ${(err as Error).message}`);
        res.status(502).json({ error: 'Drone planning context is unavailable' });
      }
    });
  },
};

export default plugin;
