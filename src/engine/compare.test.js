/**
 * compare.test.js — the protocol comparison runner.
 *
 * The runner has no protocol logic of its own, so what is worth testing is the
 * three promises the table's numbers rest on: that it never touches the live
 * simulation, that each row measures the convergence it claims to, and that a
 * protocol which never settles is *reported* rather than hung on.
 *
 * `Topology.clone()` is tested here too. It exists only for this runner, and
 * "every row starts from the same network" is the property it is holding up.
 */

import { Simulation } from './Simulation';
import { Topology } from './Topology';
import { PROTOCOLS } from './protocols';
import {
  COMPARISON_VARIANTS,
  comparisonRows,
  describeEvent,
  normalizeEvent,
  runComparison,
} from './compare';

const SAMPLE_TOPOLOGY = {
  N1: [{ neighbor: 'N2', cost: 1 }],
  N2: [
    { neighbor: 'N1', cost: 1 },
    { neighbor: 'N3', cost: 6 },
    { neighbor: 'N5', cost: 3 },
  ],
  N3: [
    { neighbor: 'N2', cost: 6 },
    { neighbor: 'N4', cost: 2 },
  ],
  N4: [
    { neighbor: 'N3', cost: 2 },
    { neighbor: 'N5', cost: 4 },
  ],
  N5: [
    { neighbor: 'N2', cost: 3 },
    { neighbor: 'N4', cost: 4 },
  ],
};

/** Three in a line: the topology the count-to-infinity demo is built on. */
const CHAIN = {
  1: [{ neighbor: '2', cost: 1 }],
  2: [
    { neighbor: '1', cost: 1 },
    { neighbor: '3', cost: 1 },
  ],
  3: [{ neighbor: '2', cost: 1 }],
};

const BREAK_MIDDLE = { type: 'removeLink', a: '2', b: '3' };

/** Registers a throwaway plugin for one test and takes it out again. */
function withProtocol(protocol, run) {
  PROTOCOLS.push(protocol);
  try {
    return run();
  } finally {
    PROTOCOLS.splice(PROTOCOLS.indexOf(protocol), 1);
  }
}

/** The floor of the plugin interface, borrowed from `Simulation.test.js`. */
const inertProtocol = {
  id: 'inert',
  name: 'Inert',
  summary: 'Learns nothing, sends nothing.',
  messageLabel: 'NOP',
  options: [{ key: 'infinityCost', label: 'Infinity', type: 'number', default: 16 }],
  columns: [{ key: 'cost', label: 'Cost', format: 'cost' }],
  createState: () => ({}),
  round: () => ({ messages: [], changed: false }),
  tables: (state, topology) =>
    Object.fromEntries(topology.routerIds.map((id) => [id, { [id]: { nextHop: id, cost: 0 } }])),
};

const rowFor = (result, protocolId, note = null) =>
  result.rows.find((row) => row.protocolId === protocolId && row.note === note);

describe('Topology.clone', () => {
  test('copies the wiring, the costs and which routers are down', () => {
    const topology = new Topology(SAMPLE_TOPOLOGY);
    topology.setRouterActive('N4', false);

    const copy = topology.clone();

    expect(copy.routerIds).toEqual(topology.routerIds);
    expect(copy.getLinks()).toEqual(topology.getLinks());
    expect(copy.isActive('N4')).toBe(false);
    expect(copy.infinityCost).toBe(topology.infinityCost);
  });

  test('is detached — editing either one leaves the other alone', () => {
    const topology = new Topology(SAMPLE_TOPOLOGY);
    const links = topology.getLinks();
    const copy = topology.clone();

    copy.removeLink('N2', 'N3');
    copy.setLinkCost('N1', 'N2', 9);
    copy.addRouter('N9');
    copy.setRouterActive('N5', false);

    expect(topology.getLinks()).toEqual(links);
    expect(topology.has('N9')).toBe(false);
    expect(topology.isActive('N5')).toBe(true);

    topology.removeLink('N4', 'N5');
    expect(copy.hasLink('N4', 'N5')).toBe(true);
  });

  test('gives the copy its own ground truth', () => {
    const topology = new Topology(SAMPLE_TOPOLOGY);
    const copy = topology.clone();
    copy.removeLink('N2', 'N3');

    // N1 reaches N3 for 7 straight through N2 here; there, only the long way
    // round the ring — N1-N2-N5-N4-N3, for 10.
    expect(topology.groundTruth.dist.get('N1|N3')).toBe(7);
    expect(copy.groundTruth.dist.get('N1|N3')).toBe(10);
  });
});

describe('the rows', () => {
  test('are every registered protocol, each followed by its own variants', () => {
    const rows = comparisonRows();

    expect(rows.map((row) => row.protocolId)).toEqual([
      'dvr',
      'dvr',
      'ls',
      'pv',
      'stp',
      'dual',
    ]);
    expect(rows[0].note).toBeNull();
    expect(rows[1].note).toBe(COMPARISON_VARIANTS[0].note);
    expect(rows[1].options).toEqual({ splitHorizon: false });
    // Keys are what React lists on, so two rows for one protocol must differ.
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  test('pick up a protocol registered later without being told', () => {
    withProtocol({ ...inertProtocol, id: 'newcomer' }, () => {
      expect(comparisonRows().map((row) => row.protocolId)).toContain('newcomer');
    });
  });
});

describe('the scripted event', () => {
  test('is rejected when the topology cannot perform it', () => {
    const topology = new Topology(SAMPLE_TOPOLOGY);

    expect(normalizeEvent(topology, BREAK_MIDDLE)).toBeNull(); // no such link here
    expect(normalizeEvent(topology, { type: 'removeLink', a: 'N2', b: 'N3' })).toEqual({
      type: 'removeLink',
      a: 'N2',
      b: 'N3',
    });
    expect(normalizeEvent(topology, null)).toBeNull();
  });

  test('reads the same way in the picker and the caption', () => {
    expect(describeEvent({ type: 'removeLink', a: '2', b: '3' })).toBe('Break link 2 ↔ 3');
    expect(describeEvent(null)).toMatch(/no event/i);
  });

  test('an event that cannot be applied is reported as no event at all', () => {
    const topology = new Topology(SAMPLE_TOPOLOGY);
    const result = runComparison(topology, { type: 'removeLink', a: 'N1', b: 'N4' });

    expect(result.event).toBeNull();
    expect(result.rows.every((row) => row.converged)).toBe(true);
  });
});

describe('the runner', () => {
  test('never touches the live simulation', () => {
    const simulation = new Simulation(CHAIN, 'dvr');
    simulation.runToConvergence();
    const before = simulation.getSnapshot();

    runComparison(simulation.topology, BREAK_MIDDLE);

    expect(simulation.getSnapshot()).toEqual(before);
    expect(simulation.hasLink('2', '3')).toBe(true);
    expect(simulation.protocol.id).toBe('dvr');
  });

  test('gives the same answer every time it is run', () => {
    const topology = new Topology(SAMPLE_TOPOLOGY);
    expect(runComparison(topology, { type: 'removeLink', a: 'N2', b: 'N3' })).toEqual(
      runComparison(topology, { type: 'removeLink', a: 'N2', b: 'N3' })
    );
  });

  test('describes the topology it ran on', () => {
    const result = runComparison(new Topology(SAMPLE_TOPOLOGY), {
      type: 'removeLink',
      a: 'N2',
      b: 'N3',
    });

    expect(result.routers).toBe(5);
    expect(result.links).toBe(5);
    expect(result.eventLabel).toBe('Break link N2 ↔ N3');
  });

  test('with an event, a row measures the recovery and not the cold start', () => {
    const row = rowFor(runComparison(new Topology(CHAIN), BREAK_MIDDLE), 'dvr');

    // The same run, by hand: converge, break the link, converge again.
    const control = new Simulation(CHAIN, 'dvr');
    control.runToConvergence();
    const messagesBefore = control.stats.messages;
    const entriesBefore = control.stats.entriesAdvertised;
    control.removeLink('2', '3');
    control.runToConvergence();

    expect(row.rounds).toBe(control.stats.roundsToConverge);
    expect(row.messages).toBe(control.stats.messages - messagesBefore);
    expect(row.entriesAdvertised).toBe(control.stats.entriesAdvertised - entriesBefore);
    expect(row.peakWrongEntries).toBe(control.stats.peakWrongEntries);
  });

  test('without an event, a row measures the cold start', () => {
    const row = rowFor(runComparison(new Topology(CHAIN)), 'dvr');

    const control = new Simulation(CHAIN, 'dvr');
    control.runToConvergence();

    expect(row.rounds).toBe(control.stats.roundsToConverge);
    expect(row.messages).toBe(control.stats.messages);
    expect(row.entriesAdvertised).toBe(control.stats.entriesAdvertised);
  });

  /**
   * The row the table exists for. Split horizon off is the only setting here
   * that can start a count to infinity, and the break that starts it is the one
   * from the "Three in a line" preset.
   */
  test('distance vector without split horizon takes strictly longer to recover', () => {
    const result = runComparison(new Topology(CHAIN), BREAK_MIDDLE);
    const guarded = rowFor(result, 'dvr');
    const counting = rowFor(result, 'dvr', COMPARISON_VARIANTS[0].note);

    expect(counting.rounds).toBeGreaterThan(guarded.rounds);
    expect(counting.messages).toBeGreaterThan(guarded.messages);
    // …and it is the only row that loops on the way there.
    expect(counting.loopsSeen).toBeGreaterThan(0);
    expect(guarded.loopsSeen).toBe(0);
  });

  test('link state recovers from the same break without counting', () => {
    const result = runComparison(new Topology(CHAIN), BREAK_MIDDLE);

    expect(rowFor(result, 'ls').rounds).toBeLessThan(
      rowFor(result, 'dvr', COMPARISON_VARIANTS[0].note).rounds
    );
    expect(rowFor(result, 'ls').loopsSeen).toBe(0);
  });

  test('a protocol with no routing tables scores "—" rather than zero', () => {
    const row = rowFor(runComparison(new Topology(SAMPLE_TOPOLOGY)), 'stp');

    expect(row.peakWrongEntries).toBeNull();
    expect(row.loopsSeen).toBeNull();
    // It still converged, and still sent messages worth counting.
    expect(row.converged).toBe(true);
    expect(row.messages).toBeGreaterThan(0);
  });
});

describe('a protocol that never settles', () => {
  const restless = {
    ...inertProtocol,
    id: 'restless',
    name: 'Restless',
    round: () => ({ messages: [], changed: true }),
  };

  test('is reported as "did not converge", not waited on for ever', () => {
    withProtocol(restless, () => {
      const result = runComparison(new Topology(SAMPLE_TOPOLOGY), null, { maxRounds: 20 });
      const row = rowFor(result, 'restless');

      expect(row.converged).toBe(false);
      expect(row.rounds).toBeNull();
      expect(row.roundsRun).toBe(20);
      expect(result.maxRounds).toBe(20);
    });
  });

  test('does not spoil the rows around it', () => {
    withProtocol(restless, () => {
      const result = runComparison(new Topology(CHAIN), BREAK_MIDDLE, { maxRounds: 30 });

      expect(rowFor(result, 'dvr').converged).toBe(true);
      expect(rowFor(result, 'ls').converged).toBe(true);
      expect(rowFor(result, 'restless').converged).toBe(false);
    });
  });
});
