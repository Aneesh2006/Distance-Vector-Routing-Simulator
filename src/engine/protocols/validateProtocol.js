/**
 * validateProtocol.js — does this object actually satisfy the plugin contract,
 * and does it survive being run?
 *
 * `compileProtocol` only proves the source is JavaScript that returned an
 * object. Everything the app assumes about that object is checked here, in two
 * passes that answer two different questions:
 *
 *   1. **The contract check** reads the shape without running anything. It is
 *      what turns "Cannot read properties of undefined" three renders later into
 *      "`messageLabel` is required — it captions the packets in the scene".
 *   2. **The smoke test** registers the plugin under a throwaway id, builds a
 *      hidden four-router network — a triangle so there is a loop to get wrong,
 *      plus a tail so there is a leaf — and actually converges it, breaks a link,
 *      converges it again, and (if the plugin declared timers) runs it on the
 *      clock. Almost everything that makes a plugin unusable in the app is a
 *      behaviour rather than a missing field, and this is where those show up.
 *
 * ── Errors and warnings ─────────────────────────────────────────────────
 *
 * An **error** blocks activation: the app would crash, hang, or render nothing.
 * A **warning** does not, and the distinction is not squeamishness — a protocol
 * that gets the wrong answer is a perfectly good thing to build here. Half the
 * point of the simulator is watching distance vector count to infinity, and a
 * teaching protocol whose whole purpose is to be wrong must be allowed to run
 * and be scored wrong by the correctness meter. So "your converged tables do not
 * match the shortest paths" is information, not a refusal.
 *
 * The one behaviour that *is* an error rather than a warning is a dishonest
 * `changed` flag, because "run to convergence" is a `while (changed)` loop: a
 * plugin that reports change for ever does not produce a wrong answer, it
 * produces a frozen tab.
 */

import { COLORS } from '../../config';
import { Simulation } from '../Simulation';
import { Topology } from '../Topology';
import { isBuiltinProtocolId, registerCustomProtocol, unregisterCustomProtocol } from './index';

/* ------------------------------------------------------------------ *
 * What the contract allows
 * ------------------------------------------------------------------ */

const OPTION_TYPES = ['boolean', 'number'];
const COLUMN_FORMATS = ['cost', 'id', 'hops', 'path', 'list', 'text'];
const MODES = ['rounds', 'timers'];
const CONTROL_SCOPES = ['router', 'neighbor'];

const REQUIRED_STRINGS = [
  ['id', 'the value a share link and the protocol dropdown identify it by'],
  ['name', 'what the dropdown, the help dialog and the comparison table call it'],
  ['summary', 'the one-line description under the Protocol panel'],
  ['messageLabel', 'the caption on the packets in the scene'],
];

const REQUIRED_FUNCTIONS = [
  ['createState', 'createState(topology, options) -> state'],
  ['round', 'round(state, topology, options) -> { messages, changed }'],
  ['tables', 'tables(state, topology, options) -> { routerId: { dest: route } }'],
];

const OPTIONAL_FUNCTIONS = [
  'onTopologyChange',
  'startTimers',
  'isSettled',
  'decorations',
  'metrics',
  'inspect',
];

/** Ids with a separator in them corrupt the positional scenario encoding. */
const UNSAFE_ID = /[~,_]/;

/* ------------------------------------------------------------------ *
 * Collecting what went wrong
 * ------------------------------------------------------------------ */

/** How many times one kind of complaint is worth repeating. */
const MAX_REPEATS = 4;

/**
 * A de-duplicating, self-capping list.
 *
 * A plugin that gets one thing wrong usually gets it wrong in every round and
 * for every router, and forty copies of the same sentence hide the other three
 * problems underneath them.
 */
function collector() {
  const seen = new Set();
  const items = [];
  const counts = new Map();

  return {
    items,
    add(message, group = message) {
      if (seen.has(message)) return;
      const count = (counts.get(group) || 0) + 1;
      counts.set(group, count);
      if (count > MAX_REPEATS) {
        const note = `…and more of the same (${group}).`;
        if (!seen.has(note)) {
          seen.add(note);
          items.push(note);
        }
        return;
      }
      seen.add(message);
      items.push(message);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Pass 1 — the shape
 * ------------------------------------------------------------------ */

const isFilledString = (value) => typeof value === 'string' && value.trim() !== '';

function checkOptions(plugin, error, warn) {
  const { options } = plugin;
  if (!Array.isArray(options)) {
    error('`options` must be an array (use `[]` for a protocol with no settings).');
    return;
  }

  const keys = new Set();
  const booleans = new Set(
    options.filter((option) => option && option.type === 'boolean').map((option) => option.key)
  );

  options.forEach((option, index) => {
    const at = `options[${index}]`;
    if (!option || typeof option !== 'object') {
      error(`${at} must be an object like { key, label, type, default }.`);
      return;
    }
    if (!isFilledString(option.key)) error(`${at}.key must be a non-empty string.`);
    else if (keys.has(option.key)) error(`${at}.key "${option.key}" is declared twice.`);
    else keys.add(option.key);

    if (!isFilledString(option.label)) error(`${at}.label must be a non-empty string.`);
    if (!OPTION_TYPES.includes(option.type)) {
      error(`${at}.type must be one of ${OPTION_TYPES.join(' | ')}.`);
    }
    // The schema is also where the defaults come from (`defaultsFrom`), so an
    // option without one starts life as `undefined` rather than as anything.
    if (option.default === undefined) {
      error(`${at}.default is required — the option schema is where defaults come from.`);
    } else if (option.type === 'boolean' && typeof option.default !== 'boolean') {
      error(`${at}.default must be true or false for a boolean option.`);
    } else if (option.type === 'number' && !Number.isFinite(option.default)) {
      error(`${at}.default must be a finite number for a number option.`);
    }

    ['min', 'max', 'step'].forEach((field) => {
      if (option[field] !== undefined && !Number.isFinite(option[field])) {
        error(`${at}.${field} must be a number when it is given.`);
      }
    });
    if (option.enabledWhen !== undefined && !booleans.has(option.enabledWhen)) {
      warn(
        `${at}.enabledWhen names "${option.enabledWhen}", which is not a boolean option ` +
          'of this protocol — the control would never enable.'
      );
    }
    if (option.modes !== undefined && !isModeList(option.modes)) {
      error(`${at}.modes must be an array of ${MODES.join(' / ')}.`);
    }
  });
}

const isModeList = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((mode) => MODES.includes(mode));

function checkColumns(plugin, error, warn) {
  const { columns } = plugin;
  if (!Array.isArray(columns)) {
    error('`columns` must be an array of { key, label, format }.');
    return;
  }
  if (columns.length === 0) {
    warn('`columns` is empty — the routing table would show destinations and nothing else.');
  }

  columns.forEach((column, index) => {
    const at = `columns[${index}]`;
    if (!column || typeof column !== 'object') {
      error(`${at} must be an object like { key, label, format }.`);
      return;
    }
    if (!isFilledString(column.key)) error(`${at}.key must be a non-empty string.`);
    if (!isFilledString(column.label)) error(`${at}.label must be a non-empty string.`);
    // A warning rather than an error: an unknown format renders as plain text,
    // which is defined behaviour, and refusing to run a working protocol over a
    // cell renderer would be the wrong trade.
    if (column.format === undefined) {
      warn(`${at}.format is missing — the column will render as plain text.`);
    } else if (!COLUMN_FORMATS.includes(column.format)) {
      warn(
        `${at}.format "${column.format}" is not one of ${COLUMN_FORMATS.join(' | ')} — ` +
          'the column will render as plain text.'
      );
    }
    if (column.modes !== undefined && !isModeList(column.modes)) {
      error(`${at}.modes must be an array of ${MODES.join(' / ')}.`);
    }
  });
}

function checkRouterControls(plugin, error) {
  const { routerControls } = plugin;
  if (routerControls === undefined) return;
  if (!Array.isArray(routerControls)) {
    error('`routerControls` must be an array when it is given.');
    return;
  }
  routerControls.forEach((control, index) => {
    const at = `routerControls[${index}]`;
    if (!control || typeof control !== 'object') {
      error(`${at} must be an object like { key, label, type, scope }.`);
      return;
    }
    if (!isFilledString(control.key)) error(`${at}.key must be a non-empty string.`);
    if (!isFilledString(control.label)) error(`${at}.label must be a non-empty string.`);
    if (!OPTION_TYPES.includes(control.type)) {
      error(`${at}.type must be one of ${OPTION_TYPES.join(' | ')}.`);
    }
    if (control.scope !== undefined && !CONTROL_SCOPES.includes(control.scope)) {
      error(`${at}.scope must be ${CONTROL_SCOPES.join(' or ')}.`);
    }
    if (control.default === undefined && control.defaultFrom === undefined) {
      error(`${at} needs a \`default\` (or \`defaultFrom: 'routerId'\`).`);
    }
  });
}

function checkHelpAndLegend(plugin, error, warn) {
  if (plugin.help !== undefined) {
    if (!Array.isArray(plugin.help)) {
      error('`help` must be an array of { heading, items } when it is given.');
    } else {
      plugin.help.forEach((section, index) => {
        const at = `help[${index}]`;
        if (!section || typeof section !== 'object') {
          error(`${at} must be an object like { heading, items: [] }.`);
          return;
        }
        if (!isFilledString(section.heading)) error(`${at}.heading must be a non-empty string.`);
        if (!Array.isArray(section.items) || !section.items.every(isFilledString)) {
          error(`${at}.items must be an array of strings.`);
        }
      });
    }
  }

  if (plugin.legend === undefined) return;
  if (!Array.isArray(plugin.legend)) {
    error('`legend` must be an array of { colorKey, label } when it is given.');
    return;
  }
  plugin.legend.forEach((entry, index) => {
    const at = `legend[${index}]`;
    if (!entry || typeof entry !== 'object') {
      error(`${at} must be an object like { colorKey, label }.`);
      return;
    }
    if (!isFilledString(entry.label)) error(`${at}.label must be a non-empty string.`);
    if (!COLORS[entry.colorKey]) {
      warn(
        `${at}.colorKey "${entry.colorKey}" is not in the palette — the swatch would be ` +
          'blank. See COLORS in config.js.'
      );
    }
  });
}

/**
 * Everything decidable without running a line of the plugin.
 *
 * Runs first and, when it finds anything, runs alone: executing a plugin with no
 * `round` would bury one useful sentence under a stack trace.
 */
function checkContract(plugin, error, warn) {
  REQUIRED_STRINGS.forEach(([field, why]) => {
    if (!isFilledString(plugin[field])) {
      error(`\`${field}\` is required and must be a non-empty string — it is ${why}.`);
    }
  });

  if (isFilledString(plugin.id)) {
    if (isBuiltinProtocolId(plugin.id)) {
      error(
        `\`id\` "${plugin.id}" belongs to a built-in protocol. Pick another, or a share ` +
          'link naming it would mean two different things.'
      );
    }
    if (UNSAFE_ID.test(plugin.id)) {
      warn(
        `\`id\` "${plugin.id}" contains one of ~ , _ , which are the separators a shared ` +
          'link is built from — a link written while this protocol is selected would be ' +
          'unreadable.'
      );
    }
  }

  REQUIRED_FUNCTIONS.forEach(([field, signature]) => {
    if (typeof plugin[field] !== 'function') {
      error(`\`${field}\` is required and must be a function — ${signature}.`);
    }
  });

  OPTIONAL_FUNCTIONS.forEach((field) => {
    if (plugin[field] !== undefined && typeof plugin[field] !== 'function') {
      error(`\`${field}\` must be a function when it is given.`);
    }
  });

  checkOptions(plugin, error, warn);
  checkColumns(plugin, error, warn);
  checkRouterControls(plugin, error, warn);
  checkHelpAndLegend(plugin, error, warn);

  if (plugin.hasRoutingTables !== undefined && typeof plugin.hasRoutingTables !== 'boolean') {
    error('`hasRoutingTables` must be true or false when it is given.');
  }
  if (plugin.rowLabel !== undefined && !isFilledString(plugin.rowLabel)) {
    error('`rowLabel` must be a non-empty string when it is given.');
  }
  if (plugin.quietSeconds !== undefined) {
    if (!Number.isFinite(plugin.quietSeconds) || plugin.quietSeconds <= 0) {
      error('`quietSeconds` must be a positive number of seconds when it is given.');
    } else if (typeof plugin.startTimers !== 'function') {
      warn('`quietSeconds` only applies in timer mode, and this protocol has no `startTimers`.');
    }
  }
  if (typeof plugin.isSettled === 'function' && typeof plugin.startTimers !== 'function') {
    warn('`isSettled` is only consulted in timer mode, and this protocol has no `startTimers`.');
  }
}

/* ------------------------------------------------------------------ *
 * Pass 2 — running it
 * ------------------------------------------------------------------ */

/** Round-mode safety cap for the smoke test. */
export const SMOKE_MAX_ROUNDS = 50;
/** Timer-mode caps: simulated seconds, and event batches, because either can run away. */
export const SMOKE_MAX_SECONDS = 600;
const SMOKE_MAX_EVENT_STEPS = 4000;

const SMOKE_ROUTERS = ['1', '2', '3', '4'];

/**
 * The network every plugin is tried on.
 *
 * A triangle (1-2-3) so there is a cycle to get wrong and two equal-ish ways
 * round it, plus a tail (3-4) so there is a leaf whose only route is through
 * somebody else. Four routers is the smallest shape that has both.
 */
export function smokeTopology() {
  const topology = new Topology();
  SMOKE_ROUTERS.forEach((id) => topology.addRouter(id));
  topology.addLink('1', '2', 1);
  topology.addLink('2', '3', 1);
  topology.addLink('1', '3', 3);
  topology.addLink('3', '4', 2);
  return topology;
}

let probeCounter = 0;

/**
 * A copy of the plugin under a throwaway id, with `round` wrapped so the smoke
 * test can inspect what it *returned* rather than what the Simulation made of it.
 *
 * The Simulation is forgiving on purpose — `{ messages = [], changed = false }`
 * means a plugin that returns nothing at all appears to converge instantly — and
 * that forgiveness is exactly what has to be caught here.
 */
function probeFor(plugin, records) {
  probeCounter += 1;
  const original = plugin.round;
  return {
    ...plugin,
    id: `__validate__${probeCounter}`,
    round(...args) {
      const result = original.apply(this, args);
      records.push(result);
      return result;
    },
  };
}

/** Every message of every round, checked once. */
function checkMessages(records, topology, error, warn) {
  records.forEach((result) => {
    if (result === null || result === undefined || typeof result !== 'object') {
      error('`round()` must return an object like { messages: [], changed: false }.');
      return;
    }
    if (!Array.isArray(result.messages)) {
      error('`round()` must return a `messages` array (empty when nothing was sent).');
    }
    if (typeof result.changed !== 'boolean') {
      error(
        '`round()` must return `changed` as true or false. Convergence is a ' +
          '`while (changed)` loop, so anything else either hangs it or ends it early.'
      );
    }

    (Array.isArray(result.messages) ? result.messages : []).forEach((message) => {
      if (!message || typeof message !== 'object') {
        error('Every message must be an object like { from, to, kind, payload }.', 'message shape');
        return;
      }
      const from = message.from === undefined ? null : String(message.from);
      const to = message.to === undefined ? null : String(message.to);
      if (from === null || to === null) {
        error('Every message needs a `from` and a `to`.', 'message endpoints');
        return;
      }
      if (!isFilledString(message.kind)) {
        error(
          'Every message needs a `kind` string — it is what colours the packet ' +
            '(see MESSAGE_STYLES in config.js).',
          'message kind'
        );
      }
      if (!topology.has(from) || !topology.has(to)) {
        warn(
          `A message went ${from} → ${to}, and one of those is not a router in the ` +
            'network. It will animate from nowhere.',
          'message endpoints exist'
        );
        return;
      }
      if (!topology.hasLink(from, to)) {
        warn(
          `A message went ${from} → ${to}, which is not a link. Real routers can only ` +
            'talk to their neighbours.',
          'message follows a link'
        );
      }
    });
  });
}

/** The shape of what `tables()` hands back, and what the table view will make of it. */
function checkTableShape(simulation, plugin, error, warn) {
  let tables;
  try {
    tables = simulation.tables();
  } catch (caught) {
    error(`\`tables()\` threw: ${caught && caught.message}.`);
    return;
  }
  if (!tables || typeof tables !== 'object') {
    error('`tables()` must return an object keyed by router id.');
    return;
  }

  const ids = new Set(simulation.routerIds);
  ids.forEach((id) => {
    if (!tables[id]) {
      warn(
        `\`tables()\` has no row for router ${id}. The inspector will show it as empty.`,
        'missing table row'
      );
    }
  });
  Object.keys(tables).forEach((id) => {
    if (!ids.has(id)) {
      warn(
        `\`tables()\` returned a row for "${id}", which is not a router in the network.`,
        'stray table row'
      );
    }
  });

  // Only destination-keyed tables carry routes. A protocol that says
  // `hasRoutingTables: false` is telling the app its rows are something else
  // (ports, in spanning tree's case), and there is no next hop to look for.
  if (plugin.hasRoutingTables === false) return;

  ids.forEach((routerId) => {
    const table = tables[routerId];
    if (!table || typeof table !== 'object') return;
    Object.entries(table).forEach(([dest, route]) => {
      if (!route || typeof route !== 'object') {
        error(
          `tables()["${routerId}"]["${dest}"] must be a route object like ` +
            '{ nextHop, cost }.',
          'route shape'
        );
        return;
      }
      if (!('nextHop' in route)) {
        error(
          `tables()["${routerId}"]["${dest}"] has no \`nextHop\` (use null for ` +
            'unreachable).',
          'route nextHop'
        );
      }
      if (typeof route.cost !== 'number') {
        error(
          `tables()["${routerId}"]["${dest}"].cost must be a number — the infinity ` +
            'ceiling is what stands in for unreachable.',
          'route cost'
        );
      }
    });
  });
}

/** How close the converged tables came to the shortest paths. Never an error. */
function checkAgainstTruth(simulation, plugin, warn, when) {
  if (plugin.hasRoutingTables === false) return;
  const { correctness } = simulation;
  if (!correctness || correctness.totals.entries === 0) return;

  const { wrong, entries } = correctness.totals;
  if (wrong === 0) return;

  const examples = [];
  Object.entries(correctness.entries).forEach(([routerId, row]) => {
    Object.entries(row).forEach(([dest, kind]) => {
      if (kind !== 'optimal' && examples.length < 3) examples.push(`${routerId}→${dest} (${kind})`);
    });
  });

  warn(
    `${when}: ${wrong} of ${entries} entries do not match the shortest paths — ` +
      `${examples.join(', ')}. That is allowed (a protocol can be wrong on purpose), ` +
      'but the correctness meter will show it.'
  );
}

/**
 * Round mode: converge, prove the convergence was honest, break a link, converge
 * again.
 *
 * The second half is not padding. `onTopologyChange` is the hook a plugin is most
 * likely to omit or to get wrong, and a protocol that converges beautifully from
 * cold and then never notices a failure is exactly the plugin this catches.
 */
function smokeRounds(plugin, error, warn) {
  const records = [];
  const probe = probeFor(plugin, records);
  const topology = smokeTopology();
  let simulation;

  try {
    registerCustomProtocol(probe);
    simulation = new Simulation(topology, probe.id);
  } catch (caught) {
    unregisterCustomProtocol(probe.id);
    error(`Building a simulation with this protocol threw: ${caught && caught.message}.`);
    return;
  }

  try {
    const cold = simulation.runToConvergence(SMOKE_MAX_ROUNDS);
    if (!cold.converged) {
      error(
        `It never converged: ${SMOKE_MAX_ROUNDS} rounds on a four-router network and ` +
          '`changed` was still true. Usually this means `changed` reports a change that ' +
          'did not happen — compare the new table with the old one (helpers.tablesEqual) ' +
          'rather than assuming a round changed something.'
      );
      return;
    }

    checkMessages(records, topology, error, warn);
    checkTableShape(simulation, plugin, error, warn);
    checkAgainstTruth(simulation, plugin, warn, 'Converged from cold');

    // The rule the whole convergence detector rests on: once settled, another
    // round must report `changed: false`.
    const extra = simulation.runIteration();
    if (extra.changed) {
      error(
        'After converging, one more round reported `changed: true`. That flag must be ' +
          'false when and only when nothing a router believes has moved, or "Run to ' +
          'Convergence" never stops.'
      );
      return;
    }

    // …and now the half that exercises `onTopologyChange`.
    simulation.removeLink('2', '3');
    const recovery = simulation.runToConvergence(SMOKE_MAX_ROUNDS);
    if (!recovery.converged) {
      error(
        `After breaking link 2 ↔ 3 it never converged again within ${SMOKE_MAX_ROUNDS} ` +
          'rounds. Check `onTopologyChange` — a protocol has to forget what it learned ' +
          'through a link that is gone.'
      );
      return;
    }
    checkTableShape(simulation, plugin, error, warn);
    checkAgainstTruth(simulation, plugin, warn, 'After breaking link 2 ↔ 3');
  } catch (caught) {
    error(`It threw while running: ${caught && caught.message}.`);
  } finally {
    unregisterCustomProtocol(probe.id);
  }
}

/**
 * Timer mode, for a plugin that declared `startTimers`.
 *
 * Bounded three ways — simulated seconds, event batches, and the clock's own
 * runaway guard — because the failure mode here is not a wrong answer but a
 * zero-delay timer that re-schedules itself, which is a frozen tab.
 */
function smokeTimers(plugin, error, warn) {
  const records = [];
  const probe = probeFor(plugin, records);
  let simulation;

  try {
    registerCustomProtocol(probe);
    simulation = new Simulation(smokeTopology(), probe.id, undefined, { mode: 'timers' });
  } catch (caught) {
    unregisterCustomProtocol(probe.id);
    error(`Starting this protocol in timer mode threw: ${caught && caught.message}.`);
    return;
  }

  try {
    let steps = 0;
    let ranDry = false;
    while (
      !simulation.isQuiet() &&
      simulation.clock.now < SMOKE_MAX_SECONDS &&
      steps < SMOKE_MAX_EVENT_STEPS &&
      !simulation.clock.overran
    ) {
      if (!simulation.stepToNextEvent().ran) {
        ranDry = true;
        break;
      }
      steps += 1;
    }

    if (simulation.clock.overran || steps >= SMOKE_MAX_EVENT_STEPS) {
      error(
        'On the clock it scheduled events faster than the clock could run them. A timer ' +
          'with a delay of zero that re-schedules itself never lets simulated time move, ' +
          'and would freeze the tab.'
      );
      return;
    }
    if (ranDry) {
      // Not a failure: the queue simply emptied. But a protocol whose routers
      // never speak again is worth saying out loud, because timer mode will look
      // broken rather than idle.
      warn(
        'On the clock it ran out of scheduled events. Nothing further will happen in ' +
          'timer mode unless a topology edit triggers it — check that `startTimers` ' +
          'registers a repeating timer.'
      );
    } else if (!simulation.isQuiet()) {
      warn(
        `On the clock it was still busy after ${SMOKE_MAX_SECONDS} simulated seconds. It ` +
          'will run, but "Run to Convergence" in timer mode may hit its own safety limit.'
      );
    }
    checkTableShape(simulation, plugin, error, warn);
  } catch (caught) {
    error(`It threw while running on the clock: ${caught && caught.message}.`);
  } finally {
    unregisterCustomProtocol(probe.id);
  }
}

/* ------------------------------------------------------------------ *
 * The public check
 * ------------------------------------------------------------------ */

/**
 * Check a plugin object against the contract, and run it.
 *
 * @param {Object} plugin
 * @param {Object} [choices]  `{ smokeTest: false }` to check the shape only
 * @returns {{ errors: string[], warnings: string[] }} — `errors` empty means it
 *   is safe to register; warnings are worth reading either way.
 */
export function validateProtocol(plugin, { smokeTest = true } = {}) {
  const errors = collector();
  const warnings = collector();
  const error = (message, group) => errors.add(message, group);
  const warn = (message, group) => warnings.add(message, group);

  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
    error('A protocol must be a plain object — see the contract at the top of Simulation.js.');
    return { errors: errors.items, warnings: warnings.items };
  }

  checkContract(plugin, error, warn);

  // Only run it once the shape holds up: a plugin missing `round` would
  // otherwise bury one useful sentence under a stack trace from the engine.
  if (smokeTest && errors.items.length === 0) {
    smokeRounds(plugin, error, warn);
    if (typeof plugin.startTimers === 'function' && errors.items.length === 0) {
      smokeTimers(plugin, error, warn);
    }
  }

  return { errors: errors.items, warnings: warnings.items };
}

export default validateProtocol;
