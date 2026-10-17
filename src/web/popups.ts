import type { PopupKind } from './layers.js';

/** One line of a popup: `alert` is highlighted, `note` is italic. */
interface Line {
  text: string;
  style?: 'alert' | 'note' | 'small';
}

/**
 * Build a popup from text nodes only. The core overlay built HTML strings and escaped them by hand; here every
 * value goes through `textContent`, so nothing in a feed or dataset can become markup.
 */
function build(title: string, lines: Line[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'drone-popup';
  const strong = document.createElement('strong');
  strong.textContent = title;
  root.append(strong);
  for (const line of lines) {
    const row = document.createElement(line.style === 'note' ? 'em' : 'span');
    if (line.style === 'alert') row.className = 'drone-popup-alert';
    if (line.style === 'small') row.className = 'drone-popup-small';
    row.textContent = line.text;
    root.append(document.createElement('br'), row);
  }
  return root;
}

const str = (v: unknown, fallback = ''): string => (v == null || v === '' ? fallback : String(v));
const isTrue = (v: unknown): boolean => v === true || v === 'true';

function airspace(p: Record<string, unknown>): HTMLElement {
  const type = str(p.typeName);
  return build(`${str(p.name, 'Airspace')}${type ? ` (${type})` : ''}`, [
    { text: `Limits: ${str(p.lowerLimitText)} to ${str(p.upperLimitText)}` },
    { text: 'Advisory context. Verify active status with official aviation publications.', style: 'note' },
  ]);
}

function airport(p: Record<string, unknown>): HTMLElement {
  const icao = p.icaoCode ? ` (${str(p.icaoCode)})` : '';
  const lines: Line[] = [];
  if (isTrue(p.outsidePlannedRadius)) lines.push({ text: 'Outside selected planned flight radius', style: 'alert' });
  if (isTrue(p.runwayGeometryUnavailable)) lines.push({ text: 'Runway geometry unavailable. Verify current aerodrome data.', style: 'alert' });
  if (isTrue(p.controlled)) {
    lines.push({ text: 'Controlled aerodrome (CASR 101.238(d)(v))', style: 'alert' });
    lines.push({
      text: isTrue(p.runwayGeometryUnavailable)
        ? 'No verified runway coordinates, so the 3 NM buffer is not drawn. Confirm applicable CASA conditions before flight.'
        : '3 NM conditional planning buffer shown. Conditions depend on aircraft category and weight (including the 250 g threshold) and on permissions. Confirm applicable CASA conditions before flight.',
      style: 'note',
    });
  } else {
    lines.push({ text: 'Aerodrome or landing area context' });
    lines.push({ text: 'Check for aircraft movements and approach and departure corridors before flight.', style: 'note' });
  }
  return build(`${str(p.name, 'Aerodrome')}${icao}`, lines);
}

function openAipAirport(p: Record<string, unknown>): HTMLElement {
  const icao = p.icaoCode ? ` (${str(p.icaoCode)})` : '';
  const lines: Line[] = [{ text: 'OpenAIP airport context', style: 'alert' }];
  if (isTrue(p.outsidePlannedRadius)) lines.push({ text: 'Outside selected planned flight radius', style: 'alert' });
  lines.push({ text: isTrue(p.controlled) ? 'Controlled aerodrome, point only' : 'Aerodrome, point only' });
  if (p.runwaySummary) lines.push({ text: `Runway context: ${str(p.runwaySummary)}` });
  lines.push({ text: 'Provider context only. It may be incomplete and does not replace pilot checks.', style: 'note' });
  lines.push({ text: 'Data provided by openAIP (CC BY-NC-SA 4.0)', style: 'small' });
  return build(`${str(p.name, 'Aerodrome')}${icao}`, lines);
}

function runwayZone(p: Record<string, unknown>, label: string, fallbackDisclaimer: string, note: string): HTMLElement {
  const icao = p.icaoCode ? ` (${str(p.icaoCode)})` : '';
  const rwy = p.runwayDesignator ? ` RWY ${str(p.runwayDesignator)}` : '';
  return build(`${str(p.airportName || p.name, 'Controlled aerodrome')}${icao}${rwy}: ${label}`, [
    { text: str(p.disclaimer, fallbackDisclaimer), style: 'alert' },
    { text: note, style: 'note' },
  ]);
}

function fire(p: Record<string, unknown>): HTMLElement {
  return build(str(p.title, 'Fire operation'), [
    { text: `Alert: ${str(p.category)} | Status: ${str(p.status)}` },
    { text: str(p.disclaimer, 'Modelled fire-operation hazard buffer.'), style: 'alert' },
    { text: 'CASR 101.238(e) restricts flight over emergency operations without approval from the person in charge.', style: 'note' },
  ]);
}

/** The popup for a clicked feature. `kind` comes from the layer; `props` are the feature's properties. */
export function popupContent(kind: PopupKind, props: Record<string, unknown>, layerId: string): HTMLElement {
  switch (kind) {
    case 'airspace':
      return airspace(props);
    case 'airport':
      return airport(props);
    case 'openaip':
      return openAipAirport(props);
    case 'fire':
      return fire(props);
    case 'c3nm':
      return runwayZone(
        props,
        '3 NM buffer',
        'Controlled aerodrome 3 NM conditional planning buffer (CASR 101.238(d)(v)).',
        'Conditional planning buffer: conditions depend on aircraft category and weight (including the 250 g threshold) and on permissions. Confirm applicable CASA conditions before flight.'
      );
    case 'core':
      return runwayZone(
        props,
        'approach and departure path',
        'Advisory approach and departure corridor. Not clearance.',
        'CASR Part 101 MOS s 4.05 core approach and departure path out to 7 km, derived from the runway thresholds. Advisory context only.'
      );
    case 'band':
      return runwayZone(
        props,
        'height-aware band (90 m / 300 ft)',
        'Advisory height-aware band, 7 km to 8.5 km from the runway end.',
        'CASR Part 101 MOS s 4.05(2)(b)(ii) outer corridor, derived from the runway thresholds. Rules may apply above 90 m (300 ft) over aerodrome elevation. Advisory context only.'
      );
    default:
      return build(layerId, []);
  }
}
