/**
 * ComparisonModal.js — one table, every protocol, the same network and the same
 * failure.
 *
 * The engine does the running (`engine/compare.js`, which never touches the live
 * simulation); this file is the event picker, the caption and six columns.
 *
 * It is mounted only while it is open, so opening it is what runs the
 * comparison. That keeps the numbers from ever being stale with respect to a
 * topology that was edited since the last time it was looked at, and it costs
 * nothing: the whole run is a few milliseconds of synchronous work.
 */

import React, { useMemo, useState } from 'react';
import Modal from './Modal';
import { describeEvent, runComparison } from './engine/compare';

const NO_EVENT = 'none';

/** The five measured columns, in the order doc 07 §4 lists them. */
const COLUMNS = [
  { key: 'rounds', label: 'Rounds to converge' },
  { key: 'messages', label: 'Messages' },
  { key: 'entriesAdvertised', label: 'Entries advertised' },
  { key: 'peakWrongEntries', label: 'Peak wrong entries' },
  { key: 'loopsSeen', label: 'Loops seen' },
];

/** `'2|3'` ⇄ the event object the runner takes. */
const eventKeyFor = (link) => `${link.source}|${link.destination}`;

const breakLink = (link) => ({ type: 'removeLink', a: link.source, b: link.destination });

function eventFromKey(key) {
  if (!key || key === NO_EVENT) return null;
  const [a, b] = key.split('|');
  return { type: 'removeLink', a, b };
}

/**
 * What one measurement reads as.
 *
 * Two of the columns can be legitimately absent: a protocol that never settled
 * has no rounds-to-converge, and one whose rows are ports rather than
 * destinations (spanning tree) has nothing to score against shortest paths. A
 * zero in either place would be a claim, so both say "—" and explain on hover.
 */
function cellFor(row, column) {
  if (column.key === 'rounds' && !row.converged) {
    return {
      text: 'did not converge',
      title: `Still changing after ${row.roundsRun} rounds`,
      muted: true,
    };
  }
  const value = row[column.key];
  if (value === null || value === undefined) {
    return {
      text: '—',
      title: `${row.label} builds no routing tables to score`,
      muted: true,
    };
  }
  return { text: String(value) };
}

function ComparisonModal({ onClose, topology, links, topologyName }) {
  const [eventKey, setEventKey] = useState(NO_EVENT);

  // Keyed on the picker's string rather than the event object, which would be a
  // new identity every render and re-run the whole comparison each time.
  const result = useMemo(
    () => runComparison(topology, eventFromKey(eventKey)),
    [topology, eventKey]
  );

  const caption = [
    topologyName,
    `${result.routers} routers, ${result.links} links`,
    result.eventLabel,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Modal onClose={onClose} label="Protocol comparison" className="modal-content--comparison">
      <h2>Compare protocols</h2>

      <p>
        Every protocol run from cold on a copy of this topology. Pick an event
        and each one is measured again on the way back from it — same network,
        same failure, same yardstick.
      </p>

      <div className="form-group">
        <label htmlFor="comparison-event">Event</label>
        <select
          id="comparison-event"
          value={eventKey}
          onChange={(event) => setEventKey(event.target.value)}
        >
          <option value={NO_EVENT}>{describeEvent(null)}</option>
          {links.map((link) => (
            <option key={eventKeyFor(link)} value={eventKeyFor(link)}>
              {describeEvent(breakLink(link))}
            </option>
          ))}
        </select>
      </div>

      <div className="comparison-scroll">
        <table className="comparison-table">
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Protocol</th>
              {COLUMNS.map((column) => (
                <th scope="col" key={column.key}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr
                key={row.key}
                className={row.converged ? undefined : 'comparison-row--stalled'}
              >
                <th scope="row">
                  {row.label}
                  {row.note && <span className="comparison-note">{row.note}</span>}
                </th>
                {COLUMNS.map((column) => {
                  const cell = cellFor(row, column);
                  return (
                    <td
                      key={column.key}
                      className={cell.muted ? 'comparison-cell--muted' : undefined}
                      title={cell.title}
                    >
                      {cell.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="hint">
        Every row runs at that protocol's <strong>default</strong> settings, so
        the table is the same one twice running — the live simulation, and
        whatever you have set on it, is untouched. With an event chosen the
        numbers describe the recovery from it, not the cold start.{' '}
        <strong>Entries advertised</strong> counts payload rather than packets:
        link state sends fewer, far bigger messages, and only counting them
        would flatter it.
      </p>

      <button type="button" onClick={onClose}>
        Close
      </button>
    </Modal>
  );
}

export default ComparisonModal;
