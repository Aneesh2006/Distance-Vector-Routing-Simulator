/**
 * dual.test.js — the DUAL suite.
 *
 * Structured like the other three protocol suites and run on the same five-node
 * fixture so they can be read side by side. Two things make this one different.
 *
 * First, the protocol's claim is about *every instant*, not about the fixed
 * point: the feasibility condition is supposed to make a forwarding loop
 * impossible at any moment under any failure, so `FD ≤ cost` and "walking the
 * tables never revisits a router" are asserted after every round rather than
 * once at the end. An invariant that only holds when the dust settles is what
 * distance vector already manages, and it is not the same claim.
 *
 * Second, where doc 05 §6 promises something the implementation does not
 * deliver, the test says what actually happens. §6.1 offers the five-node
 * fixture as the instant-failover demo; it is not one — N5 reports 6 for N3 and
 * N2's feasible distance is also 6, so the condition fails by exactly the strict
 * inequality it is built on, and N2 goes ACTIVE. That is a better lesson than
 * the one the doc intended, and there is a test for it.
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
 * The "Feasibility trap" preset, and the fixture for everything about the
 * condition itself.
 *
 *          2         router 1 reaches 4 three ways:
 *        /   \         via 2  — cost 2, neighbour reports 1
 *   1 -- 5 -- 4         via 5  — cost 2, neighbour reports 1   ← feasible backup
 *        \   /          via 3  — cost 6, neighbour reports 5   ← loop-free, and
 *          3                                                     still fails the FC
 */
const FEASIBILITY_TRAP = {
  '1': [
    { neighbor: '2', cost: 1 },
    { neighbor: '3', cost: 1 },
    { neighbor: '5', cost: 1 },
  ],
  '2': [
    { neighbor: '1', cost: 1 },
    { neighbor: '4', cost: 1 },
  ],
  '3': [
    { neighbor: '1', cost: 1 },
    { neighbor: '4', cost: 5 },
  ],
  '4': [
    { neighbor: '2', cost: 1 },
    { neighbor: '3', cost: 5 },
    { neighbor: '5', cost: 1 },
  ],
  '5': [
    { neighbor: '1', cost: 1 },
    { neighbor: '4', cost: 1 },
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

const dual = (topology, overrides) => new Simulation(topology, 'dual', overrides);

/** Every route in the network, flattened. */
function everyRoute(simulation) {
  const list = [];
  Object.entries(simulation.tables()).forEach(([from, table]) => {
    Object.entries(table).forEach(([dest, route]) => list.push({ from, dest, route }));
  });
  return list;
}

const messagesOf = (result, kind) => result.exchanges.filter((message) => message.kind === kind);

/** Queries about one destination, which is what the labels carry. */
const queriesAbout = (result, dest) =>
  messagesOf(result, 'query').filter((message) => message.label === `QRY·${dest}`);

/**
 * The algorithm's own invariant: the feasible distance is the best this router
 * has *achieved*, so it can never be more than what it currently believes.
 */
function expectFeasibleDistanceHolds(simulation) {
  everyRoute(simulation).forEach(({ route }) => {
    expect(route.fd).toBeLessThanOrEqual(route.cost);
  });
}

/** The headline claim, asserted by walking the live tables hop by hop. */
function expectLoopFree(simulation) {
  simulation.routerIds.forEach((source) => {
    simulation.routerIds.forEach((destination) => {
      expect(simulation.findPath(source, destination).status).not.toBe('loop');
    });
  });
  expect(simulation.correctness.totals.byClass.looping).toBe(0);
}

/**
 * A seeded generator, so "randomised" means "the same script every run" rather
 * than a test that fails once a fortnight and cannot be reproduced.
 */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Correctness
 * ------------------------------------------------------------------ */

describe('correctness', () => {
  test('every converged cost is the true shortest path', () => {
    const simulation = dual(SAMPLE_TOPOLOGY);
    expect(simulation.runToConvergence().converged).toBe(true);

    simulation.routerIds.forEach((source) => {
      simulation.routerIds.forEach((destination) => {
        expect(simulation.tables()[source][destination].cost).toBe(
          simulation.shortestPath(source, destination).cost
        );
      });
    });
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('and still does after the link that carried them is cut', () => {
    const simulation = dual(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    simulation.removeLink('N2', 'N3');
    expect(simulation.runToConvergence().converged).toBe(true);

    // N2 → N3 the long way round: 3 + 4 + 2. No intermediate 7, 8 or 9 on the
    // way there, which is the next test.
    expect(simulation.tables().N2.N3).toMatchObject({ cost: 9, nextHop: 'N5' });
    expect(simulation.tables().N1.N3).toMatchObject({ cost: 10, nextHop: 'N2' });
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('FD is never more than the cost it was measured from — every round', () => {
    const simulation = dual(SAMPLE_TOPOLOGY);
    expectFeasibleDistanceHolds(simulation);

    for (let round = 0; round < 6; round += 1) {
      simulation.runIteration();
      expectFeasibleDistanceHolds(simulation);
    }
    simulation.removeLink('N2', 'N3');
    expectFeasibleDistanceHolds(simulation);
    for (let round = 0; round < 8; round += 1) {
      simulation.runIteration();
      expectFeasibleDistanceHolds(simulation);
    }
  });

  test('no cost ever climbs past the truth — the anti-counting assertion', () => {
    // The direct contrast with `DvrAlgorithm.test.js`, where the same shape of
    // failure walks a cost upward one round at a time until it hits the ceiling.
    // Here a router either knows a real answer or admits it has none; there is
    // no third state in which it holds a number it invented.
    const simulation = dual(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    simulation.removeLink('N2', 'N3');

    const infinity = simulation.infinityCost;
    const check = () =>
      everyRoute(simulation).forEach(({ from, dest, route }) => {
        if (route.cost >= infinity) return; // "I don't know" is always allowed
        expect(route.cost).toBeLessThanOrEqual(simulation.shortestPath(from, dest).cost);
      });

    check();
    for (let round = 0; round < 10; round += 1) {
      simulation.runIteration();
      check();
    }
  });

  test('equal candidates settle rather than flapping', () => {
    const simulation = dual({
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
    });
    simulation.runToConvergence();

    expect(simulation.tables().A.D).toMatchObject({ nextHop: 'B', cost: 6, fd: 6 });
    for (let round = 0; round < 5; round += 1) {
      expect(simulation.runIteration().changed).toBe(false);
      expect(simulation.tables().A.D.nextHop).toBe('B');
    }
  });

  test('split horizon is an efficiency measure, not a correctness one', () => {
    // The claim the help text makes, asserted: turning off the thing distance
    // vector depends on changes how much is said and nothing about what is
    // believed, because the condition rather than the silence rules out loops.
    const withHorizon = dual(ring(6, 2));
    const without = dual(ring(6, 2), { splitHorizon: false });
    withHorizon.runToConvergence();
    without.runToConvergence();

    expect(without.getSnapshot().tables).toEqual(withHorizon.getSnapshot().tables);
    expect(without.stats.entriesAdvertised).toBeGreaterThan(withHorizon.stats.entriesAdvertised);
  });
});

/* ------------------------------------------------------------------ *
 * The feasibility condition
 * ------------------------------------------------------------------ */

describe('the feasibility condition', () => {
  test('a neighbour reporting at or above FD is never listed as a feasible successor', () => {
    const simulation = dual(FEASIBILITY_TRAP);
    simulation.runToConvergence();

    // Router 1 reaches 4 for 2, so FD is 2. Router 5 reports 1 — feasible.
    // Router 3 reports 5 — not, although routing 1 → 3 → 4 loops no more than
    // the other two do. The condition is sufficient, not necessary.
    expect(simulation.tables()['1']['4']).toMatchObject({ cost: 2, nextHop: '2', fd: 2 });
    expect(simulation.tables()['1']['4'].feasible).toEqual(['5']);

    // And the general form of it, everywhere at once.
    everyRoute(simulation).forEach(({ from, dest, route }) => {
      route.feasible.forEach((neighborId) => {
        const reported = simulation.tables()[neighborId][dest].cost;
        expect(reported).toBeLessThan(route.fd);
        expect(neighborId).not.toBe(route.nextHop);
      });
    });
  });

  test('losing the successor with a feasible successor in hand costs nothing at all', () => {
    const simulation = dual(FEASIBILITY_TRAP);
    simulation.runToConvergence();

    simulation.removeLink('1', '2');
    // Same instant — no round has been run — and FD does not move, because the
    // backup was already proved safe at this distance.
    expect(simulation.tables()['1']['4']).toMatchObject({
      cost: 2,
      nextHop: '5',
      fd: 2,
      state: 'Passive',
    });

    // Not one query about 4 goes out. (Router 1 does query about *2*, whose
    // direct link it just lost: nobody else can report a distance below 1, so
    // that destination has no feasible successor by construction.)
    const first = simulation.runIteration();
    expect(queriesAbout(first, '4')).toEqual([]);
    expect(simulation.tables()['1']['4'].nextHop).toBe('5');
  });

  test('losing it without one sends exactly one query to each remaining neighbour', () => {
    const simulation = dual(FEASIBILITY_TRAP);
    simulation.runToConvergence();
    simulation.removeLink('1', '2');
    simulation.runToConvergence();

    simulation.removeLink('1', '5');
    // Only 3 is left, it reports 5, and FD is 2. Nothing is feasible, so router
    // 1 stops guessing: no next hop, and the destination goes ACTIVE.
    expect(simulation.tables()['1']['4']).toMatchObject({
      cost: simulation.infinityCost,
      nextHop: null,
      fd: 2,
      state: 'Active',
    });

    const first = simulation.runIteration();
    const queries = queriesAbout(first, '4');
    expect(queries.length).toBe(1);
    expect(queries[0]).toMatchObject({ from: '1', to: '3' });
  });

  test('the five-node fixture is not the instant-failover demo doc 05 §6.1 claims', () => {
    // N2 reaches N3 directly for 6, so FD is 6. Its only other neighbour, N5,
    // reaches N3 for 6 as well — and the condition is a *strict* inequality, so
    // 6 < 6 is false and N5 is not a feasible successor. Break the link and N2
    // has to run a diffusing computation for a route that was sitting there.
    const simulation = dual(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    expect(simulation.tables().N2.N3).toMatchObject({ fd: 6, feasible: [] });
    expect(simulation.tables().N5.N3.cost).toBe(6);

    simulation.removeLink('N2', 'N3');
    expect(simulation.tables().N2.N3.state).toBe('Active');
    expect(queriesAbout(simulation.runIteration(), 'N3').length).toBe(2);
    // It gets there, and to the right answer — it simply had to ask.
    simulation.runToConvergence();
    expect(simulation.tables().N2.N3).toMatchObject({ cost: 9, nextHop: 'N5', fd: 9 });
  });

  test('a destination you are plugged into can never send you ACTIVE', () => {
    // A directly attached destination reports zero, and zero is below every
    // feasible distance a router can hold for anything but itself. So the one
    // route a router can see for itself is always feasible.
    const simulation = dual(ring(5, 3));
    simulation.runToConvergence();
    simulation.setLinkCost('1', '2', 12);
    simulation.runToConvergence();

    expect(simulation.tables()['1']['2'].state).toBe('Passive');
    expect(simulation.correctness.totals.percent).toBe(100);
  });
});

/* ------------------------------------------------------------------ *
 * The diffusing computation
 * ------------------------------------------------------------------ */

describe('the diffusing computation', () => {
  test('the A–B–C break: two rounds, no counting, nothing switched on', () => {
    // The fixture the distance-vector suite uses to demonstrate counting to
    // infinity, run with every loop-avoidance option left alone.
    const simulation = dual(chain(3));
    simulation.runToConvergence();
    expect(simulation.tables()['1']['3'].cost).toBe(2);

    simulation.removeLink('2', '3');
    const seen = new Set([simulation.tables()['1']['3'].cost]);
    const { rounds, converged } = simulation.runToConvergence();
    seen.add(simulation.tables()['1']['3'].cost);

    expect(converged).toBe(true);
    expect(rounds).toBeLessThanOrEqual(3);
    // 2 and ∞ are the only two costs router 1 ever holds: no 3, no 4, no climb.
    expect([...seen].sort((a, b) => a - b)).toEqual([2, simulation.infinityCost]);
    expect(simulation.findPath('1', '3').status).toBe('unreachable');
  });

  test('queries spread outward one hop per round and the replies collapse back', () => {
    // The picture the protocol exists for. On a six-router line, breaking the
    // far link leaves nobody with an answer, so the query has to reach the end
    // of the chain before the first reply can be written.
    const simulation = dual(chain(6));
    simulation.runToConvergence();
    simulation.removeLink('5', '6');

    const wave = [];
    for (let round = 0; round < 8; round += 1) {
      const result = simulation.runIteration();
      wave.push({
        queries: queriesAbout(result, '6').map((m) => `${m.from}→${m.to}`),
        replies: messagesOf(result, 'reply')
          .filter((m) => m.label === 'RPY·6')
          .map((m) => `${m.from}→${m.to}`),
      });
    }

    expect(wave.map((step) => step.queries)).toEqual([
      ['5→4'],
      ['4→3'],
      ['3→2'],
      ['2→1'],
      [],
      [],
      [],
      [],
    ]);
    expect(wave.map((step) => step.replies)).toEqual([
      [],
      [],
      [],
      [],
      ['1→2'],
      ['2→3'],
      ['3→4'],
      ['4→5'],
    ]);

    // Out and back, and every router ends up saying the same true thing.
    simulation.routerIds
      .filter((id) => id !== '6')
      .forEach((id) => expect(simulation.tables()[id]['6'].nextHop).toBeNull());
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('all replies in ⇒ PASSIVE next round, with FD reset rather than minimised', () => {
    const simulation = dual(FEASIBILITY_TRAP);
    simulation.runToConvergence();
    simulation.removeLink('1', '2');
    simulation.runToConvergence();
    simulation.removeLink('1', '5');
    expect(simulation.tables()['1']['4']).toMatchObject({ fd: 2, state: 'Active' });

    simulation.runIteration(); // the query goes out and 3 answers it
    expect(simulation.tables()['1']['4'].state).toBe('Active');

    simulation.runIteration(); // the reply lands, and the computation collapses
    expect(simulation.tables()['1']['4']).toMatchObject({
      cost: 6,
      nextHop: '3',
      state: 'Passive',
      // The reset, and the only moment FD is ever allowed to rise. Minimising
      // here instead would leave FD at 2 and this route could never be found
      // again, however long the network waited.
      fd: 6,
    });
  });

  test('every destination is back to PASSIVE well inside the stuck-in-active limit', () => {
    const simulation = dual(ring(8, 2));
    simulation.runToConvergence();
    simulation.removeLink('4', '5');
    simulation.setRouterActive('7', false);

    let longest = 0;
    for (let round = 0; round < SIM.dual.maxActiveRounds; round += 1) {
      simulation.runIteration();
      const active = everyRoute(simulation).filter(({ route }) => route.state === 'Active');
      longest = Math.max(longest, active.length);
    }

    expect(longest).toBeGreaterThan(0); // it really did go ACTIVE
    expect(everyRoute(simulation).every(({ route }) => route.state === 'Passive')).toBe(true);
    expect(simulation.converged).toBe(true);
  });

  test('a neighbour that disappears mid-query stops being waited for', () => {
    // Doc 05 §8: without this the destination hangs until the stuck-in-active
    // timer, which is a safety net rather than a mechanism.
    const simulation = dual(chain(4));
    simulation.runToConvergence();
    simulation.removeLink('3', '4');
    simulation.runIteration(); // 3 queries 2, which queries 1
    expect(simulation.tables()['2']['4'].state).toBe('Active');

    simulation.removeRouter('1');
    // The router it was waiting on is gone, so the wait is over immediately —
    // no rounds, and no need for the timer.
    expect(simulation.tables()['2']['4'].state).toBe('Passive');
    expect(simulation.runToConvergence().converged).toBe(true);
  });

  test('stuck-in-active declares the destination unreachable instead of hanging', () => {
    // Squeeze the guard below the time the wave needs and it fires. Nothing in
    // a lossless round-based model can genuinely fail to answer, so this is the
    // only honest way to exercise it — which is itself the point: the timer is
    // a backstop, not part of the algorithm.
    const simulation = dual(chain(6), { maxActiveRounds: 1 });
    simulation.runToConvergence();
    simulation.removeLink('5', '6');

    simulation.runIteration();
    simulation.runIteration();
    expect(simulation.tables()['5']['6']).toMatchObject({
      state: 'Passive',
      nextHop: null,
      cost: simulation.infinityCost,
      fd: simulation.infinityCost,
    });
    // And the network still settles rather than churning on the stub.
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('several neighbours may query the same destination at once, and all get answers', () => {
    const simulation = dual(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    simulation.removeLink('N2', 'N3');

    // N3 loses its route to both N1 and N2 in one stroke, and asks N4 about
    // each of them separately.
    const first = simulation.runIteration();
    const asked = messagesOf(first, 'query').filter((message) => message.from === 'N3');
    expect(asked.map((message) => message.label).sort()).toEqual(['QRY·N1', 'QRY·N2']);
    expect(asked.every((message) => message.to === 'N4')).toBe(true);

    const second = simulation.runIteration();
    const answered = messagesOf(second, 'reply').filter((message) => message.to === 'N3');
    expect(answered.map((message) => message.label).sort()).toEqual(['RPY·N1', 'RPY·N2']);
  });
});

/* ------------------------------------------------------------------ *
 * Loop freedom
 * ------------------------------------------------------------------ */

describe('loop freedom', () => {
  test('no forwarding loop after any round of a randomised failure script', () => {
    // The headline. Written as a loop over rounds rather than a check at
    // convergence, because "loop-free once it settles" is what distance vector
    // already manages and it is a different, much weaker claim.
    const next = random(20260729);
    const simulation = dual(ring(7, 2), { infinityCost: SIM.maxInfinityCost });
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

    for (let step = 0; step < 80; step += 1) {
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
      expectFeasibleDistanceHolds(simulation);
    }

    // And it is still a working network at the end of all that.
    simulation.routerIds.forEach((id) => simulation.setRouterActive(id, true));
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('the loop distance vector cannot avoid, DUAL never enters', () => {
    // `pathVector.test.js` documents the transient loop the AS path can end but
    // not prevent: two routers lose their route to D in the same instant and
    // each believes the other's last advertisement. The feasibility condition
    // rules exactly that out — neither reported distance is below the other's
    // feasible distance — so both go ACTIVE instead of both guessing.
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
    const simulation = dual(stub);
    simulation.runToConvergence();

    simulation.removeLink('A', 'D');
    simulation.removeLink('B', 'D');

    expect(simulation.tables().A.D.state).toBe('Active');
    expect(simulation.tables().B.D.state).toBe('Active');
    expect(simulation.findPath('A', 'D').status).toBe('unreachable');
    expectLoopFree(simulation);

    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.tables().A.D.nextHop).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Failure handling
 * ------------------------------------------------------------------ */

describe('failure handling', () => {
  test('a partition marks the far side unreachable', () => {
    const simulation = dual({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
    });
    simulation.runToConvergence();

    simulation.removeLink('A', 'B');
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.tables().A.B).toMatchObject({
      nextHop: null,
      cost: simulation.infinityCost,
      state: 'Passive',
    });
  });

  test('a downed router is routed around, and comes back without believing a lie', () => {
    const simulation = dual(ring(6, 2));
    simulation.runToConvergence();

    simulation.setRouterActive('1', false);
    expect(simulation.runToConvergence().converged).toBe(true);
    const live = simulation.routerIds.filter((id) => simulation.isActive(id));
    live.forEach((source) =>
      live.forEach((destination) =>
        expect(simulation.tables()[source][destination].cost).toBe(
          simulation.shortestPath(source, destination).cost
        )
      )
    );
    // Invariant 12: it forgot everything while it was off.
    expect(simulation.tables()['1']['4'].cost).toBe(simulation.infinityCost);

    simulation.setRouterActive('1', true);
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('a deleted router leaves the tables entirely', () => {
    const simulation = dual(chain(3));
    simulation.runToConvergence();

    simulation.removeRouter('2');
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(Object.keys(simulation.tables()['1'])).toEqual(['1', '3']);
    expect(simulation.tables()['1']['3'].nextHop).toBeNull();
  });

  test('a new link is used as soon as it is worth using', () => {
    const simulation = dual(chain(4));
    simulation.runToConvergence();
    expect(simulation.tables()['1']['4'].cost).toBe(3);

    simulation.addLink('1', '4', 1);
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.tables()['1']['4']).toMatchObject({ cost: 1, nextHop: '4', fd: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * What the UI reads
 * ------------------------------------------------------------------ */

describe('the views the plugin exposes', () => {
  test('five columns, and the snapshot carries a detached copy of the FS list', () => {
    const simulation = dual(FEASIBILITY_TRAP);
    simulation.runToConvergence();

    const snapshot = simulation.getSnapshot();
    expect(snapshot.protocol.columns.map((column) => column.key)).toEqual([
      'cost',
      'nextHop',
      'fd',
      'feasible',
      'state',
    ]);
    expect(snapshot.tables['1']['4'].feasible).toEqual(['5']);
    // Invariant 9: React state must not alias anything the engine can rewrite.
    expect(snapshot.tables['1']['4'].feasible).not.toBe(simulation.tables()['1']['4'].feasible);
  });

  test('the metrics and the tint follow the wave', () => {
    const simulation = dual(chain(4));
    simulation.runToConvergence();
    const value = (label) => simulation.metrics().find((row) => row.label === label).value;

    expect(value('Routers recomputing')).toBe(0);
    expect(simulation.decorations()).toEqual({ links: {}, routers: {} });

    simulation.removeLink('3', '4');
    // Only 3 lights up. Router 4 is the end of the line: with nobody left to
    // ask it has no diffusing computation to run, so it goes straight to
    // "unreachable" without ever entering ACTIVE.
    expect(value('Routers recomputing')).toBe(1);
    expect(simulation.decorations().routers).toEqual({ '3': 'active' });
    expect(value('Destinations ACTIVE')).toBe(1); // 3's route to 4

    simulation.runToConvergence();
    expect(value('Routers recomputing')).toBe(0);
    expect(value('Replies outstanding')).toBe(0);
    expect(simulation.decorations().routers).toEqual({});
  });

  test('the inspector names who a router is waiting on', () => {
    const simulation = dual(chain(4));
    simulation.runToConvergence();
    simulation.removeLink('3', '4');
    simulation.runIteration(); // 3 has queried 2

    const [tab] = simulation.inspect('2');
    expect(tab).toMatchObject({ id: 'dual', label: 'DUAL' });
    const table = tab.blocks.find((block) => block.type === 'table');
    expect(table.rows).toEqual([
      expect.objectContaining({ dest: '4', awaiting: '1', owed: '3' }),
    ]);

    simulation.runToConvergence();
    const settled = simulation.inspect('2')[0];
    expect(settled.blocks.some((block) => block.type === 'table')).toBe(false);
  });

  test('the route tree is the successor tree', () => {
    const simulation = dual(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    const edges = simulation.routeTreeEdges('N1');
    expect(edges.has('N1|N2')).toBe(true);
    expect(edges.size).toBe(4);
    edges.forEach((edge) => {
      const [a, b] = edge.split('|');
      expect(simulation.hasLink(a, b)).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ *
 * The comparison the stage exists for
 * ------------------------------------------------------------------ */

describe('against distance vector, on the same failure', () => {
  test('DUAL asks a bounded question where distance vector counts', () => {
    const counting = new Simulation(chain(3), 'dvr', {
      splitHorizon: false,
      poisonedReverse: false,
    });
    counting.runToConvergence();
    counting.removeLink('2', '3');
    const dvr = counting.runToConvergence();

    const diffusing = dual(chain(3));
    diffusing.runToConvergence();
    diffusing.removeLink('2', '3');
    const eigrp = diffusing.runToConvergence();

    // Same answer in the end…
    expect(counting.tables()['1']['3'].cost).toBe(counting.infinityCost);
    expect(diffusing.tables()['1']['3'].cost).toBe(diffusing.infinityCost);
    // …but one of them walked there one round per unit of cost with every patch
    // it has for the problem switched off, while the other has no patches to
    // switch off because the condition does the work instead.
    expect(dvr.rounds).toBeGreaterThan(eigrp.rounds * 2);
    expect(counting.stats.peakWrongEntries).toBeGreaterThanOrEqual(
      diffusing.stats.peakWrongEntries
    );
  });
});
