/**
 * pathVector.test.js — the path-vector suite.
 *
 * Structured like `DvrAlgorithm.test.js` and `linkState.test.js`, on the same
 * five-node fixture, so the three protocols can be read side by side.
 *
 * The protocol's one real guarantee is loop freedom by construction, so that is
 * asserted *after every round* rather than only at convergence — an invariant
 * that only holds once the dust settles is not an invariant. Where the honest
 * answer is more interesting than the tidy one it is written down instead: the
 * self-scan cannot prevent a transient forwarding loop, only end it, and there
 * is a test that shows exactly that.
 */

import { Simulation } from '../Simulation';
import { SIM } from '../../config';

/**
 *   N1 --1-- N2 --6-- N3
 *             |        |
 *             3        2
 *             |        |
 *            N5 --4-- N4
 */
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

/**
 *   1 --------- 10 --------- 4     one hop, and dear
 *   |                        |
 *   1                        1
 *   |                        |
 *   2 ---------- 1 --------- 3     three hops, and cheap
 *
 * The fixture for everything about the decision process: hop count and cost
 * disagree about how to get from 1 to 4, so which of them is consulted first is
 * visible in one table cell.
 */
const EXPENSIVE_SHORTCUT = {
  '1': [
    { neighbor: '2', cost: 1 },
    { neighbor: '4', cost: 10 },
  ],
  '2': [
    { neighbor: '1', cost: 1 },
    { neighbor: '3', cost: 1 },
  ],
  '3': [
    { neighbor: '2', cost: 1 },
    { neighbor: '4', cost: 1 },
  ],
  '4': [
    { neighbor: '3', cost: 1 },
    { neighbor: '1', cost: 10 },
  ],
};

/** `count` routers in a line, ids "1".."count". */
function chain(count, cost = 1) {
  const topology = {};
  for (let index = 1; index <= count; index += 1) topology[String(index)] = [];
  for (let index = 1; index < count; index += 1) {
    topology[String(index)].push({ neighbor: String(index + 1), cost });
    topology[String(index + 1)].push({ neighbor: String(index), cost });
  }
  return topology;
}

/** The same, closed into a ring. */
function ring(count, cost = 1) {
  const topology = chain(count, cost);
  topology['1'].push({ neighbor: String(count), cost });
  topology[String(count)].push({ neighbor: '1', cost });
  return topology;
}

const pv = (topology, overrides) => new Simulation(topology, 'pv', overrides);

/**
 * One round taken straight off the plugin. `Simulation` drops message payloads
 * from the snapshot, and the advertising rules are statements about payloads.
 */
const advertise = (simulation) =>
  simulation.protocol.round(simulation.state, simulation.topology, simulation.options).messages;

const costsFrom = (simulation, routerId) =>
  Object.fromEntries(
    Object.entries(simulation.tables()[routerId]).map(([dest, route]) => [dest, route.cost])
  );

/** Every route in the network, flattened. */
function everyRoute(simulation) {
  const list = [];
  Object.entries(simulation.tables()).forEach(([from, table]) => {
    Object.entries(table).forEach(([dest, route]) => list.push({ from, dest, route }));
  });
  return list;
}

/**
 * The protocol's core guarantee, plus the path convention that makes it
 * checkable: a path is what its *owner* would traverse, so it excludes the
 * owner, starts at the next hop and ends at the destination.
 */
function expectLoopFree(simulation) {
  everyRoute(simulation).forEach(({ from, dest, route }) => {
    expect(new Set(route.path).size).toBe(route.path.length); // no id twice
    expect(route.path).not.toContain(from); // and never the owner's own
    if (from === dest || route.nextHop === null) return;
    expect(route.path[0]).toBe(route.nextHop);
    expect(route.path[route.path.length - 1]).toBe(dest);
  });
}

/**
 * A seeded generator, so "randomised" means "the same script every run" rather
 * than a test that fails once a fortnight and cannot be reproduced. (Stage 8
 * adds a shared mulberry32 to the engine; this is a test-local stand-in.)
 */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Loop freedom
 * ------------------------------------------------------------------ */

describe('loop freedom', () => {
  test('no stored path ever repeats an id, or contains its owner — after every round', () => {
    // The invariant is asserted after every round *and* after every edit, not
    // only at convergence: "eventually loop-free" is what distance vector
    // manages, and it is not the same claim.
    const next = random(20240404);
    const simulation = pv(ring(7, 2), { infinityCost: SIM.maxInfinityCost });
    simulation.addLink('1', '4', 3);
    simulation.addLink('2', '6', 5);

    const editable = [
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
      ['1', '4'],
      ['2', '6'],
      ['6', '7'],
    ];
    const pick = (list) => list[Math.floor(next() * list.length)];

    for (let step = 0; step < 60; step += 1) {
      const roll = next();
      if (roll < 0.14) {
        const [a, b] = pick(editable);
        if (simulation.hasLink(a, b)) simulation.removeLink(a, b);
        else simulation.addLink(a, b, 1 + Math.floor(next() * 6));
      } else if (roll < 0.2) {
        const id = pick(simulation.routerIds);
        simulation.setRouterActive(id, !simulation.isActive(id));
      } else {
        simulation.runIteration();
      }
      expectLoopFree(simulation);
    }
  });

  test('once settled, following the next hops walks exactly the advertised path', () => {
    // At a fixed point every router holds its neighbours' current tables, so
    // the path in the advertisement and the path the traffic takes are the same
    // thing — which is what makes the AS Path column worth reading.
    const simulation = pv(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    simulation.removeLink('N2', 'N3');
    simulation.runToConvergence();

    simulation.routerIds.forEach((source) => {
      simulation.routerIds.forEach((destination) => {
        const walked = simulation.findPath(source, destination);
        expect(walked.status).toBe('ok');
        expect(walked.path).toEqual([source, ...simulation.tables()[source][destination].path]);
        expect(walked.cost).toBe(simulation.tables()[source][destination].cost);
      });
    });
  });

  test('the one loop the AS path cannot prevent — and it lasts exactly one round', () => {
    // Honesty, not a caveat: the self-scan rejects a path you are *on*, and
    // both of these are loop-free as written. They are simply out of date, and
    // A and B lost their own route to D in the same instant — one duct, two
    // cables, one digger.
    const stub = {
      A: [
        { neighbor: 'B', cost: 1 },
        { neighbor: 'D', cost: 1 },
      ],
      B: [
        { neighbor: 'A', cost: 1 },
        { neighbor: 'D', cost: 1 },
      ],
      D: [
        { neighbor: 'A', cost: 1 },
        { neighbor: 'B', cost: 1 },
      ],
    };
    const simulation = pv(stub);
    simulation.runToConvergence();

    simulation.removeLink('A', 'D');
    simulation.removeLink('B', 'D');

    expect(simulation.tables().A.D.path).toEqual(['B', 'D']);
    expect(simulation.tables().B.D.path).toEqual(['A', 'D']);
    expectLoopFree(simulation); // every path is still loop-free *as written*
    expect(simulation.findPath('A', 'D').status).toBe('loop');
    expect(simulation.correctness.totals.byClass.looping).toBe(2);

    // Next round each hears the other's new path, finds itself on it, and the
    // route is gone. This is the whole difference from counting to infinity:
    // the mistake is discovered by inspection rather than by arithmetic.
    simulation.runIteration();
    expect(simulation.findPath('A', 'D').status).toBe('unreachable');
    expect(simulation.correctness.totals.byClass.looping).toBe(0);
    expect(simulation.tables().A.D).toEqual({
      nextHop: null,
      cost: simulation.infinityCost,
      path: [],
      pref: 0,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Advertising
 * ------------------------------------------------------------------ */

describe('advertising', () => {
  test('a route is sent straight back to the neighbour it was learned from', () => {
    // No split horizon and no poisoned reverse. The guard is at the receiver,
    // and it is exact rather than approximate.
    const simulation = pv(chain(3));
    simulation.runToConvergence();

    const backwards = advertise(simulation).find(
      (message) => message.from === '1' && message.to === '2'
    );
    expect(backwards.kind).toBe('path');
    // The path on the wire includes the sender, because the sender is what
    // prepends it (RFC 4271 §5.1.2) — router 1 says "through me, then 2, then 3".
    // What it *stores* is still exclusive of itself; only the advertisement grows.
    expect(backwards.payload['3']).toEqual({ cost: 2, path: ['1', '2', '3'] });
    expect(simulation.tables()['1']['3'].path).toEqual(['2', '3']);

    // …and 2 is on that path, so it is never a candidate there.
    expect(simulation.tables()['2']['3'].path).toEqual(['3']);
  });

  test('a router with no route to somewhere says nothing about it', () => {
    const simulation = pv(chain(3));
    simulation.removeLink('2', '3');
    const payload = advertise(simulation).find((message) => message.from === '2').payload;
    expect(Object.keys(payload).sort()).toEqual(['1', '2']);
  });

  test('every router starts out knowing itself and whatever it is plugged into', () => {
    // Unlike link state, the direct link is a candidate before anyone has said
    // anything: a router can see its own interfaces.
    const simulation = pv(SAMPLE_TOPOLOGY);
    expect(costsFrom(simulation, 'N2')).toEqual({
      N1: 1,
      N2: 0,
      N3: 6,
      N4: simulation.infinityCost,
      N5: 3,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Correctness
 * ------------------------------------------------------------------ */

describe('correctness', () => {
  test('with "prefer total cost" on, every converged cost is the true shortest path', () => {
    // The same cross-check the distance-vector and link-state suites use: with
    // the middle two steps of the decision process swapped, path vector is an
    // IGP and must agree with ground truth everywhere.
    const simulation = pv(SAMPLE_TOPOLOGY, { preferCost: true });
    expect(simulation.runToConvergence().converged).toBe(true);

    simulation.routerIds.forEach((source) => {
      simulation.routerIds.forEach((destination) => {
        expect(simulation.tables()[source][destination].cost).toBe(
          simulation.shortestPath(source, destination).cost
        );
      });
    });
    expect(costsFrom(simulation, 'N1')).toEqual({ N1: 0, N2: 1, N3: 7, N4: 8, N5: 4 });
  });

  test('with it off, every route is the fewest hops, then the cheapest of those', () => {
    const simulation = pv(EXPENSIVE_SHORTCUT, { infinityCost: SIM.maxInfinityCost });
    expect(simulation.runToConvergence().converged).toBe(true);

    const truth = fewestHops(simulation);
    everyRoute(simulation).forEach(({ from, dest, route }) => {
      const [hops, cost] = truth.get(`${from}|${dest}`);
      expect(route.path.length).toBe(hops);
      expect(route.cost).toBe(cost);
    });
  });

  test("every path is a real walk, and its cost is that walk's", () => {
    const simulation = pv(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    everyRoute(simulation).forEach(({ from, route }) => {
      let cursor = from;
      let cost = 0;
      route.path.forEach((hop) => {
        expect(simulation.hasLink(cursor, hop)).toBe(true);
        cost += simulation.topology.linkCost(cursor, hop);
        cursor = hop;
      });
      if (route.nextHop !== null) expect(route.cost).toBe(cost);
    });
  });

  test('equal candidates settle rather than flapping', () => {
    // Both ways round the diamond are two hops for six, so the decision falls
    // through to the last tie-break — the lowest neighbour id, as in BGP — and
    // stays there. Anything less deterministic would make convergence
    // undetectable (invariant 4).
    const diamond = {
      A: [
        { neighbor: 'B', cost: 3 },
        { neighbor: 'C', cost: 3 },
      ],
      B: [
        { neighbor: 'A', cost: 3 },
        { neighbor: 'D', cost: 3 },
      ],
      C: [
        { neighbor: 'A', cost: 3 },
        { neighbor: 'D', cost: 3 },
      ],
      D: [
        { neighbor: 'B', cost: 3 },
        { neighbor: 'C', cost: 3 },
      ],
    };
    const simulation = pv(diamond);
    simulation.runToConvergence();

    expect(simulation.tables().A.D).toMatchObject({ nextHop: 'B', cost: 6, path: ['B', 'D'] });
    for (let round = 0; round < 5; round += 1) {
      expect(simulation.runIteration().changed).toBe(false);
      expect(simulation.tables().A.D.nextHop).toBe('B');
    }
  });
});

/**
 * Fewest hops, then cheapest among those — the objective BGP's default ordering
 * actually optimises — computed independently of the protocol by
 * Floyd-Warshall over the lexicographic pair.
 */
function fewestHops(simulation) {
  const ids = simulation.routerIds;
  const key = (a, b) => `${a}|${b}`;
  const best = new Map();

  ids.forEach((a) =>
    ids.forEach((b) => best.set(key(a, b), a === b ? [0, 0] : [Infinity, Infinity]))
  );
  simulation.getLinks().forEach(({ source, destination, cost }) => {
    best.set(key(source, destination), [1, cost]);
    best.set(key(destination, source), [1, cost]);
  });

  ids.forEach((k) =>
    ids.forEach((i) =>
      ids.forEach((j) => {
        const [ih, ic] = best.get(key(i, k));
        const [kh, kc] = best.get(key(k, j));
        if (ih === Infinity || kh === Infinity) return;
        const [held, heldCost] = best.get(key(i, j));
        if (ih + kh < held || (ih + kh === held && ic + kc < heldCost)) {
          best.set(key(i, j), [ih + kh, ic + kc]);
        }
      })
    )
  );

  return best;
}

/* ------------------------------------------------------------------ *
 * Failure handling
 * ------------------------------------------------------------------ */

describe('failure handling', () => {
  test('the A–B–C break goes straight to unreachable, with nothing switched on', () => {
    // The headline. This is the fixture the distance-vector suite uses to
    // demonstrate counting to infinity, run with every option left alone —
    // because there are no loop-avoidance options to turn on.
    const simulation = pv(chain(3));
    simulation.runToConvergence();
    expect(simulation.tables()['1']['3'].cost).toBe(2);

    simulation.removeLink('2', '3');
    const seen = new Set([simulation.tables()['1']['3'].cost]);
    const { rounds, converged } = simulation.runToConvergence();
    seen.add(simulation.tables()['1']['3'].cost);

    expect(converged).toBe(true);
    expect(rounds).toBeLessThanOrEqual(2);
    // 2 and ∞ are the only two costs router 1 is ever allowed to hold: no 3,
    // no 4, no climb to the ceiling.
    expect([...seen].sort((a, b) => a - b)).toEqual([2, simulation.infinityCost]);
    expect(simulation.tables()['1']['3'].nextHop).toBeNull();
  });

  test('a partition marks the far side unreachable, with an empty path', () => {
    const simulation = pv({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
    });
    simulation.runToConvergence();

    simulation.removeLink('A', 'B');
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.tables().A.B).toEqual({
      nextHop: null,
      cost: simulation.infinityCost,
      path: [],
      pref: 0,
    });
    expect(simulation.findPath('A', 'B').status).toBe('unreachable');
  });

  test('a downed router is routed around, and appears in nobody‘s path', () => {
    const simulation = pv(ring(6, 2));
    simulation.runToConvergence();
    simulation.setRouterActive('1', false);
    expect(simulation.runToConvergence().converged).toBe(true);

    const live = simulation.routerIds.filter((id) => simulation.isActive(id));
    live.forEach((source) => {
      live.forEach((destination) => {
        expect(simulation.tables()[source][destination].cost).toBe(
          simulation.shortestPath(source, destination).cost
        );
      });
      expect(simulation.tables()[source]['1'].nextHop).toBeNull();
    });
    // Not one surviving route still lists it — the stale paths that carried it
    // for a round after the failure are gone.
    everyRoute(simulation).forEach(({ route }) => expect(route.path).not.toContain('1'));
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('a deleted router leaves the tables entirely', () => {
    const simulation = pv(chain(3));
    simulation.runToConvergence();

    simulation.removeRouter('2');
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(Object.keys(simulation.tables()['1'])).toEqual(['1', '3']);
    expect(simulation.tables()['1']['3'].nextHop).toBeNull();
  });

  test('path hunting: a broken ring is re-learned through successively longer paths', () => {
    // The path vector analogue of counting to infinity — and the reason it
    // terminates is visible in the column: every candidate is loop-free, and
    // there are finitely many of them.
    const simulation = pv(ring(6, 2));
    simulation.runToConvergence();
    expect(simulation.tables()['1']['2'].path).toEqual(['2']);

    simulation.removeLink('1', '2');
    const lengths = [simulation.tables()['1']['2'].path.length];
    for (let round = 0; round < 6; round += 1) {
      simulation.runIteration();
      lengths.push(simulation.tables()['1']['2'].path.length);
    }

    // One hop, then nothing at all, then the whole way round the ring.
    expect(lengths[0]).toBe(0);
    expect(simulation.tables()['1']['2'].path).toEqual(['6', '5', '4', '3', '2']);
    expect(simulation.tables()['1']['2'].cost).toBe(simulation.shortestPath('1', '2').cost);
    expect(Math.max(...lengths)).toBe(5);
  });
});

/* ------------------------------------------------------------------ *
 * Policy
 * ------------------------------------------------------------------ */

describe('policy', () => {
  test('LOCAL_PREF outranks path length', () => {
    const simulation = pv(EXPENSIVE_SHORTCUT, { infinityCost: SIM.maxInfinityCost });
    simulation.runToConvergence();
    // One hop beats three, however dear the hop is: this is BGP, not an IGP.
    expect(simulation.tables()['1']['4']).toMatchObject({ nextHop: '4', cost: 10 });

    simulation.setRouterOption('1', 'localPref', 200, '2');
    simulation.runToConvergence();
    expect(simulation.tables()['1']['4']).toMatchObject({
      nextHop: '2',
      cost: 3,
      path: ['2', '3', '4'],
      accent: 'policy',
    });
  });

  test('path length outranks cost, unless told otherwise', () => {
    const bgp = pv(EXPENSIVE_SHORTCUT, { infinityCost: SIM.maxInfinityCost });
    bgp.runToConvergence();
    expect(bgp.tables()['1']['4']).toMatchObject({ cost: 10, path: ['4'] });

    const igp = pv(EXPENSIVE_SHORTCUT, {
      preferCost: true,
      infinityCost: SIM.maxInfinityCost,
    });
    igp.runToConvergence();
    expect(igp.tables()['1']['4']).toMatchObject({ cost: 3, path: ['2', '3', '4'] });
  });

  test('LOCAL_PREF outranks cost as well — the long way round, on purpose', () => {
    const simulation = pv(EXPENSIVE_SHORTCUT, {
      preferCost: true,
      infinityCost: SIM.maxInfinityCost,
    });
    simulation.runToConvergence();
    expect(simulation.tables()['1']['3']).toMatchObject({ nextHop: '2', cost: 2 });

    simulation.setRouterOption('1', 'localPref', 200, '4');
    simulation.runToConvergence();
    expect(simulation.tables()['1']['3']).toMatchObject({
      nextHop: '4',
      cost: 11,
      accent: 'policy',
    });
    // And the meter says so: policy is a decision to spend distance, and
    // "converged" was never the same question as "correct".
    expect(simulation.correctness.totals.byClass.suboptimal).toBeGreaterThan(0);
  });

  test('raising it changes the router that holds it, and nobody else', () => {
    const simulation = pv(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    const before = simulation.getSnapshot().tables;

    simulation.setRouterOption('N2', 'localPref', 200, 'N3');

    // Applied at once rather than at the next round: it is configuration, not
    // something anyone has to be told.
    expect(simulation.tables().N2.N4).toMatchObject({ nextHop: 'N3', cost: 8 });
    simulation.routerIds
      .filter((id) => id !== 'N2')
      .forEach((id) => expect(simulation.tables()[id]).toEqual(before[id]));
  });

  test('a preference nobody set is the default, and equal preferences decide nothing', () => {
    const simulation = pv(SAMPLE_TOPOLOGY);
    expect(simulation.routerOption('N2', 'localPref', 'N3')).toBe(SIM.pathVector.defaultLocalPref);

    // Raising every neighbour equally is not a policy, so no route is marked as
    // won by one.
    simulation.setRouterOption('N2', 'localPref', 300, 'N1');
    simulation.setRouterOption('N2', 'localPref', 300, 'N3');
    simulation.setRouterOption('N2', 'localPref', 300, 'N5');
    simulation.runToConvergence();

    expect(everyRoute(simulation).some(({ route }) => route.accent)).toBe(false);
    simulation.routerIds.forEach((source) =>
      simulation.routerIds.forEach((destination) =>
        expect(simulation.tables()[source][destination].cost).toBe(
          simulation.shortestPath(source, destination).cost
        )
      )
    );
  });
});

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

describe('maxPathLength', () => {
  test('is a cap on the path, not a licence to hold a longer one', () => {
    const simulation = pv(chain(6), { maxPathLength: 3 });
    expect(simulation.runToConvergence().converged).toBe(true);

    expect(simulation.tables()['1']['4'].path).toEqual(['2', '3', '4']);
    // Beyond the cap the answer is "unreachable", not "here is an over-long
    // path" — the routers stop accepting them rather than stop advertising.
    expect(simulation.tables()['1']['5'].nextHop).toBeNull();
    expect(simulation.tables()['1']['6'].nextHop).toBeNull();
    everyRoute(simulation).forEach(({ route }) =>
      expect(route.path.length).toBeLessThanOrEqual(3)
    );
  });

  test('raising it again restores the far end', () => {
    const simulation = pv(chain(6), { maxPathLength: 3 });
    simulation.runToConvergence();
    simulation.setOptions({ maxPathLength: SIM.pathVector.maxPathLength });
    simulation.runToConvergence();

    expect(simulation.tables()['1']['6']).toMatchObject({
      cost: 5,
      path: ['2', '3', '4', '5', '6'],
    });
  });
});

/* ------------------------------------------------------------------ *
 * What the UI reads
 * ------------------------------------------------------------------ */

describe('the views the plugin exposes', () => {
  test('the AS path is a column, and the snapshot carries a detached copy of it', () => {
    const simulation = pv(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    const snapshot = simulation.getSnapshot();
    expect(snapshot.protocol.columns.map((column) => column.key)).toEqual([
      'cost',
      'nextHop',
      'path',
    ]);
    expect(snapshot.tables.N1.N4.path).toEqual(['N2', 'N5', 'N4']);
    // Invariant 9: React state must not alias anything the engine can rewrite.
    expect(snapshot.tables.N1.N4.path).not.toBe(simulation.tables().N1.N4.path);
  });

  test('the metrics track path hunting and policy', () => {
    const simulation = pv(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    const value = (label) => simulation.metrics().find((row) => row.label === label).value;

    expect(value('Longest AS path')).toBe(3);
    expect(value('Routes chosen by policy')).toBe(0);
    expect(simulation.decorations()).toEqual({ links: {}, routers: {} });

    simulation.setRouterOption('N2', 'localPref', 200, 'N3');
    expect(value('Routes chosen by policy')).toBeGreaterThan(0);
    // The link carrying those routes is tinted in the scene, so the detour is
    // visible without opening a table.
    expect(simulation.decorations().links).toEqual({ 'N2|N3': 'policy' });
  });

  test('the route tree is the policy tree', () => {
    const simulation = pv(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    const edges = simulation.routeTreeEdges('N1');
    expect(edges.size).toBe(4);
    edges.forEach((edge) => {
      const [a, b] = edge.split('|');
      expect(simulation.hasLink(a, b)).toBe(true);
    });
    expect(edges.has('N1|N2')).toBe(true);
    expect(edges.has('N2|N3')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The comparison the stage exists for
 * ------------------------------------------------------------------ */

describe('against distance vector, on the same failure', () => {
  test('path vector withdraws where distance vector counts', () => {
    const counting = new Simulation(chain(3), 'dvr', {
      splitHorizon: false,
      poisonedReverse: false,
    });
    counting.runToConvergence();
    counting.removeLink('2', '3');
    const dvr = counting.runToConvergence();

    const walking = pv(chain(3));
    walking.runToConvergence();
    walking.removeLink('2', '3');
    const path = walking.runToConvergence();

    // Same answer in the end…
    expect(counting.tables()['1']['3'].cost).toBe(counting.infinityCost);
    expect(walking.tables()['1']['3'].cost).toBe(walking.infinityCost);
    // …but one of them walked there one round per unit of cost, with every
    // patch distance vector has for the problem switched off — while the other
    // has no such patches to switch off in the first place.
    expect(dvr.rounds).toBeGreaterThan(path.rounds * 3);
    expect(counting.stats.peakWrongEntries).toBeGreaterThan(walking.stats.peakWrongEntries);
  });
});
