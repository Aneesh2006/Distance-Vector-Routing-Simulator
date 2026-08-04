/**
 * scenario.test.js — a whole simulator state as a URL, and back (stage 9.9).
 *
 * Two properties matter, and one of them is not about correctness:
 *
 *   - **round trip**: encode a simulation, decode it, rebuild it, and the two
 *     agree about the topology, the protocol, every setting and the seed. Not
 *     about how far the run has got — a link is a scenario, not a save file.
 *   - **never explodes**: a link that has been truncated by an email client,
 *     hand-edited, or written by a build with different options must produce the
 *     parts it can and say what it dropped. A blank page is the one outcome a
 *     shared link must not have.
 */

import { Simulation } from './Simulation';
import { Topology } from './Topology';
import {
  SCENARIO_VERSION,
  decodeScenario,
  encodeScenario,
  scenarioFromUrl,
  scenarioUrl,
} from './scenario';
import { SIM } from '../config';

const RING = {
  1: [
    { neighbor: '2', cost: 1 },
    { neighbor: '5', cost: 3 },
  ],
  2: [{ neighbor: '3', cost: 1 }],
  3: [{ neighbor: '4', cost: 2 }],
  4: [{ neighbor: '5', cost: 1 }],
  5: [],
};

const POSITIONS = {
  1: { x: -8, y: 0, z: 0 },
  2: { x: -4, y: 1.5, z: 6 },
  3: { x: 4, y: 0, z: 6 },
  4: { x: 8, y: -1.5, z: 0 },
  5: { x: 0, y: 0, z: -7 },
};

const sim = (protocolId = 'dvr', overrides, run) =>
  new Simulation(new Topology(RING), protocolId, overrides, run);

/**
 * Rebuild a simulation from a decoded scenario, the way `App` does.
 *
 * Kept here rather than imported because `App.js` is React and the engine is not
 * — but it is the same four steps in the same order, and if they ever diverge
 * this is the test that has to change with them.
 */
function rebuild(scenario) {
  const simulation = new Simulation(undefined, scenario.protocolId, scenario.options, {
    mode: scenario.mode,
    seed: scenario.seed,
  });
  scenario.routers.forEach((router) => simulation.addRouter(router.id, { refresh: false }));
  scenario.links.forEach((link) =>
    simulation.addLink(link.source, link.destination, link.cost, { refresh: false })
  );
  Object.entries(scenario.routerOptions).forEach(([routerId, knobs]) => {
    Object.entries(knobs).forEach(([key, value]) => {
      if (value !== null && typeof value === 'object') {
        Object.entries(value).forEach(([neighborId, inner]) =>
          simulation.setRouterOption(routerId, key, inner, neighborId)
        );
        return;
      }
      simulation.setRouterOption(routerId, key, value);
    });
  });
  scenario.routers.forEach((router) => {
    if (!router.isActive) simulation.setRouterActive(router.id, false, { refresh: false });
  });
  simulation.refresh();
  return simulation;
}

/** Encode, decode, rebuild — the whole trip. */
function roundTrip(simulation, positions = POSITIONS) {
  const text = encodeScenario(simulation.getSnapshot(), positions);
  const scenario = decodeScenario(text);
  expect(scenario.ok).toBe(true);
  expect(scenario.warnings).toEqual([]);
  return { text, scenario, rebuilt: rebuild(scenario) };
}

const wiring = (simulation) => ({
  routers: simulation.routerIds,
  links: simulation.getLinks(),
  active: simulation.routerIds.map((id) => simulation.isActive(id)),
});

/* ------------------------------------------------------------------ *
 * The round trip
 * ------------------------------------------------------------------ */

describe('the round trip', () => {
  test('carries the topology exactly', () => {
    const { rebuilt } = roundTrip(sim());
    expect(wiring(rebuilt)).toEqual(wiring(sim()));
  });

  test('carries positions to a tenth, which is all anyone can type', () => {
    const { scenario } = roundTrip(sim());
    scenario.routers.forEach((router) => {
      expect({ x: router.x, y: router.y, z: router.z }).toEqual(POSITIONS[router.id]);
    });
  });

  test('carries the protocol', () => {
    ['dvr', 'ls', 'pv', 'stp', 'dual'].forEach((id) => {
      const { rebuilt } = roundTrip(sim(id));
      expect(rebuilt.protocol.id).toBe(id);
    });
  });

  test('carries which routers are switched off', () => {
    const simulation = sim();
    simulation.setRouterActive('3', false);
    const { rebuilt } = roundTrip(simulation);
    expect(rebuilt.isActive('3')).toBe(false);
    expect(rebuilt.isActive('2')).toBe(true);
  });

  test('carries the settings that differ from the defaults', () => {
    const simulation = sim('dvr', { splitHorizon: false, infinityCost: 8 });
    const { rebuilt } = roundTrip(simulation);
    expect(rebuilt.options.splitHorizon).toBe(false);
    expect(rebuilt.options.infinityCost).toBe(8);
    // And leaves the rest at their defaults rather than freezing them.
    expect(rebuilt.options.poisonedReverse).toBe(true);
  });

  test('carries per-router knobs, both scopes', () => {
    const simulation = sim('pv');
    simulation.setRouterOption('2', 'localPref', 200, '3');
    simulation.setRouterOption('2', 'as', 7);
    const { rebuilt } = roundTrip(simulation);

    expect(rebuilt.routerOption('2', 'localPref', '3')).toBe(200);
    expect(rebuilt.routerOption('2', 'as')).toBe(7);
    // Untouched ones still fall back to their own defaults.
    expect(rebuilt.routerOption('4', 'localPref', '5')).toBe(SIM.pathVector.defaultLocalPref);
  });

  test('carries a boolean per-router knob', () => {
    const simulation = sim('pv');
    simulation.setRouterOption('3', 'routeReflector', true);
    const { rebuilt } = roundTrip(simulation);
    expect(rebuilt.routerOption('3', 'routeReflector')).toBe(true);
  });

  test('carries the mode and the seed', () => {
    const simulation = sim('dvr', undefined, { mode: 'timers', seed: 4242 });
    const { rebuilt } = roundTrip(simulation);
    expect(rebuilt.mode).toBe('timers');
    expect(rebuilt.seed).toBe(4242);
  });

  test('and converges to the same tables as the original', () => {
    // The point of all of it: the same scenario, so the same answer.
    const original = sim('ls', { requireBidirectional: false });
    original.setRouterOption('4', 'area', 1);
    const { rebuilt } = roundTrip(original);

    original.runToConvergence();
    rebuilt.runToConvergence();
    expect(rebuilt.tables()).toEqual(original.tables());
  });

  test('a run that had already started comes back at round zero', () => {
    // A link is a scenario, not a save file. Encoding how far a run had got would
    // make two links to the same network different, and would leave the receiver
    // unable to watch the thing the sender wanted them to see.
    const simulation = sim();
    simulation.runToConvergence();
    const { rebuilt } = roundTrip(simulation);
    expect(rebuilt.iteration).toBe(0);
    expect(rebuilt.stats.messages).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Brevity
 * ------------------------------------------------------------------ */

describe('what the string looks like', () => {
  test('a default scenario writes no settings at all', () => {
    const text = encodeScenario(sim().getSnapshot(), POSITIONS);
    const [, protocolId, run, , , options, routerOptions] = text.split('~');
    expect(protocolId).toBe('dvr');
    expect(run).toBe('rounds');
    expect(options).toBe('');
    expect(routerOptions).toBe('');
  });

  test('a five-router scenario fits in a link nobody has to unwrap', () => {
    const text = encodeScenario(sim().getSnapshot(), POSITIONS);
    expect(text.length).toBeLessThan(140);
  });

  test('round mode carries no seed, so two links to it are the same string', () => {
    const one = encodeScenario(sim('dvr', undefined, { seed: 1 }).getSnapshot(), POSITIONS);
    const two = encodeScenario(sim('dvr', undefined, { seed: 99 }).getSnapshot(), POSITIONS);
    expect(one).toBe(two);
  });

  test('it starts with the version, so an old build can say so', () => {
    expect(encodeScenario(sim().getSnapshot(), POSITIONS).startsWith(`${SCENARIO_VERSION}~`)).toBe(
      true
    );
  });

  test('encoding is stable: the same state twice gives the same string', () => {
    const simulation = sim('pv');
    simulation.setRouterOption('2', 'localPref', 150, '3');
    const first = encodeScenario(simulation.getSnapshot(), POSITIONS);
    const second = encodeScenario(simulation.getSnapshot(), POSITIONS);
    expect(first).toBe(second);
  });
});

/* ------------------------------------------------------------------ *
 * Broken input
 * ------------------------------------------------------------------ */

describe('a link that has been damaged', () => {
  test('an empty string is refused, not crashed on', () => {
    expect(decodeScenario('')).toMatchObject({ ok: false });
    expect(decodeScenario(undefined)).toMatchObject({ ok: false });
    expect(decodeScenario(null)).toMatchObject({ ok: false });
  });

  test('a future version is refused with the versions named', () => {
    const result = decodeScenario('v9~dvr~rounds~1_0_0_0~~~');
    expect(result.ok).toBe(false);
    expect(result.warnings[0]).toContain('v9');
    expect(result.warnings[0]).toContain(SCENARIO_VERSION);
  });

  test('an unknown protocol falls back and says so', () => {
    const result = decodeScenario(`${SCENARIO_VERSION}~nope~rounds~1_0_0_0,2_5_0_0~1_2_1~~`);
    expect(result.ok).toBe(true);
    expect(result.protocolId).toBe('dvr');
    expect(result.warnings.join(' ')).toContain('nope');
    expect(result.routers).toHaveLength(2);
  });

  test('a link to a router that is not in the string is dropped, with a warning', () => {
    const result = decodeScenario(`${SCENARIO_VERSION}~dvr~rounds~1_0_0_0~1_9_4~~`);
    expect(result.ok).toBe(true);
    expect(result.links).toEqual([]);
    expect(result.warnings.join(' ')).toContain('one end is missing');
  });

  test('a duplicated router is dropped rather than added twice', () => {
    const result = decodeScenario(`${SCENARIO_VERSION}~dvr~rounds~1_0_0_0,1_5_0_0~~~`);
    expect(result.routers).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('Skipped a router');
  });

  test('a router with no usable position is kept and placed automatically', () => {
    const result = decodeScenario(`${SCENARIO_VERSION}~dvr~rounds~1_x_y_z~~~`);
    expect(result.routers).toEqual([{ id: '1', isActive: true }]);
    expect(result.warnings.join(' ')).toContain('placing it automatically');
  });

  test('a setting this build has never heard of is ignored, not guessed at', () => {
    const result = decodeScenario(
      `${SCENARIO_VERSION}~dvr~rounds~1_0_0_0~~splitHorizon_0,invented_7~`
    );
    expect(result.options).toEqual({ splitHorizon: false });
    expect(result.warnings.join(' ')).toContain('invented');
  });

  test('a per-router knob of the wrong shape is ignored', () => {
    const result = decodeScenario(
      `${SCENARIO_VERSION}~pv~rounds~1_0_0_0~~~1_localPref_2_3_4,1_nonsense_5`
    );
    expect(result.routerOptions).toEqual({});
    expect(result.warnings).toHaveLength(2);
  });

  test('a truncated string yields what survived', () => {
    const full = encodeScenario(sim().getSnapshot(), POSITIONS);
    const cut = full.slice(0, full.indexOf('~', full.indexOf('~', full.indexOf('~') + 1) + 1));
    const result = decodeScenario(cut);
    // Version and protocol survived, so there is something to open.
    expect(result.ok).toBe(true);
    expect(result.protocolId).toBe('dvr');
    expect(result.links).toEqual([]);
  });

  test('a boolean written as a number and a number written as text both survive', () => {
    const result = decodeScenario(
      `${SCENARIO_VERSION}~dvr~rounds~1_0_0_0~~splitHorizon_1,infinityCost_12~`
    );
    expect(result.options).toEqual({ splitHorizon: true, infinityCost: 12 });
  });

  test('an unreadable seed falls back to the default rather than to NaN', () => {
    const result = decodeScenario(`${SCENARIO_VERSION}~dvr~timers_abc~1_0_0_0~~~`);
    expect(result.mode).toBe('timers');
    expect(result.seed).toBe(SIM.timers.defaultSeed);
  });
});

/* ------------------------------------------------------------------ *
 * The URL
 * ------------------------------------------------------------------ */

describe('the URL', () => {
  const HOST = 'https://example.test/sim';

  test('the scenario goes in the fragment, so it never reaches a server', () => {
    const url = scenarioUrl(sim().getSnapshot(), POSITIONS, HOST);
    expect(url.startsWith(`${HOST}#${SCENARIO_VERSION}~`)).toBe(true);
  });

  test('an existing fragment is replaced, not appended to', () => {
    const url = scenarioUrl(sim().getSnapshot(), POSITIONS, `${HOST}#v1~old~stuff`);
    expect(url.split('#')).toHaveLength(2);
    expect(url.startsWith(`${HOST}#`)).toBe(true);
  });

  test('a query string is preserved', () => {
    const url = scenarioUrl(sim().getSnapshot(), POSITIONS, `${HOST}?a=1`);
    expect(url.startsWith(`${HOST}?a=1#`)).toBe(true);
  });

  test('reading it back gives the same string', () => {
    const snapshot = sim().getSnapshot();
    const url = scenarioUrl(snapshot, POSITIONS, HOST);
    expect(scenarioFromUrl(url)).toBe(encodeScenario(snapshot, POSITIONS));
  });

  test('a percent-encoded fragment is decoded first', () => {
    const text = encodeScenario(sim().getSnapshot(), POSITIONS);
    expect(scenarioFromUrl(`${HOST}#${encodeURIComponent(text)}`)).toBe(text);
  });

  test('a malformed escape is used as it came rather than throwing', () => {
    // `%` on its own is not a valid escape; decodeURIComponent throws on it.
    expect(() => scenarioFromUrl(`${HOST}#${SCENARIO_VERSION}~dvr~100%`)).not.toThrow();
  });

  test('a URL with no scenario in it reads as none', () => {
    expect(scenarioFromUrl(HOST)).toBeNull();
    expect(scenarioFromUrl(`${HOST}#`)).toBeNull();
    expect(scenarioFromUrl(`${HOST}#something-else`)).toBeNull();
    expect(scenarioFromUrl('')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Awkward topologies
 * ------------------------------------------------------------------ */

describe('edge cases', () => {
  test('an empty network round-trips to an empty network', () => {
    const simulation = new Simulation(undefined, 'dvr');
    const text = encodeScenario(simulation.getSnapshot(), {});
    const scenario = decodeScenario(text);
    expect(scenario.ok).toBe(true);
    expect(scenario.routers).toEqual([]);
    expect(scenario.links).toEqual([]);
  });

  test('a single router with no links round-trips', () => {
    const simulation = new Simulation(undefined, 'dvr');
    simulation.addRouter('7');
    const { rebuilt } = roundTrip(simulation, { 7: { x: 1, y: 2, z: 3 } });
    expect(rebuilt.routerIds).toEqual(['7']);
  });

  test('ids that would break the format are dropped rather than corrupting it', () => {
    // Nothing the app generates contains a separator — `nextFreeId` counts and
    // every preset is numeric — but a hand-built topology could, and half a
    // scenario is worse than an obviously incomplete one. A dot is *not* one of
    // them: it is the decimal point, which is exactly why it is not a separator.
    const simulation = new Simulation(undefined, 'dvr');
    ['a_b', 'c,d', 'e~f', 'g.h', '2'].forEach((id) => simulation.addRouter(id));
    const text = encodeScenario(simulation.getSnapshot(), { '2': { x: 0, y: 0, z: 0 } });
    const scenario = decodeScenario(text);
    expect(scenario.routers.map((router) => router.id).sort()).toEqual(['2', 'g.h']);
  });

  test('ids sort numerically in the string, so it reads in router order', () => {
    const simulation = new Simulation(undefined, 'dvr');
    ['9', '10', '2'].forEach((id) => simulation.addRouter(id));
    const text = encodeScenario(simulation.getSnapshot(), {});
    const ids = text.split('~')[3].split(',').map((record) => record.split('_')[0]);
    expect(ids).toEqual(['2', '9', '10']);
  });

  test('a spanning-tree scenario with a priority round-trips', () => {
    const simulation = sim('stp');
    simulation.setRouterOption('4', 'priority', 4096);
    const { rebuilt } = roundTrip(simulation);
    expect(rebuilt.routerOption('4', 'priority')).toBe(4096);
    rebuilt.runToConvergence();
    expect(rebuilt.metrics()[0].value).toBe('4');
  });

  test('a timer-mode scenario replays identically from the link', () => {
    const original = sim('dvr', undefined, { mode: 'timers', seed: 12 });
    const { rebuilt } = roundTrip(original);
    original.runToConvergence();
    rebuilt.runToConvergence();
    expect(rebuilt.getSnapshot().tables).toEqual(original.getSnapshot().tables);
    expect(rebuilt.time).toBe(original.time);
  });
});
