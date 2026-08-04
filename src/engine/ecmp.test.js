/**
 * ecmp.test.js — equal-cost multipath, doc 07 §5.
 *
 * The claims worth guarding are the same for all three protocols that offer the
 * option, so the interesting tests run against each of them rather than being
 * written once for distance vector and hoped for elsewhere:
 *
 *   - off, the tables are byte-identical to what they have always been;
 *   - on, a genuine tie installs every hop and changes no cost;
 *   - on, the network still converges — the failure mode ECMP invites is a
 *     table that flaps between two equally good answers forever.
 */

import { Simulation } from './Simulation';
import { Topology } from './Topology';
import { multipathRoute, nextHopsOf, tablesEqual, formatCell } from './helpers';
import { SIM } from '../config';

/** A–B–D and A–C–D, every link cost 3: both ways to D cost 6. */
const DIAMOND = {
  A: [
    { neighbor: 'B', cost: 3 },
    { neighbor: 'C', cost: 3 },
  ],
  B: [{ neighbor: 'D', cost: 3 }],
  C: [{ neighbor: 'D', cost: 3 }],
  D: [],
};

/** Three equal ways from A to D, to prove the set is not capped at two. */
const TRIDENT = {
  A: [
    { neighbor: 'B', cost: 1 },
    { neighbor: 'C', cost: 1 },
    { neighbor: 'E', cost: 1 },
  ],
  B: [{ neighbor: 'D', cost: 1 }],
  C: [{ neighbor: 'D', cost: 1 }],
  E: [{ neighbor: 'D', cost: 1 }],
  D: [],
};

/** Every protocol that declares the shared switch. */
const ECMP_PROTOCOLS = ['dvr', 'ls', 'pv'];

function converged(adjacency, protocolId, options) {
  const simulation = new Simulation(new Topology(adjacency), protocolId, options);
  simulation.runToConvergence();
  return simulation;
}

/* ------------------------------------------------------------------ *
 * The route shape
 * ------------------------------------------------------------------ */

describe('the multipath route shape', () => {
  test('a single hop is exactly the shape a route has always been', () => {
    // No `nextHops` key at all: doc 07 §5's getter would have put one on every
    // entry of every protocol, and the point of the field is that it is unusual.
    expect(multipathRoute('2', 4, ['2'])).toEqual({ nextHop: '2', cost: 4 });
    expect(multipathRoute('2', 4, null)).toEqual({ nextHop: '2', cost: 4 });
  });

  test('several hops sort with compareIds, and the primary is the lowest', () => {
    const route = multipathRoute('9', 4, ['10', '9', '2']);
    expect(route.nextHops).toEqual(['2', '9', '10']);
    expect(route.nextHop).toBe('2');
  });

  test('extra columns survive', () => {
    const route = multipathRoute('2', 4, ['2', '5'], { path: ['2', 'D'], accent: 'policy' });
    expect(route).toMatchObject({ path: ['2', 'D'], accent: 'policy', nextHops: ['2', '5'] });
  });

  test('nextHopsOf normalises both shapes, and unreachable is no hops at all', () => {
    expect(nextHopsOf({ nextHop: '2', cost: 4 })).toEqual(['2']);
    expect(nextHopsOf({ nextHop: '2', nextHops: ['2', '5'], cost: 4 })).toEqual(['2', '5']);
    expect(nextHopsOf({ nextHop: null, cost: 16 })).toEqual([]);
    expect(nextHopsOf(undefined)).toEqual([]);
  });

  test('tablesEqual sees a change of hop set even when hop and cost hold still', () => {
    const one = { D: { nextHop: '2', cost: 6 } };
    const two = { D: { nextHop: '2', nextHops: ['2', '3'], cost: 6 } };
    expect(tablesEqual(one, one)).toBe(true);
    expect(tablesEqual(one, two)).toBe(false);
    expect(tablesEqual(two, { D: { nextHop: '2', nextHops: ['2', '3'], cost: 6 } })).toBe(true);
  });

  test('the hops formatter renders a set as "2, 3" and one hop as itself', () => {
    const single = { nextHop: '2', cost: 6 };
    const multi = { nextHop: '2', nextHops: ['2', '3'], cost: 6 };
    expect(formatCell('hops', single.nextHop, 16, single)).toBe('2');
    expect(formatCell('hops', multi.nextHop, 16, multi)).toBe('2, 3');
    expect(formatCell('hops', null, 16, { nextHop: null, cost: 16 })).toBe('—');
    // Without the route it still answers for the cell it was given, so a caller
    // that has not been updated degrades to the old behaviour rather than to '—'.
    expect(formatCell('hops', '2', 16)).toBe('2');
  });
});

/* ------------------------------------------------------------------ *
 * The protocols
 * ------------------------------------------------------------------ */

describe.each(ECMP_PROTOCOLS)('%s with ECMP', (protocolId) => {
  test('installs both hops on the diamond, and exactly one with the option off', () => {
    const off = converged(DIAMOND, protocolId, { ecmp: false });
    const on = converged(DIAMOND, protocolId, { ecmp: true });

    expect(nextHopsOf(off.tables().A.D)).toHaveLength(1);
    expect(nextHopsOf(on.tables().A.D)).toEqual(['B', 'C']);
  });

  test('installs all three hops when there are three', () => {
    const on = converged(TRIDENT, protocolId, { ecmp: true });
    expect(nextHopsOf(on.tables().A.D)).toEqual(['B', 'C', 'E']);
  });

  test('changes no converged cost, only the next-hop sets', () => {
    const off = converged(DIAMOND, protocolId, { ecmp: false });
    const on = converged(DIAMOND, protocolId, { ecmp: true });

    off.routerIds.forEach((from) => {
      off.routerIds.forEach((to) => {
        expect(on.tables()[from][to].cost).toBe(off.tables()[from][to].cost);
      });
    });
  });

  test('still converges — no flapping between two equally good answers', () => {
    const simulation = new Simulation(new Topology(DIAMOND), protocolId, { ecmp: true });
    const run = simulation.runToConvergence();
    expect(run.converged).toBe(true);
    // And it stays converged: a further round must change nothing at all.
    expect(simulation.runIteration().changed).toBe(false);
  });

  test('the primary hop is the lowest id, so findPath stays deterministic', () => {
    const on = converged(DIAMOND, protocolId, { ecmp: true });
    expect(on.tables().A.D.nextHop).toBe('B');
    expect(on.findPath('A', 'D')).toMatchObject({ status: 'ok', path: ['A', 'B', 'D'], cost: 6 });
  });

  test('every installed hop is a real neighbour that reaches the destination', () => {
    const on = converged(TRIDENT, protocolId, { ecmp: true });
    const truth = on.shortestPath('A', 'D').cost;

    nextHopsOf(on.tables().A.D).forEach((hop) => {
      expect(on.hasLink('A', hop)).toBe(true);
      expect(on.topology.linkCost('A', hop) + on.tables()[hop].D.cost).toBe(truth);
    });
  });

  test('the route tree overlay draws every equal-cost path', () => {
    const off = converged(DIAMOND, protocolId, { ecmp: false });
    const on = converged(DIAMOND, protocolId, { ecmp: true });

    // Off: one side of the diamond, so one of the two A-edges is missing.
    expect([...off.routeTreeEdges('A')].length).toBeLessThan(4);
    expect([...on.routeTreeEdges('A')].sort()).toEqual(['A|B', 'A|C', 'B|D', 'C|D']);
  });

  test('a tie that is not a tie installs one hop', () => {
    // Make one side of the diamond dearer and the set collapses to the cheap one.
    const simulation = new Simulation(new Topology(DIAMOND), protocolId, { ecmp: true });
    simulation.setLinkCost('A', 'C', 5);
    simulation.runToConvergence();
    expect(nextHopsOf(simulation.tables().A.D)).toEqual(['B']);
  });

  test('the option survives a break and a repair', () => {
    const simulation = new Simulation(new Topology(DIAMOND), protocolId, { ecmp: true });
    simulation.runToConvergence();

    simulation.removeLink('B', 'D');
    simulation.runToConvergence();
    expect(nextHopsOf(simulation.tables().A.D)).toEqual(['C']);

    simulation.addLink('B', 'D', 3);
    simulation.runToConvergence();
    expect(nextHopsOf(simulation.tables().A.D)).toEqual(['B', 'C']);
  });
});

/* ------------------------------------------------------------------ *
 * Where the option is, and is not, offered
 * ------------------------------------------------------------------ */

describe('which protocols offer it', () => {
  const declares = (id) => {
    const simulation = new Simulation(new Topology(DIAMOND), id);
    return simulation.protocol.options.some((option) => option.key === 'ecmp');
  };

  test.each(ECMP_PROTOCOLS)('%s declares it', (id) => {
    expect(declares(id)).toBe(true);
  });

  test.each(['stp', 'dual'])('%s does not', (id) => {
    expect(declares(id)).toBe(false);
  });

  test('distance vector hides it on the clock, where routes carry timers', () => {
    const simulation = new Simulation(new Topology(DIAMOND), 'dvr');
    expect(simulation.optionSchema().some((option) => option.key === 'ecmp')).toBe(true);

    simulation.setMode('timers');
    expect(simulation.optionSchema().some((option) => option.key === 'ecmp')).toBe(false);
    // The value still exists — `defaultsFrom` reads the whole schema — so
    // switching back does not lose what the user chose.
    expect(simulation.options.ecmp).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The scoreboard still agrees
 * ------------------------------------------------------------------ */

describe('the correctness overlay with ECMP on', () => {
  test('a converged diamond scores 100% either way', () => {
    [false, true].forEach((ecmp) => {
      const simulation = converged(DIAMOND, 'ls', { ecmp });
      expect(simulation.correctness.totals.percent).toBe(100);
    });
  });

  test('a bigger topology converges within the safety cap with ECMP on', () => {
    ECMP_PROTOCOLS.forEach((protocolId) => {
      const simulation = new Simulation(new Topology(TRIDENT), protocolId, { ecmp: true });
      const run = simulation.runToConvergence();
      expect(run.converged).toBe(true);
      expect(run.rounds).toBeLessThanOrEqual(SIM.maxConvergenceRounds);
    });
  });
});
