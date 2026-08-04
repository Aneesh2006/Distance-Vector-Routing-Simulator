/**
 * compare.js — every protocol, one network, one failure.
 *
 * The app's strongest single artefact: a table that runs all five protocols
 * over the same topology and the same broken link, and reports what each one
 * cost. Nothing here is new protocol logic — it is the stage 1 counters plus a
 * loop over the registry, which is exactly why it is worth having.
 *
 * Three rules make the numbers mean something:
 *
 *   1. **Every row starts from the same network.** Each run gets its own
 *      `Topology.clone()`, because running a protocol is not read-only: a plugin
 *      declares its own infinity ceiling and pushing that down re-clamps link
 *      costs. Sharing one copy would let the first protocol decide what the rest
 *      see.
 *   2. **Every row runs at the protocol's defaults**, not at whatever the user
 *      has set live. Otherwise the table stops being reproducible — and the
 *      no-split-horizon row would silently become a duplicate the moment the
 *      user turned split horizon off.
 *   3. **The live simulation is never touched.** Only reads on the topology it
 *      is handed; everything else happens on copies.
 *
 * What a row measures depends on whether there is a scripted event. With one it
 * is the *recovery*: converge from cold, break the link, then count the rounds,
 * messages and wrongness of getting back. Without one it is the cold start
 * itself. Either way the six columns describe one convergence, so they can be
 * read across.
 */

import { SIM } from '../config';
import { PROTOCOLS } from './protocols';
import { Simulation } from './Simulation';

/**
 * Extra rows that re-run a protocol under settings other than its defaults.
 *
 * One entry so far, and it is the reason the table exists: distance vector with
 * split horizon off is the row that counts to infinity, and putting it beside
 * the same protocol with the loop guard on says more than any amount of prose.
 * Running one protocol under two option sets belongs in the comparison (doc
 * 07 §4), so this is data rather than a special case in the runner.
 */
export const COMPARISON_VARIANTS = [
  { protocolId: 'dvr', note: 'no split horizon', options: { splitHorizon: false } },
];

/**
 * The rows to run, in display order: every registered protocol, each followed
 * immediately by its own variants so the pair can be read as a pair.
 *
 * Read from `PROTOCOLS` rather than listed here, so a protocol added in a later
 * stage appears in the comparison without anyone remembering to come back.
 */
export function comparisonRows() {
  return PROTOCOLS.flatMap((protocol) => [
    { key: protocol.id, protocolId: protocol.id, label: protocol.name, note: null },
    ...COMPARISON_VARIANTS.filter((variant) => variant.protocolId === protocol.id).map(
      (variant) => ({
        key: `${protocol.id}:${variant.note}`,
        protocolId: protocol.id,
        label: protocol.name,
        note: variant.note,
        options: variant.options,
      })
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * The scripted event
 * ------------------------------------------------------------------ */

/**
 * Reject an event the topology cannot actually perform, once, up front.
 *
 * Every row runs the same script, so one check covers all of them — and it
 * matters: an event that applies to nothing would leave the recovery phase
 * reporting the *cold start's* episode counters, which is worse than reporting
 * no event at all.
 */
export function normalizeEvent(topology, event) {
  if (!event) return null;
  if (event.type === 'removeLink' && topology.hasLink(event.a, event.b)) {
    return { type: 'removeLink', a: String(event.a), b: String(event.b) };
  }
  return null;
}

/** One case per scripted event; the picker offers link breaks so far. */
function applyEvent(simulation, event) {
  switch (event.type) {
    case 'removeLink':
      simulation.removeLink(event.a, event.b);
      break;
    default:
      break;
  }
}

/**
 * How an event reads to a human.
 *
 * Lives here rather than in the modal so the picker, the caption and any future
 * export all spell the same event the same way.
 */
export function describeEvent(event) {
  if (!event) return 'No event — cold start only';
  if (event.type === 'removeLink') return `Break link ${event.a} ↔ ${event.b}`;
  return 'Unknown event';
}

/* ------------------------------------------------------------------ *
 * Measuring one row
 * ------------------------------------------------------------------ */

/**
 * Turn a finished convergence run into the six columns of the table.
 *
 * `messagesBefore` / `entriesBefore` subtract the cold start when there is an
 * event, because the cumulative counters run from the simulation's creation and
 * the question being asked is what the *recovery* cost.
 */
function report(simulation, run, messagesBefore, entriesBefore) {
  const { stats } = simulation;
  // Spanning tree's rows are ports, not destinations, so there is nothing to
  // score against shortest paths and the two correctness columns read "—".
  const scored = simulation.hasRoutingTables;

  return {
    converged: run.converged,
    // The engine's own number, so the table and the Stats panel can never
    // disagree; it counts the confirming round in which nothing changed.
    rounds: run.converged ? stats.roundsToConverge : null,
    roundsRun: run.rounds,
    messages: stats.messages - messagesBefore,
    entriesAdvertised: stats.entriesAdvertised - entriesBefore,
    peakWrongEntries: scored ? stats.peakWrongEntries : null,
    loopsSeen: scored ? stats.loopsSeen : null,
  };
}

function measureRow({ options, ...row }, topology, event, maxRounds) {
  const simulation = new Simulation(topology.clone(), row.protocolId, options);
  const cold = simulation.runToConvergence(maxRounds);

  // A protocol that never settled has no recovery worth measuring, and running
  // the event phase anyway would only spend another `maxRounds` saying so.
  if (!event || !cold.converged) return { ...row, ...report(simulation, cold, 0, 0) };

  const messagesBefore = simulation.stats.messages;
  const entriesBefore = simulation.stats.entriesAdvertised;
  applyEvent(simulation, event);
  const recovery = simulation.runToConvergence(maxRounds);

  return { ...row, ...report(simulation, recovery, messagesBefore, entriesBefore) };
}

/* ------------------------------------------------------------------ *
 * The runner
 * ------------------------------------------------------------------ */

/**
 * Run every protocol over a copy of `topology` and report what each one cost.
 *
 * @param {Topology} topology   read only — never mutated, never advanced
 * @param {Object} [event]      `{ type: 'removeLink', a, b }`, or null
 * @param {Object} [limits]     `{ maxRounds }`; the safety cap that turns a
 *                              protocol that never settles into a reported
 *                              "did not converge" rather than a hung browser
 */
export function runComparison(
  topology,
  event = null,
  { maxRounds = SIM.maxConvergenceRounds } = {}
) {
  const scriptedEvent = normalizeEvent(topology, event);

  return {
    rows: comparisonRows().map((row) => measureRow(row, topology, scriptedEvent, maxRounds)),
    event: scriptedEvent,
    eventLabel: describeEvent(scriptedEvent),
    // The caption's raw material: enough for a screenshot of the table to say
    // what it was a table of.
    routers: topology.routerIds.length,
    links: topology.getLinks().length,
    maxRounds,
  };
}
