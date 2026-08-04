/**
 * ripTimers.test.js — distance vector on the clock.
 *
 * The round-based suite proves the algorithm is right. This one proves the
 * *timers* are right, which is a different claim: that a route really does sit
 * valid for three minutes after the router advertising it dies, that it is then
 * shouted about as dead for two more, and that none of it depends on anything
 * as unreproducible as `Math.random()`.
 *
 * The last describe block is the one that guards everything else. On a static
 * topology both clocks have to reach the same answer — if they do not, the new
 * mode did not add a clock, it changed the protocol.
 */

import { Simulation } from '../Simulation';
import { SIM } from '../../config';
import { PRESETS } from '../../presets';

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

const CHAIN = {
  A: [{ neighbor: 'B', cost: 1 }],
  B: [
    { neighbor: 'A', cost: 1 },
    { neighbor: 'C', cost: 1 },
  ],
  C: [{ neighbor: 'B', cost: 1 }],
};

const rip = (topology, options, seed = SIM.timers.defaultSeed) =>
  new Simulation(topology, 'dvr', options, { mode: 'timers', seed });

const costsOf = (simulation) =>
  Object.fromEntries(
    Object.entries(simulation.tables()).map(([id, table]) => [
      id,
      Object.fromEntries(Object.entries(table).map(([dest, route]) => [dest, route.cost])),
    ])
  );

/** The live route object, so a test can assert on the lifecycle itself. */
const routeAt = (simulation, routerId, dest) =>
  simulation.state.timers.routes.get(routerId).get(dest);

/** Every message sent while advancing `seconds`, with payload and timestamp. */
function collect(simulation, seconds) {
  return simulation.advance(seconds).messages;
}

describe('starting up', () => {
  test('routers know themselves and their links, and say nothing yet', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);

    expect(simulation.mode).toBe('timers');
    expect(simulation.time).toBe(0);
    expect(costsOf(simulation).N2).toEqual({
      N1: 1,
      N2: 0,
      N3: 6,
      N4: SIM.defaultInfinityCost,
      N5: 3,
    });

    // Nothing is transmitted until the first scheduled update: a network that
    // has just been switched on is quiet, and that silence is what the jitter
    // demo below depends on.
    expect(collect(simulation, SIM.timers.updateInterval - SIM.timers.updateJitter - 0.1))
      .toEqual([]);
  });

  test('every switched-on router has exactly one periodic update timer', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    expect(simulation.state.timers.updates.size).toBe(5);

    simulation.setRouterActive('N3', false);
    expect(simulation.state.timers.updates.has('N3')).toBe(false);

    simulation.setRouterActive('N3', true);
    expect(simulation.state.timers.updates.has('N3')).toBe(true);
  });

  test('the clock only supports protocols that asked for it', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    expect(simulation.supportsTimers).toBe(true);

    // Link state has no `startTimers`, so selecting it falls back rather than
    // leaving a mode selected that nothing implements.
    simulation.setProtocol('ls');
    expect(simulation.supportsTimers).toBe(false);
    expect(simulation.mode).toBe('rounds');
    expect(simulation.setMode('timers')).toBe('rounds');
  });
});

describe('the periodic update', () => {
  test('fires once per interval, jittered inside the window', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    const sent = collect(simulation, SIM.timers.updateInterval + SIM.timers.updateJitter);

    const senders = new Set(sent.map((message) => message.from));
    expect(senders).toEqual(new Set(['N1', 'N2', 'N3', 'N4', 'N5']));
    sent.forEach((message) => {
      expect(message.at).toBeGreaterThanOrEqual(
        SIM.timers.updateInterval - SIM.timers.updateJitter
      );
      expect(message.at).toBeLessThanOrEqual(
        SIM.timers.updateInterval + SIM.timers.updateJitter
      );
    });
  });

  test('jitter spreads the transmissions out — and zero jitter does not', () => {
    const spread = rip(SAMPLE_TOPOLOGY, { triggeredUpdates: false });
    const jittered = new Set(
      collect(spread, 100)
        .filter((message) => message.from === message.from)
        .map((message) => message.at)
    );
    expect(jittered.size).toBeGreaterThan(3);

    // The pathology, asserted rather than assumed: routers started together
    // with no jitter transmit in the same instant, for ever. This is why the
    // random offset is in the RFC.
    const locked = rip(SAMPLE_TOPOLOGY, { updateJitter: 0, triggeredUpdates: false });
    const timestamps = new Set(collect(locked, 100).map((message) => message.at));
    expect([...timestamps].sort((a, b) => a - b)).toEqual([
      SIM.timers.updateInterval,
      SIM.timers.updateInterval * 2,
      SIM.timers.updateInterval * 3,
    ]);
  });
});

describe('the route lifecycle', () => {
  /**
   * Switch a router off without deleting it — the honest failure. Its
   * neighbours are told nothing, because nothing told them: this is the whole
   * reason the mode exists.
   */
  const silenced = () => {
    const simulation = rip(CHAIN);
    simulation.runToConvergence();
    simulation.setRouterActive('C', false);
    return simulation;
  };

  test('a route stays valid for the whole timeout, then goes to infinity', () => {
    const simulation = silenced();
    // The clock started at C's *last update*, not at the moment it was switched
    // off — nobody at B knows when C died, only when it last spoke. That gap is
    // why the outage looks longer than three minutes from the outside.
    const { timeoutAt } = routeAt(simulation, 'B', 'C');
    expect(timeoutAt - simulation.time).toBeGreaterThan(SIM.timers.routeTimeout / 2);

    simulation.advance(timeoutAt - simulation.time - 0.5);
    expect(routeAt(simulation, 'B', 'C').valid).toBe(true);
    expect(routeAt(simulation, 'B', 'C').cost).toBe(1);

    simulation.advance(1);
    const route = routeAt(simulation, 'B', 'C');
    expect(route.valid).toBe(false);
    expect(route.cost).toBe(SIM.defaultInfinityCost);
    expect(route.gcAt).toBeCloseTo(timeoutAt + SIM.timers.garbageCollection, 6);
  });

  test('the dead route is advertised as unreachable until garbage collection', () => {
    const simulation = silenced();
    simulation.advance(SIM.timers.routeTimeout + 1);

    // Still in the table, still going out on the wire — as infinity, so A
    // learns it is gone rather than timing it out on its own schedule.
    const poison = collect(simulation, SIM.timers.updateInterval * 2).filter(
      (message) => message.from === 'B' && message.to === 'A'
    );
    expect(poison.length).toBeGreaterThan(0);
    expect(poison.every((message) => message.payload.C === SIM.defaultInfinityCost)).toBe(true);
    expect(routeAt(simulation, 'B', 'C')).toBeDefined();

    simulation.advance(SIM.timers.garbageCollection);
    expect(routeAt(simulation, 'B', 'C')).toBeUndefined();
    // Deleted from the table, so the view falls back to "no route at all".
    expect(simulation.tables().B.C).toEqual({
      nextHop: null,
      cost: SIM.defaultInfinityCost,
    });
  });

  test('a refresh during garbage collection restores the route', () => {
    const simulation = silenced();
    simulation.advance(SIM.timers.routeTimeout + 1);
    expect(routeAt(simulation, 'B', 'C').valid).toBe(false);

    // C comes back with time to spare. The pending deletion is cancelled, not
    // merely postponed.
    simulation.setRouterActive('C', true);
    simulation.advance(SIM.timers.garbageCollection + SIM.timers.updateInterval * 2);

    const route = routeAt(simulation, 'B', 'C');
    expect(route.valid).toBe(true);
    expect(route.cost).toBe(1);
    expect(route.gc).toBeNull();
  });

  test('a route to a router that is down is never revived by the link alone', () => {
    const simulation = silenced();
    // The cable to C is fine and the link cost says "one hop away", but C is
    // switched off — so the direct route must not be reinstated behind the
    // timeout's back.
    simulation.advance(SIM.timers.routeTimeout + SIM.timers.garbageCollection + 10);
    expect(routeAt(simulation, 'B', 'C')).toBeUndefined();
  });

  test('pulling the cable is noticed at once, unlike switching a box off', () => {
    const simulation = rip(CHAIN);
    simulation.runToConvergence();
    simulation.removeLink('B', 'C');

    // No timeout involved: the interface is down and the router can see it.
    expect(routeAt(simulation, 'B', 'C').valid).toBe(false);
    expect(routeAt(simulation, 'B', 'C').cost).toBe(SIM.defaultInfinityCost);
    expect(routeAt(simulation, 'A', 'C').valid).toBe(true);

    // A finds out from B's triggered update, inside the 1–5 second window.
    simulation.advance(SIM.timers.triggeredUpdateMax + 0.1);
    expect(simulation.tables().A.C.cost).toBe(SIM.defaultInfinityCost);
  });
});

describe('triggered updates', () => {
  test('a metric change schedules exactly one, inside the 1–5 second window', () => {
    const simulation = rip(CHAIN);
    simulation.runToConvergence();
    const brokenAt = simulation.time;

    simulation.removeLink('B', 'C');
    const triggered = collect(simulation, SIM.timers.triggeredUpdateMax * 3).filter(
      (message) => message.label === 'DV!'
    );
    expect(triggered.length).toBeGreaterThan(0);

    // B saw the interface go down, so B is the one that announces, once, inside
    // the window. One update however many of its routes moved.
    const fromB = triggered.filter((message) => message.from === 'B');
    const announcedAt = fromB[0].at - brokenAt;
    expect(announcedAt).toBeGreaterThanOrEqual(SIM.timers.triggeredUpdateMin);
    expect(announcedAt).toBeLessThanOrEqual(SIM.timers.triggeredUpdateMax);
    expect(new Set(fromB.map((message) => message.at)).size).toBe(1);

    // Everything after that is the wave: each hop hears the news, changes its
    // own mind, and waits its own 1–5 seconds before passing it on. Nothing
    // arrives before the hop in front of it spoke.
    triggered
      .filter((message) => message.from !== 'B')
      .forEach((message) => expect(message.at).toBeGreaterThan(fromB[0].at));
  });

  test('a triggered update carries only what changed', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    simulation.removeLink('N2', 'N3');

    const triggered = collect(simulation, SIM.timers.triggeredUpdateMax + 0.5).filter(
      (message) => message.label === 'DV!'
    );
    expect(triggered.length).toBeGreaterThan(0);
    // A full table would be five entries; a triggered update is the news only.
    triggered.forEach((message) => {
      expect(Object.keys(message.payload).length).toBeLessThan(5);
    });
  });

  test('turning them off makes recovery wait for the next scheduled update', () => {
    // Jitter off so the periodic updates land on exact multiples of the
    // interval and the two runs can be compared second for second — otherwise
    // somebody else's scheduled update wanders into the window by luck.
    const fast = rip(CHAIN, { updateJitter: 0 });
    fast.runToConvergence();
    fast.removeLink('B', 'C');
    fast.advance(SIM.timers.triggeredUpdateMax + 0.5);
    expect(fast.tables().A.C.cost).toBe(SIM.defaultInfinityCost);

    const slow = rip(CHAIN, { updateJitter: 0, triggeredUpdates: false });
    slow.runToConvergence();
    slow.removeLink('B', 'C');
    slow.advance(SIM.timers.triggeredUpdateMax + 0.5);
    // Nothing has been said, so A still believes in a route that no longer
    // exists — for up to a full update interval. This is the argument for
    // triggered updates, and it costs the protocol nothing to make.
    expect(slow.tables().A.C.cost).toBe(2);

    slow.advance(SIM.timers.updateInterval);
    expect(slow.tables().A.C.cost).toBe(SIM.defaultInfinityCost);
  });
});

describe('convergence, redefined', () => {
  test('quiet means no change and nothing outstanding for a whole interval', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    const { converged, seconds } = simulation.runToConvergence();

    expect(converged).toBe(true);
    expect(simulation.stats.quietFor).toBeGreaterThanOrEqual(SIM.timers.updateInterval);
    expect(seconds).toBeLessThan(SIM.timers.maxConvergenceSeconds);
    // Reported from the moment things actually went quiet, not the moment we
    // were prepared to say so.
    expect(simulation.stats.secondsToConverge).toBeLessThan(simulation.time);
    expect(costsOf(simulation).N1.N4).toBe(8);
  });

  test('a periodic update on a settled network does not break the quiet', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();

    // Three more intervals of the thirty-second drumbeat. A network that is
    // completely settled still talks, and if that counted as activity nothing
    // would ever be allowed to call itself converged.
    const sent = collect(simulation, SIM.timers.updateInterval * 3);
    expect(sent.length).toBeGreaterThan(0);
    expect(simulation.converged).toBe(true);
  });

  test('silence from a dying neighbour is not quiet', () => {
    const simulation = rip(CHAIN);
    simulation.runToConvergence();
    simulation.setRouterActive('C', false);

    // Nothing is *said* after C goes silent, and thirty seconds of nothing
    // would otherwise read as convergence — with two and a half minutes of the
    // staircase still to come and both routers still believing in C.
    simulation.advance(SIM.timers.updateInterval + 5);
    expect(simulation.converged).toBe(false);

    // Run to convergence must therefore play the whole staircase out.
    const run = simulation.runToConvergence();
    expect(run.converged).toBe(true);
    expect(run.seconds).toBeGreaterThan(
      SIM.timers.routeTimeout + SIM.timers.garbageCollection - SIM.timers.updateInterval * 2
    );
    expect(simulation.tables().B.C.nextHop).toBeNull();
  });

  test('an edit ends the quiet immediately', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    simulation.runToConvergence();
    expect(simulation.converged).toBe(true);

    simulation.removeLink('N2', 'N5');
    expect(simulation.converged).toBe(false);
    expect(simulation.stats.secondsToConverge).toBeNull();

    // N5 is still reachable, the long way round: 1 + 6 + 2 + 4.
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(costsOf(simulation).N1.N5).toBe(13);
    expect(simulation.stats.secondsToConverge).not.toBeNull();
  });
});

describe('determinism', () => {
  /** The same script of edits, run twice from the same seed. */
  const play = (seed) => {
    const simulation = rip(SAMPLE_TOPOLOGY, undefined, seed);
    simulation.runToConvergence();
    simulation.removeLink('N2', 'N3');
    simulation.advance(45);
    simulation.setRouterActive('N5', false);
    simulation.runToConvergence();
    return simulation;
  };

  test('the same seed and the same edits produce identical snapshots', () => {
    expect(play(4).getSnapshot()).toEqual(play(4).getSnapshot());
  });

  test('different seeds produce different timings', () => {
    const a = play(1);
    const b = play(9);

    // The same answer — the protocol is not random — reached at a different
    // moment. Convergence is a distribution, not a number.
    expect(costsOf(a)).toEqual(costsOf(b));
    expect(a.time).not.toBe(b.time);
  });

  test('changing the seed replays from the beginning', () => {
    const simulation = rip(SAMPLE_TOPOLOGY, undefined, 1);
    simulation.runToConvergence();
    expect(simulation.time).toBeGreaterThan(0);

    simulation.setSeed(2);
    expect(simulation.time).toBe(0);
    expect(simulation.stats.messages).toBe(0);
    expect(simulation.getSnapshot()).toEqual(rip(SAMPLE_TOPOLOGY, undefined, 2).getSnapshot());
  });
});

describe('the event log', () => {
  test('narrates transmissions and the route lifecycle, with timestamps', () => {
    const simulation = rip(CHAIN);
    simulation.runToConvergence();
    simulation.setRouterActive('C', false);
    simulation.advance(SIM.timers.routeTimeout + SIM.timers.garbageCollection + 5);

    const text = simulation.getSnapshot().eventLog.map((entry) => entry.text);
    expect(text.some((line) => /^C down/.test(line))).toBe(true);
    expect(text).toContain('B route to C invalid (timeout)');
    expect(text).toContain('B route to C deleted (garbage collection)');
    expect(text.some((line) => /→ .* update$/.test(line))).toBe(true);

    // Newest first, and every line knows when it happened.
    const log = simulation.getSnapshot().eventLog;
    expect(log[0].at).toBeGreaterThanOrEqual(log[log.length - 1].at);
    expect(log.length).toBeLessThanOrEqual(SIM.timers.eventLogLength);
  });
});

describe('the timers inspector', () => {
  test('shows the next update and every route that can time out', () => {
    const simulation = rip(CHAIN);
    simulation.runToConvergence();

    const [tab] = simulation.inspect('B');
    expect(tab).toMatchObject({ id: 'timers', label: 'Timers' });

    const rows = tab.blocks.find((block) => block.type === 'rows').rows;
    expect(rows.find((row) => row.label === 'Next update').value).toMatch(/^\d/);
    const bars = tab.blocks.find((block) => block.type === 'bars').bars;
    // B's own row carries no timer — a router cannot lose itself.
    expect(bars.map((bar) => bar.label)).toEqual(['A', 'C']);
    expect(bars.every((bar) => bar.max === SIM.timers.routeTimeout)).toBe(true);

    simulation.setRouterActive('C', false);
    simulation.advance(SIM.timers.routeTimeout + 1);
    const dying = simulation
      .inspect('B')[0]
      .blocks.find((block) => block.type === 'bars')
      .bars.find((bar) => bar.label.startsWith('C'));
    expect(dying.max).toBe(SIM.timers.garbageCollection);
    expect(dying.caption).toMatch(/to deletion$/);
  });

  test('round mode offers no timer tab at all', () => {
    const simulation = new Simulation(CHAIN, 'dvr');
    simulation.runToConvergence();
    expect(simulation.inspect('B')).toEqual([]);
    expect(simulation.getSnapshot().metrics).toEqual([]);
  });
});

describe('stepping', () => {
  test('step to next event skips the empty seconds', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    const next = simulation.clock.nextEventAt;

    const step = simulation.stepToNextEvent();
    expect(step.ran).toBe(true);
    expect(simulation.time).toBe(next);
    expect(step.exchanges.length).toBeGreaterThan(0);
  });

  test('advancing a fraction of a second lands exactly there', () => {
    const simulation = rip(SAMPLE_TOPOLOGY);
    simulation.advance(0.25);
    simulation.advance(0.25);
    expect(simulation.time).toBeCloseTo(0.5, 10);
  });

  test('the two clocks refuse to be driven by the wrong control', () => {
    const timed = rip(SAMPLE_TOPOLOGY);
    expect(() => timed.runIteration()).toThrow(/round mode only/);

    const rounds = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    expect(() => rounds.advance(10)).toThrow(/timer mode only/);
  });
});

/**
 * The stage's checkpoint, as one run: switch a router off and watch its routes
 * live out the whole 180 + 120 second staircase.
 */
describe('the staircase', () => {
  test('valid, then infinity, then advertised as dead, then gone', () => {
    const simulation = rip(CHAIN);
    simulation.runToConvergence();
    expect(simulation.tables().A.C).toEqual({ nextHop: 'B', cost: 2 });

    simulation.setRouterActive('C', false);
    const deadline = routeAt(simulation, 'B', 'C').timeoutAt;

    // Step one: nothing. Nobody told anybody anything, and both routers still
    // hold a route to a box that has been off for nearly three minutes.
    //
    // Note what does *not* happen: the correctness meter stays at 100%, because
    // a router that is switched off is scored neither as a source nor as a
    // destination (doc 07). The staircase is invisible to it, which is exactly
    // why the event log and the timer bars had to be built.
    simulation.advance(deadline - simulation.time - 1);
    expect(simulation.tables().A.C).toEqual({ nextHop: 'B', cost: 2 });
    expect(simulation.tables().B.C).toEqual({ nextHop: 'C', cost: 1 });
    expect(simulation.correctness.totals.percent).toBe(100);

    // Step two: B's timer runs out. The metric goes to infinity, the next hop
    // stays — "I know who told me, and I no longer believe them".
    simulation.advance(2);
    expect(simulation.tables().B.C).toEqual({
      nextHop: 'C',
      cost: SIM.defaultInfinityCost,
    });

    // Step three: B says so, out loud, and A believes it.
    simulation.advance(SIM.timers.triggeredUpdateMax + 0.5);
    expect(simulation.tables().A.C.cost).toBe(SIM.defaultInfinityCost);

    // Step four: garbage collection, and the route is gone rather than dead.
    simulation.advance(SIM.timers.garbageCollection + 1);
    expect(simulation.tables().B.C).toEqual({
      nextHop: null,
      cost: SIM.defaultInfinityCost,
    });

    const narration = simulation.getSnapshot().eventLog.map((entry) => entry.text);
    expect(narration).toEqual(
      expect.arrayContaining([
        'B route to C invalid (timeout)',
        'B route to C deleted (garbage collection)',
      ])
    );
    // With C down there is nothing left to be wrong about.
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.correctness.totals.percent).toBe(100);
  });
});

/**
 * The preset the help text points at. Split horizon and poisoned reverse are
 * both on and the tables still loop, which is the whole argument for DUAL —
 * so if a future change makes the demo stop demonstrating, this is what says so.
 */
describe('the async loop trap preset', () => {
  const preset = PRESETS.find((entry) => entry.id === 'async-loop');

  /** Built the way the app builds it, so the seeded run matches what a user sees. */
  const load = (options, seed) => {
    const simulation = new Simulation(undefined, 'dvr', options, { mode: 'timers', seed });
    preset.routers.forEach((router) => simulation.addRouter(router.id, { refresh: false }));
    preset.links.forEach((link) =>
      simulation.addLink(link.source, link.destination, link.cost, { refresh: false })
    );
    simulation.refresh();
    return simulation;
  };

  test('loops with split horizon and poisoned reverse both on', () => {
    const simulation = load({ triggeredUpdates: false }, SIM.timers.defaultSeed);
    expect(simulation.options.splitHorizon).toBe(true);
    expect(simulation.options.poisonedReverse).toBe(true);

    simulation.runToConvergence();
    expect(simulation.stats.loopsSeen).toBe(0);

    simulation.removeLink('1', '5');
    const run = simulation.runToConvergence();

    // Stale news from one side of the ring outran the poison coming round the
    // other, and for a while the routers pointed at each other.
    expect(simulation.stats.loopsSeen).toBeGreaterThan(0);
    // …and it still ends, because infinity is a small finite ceiling.
    expect(run.converged).toBe(true);
    expect(simulation.correctness.totals.percent).toBe(100);
  });

  test('and settles cleanly under the round loop, which is the point', () => {
    const rounds = new Simulation(undefined, 'dvr');
    preset.routers.forEach((router) => rounds.addRouter(router.id, { refresh: false }));
    preset.links.forEach((link) =>
      rounds.addLink(link.source, link.destination, link.cost, { refresh: false })
    );
    rounds.refresh();

    rounds.runToConvergence();
    rounds.removeLink('1', '5');
    rounds.runToConvergence();
    // Same topology, same failure, same loop guards. In lockstep nobody is ever
    // holding news that everybody else has already moved past, so there is
    // nothing for a stale advertisement to outrun.
    expect(rounds.stats.loopsSeen).toBe(0);
  });
});

/**
 * The test the whole stage rests on. Two clocks, one protocol: if they disagree
 * about the answer then the asynchronous mode is not a clock, it is a different
 * algorithm wearing the same name.
 */
describe('equivalence with round mode', () => {
  test.each([
    ['the sample topology', SAMPLE_TOPOLOGY],
    ['a chain', CHAIN],
  ])('converges to the same tables as the round loop on %s', (label, topology) => {
    const rounds = new Simulation(topology, 'dvr');
    rounds.runToConvergence();

    const timers = rip(topology);
    timers.runToConvergence();

    expect(costsOf(timers)).toEqual(costsOf(rounds));
    expect(timers.getSnapshot().correctness.totals.percent).toBe(100);
  });

  test('and after a failure, too — at a different moment', () => {
    const rounds = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    rounds.runToConvergence();
    rounds.removeLink('N2', 'N5');
    rounds.runToConvergence();

    const timers = rip(SAMPLE_TOPOLOGY);
    timers.runToConvergence();
    timers.removeLink('N2', 'N5');
    timers.runToConvergence();

    expect(costsOf(timers)).toEqual(costsOf(rounds));
  });

  test('switching mode starts the protocol again rather than translating it', () => {
    const simulation = new Simulation(SAMPLE_TOPOLOGY, 'dvr');
    simulation.runToConvergence();
    expect(simulation.iteration).toBeGreaterThan(0);

    expect(simulation.setMode('timers')).toBe('timers');
    // A table built by lockstep rounds has no timers hanging off it, so the
    // honest thing is to start again — and say so by resetting the counters.
    expect(simulation.time).toBe(0);
    expect(simulation.iteration).toBe(0);
    expect(simulation.stats.messages).toBe(0);
    expect(costsOf(simulation).N1.N4).toBe(SIM.defaultInfinityCost);

    simulation.runToConvergence();
    expect(costsOf(simulation).N1.N4).toBe(8);
  });
});
