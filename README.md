# PhotoScout Drone Planning

An advisory drone planning overlay for Australia, independently maintained by Dread905 and based on PhotoScout's `plugin-example/drone-planning` port of PR #6. **Planning guidance only**: it never says a flight is legal, safe, approved, cleared or permitted. NOTAMs and non-fire emergency operations remain visibly **Not checked**.

## What it does

- Adds a `Drone planning` legend toggle for the planned-flight circle, OpenAIP airspace, local aerodromes with runway-derived 3 NM buffers and approach/height-band zones, NSW RFS fire buffers, and OpenAIP airport points.
- Adds a corner widget for the verdict, selected point/radius, current weather and ADS-B awareness; the evidence/checklist panel carries sources and explicit not-checked gates.
- Keeps OpenAIP credentials server-side in a host-managed secret setting. No credential is packaged in the browser bundle.

## Setup

- **OpenAIP key** (optional): an administrator saves it under **Settings → Plugins**. The key is sent only to `api.core.openaip.net` from the server.
- **Aerodrome dataset** (optional): install `aerodromes.json` in the plugin data folder, `data/plugins/map.dread905.drone-planning/data/`. No dataset ships with this plugin. Each record needs provenance and explicit validated runway threshold endpoints before runway-derived geometry is shown.

## Local development

```sh
npm install
npm run typecheck
npm test
npm run build
```

To validate/build against the live PhotoScout plugin contract, use a PhotoScout checkout:

```sh
node /path/to/photoscout/scripts/plugin.mjs sdk-check . --sdk /path/to/photoscout
node /path/to/photoscout/scripts/plugin.mjs validate .
node /path/to/photoscout/scripts/plugin.mjs build .
```

The packaged zip must contain only `plugin.json`, `server.js`, and `web.js`.

## Release gates

Known limitations remain deliberate: no NOTAM feed, no non-fire emergency-operation feed, NSW RFS coverage only, no bundled aerodrome dataset, weather is current rather than planned-flight-time forecast.
