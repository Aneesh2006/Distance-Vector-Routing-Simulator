/**
 * bgpTiers.test.js — the two-tier AS model for path vector (stage 9.6, doc 03 §7).
 *
 * The single-tier model is one router, one autonomous system, and the first
 * group of tests is the safety property everything else rests on: on that
 * default nothing here exists and every path is the list of router ids it always
 * was.
 *
 * Group two onward is what grouping routers buys, and what it costs. The AS path
 * only grows on an external session, so it is only a loop guard on one; inside an
 * AS BGP has to fall back on refusing to relay, which is why iBGP needs a full
 * mesh and why route reflectors exist. Those three sentences are the stage.
 */

import { Simulation } from '../Simulation';
import { Topology } from '../Topology';
import { SIM } from '../../config';

const PV = SIM.pathVector;

/** Six routers in a line: 1–2–3–4–5–6. */
const LINE = {
  1: [{ neighbor: '2', cost: 1 }],
  2: [{ neighbor: '3', cost: 1 }],
  3: [{ neighbor: '4', cost: 1 }],
  4: [{ neighbor: '5', cost: 1 }],
  5: [{ neighbor: '6', cost: 1 }],
  6: [],
};

/** Three in a triangle, for testing a fully-meshed AS. */
const TRIANGLE = {
  A: [
    { neighbor: 'B', cost: 1 },
    { neighbor: 'C', cost: 1 },
  ],
  B: [{ neighbor: 'C', cost: 1 }],
  C: [],
};

function pv(adjacency, config = {}, overrides) {
  const simulation = new Simulation(new Topology(adjacency), 'pv', overrides);
  Object.entries(config).forEach(([routerId, settings]) => {
    Object.entries(settings).forEach(([key, value]) => {
      simulation.setRouterOption(routerId, key, value);
    });
  });
  simulation.runToConvergence();
  return simulation;
}

/** `{ as: n }` for each router in a list — the common case. */
const inAs = (as, ids) => Object.fromEntries(ids.map((id) => [id, { as }]));

const pathTo = (simulation, from, dest) => simulation.tables()[from][dest].path;

const costsFrom = (simulation, routerId) =>
  Object.fromEntries(
    Object.entries(simulation.tables()[routerId]).map(([dest, route]) => [dest, route.cost])
  );

const metric = (simulation, label) => {
  const row = simulation.metrics().find((entry) => entry.label === label);
  return row && row.value;
};

/* ------------------------------------------------------------------ *
 * One router, one AS
 * ------------------------------------------------------------------ */

describe('a network nobody has grouped', () => {
  test('shows no tier at all: no extra metrics, no decorations, no BGP tab', () => {
    const simulation = pv(LINE);
    expect(simulation.metrics().map((row) => row.label)).toEqual([
      'Longest AS path',
      'Routes chosen by policy',
    ]);
    expect(simulation.decorations()).toEqual({ links: {}, routers: {} });
    expect(simulation.inspect('1')).toEqual([]);
  });

  test('the AS path is the list of router ids it always was', () => {
    const simulation = pv(LINE);
    expect(pathTo(simulation, '1', '6')).toEqual(['2', '3', '4', '5', '6']);
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('stating every AS explicitly, one per router, changes nothing', () => {
    const plain = pv(LINE);
    const stated = pv(
      LINE,
      Object.fromEntries(Object.keys(LINE).map((id) => [id, { as: Number(id) }]))
    );
    expect(pathTo(stated, '1', '6')).toEqual(pathTo(plain, '1', '6'));
    expect(costsFrom(stated, '1')).toEqual(costsFrom(plain, '1'));
  });

  test('the AS defaults to the router id, so the control shows something true', () => {
    const simulation = pv(LINE);
    expect(simulation.routerOption('3', 'as')).toBe('3');
    simulation.setRouterOption('3', 'as', 9);
    expect(simulation.routerOption('3', 'as')).toBe(9);
  });
});

/* ------------------------------------------------------------------ *
 * eBGP and iBGP
 * ------------------------------------------------------------------ */

describe('grouping routers into an AS', () => {
  // AS 1 = {1,2,3}, AS 2 = {4,5,6}. Only 3 ↔ 4 crosses.
  const TWO = { ...inAs(1, ['1', '2', '3']), ...inAs(2, ['4', '5', '6']) };

  test('the AS path counts systems crossed, not routers', () => {
    const simulation = pv(LINE, { ...TWO, 2: { as: 1, routeReflector: true } });
    // 1 to 6: leave AS 1, cross into AS 2. One AS on the path.
    expect(pathTo(simulation, '1', '6')).toEqual(['2']);
    // And within an AS no system is crossed at all.
    expect(pathTo(simulation, '1', '3')).toEqual([]);
  });

  test('an internal destination costs the link costs but no path length', () => {
    const simulation = pv(LINE, TWO);
    expect(simulation.tables()['1']['3']).toMatchObject({ cost: 2, nextHop: '2', path: [] });
  });

  test('the boundary link is decorated and the internal ones are not', () => {
    const simulation = pv(LINE, TWO);
    expect(simulation.decorations().links).toEqual({ '3|4': 'asBoundary' });
  });

  test('the metrics count the systems and both kinds of session', () => {
    const simulation = pv(LINE, TWO);
    expect(metric(simulation, 'Autonomous systems')).toBe(2);
    expect(metric(simulation, 'Sessions (eBGP / iBGP)')).toBe('1 / 4');
    expect(metric(simulation, 'Route reflectors')).toBe('none');
  });

  test('the BGP tab names each session and what this router relays from it', () => {
    const simulation = pv(LINE, TWO);
    const [tab] = simulation.inspect('3');
    const rows = tab.blocks.find((block) => block.type === 'rows').rows;
    const table = tab.blocks.find((block) => block.type === 'table');

    expect(tab.id).toBe('bgp');
    expect(rows.find((row) => row.label === 'AS').value).toBe('1');
    expect(table.rows).toEqual([
      { key: '2', peer: '2', as: '1', session: 'iBGP', passesOn: 'eBGP only' },
      { key: '4', peer: '4', as: '2', session: 'eBGP', passesOn: 'everything' },
    ]);
  });

  test('a route records which kind of session it arrived on', () => {
    const simulation = pv(LINE, TWO);
    // 3 hears about 4 across the boundary: external.
    expect(simulation.tables()['3']['4'].viaIbgp).toBe(false);
    // 2 hears about 4 from 3, which is in its own AS: internal, and therefore
    // the thing it may not pass on.
    expect(simulation.tables()['2']['4'].viaIbgp).toBe(true);
    // A directly connected internal peer is locally originated rather than
    // learned, which is why an AS can still route within itself.
    expect(simulation.tables()['1']['2'].viaIbgp).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §9.2, and what it costs
 * ------------------------------------------------------------------ */

describe('iBGP does not re-advertise', () => {
  const TWO = { ...inAs(1, ['1', '2', '3']), ...inAs(2, ['4', '5', '6']) };

  test('the interior of an AS never hears the external route', () => {
    // 3 peers with AS 2 and tells 2 (that is allowed — the route was learned
    // externally). 2 must not tell 1, because it heard it from an internal peer
    // and an unchanged AS path could not reveal the loop that would make.
    const simulation = pv(LINE, TWO);
    expect(simulation.tables()['2']['5'].nextHop).toBe('3');
    expect(simulation.tables()['1']['5'].nextHop).toBeNull();
    // Which is a real hole in the network, and the meter says so.
    expect(simulation.correctness.totals.percent).toBeLessThan(100);
  });

  test('a route reflector on each side fills both holes', () => {
    // The hole is symmetric: 6 cannot hear about AS 1 either, because 5 heard it
    // from 4 internally. One reflector fixes one half.
    const half = pv(LINE, { ...TWO, 2: { as: 1, routeReflector: true } });
    expect(half.tables()['1']['5'].nextHop).toBe('2');
    expect(half.tables()['6']['1'].nextHop).toBeNull();

    const both = pv(LINE, {
      ...TWO,
      2: { as: 1, routeReflector: true },
      5: { as: 2, routeReflector: true },
    });
    expect(both.tables()['1']['5'].nextHop).toBe('2');
    expect(both.tables()['6']['1'].nextHop).toBe('5');
    expect(both.correctness.totals.percent).toBe(100);
    expect(metric(both, 'Route reflectors')).toBe('2, 5');
    expect(both.decorations().routers['2']).toBe('reflector');
  });

  test('so does turning the rule off, which is what a full mesh amounts to', () => {
    const simulation = pv(LINE, TWO, { ibgpNoReadvertise: false });
    expect(simulation.tables()['1']['5'].nextHop).toBe('2');
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('a genuinely full mesh needs no reflector and no exception', () => {
    // Every router in AS 1 peers with every other, so nothing has to be relayed:
    // each hears the external route from a border router directly. That is the
    // n²/2 sessions the rule costs you.
    const simulation = pv(
      {
        A: [
          { neighbor: 'B', cost: 1 },
          { neighbor: 'C', cost: 1 },
          { neighbor: 'X', cost: 1 },
        ],
        B: [
          { neighbor: 'C', cost: 1 },
          { neighbor: 'X', cost: 1 },
        ],
        C: [],
        X: [],
      },
      inAs(1, ['A', 'B', 'C'])
    );
    expect(simulation.correctness.totals.percent).toBe(100);
    // C hears X from A and from B, both eBGP-learned by them and therefore
    // relayable; the two are equal and the lowest id breaks the tie.
    expect(simulation.tables().C.X).toMatchObject({ nextHop: 'A', cost: 2 });
  });

  test('the whole AS still reaches everything inside itself', () => {
    // The rule is about routes *learned* internally, never about the wiring: a
    // directly connected internal peer is locally originated and always relayed,
    // or an AS could not route within itself at all.
    const simulation = pv(LINE, TWO);
    ['1', '2', '3'].forEach((from) => {
      ['1', '2', '3'].forEach((to) => {
        expect(simulation.tables()[from][to].cost).toBe(Math.abs(Number(from) - Number(to)));
      });
    });
  });
});

/* ------------------------------------------------------------------ *
 * Loop freedom, still
 * ------------------------------------------------------------------ */

describe('loop freedom with two tiers', () => {
  test('nobody accepts a path their own AS is already on', () => {
    // A ring cut into two ASes: each half hears about the other from both
    // directions, and the far one always names its own AS.
    const simulation = pv(
      {
        1: [
          { neighbor: '2', cost: 1 },
          { neighbor: '4', cost: 1 },
        ],
        2: [{ neighbor: '3', cost: 1 }],
        3: [{ neighbor: '4', cost: 1 }],
        4: [],
      },
      { ...inAs(1, ['1', '2']), ...inAs(2, ['3', '4']) }
    );

    simulation.routerIds.forEach((from) => {
      const mine = simulation.routerOption(from, 'as');
      Object.values(simulation.tables()[from]).forEach((route) => {
        expect(route.path.map(String)).not.toContain(String(mine));
        // And no AS appears twice, which is what a loop would look like.
        expect(new Set(route.path).size).toBe(route.path.length);
      });
    });
  });

  test('the tables never disagree about where a packet goes', () => {
    const simulation = pv(
      {
        1: [
          { neighbor: '2', cost: 1 },
          { neighbor: '4', cost: 1 },
        ],
        2: [{ neighbor: '3', cost: 1 }],
        3: [{ neighbor: '4', cost: 1 }],
        4: [],
      },
      { ...inAs(1, ['1', '2']), ...inAs(2, ['3', '4']) }
    );

    simulation.routerIds.forEach((from) => {
      simulation.routerIds.forEach((to) => {
        expect(simulation.findPath(from, to).status).not.toBe('loop');
      });
    });
  });

  test('two reflectors pointed at each other still terminate', () => {
    // Real reflectors carry a CLUSTER_LIST for exactly this, and it is not
    // modelled — so what must be guaranteed is that the sim does not hang and no
    // cost escapes the ceiling. It converges because a route round the loop gets
    // dearer every time, exactly as count-to-infinity does.
    const simulation = new Simulation(
      new Topology({
        A: [
          { neighbor: 'B', cost: 1 },
          { neighbor: 'X', cost: 1 },
        ],
        B: [{ neighbor: 'C', cost: 1 }],
        C: [],
        X: [],
      }),
      'pv'
    );
    ['A', 'B', 'C'].forEach((id) => simulation.setRouterOption(id, 'as', 1));
    ['A', 'B'].forEach((id) => simulation.setRouterOption(id, 'routeReflector', true));

    const run = simulation.runToConvergence();
    expect(run.converged).toBe(true);
    expect(run.rounds).toBeLessThanOrEqual(SIM.maxConvergenceRounds);
    simulation.routerIds.forEach((from) => {
      Object.values(simulation.tables()[from]).forEach((route) => {
        expect(route.cost).toBeLessThanOrEqual(simulation.infinityCost);
      });
    });
    // And the answer is right: reflection got the route where it had to go.
    expect(simulation.tables().C.X.cost).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * The decision process
 * ------------------------------------------------------------------ */

describe('the decision process with two tiers', () => {
  test('eBGP is preferred to iBGP when the path lengths tie', () => {
    // D is in AS 2. B (AS 1) can reach it directly by eBGP for 5, or by iBGP
    // through A for 2 + 1 = 3. Both paths cross exactly one AS, so length ties
    // and the eBGP-over-iBGP step decides — against the cheaper route, which is
    // exactly the surprise worth demonstrating.
    const simulation = pv(
      {
        A: [
          { neighbor: 'B', cost: 2 },
          { neighbor: 'D', cost: 1 },
        ],
        B: [{ neighbor: 'D', cost: 5 }],
        D: [],
      },
      { ...inAs(1, ['A', 'B']), D: { as: 2 } }
    );
    expect(simulation.tables().B.D).toMatchObject({ nextHop: 'D', cost: 5, viaIbgp: false });
  });

  test('and cost decides again once "prefer total cost" is on', () => {
    // preferCost moves the metric ahead of both length and the tier, so the
    // cheap internal route wins after all.
    const simulation = pv(
      {
        A: [
          { neighbor: 'B', cost: 2 },
          { neighbor: 'D', cost: 1 },
        ],
        B: [{ neighbor: 'D', cost: 5 }],
        D: [],
      },
      { ...inAs(1, ['A', 'B']), D: { as: 2 } },
      { preferCost: true }
    );
    expect(simulation.tables().B.D).toMatchObject({ nextHop: 'A', cost: 3, viaIbgp: true });
  });

  test('LOCAL_PREF still outranks everything, tiers included', () => {
    const simulation = pv(
      {
        A: [
          { neighbor: 'B', cost: 2 },
          { neighbor: 'D', cost: 1 },
        ],
        B: [{ neighbor: 'D', cost: 5 }],
        D: [],
      },
      { ...inAs(1, ['A', 'B']), D: { as: 2 } }
    );
    expect(simulation.tables().B.D.nextHop).toBe('D');

    // Tell B it prefers everything it hears from A, and the internal route wins.
    simulation.setRouterOption('B', 'localPref', 200, 'A');
    simulation.runToConvergence();
    expect(simulation.tables().B.D.nextHop).toBe('A');
  });

  test('maxPathLength counts ASes, so grouping routers loosens it', () => {
    // Six routers in a line is five ASes crossed, so a cap of 2 cuts the far end
    // off — until three of them become one AS and the same journey is two hops.
    const tight = pv(LINE, {}, { maxPathLength: 2 });
    expect(tight.tables()['1']['6'].nextHop).toBeNull();

    const grouped = pv(
      LINE,
      { ...inAs(1, ['1', '2', '3']), ...inAs(2, ['4', '5', '6']), 2: { as: 1, routeReflector: true } },
      { maxPathLength: 2 }
    );
    expect(grouped.tables()['1']['6'].nextHop).toBe('2');
  });
});

/* ------------------------------------------------------------------ *
 * Living with it
 * ------------------------------------------------------------------ */

describe('editing the tiers', () => {
  test('merging two routers into one AS takes effect at once', () => {
    const simulation = pv(TRIANGLE);
    expect(pathTo(simulation, 'A', 'C')).toEqual(['C']);

    // A routerOption event re-derives immediately, like every other edit.
    simulation.setRouterOption('A', 'as', 1);
    simulation.setRouterOption('C', 'as', 1);
    expect(pathTo(simulation, 'A', 'C')).toEqual([]);
  });

  test('splitting them again restores the path', () => {
    const simulation = pv(TRIANGLE, inAs(1, ['A', 'B', 'C']));
    expect(pathTo(simulation, 'A', 'C')).toEqual([]);

    simulation.setRouterOption('C', 'as', 2);
    simulation.runToConvergence();
    expect(pathTo(simulation, 'A', 'C')).toEqual(['2']);
  });

  test('a converged two-tier network reports no further change', () => {
    const simulation = pv(LINE, {
      ...inAs(1, ['1', '2', '3']),
      ...inAs(2, ['4', '5', '6']),
      2: { as: 1, routeReflector: true },
    });
    expect(simulation.runIteration().changed).toBe(false);
    expect(simulation.runIteration().changed).toBe(false);
  });

  test('a fully-internal AS converges and reaches everything', () => {
    const simulation = pv(TRIANGLE, inAs(1, ['A', 'B', 'C']));
    expect(simulation.correctness.totals.percent).toBe(100);
    ['A', 'B', 'C'].forEach((from) => {
      expect(pathTo(simulation, from, from === 'A' ? 'B' : 'A')).toEqual([]);
    });
  });

  test('switching the protocol away and back forgets the grouping', () => {
    // AS numbers live in options.routerOptions, which resets with the protocol —
    // the same call every other per-router knob makes.
    const simulation = pv(TRIANGLE, inAs(1, ['A', 'B', 'C']));
    simulation.setProtocol('dvr');
    simulation.setProtocol('pv');
    expect(simulation.routerOption('A', 'as')).toBe('A');
  });

  test('an AS number above the control range is clamped by the UI, not the engine', () => {
    // The engine takes what it is given and treats it as an identity; the bounds
    // exist so the input cannot produce something silly.
    const control = new Simulation(new Topology(TRIANGLE), 'pv').protocol.routerControls.find(
      (item) => item.key === 'as'
    );
    expect(control).toMatchObject({ min: PV.minAs, max: PV.maxAs, defaultFrom: 'routerId' });
  });
});
