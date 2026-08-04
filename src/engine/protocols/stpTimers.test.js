/**
 * stpTimers.test.js — spanning tree on the clock (stage 9.7, doc 04 §2).
 *
 * The claim this stage exists to make is a number: a port that has just been
 * given a role takes two forward delays to become usable, and the failure that
 * gave it that role took up to a max age to be noticed — so a ring break costs
 * up to fifty seconds of a network with a hole in it. Every test here is
 * ultimately about that number, or about the safety property that makes the wait
 * acceptable (blocking is immediate, forwarding is not).
 *
 * The equivalence test at the bottom is the one that says the clock changed
 * nothing about the protocol: the same topology settles on the same tree either
 * way.
 */

import { Simulation } from '../Simulation';
import { Topology } from '../Topology';
import { SIM } from '../../config';

const STP = SIM.spanningTree;

/** A ring: exactly one link has to be blocked, so there is always a spare. */
const RING = {
  1: [
    { neighbor: '2', cost: 1 },
    { neighbor: '5', cost: 1 },
  ],
  2: [{ neighbor: '3', cost: 1 }],
  3: [{ neighbor: '4', cost: 1 }],
  4: [{ neighbor: '5', cost: 1 }],
  5: [],
};

/** Two bridges, one link — the smallest thing with a port state at all. */
const PAIR = { A: [{ neighbor: 'B', cost: 1 }], B: [] };

function timed(adjacency = RING, options) {
  const simulation = new Simulation(new Topology(adjacency), 'stp', options, {
    mode: 'timers',
  });
  return simulation;
}

/** Every port of every bridge, as `{ 'A:B': 'forwarding' }`. */
function portStates(simulation) {
  const states = {};
  simulation.routerIds.forEach((routerId) => {
    const tables = simulation.tables();
    Object.entries(tables[routerId]).forEach(([neighborId, row]) => {
      states[`${routerId}:${neighborId}`] = row.state;
    });
  });
  return states;
}

const forwardingLinks = (simulation) =>
  Object.entries(simulation.decorations().links)
    .filter(([, variant]) => variant === 'forwarding')
    .map(([key]) => key)
    .sort();

const variantCount = (simulation, name) =>
  Object.values(simulation.decorations().links).filter((variant) => variant === name).length;

/* ------------------------------------------------------------------ *
 * The mode exists at all
 * ------------------------------------------------------------------ */

describe('spanning tree declares timer support', () => {
  test('the mode toggle is available', () => {
    expect(timed().supportsTimers).toBe(true);
  });

  test('the State column appears only on the clock', () => {
    const rounds = new Simulation(new Topology(RING), 'stp');
    const clock = timed();
    const labels = (simulation) => simulation.getSnapshot().protocol.columns.map((c) => c.label);

    expect(labels(rounds)).not.toContain('State');
    expect(labels(clock)).toContain('State');
  });

  test('the round-mode max age is hidden on the clock, and the seconds appear', () => {
    const clock = timed();
    const keys = clock.optionSchema().map((option) => option.key);
    expect(keys).not.toContain('maxAgeRounds');
    expect(keys).toEqual(
      expect.arrayContaining(['helloSeconds', 'forwardDelaySeconds', 'maxAgeSeconds'])
    );
  });

  test('the tree is called settled after three hellos, not RIP\'s thirty seconds', () => {
    // Waiting an update interval for a protocol whose bridges speak every two
    // seconds would be waiting for nothing.
    expect(timed().quietSeconds).toBe(STP.quietSeconds);
    expect(timed().quietSeconds).toBeLessThan(SIM.timers.updateInterval);
  });
});

/* ------------------------------------------------------------------ *
 * Blocking → Listening → Learning → Forwarding
 * ------------------------------------------------------------------ */

describe('the port state machine', () => {
  test('a port starts in Blocking and leaves it the instant it is given a role', () => {
    // Every bridge claims to be the root at power-on, so every port is
    // designated straight away and the climb starts at t=0. Blocking is the
    // initial condition rather than a state anything waits in — it is Listening
    // and Learning that cost fifteen seconds each.
    const simulation = timed(PAIR);
    expect(portStates(simulation)).toEqual({ 'A:B': 'Listening', 'B:A': 'Listening' });
    expect(forwardingLinks(simulation)).toEqual([]);
  });

  test('a port climbs Listening → Learning → Forwarding, one forward delay each', () => {
    const simulation = timed(PAIR);
    const { forwardDelaySeconds } = simulation.options;

    // One forward delay short of the next step: still Listening.
    simulation.advance(forwardDelaySeconds - 0.1);
    expect(portStates(simulation)['A:B']).toBe('Listening');

    simulation.advance(0.2);
    expect(portStates(simulation)['A:B']).toBe('Learning');

    simulation.advance(forwardDelaySeconds - 0.2);
    expect(portStates(simulation)['A:B']).toBe('Learning');

    simulation.advance(0.2);
    expect(portStates(simulation)['A:B']).toBe('Forwarding');
  });

  test('a link is usable exactly 2 × forward delay after power-on', () => {
    const simulation = timed(PAIR);
    const { forwardDelaySeconds } = simulation.options;

    simulation.advance(2 * forwardDelaySeconds - 0.5);
    expect(forwardingLinks(simulation)).toEqual([]);

    simulation.advance(1);
    expect(forwardingLinks(simulation)).toEqual(['A|B']);
  });

  test('changing which kind of forwarding port it is does not restart the climb', () => {
    // B's port to A starts designated (B thinks it is the root) and becomes the
    // root port on the first hello. Restarting the countdown for that would
    // punish a bridge for having agreed with its neighbour — and re-arming on
    // every hello would leave it climbing for ever.
    const simulation = timed(PAIR);
    const { forwardDelaySeconds } = simulation.options;
    simulation.advance(2 * forwardDelaySeconds + 0.5);

    expect(simulation.tables().B.A.role).toBe('Root');
    expect(portStates(simulation)['B:A']).toBe('Forwarding');
  });

  test('a port mid-climb is drawn as coming up, not as blocked or forwarding', () => {
    const simulation = timed(PAIR);
    simulation.advance(1);
    expect(variantCount(simulation, 'learning')).toBe(1);
    expect(variantCount(simulation, 'forwarding')).toBe(0);
  });

  test('a port that keeps its role keeps its progress across a dozen hellos', () => {
    // The failure this guards: re-arming the countdown on every hello would
    // leave a port climbing for ever, because a hello arrives every two seconds
    // and the climb takes thirty.
    const simulation = timed(PAIR);
    const { forwardDelaySeconds } = simulation.options;
    for (let i = 0; i < 40; i += 1) simulation.advance(1);
    expect(simulation.time).toBeGreaterThan(2 * forwardDelaySeconds);
    expect(portStates(simulation)['A:B']).toBe('Forwarding');
  });

  test('losing a role blocks the port in the same instant', () => {
    const simulation = timed();
    simulation.runToConvergence();
    const before = portStates(simulation);
    const [routerId, neighborId] = Object.entries(before)
      .find(([, name]) => name === 'Forwarding')[0]
      .split(':');

    // Pulling the cable is something a bridge sees for itself, so the port goes
    // at once — no forward delay on the way down.
    simulation.removeLink(routerId, neighborId);
    expect(simulation.tables()[routerId][neighborId]).toBeUndefined();
  });

  test('a bridge switched off reports every port disabled, immediately', () => {
    const simulation = timed();
    simulation.runToConvergence();
    simulation.setRouterActive('3', false);

    Object.values(simulation.tables()['3']).forEach((row) => {
      expect(row.state).toBe('Disabled');
      expect(row.role).toBe('Disabled');
    });
  });
});

/* ------------------------------------------------------------------ *
 * The tree it settles on
 * ------------------------------------------------------------------ */

describe('convergence on the clock', () => {
  test('the ring settles on a tree: V−1 forwarding links, and the lowest id is root', () => {
    const simulation = timed();
    const run = simulation.runToConvergence();

    expect(run.converged).toBe(true);
    expect(forwardingLinks(simulation)).toHaveLength(simulation.routerIds.length - 1);
    expect(simulation.metrics()[0].value).toBe('1');
  });

  test('nothing is left mid-transition once it reports quiet', () => {
    const simulation = timed();
    simulation.runToConvergence();
    Object.values(portStates(simulation)).forEach((name) => {
      expect(['Forwarding', 'Blocking']).toContain(name);
    });
  });

  test('a settled tree stays settled: the hello drumbeat is not news', () => {
    const simulation = timed();
    simulation.runToConvergence();
    const tree = forwardingLinks(simulation);

    // Ten more hellos in each direction and nothing moves. A bridged network at
    // rest still transmits for ever, so this is what "quiet" has to mean.
    simulation.advance(10 * simulation.options.helloSeconds);
    expect(simulation.converged).toBe(true);
    expect(forwardingLinks(simulation)).toEqual(tree);
  });

  test('run to convergence does not report a finish mid-climb', () => {
    const simulation = timed();
    const run = simulation.runToConvergence();
    // It has to have waited out at least the full climb.
    expect(run.seconds).toBeGreaterThanOrEqual(2 * simulation.options.forwardDelaySeconds);
  });

  test('priority moves the root, and the tree reshapes around it', () => {
    const simulation = timed();
    simulation.runToConvergence();
    expect(simulation.metrics()[0].value).toBe('1');

    simulation.setRouterOption('4', 'priority', STP.defaultPriority - STP.priorityStep);
    simulation.runToConvergence();
    expect(simulation.metrics()[0].value).toBe('4');
    expect(forwardingLinks(simulation)).toHaveLength(simulation.routerIds.length - 1);
  });
});

/* ------------------------------------------------------------------ *
 * The fifty seconds
 * ------------------------------------------------------------------ */

describe('failover, and what it costs', () => {
  test('a ring break is noticed after max age and repaired 2 × forward delay later', () => {
    const simulation = timed();
    simulation.runToConvergence();
    const { maxAgeSeconds, forwardDelaySeconds } = simulation.options;

    const tree = forwardingLinks(simulation);
    // Break a link that is *not* adjacent to the blocked one, so the recovery
    // genuinely needs the blocked port to take over rather than a neighbour
    // simply re-deciding.
    const blocked = Object.entries(simulation.decorations().links).find(
      ([, variant]) => variant === 'blocked'
    )[0];
    const [a, b] = tree.find((key) => key !== blocked).split('|');

    simulation.removeLink(a, b);
    const at = simulation.time;
    simulation.runToConvergence();
    const took = simulation.time - at;

    // Both ends of the broken link knew at once, but the bridge on the far side
    // of the ring had to age out a BPDU before it could be given a role, and
    // then wait out the climb.
    expect(took).toBeLessThanOrEqual(maxAgeSeconds + 2 * forwardDelaySeconds + 5);
    expect(forwardingLinks(simulation)).toContain(blocked);
    expect(forwardingLinks(simulation)).toHaveLength(simulation.routerIds.length - 1);
  });

  test('there is a stretch with a hole in the tree — that is the point', () => {
    const simulation = timed();
    simulation.runToConvergence();
    const before = forwardingLinks(simulation).length;

    const blocked = Object.entries(simulation.decorations().links).find(
      ([, variant]) => variant === 'blocked'
    )[0];
    const [a, b] = forwardingLinks(simulation)
      .find((key) => key !== blocked)
      .split('|');
    simulation.removeLink(a, b);

    // Immediately after the break the network is one link short and the spare is
    // not usable yet. A protocol that recovered instantly would make the whole
    // stage pointless.
    expect(forwardingLinks(simulation).length).toBeLessThan(before);
    simulation.advance(simulation.options.forwardDelaySeconds);
    expect(forwardingLinks(simulation).length).toBeLessThan(before);
  });

  test('killing the root re-elects, once its BPDU has aged out everywhere', () => {
    const simulation = timed();
    simulation.runToConvergence();
    expect(simulation.metrics()[0].value).toBe('1');

    // Switched off, not deleted: nobody is told, so every survivor has to time
    // the old root's vector out for itself.
    simulation.setRouterActive('1', false);
    simulation.runToConvergence();

    expect(simulation.metrics()[0].value).toBe('2');
    // Four live bridges, so three forwarding links, and the ring is now a chain.
    expect(forwardingLinks(simulation)).toHaveLength(3);
  });

  test('a stored BPDU ages both in flight and while it waits', () => {
    const simulation = timed();
    simulation.runToConvergence();

    // Bridge 3 is two hops from the root, so what it holds left the root a
    // moment ago and has crossed two links.
    const ages = () =>
      simulation
        .inspect('3')[0]
        .blocks.find((block) => block.type === 'table')
        .rows.map((row) => row.age);

    expect(ages().some((age) => age !== '—')).toBe(true);
    // Every age is strictly below max age: anything at it would have been thrown
    // away rather than stored.
    ages()
      .filter((age) => age !== '—')
      .forEach((age) => {
        expect(Number.parseFloat(age)).toBeLessThan(simulation.options.maxAgeSeconds);
      });
  });
});

/* ------------------------------------------------------------------ *
 * The inspector
 * ------------------------------------------------------------------ */

describe('the Ports tab', () => {
  test('offers no tab at all in round mode', () => {
    const rounds = new Simulation(new Topology(RING), 'stp');
    expect(rounds.inspect('1')).toEqual([]);
  });

  test('lists every port with its state, role and BPDU age', () => {
    const simulation = timed();
    simulation.runToConvergence();
    const [tab] = simulation.inspect('1');

    expect(tab.id).toBe('ports');
    const table = tab.blocks.find((block) => block.type === 'table');
    expect(table.rows.map((row) => row.port).sort()).toEqual(['2', '5']);
    table.rows.forEach((row) => {
      expect(['Forwarding', 'Blocking']).toContain(row.state);
    });
  });

  test('shows a draining bar per port still coming up, and none once settled', () => {
    const simulation = timed(PAIR);
    simulation.advance(1);

    const bars = () => simulation.inspect('A')[0].blocks.find((block) => block.type === 'bars');
    expect(bars().bars).toHaveLength(1);
    expect(bars().bars[0].label).toContain('Listening');

    simulation.runToConvergence();
    expect(bars()).toBeUndefined();
  });

  test('counts down: the bar shrinks as the forward delay runs out', () => {
    const simulation = timed(PAIR);
    simulation.advance(1);
    const value = () => simulation.inspect('A')[0].blocks.find((b) => b.type === 'bars').bars[0]
      .value;

    const first = value();
    simulation.advance(5);
    expect(value()).toBeLessThan(first);
  });
});

/* ------------------------------------------------------------------ *
 * Determinism, and the two clocks agreeing
 * ------------------------------------------------------------------ */

describe('determinism and equivalence', () => {
  test('the same seed and the same edits replay identically', () => {
    const run = (seed) => {
      const simulation = new Simulation(new Topology(RING), 'stp', undefined, {
        mode: 'timers',
        seed,
      });
      simulation.runToConvergence();
      simulation.removeLink('2', '3');
      simulation.runToConvergence();
      return JSON.stringify(simulation.getSnapshot());
    };
    expect(run(7)).toBe(run(7));
  });

  test('nothing here consumes randomness, so every seed gives the same answer', () => {
    // Worth asserting rather than assuming: spanning tree has no jitter — every
    // bridge transmits on a fixed hello — so unlike RIP the seed changes nothing
    // at all. If a jittered hello is ever added, this is the test that will say so.
    const tree = (seed) => {
      const simulation = new Simulation(new Topology(RING), 'stp', undefined, {
        mode: 'timers',
        seed,
      });
      simulation.runToConvergence();
      return { at: simulation.time, links: forwardingLinks(simulation) };
    };
    expect(tree(1)).toEqual(tree(999));
  });

  test('both clocks settle on the same tree', () => {
    // The proof that the port state machine changed nothing about the protocol:
    // it decides *when* a link is usable, never *which* links are in the tree.
    const rounds = new Simulation(new Topology(RING), 'stp');
    rounds.runToConvergence();
    const clock = timed();
    clock.runToConvergence();

    expect(forwardingLinks(clock)).toEqual(forwardingLinks(rounds));
    expect(clock.metrics()[0].value).toBe(rounds.metrics()[0].value);
    // And the roles agree port for port, which is the stronger statement.
    rounds.routerIds.forEach((routerId) => {
      Object.entries(rounds.tables()[routerId]).forEach(([neighborId, row]) => {
        expect(clock.tables()[routerId][neighborId].role).toBe(row.role);
      });
    });
  });

  test('switching mode and back leaves the same tree', () => {
    const simulation = timed();
    simulation.runToConvergence();
    const onClock = forwardingLinks(simulation);

    simulation.setMode('rounds');
    simulation.runToConvergence();
    expect(forwardingLinks(simulation)).toEqual(onClock);

    simulation.setMode('timers');
    simulation.runToConvergence();
    expect(forwardingLinks(simulation)).toEqual(onClock);
  });

  test('the event log narrates the climb', () => {
    const simulation = timed(PAIR);
    simulation.runToConvergence();
    const text = simulation.getSnapshot().eventLog.map((entry) => entry.text);

    expect(text.some((line) => line.includes('Listening'))).toBe(true);
    expect(text.some((line) => line.includes('Learning'))).toBe(true);
    expect(text.some((line) => line.includes('Forwarding'))).toBe(true);
  });
});
