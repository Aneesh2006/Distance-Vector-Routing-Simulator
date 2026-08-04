/**
 * linkState.test.js — the link-state suite.
 *
 * Structured like `DvrAlgorithm.test.js` and using the same five-node fixture,
 * so the two protocols can be read side by side. Where a result is the *point*
 * of link state rather than merely true of it — convergence bounded by the
 * diameter, no inflated intermediate costs, no count to infinity — the test
 * says so, and the distance-vector comparison at the bottom of this file
 * demonstrates it directly rather than by assertion.
 *
 * A few tests reach into `simulation.state`. Databases are what this protocol
 * *is*, and "every router ends up holding the same map" cannot be observed from
 * the routing tables alone.
 */

import { Simulation } from '../Simulation';
import { compareIds } from '../helpers';
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

/** `count` routers in a line, ids "1".."count". Diameter is `count - 1`. */
function chain(count, cost = 1) {
  const topology = {};
  for (let index = 1; index <= count; index += 1) topology[String(index)] = [];
  for (let index = 1; index < count; index += 1) {
    topology[String(index)].push({ neighbor: String(index + 1), cost });
    topology[String(index + 1)].push({ neighbor: String(index), cost });
  }
  return topology;
}

/** The same, closed into a ring. Diameter is `floor(count / 2)`. */
function ring(count, cost = 1) {
  const topology = chain(count, cost);
  topology['1'].push({ neighbor: String(count), cost });
  topology[String(count)].push({ neighbor: '1', cost });
  return topology;
}

const ls = (topology, overrides) => new Simulation(topology, 'ls', overrides);

const database = (simulation, routerId) => simulation.state.lsdb.get(routerId);

/** A database as `origin:seq,origin:seq` — the thing every router must agree on. */
const signature = (simulation, routerId) =>
  [...database(simulation, routerId).values()]
    .sort((a, b) => compareIds(a.origin, b.origin))
    .map((lsa) => `${lsa.origin}:${lsa.seq}`)
    .join(',');

const costsFrom = (simulation, routerId) =>
  Object.fromEntries(
    Object.entries(simulation.tables()[routerId]).map(([dest, route]) => [dest, route.cost])
  );

/**
 * One round taken straight off the plugin.
 *
 * `Simulation` deliberately drops message payloads from the snapshot, and the
 * flooding rules are statements about payloads. Protocol state advances exactly
 * as `runIteration()` would advance it; only the round counter is left behind.
 */
const floodRound = (simulation) =>
  simulation.protocol.round(simulation.state, simulation.topology, simulation.options).messages;

/** Forge an LSA into a router's database and queue it for flooding. */
function plant(simulation, routerId, lsa) {
  database(simulation, routerId).set(lsa.origin, lsa);
  simulation.state.pending.get(routerId).set(lsa.origin, null);
}

/* ------------------------------------------------------------------ *
 * Correctness
 * ------------------------------------------------------------------ */

describe('correctness', () => {
  test('nothing is known before anything has been flooded', () => {
    // Unlike distance vector, a link-state router does not even know its
    // neighbours until it has heard from them: an adjacency it alone claims is
    // one-way, and SPF skips it.
    const simulation = ls(SAMPLE_TOPOLOGY);
    expect(costsFrom(simulation, 'N1')).toEqual({
      N1: 0,
      N2: simulation.infinityCost,
      N3: simulation.infinityCost,
      N4: simulation.infinityCost,
      N5: simulation.infinityCost,
    });
  });

  test('every converged cost matches the true shortest path', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
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

  test('next hops lead somewhere: every path walks to its destination', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    simulation.routerIds.forEach((source) => {
      simulation.routerIds.forEach((destination) => {
        const walked = simulation.findPath(source, destination);
        expect(walked.status).toBe('ok');
        // The next hop is inherited from the parent in SPF; if that were
        // recomputed instead, costs would still be right and traffic would
        // still go the wrong way. This is what catches that.
        expect(walked.cost).toBe(simulation.shortestPath(source, destination).cost);
      });
    });
  });

  test('every router lists every destination', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    simulation.routerIds.forEach((id) => {
      expect(Object.keys(simulation.tables()[id]).sort()).toEqual([
        'N1',
        'N2',
        'N3',
        'N4',
        'N5',
      ]);
    });
  });

  test('every database ends up holding the same (origin, seq) set', () => {
    // The defining property of link state: agreement on the map is the only
    // distributed part of the algorithm.
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    const reference = signature(simulation, 'N1');
    expect(reference.split(',')).toHaveLength(5);
    simulation.routerIds.forEach((id) => expect(signature(simulation, id)).toBe(reference));
  });

  test('equal-cost paths pick one hop and keep it', () => {
    // Both ways round the diamond cost 6. Without an incumbent-sticky tie-break
    // the table would flap every round and convergence would never be detected.
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
    const simulation = ls(diamond);
    simulation.runToConvergence();

    expect(simulation.tables().A.D.cost).toBe(6);
    const chosen = simulation.tables().A.D.nextHop;
    expect(['B', 'C']).toContain(chosen);
    for (let round = 0; round < 5; round += 1) {
      expect(simulation.runIteration().changed).toBe(false);
      expect(simulation.tables().A.D.nextHop).toBe(chosen);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Flooding
 * ------------------------------------------------------------------ */

describe('flooding', () => {
  test('an LSA with an older or equal sequence number is discarded', () => {
    const simulation = ls(chain(3));
    simulation.runToConvergence();
    const genuine = database(simulation, '3').get('1');

    // Older: router 2 floods a doctored copy of 1's LSA to router 3.
    plant(simulation, '2', { origin: '1', seq: genuine.seq - 1, age: 0, links: { 3: 1 } });
    floodRound(simulation);
    expect(database(simulation, '3').get('1').seq).toBe(genuine.seq);
    expect(database(simulation, '3').get('1').links).toEqual(genuine.links);

    // Equal is not newer either — "strictly greater" is the whole rule.
    plant(simulation, '2', { origin: '1', seq: genuine.seq, age: 0, links: { 3: 1 } });
    floodRound(simulation);
    expect(database(simulation, '3').get('1').links).toEqual(genuine.links);

    // …and one sequence number higher is accepted, so the test above is not
    // passing because the plumbing is broken.
    plant(simulation, '2', { origin: '1', seq: genuine.seq + 1, age: 0, links: { 3: 1 } });
    floodRound(simulation);
    expect(database(simulation, '3').get('1').seq).toBe(genuine.seq + 1);
    expect(database(simulation, '3').get('1').links).toEqual({ 3: 1 });
  });

  test("one router's LSA reaches a router d hops away in exactly d rounds", () => {
    const simulation = ls(chain(6));
    const holders = () => simulation.routerIds.filter((id) => database(simulation, id).has('1'));

    expect(holders()).toEqual(['1']);
    for (let distance = 1; distance <= 5; distance += 1) {
      simulation.runIteration();
      // Exactly the routers within `distance` hops, no more and no fewer.
      expect(holders()).toEqual(
        Array.from({ length: distance + 1 }, (unused, index) => String(index + 1))
      );
    }
  });

  test('a router never floods an LSA back out of the interface it arrived on', () => {
    const simulation = ls(ring(6));

    for (let round = 0; round < 8; round += 1) {
      // Where each queued LSA came from, captured before the round consumes it.
      const arrivedFrom = new Map(
        [...simulation.state.pending].map(([id, queue]) => [id, new Map(queue)])
      );

      floodRound(simulation).forEach(({ from, to, payload }) => {
        payload.forEach((lsa) => {
          expect(arrivedFrom.get(from).get(lsa.origin)).not.toBe(to);
          // Nor back to the router that wrote it: the origin holds the
          // authoritative copy by definition.
          expect(lsa.origin).not.toBe(to);
        });
      });
    }
  });

  test('flooding stops: a settled network sends nothing until something changes', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    expect(simulation.runIteration().exchanges).toEqual([]);
  });

  test('every message says which LSAs it carries', () => {
    const simulation = ls(chain(3));
    const messages = floodRound(simulation);
    // The caption is what turns a stream of identical spheres in the scene into
    // a wavefront spreading out from one router.
    expect(messages.every((message) => message.kind === 'lsa')).toBe(true);
    expect(messages.find((message) => message.from === '1').label).toBe('LSA·1');
  });
});

/* ------------------------------------------------------------------ *
 * Convergence bound
 * ------------------------------------------------------------------ */

describe('convergence is bounded by the diameter, not by the costs', () => {
  test('a six-node ring converges within diameter + 2 rounds', () => {
    const { rounds, converged } = ls(ring(6)).runToConvergence();
    expect(converged).toBe(true);
    expect(rounds).toBeLessThanOrEqual(3 + 2);
  });

  test('multiplying every link cost by ten changes nothing about the round count', () => {
    // The ceiling is raised only so the larger costs still fit; under link
    // state it is a display sentinel and nothing counts up to it. The distance
    // vector equivalent of this test fails: with split horizon off, the number
    // of rounds it needs to climb to the ceiling after a failure depends
    // entirely on how large the link costs are (see the comparison below).
    const cheap = ls(ring(6, 1), { infinityCost: 99 });
    const dear = ls(ring(6, 10), { infinityCost: 99 });

    expect(dear.runToConvergence().rounds).toBe(cheap.runToConvergence().rounds);

    cheap.removeLink('1', '2');
    dear.removeLink('1', '2');
    expect(dear.runToConvergence().rounds).toBe(cheap.runToConvergence().rounds);

    expect(dear.tables()['1']['2'].cost).toBe(cheap.tables()['1']['2'].cost * 10);
  });
});

/* ------------------------------------------------------------------ *
 * Failure handling
 * ------------------------------------------------------------------ */

describe('link failure', () => {
  test('the new cost appears directly, never through an inflated one', () => {
    // The anti-count-to-infinity assertion. N1 reaches N3 for 7 via N2; once
    // N2 ↔ N3 breaks the only answer is 10 the long way round, and 7 and 10 are
    // the only two costs N1 is ever allowed to hold.
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    expect(simulation.tables().N1.N3.cost).toBe(7);

    simulation.removeLink('N2', 'N3');
    const seen = new Set([simulation.tables().N1.N3.cost]);
    for (let round = 0; round < 10; round += 1) {
      simulation.runIteration();
      seen.add(simulation.tables().N1.N3.cost);
    }

    expect([...seen].sort((a, b) => a - b)).toEqual([7, 10]);
    expect(simulation.tables().N1.N3.cost).toBe(10);
    expect(simulation.findPath('N1', 'N3').path).toEqual(['N1', 'N2', 'N5', 'N4', 'N3']);
  });

  test('the A–B–C break converges within diameter + 2 with no options touched', () => {
    // The fixture the distance-vector suite uses to demonstrate counting to
    // infinity, run with every setting left alone.
    const simulation = ls(chain(3));
    simulation.runToConvergence();
    simulation.removeLink('2', '3');

    const { rounds, converged } = simulation.runToConvergence();
    expect(converged).toBe(true);
    expect(rounds).toBeLessThanOrEqual(2 + 2);
    expect(simulation.tables()['1']['3']).toEqual({
      nextHop: null,
      cost: simulation.infinityCost,
    });
  });

  test('a partition marks the far side unreachable', () => {
    const simulation = ls({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
    });
    simulation.runToConvergence();

    simulation.removeLink('A', 'B');
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.tables().A.B).toEqual({ nextHop: null, cost: simulation.infinityCost });
    expect(simulation.findPath('A', 'B').status).toBe('unreachable');
  });

  test('a re-costed link is re-advertised by both endpoints', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    simulation.setLinkCost('N2', 'N3', 15);
    simulation.runToConvergence();

    expect(database(simulation, 'N1').get('N2').links.N3).toBe(15);
    expect(database(simulation, 'N1').get('N3').links.N2).toBe(15);
    expect(simulation.tables().N1.N3.cost).toBe(10); // N1 → N2 → N5 → N4 → N3
  });
});

describe('router failure', () => {
  test('a dead router is routed around within deadRounds + diameter', () => {
    // A six-node ring minus one router is a five-node chain: diameter 4.
    const simulation = ls(ring(6));
    simulation.runToConvergence();
    simulation.setRouterActive('1', false);

    // Nobody has noticed yet — hellos are how a *router* dying is detected, and
    // none have been missed.
    expect(simulation.tables()['4']['1'].cost).toBeLessThan(simulation.infinityCost);

    const budget = simulation.options.deadRounds + 4;
    for (let round = 0; round < budget; round += 1) simulation.runIteration();

    simulation.routerIds
      .filter((id) => simulation.isActive(id))
      .forEach((source) => {
        simulation.routerIds
          .filter((id) => simulation.isActive(id))
          .forEach((destination) => {
            expect(simulation.tables()[source][destination].cost).toBe(
              simulation.shortestPath(source, destination).cost
            );
          });
        expect(simulation.tables()[source]['1'].cost).toBe(simulation.infinityCost);
      });
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('the bidirectional check is what stops a dead router black-holing', () => {
    // §16.1 in one experiment. 2 is down; 1 and 3 write it off after
    // deadRounds, but 2's own LSA still claims both links. With the check on,
    // an adjacency only one end advertises is skipped and routing is correct.
    const settings = { lsaRefreshRounds: 6, lsaMaxAgeRounds: 12 };
    const checked = ls(chain(3), settings);
    checked.runToConvergence();
    checked.setRouterActive('2', false);
    for (let round = 0; round < checked.options.deadRounds + 2; round += 1) {
      checked.runIteration();
    }
    expect(checked.tables()['1']['3'].nextHop).toBeNull();

    // With it off the database is read as an undirected graph, so 2's own stale
    // claims are believed and 1 keeps routing through a router that is not
    // there — for as long as that LSA survives.
    const naive = ls(chain(3), { ...settings, requireBidirectional: false });
    naive.runToConvergence();
    naive.setRouterActive('2', false);
    for (let round = 0; round < naive.options.deadRounds + 2; round += 1) naive.runIteration();

    expect(naive.tables()['1']['3'].nextHop).toBe('2');
    expect(naive.tables()['1']['3'].cost).toBe(2);
    expect(naive.correctness.totals.byClass.phantom).toBeGreaterThan(0);

    // …and it only clears when the stale LSA finally ages out.
    let rounds = 0;
    while (naive.tables()['1']['3'].nextHop !== null && rounds <= settings.lsaMaxAgeRounds) {
      naive.runIteration();
      rounds += 1;
    }
    expect(naive.tables()['1']['3'].nextHop).toBeNull();
    expect(rounds).toBeGreaterThan(0);
  });

  test('a revived router relearns the map instead of trusting its old one', () => {
    const simulation = ls(ring(6));
    simulation.runToConvergence();
    const before = database(simulation, '1').get('1').seq;

    simulation.setRouterActive('1', false);
    simulation.runToConvergence();
    simulation.setRouterActive('1', true);

    // §5.6: a higher sequence number, or everyone still holding the old LSA
    // would reject the new one; and an empty database, because the network
    // moved on while it was off.
    expect(database(simulation, '1').get('1').seq).toBeGreaterThan(before);
    expect(database(simulation, '1').size).toBe(1);

    simulation.runToConvergence();
    expect(signature(simulation, '1')).toBe(signature(simulation, '4'));
    simulation.routerIds.forEach((destination) => {
      expect(simulation.tables()['1'][destination].cost).toBe(
        simulation.shortestPath('1', destination).cost
      );
    });
  });

  test('a router wired in later is given the map that already exists', () => {
    // Without a database exchange on a new adjacency a router joining a settled
    // network would only ever hear about future changes.
    const simulation = ls(chain(4));
    simulation.runToConvergence();

    simulation.addRouter('9');
    simulation.addLink('9', '2', 1);
    expect(simulation.runToConvergence().converged).toBe(true);

    expect(signature(simulation, '9')).toBe(signature(simulation, '4'));
    expect(simulation.tables()['9']['4'].cost).toBe(3); // 9 → 2 → 3 → 4
  });

  test('a deleted router leaves the tables, and its LSA ages out behind it', () => {
    const simulation = ls(chain(3), { lsaRefreshRounds: 5, lsaMaxAgeRounds: 10 });
    simulation.runToConvergence();

    simulation.removeRouter('2');
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(Object.keys(simulation.tables()['1'])).toEqual(['1', '3']);
    expect(simulation.tables()['1']['3'].nextHop).toBeNull();

    for (let round = 0; round < 12; round += 1) simulation.runIteration();
    expect(database(simulation, '1').has('2')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Timers
 * ------------------------------------------------------------------ */

describe('timers', () => {
  test('an LSA nobody refreshes is deleted at exactly lsaMaxAgeRounds', () => {
    const settings = { lsaRefreshRounds: 8, lsaMaxAgeRounds: 16 };
    const simulation = ls(chain(3), settings);
    simulation.runToConvergence();

    // Taking 2 down stops it refreshing, and isolates 1 and 3 so nothing else
    // can put a fresh copy back.
    simulation.setRouterActive('2', false);
    const remaining = settings.lsaMaxAgeRounds - database(simulation, '1').get('2').age;

    for (let round = 1; round < remaining; round += 1) {
      simulation.runIteration();
      expect(database(simulation, '1').has('2')).toBe(true);
    }
    simulation.runIteration();
    expect(database(simulation, '1').has('2')).toBe(false);
  });

  test('a router re-originates at the refresh interval, seq up and age reset', () => {
    const settings = { lsaRefreshRounds: 9, lsaMaxAgeRounds: 18 };
    const simulation = ls(SAMPLE_TOPOLOGY, settings);
    simulation.runToConvergence();

    const before = database(simulation, 'N1').get('N1');
    expect(before.age).toBeLessThan(settings.lsaRefreshRounds);
    // Nothing about the topology changes; only the clock runs.
    for (let age = before.age; age < settings.lsaRefreshRounds; age += 1) {
      simulation.runIteration();
    }

    const after = database(simulation, 'N1').get('N1');
    expect(after.seq).toBe(before.seq + 1);
    expect(after.age).toBe(0);
    expect(after.links).toEqual(before.links);
  });

  test('a refresh is not silence: the network reports work while it re-floods', () => {
    // The refresh interval has to be longer than the network takes to flood, or
    // the next refresh starts before the last one has finished and the network
    // never goes quiet — which is why the real LSRefreshTime is half an hour.
    const settings = { lsaRefreshRounds: 8, lsaMaxAgeRounds: 16 };
    const simulation = ls(chain(4), settings);
    simulation.runToConvergence();
    expect(simulation.converged).toBe(true);

    // Claiming "converged" while LSAs are still travelling would be a lie, so a
    // database change counts as a change even when no table moves.
    let woke = false;
    for (let round = 0; round < settings.lsaRefreshRounds + 2; round += 1) {
      if (simulation.runIteration().changed) woke = true;
    }
    expect(woke).toBe(true);

    simulation.routerIds.forEach((destination) => {
      expect(simulation.tables()['1'][destination].cost).toBe(
        simulation.shortestPath('1', destination).cost
      );
    });
  });

  test('two edits inside the minimum interval produce one LSA, not two', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    const before = database(simulation, 'N2').get('N2').seq;

    simulation.setLinkCost('N1', 'N2', 4);
    simulation.setLinkCost('N1', 'N2', 5);

    const damped = database(simulation, 'N2').get('N2');
    expect(damped.seq).toBe(before + 1);
    expect(damped.links.N1).toBe(4); // only the first edit made it out…

    simulation.runIteration();
    const caughtUp = database(simulation, 'N2').get('N2');
    expect(caughtUp.seq).toBe(before + 2);
    expect(caughtUp.links.N1).toBe(5); // …and the second is not lost, only late
  });

  test('flooding the whole database every round is wasteful, not wrong', () => {
    const chatty = ls(SAMPLE_TOPOLOGY, { floodWholeDatabase: true });
    expect(chatty.runToConvergence().converged).toBe(true);

    chatty.routerIds.forEach((source) => {
      chatty.routerIds.forEach((destination) => {
        expect(chatty.tables()[source][destination].cost).toBe(
          chatty.shortestPath(source, destination).cost
        );
      });
    });

    const thrifty = ls(SAMPLE_TOPOLOGY);
    thrifty.runToConvergence();
    expect(chatty.stats.entriesAdvertised).toBeGreaterThan(thrifty.stats.entriesAdvertised);
  });
});

/* ------------------------------------------------------------------ *
 * What the UI reads
 * ------------------------------------------------------------------ */

describe('the views the plugin exposes', () => {
  test('the sync meter counts databases that agree, and the tint follows it', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    const sync = () => simulation.metrics().find((row) => row.label === 'LSDB in sync').value;

    // Before anything is flooded every router holds only its own LSA, so no two
    // agree; the meter says so rather than flattering the protocol.
    expect(sync()).toBe('1 / 5');
    expect(Object.keys(simulation.decorations().routers)).toHaveLength(4);

    simulation.runToConvergence();
    expect(sync()).toBe('5 / 5');
    expect(simulation.decorations()).toEqual({ links: {}, routers: {} });
  });

  test('the LSDB tab lists one row per LSA held', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    const [tab] = simulation.inspect('N2');
    expect(tab.id).toBe('lsdb');
    const table = tab.blocks.find((block) => block.type === 'table');
    expect(table.rows.map((row) => row.origin)).toEqual(['N1', 'N2', 'N3', 'N4', 'N5']);
    expect(table.rows.find((row) => row.origin === 'N2').links).toBe(3);

    const rows = tab.blocks.find((block) => block.type === 'rows').rows;
    expect(rows.find((row) => row.label === 'Advertising').value).toBe('N1@1, N3@6, N5@3');

    // Ages tick every round, which is the point of showing them.
    const before = table.rows.find((row) => row.origin === 'N1').age;
    simulation.runIteration();
    const after = simulation
      .inspect('N2')[0]
      .blocks.find((block) => block.type === 'table')
      .rows.find((row) => row.origin === 'N1').age;
    expect(after).toBe(before + 1);
  });

  test('the route tree overlay is the SPF tree', () => {
    const simulation = ls(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    const edges = simulation.routeTreeEdges('N1');
    // Four destinations, so a tree of four edges, every one a real link.
    expect(edges.size).toBe(4);
    edges.forEach((edge) => {
      const [a, b] = edge.split('|');
      expect(simulation.hasLink(a, b)).toBe(true);
    });
    expect(edges.has('N1|N2')).toBe(true);
    expect(edges.has('N2|N3')).toBe(true);
    // N1 reaches N4 via N5 (cost 8), not via N3 (cost 9) — so that link is on
    // nobody's tree from here even though both its endpoints are.
    expect(edges.has('N3|N4')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The comparison the whole stage exists for
 * ------------------------------------------------------------------ */

describe('against distance vector, on the same failure', () => {
  const linear = () => chain(3);

  test('link state does not count, and distance vector does', () => {
    const counting = new Simulation(linear(), 'dvr', {
      splitHorizon: false,
      poisonedReverse: false,
    });
    counting.runToConvergence();
    counting.removeLink('2', '3');
    const dvr = counting.runToConvergence();

    const flooding = ls(linear());
    flooding.runToConvergence();
    flooding.removeLink('2', '3');
    const link = flooding.runToConvergence();

    // Both end up with the same answer…
    expect(counting.tables()['1']['3'].cost).toBe(counting.infinityCost);
    expect(flooding.tables()['1']['3'].cost).toBe(flooding.infinityCost);
    // …but one of them walked there one round per unit of cost.
    expect(dvr.rounds).toBeGreaterThan(link.rounds * 2);
    expect(counting.stats.peakWrongEntries).toBeGreaterThan(flooding.stats.peakWrongEntries);
  });

  test('and the number of rounds it takes to count depends on the link costs', () => {
    // The test link state passes in `convergence is bounded by the diameter`.
    const count = (cost) => {
      const simulation = new Simulation(chain(3, cost), 'dvr', {
        splitHorizon: false,
        poisonedReverse: false,
        infinityCost: SIM.maxInfinityCost,
      });
      simulation.runToConvergence();
      simulation.removeLink('2', '3');
      return simulation.runToConvergence().rounds;
    };

    expect(count(1)).toBeGreaterThan(count(10));
  });
});
