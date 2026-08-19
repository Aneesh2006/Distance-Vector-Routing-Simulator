/**
 * customTemplates.js — the two starting points the editor offers.
 *
 * Both are plain source text, not objects: they are what appears in the editor,
 * so they have to read as something a person would write rather than as
 * something a serialiser produced. Both compile, validate and run exactly as
 * they stand, because a first click that lands on an error teaches nothing about
 * the protocol and everything about the tooling.
 *
 *   1. **Minimal skeleton** — every required field, each under the line of the
 *      contract it satisfies, and nothing else. It converges immediately and is
 *      wrong about everything, which is the honest floor to build up from.
 *   2. **Worked example** — naive distance vector, no split horizon: enough to
 *      watch packets fly and count-to-infinity happen, short enough to read in
 *      one sitting.
 *
 * Both live inside template literals here, so a backtick in the source text has
 * to be written escaped and `${` avoided altogether. That is the only
 * constraint on them.
 *
 * The five *built-in* protocols are offered from the same menu (see
 * `builtinTemplates`), but they are not written out here — they are extracted
 * from the real modules by `scripts/protocolSourceTransform.cjs`, because a
 * hand-written copy of a thousand-line protocol would be a second
 * implementation, wrong within a week.
 */

import { PROTOCOLS } from './index';
import { BUILTIN_SOURCES } from './builtinSources.generated';

export const MINIMAL_TEMPLATE = `// Minimal skeleton — every field the plugin contract requires, and nothing
// else. It compiles, validates and runs as it stands; it simply never says
// anything, so every router knows only itself.
//
// (The validator will warn that the tables do not match the shortest paths.
// Of course they do not — that is the exercise. Warnings do not block
// activation; only errors do.)
//
// Two names are in scope, the same two every built-in protocol imports:
//
//   helpers — compareIds, tablesEqual, cloneTable, cloneTables,
//             multipathRoute, nextHopsOf, formatCost
//   config  — the SIM object from config.js, frozen
//
// The last line has to be:  return protocol;

const protocol = {
  // id, name, summary, messageLabel — the four required strings.
  id: 'mine',
  name: 'My Protocol',
  summary: 'Routers keep themselves to themselves.',
  messageLabel: 'MSG', // the caption on a packet in the scene

  // options: [{ key, label, type: 'boolean' | 'number', default, min, max,
  //             step, enabledWhen }]  — also where the defaults come from.
  options: [
    {
      key: 'infinityCost',
      label: 'Infinity',
      type: 'number',
      default: config.defaultInfinityCost,
      min: config.minInfinityCost,
      max: config.maxInfinityCost,
    },
  ],

  // columns: [{ key, label, format }]
  //   format: 'cost' | 'id' | 'hops' | 'path' | 'list' | 'text'
  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    { key: 'nextHop', label: 'Next Hop', format: 'id' },
  ],

  // createState(topology, options) -> state
  // Whatever your routers remember. It is thrown away and rebuilt whenever the
  // protocol, the mode or the seed changes.
  createState(topology, options) {
    return {};
  },

  // round(state, topology, options) -> { messages, changed }
  // One synchronous round: every router speaks, every router listens.
  // \`changed\` must be false when and only when nothing a router believes has
  // moved — "Run to Convergence" is a while (changed) loop.
  round(state, topology, options) {
    return { messages: [], changed: false };
  },

  // tables(state, topology, options) -> { routerId: { dest: { nextHop, cost } } }
  // The view every panel renders from: the routing table, the correctness
  // meter, the path finder and the route-tree overlay all read this.
  tables(state, topology, options) {
    const view = {};
    topology.routerIds.forEach(function (id) {
      view[id] = { [id]: { nextHop: id, cost: 0 } };
    });
    return view;
  },
};

return protocol;
`;

export const NAIVE_DV_TEMPLATE = `// Naive distance vector — Bellman-Ford with no loop avoidance at all.
//
// Every router tells its neighbours its best cost to every destination, then
// rebuilds its own table from what it has been told:
//
//     D(x, dest) = min over neighbours n of [ c(x, n) + D(n, dest) ]
//
// There is no split horizon and no poisoned reverse, which is the point: load
// "Three in a line", converge, then break link 2 - 3 and watch the costs climb
// one hop at a time until they hit the infinity ceiling. That is
// count-to-infinity, and the finite ceiling is the only thing that stops it.
//
// Two rules matter more than the arithmetic, and both are marked below:
//   1. Build every outbound message BEFORE applying any of them. Otherwise a
//      round's result depends on the order the routers happen to be visited in.
//   2. \`changed\` must never lie. Report a change that did not happen and the
//      simulation never converges; miss one and it stops early on a wrong answer.

// What a router would put in an update: its cost to every destination it knows.
// Naive, so it holds nothing back from anyone.
function vectorOf(table) {
  const vector = {};
  Object.keys(table).forEach(function (dest) {
    vector[dest] = table[dest].cost;
  });
  return vector;
}

// Rebuild every table from the vectors currently held. Deriving the tables
// rather than patching them in place is what makes a round order-independent.
// Returns whether anything actually moved — rule 2.
function recompute(state, topology, options) {
  const infinity = options.infinityCost;
  const ids = topology.routerIds;
  const previous = state.tables;
  const next = {};
  let changed = ids.length !== Object.keys(previous).length;

  ids.forEach(function (id) {
    const table = {};

    ids.forEach(function (dest) {
      if (dest === id) {
        table[dest] = { nextHop: id, cost: 0 };
        return;
      }

      let bestCost = infinity;
      let bestHop = null;

      if (topology.isActive(id)) {
        topology.neighborsOf(id).forEach(function (neighbor) {
          if (!topology.canReach(id, neighbor)) return;
          const heard = state.vectors[id] && state.vectors[id][neighbor];
          // The direct link is a candidate even before the neighbour has said
          // anything; anything further is only as good as what it claimed.
          const claimed =
            neighbor === dest ? 0 : heard && heard[dest] !== undefined ? heard[dest] : infinity;
          const total = Math.min(infinity, topology.linkCost(id, neighbor) + claimed);
          if (total < bestCost) {
            bestCost = total;
            bestHop = neighbor;
          }
        });
      }

      table[dest] = bestHop === null ? { nextHop: null, cost: infinity } : {
        nextHop: bestHop,
        cost: bestCost,
      };
    });

    next[id] = table;
    // helpers.tablesEqual compares hops and costs, which is exactly what a
    // change means here. Guessing instead is how a plugin hangs the app.
    if (!previous[id] || !helpers.tablesEqual(previous[id], table)) changed = true;
  });

  state.tables = next;
  return changed;
}

const protocol = {
  id: 'naive-dv',
  name: 'Naive Distance Vector',
  summary: 'Bellman-Ford with no split horizon — it counts to infinity, on purpose.',
  messageLabel: 'DV',

  options: [
    {
      key: 'infinityCost',
      label: 'Infinity',
      type: 'number',
      default: config.defaultInfinityCost,
      min: config.minInfinityCost,
      max: config.maxInfinityCost,
    },
  ],

  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    { key: 'nextHop', label: 'Next Hop', format: 'id' },
  ],

  legend: [{ colorKey: 'packet', label: 'Distance vector in flight' }],

  help: [
    {
      heading: 'Count to infinity',
      items: [
        'Load "Three in a line", run to convergence, then delete link 2 - 3.',
        'Routers 1 and 2 now believe each other about a destination neither can ' +
          'reach, and each round adds one hop to the lie.',
        'It ends only because the Infinity setting is a small finite ceiling. ' +
          'Raise it and the count takes longer; that is the whole trade RIP makes.',
      ],
    },
  ],

  createState(topology, options) {
    // vectors: routerId -> (neighbourId -> the last vector heard from it)
    const state = { vectors: {}, tables: {} };
    recompute(state, topology, options);
    return state;
  },

  round(state, topology, options) {
    // Phase 1 — build everything that is going out, from tables nobody has
    // touched yet. Rule 1.
    const messages = [];
    topology.routerIds.forEach(function (from) {
      if (!topology.isActive(from)) return;
      const payload = vectorOf(state.tables[from] || {});
      topology.neighborsOf(from).forEach(function (to) {
        if (!topology.canReach(from, to)) return;
        messages.push({ from: from, to: to, kind: 'dv', payload: payload });
      });
    });

    // Phase 2 — deliver, then derive.
    messages.forEach(function (message) {
      if (!state.vectors[message.to]) state.vectors[message.to] = {};
      state.vectors[message.to][message.from] = message.payload;
    });

    return { messages: messages, changed: recompute(state, topology, options) };
  },

  // Forget only what has genuinely become unhearable, then re-derive. The
  // routers at the two ends of a broken link notice at once; everybody else
  // keeps believing what they were last told, which is the honest picture.
  onTopologyChange(state, topology, options, event) {
    if (event.type === 'removeLink') {
      const a = String(event.a);
      const b = String(event.b);
      if (state.vectors[a]) delete state.vectors[a][b];
      if (state.vectors[b]) delete state.vectors[b][a];
    }
    if (event.type === 'removeRouter' || (event.type === 'setRouterActive' && !event.active)) {
      const gone = String(event.id);
      delete state.vectors[gone];
      Object.keys(state.vectors).forEach(function (id) {
        delete state.vectors[id][gone];
      });
    }
    recompute(state, topology, options);
  },

  tables(state) {
    return state.tables;
  },
};

return protocol;
`;

/** The blank-page starting points, in menu order. */
export const CUSTOM_TEMPLATES = [
  {
    id: 'minimal',
    label: 'Minimal skeleton',
    summary: 'Every required field, one comment each, and no behaviour at all.',
    source: MINIMAL_TEMPLATE,
  },
  {
    id: 'naive-dv',
    label: 'Worked example — naive distance vector',
    summary: 'Bellman-Ford with no split horizon, so it counts to infinity.',
    source: NAIVE_DV_TEMPLATE,
  },
];

export const DEFAULT_TEMPLATE_ID = CUSTOM_TEMPLATES[0].id;

/* ------------------------------------------------------------------ *
 * The built-ins, opened for editing
 * ------------------------------------------------------------------ */

/** Menu ids for the built-ins are namespaced so they cannot collide. */
export const BUILTIN_TEMPLATE_PREFIX = 'builtin:';

/**
 * Every shipped protocol as an editable copy of itself.
 *
 * The most useful starting point for "write a routing protocol" is rarely a
 * blank page — it is distance vector with the split-horizon rule in front of
 * you, or link state with its flooding loop, ready to be changed. So the same
 * menu that offers the two templates offers all five implementations, and what
 * opens is the real file rather than a retelling of it: the source is extracted
 * from the modules at build time (`npm run build:sources`), with a test that
 * fails the moment the extract falls behind.
 *
 * The label and summary come from the live plugin objects, so a protocol
 * renamed in its own file is renamed here too, with nothing to remember.
 */
export function builtinTemplates() {
  return PROTOCOLS.filter((protocol) => BUILTIN_SOURCES[protocol.id]).map((protocol) => ({
    id: `${BUILTIN_TEMPLATE_PREFIX}${protocol.id}`,
    label: protocol.name,
    summary: protocol.summary,
    source: BUILTIN_SOURCES[protocol.id],
    builtin: true,
  }));
}

/** Both groups, templates first — the menu's order. */
export function allTemplates() {
  return [...CUSTOM_TEMPLATES, ...builtinTemplates()];
}

export function findTemplate(id) {
  return allTemplates().find((entry) => entry.id === id) || null;
}

export function templateSource(id) {
  const template = findTemplate(id);
  return template ? template.source : '';
}
