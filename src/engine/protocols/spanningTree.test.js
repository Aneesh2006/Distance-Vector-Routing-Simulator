/**
 * spanningTree.test.js — the 802.1D suite.
 *
 * Assert on the *result*, not the mechanism (doc 04 §6). "Exactly one end of
 * every off-tree link blocks" is an implementation detail that could be reached
 * a dozen ways; "the links that forward form a spanning tree" is the promise
 * the protocol exists to keep, and it is checkable with a union-find and no
 * knowledge of how the roles were assigned. So most of this file goes through
 * `decorations()` and `tables()` — the same two surfaces the app draws from.
 *
 * The exception is the root id: every bridge holding the same opinion about who
 * won is not visible in any single output, so that one test reads `state.best`
 * directly and says so.
 */

import { Simulation } from '../Simulation';
import { Topology } from '../Topology';
import { compareIds } from '../helpers';
import { compareBpdu, compareBridgeId } from './spanningTree';
import { SIM } from '../../config';

const STP = SIM.spanningTree;

/**
 *   N1 --1-- N2 --6-- N3
 *             |        |
 *             3        2
 *             |        |
 *            N5 --4-- N4
 *
 * The five-node fixture the other protocol suites use, so the tree it settles
 * on can be read beside their routing tables. One link more than a tree needs,
 * so exactly one of the five blocks.
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

/** `count` bridges in a ring, ids "1".."count". */
function ring(count, cost = 1) {
  const topology = {};
  for (let index = 1; index <= count; index += 1) topology[String(index)] = [];
  const join = (a, b) => {
    topology[a].push({ neighbor: b, cost });
    topology[b].push({ neighbor: a, cost });
  };
  for (let index = 1; index < count; index += 1) join(String(index), String(index + 1));
  join('1', String(count));
  return topology;
}

const stp = (topology, overrides) => new Simulation(topology, 'stp', overrides);

const converged = (topology, overrides) => {
  const simulation = stp(topology, overrides);
  simulation.runToConvergence();
  return simulation;
};

/* ---------------- reading the result ---------------- */

const linksWith = (simulation, variant) =>
  Object.entries(simulation.decorations().links)
    .filter(([, value]) => value === variant)
    .map(([key]) => key)
    .sort();

const forwarding = (simulation) => linksWith(simulation, 'forwarding');
const blocked = (simulation) => linksWith(simulation, 'blocked');

/** The bridges wearing a crown in the scene. */
const crowns = (simulation) =>
  Object.keys(simulation.decorations().routers).sort(compareIds);

const activeIds = (simulation) => simulation.routerIds.filter((id) => simulation.isActive(id));

/** `{ neighbourId: 'Root' | 'Designated' | 'Blocked' }` for one bridge. */
const portsOf = (simulation, routerId) =>
  Object.fromEntries(
    Object.entries(simulation.tables()[routerId]).map(([port, row]) => [port, row.role])
  );

/** Cost to the root and the port toward it, both bridge-wide, off any row. */
function bridgeView(simulation, routerId) {
  const rows = Object.values(simulation.tables()[routerId]);
  return rows.length === 0 ? { cost: 0, nextHop: null } : rows[0];
}

/**
 * Union-find over a set of edges: how many components they leave, and how many
 * edges closed a cycle. A spanning tree is 1 and 0.
 */
function shapeOf(nodes, edges) {
  const parent = new Map(nodes.map((id) => [id, id]));
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    return root;
  };

  let cycles = 0;
  edges.forEach((edge) => {
    const [a, b] = edge.split('|');
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) cycles += 1;
    else parent.set(ra, rb);
  });

  return { components: new Set(nodes.map(find)).size, cycles };
}

/** The whole promise, on a connected network: V − 1 links, acyclic, connected. */
function expectSpanningTree(simulation) {
  const nodes = activeIds(simulation);
  const edges = forwarding(simulation);

  expect(edges).toHaveLength(nodes.length - 1);
  expect(shapeOf(nodes, edges)).toEqual({ components: 1, cycles: 0 });
  // …and every forwarding link is one that physically exists and is usable.
  edges.forEach((edge) => {
    const [a, b] = edge.split('|');
    expect(simulation.hasLink(a, b)).toBe(true);
    expect(simulation.isActive(a) && simulation.isActive(b)).toBe(true);
  });
}

/* ------------------------------------------------------------------ *
 * The comparison
 * ------------------------------------------------------------------ */

describe('the BPDU comparison', () => {
  const bpdu = (rootId, rootCost, senderId, priority = STP.defaultPriority) => ({
    rootId,
    rootPriority: priority,
    rootCost,
    senderId,
    senderPriority: priority,
  });

  test('is lexicographic, lowest wins, field by field', () => {
    // A better root beats any cost…
    expect(compareBpdu(bpdu('1', 99, '9'), bpdu('2', 0, '1'))).toBeLessThan(0);
    // …a lower cost to the same root beats any sender…
    expect(compareBpdu(bpdu('1', 2, '9'), bpdu('1', 3, '1'))).toBeLessThan(0);
    // …and the sender is the last word.
    expect(compareBpdu(bpdu('1', 2, '3'), bpdu('1', 2, '4'))).toBeLessThan(0);
    expect(compareBpdu(bpdu('1', 2, '3'), bpdu('1', 2, '3'))).toBe(0);
  });

  test('puts priority in front of the id, in both halves of the vector', () => {
    expect(compareBridgeId('9', 4096, '1', STP.defaultPriority)).toBeLessThan(0);
    expect(compareBridgeId('9', 32768, '1', 32768)).toBeGreaterThan(0);
    // A high-priority bridge 9 is a better root than a default-priority 1.
    expect(compareBpdu(bpdu('9', 0, '9', 4096), bpdu('1', 0, '1'))).toBeLessThan(0);
  });

  test('sorts ids numerically, so "10" is not a better root than "9"', () => {
    expect(compareBridgeId('9', 32768, '10', 32768)).toBeLessThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Election
 * ------------------------------------------------------------------ */

describe('electing a root', () => {
  test('the lowest bridge id wins when nobody has set a priority', () => {
    expect(crowns(converged(SAMPLE_TOPOLOGY))).toEqual(['N1']);
    expect(crowns(converged(ring(6)))).toEqual(['1']);
  });

  test('a lower priority wins regardless of id', () => {
    const simulation = stp(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    simulation.setRouterOption('N4', 'priority', STP.defaultPriority - STP.priorityStep);
    simulation.runToConvergence();

    expect(crowns(simulation)).toEqual(['N4']);
    expect(bridgeView(simulation, 'N4').nextHop).toBeNull();
    expectSpanningTree(simulation);
  });

  test('every bridge agrees on who won', () => {
    const simulation = converged(ring(6));
    // The one place internal state is read: "everyone holds the same opinion"
    // is not visible in any single output, which is precisely what makes it
    // worth asserting.
    const opinions = new Set(
      simulation.routerIds.map((id) => simulation.state.best.get(id).rootId)
    );
    expect([...opinions]).toEqual(['1']);
  });

  test('a bridge on its own is its own root, at no cost', () => {
    const simulation = converged({ A: [], B: [{ neighbor: 'C', cost: 1 }], C: [] });
    expect(crowns(simulation)).toEqual(['A', 'B']);
    expect(simulation.tables().A).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * Tree properties
 * ------------------------------------------------------------------ */

describe('the tree it settles on', () => {
  test.each([
    ['the five-node sample', SAMPLE_TOPOLOGY],
    ['a six-node ring', ring(6)],
    ['a ring with one dear link', {
      '1': [{ neighbor: '2', cost: 1 }, { neighbor: '5', cost: 9 }],
      '2': [{ neighbor: '1', cost: 1 }, { neighbor: '3', cost: 1 }],
      '3': [{ neighbor: '2', cost: 1 }, { neighbor: '4', cost: 1 }],
      '4': [{ neighbor: '3', cost: 1 }, { neighbor: '5', cost: 1 }],
      '5': [{ neighbor: '4', cost: 1 }, { neighbor: '1', cost: 9 }],
    }],
  ])('spans %s exactly once', (_name, topology) => {
    expectSpanningTree(converged(topology));
  });

  test('every non-root bridge has exactly one root port, and the root has none', () => {
    const simulation = converged(SAMPLE_TOPOLOGY);
    const [root] = crowns(simulation);

    simulation.routerIds.forEach((id) => {
      const roots = Object.values(portsOf(simulation, id)).filter((role) => role === 'Root');
      expect(roots).toHaveLength(id === root ? 0 : 1);
    });
  });

  test('cost to the root is the true shortest path to it', () => {
    const simulation = converged(SAMPLE_TOPOLOGY);
    const [root] = crowns(simulation);

    simulation.routerIds.forEach((id) => {
      const { cost, nextHop } = bridgeView(simulation, id);
      expect(cost).toBe(simulation.shortestPath(id, root).cost);
      // …and the port toward the root really is the first hop of such a path.
      if (id !== root) expect(simulation.hasLink(id, nextHop)).toBe(true);
    });
  });

  test('root path cost decides, not hop count', () => {
    // 5 is one hop from the root down a link costing 9, and four hops from it
    // the other way round for 4. It blocks the short, dear one.
    const simulation = converged({
      '1': [{ neighbor: '2', cost: 1 }, { neighbor: '5', cost: 9 }],
      '2': [{ neighbor: '1', cost: 1 }, { neighbor: '3', cost: 1 }],
      '3': [{ neighbor: '2', cost: 1 }, { neighbor: '4', cost: 1 }],
      '4': [{ neighbor: '3', cost: 1 }, { neighbor: '5', cost: 1 }],
      '5': [{ neighbor: '4', cost: 1 }, { neighbor: '1', cost: 9 }],
    });

    expect(blocked(simulation)).toEqual(['1|5']);
    expect(bridgeView(simulation, '5')).toMatchObject({ cost: 4, nextHop: '4' });
    expect(portsOf(simulation, '5')).toEqual({ '1': 'Blocked', '4': 'Root' });
  });

  test('a bridge that is down holds no election and forwards nothing', () => {
    const simulation = converged(ring(4));
    simulation.setRouterActive('3', false);
    simulation.runToConvergence();

    expect(Object.values(portsOf(simulation, '3'))).toEqual(['Disabled', 'Disabled']);
    expect(crowns(simulation)).toEqual(['1']);
    forwarding(simulation).forEach((edge) => expect(edge).not.toContain('3'));
    expectSpanningTree(simulation);
  });
});

/* ------------------------------------------------------------------ *
 * Failover
 * ------------------------------------------------------------------ */

describe('failover', () => {
  test('a blocked link takes over when a forwarding one breaks', () => {
    const simulation = converged(ring(4));
    const dark = blocked(simulation);
    expect(dark).toEqual(['3|4']);
    expect(forwarding(simulation)).toEqual(['1|2', '1|4', '2|3']);

    simulation.removeLink('2', '3');
    simulation.runToConvergence();

    expect(forwarding(simulation)).toEqual(['1|2', '1|4', '3|4']);
    expectSpanningTree(simulation);
  });

  test('the root dying triggers a real election', () => {
    const simulation = converged(ring(4));
    simulation.setRouterActive('1', false);
    const { converged: settled } = simulation.runToConvergence();

    expect(settled).toBe(true);
    expect(crowns(simulation)).toEqual(['2']);
    expectSpanningTree(simulation);
  });

  test('max age is what ends the count after a root dies', () => {
    // Without the age field the survivors would quote the dead root's vector to
    // each other for ever, each adding a link cost. With it, recovery takes
    // about as long as the age allows — so a shorter age recovers sooner, and
    // that difference is the mechanism made visible.
    const recover = (maxAgeRounds) => {
      const simulation = converged(ring(4), { maxAgeRounds });
      simulation.setRouterActive('1', false);
      return simulation.runToConvergence().rounds;
    };

    const quick = recover(3);
    const slow = recover(12);
    expect(quick).toBeLessThan(slow);
    expect(slow).toBeLessThan(SIM.maxConvergenceRounds);
  });

  test('a partition elects one root per component', () => {
    const simulation = converged(ring(4));
    simulation.removeLink('1', '4');
    simulation.removeLink('2', '3');
    simulation.runToConvergence();

    expect(crowns(simulation)).toEqual(['1', '3']);
    expect(forwarding(simulation)).toEqual(['1|2', '3|4']);
    expect(bridgeView(simulation, '4')).toMatchObject({ nextHop: '3' });
  });

  test('a healed partition settles back on one tree', () => {
    const simulation = converged(ring(4));
    simulation.removeLink('1', '4');
    simulation.removeLink('2', '3');
    simulation.runToConvergence();
    simulation.addLink('2', '3', 1);
    simulation.runToConvergence();

    expect(crowns(simulation)).toEqual(['1']);
    expectSpanningTree(simulation);
  });
});

/* ------------------------------------------------------------------ *
 * Stability
 * ------------------------------------------------------------------ */

describe('stability', () => {
  test('a settled network reports no further change', () => {
    const simulation = converged(SAMPLE_TOPOLOGY);
    expect(simulation.runIteration().changed).toBe(false);
    expect(simulation.runIteration().changed).toBe(false);
  });

  test('every bridge still sends every round — silence is not convergence', () => {
    const simulation = converged(SAMPLE_TOPOLOGY);
    const { exchanges } = simulation.runIteration();

    expect(exchanges).toHaveLength(2 * simulation.getLinks().length);
    exchanges.forEach((exchange) => expect(exchange.kind).toBe('bpdu'));
  });

  test('the tree does not depend on the order the network was built in', () => {
    const build = (order) => {
      const simulation = new Simulation(new Topology(), 'stp');
      ['1', '2', '3', '4', '5'].forEach((id) => simulation.addRouter(id, { refresh: false }));
      order.forEach(([a, b, cost]) => simulation.addLink(a, b, cost, { refresh: false }));
      simulation.refresh();
      simulation.runToConvergence();
      return simulation;
    };

    const wiring = [
      ['1', '2', 1],
      ['2', '3', 6],
      ['2', '5', 3],
      ['3', '4', 2],
      ['4', '5', 4],
      ['1', '5', 5],
    ];
    const forwards = build(wiring);
    const backwards = build([...wiring].reverse());

    expect(forwarding(backwards)).toEqual(forwarding(forwards));
    expect(crowns(backwards)).toEqual(crowns(forwards));
  });

  test('changing a priority back and forth returns the same tree', () => {
    const simulation = converged(SAMPLE_TOPOLOGY);
    const before = forwarding(simulation);

    simulation.setRouterOption('N4', 'priority', 4096);
    simulation.runToConvergence();
    expect(forwarding(simulation)).not.toEqual(before);

    simulation.setRouterOption('N4', 'priority', STP.defaultPriority);
    simulation.runToConvergence();
    expect(forwarding(simulation)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * What the app reads
 * ------------------------------------------------------------------ */

describe('what the app reads', () => {
  test('there is nothing to score, so nothing pretends there is', () => {
    const simulation = converged(SAMPLE_TOPOLOGY);
    const snapshot = simulation.getSnapshot();

    expect(snapshot.protocol.hasRoutingTables).toBe(false);
    expect(snapshot.correctness).toBeNull();
    expect(snapshot.protocol.rowLabel).toBe('Port');
    expect(simulation.routeTreeEdges('N1').size).toBe(0);
  });

  test('the path finder says so rather than walking a table of ports', () => {
    const walked = converged(SAMPLE_TOPOLOGY).findPath('N1', 'N4');
    expect(walked.status).toBe('unsupported');
    expect(walked.path).toEqual([]);
  });

  test('metrics name the root and count the dark links', () => {
    const simulation = converged(SAMPLE_TOPOLOGY);
    expect(simulation.metrics()).toEqual([
      { label: 'Root bridge', value: 'N1' },
      { label: 'Links forwarding', value: 4 },
      { label: 'Links blocked', value: 1 },
    ]);
  });

  test('metrics report both roots while the network is cut in two', () => {
    const simulation = converged(ring(4));
    simulation.removeLink('1', '4');
    simulation.removeLink('2', '3');
    simulation.runToConvergence();

    expect(simulation.metrics()[0]).toEqual({ label: 'Root bridges', value: '1, 3' });
  });
});
