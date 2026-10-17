import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

const root = path.resolve(import.meta.dirname, '..');

test('the build makes a zip holding exactly plugin.json, server.js and web.js, with no key or source in them', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'build.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')) as { id: string; version: string };
  const zip = path.join(root, 'dist', `${manifest.id}-${manifest.version}.zip`);
  const entries = unzipSync(fs.readFileSync(zip));
  assert.deepEqual(Object.keys(entries).sort(), ['plugin.json', 'server.js', 'web.js']);

  const text = (name: string) => Buffer.from(entries[name]).toString('utf8');
  // The browser bundle is public, even on a private instance: the key header and the geometry library stay server-side.
  assert.ok(!text('web.js').includes('x-openaip-api-key'));
  assert.ok(!text('web.js').includes('jsts'));
  assert.ok(text('server.js').includes('x-openaip-api-key'));
  for (const name of Object.keys(entries)) {
    assert.doesNotMatch(text(name), /sk-[A-Za-z0-9]{20,}|BEGIN (RSA )?PRIVATE KEY/);
  }
});

test('external repository: has its own identity and vendored plugin contracts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8')) as { id: string; author: string; homepage: string };
  assert.equal(manifest.id, 'map.dread905.drone-planning');
  assert.equal(manifest.author, 'Dread905');
  assert.equal(manifest.homepage, 'https://github.com/Dread905/photoscout-plugin-drone-planning');

  for (const file of ['src/server.ts', 'src/web.ts', 'test/server.test.ts', 'test/web.test.ts']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(text, /@photoscout\/plugin-sdk\/(server|web)/);
  }
  assert.match(fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8'), /\.\/sdk\/server-api\.js/);
  assert.match(fs.readFileSync(path.join(root, 'src/web.ts'), 'utf8'), /\.\/sdk\/web-api\.js/);
  assert.ok(fs.existsSync(path.join(root, 'src/sdk/server-api.ts')));
  assert.ok(fs.existsSync(path.join(root, 'src/sdk/web-api.ts')));
});
