import type * as React from 'react';
import type { DroneEvidence, DroneSeverity, PlannerActions, PlannerState, PlannerStore } from './types.js';

/**
 * The planner as React components, built with the host's React (host.ui.react), so this bundle ships no copy
 * of it. No JSX, so elements are made with createElement.
 *
 *   - the corner widget: the verdict, the point and radius, the live context, a button to open the details;
 *   - the details panel: evidence, "not checked" gates, the pilot checklist, sources and the disclaimer.
 */

export interface ViewDeps {
  react: typeof React;
  store: PlannerStore;
  actions: PlannerActions;
}

const SEVERITY: Record<DroneSeverity, { label: string; cls: string }> = {
  restriction: { label: 'Restriction', cls: 'restriction' },
  caution: { label: 'Caution', cls: 'caution' },
  not_checked: { label: 'Not checked', cls: 'not-checked' },
  pilot_responsibility: { label: 'Pilot responsibility', cls: 'responsibility' },
  info: { label: 'Advisory context', cls: 'info' },
};

const AUTHORITY: Record<string, string> = {
  legislation: 'Legislation (CASR)',
  regulator_guidance: 'Regulator guidance (CASA)',
  provider_context: 'Provider context (openAIP / ADS-B)',
  product_policy: 'Product policy heuristic',
  unknown: 'Unverified / external source',
};

export const DISCLAIMER =
  'Planning guidance only. PhotoScout does not confirm that a flight is legal, authorised, or safe. The remote pilot is responsible for checking current airspace, NOTAMs, emergency operations, approvals, operating conditions, and all applicable laws.';

const fmtTime = (iso?: string): string => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString() : '';
};

/** Subscribe a component to the store; it re-renders when the state object changes. */
function useStore(react: typeof React, store: PlannerStore): PlannerState {
  return react.useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function createCorner({ react, store, actions }: ViewDeps): React.FunctionComponent {
  const h = react.createElement;

  return function DroneCorner() {
    const s = useStore(react, store);
    const { context, aerodromes } = s;
    const a = context?.assessment;
    const severity: DroneSeverity = a?.overallSeverity ?? (s.signedIn ? 'not_checked' : 'info');
    const busy = s.loading || s.aerodromesLoading;
    const summary = a?.summary ?? (busy ? 'Loading planning context…' : 'Advisory drone planning guidance');
    const sev = SEVERITY[severity];

    const alerts: React.ReactNode[] = [];
    if (!s.signedIn) {
      alerts.push(h('p', { key: 'signin', className: 'dp-alert dp-alert--info' }, 'Sign in for fire, weather, aircraft and airspace context. Local aerodrome data does not need an account.'));
    } else if (context && !context.configured) {
      alerts.push(h('p', { key: 'nokey', className: 'dp-alert dp-alert--warn' }, 'No OpenAIP API key is set, so airspace polygons are not loaded. An admin can add one under Settings, Plugins.'));
    }
    if (s.error) alerts.push(h('p', { key: 'err', role: 'alert', className: 'dp-alert dp-alert--error' }, `Planning context error: ${s.error}`));
    if (s.aerodromesError) alerts.push(h('p', { key: 'aerr', role: 'alert', className: 'dp-alert dp-alert--error' }, `Aerodrome data error: ${s.aerodromesError}`));
    if (aerodromes && (!aerodromes.available || aerodromes.status !== 'ok')) {
      alerts.push(h('p', { key: 'nodata', className: 'dp-alert dp-alert--info' }, aerodromes.message || 'No local aerodrome dataset is installed, so runway-derived zones are not drawn.'));
    }
    if (context?.rules.stale) {
      alerts.push(h('p', { key: 'rules', className: 'dp-alert dp-alert--warn' }, `The encoded CASR rules were last checked ${context.rules.checkedDate} and are past their review date (${context.rules.reviewBy}). Check current legislation.`));
    }

    const w = context?.weather;
    const ac = context?.aircraft;

    return h('section', { className: 'dp-corner', 'aria-label': 'Drone planning' },
      h('div', { className: 'dp-head' },
        h('strong', null, 'Drone planning'),
        h('span', { className: `dp-badge dp-badge--${sev.cls}` }, sev.label),
        a?.stale && h('span', { className: 'dp-badge dp-badge--stale' }, 'Stale data')),
      h('p', { className: 'dp-summary' }, summary),
      h('div', { className: 'dp-row' },
        h('span', null, s.point ? `Pin ${s.point.lat.toFixed(4)}, ${s.point.lng.toFixed(4)}` : 'Map centre'),
        s.point
          ? h('button', { type: 'button', className: 'dp-btn', onClick: () => actions.setPoint(null) }, 'Reset to centre')
          : s.centre && h('button', { type: 'button', className: 'dp-btn', onClick: () => actions.setPoint(s.centre) }, 'Drop pin here'),
        h('button', { type: 'button', className: 'dp-btn', onClick: actions.refresh, disabled: busy }, busy ? 'Refreshing…' : 'Refresh')),
      h('label', { className: 'dp-radius' },
        'Planned flight radius: ', h('strong', null, `${s.radiusKm} km`),
        h('input', {
          type: 'range', min: 1, max: 50, step: 1, value: s.radiusKm,
          'aria-valuetext': `${s.radiusKm} km`,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => actions.setRadiusKm(Number(e.target.value)),
        })),
      alerts,
      (w || ac) && h('div', { className: 'dp-chips' },
        w && h('div', { className: 'dp-chip' },
          h('span', { className: 'dp-chip__label' }, 'Weather now'),
          `${w.tempC != null ? `${Math.round(w.tempC)}°C · ` : ''}wind ${w.windKmh != null ? `${Math.round(w.windKmh)} km/h` : '–'}`,
          w.gustKmh != null ? ` (gusts ${Math.round(w.gustKmh)})` : '',
          w.visibilityM != null ? ` · vis ${Math.round(w.visibilityM / 1000)} km` : ''),
        ac && h('div', { className: 'dp-chip' },
          h('span', { className: 'dp-chip__label' }, 'ADS-B traffic'),
          ac.count === 0
            ? 'None heard in the air nearby'
            : ac.closest
              ? `${ac.closest.flight || ac.closest.hex}${ac.closest.distanceM != null ? ` · ${(ac.closest.distanceM / 1000).toFixed(1)} km` : ''}${ac.closest.alt_baro != null ? ` · ${ac.closest.alt_baro} ft` : ''}${ac.count > 1 ? ` · ${ac.count} aircraft` : ''}`
              : `${ac.count} aircraft nearby`)),
      h('div', { className: 'dp-row' },
        h('button', { type: 'button', className: 'dp-btn dp-btn--primary', onClick: actions.openDetails }, 'Evidence and checklist'),
        a?.evaluatedAt && h('span', { className: 'dp-muted' }, `Evaluated ${fmtTime(a.evaluatedAt)}`)),
      h('p', { className: 'dp-disclaimer' }, DISCLAIMER));
  };
}

export function createDetails({ react, store }: ViewDeps): React.FunctionComponent<{ close(): void }> {
  const h = react.createElement;

  const badge = (severity: DroneSeverity) =>
    h('span', { className: `dp-badge dp-badge--${SEVERITY[severity]?.cls ?? 'info'}` }, SEVERITY[severity]?.label ?? severity);

  return function DroneDetails({ close }) {
    const s = useStore(react, store);
    const [checked, setChecked] = react.useState<Record<string, boolean>>({});
    const { context, aerodromes } = s;
    const a = context?.assessment;

    const evidenceCard = (item: DroneEvidence) =>
      h('div', { key: item.id, className: `dp-card dp-card--${item.severity}` },
        h('div', { className: 'dp-card__head' },
          badge(item.severity),
          item.outsidePlannedRadius && h('span', { className: 'dp-badge dp-badge--outside' }, 'Outside planned radius'),
          item.ruleId && h('span', { className: 'dp-badge dp-badge--rule' }, item.ruleId.toUpperCase()),
          h('span', { className: 'dp-badge dp-badge--authority' }, AUTHORITY[item.authority] ?? item.authority)),
        h('h4', null, item.title),
        h('p', null, item.explanation),
        h('p', { className: 'dp-action' }, h('strong', null, 'Action: '), item.userAction),
        item.source && h('p', { className: 'dp-muted' }, `Source: ${item.source.name}${item.source.fetchedAt ? ` · ${fmtTime(item.source.fetchedAt)}` : ''}`));

    return h('div', { className: 'dp-details' },
      h('div', { className: 'dp-head' },
        h('h2', null, 'Drone planning'),
        h('button', { type: 'button', className: 'dp-btn', onClick: close, 'aria-label': 'Close drone planning details' }, 'Close')),
      !a && h('p', { className: 'dp-muted' }, s.loading ? 'Loading planning context…' : 'No planning context yet.'),

      a && a.evidence.length > 0 && h('section', null,
        h('h3', null, `Mapped evidence and cautions (${a.evidence.length})`),
        a.evidence.map(evidenceCard)),

      a && a.notChecked.length > 0 && h('section', null,
        h('h3', null, `Not checked (${a.notChecked.length})`),
        h('p', { className: 'dp-muted' }, 'These cannot be automated here and are not verified by PhotoScout. The remote pilot must check them before flight.'),
        a.notChecked.map((gate) =>
          h('div', { key: gate.id, className: 'dp-card dp-card--not_checked' },
            h('div', { className: 'dp-card__head' }, badge('not_checked'), h('span', { className: 'dp-badge dp-badge--authority' }, gate.source?.name ?? 'No authoritative provider configured')),
            h('h4', null, gate.title),
            h('p', null, gate.explanation),
            h('p', { className: 'dp-action' }, h('strong', null, 'Pilot requirement: '), gate.userAction)))),

      a && a.pilotChecklist.length > 0 && h('section', null,
        h('h3', null, 'Pilot responsibility checklist'),
        h('p', { className: 'dp-muted' }, 'Requirements under CASR Part 101. Confirm each on site. Ticks are not saved.'),
        a.pilotChecklist.map((item) =>
          h('label', { key: item.id, className: 'dp-check' },
            h('input', { type: 'checkbox', checked: Boolean(checked[item.id]), onChange: () => setChecked((prev) => ({ ...prev, [item.id]: !prev[item.id] })) }),
            h('span', null,
              h('strong', null, item.title), item.ruleId && h('code', null, ` ${item.ruleId.toUpperCase()}`),
              h('span', { className: 'dp-block' }, item.explanation),
              h('span', { className: 'dp-block dp-muted' }, item.userAction))))),

      h('section', null,
        h('h3', null, 'Sources, authority and freshness'),
        h('ul', { className: 'dp-sources' },
          h('li', null, h('strong', null, 'Civil Aviation Safety Regulations 1998, Part 101'), ': statutory baseline.',
            context?.rules && ` Encoded rules last checked ${context.rules.checkedDate}, review by ${context.rules.reviewBy}.`),
          aerodromes?.source && h('li', null, h('strong', null, 'Local aerodrome dataset'), `: ${aerodromes.source.name} (${aerodromes.source.authority}, ${aerodromes.source.licence}), effective ${aerodromes.source.effectiveDate || 'n/a'}.`),
          context?.sources.openaip && h('li', null, h('strong', null, 'openAIP Core API'), `: airspace and airport context, fetched ${new Date(context.sources.openaip.fetchedAt).toLocaleString()}. ${context.sources.openaip.attribution}. Provider context only; it may be incomplete.`),
          context?.sources.rfs && h('li', null, h('strong', null, 'NSW Rural Fire Service'), `: major incidents feed (NSW only). ${context.sources.rfs.attribution}`),
          context?.sources.weather && h('li', null, h('strong', null, 'Open-Meteo'), `: current conditions. ${context.sources.weather.attribution}`),
          context?.sources.aircraft && h('li', null, h('strong', null, 'ADS-B feeds'), ': aircraft heard in the last minute and not on the ground. Coverage is incomplete.'),
          h('li', null, h('strong', null, 'OpenStreetMap'), ': the count of mapped buildings is a heuristic, not a populous-area determination.'))),

      h('p', { className: 'dp-disclaimer' }, DISCLAIMER));
  };
}
