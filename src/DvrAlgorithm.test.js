import { Network, cloneTable, compareIds, tablesEqual } from './DvrAlgorithm';
import { SIM } from './config';

/**
 * The five-node example that used to be hard-coded inside `DVR Algo.js`.
 * Kept here as a fixture so the expected distances stay verifiable.
 *
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

const costsFrom = (network, id) =>
  Object.fromEntries(
    Object.entries(network.routers[id].routingTable).map(([dest, route]) => [dest, route.cost])
  );

describe('initial state', () => {
  test('iteration 0 knows only itself and its direct neighbours', () => {
    const network = new Network(SAMPLE_TOPOLOGY);

    expect(network.iteration).toBe(0);
    expect(costsFrom(network, 'N1')).toEqual({
      N1: 0,
      N2: 1,
      N3: network.infinityCost,
      N4: network.infinityCost,
      N5: network.infinityCost,
    });
  });

  test('every router lists every destination', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.routerIds.forEach((id) => {
      expect(Object.keys(network.routers[id].routingTable).sort()).toEqual([
        'N1',
        'N2',
        'N3',
        'N4',
        'N5',
      ]);
    });
  });
});

describe('convergence', () => {
  test('converges to the true shortest paths', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const { converged } = network.runToConvergence();

    expect(converged).toBe(true);
    expect(costsFrom(network, 'N1')).toEqual({ N1: 0, N2: 1, N3: 7, N4: 8, N5: 4 });
    expect(costsFrom(network, 'N3')).toEqual({ N1: 7, N2: 6, N3: 0, N4: 2, N5: 6 });
    expect(costsFrom(network, 'N4')).toEqual({ N1: 8, N2: 7, N3: 2, N4: 0, N5: 4 });
  });

  test('every converged cost matches Dijkstra on the same topology', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();

    network.routerIds.forEach((source) => {
      network.routerIds.forEach((destination) => {
        const optimal = network.shortestPath(source, destination);
        expect(network.routers[source].routingTable[destination].cost).toBe(optimal.cost);
      });
    });
  });

  test('a settled network reports no further change', () => {
    // Regression: the old engine rewrote entries with identical values and
    // flagged them as changes, so convergence was never detected.
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();

    expect(network.runIteration().changed).toBe(false);
    expect(network.converged).toBe(true);
  });

  test('a round is synchronous — no router sees this round\'s updates', () => {
    // N1 is three hops from N4, so it cannot learn the route in one round
    // regardless of the order routers are processed in.
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runIteration();
    expect(network.routers.N1.routingTable.N4.cost).toBe(network.infinityCost);
    network.runIteration();
    expect(network.routers.N1.routingTable.N4.cost).toBeLessThan(network.infinityCost);
  });
});

describe('link failure', () => {
  test('removing a link still reaches a stable state', () => {
    // Regression: link failure used to leave hasChanges permanently true.
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();

    network.removeLink('N2', 'N3');
    const { converged } = network.runToConvergence();

    expect(converged).toBe(true);
    // N2 must now reach N3 the long way round: N2 -> N5 -> N4 -> N3.
    expect(network.routers.N2.routingTable.N3.cost).toBe(9);
    expect(network.findPath('N2', 'N3').path).toEqual(['N2', 'N5', 'N4', 'N3']);
  });

  test('a partition marks the far side unreachable', () => {
    const network = new Network({
      A: [{ neighbor: 'B', cost: 1 }],
      B: [{ neighbor: 'A', cost: 1 }],
    });
    network.runToConvergence();

    network.removeLink('A', 'B');
    const { converged } = network.runToConvergence();

    expect(converged).toBe(true);
    expect(network.routers.A.routingTable.B.cost).toBe(network.infinityCost);
    expect(network.routers.A.routingTable.B.nextHop).toBeNull();
    expect(network.findPath('A', 'B').status).toBe('unreachable');
  });
});

describe('count to infinity', () => {
  const linear = () => ({
    A: [{ neighbor: 'B', cost: 1 }],
    B: [
      { neighbor: 'A', cost: 1 },
      { neighbor: 'C', cost: 1 },
    ],
    C: [{ neighbor: 'B', cost: 1 }],
  });

  test('without split horizon the count terminates at the infinity ceiling', () => {
    const network = new Network(linear(), { splitHorizon: false, poisonedReverse: false });
    network.runToConvergence();
    expect(network.routers.A.routingTable.C.cost).toBe(2);

    network.removeLink('B', 'C');
    const { converged, rounds } = network.runToConvergence();

    expect(converged).toBe(true);
    // It really did count upwards rather than failing immediately...
    expect(rounds).toBeGreaterThan(3);
    // ...and it stopped at the ceiling instead of looping forever.
    expect(network.routers.A.routingTable.C.cost).toBe(network.infinityCost);
    expect(network.routers.B.routingTable.C.cost).toBe(network.infinityCost);
  });

  test('split horizon with poisoned reverse kills the count immediately', () => {
    const network = new Network(linear(), { splitHorizon: true, poisonedReverse: true });
    network.runToConvergence();

    network.removeLink('B', 'C');
    const { converged, rounds } = network.runToConvergence();

    expect(converged).toBe(true);
    expect(rounds).toBeLessThan(4);
    expect(network.routers.A.routingTable.C.cost).toBe(network.infinityCost);
  });

  test('the infinity ceiling is configurable', () => {
    const network = new Network(linear(), {
      splitHorizon: false,
      poisonedReverse: false,
      infinityCost: 8,
    });
    network.runToConvergence();
    network.removeLink('B', 'C');
    network.runToConvergence();

    expect(network.routers.A.routingTable.C.cost).toBe(8);
  });
});

describe('router failure', () => {
  test('a downed router is routed around', () => {
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
    network.runToConvergence();
    expect(network.routers.A.routingTable.C.cost).toBe(2);

    network.setRouterActive('B', false);
    network.runToConvergence();

    expect(network.routers.A.routingTable.C.cost).toBe(5);
    expect(network.routers.A.routingTable.B.cost).toBe(network.infinityCost);

    network.setRouterActive('B', true);
    network.runToConvergence();
    expect(network.routers.A.routingTable.C.cost).toBe(2);
  });
});

describe('topology edits preserve simulation state', () => {
  test('adding a link keeps the iteration counter and learned routes', () => {
    // Regression: the UI used to rebuild the Network on every edit, which
    // silently reset both the iteration counter and every routing table.
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();
    const iterationBefore = network.iteration;

    network.addRouter('N6');
    network.addLink('N6', 'N1', 2);

    expect(network.iteration).toBe(iterationBefore);
    expect(network.routers.N1.routingTable.N5.cost).toBe(4); // still known
    expect(network.routers.N1.routingTable.N6.cost).toBe(2); // learned instantly
    expect(network.routers.N3.routingTable.N6.cost).toBe(network.infinityCost);

    network.runToConvergence();
    expect(network.routers.N3.routingTable.N6.cost).toBe(9);
  });

  test('removing a router drops it from every table', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();

    network.removeRouter('N2');
    network.runToConvergence();

    expect(network.routerIds).toEqual(['N1', 'N3', 'N4', 'N5']);
    Object.values(network.routers).forEach((router) => {
      expect(router.routingTable.N2).toBeUndefined();
      expect(router.neighbors).not.toContain('N2');
    });
    // N1 is now isolated.
    expect(network.routers.N1.routingTable.N3.cost).toBe(network.infinityCost);
  });

  test('link costs are clamped into the usable range', () => {
    const network = new Network(SAMPLE_TOPOLOGY, { infinityCost: 10 });
    network.addLink('N1', 'N3', 999);
    expect(network.routers.N1.linkCostTo('N3')).toBe(9);

    network.addLink('N1', 'N4', -4);
    expect(network.routers.N1.linkCostTo('N4')).toBe(1);

    network.addLink('N1', 'N5', Number.NaN);
    expect(network.routers.N1.linkCostTo('N5')).toBe(1);
  });

  test('lowering the infinity ceiling re-clamps existing links', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    expect(network.routers.N2.linkCostTo('N3')).toBe(6);
    network.setOptions({ infinityCost: 5 });
    expect(network.routers.N2.linkCostTo('N3')).toBe(4);
  });
});

describe('findPath', () => {
  test('does not advance the simulation', () => {
    // Regression: findPath used to call runUntilConvergence internally.
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runIteration();
    const iteration = network.iteration;
    const before = cloneTable(network.routers.N1.routingTable);

    network.findPath('N1', 'N4');

    expect(network.iteration).toBe(iteration);
    expect(tablesEqual(network.routers.N1.routingTable, before)).toBe(true);
  });

  test('reports the walked path and its real cost', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();

    const result = network.findPath('N1', 'N4');
    expect(result.status).toBe('ok');
    expect(result.path).toEqual(['N1', 'N2', 'N5', 'N4']);
    expect(result.cost).toBe(8);
    expect(result.cost).toBe(result.tableCost);
  });

  test('handles unknown and identical endpoints', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    expect(network.findPath('N1', 'nope').status).toBe('missing');
    expect(network.findPath('N1', 'N1')).toMatchObject({ status: 'ok', cost: 0 });
  });

  test('reports unreachable before the tables have converged', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    expect(network.findPath('N1', 'N4').status).toBe('unreachable');
  });
});

describe('stats', () => {
  const linear = () => ({
    A: [{ neighbor: 'B', cost: 1 }],
    B: [
      { neighbor: 'A', cost: 1 },
      { neighbor: 'C', cost: 1 },
    ],
    C: [{ neighbor: 'B', cost: 1 }],
  });

  test('one round sends one advertisement each way along every link', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    expect(network.stats.rounds).toBe(0);
    expect(network.stats.messages).toBe(0);

    network.runIteration();

    const links = network.getLinks().length;
    expect(links).toBe(5);
    expect(network.stats.messages).toBe(2 * links);
    expect(network.stats.messagesByKind).toEqual({ dv: 2 * links });
    // Every advertisement lists all five destinations: with poisoned reverse
    // on, a suppressed route is sent as infinity rather than omitted.
    expect(network.stats.entriesAdvertised).toBe(2 * links * 5);
    expect(network.stats.rounds).toBe(1);
  });

  test('counters accumulate across rounds and survive a topology edit', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();
    const messages = network.stats.messages;
    expect(messages).toBeGreaterThan(0);

    network.removeLink('N2', 'N3');
    // The work already done did not un-happen.
    expect(network.stats.messages).toBe(messages);
    network.runIteration();
    expect(network.stats.messages).toBeGreaterThan(messages);
  });

  test('roundsToConverge resets on an edit and is set exactly once', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    expect(network.stats.roundsToConverge).toBeNull();

    const first = network.runToConvergence();
    expect(network.stats.roundsToConverge).toBe(first.rounds);

    // Idle rounds after convergence must not inflate the figure.
    network.runIteration();
    network.runIteration();
    expect(network.stats.roundsToConverge).toBe(first.rounds);
    expect(network.stats.roundsSinceTopologyChange).toBe(first.rounds + 2);

    network.removeLink('N2', 'N3');
    expect(network.stats.roundsToConverge).toBeNull();
    expect(network.stats.roundsSinceTopologyChange).toBe(0);

    const second = network.runToConvergence();
    expect(network.stats.roundsToConverge).toBe(second.rounds);
  });

  test('an option change starts a new episode too', () => {
    // Rounds-to-converge measured under the old settings describes nothing.
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();
    expect(network.stats.roundsToConverge).not.toBeNull();

    network.setOptions({ splitHorizon: false });
    expect(network.stats.roundsToConverge).toBeNull();
    expect(network.stats.roundsSinceTopologyChange).toBe(0);
  });

  test('correctness is sampled on the edit and after every round', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    // One sample from loading the topology: 15 of 25 entries already right.
    expect(network.stats.correctnessHistory).toEqual([60]);

    network.runToConvergence();
    const history = network.stats.correctnessHistory;
    expect(history[history.length - 1]).toBe(100);
    expect(history.length).toBe(network.stats.rounds + 1);
    // It only ever climbs while nothing is breaking.
    history.forEach((value, index) => {
      if (index > 0) expect(value).toBeGreaterThanOrEqual(history[index - 1]);
    });

    network.removeLink('N2', 'N3');
    // The dip is the first sample of the new episode, before any round runs.
    expect(network.stats.correctnessHistory.length).toBe(1);
    expect(network.stats.correctnessHistory[0]).toBeLessThan(100);
  });

  test('the history is capped so the sparkline stays legible', () => {
    const network = new Network(linear(), {
      splitHorizon: false,
      poisonedReverse: false,
      infinityCost: SIM.maxInfinityCost,
    });
    network.runToConvergence();
    network.removeLink('B', 'C');
    const { rounds } = network.runToConvergence();

    expect(rounds).toBeGreaterThan(SIM.metrics.historyLength);
    expect(network.stats.correctnessHistory.length).toBe(SIM.metrics.historyLength);
  });

  test('peak wrong entries and loops seen describe the current episode', () => {
    const network = new Network(linear(), { splitHorizon: false, poisonedReverse: false });
    network.runToConvergence();
    // Converged from scratch: the peak was the ignorance it started with.
    expect(network.stats.peakWrongEntries).toBeGreaterThan(0);
    expect(network.stats.loopsSeen).toBe(0);

    network.removeLink('B', 'C');
    expect(network.stats.peakWrongEntries).toBe(network.correctness.totals.wrong);

    network.runToConvergence();
    // A and B pointed at each other for C while the count climbed.
    expect(network.stats.loopsSeen).toBeGreaterThan(0);
  });

  test('split horizon keeps loopsSeen at zero on the same failure', () => {
    const network = new Network(linear(), { splitHorizon: true, poisonedReverse: true });
    network.runToConvergence();
    network.removeLink('B', 'C');
    network.runToConvergence();

    expect(network.stats.loopsSeen).toBe(0);
  });

  test('the snapshot carries stats and correctness, detached', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const snapshot = network.getSnapshot();

    expect(snapshot.stats).toMatchObject({ rounds: 0, messages: 0 });
    expect(snapshot.correctness.totals).toMatchObject({ entries: 25, correct: 15 });
    expect(snapshot.correctness.entries.N1.N4).toBe('stale-unreachable');
    expect(snapshot.correctness.routers.N1).toMatchObject({ total: 5, correct: 2 });

    network.runToConvergence();

    // The old snapshot still describes the moment it was taken.
    expect(snapshot.stats.rounds).toBe(0);
    expect(snapshot.stats.correctnessHistory).toEqual([60]);
    expect(snapshot.correctness.totals.correct).toBe(15);
    expect(network.getSnapshot().correctness.totals.correct).toBe(25);
  });

  test('converged and correct are different questions', () => {
    // The badge can say CONVERGED while a quarter of the network is lying;
    // this is the distinction the whole scoreboard exists to make visible.
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

    const snapshot = network.getSnapshot();
    expect(snapshot.converged).toBe(false);
    expect(snapshot.correctness.totals.percent).toBeLessThan(100);
    expect(snapshot.correctness.totals.byClass.looping).toBeGreaterThan(0);
  });

  test('reset clears the counters as well as the tables', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    network.runToConvergence();
    expect(network.stats.messages).toBeGreaterThan(0);

    network.reset();

    expect(network.stats).toMatchObject({
      rounds: 0,
      messages: 0,
      messagesByKind: {},
      entriesAdvertised: 0,
      roundsSinceTopologyChange: 0,
      roundsToConverge: null,
    });
    expect(network.stats.correctnessHistory).toEqual([60]);
  });
});

describe('helpers', () => {
  test('compareIds sorts numerically when it can', () => {
    expect(['10', '2', '1', '20'].sort(compareIds)).toEqual(['1', '2', '10', '20']);
    expect(['N10', 'N2'].sort(compareIds)).toEqual(['N10', 'N2']);
  });

  test('cloneTable is lossless for non-finite costs', () => {
    // Regression: JSON.parse(JSON.stringify(...)) turned Infinity into null,
    // which is why unreachable rows used to render blank instead of "∞".
    const table = { A: { nextHop: null, cost: Number.POSITIVE_INFINITY } };
    expect(cloneTable(table).A.cost).toBe(Number.POSITIVE_INFINITY);
    expect(JSON.parse(JSON.stringify(table)).A.cost).toBeNull();
  });

  test('getSnapshot returns detached copies', () => {
    const network = new Network(SAMPLE_TOPOLOGY);
    const snapshot = network.getSnapshot();
    network.runToConvergence();
    expect(snapshot.tables.N1.N4.cost).toBe(network.infinityCost);
    expect(network.routers.N1.routingTable.N4.cost).toBe(8);
  });
});
