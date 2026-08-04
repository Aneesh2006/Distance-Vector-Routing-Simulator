/**
 * ProtocolPanel.js — the generic renderers for everything a protocol plugin
 * declares as data.
 *
 * Nothing here knows which protocol is loaded. Option schemas, table columns,
 * legend entries and per-router knobs all arrive in the snapshot, so adding a
 * protocol means adding a plugin, not adding a branch to the right-hand panel.
 * That is the whole point of stage 2.
 */

import React from 'react';
import {
  COLORS,
  CORRECTNESS_STYLES,
  ROUTER_DECORATIONS,
  ROUTE_ACCENTS,
  withAlpha,
} from './config';
import { compareIds, formatCell } from './DvrAlgorithm';
import { CorrectnessLegend, correctnessRowStyle } from './Scoreboard';

/* ------------------------------------------------------------------ *
 * Decorations
 * ------------------------------------------------------------------ */

/**
 * How a router the active plugin has decorated should read in the Routers list.
 *
 * The same `ROUTER_DECORATIONS` map the 3D scene uses, so a database that is out
 * of step is the same colour in both views — and, as in the scene, selection
 * still wins: a decoration tints, it never takes away an affordance the user
 * can act on.
 */
export function routerDecoration(variant, isSelected) {
  const style = ROUTER_DECORATIONS[variant];
  if (!style) return { suffix: '' };
  return {
    suffix: style.suffix,
    title: style.label,
    style: isSelected
      ? undefined
      : {
          backgroundColor: withAlpha(COLORS[style.colorKey], style.tint),
          borderColor: withAlpha(COLORS[style.colorKey], Math.min(1, style.tint * 2.5)),
        },
  };
}

/**
 * How a route the active plugin has accented should read in the table.
 *
 * An inset edge rather than a second background wash, because correctness
 * already owns the background and the two have to be legible at once: a route
 * chosen by policy is very often also scored suboptimal, which is precisely
 * what makes it worth marking.
 */
export function routeAccentStyle(name) {
  const accent = ROUTE_ACCENTS[name];
  if (!accent) return undefined;
  return { boxShadow: `inset ${accent.width}px 0 0 ${COLORS[accent.colorKey]}` };
}

/**
 * Parse a form field, falling back instead of producing NaN.
 * An emptied input is a normal intermediate state while typing, so it yields
 * the fallback rather than Number('') === 0.
 */
export function toNumber(raw, fallback, { min, max } = {}) {
  const text = String(raw).trim();
  if (text === '') return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  const lower = min === undefined ? value : Math.max(min, value);
  return max === undefined ? lower : Math.min(max, lower);
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/**
 * One control per entry in `protocol.options`.
 *
 * `enabledWhen` names another boolean option that has to be on for this one to
 * mean anything — poisoned reverse without split horizon is not a setting, it
 * is a contradiction — so the control greys out rather than disappearing, which
 * would leave the user wondering where it went.
 */
export function ProtocolOptions({ schema, values, onChange }) {
  return schema.map((option) => {
    const disabled = Boolean(option.enabledWhen) && !values[option.enabledWhen];
    const id = `option-${option.key}`;

    if (option.type === 'boolean') {
      return (
        <label className="checkbox-row" key={option.key}>
          <input
            type="checkbox"
            checked={Boolean(values[option.key])}
            disabled={disabled}
            onChange={(event) => onChange({ [option.key]: event.target.checked })}
          />
          <span>{option.label}</span>
        </label>
      );
    }

    return (
      <div className="form-group" key={option.key}>
        <label htmlFor={id}>{option.label}</label>
        <input
          id={id}
          type="number"
          value={values[option.key]}
          min={option.min}
          max={option.max}
          step={option.step}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              [option.key]: toNumber(event.target.value, option.default, {
                min: option.min,
                max: option.max,
              }),
            })
          }
        />
      </div>
    );
  });
}

/* ------------------------------------------------------------------ *
 * Per-router knobs
 * ------------------------------------------------------------------ */

/**
 * `routerControls`, rendered in the inspector for the selected router.
 *
 * Scope `'router'` is one value (an STP bridge priority); scope `'neighbor'` is
 * one value per neighbour (a BGP LOCAL_PREF towards each peer), which is why
 * the neighbour list is passed in rather than derived from the control.
 */
export function RouterControls({ controls, routerId, neighbors, values, onChange }) {
  if (!controls || controls.length === 0) return null;

  const current = (control, neighborId) => {
    const stored = (values[routerId] || {})[control.key];
    const value = neighborId === undefined ? stored : stored && stored[neighborId];
    if (value !== undefined) return value;
    // `defaultFrom: 'routerId'` — a knob whose natural default is the router's
    // own identity, which no static value in the schema can express. A BGP AS
    // number is the case: one router per AS until somebody groups them.
    return control.defaultFrom === 'routerId' ? routerId : control.default;
  };

  const field = (control, neighborId) => {
    const id = `control-${routerId}-${control.key}-${neighborId || 'self'}`;
    const label = neighborId === undefined ? control.label : `${control.label} → ${neighborId}`;

    // A boolean knob is a checkbox, and a checkbox belongs beside its label
    // rather than stretched across a form row — the same `checkbox-row` every
    // other switch in the app uses, so they read alike and hit alike.
    if (control.type === 'boolean') {
      return (
        <label className="checkbox-row" key={id}>
          <input
            type="checkbox"
            checked={Boolean(current(control, neighborId))}
            onChange={(event) => onChange(control.key, event.target.checked, neighborId)}
          />
          <span>{label}</span>
        </label>
      );
    }

    return (
      <div className="form-group" key={id}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="number"
          value={current(control, neighborId)}
          min={control.min}
          max={control.max}
          step={control.step}
          onChange={(event) =>
            onChange(
              control.key,
              toNumber(event.target.value, control.default, {
                min: control.min,
                max: control.max,
              }),
              neighborId
            )
          }
        />
      </div>
    );
  };

  return (
    <div className="router-controls" role="group" aria-label={`Settings for router ${routerId}`}>
      {controls.map((control) =>
        control.scope === 'neighbor'
          ? neighbors.map((neighborId) => field(control, neighborId))
          : field(control)
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Routing table
 * ------------------------------------------------------------------ */

/**
 * The routing table, with headers and cells driven by `protocol.columns`.
 *
 * `hasRoutingTables` is false for protocols whose rows are not destinations —
 * spanning tree lists ports — and turns off both things that only make sense
 * for a route: the correctness classes, and reading a null next hop as
 * unreachable (the root bridge has no way *toward* the root, and there is
 * nothing wrong with that).
 */
export function RoutingTable({
  table,
  columns,
  correctness,
  infinityCost,
  hasRoutingTables,
  rowLabel,
}) {
  const destinations = Object.keys(table).sort(compareIds);
  // One grid column per protocol column, plus the row's own key.
  const template = { gridTemplateColumns: `repeat(${columns.length + 1}, 1fr)` };

  return (
    <>
      {/*
        A CSS grid rather than a `<table>`, because the columns have to line up
        across a sticky header inside a scrolling box — but the ARIA roles say
        table, so a screen reader still announces "row 3, Next Hop, 2" instead of
        reading four numbers in a row and leaving the user to guess which column
        each belonged to.
      */}
      <div className="routing-table" role="table" aria-label="Routing table">
        <div className="routing-entry routing-entry--head" style={template} role="row">
          {/* A soft hyphen: from four columns on (path vector's AS path, DUAL's
              five) the heading is wider than its share of a 320px panel, and
              this is what makes it wrap as DESTINA-TION rather than as a typo. */}
          <span role="columnheader">{rowLabel || 'Destina­tion'}</span>
          {/* Keyed by position: a plugin's column list is static, and two
              columns may legitimately read the same field (cost and FD). */}
          {columns.map((column, index) => (
            <span role="columnheader" key={index}>
              {column.label}
            </span>
          ))}
        </div>
        {destinations.map((destination) => {
          const route = table[destination];
          const unreachable =
            hasRoutingTables && (route.nextHop === null || route.nextHop === undefined);
          const className = hasRoutingTables ? correctness[destination] : undefined;
          // Both explanations at once where there are two: "this route is not
          // the shortest one" and "…because someone chose it on purpose".
          const title = [CORRECTNESS_STYLES[className]?.label, ROUTE_ACCENTS[route.accent]?.label]
            .filter(Boolean)
            .join(' · ');
          return (
            <div
              key={destination}
              className={`routing-entry ${unreachable ? 'routing-entry--unreachable' : ''}`}
              style={{
                ...template,
                ...correctnessRowStyle(className),
                ...routeAccentStyle(route.accent),
              }}
              role="row"
              // The tint and the accent bar are the only thing saying this row is
              // wrong, and colour alone is not a message. The same sentence the
              // tooltip carries goes on the row itself.
              title={title || undefined}
              aria-label={title ? `${destination}: ${title}` : undefined}
            >
              <span role="rowheader">{destination}</span>
              {columns.map((column, index) => (
                <span role="cell" key={index}>
                  {formatCell(column.format, route[column.key], infinityCost, route)}
                </span>
              ))}
            </div>
          );
        })}
      </div>
      {hasRoutingTables && <CorrectnessLegend classes={Object.values(correctness)} />}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Inspector blocks
 * ------------------------------------------------------------------ */

/**
 * Renders whatever `protocol.inspect()` returned.
 *
 * The plugin returns plain data — rows, small tables, progress bars, notes —
 * and this decides what it looks like, so the engine stays free of React and a
 * new tab (LSDB in stage 3, timers in stage 8) costs no UI code at all.
 */
export function InspectorBlocks({ blocks, infinityCost }) {
  return (blocks || []).map((block, index) => {
    const key = `${block.type}-${index}`;

    if (block.type === 'rows') {
      return (
        <div className="stats-panel" key={key}>
          {block.rows.map((row) => (
            <div className="stat-row" key={row.label}>
              <span className="stat-row__label">{row.label}</span>
              <span className="stat-row__value">{row.value}</span>
            </div>
          ))}
        </div>
      );
    }

    if (block.type === 'table') {
      const template = { gridTemplateColumns: `repeat(${block.columns.length}, 1fr)` };
      return (
        <div className="routing-table" role="table" key={key}>
          <div className="routing-entry routing-entry--head" style={template} role="row">
            {block.columns.map((column, columnIndex) => (
              <span role="columnheader" key={columnIndex}>
                {column.label}
              </span>
            ))}
          </div>
          {block.rows.map((row, rowIndex) => (
            <div
              className="routing-entry"
              style={template}
              role="row"
              key={row.key || rowIndex}
            >
              {block.columns.map((column, columnIndex) => (
                <span role="cell" key={columnIndex}>
                  {formatCell(column.format, row[column.key], infinityCost, row)}
                </span>
              ))}
            </div>
          ))}
        </div>
      );
    }

    if (block.type === 'bars') {
      return (
        <div className="bar-list" key={key}>
          {block.bars.map((bar) => (
            <div className="bar-row" key={bar.label}>
              <span className="bar-row__label">{bar.label}</span>
              {/* A real progressbar rather than two nested spans: the bar is the
                  whole reason the timer modes exist, and "15.3s to forwarding"
                  has to be readable without seeing how full it is. */}
              <span
                className="bar-row__track"
                role="progressbar"
                aria-label={bar.label}
                aria-valuemin={0}
                aria-valuemax={bar.max}
                aria-valuenow={Math.max(0, Math.min(bar.max, bar.value))}
                aria-valuetext={bar.caption}
              >
                <span
                  className="bar-row__fill"
                  style={{
                    width: `${Math.max(0, Math.min(100, (bar.value / bar.max) * 100))}%`,
                  }}
                />
              </span>
              <span className="bar-row__caption">{bar.caption}</span>
            </div>
          ))}
        </div>
      );
    }

    return (
      <p className="hint" key={key}>
        {block.text}
      </p>
    );
  });
}

/* ------------------------------------------------------------------ *
 * Legend
 * ------------------------------------------------------------------ */

/**
 * Scene legend: the entries that are true for every protocol, then whatever
 * the active one adds.
 */
const SHARED_LEGEND = [
  { colorKey: 'routerIdle', label: 'Router' },
  { colorKey: 'link', label: 'Link' },
  { colorKey: 'linkHighlighted', label: 'Shortest path' },
];

export function SceneLegend({ entries }) {
  return (
    <div className="legend" role="region" aria-label="What the colours in the scene mean">
      {[...SHARED_LEGEND, ...(entries || [])].map((entry) => (
        <span key={entry.label}>
          {/* The swatch is decoration: the label beside it already says what the
              colour means, so announcing it twice would be noise. */}
          <i
            className="swatch"
            aria-hidden="true"
            style={{ backgroundColor: COLORS[entry.colorKey] }}
          />
          {entry.label}
        </span>
      ))}
    </div>
  );
}
