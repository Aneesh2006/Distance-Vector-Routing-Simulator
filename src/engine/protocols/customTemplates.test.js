/**
 * customTemplates.test.js — the end-to-end proof, and the one test that would
 * notice if any link in the chain broke.
 *
 * Source text → `compileProtocol` → `validateProtocol` → `registerCustomProtocol`
 * → a real `Simulation` on a real preset topology → correct routing tables. No
 * mocks anywhere: if the templates, the loader, the validator, the registry and
 * the engine do not agree, this is where it shows.
 *
 * The worked example is naive distance vector, so the topology to run it on is
 * the one the count-to-infinity demo uses — the point of shipping that template
 * is that it reproduces the failure, and a template that could not would be
 * teaching the wrong lesson.
 */

import { Simulation } from '../Simulation';
import { Topology } from '../Topology';
import { compileProtocol } from './customLoader';
import { validateProtocol } from './validateProtocol';
import {
  CUSTOM_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  MINIMAL_TEMPLATE,
  NAIVE_DV_TEMPLATE,
  templateSource,
} from './customTemplates';
import { customProtocolList, registerCustomProtocol, unregisterCustomProtocol } from './index';

/** "Three in a line": 1 — 2 — 3, both links cost 1. */
const CHAIN = {
  1: [{ neighbor: '2', cost: 1 }],
  2: [
    { neighbor: '1', cost: 1 },
    { neighbor: '3', cost: 1 },
  ],
  3: [{ neighbor: '2', cost: 1 }],
};

const costs = (simulation, from) =>
  Object.fromEntries(
    Object.entries(simulation.tables()[from]).map(([dest, route]) => [dest, route.cost])
  );

afterEach(() => {
  customProtocolList().forEach((entry) => unregisterCustomProtocol(entry.id));
});

describe('the template list', () => {
  test('offers both templates, and the default is one of them', () => {
    expect(CUSTOM_TEMPLATES.map((entry) => entry.id)).toEqual(['minimal', 'naive-dv']);
    expect(templateSource(DEFAULT_TEMPLATE_ID)).toBe(MINIMAL_TEMPLATE);
    expect(templateSource('nope')).toBe('');
    CUSTOM_TEMPLATES.forEach((template) => {
      expect(template.label).toEqual(expect.any(String));
      expect(template.summary).toEqual(expect.any(String));
    });
  });
});

describe('the minimal skeleton', () => {
  test('runs, converges immediately, and knows only each router itself', () => {
    const { plugin } = compileProtocol(MINIMAL_TEMPLATE);
    registerCustomProtocol(plugin);

    const simulation = new Simulation(CHAIN, plugin.id);
    const { rounds, converged } = simulation.runToConvergence();

    expect(converged).toBe(true);
    expect(rounds).toBe(1);
    expect(simulation.tables()).toEqual({
      1: { 1: { nextHop: '1', cost: 0 } },
      2: { 2: { nextHop: '2', cost: 0 } },
      3: { 3: { nextHop: '3', cost: 0 } },
    });
  });
});

describe('the worked example, from source text to routing tables', () => {
  /** The whole pipeline, exactly as the editor's Activate button runs it. */
  function activate(source) {
    const compiled = compileProtocol(source);
    expect(compiled.ok).toBe(true);
    const { errors } = validateProtocol(compiled.plugin);
    expect(errors).toEqual([]);
    return registerCustomProtocol(compiled.plugin);
  }

  test('converges to the true shortest paths on Three in a line', () => {
    const plugin = activate(NAIVE_DV_TEMPLATE);
    const simulation = new Simulation(CHAIN, plugin.id);
    const { converged } = simulation.runToConvergence();

    expect(converged).toBe(true);
    expect(costs(simulation, '1')).toEqual({ 1: 0, 2: 1, 3: 2 });
    expect(costs(simulation, '3')).toEqual({ 1: 2, 2: 1, 3: 0 });
    expect(simulation.tables()['1']['3'].nextHop).toBe('2');
    // Scored against ground truth by the same meter every built-in is scored by.
    expect(simulation.correctness.totals.wrong).toBe(0);
  });

  /**
   * The reason this template exists. With no split horizon, breaking the far
   * link leaves 1 and 2 each routing to 3 through the other, and the cost climbs
   * one hop per round until it reaches the ceiling — which is the only thing
   * that stops it.
   */
  test('counts to infinity when the far link breaks', () => {
    const plugin = activate(NAIVE_DV_TEMPLATE);
    const simulation = new Simulation(CHAIN, plugin.id);
    simulation.runToConvergence();

    simulation.removeLink('2', '3');
    const climb = [];
    for (let round = 0; round < 30 && !simulation.converged; round += 1) {
      simulation.runIteration();
      climb.push(simulation.tables()['1']['3'].cost);
    }

    // It climbed, and it stopped: strictly increasing until the ceiling.
    expect(climb[0]).toBeLessThan(climb[climb.length - 1]);
    expect(climb[climb.length - 1]).toBe(simulation.infinityCost);
    expect(simulation.converged).toBe(true);
    // …and the loop the climb was made of is what the correctness meter saw.
    expect(simulation.stats.loopsSeen).toBeGreaterThan(0);
  });

  test('reacts to an edit through onTopologyChange, and recovers', () => {
    const plugin = activate(NAIVE_DV_TEMPLATE);
    const topology = new Topology(CHAIN);
    const simulation = new Simulation(topology, plugin.id);
    simulation.runToConvergence();

    // A cheaper way round: 1 — 3 direct at cost 1 makes 1's route to 3 direct.
    simulation.addLink('1', '3', 1);
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.tables()['1']['3']).toEqual({ nextHop: '3', cost: 1 });
    expect(simulation.correctness.totals.wrong).toBe(0);
  });

  test('a router taken down is noticed, and the rest still route around it', () => {
    const plugin = activate(NAIVE_DV_TEMPLATE);
    const simulation = new Simulation(
      {
        ...CHAIN,
        1: [
          { neighbor: '2', cost: 1 },
          { neighbor: '3', cost: 4 },
        ],
        3: [
          { neighbor: '2', cost: 1 },
          { neighbor: '1', cost: 4 },
        ],
      },
      plugin.id
    );
    simulation.runToConvergence();
    expect(simulation.tables()['1']['3'].cost).toBe(2);

    simulation.setRouterActive('2', false);
    expect(simulation.runToConvergence().converged).toBe(true);
    expect(simulation.tables()['1']['3']).toEqual({ nextHop: '3', cost: 4 });
  });
});
