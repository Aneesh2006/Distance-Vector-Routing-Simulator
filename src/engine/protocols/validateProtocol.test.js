/**
 * validateProtocol.test.js — the gate a user-written plugin has to get through.
 *
 * Two halves, tested as two: the contract check reads the shape and must name
 * the field it is unhappy about, and the smoke test runs the thing on a real
 * four-router network and must catch the behaviours that make a plugin unusable
 * rather than merely wrong.
 *
 * The distinction under test throughout is errors versus warnings. An error
 * means the app would crash or hang; a warning means it will look odd. A
 * protocol that converges on the wrong answer is a *warning*, and deliberately
 * so — half the point of this simulator is watching protocols be wrong.
 */

import { validateProtocol } from './validateProtocol';
import { compileProtocol } from './customLoader';
import { NAIVE_DV_TEMPLATE, MINIMAL_TEMPLATE } from './customTemplates';
import { customProtocolList } from './index';

/** A plugin that satisfies the contract and routes correctly, to vary from. */
function workingPlugin(overrides = {}) {
  return {
    id: 'test-proto',
    name: 'Test Protocol',
    summary: 'Floods link costs and runs Bellman-Ford.',
    messageLabel: 'TP',
    options: [{ key: 'infinityCost', label: 'Infinity', type: 'number', default: 16 }],
    columns: [
      { key: 'cost', label: 'Cost', format: 'cost' },
      { key: 'nextHop', label: 'Next Hop', format: 'id' },
    ],

    createState() {
      return { vectors: {}, tables: {} };
    },

    round(state, topology, options) {
      const messages = [];
      topology.routerIds.forEach((from) => {
        if (!topology.isActive(from)) return;
        const vector = {};
        Object.entries(state.tables[from] || {}).forEach(([dest, route]) => {
          vector[dest] = route.cost;
        });
        topology.neighborsOf(from).forEach((to) => {
          if (!topology.canReach(from, to)) return;
          messages.push({ from, to, kind: 'dv', payload: vector });
        });
      });
      messages.forEach(({ from, to, payload }) => {
        state.vectors[to] = { ...(state.vectors[to] || {}), [from]: payload };
      });
      return { messages, changed: rebuild(state, topology, options) };
    },

    onTopologyChange(state, topology, options, event) {
      if (event.type === 'removeLink') {
        delete (state.vectors[String(event.a)] || {})[String(event.b)];
        delete (state.vectors[String(event.b)] || {})[String(event.a)];
      }
      rebuild(state, topology, options);
    },

    tables(state) {
      return state.tables;
    },

    ...overrides,
  };
}

/** Plain Bellman-Ford over whatever vectors have been heard. */
function rebuild(state, topology, options) {
  const infinity = options.infinityCost;
  const ids = topology.routerIds;
  const previous = state.tables;
  const next = {};
  let changed = ids.length !== Object.keys(previous).length;

  ids.forEach((id) => {
    const table = {};
    ids.forEach((dest) => {
      if (dest === id) {
        table[dest] = { nextHop: id, cost: 0 };
        return;
      }
      let bestCost = infinity;
      let bestHop = null;
      if (topology.isActive(id)) {
        topology.neighborsOf(id).forEach((neighbor) => {
          if (!topology.canReach(id, neighbor)) return;
          const heard = (state.vectors[id] || {})[neighbor];
          const claimed =
            neighbor === dest ? 0 : heard && heard[dest] !== undefined ? heard[dest] : infinity;
          const total = Math.min(infinity, topology.linkCost(id, neighbor) + claimed);
          if (total < bestCost) {
            bestCost = total;
            bestHop = neighbor;
          }
        });
      }
      table[dest] =
        bestHop === null ? { nextHop: null, cost: infinity } : { nextHop: bestHop, cost: bestCost };
    });
    next[id] = table;
    const before = previous[id];
    if (!before || JSON.stringify(before) !== JSON.stringify(table)) changed = true;
  });

  state.tables = next;
  return changed;
}

const failsWith = (plugin, pattern) => {
  const { errors } = validateProtocol(plugin);
  expect(errors.join('\n')).toMatch(pattern);
  return errors;
};

describe('a plugin that satisfies the contract', () => {
  test('passes with no errors at all', () => {
    const { errors, warnings } = validateProtocol(workingPlugin());
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('leaves the registry exactly as it found it', () => {
    const before = customProtocolList().length;
    validateProtocol(workingPlugin());
    validateProtocol(workingPlugin({ round: () => ({ messages: [], changed: true }) }));
    expect(customProtocolList()).toHaveLength(before);
  });
});

describe('the required fields', () => {
  test.each([
    ['id', /`id`/],
    ['name', /`name`/],
    ['summary', /`summary`/],
    ['messageLabel', /`messageLabel`/],
    ['createState', /`createState`/],
    ['round', /`round`/],
    ['tables', /`tables`/],
    ['options', /`options`/],
    ['columns', /`columns`/],
  ])('missing %s is a named error', (field, pattern) => {
    const plugin = workingPlugin();
    delete plugin[field];
    failsWith(plugin, pattern);
  });

  test('an id that collides with a built-in is refused', () => {
    failsWith(workingPlugin({ id: 'dvr' }), /built-in/);
  });

  test('an id with a scenario separator in it only warns', () => {
    const { errors, warnings } = validateProtocol(workingPlugin({ id: 'my_protocol' }));
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/link/);
  });

  test('a required field of the wrong type is as much an error as a missing one', () => {
    failsWith(workingPlugin({ messageLabel: 42 }), /`messageLabel`/);
    failsWith(workingPlugin({ round: 'soon' }), /`round`/);
    failsWith(workingPlugin({ options: {} }), /`options`/);
  });
});

describe('the option and column schemas', () => {
  test('an option without a default is an error — the schema is where defaults come from', () => {
    failsWith(
      workingPlugin({ options: [{ key: 'a', label: 'A', type: 'boolean' }] }),
      /options\[0\]\.default/
    );
  });

  test('an option type outside boolean | number is an error', () => {
    failsWith(
      workingPlugin({ options: [{ key: 'a', label: 'A', type: 'string', default: 'x' }] }),
      /options\[0\]\.type/
    );
  });

  test('a duplicate option key is an error', () => {
    failsWith(
      workingPlugin({
        options: [
          { key: 'a', label: 'A', type: 'number', default: 1 },
          { key: 'a', label: 'Again', type: 'number', default: 2 },
        ],
      }),
      /declared twice/
    );
  });

  test('an unknown column format only warns — it renders as text', () => {
    const { errors, warnings } = validateProtocol(
      workingPlugin({
        columns: [{ key: 'cost', label: 'Cost', format: 'sparkline' }],
      })
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/plain text/);
  });

  test('a legend colour outside the palette warns rather than blocks', () => {
    const { errors, warnings } = validateProtocol(
      workingPlugin({ legend: [{ colorKey: 'chartreuse', label: 'Nope' }] })
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/palette/);
  });
});

describe('the smoke test', () => {
  test('a round() that throws is caught and reported', () => {
    failsWith(
      workingPlugin({
        round() {
          throw new Error('kaboom');
        },
      }),
      /kaboom/
    );
  });

  test('a protocol that never converges is caught rather than hung on', () => {
    failsWith(
      workingPlugin({
        round: () => ({ messages: [], changed: true }),
      }),
      /never converged/
    );
  });

  test('round() must return the documented shape', () => {
    failsWith(workingPlugin({ round: () => undefined }), /must return an object/);
    failsWith(workingPlugin({ round: () => ({ changed: false }) }), /`messages` array/);
    failsWith(workingPlugin({ round: () => ({ messages: [] }) }), /true or false/);
  });

  test('a message with no kind is an error', () => {
    failsWith(
      workingPlugin({ round: () => ({ messages: [{ from: '1', to: '2' }], changed: false }) }),
      /`kind`/
    );
  });

  test('a message between routers that are not neighbours is only a warning', () => {
    // 1 and 4 are three hops apart on the smoke topology. Real routers cannot
    // do this; a simulator that refused to draw it would be less useful.
    const { errors, warnings } = validateProtocol(
      workingPlugin({
        round: () => ({ messages: [{ from: '1', to: '4', kind: 'x' }], changed: false }),
      })
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/not a link/);
  });

  test('a dishonest `changed` after convergence is an error, not a warning', () => {
    // Settles, then claims a change on the very next round — which is what makes
    // "Run to Convergence" a loop that never ends.
    let settled = false;
    failsWith(
      workingPlugin({
        round(state, topology, options) {
          if (settled) return { messages: [], changed: true };
          settled = true;
          return { messages: [], changed: false };
        },
      }),
      /`changed: true`/
    );
  });

  test('tables() must hand back routes, not just anything', () => {
    failsWith(workingPlugin({ tables: () => ({ 1: { 2: 'over there' } }) }), /route object/);
    failsWith(workingPlugin({ tables: () => ({ 1: { 2: { cost: 3 } } }) }), /nextHop/);
    failsWith(workingPlugin({ tables: () => ({ 1: { 2: { nextHop: '3' } } }) }), /cost/);
  });

  test('a protocol whose rows are not routes opts out of the route checks', () => {
    const { errors } = validateProtocol(
      workingPlugin({
        hasRoutingTables: false,
        tables: (state, topology) =>
          Object.fromEntries(topology.routerIds.map((id) => [id, { p1: { role: 'root' } }])),
      })
    );
    expect(errors).toEqual([]);
  });

  /**
   * The rule this whole file exists to protect: being wrong is allowed. A
   * teaching protocol whose entire purpose is to converge on a lie must run.
   */
  test('converging on the wrong answer is a warning, and it still activates', () => {
    const { errors, warnings } = validateProtocol(
      workingPlugin({
        tables: (state, topology) =>
          Object.fromEntries(
            topology.routerIds.map((id) => [
              id,
              Object.fromEntries(
                topology.routerIds.map((dest) => [
                  dest,
                  dest === id ? { nextHop: id, cost: 0 } : { nextHop: null, cost: 16 },
                ])
              ),
            ])
          ),
      })
    );

    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/shortest paths/);
  });

  /**
   * The second convergence is not padding: `onTopologyChange` is the hook a
   * first attempt is likeliest to get wrong, and a plugin that settles
   * beautifully from cold and then falls apart on a failure is exactly what the
   * link break is there to find.
   */
  test('a protocol that never settles again after a link breaks is caught', () => {
    const base = workingPlugin();
    let edited = false;

    failsWith(
      workingPlugin({
        onTopologyChange(state, topology, options, event) {
          if (event.type === 'removeLink') edited = true;
          base.onTopologyChange(state, topology, options, event);
        },
        round(state, topology, options) {
          const result = base.round(state, topology, options);
          return edited ? { ...result, changed: true } : result;
        },
      }),
      /breaking link 2 ↔ 3/
    );
  });

  test('the shape-only mode never runs the plugin', () => {
    let ran = false;
    const { errors } = validateProtocol(
      workingPlugin({
        round() {
          ran = true;
          return { messages: [], changed: false };
        },
      }),
      { smokeTest: false }
    );

    expect(errors).toEqual([]);
    expect(ran).toBe(false);
  });
});

describe('timer mode', () => {
  test('a startTimers that throws is reported', () => {
    failsWith(
      workingPlugin({
        startTimers() {
          throw new Error('no clock here');
        },
      }),
      /no clock here/
    );
  });

  test('a zero-delay timer that reschedules itself is caught, not run', () => {
    failsWith(
      workingPlugin({
        startTimers(state, topology, options, clock) {
          const tick = () => clock.schedule(0, tick);
          tick();
        },
      }),
      /freeze the tab/
    );
  });

  test('a protocol that registers no repeating timer is only warned about', () => {
    const { errors, warnings } = validateProtocol(
      workingPlugin({
        startTimers(state, topology, options, clock) {
          clock.log('nothing to do');
        },
      })
    );
    expect(errors).toEqual([]);
    expect(warnings.join('\n')).toMatch(/ran out of scheduled events/);
  });
});

describe('the shipped templates', () => {
  test('the minimal skeleton validates with no errors', () => {
    const compiled = compileProtocol(MINIMAL_TEMPLATE);
    expect(compiled.ok).toBe(true);

    const { errors } = validateProtocol(compiled.plugin);
    expect(errors).toEqual([]);
  });

  test('the worked example validates with no errors and no warnings', () => {
    const compiled = compileProtocol(NAIVE_DV_TEMPLATE);
    expect(compiled.ok).toBe(true);

    const { errors, warnings } = validateProtocol(compiled.plugin);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
