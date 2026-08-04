import { Network } from '../DvrAlgorithm';
import {
  allPairsShortestPaths,
  classifyTables,
  pairKey,
  truthCost,
  truthPath,
} from './groundTruth';

/** The same five-node fixture the DVR suite uses, so results are comparable. */
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

/** Link cost lookup straight from the topology, for verifying reconstructed walks. */
function linkCosts(network) {
  const costs = new Map();
  network.getLinks().forEach(({ source, destination, cost }) => {
    costs.set(pairKey(source, destination), cost);
    costs.set(pairKey(destination, source), cost);
  });
  return costs;
}

/**
 * A plain single-source Dijkstra, kept here as an independent second opinion.
 *
 * `Network.shortestPath()` is now a lookup into the very matrix under test, so
 * comparing against it would be circular. This is the algorithm it used to run.
 */
function dijkstra(network, sourceId) {
  const distance = new Map();
  const unvisited = new Set();
  network.routerIds.forEach((id) => {
    if (!network.isActive(id)) return;
    distance.set(id, Infinity);
    unvisited.add(id);
  });
  if (!distance.has(sourceId)) return distance;
  distance.set(sourceId, 0);

  while (unvisited.size > 0) {
    let current = null;
    unvisited.forEach((id) => {
      if (current === null || distance.get(id) < distance.get(current)) current = id;
    });
    if (current === null || distance.get(current) === Infinity) break;
    unvisited.delete(current);
    network.routers[current].links.forEach((linkCost, neighborId) => {
      if (!unvisited.has(neighborId)) return;
      const candidate = distance.get(current) + linkCost;
      if (candidate < distance.get(neighborId)) distance.set(neighborId, candidate);
    });
  }
  return distance;
}

describe('allPairsShortestPaths', () => {
  test('agrees with Dijkstra on every pair of the sample topology', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const truth = allPairsShortestPaths(network);

    network.routerIds.forEach((source) => {
      const reference = dijkstra(network, source);
      network.routerIds.forEach((destination) => {
        expect(truthCost(truth, source, destination)).toBe(reference.get(destination));
      });
    });
  });

  test('is symmetric and zero on the diagonal', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const truth = allPairsShortestPaths(network);

    truth.ids.forEach((a) => {
      expect(truthCost(truth, a, a)).toBe(0);
      expect(truthPath(truth, a, a)).toEqual([a]);
      truth.ids.forEach((b) => {
        expect(truthCost(truth, a, b)).toBe(truthCost(truth, b, a));
      });
    });
  });

  test('prefers the cheap detour over an expensive direct link', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const truth = allPairsShortestPaths(network);

    // N2 -> N3 is a direct 6, but N2 -> N5 -> N4 -> N3 costs 3 + 4 + 2 = 9,
    // so here the direct link really is best...
    expect(truthCost(truth, 'N2', 'N3')).toBe(6);
    // ...while N1 -> N4 must go the long way round: 1 + 3 + 4.
    expect(truthCost(truth, 'N1', 'N4')).toBe(8);
    expect(truthPath(truth, 'N1', 'N4')).toEqual(['N1', 'N2', 'N5', 'N4']);
  });

  test('disconnected components are Infinity, not a wrong number', () => {
    const network = new Network({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
      C: [{ neighbor: 'D', cost: 1 }],
      D: [{ neighbor: 'C', cost: 1 }],
    });
    const truth = allPairsShortestPaths(network);

    expect(truthCost(truth, 'A', 'B')).toBe(1);
    expect(truthCost(truth, 'A', 'C')).toBe(Infinity);
    expect(truthCost(truth, 'D', 'A')).toBe(Infinity);
    expect(truthPath(truth, 'A', 'C')).toEqual([]);
  });

  test('inactive routers are excluded, and paths through them do not count', () => {
    // A -1- B -1- C with an expensive A -5- C bypass: taking B down must push
    // the true A->C cost up to 5 rather than leaving it at 2.
    const network = new Network({
      A: [
        { neighbor: 'B', cost: 1 },
        { neighbor: 'C', cost: 5 },
      ],
      B: [
        { neighbor: 'A', cost: 1 },
        { neighbor: 'C', cost: 1 },
      ],
      C: [
        { neighbor: 'A', cost: 5 },
        { neighbor: 'B', cost: 1 },
      ],
    });
    expect(truthCost(allPairsShortestPaths(network), 'A', 'C')).toBe(2);

    network.setRouterActive('B', false);
    const truth = allPairsShortestPaths(network);

    expect(truth.ids).toEqual(['A', 'C']);
    expect(truthCost(truth, 'A', 'C')).toBe(5);
    expect(truthCost(truth, 'A', 'B')).toBe(Infinity);
    expect(truthPath(truth, 'A', 'C')).toEqual(['A', 'C']);
  });

  test('via reconstructs a real walk whose link costs sum to dist', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const truth = allPairsShortestPaths(network);
    const costs = linkCosts(network);

    truth.ids.forEach((source) => {
      truth.ids.forEach((destination) => {
        const path = truthPath(truth, source, destination);
        expect(path[0]).toBe(source);
        expect(path[path.length - 1]).toBe(destination);

        let walked = 0;
        for (let hop = 0; hop < path.length - 1; hop += 1) {
          const step = costs.get(pairKey(path[hop], path[hop + 1]));
          expect(step).toBeDefined(); // every hop is a real link
          walked += step;
        }
        expect(walked).toBe(truthCost(truth, source, destination));
      });
    });
  });

  test('a single router has only the self-pair', () => {
    const network = new Network({ A: [] });
    const truth = allPairsShortestPaths(network);

    expect(truth.ids).toEqual(['A']);
    expect(truth.dist.size).toBe(1);
    expect(truthCost(truth, 'A', 'A')).toBe(0);
    expect(truth.via.size).toBe(0);
  });

  test('an empty topology is handled', () => {
    const truth = allPairsShortestPaths(new Network());
    expect(truth.ids).toEqual([]);
    expect(truth.dist.size).toBe(0);
    expect(truthCost(truth, 'A', 'B')).toBe(Infinity);
    expect(truthPath(truth, 'A', 'B')).toEqual([]);
  });
});

describe('the cached ground truth on Network', () => {
  test('is computed once and reused until something changes', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const first = network.groundTruth;
    expect(network.groundTruth).toBe(first); // same object — no recomputation
    network.runToConvergence();
    expect(network.groundTruth).toBe(first); // rounds do not move the topology
  });

  test('every kind of edit invalidates it', () => {
    // A stale matrix would quietly mis-report the correctness overlay for the
    // rest of the session, so each mutator is checked by hand.
    const edits = [
      ['addRouter', (n) => n.addRouter('N9')],
      ['removeRouter', (n) => n.removeRouter('N3')],
      ['addLink', (n) => n.addLink('N1', 'N4', 2)],
      ['setLinkCost', (n) => n.setLinkCost('N2', 'N3', 2)],
      ['removeLink', (n) => n.removeLink('N2', 'N3')],
      ['setRouterActive', (n) => n.setRouterActive('N3', false)],
      ['setOptions re-clamping costs', (n) => n.setOptions({ infinityCost: 5 })],
    ];

    edits.forEach(([label, edit]) => {
      const network = new Network(SAMPLE_TOPOLOGY);
      const before = network.groundTruth;
      edit(network);
      expect(`${label}: ${network.groundTruth === before}`).toBe(`${label}: false`);
    });
  });

  test('shortestPath reflects an edit immediately', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    expect(network.shortestPath('N1', 'N4')).toEqual({
      path: ['N1', 'N2', 'N5', 'N4'],
      cost: 8,
    });

    network.setLinkCost('N2', 'N3', 1);
    expect(network.shortestPath('N1', 'N4')).toEqual({
      path: ['N1', 'N2', 'N3', 'N4'],
      cost: 4,
    });

    network.removeRouter('N2');
    expect(network.shortestPath('N1', 'N4')).toEqual({ path: [], cost: network.infinityCost });
  });

  test('a real path above the infinity ceiling reads as unreachable', () => {
    // The ceiling is the protocol's arithmetic, not the topology's: a genuine
    // 12-cost path simply cannot be expressed when infinity is 8.
    const network = new Network(
      {
        A: [{ neighbor: 'B', cost: 6 }],
        B: [
          { neighbor: 'A', cost: 6 },
          { neighbor: 'C', cost: 6 },
        ],
        C: [{ neighbor: 'B', cost: 6 }],
      },
      { infinityCost: 20 }
    );
    expect(network.shortestPath('A', 'C').cost).toBe(12);

    network.setOptions({ infinityCost: 8 });
    // Costs re-clamp to 7 apiece, so the true path is 14 — still over the ceiling.
    expect(network.shortestPath('A', 'C')).toEqual({ path: [], cost: 8 });
  });
});

/* ------------------------------------------------------------------ *
 * Correctness overlay
 * ------------------------------------------------------------------ */

/** Score a live network exactly the way the engine does each round. */
const scoreOf = (network) =>
  classifyTables(network.getSnapshot().tables, network.groundTruth, {
    infinityCost: network.infinityCost,
  });

describe('classifyTables', () => {
  test('a fresh network knows only itself and its direct links', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const score = scoreOf(network);

    // 5 self entries + 10 directed direct links, all of which happen to be
    // the true shortest path here; the other 10 are simply not known yet.
    expect(score.totals).toMatchObject({ entries: 25, correct: 15, wrong: 10, percent: 60 });
    expect(score.totals.byClass).toEqual({
      optimal: 15,
      suboptimal: 0,
      'stale-unreachable': 10,
      phantom: 0,
      looping: 0,
    });

    expect(score.entries.N1.N1).toBe('optimal'); // self
    expect(score.entries.N1.N2).toBe('optimal'); // direct link
    expect(score.entries.N1.N4).toBe('stale-unreachable'); // a path exists, N1 has not heard
  });

  test('a converged network is 100% correct', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();
    const score = scoreOf(network);

    expect(score.totals).toMatchObject({ entries: 25, correct: 25, wrong: 0, percent: 100 });
    expect(score.totals.byClass.optimal).toBe(25);
    expect(score.loops).toBe(0);
    network.routerIds.forEach((id) => {
      expect(score.routers[id]).toMatchObject({ total: 5, correct: 5 });
    });
  });

  test('a correctly-unreachable entry counts as correct', () => {
    // Being right that there is no path is not a failure to find one.
    const network = new Network({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
    });
    network.runToConvergence();
    network.removeLink('A', 'B');
    network.runToConvergence();

    const score = scoreOf(network);
    expect(score.entries.A.B).toBe('optimal');
    expect(score.totals).toMatchObject({ entries: 4, correct: 4, percent: 100 });
  });

  test('an entry that has not caught up with a cost rise is suboptimal', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();
    expect(network.routers.N1.routingTable.N5.cost).toBe(4);

    // N2 -> N5 jumps from 3 to 9. N2 sees it at once; N1 is still repeating
    // the old number it was told last round.
    network.setLinkCost('N2', 'N5', 9);
    const score = scoreOf(network);

    expect(network.shortestPath('N1', 'N5').cost).toBe(10);
    expect(network.routers.N1.routingTable.N5.cost).toBe(4);
    expect(score.entries.N1.N5).toBe('suboptimal');
    expect(score.totals.byClass.suboptimal).toBeGreaterThan(0);
  });

  test('count-to-infinity shows up as looping entries, not as noise', () => {
    // This is the whole point of the `loops` counter: the pathology distance
    // vector suffers and link state cannot.
    const network = new Network(
      {
        A: [{ neighbor: 'B', cost: 1 }],
        B: [
          { neighbor: 'A', cost: 1 },
          { neighbor: 'C', cost: 1 },
        ],
        C: [{ neighbor: 'B', cost: 1 }],
      },
      { splitHorizon: false, poisonedReverse: false }
    );
    network.runToConvergence();

    network.removeLink('B', 'C');
    network.runIteration();
    const midCount = scoreOf(network);

    // A and B now point at each other for C while its cost climbs.
    expect(midCount.entries.A.C).toBe('looping');
    expect(midCount.entries.B.C).toBe('looping');
    expect(midCount.loops).toBeGreaterThan(0);

    // ...and once the ceiling is reached the lie is gone.
    network.runToConvergence();
    const settled = scoreOf(network);
    expect(settled.loops).toBe(0);
    expect(settled.entries.A.C).toBe('optimal'); // correctly unreachable
  });

  test('split horizon with poisoned reverse keeps the loop count at zero', () => {
    const network = new Network(
      {
        A: [{ neighbor: 'B', cost: 1 }],
        B: [
          { neighbor: 'A', cost: 1 },
          { neighbor: 'C', cost: 1 },
        ],
        C: [{ neighbor: 'B', cost: 1 }],
      },
      { splitHorizon: true, poisonedReverse: true }
    );
    network.runToConvergence();
    network.removeLink('B', 'C');

    let loops = 0;
    for (let round = 0; round < 6; round += 1) {
      network.runIteration();
      loops += scoreOf(network).loops;
    }
    expect(loops).toBe(0);
  });

  test('a hand-built stale table is a phantom route', () => {
    const network = new Network({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
    });
    network.removeLink('A', 'B');

    // A still believes in a link that is gone: a black hole, not a long way round.
    const tables = {
      A: { A: { nextHop: 'A', cost: 0 }, B: { nextHop: 'B', cost: 1 } },
      B: { A: { nextHop: null, cost: 16 }, B: { nextHop: 'B', cost: 0 } },
    };
    const score = classifyTables(tables, network.groundTruth, { infinityCost: 16 });

    expect(score.entries.A.B).toBe('phantom');
    expect(score.entries.B.A).toBe('optimal'); // correctly gave up
    expect(score.totals.byClass.phantom).toBe(1);
  });

  test('a two-router next-hop cycle is a loop', () => {
    const network = new Network({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [
        { neighbor: 'A', cost: 1 },
        { neighbor: 'C', cost: 1 },
      ],
      C: [{ neighbor: 'B', cost: 1 }],
    });

    // C is genuinely reachable from both, but A and B point at each other.
    const tables = {
      A: {
        A: { nextHop: 'A', cost: 0 },
        B: { nextHop: 'B', cost: 1 },
        C: { nextHop: 'B', cost: 2 },
      },
      B: {
        A: { nextHop: 'A', cost: 1 },
        B: { nextHop: 'B', cost: 0 },
        C: { nextHop: 'A', cost: 3 },
      },
      C: {
        A: { nextHop: 'B', cost: 2 },
        B: { nextHop: 'B', cost: 1 },
        C: { nextHop: 'C', cost: 0 },
      },
    };
    const score = classifyTables(tables, network.groundTruth, { infinityCost: 16 });

    expect(score.entries.B.C).toBe('looping');
    expect(score.entries.A.C).toBe('looping'); // A walks into the same cycle
    expect(score.loops).toBe(2);
    expect(score.routers.C).toMatchObject({ total: 3, correct: 3 });
  });

  test('a router that dies stops being scored, as source and as destination', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();
    expect(scoreOf(network).totals.entries).toBe(25);

    network.setRouterActive('N3', false);
    network.runToConvergence();
    const score = scoreOf(network);

    // Four live routers: its own beliefs about a network it left are not
    // something the user can act on, and neither is anyone's view of it.
    expect(score.totals).toMatchObject({ entries: 16, correct: 16, percent: 100 });
    expect(score.entries.N3).toBeUndefined();
    expect(score.entries.N1.N3).toBeUndefined();
  });

  test('missing rows are treated as "does not know", never skipped', () => {
    // Keeps the meter denominator a predictable active², whatever a future
    // protocol chooses to put in its tables.
    const network = new Network({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
    });
    const score = classifyTables({ A: {}, B: {} }, network.groundTruth, { infinityCost: 16 });

    expect(score.totals.entries).toBe(4);
    expect(score.entries.A.A).toBe('stale-unreachable');
    expect(score.entries.A.B).toBe('stale-unreachable');
  });

  test('percent never rounds up to a flattering 100', () => {
    const ids = Array.from({ length: 16 }, (_, index) => `R${index}`);
    const topology = {};
    ids.forEach((id, index) => {
      topology[id] = index === 0 ? [] : [{ neighbor: ids[0], cost: 1 }];
    });
    const network = new Network(topology);
    network.runToConvergence();

    const tables = network.getSnapshot().tables;
    tables.R1.R2 = { nextHop: null, cost: 16 }; // 1 wrong entry out of 256
    const score = classifyTables(tables, network.groundTruth, { infinityCost: 16 });

    expect(score.totals.correct).toBe(255);
    expect(score.totals.percent).toBe(99);
  });
});
