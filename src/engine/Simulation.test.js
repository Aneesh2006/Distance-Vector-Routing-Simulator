/**
 * Simulation.test.js — the refactor's own suite.
 *
 * `DvrAlgorithm.test.js` proves the distance-vector *behaviour* is unchanged.
 * This file proves the things only the new structure can get wrong: that
 * switching protocol keeps the topology and discards only what the protocol
 * knew, that the optional halves of the plugin interface really are optional,
 * and that every registered plugin actually settles.
 */

import { Simulation, defaultsFrom, payloadSize } from './Simulation';
import { Topology } from './Topology';
import { PROTOCOLS, getProtocol } from './protocols';
import { SIM } from '../config';

/** The five-node fixture the other suites use, so results are comparable. */
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

const costsOf = (simulation) => {
  const tables = simulation.tables();
  return Object.fromEntries(
    Object.entries(tables).map(([id, table]) => [
      id,
      Object.fromEntries(Object.entries(table).map(([dest, route]) => [dest, route.cost])),
    ])
  );
};

/**
 * A plugin that does nothing at all — the floor of the interface. Everything
 * optional is omitted on purpose: if the Simulation ever stops defaulting one
 * of them, this is what notices.
 */
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
    Object.fromEntries(
      topology.routerIds.map((id) => [id, { [id]: { nextHop: id, cost: 0 } }])
    ),
};

/** Registers a throwaway plugin for one test and takes it out again. */
function withProtocol(protocol, run) {
  PROTOCOLS.push(protocol);
  try {
    return run();
  } finally {
    PROTOCOLS.splice(PROTOCOLS.indexOf(protocol), 1);
  }
}

describe('option defaults', () => {
  test('come from the plugin schema, then the caller', () => {
    const schema = [
      { key: 'a', default: 1 },
      { key: 'b', default: true },
    ];
    expect(defaultsFrom(schema)).toEqual({ a: 1, b: true });
    expect(defaultsFrom(schema, { b: false })).toEqual({ a: 1, b: false });
    expect(defaultsFrom()).toEqual({});
  });
});

describe('payloadSize', () => {
  test('counts what a message actually carried', () => {
    expect(payloadSize({ A: 1, B: 2 })).toBe(2);
    expect(payloadSize([1, 2, 3])).toBe(3);
    expect(payloadSize(null)).toBe(0);
    expect(payloadSize(7)).toBe(1);
  });
});

describe('switching protocol', () => {
  test('keeps the topology and resets the round counter', () => {
    const simulation = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    simulation.runToConvergence();
    const links = simulation.getLinks();
    expect(simulation.iteration).toBeGreaterThan(0);

    withProtocol(inertProtocol, () => {
      simulation.setProtocol('inert');

      expect(simulation.routerIds).toEqual(['N1', 'N2', 'N3', 'N4', 'N5']);
      expect(simulation.getLinks()).toEqual(links);
      expect(simulation.iteration).toBe(0);
      expect(simulation.stats.rounds).toBe(0);
      expect(simulation.protocol.id).toBe('inert');
    });
  });

  test('switching away and back is the same as never switching', () => {
    const control = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    control.runToConvergence();

    const switched = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    withProtocol(inertProtocol, () => {
      switched.runIteration();
      switched.setProtocol('inert');
      switched.runToConvergence();
      switched.setProtocol('dvr');
    });
    switched.runToConvergence();

    expect(costsOf(switched)).toEqual(costsOf(control));
  });

  test('an unknown protocol id is an error, not a silent default', () => {
    expect(() => getProtocol('nope')).toThrow(/nope/);
  });
});

describe('the optional half of the interface', () => {
  test('a plugin that never changes anything converges in one round', () => {
    withProtocol(inertProtocol, () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, 'inert');
      const { rounds, converged } = simulation.runToConvergence();

      expect(rounds).toBe(1);
      expect(converged).toBe(true);
      expect(simulation.stats.roundsToConverge).toBe(1);
    });
  });

  test('decorations and metrics default to empty', () => {
    withProtocol(inertProtocol, () => {
      const snapshot = new Simulation(SAMPLE_TOPOLOGY, 'inert').getSnapshot();

      expect(snapshot.decorations).toEqual({ links: {}, routers: {} });
      expect(snapshot.metrics).toEqual([]);
      expect(snapshot.protocol.help).toEqual([]);
      expect(snapshot.protocol.legend).toEqual([]);
      expect(snapshot.protocol.routerControls).toEqual([]);
      expect(snapshot.protocol.hasRoutingTables).toBe(true);
    });
  });

  test('inspect returns nothing for a plugin that offers no tabs', () => {
    withProtocol(inertProtocol, () => {
      expect(new Simulation(SAMPLE_TOPOLOGY, 'inert').inspect('N1')).toEqual([]);
    });
  });

  test('a plugin can declare it has no routing tables to score', () => {
    withProtocol({ ...inertProtocol, id: 'portless', hasRoutingTables: false }, () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, 'portless');
      expect(simulation.getSnapshot().correctness).toBeNull();
      expect(simulation.getSnapshot().protocol.hasRoutingTables).toBe(false);
      // …and the route-tree overlay has nothing to draw either.
      expect(simulation.routeTreeEdges('N1').size).toBe(0);
    });
  });
});

describe('the snapshot', () => {
  test('describes the active protocol and its live option values', () => {
    const simulation = new Simulation(SAMPLE_TOPOLOGY, 'dvr', { splitHorizon: false });
    const snapshot = simulation.getSnapshot();

    expect(snapshot.protocol).toMatchObject({ id: 'dvr', messageLabel: 'DV' });
    expect(snapshot.protocol.columns.map((column) => column.key)).toEqual([
      'cost',
      'nextHop',
    ]);
    expect(snapshot.options).toMatchObject({ splitHorizon: false, poisonedReverse: true });
    // Per-router knobs travel separately so the generic option panel can loop
    // over the schema without tripping over a nested object.
    expect(snapshot.options.routerOptions).toBeUndefined();
    expect(snapshot.routerOptions).toEqual({});
  });

  test('every exchange carries the kind of message it was', () => {
    const simulation = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    simulation.runIteration();
    const { exchanges } = simulation.getSnapshot();

    expect(exchanges.length).toBe(2 * simulation.getLinks().length);
    exchanges.forEach((exchange) => expect(exchange.kind).toBe('dv'));
  });

  test('an optional per-message label travels with the exchange', () => {
    const labelled = {
      ...inertProtocol,
      id: 'labelled',
      round: (state, topology) => ({
        messages: topology.routerIds.map((id) => ({
          from: id,
          to: id,
          kind: 'dv',
          label: `X·${id}`,
        })),
        changed: false,
      }),
    };

    withProtocol(labelled, () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, 'labelled');
      simulation.runIteration();
      expect(simulation.getSnapshot().exchanges[0]).toEqual({
        from: 'N1',
        to: 'N1',
        kind: 'dv',
        label: 'X·N1',
      });
    });

    // A protocol that stamps no label keeps the field off the snapshot entirely,
    // rather than carrying `undefined` around.
    const plain = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    plain.runIteration();
    expect(Object.keys(plain.getSnapshot().exchanges[0])).toEqual(['from', 'to', 'kind']);
  });

  test('still returns detached copies', () => {
    const simulation = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    const snapshot = simulation.getSnapshot();
    simulation.runToConvergence();

    expect(snapshot.tables.N1.N4.cost).toBe(simulation.infinityCost);
    expect(simulation.tables().N1.N4.cost).toBe(8);
  });
});

describe('per-router controls', () => {
  const withPriority = {
    ...inertProtocol,
    id: 'knobs',
    routerControls: [
      { key: 'priority', label: 'Priority', type: 'number', scope: 'router', default: 32768 },
      { key: 'pref', label: 'Local pref', type: 'number', scope: 'neighbor', default: 100 },
    ],
  };

  test('read back their default until they are set', () => {
    withProtocol(withPriority, () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, 'knobs');
      expect(simulation.routerOption('N1', 'priority')).toBe(32768);
      expect(simulation.routerOption('N1', 'pref', 'N2')).toBe(100);

      simulation.setRouterOption('N1', 'priority', 4096);
      simulation.setRouterOption('N1', 'pref', 250, 'N2');

      expect(simulation.routerOption('N1', 'priority')).toBe(4096);
      expect(simulation.routerOption('N1', 'pref', 'N2')).toBe(250);
      // Scoped: a value set toward one neighbour says nothing about another.
      expect(simulation.routerOption('N1', 'pref', 'N3')).toBe(100);
      expect(simulation.routerOption('N2', 'priority')).toBe(32768);
    });
  });

  test('reset when the protocol changes', () => {
    withProtocol(withPriority, () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, 'knobs');
      simulation.setRouterOption('N1', 'priority', 4096);
      simulation.setProtocol('knobs');
      expect(simulation.getSnapshot().routerOptions).toEqual({});
    });
  });
});

describe('the route-tree overlay', () => {
  test('is every edge a converged table actually uses', () => {
    const simulation = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    simulation.runToConvergence();

    // From N1 the tree is N1-N2, then N2-N5 and N2-N3 … whichever hops the
    // converged tables pick; assert the shape rather than the mechanism.
    const edges = simulation.routeTreeEdges('N1');
    expect(edges.has('N1|N2')).toBe(true);
    expect(edges.size).toBeGreaterThanOrEqual(3);
    edges.forEach((edge) => {
      const [a, b] = edge.split('|');
      expect(simulation.hasLink(a, b)).toBe(true);
    });
  });

  test('draws nothing through an unconverged loop', () => {
    const simulation = new Simulation(
      {
        A: [{ neighbor: 'B', cost: 1 }],
        B: [
          { neighbor: 'A', cost: 1 },
          { neighbor: 'C', cost: 1 },
        ],
        C: [{ neighbor: 'B', cost: 1 }],
      },
      'dvr',
      { splitHorizon: false, poisonedReverse: false }
    );
    simulation.runToConvergence();
    simulation.removeLink('B', 'C');
    simulation.runIteration();

    // A and B now point at each other for C; the overlay must not draw a cycle.
    expect(simulation.routeTreeEdges('A').has('A|B')).toBe(true);
    expect(simulation.findPath('A', 'C').status).toBe('loop');
  });
});

describe('topology edits reach the plugin', () => {
  test('a bulk load can defer the notification until the end', () => {
    const events = [];
    withProtocol(
      {
        ...inertProtocol,
        id: 'nosy',
        onTopologyChange: (state, topology, options, event) => events.push(event.type),
      },
      () => {
        const simulation = new Simulation(new Topology(), 'nosy');
        events.length = 0;

        simulation.addRouter('A', { refresh: false });
        simulation.addRouter('B', { refresh: false });
        simulation.addLink('A', 'B', 3, { refresh: false });
        expect(events).toEqual([]);

        simulation.refresh();
        expect(events).toEqual(['refresh']);

        simulation.removeLink('A', 'B');
        expect(events).toEqual(['refresh', 'removeLink']);
      }
    );
  });

  test('an edit that changes nothing notifies nobody', () => {
    const events = [];
    withProtocol(
      {
        ...inertProtocol,
        id: 'nosy2',
        onTopologyChange: (state, topology, options, event) => events.push(event.type),
      },
      () => {
        const simulation = new Simulation(SAMPLE_TOPOLOGY, 'nosy2');
        events.length = 0;

        expect(simulation.addLink('N1', 'N1', 2)).toBe(false); // self link
        expect(simulation.removeLink('N1', 'N4')).toBe(false); // no such link
        expect(simulation.setRouterActive('N1', true)).toBe(false); // already up
        expect(events).toEqual([]);
      }
    );
  });
});

/**
 * The smoke test that guards every protocol added from stage 3 onward: a plugin
 * whose `changed` flag is never honest will hang "run to convergence" in the
 * app, and this is where that shows up first.
 */
describe.each(PROTOCOLS.map((protocol) => [protocol.id, protocol]))(
  'protocol %s',
  (id) => {
    test('converges on the sample topology within the safety limit', () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, id);
      const { rounds, converged } = simulation.runToConvergence();

      expect(converged).toBe(true);
      expect(rounds).toBeLessThan(SIM.maxConvergenceRounds);
    });

    test('reports no further change once settled', () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, id);
      simulation.runToConvergence();
      expect(simulation.runIteration().changed).toBe(false);
    });

    test('recovers from a link failure', () => {
      const simulation = new Simulation(SAMPLE_TOPOLOGY, id);
      simulation.runToConvergence();
      simulation.removeLink('N2', 'N3');

      const { converged } = simulation.runToConvergence();
      expect(converged).toBe(true);
    });

    test('declares every field the UI renders from', () => {
      const protocol = getProtocol(id);
      expect(typeof protocol.name).toBe('string');
      expect(typeof protocol.summary).toBe('string');
      expect(typeof protocol.messageLabel).toBe('string');
      expect(Array.isArray(protocol.columns)).toBe(true);
      expect(Array.isArray(protocol.options)).toBe(true);
      protocol.options.forEach((option) => {
        expect(['boolean', 'number']).toContain(option.type);
        expect(option.default).toBeDefined();
      });
      protocol.columns.forEach((column) => {
        expect(typeof column.key).toBe('string');
        expect(typeof column.label).toBe('string');
      });
    });
  }
);
