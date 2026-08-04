/**
 * Scoreboard.js — the correctness overlay and work counters, as pure views.
 *
 * Everything here reads `snapshot.correctness` and `snapshot.stats` and renders
 * them. No engine calls, no state: the engine already did the scoring, and
 * keeping these components dumb is what lets the same numbers appear in the
 * meter, the table tints, the router chips and the stats panel without four
 * slightly different opinions about what "correct" means.
 */

import React from 'react';
import { COLORS, CORRECTNESS_STYLES, SIM, withAlpha } from './config';

/**
 * Inline row styling for a classified table entry.
 * Returns `undefined` for `optimal` so a correct table stays visually calm.
 */
export function correctnessRowStyle(name) {
  const style = CORRECTNESS_STYLES[name];
  if (!style || !style.colorKey || !style.tint) return undefined;
  return {
    backgroundColor: withAlpha(COLORS[style.colorKey], style.tint),
    fontWeight: style.bold ? 700 : undefined,
  };
}

/**
 * Correctness per round since the last edit.
 *
 * The y-axis is pinned to 0–100 rather than auto-scaled: the whole point is to
 * show how far the network fell, and rescaling to fit would turn a two-point
 * wobble and a fifty-point collapse into the same picture.
 */
export function Sparkline({ values }) {
  const { width, height, strokeWidth } = SIM.metrics.sparkline;
  if (!values || values.length < 2) return null;

  const step = width / (values.length - 1);
  const usable = height - strokeWidth;
  const y = (value) => strokeWidth / 2 + usable * (1 - value / 100);
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${y(value).toFixed(1)}`)
    .join(' ');

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Correctness over the last ${values.length} rounds, now ${
        values[values.length - 1]
      } per cent`}
    >
      {/* Where a fully correct network would sit, so the dip has a reference. */}
      <line
        x1="0"
        x2={width}
        y1={y(100)}
        y2={y(100)}
        stroke={COLORS.borderColor}
        strokeWidth="1"
        strokeDasharray="2 3"
      />
      <polyline
        points={points}
        fill="none"
        stroke={COLORS.primary}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * "Tables correct: 18 / 25 (72%)".
 *
 * This is the number the CONVERGED badge cannot give you: a network can settle
 * on a wrong answer and the badge would still claim success.
 */
export function CorrectnessMeter({ correctness }) {
  if (!correctness || correctness.totals.entries === 0) return null;
  const { correct, entries, percent } = correctness.totals;
  const tone = correct === entries ? 'success' : 'warning';

  return (
    <span
      className={`correctness-meter correctness-meter--${tone}`}
      title="Routing table entries that match the true shortest path"
    >
      Tables correct: {correct} / {entries} ({percent}%)
    </span>
  );
}

/** `4/5` beside a router in the list, green only when it is fully optimal. */
export function RouterScore({ score }) {
  if (!score) {
    return (
      <span className="score-chip score-chip--absent" title="Router is down — not scored">
        —
      </span>
    );
  }
  const perfect = score.correct === score.total;
  return (
    <span
      className={`score-chip ${perfect ? 'score-chip--ok' : 'score-chip--bad'}`}
      title={`${score.correct} of ${score.total} entries match the true shortest path`}
    >
      {score.correct}/{score.total}
    </span>
  );
}

/**
 * One line naming every wrong class currently on screen.
 *
 * Only the classes actually present are listed: the legend appears exactly when
 * a colour does, which is the moment it is worth reading.
 */
export function CorrectnessLegend({ classes }) {
  const present = Object.keys(CORRECTNESS_STYLES).filter(
    (name) => name !== 'optimal' && classes.includes(name)
  );
  if (present.length === 0) {
    return <p className="hint">Every entry matches the true shortest path.</p>;
  }

  return (
    <p className="hint correctness-legend">
      {present.map((name) => (
        <span key={name}>
          <i
            className="swatch"
            aria-hidden="true"
            style={{ backgroundColor: COLORS[CORRECTNESS_STYLES[name].colorKey] }}
          />
          {CORRECTNESS_STYLES[name].label}
        </span>
      ))}
    </p>
  );
}

/**
 * Simulated time as a wall clock: `00:04:32`.
 *
 * Seconds alone stop being readable at about the point RIP gets interesting —
 * "t = 312" and "t = 00:05:12" are the same number, and only one of them makes
 * "three minutes" obvious.
 */
export function formatClock(time) {
  const total = Math.max(0, Math.floor(time));
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(
    total % 60
  )}`;
}

const secondsLabel = (value) => `${Math.round(value)}s`;

/**
 * `t = 00:04:32`, with the round counter demoted beside it.
 *
 * Rounds do not disappear in timer mode — the counter is still the honest
 * answer to "how many times has the round loop run?", which is zero — so it
 * stays visible and small rather than being swapped out and leaving the user
 * wondering which clock they are looking at.
 */
export function ClockReadout({ time }) {
  return (
    <span className="clock-readout" title="Simulated time since the protocol started">
      t = {formatClock(time)}
    </span>
  );
}

/**
 * The last few things that happened, newest first.
 *
 * The engine already timestamps every line from the same clock that scheduled
 * it, so this is a pure view — and it is what turns "the route timed out" from
 * a claim into something the user watched happen.
 */
export function EventLog({ entries, limit }) {
  if (!entries || entries.length === 0) {
    return <p className="empty-note">Nothing has happened yet.</p>;
  }

  return (
    <ol className="event-log">
      {entries.slice(0, limit).map((entry, index) => (
        <li key={`${entry.at}-${index}`}>
          <span className="event-log__time">t={entry.at.toFixed(1)}</span>
          <span className="event-log__text">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Work counters: what this protocol cost to run, and how the episode is going.
 *
 * `metrics` is whatever the active plugin volunteered — LSDB sync, routers in
 * ACTIVE, blocked links. Rendered as ordinary rows above the shared counters so
 * a protocol can explain itself without its own panel.
 *
 * In timer mode the episode is measured in simulated seconds rather than
 * rounds, and gains "quiet for": convergence there is defined as a stretch of
 * silence, and a definition the user cannot watch tick over is indistinguishable
 * from magic.
 */
export function StatsPanel({ stats, correctness, metrics, mode = 'rounds', time = 0 }) {
  const timed = mode === 'timers';
  const kinds = Object.entries(stats.messagesByKind);
  const rows = [
    ...(metrics || []).map((metric) => [metric.label, metric.value]),
    timed ? ['Simulated time', formatClock(time)] : ['Rounds', stats.rounds],
    ['Messages', stats.messages],
    ['Entries advertised', stats.entriesAdvertised],
    ...(timed
      ? [
          ['Since last change', secondsLabel(stats.secondsSinceTopologyChange)],
          [
            'Seconds to converge',
            stats.secondsToConverge === null ? '—' : secondsLabel(stats.secondsToConverge),
          ],
          ['Quiet for', secondsLabel(stats.quietFor)],
        ]
      : [
          ['Rounds since last change', stats.roundsSinceTopologyChange],
          [
            'Rounds to converge',
            stats.roundsToConverge === null ? '—' : stats.roundsToConverge,
          ],
        ]),
    ['Peak wrong entries', stats.peakWrongEntries],
    ['Loops seen', stats.loopsSeen],
  ];

  return (
    <div className="stats-panel">
      {rows.map(([label, value]) => (
        <div className="stat-row" key={label}>
          <span className="stat-row__label">{label}</span>
          <span className="stat-row__value">{value}</span>
        </div>
      ))}

      {kinds.length > 0 && (
        <div className="stat-row stat-row--kinds">
          <span className="stat-row__label">By kind</span>
          <span className="stat-row__value">
            {kinds.map(([kind, count]) => `${kind} ${count}`).join(', ')}
          </span>
        </div>
      )}

      <p className="hint">
        Entries advertised counts payload, not packets — it is what keeps a
        comparison between protocols honest.
      </p>

      {timed && (
        <p className="hint">
          Converged here means quiet: no table has changed and nothing but the
          periodic timers is outstanding, for a whole update interval. The
          thirty-second drumbeat never stops, so it cannot be what counts.
        </p>
      )}

      {correctness && correctness.totals.entries > 0 && (
        <p className="hint">
          Converged means no table changed last round. Correct means the tables
          agree with the topology. They are not the same question.
        </p>
      )}
    </div>
  );
}
