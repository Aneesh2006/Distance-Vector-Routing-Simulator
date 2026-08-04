/**
 * Simulation.js — the clock, the scoreboard and the plumbing between a
 * `Topology` and a protocol plugin.
 *
 * The split, in one line each:
 *   - `Topology`  owns the wiring.
 *   - the plugin  owns what each router knows and how that knowledge moves.
 *   - `Simulation` owns rounds, convergence, counters, path tracing and the
 *                  snapshot the UI renders.
 *
 * Switching protocol is therefore just throwing the plugin's state object away
 * and asking for a new one: the topology, the positions and the ground truth
 * all survive untouched.
 *
 * ── The plugin contract ──────────────────────────────────────────────────
 *
 * Required:
 *   id, name, summary, messageLabel
 *   options:  [{ key, label, type: 'boolean'|'number', default, min, max,
 *                step, enabledWhen }]        — also the source of the defaults
 *   columns:  [{ key, label, format, modes? }]
 *     format: 'cost' | 'id' | 'hops' | 'path' | 'list' | 'text'
 *     `hops` renders a route's equal-cost next-hop set, and is identical to
 *     `id` for the ordinary route with one of them.
 *     `modes` scopes a column to one clock, exactly as it does for an option.
 *     `rowLabel` (optional) renames the leading column, which is the row's key:
 *     'Destination' for everything that routes, 'Port' for spanning tree.
 *   createState(topology, options) -> state
 *   round(state, topology, options) -> { messages: [{ from, to, kind, payload,
 *                                                     label? }],
 *                                        changed: boolean }
 *     `label` is optional: it overrides the caption on the packet in the scene,
 *     for protocols where one message differs from the next (an LSA carries the
 *     id of the router that wrote it).
 *   tables(state, topology, options) -> { routerId: { dest: { nextHop, cost, … } } }
 *
 * Optional:
 *   onTopologyChange(state, topology, options, event, clock)
 *     `clock` is the virtual clock in timer mode and null in round mode, so a
 *     plugin that never grew timers can ignore the extra argument entirely.
 *   startTimers(state, topology, options, clock)
 *     Declaring this is what says "I can be run asynchronously": the mode
 *     toggle is disabled for a protocol that omits it. Called once, after
 *     createState, to register the protocol's initial timers.
 *   isSettled(state, topology, options, clock) -> boolean
 *     Timer mode only, and optional even there. The clock can see that nothing
 *     is *scheduled*; only the protocol can see that something is about to go
 *     wrong — a route three seconds from timing out is silence, not calm.
 *   quietSeconds: number
 *     Timer mode only. How long the network must hold still before it counts as
 *     settled. Defaults to RIP's update interval, which is what the mode was
 *     built for; a protocol whose routers speak every two seconds should say so
 *     rather than wait thirty for nothing.
 *   decorations(state, topology, options) -> { links: {'A|B': variant},
 *                                              routers: { A: variant } }
 *   metrics(state, topology, options)     -> [{ label, value }]
 *   inspect(state, topology, options, routerId) -> [{ id, label, blocks }]
 *   routerControls: [{ key, label, type, scope: 'router'|'neighbor', … }]
 *   help:   [{ heading, items: string[] }]
 *   legend: [{ colorKey, label }]
 *   hasRoutingTables: boolean (default true) — false for protocols whose
 *     "table" is not destination-keyed (spanning tree), which turns off the
 *     correctness meter, the score chips and the route-tree overlay.
 *
 * Rules a plugin must follow are documented in `01-protocol-plugin-refactor.md`;
 * the two that matter most are that `round()` builds every outbound message
 * before applying any of them, and that `changed` is false when and only when
 * nothing a router believes has changed.
 */

import { SIM } from '../config';
import { Clock } from './Clock';
import { classifyTables, cloneCorrectness, truthCost, truthPath } from './groundTruth';
import { cloneTable, compareIds, nextHopsOf } from './helpers';
import { Topology } from './Topology';
import { DEFAULT_PROTOCOL_ID, getProtocol } from './protocols';

/* ------------------------------------------------------------------ *
 * Counters
 * ------------------------------------------------------------------ */

/**
 * The work counters, in two halves.
 *
 * `rounds`, `messages`, `messagesByKind` and `entriesAdvertised` are cumulative
 * since the last `reset()` — they answer "what did this protocol cost to run?".
 * Everything below them describes the current *convergence episode* and is
 * cleared by any edit, because "rounds to converge" and "peak wrong entries"
 * only mean anything relative to the change that caused them.
 */
export function createStats() {
  return {
    rounds: 0,
    messages: 0,
    messagesByKind: {},
    entriesAdvertised: 0,

    roundsSinceTopologyChange: 0,
    roundsToConverge: null,
    peakWrongEntries: 0,
    loopsSeen: 0,
    correctnessHistory: [],

    // Timer mode's half of the same two questions. Rounds are meaningless when
    // every router runs on its own schedule, so the episode is measured in
    // simulated seconds instead; both sets are always present so the stats
    // panel needs no mode-dependent shape.
    secondsSinceTopologyChange: 0,
    secondsToConverge: null,
    quietFor: 0,
  };
}

/** Detached copy — the stats object itself is mutated in place every round. */
export function cloneStats(stats) {
  return {
    ...stats,
    messagesByKind: { ...stats.messagesByKind },
    correctnessHistory: [...stats.correctnessHistory],
  };
}

/**
 * How much a message actually carried.
 *
 * Counted generically from the payload rather than reported by the plugin,
 * because this is the number that keeps the eventual protocol comparison
 * honest: link state sends fewer rounds of far bigger messages, and a plugin
 * that got to define its own units could flatter itself.
 */
export function payloadSize(payload) {
  if (payload === null || payload === undefined) return 0;
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload === 'object') return Object.keys(payload).length;
  return 1;
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/** Defaults straight out of a plugin's option schema, then the caller's overrides. */
export function defaultsFrom(schema = [], overrides = {}) {
  const options = {};
  schema.forEach(({ key, default: fallback }) => {
    options[key] = fallback;
  });
  return { ...options, ...overrides };
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

export class Simulation {
  /**
   * @param {Topology|Object} [topology]  a `Topology`, or an adjacency map
   * @param {string} [protocolId]
   * @param {Object} [optionOverrides]
   * @param {Object} [run]  `{ mode: 'rounds'|'timers', seed }`
   */
  constructor(
    topology,
    protocolId = DEFAULT_PROTOCOL_ID,
    optionOverrides,
    { mode = 'rounds', seed = SIM.timers.defaultSeed } = {}
  ) {
    this.topology = topology instanceof Topology ? topology : new Topology(topology);
    this.mode = mode;
    this.seed = seed;
    this.setProtocol(protocolId, optionOverrides);
  }

  /**
   * Point the same topology at a different protocol.
   *
   * Everything the protocol knew is discarded — that is the whole idea — but
   * the wiring, the router positions (which live in the UI) and the ground
   * truth survive, so the two protocols can be compared on identical input.
   */
  setProtocol(id, optionOverrides) {
    this.protocol = getProtocol(id);
    this.options = defaultsFrom(this.protocol.options, optionOverrides);
    // Per-router / per-neighbour knobs (`routerControls`) ride inside `options`
    // under a reserved key: they are configuration, they must reset with the
    // protocol, and this way a plugin needs no extra accessor to read them.
    this.options.routerOptions = {};
    this.topology.setInfinityCost(this.infinityCost);
    // Switching to a protocol that has no timers falls back rather than leaving
    // a mode selected that nothing implements.
    if (!this.supportsTimers) this.mode = 'rounds';
    this.iteration = 0;
    this.converged = false;
    this.lastExchanges = [];
    this.stats = createStats();
    this.correctness = null;
    this.startState();
    this.startEpisode();
    this.refresh();
    return this.protocol;
  }

  /* ---------------- run mode ---------------- */

  /**
   * Fresh protocol state, and — in timer mode — a fresh clock with the
   * protocol's timers registered on it.
   *
   * In round mode `clock` stays null and nothing else in this file behaves any
   * differently, which is the promise the round-based half of the app was
   * written against.
   */
  startState() {
    this.clock = this.mode === 'timers' ? new Clock({ seed: this.seed }) : null;
    this.state = this.protocol.createState(this.topology, this.options);
    if (this.clock) {
      this.protocol.startTimers(this.state, this.topology, this.options, this.clock);
    }
  }

  /** Can the active protocol be run on the clock at all? */
  get supportsTimers() {
    return typeof this.protocol.startTimers === 'function';
  }

  /** Simulated seconds elapsed; always 0 in round mode. */
  get time() {
    return this.clock ? this.clock.now : 0;
  }

  /**
   * Switch between the round loop and the clock.
   *
   * Protocol state is thrown away either way: a table built by lockstep rounds
   * has no per-route timers hanging off it, and one built on the clock has
   * timers that mean nothing without it. Starting again is both simpler and
   * more honest than trying to translate between them.
   */
  setMode(mode) {
    const next = mode === 'timers' && this.supportsTimers ? 'timers' : 'rounds';
    if (next === this.mode) return this.mode;
    this.mode = next;
    this.reset();
    return this.mode;
  }

  /**
   * Change the seed and replay from the beginning.
   *
   * Every jittered decision comes from this number, so the same seed and the
   * same edits produce the same run — which is what makes "convergence is a
   * distribution, not a number" demonstrable rather than assertable.
   */
  setSeed(seed) {
    this.seed = seed;
    this.reset();
    return this.seed;
  }

  /* ---------------- protocol-derived views ---------------- */

  get infinityCost() {
    return this.options.infinityCost ?? SIM.defaultInfinityCost;
  }

  /** Does this protocol produce destination-keyed tables worth scoring? */
  get hasRoutingTables() {
    return this.protocol.hasRoutingTables !== false;
  }

  isUnreachable(cost) {
    return !Number.isFinite(cost) || cost >= this.infinityCost;
  }

  tables() {
    return this.protocol.tables(this.state, this.topology, this.options) || {};
  }

  decorations() {
    if (!this.protocol.decorations) return { links: {}, routers: {} };
    const result = this.protocol.decorations(this.state, this.topology, this.options) || {};
    return { links: result.links || {}, routers: result.routers || {} };
  }

  metrics() {
    if (!this.protocol.metrics) return [];
    return this.protocol.metrics(this.state, this.topology, this.options) || [];
  }

  /** Extra inspector tabs for one router; `[]` when the plugin offers none. */
  inspect(routerId) {
    if (!this.protocol.inspect || !this.topology.has(routerId)) return [];
    return (
      this.protocol.inspect(
        this.state,
        this.topology,
        this.options,
        String(routerId),
        this.clock
      ) || []
    );
  }

  /**
   * The option schema as it applies to the current mode.
   *
   * An option may declare `modes: ['timers']` — the RIP timers describe nothing
   * in a world where every router speaks once per round — and filtering here
   * rather than in the panel keeps the generic renderer generic. The *values*
   * always exist, because `defaultsFrom` reads the whole schema.
   */
  optionSchema() {
    return (this.protocol.options || []).filter(
      (option) => !option.modes || option.modes.includes(this.mode)
    );
  }

  /**
   * The table columns as they apply to the current mode.
   *
   * Same rule as `optionSchema`, and for the same reason: a spanning-tree port
   * has a *state* only once there is a clock for it to take thirty seconds on,
   * and a column that read "—" in round mode would be a worse answer than no
   * column at all.
   */
  columnSchema() {
    return (this.protocol.columns || []).filter(
      (column) => !column.modes || column.modes.includes(this.mode)
    );
  }

  /**
   * How long the network has to hold still before timer mode calls it settled.
   *
   * RIP's update interval is the default because RIP is what the mode was built
   * for, but it is a property of the protocol rather than of the clock: waiting
   * thirty seconds to declare a spanning tree converged, when its bridges speak
   * every two, would be waiting for nothing.
   */
  get quietSeconds() {
    return this.protocol.quietSeconds ?? SIM.timers.updateInterval;
  }

  /* ---------------- options ---------------- */

  setOptions(partial) {
    this.options = { ...this.options, ...partial };
    if (partial.infinityCost !== undefined) this.topology.setInfinityCost(this.infinityCost);
    // Not a topology edit, but it changes how the protocol behaves, so the
    // convergence episode measured under the old settings is over.
    this.startEpisode();
    this.notify({ type: 'options', changed: partial });
    return this.options;
  }

  /**
   * Set one of the per-router knobs a plugin declares in `routerControls`
   * (STP bridge priority, BGP LOCAL_PREF towards one neighbour).
   */
  setRouterOption(routerId, key, value, neighborId) {
    const id = String(routerId);
    const perRouter = { ...(this.options.routerOptions[id] || {}) };
    if (neighborId === undefined || neighborId === null) {
      perRouter[key] = value;
    } else {
      perRouter[key] = { ...(perRouter[key] || {}), [String(neighborId)]: value };
    }
    this.options.routerOptions = { ...this.options.routerOptions, [id]: perRouter };
    this.startEpisode();
    this.notify({ type: 'routerOption', routerId: id, key, value, neighborId });
    return this.options.routerOptions;
  }

  /** Current value of a per-router knob, falling back to the control's default. */
  routerOption(routerId, key, neighborId) {
    const control = (this.protocol.routerControls || []).find((item) => item.key === key);
    const stored = (this.options.routerOptions[String(routerId)] || {})[key];
    const value =
      neighborId === undefined || neighborId === null
        ? stored
        : stored && stored[String(neighborId)];
    if (value !== undefined) return value;
    // `defaultFrom: 'routerId'` is for a knob whose natural default is the
    // router's own identity — a BGP AS number, where one router per AS is the
    // model until somebody groups them. A static default cannot say that, and a
    // function would not survive the snapshot.
    if (control && control.defaultFrom === 'routerId') return String(routerId);
    return control && control.default;
  }

  /* ---------------- topology ---------------- */

  get routerIds() {
    return this.topology.routerIds;
  }

  isActive(id) {
    return this.topology.isActive(id);
  }

  hasLink(a, b) {
    return this.topology.hasLink(a, b);
  }

  getLinks() {
    return this.topology.getLinks();
  }

  normalizeCost(cost) {
    return this.topology.normalizeCost(cost);
  }

  get groundTruth() {
    return this.topology.groundTruth;
  }

  addRouter(id, { refresh = true } = {}) {
    return this.edit(this.topology.addRouter(id), { type: 'addRouter', id }, refresh);
  }

  removeRouter(id, { refresh = true } = {}) {
    return this.edit(this.topology.removeRouter(id), { type: 'removeRouter', id }, refresh);
  }

  addLink(a, b, cost = SIM.defaultLinkCost, { refresh = true } = {}) {
    return this.edit(
      this.topology.addLink(a, b, cost),
      { type: 'addLink', a, b, cost },
      refresh
    );
  }

  setLinkCost(a, b, cost) {
    return this.edit(this.topology.setLinkCost(a, b, cost), { type: 'setLinkCost', a, b, cost });
  }

  removeLink(a, b, { refresh = true } = {}) {
    return this.edit(this.topology.removeLink(a, b), { type: 'removeLink', a, b }, refresh);
  }

  setRouterActive(id, active, { refresh = true } = {}) {
    return this.edit(
      this.topology.setRouterActive(id, active),
      { type: 'setRouterActive', id, active },
      refresh
    );
  }

  /**
   * Common tail for every topology edit.
   *
   * `refresh: false` exists for bulk loading (a preset adds ten routers and
   * fifteen links before anyone should look), and the caller finishes with one
   * explicit `refresh()`.
   */
  edit(didChange, event, refresh = true) {
    if (!didChange) return false;
    this.startEpisode();
    if (refresh) this.notify(event);
    return true;
  }

  /**
   * Re-derive everything from current state without running a round.
   *
   * This is what makes invariant 7 hold: after an edit the endpoints notice
   * immediately, while the rest of the network still holds stale information
   * until a round delivers the news.
   */
  refresh() {
    return this.notify({ type: 'refresh' });
  }

  notify(event) {
    if (this.protocol.onTopologyChange) {
      this.protocol.onTopologyChange(this.state, this.topology, this.options, event, this.clock);
    }
    // An edit is activity by definition, so the quiet timer starts again from
    // here — otherwise breaking a link during a lull would leave the network
    // claiming it had already converged on the answer it is about to abandon.
    if (this.clock && event.type !== 'refresh') this.clock.disturb();
    this.converged = false;
    this.recordCorrectness();
    return this;
  }

  /* ---------------- scoring ---------------- */

  /**
   * A convergence episode is the stretch between one change and the network
   * settling again. Any edit — or an option change, which rewrites how the
   * protocol behaves — starts a new one, because rounds-to-converge and peak
   * wrong entries measured across a change describe nothing.
   */
  startEpisode() {
    this.stats.roundsSinceTopologyChange = 0;
    this.stats.roundsToConverge = null;
    this.stats.peakWrongEntries = 0;
    this.stats.loopsSeen = 0;
    this.stats.correctnessHistory = [];
    this.episodeStartedAt = this.time;
    this.stats.secondsSinceTopologyChange = 0;
    this.stats.secondsToConverge = null;
  }

  /**
   * Score the tables against ground truth and fold the result into the stats.
   *
   * Called from `notify()` and `runIteration()` — the two moments the tables
   * are freshly derived — so the history is one sample per round plus one for
   * the edit that started the episode. That first sample is what makes the
   * sparkline show the *drop*, not just the recovery.
   */
  recordCorrectness() {
    if (!this.hasRoutingTables) {
      this.correctness = null;
      return null;
    }
    this.correctness = classifyTables(this.tables(), this.groundTruth, {
      infinityCost: this.infinityCost,
    });

    const { wrong, percent } = this.correctness.totals;
    this.stats.peakWrongEntries = Math.max(this.stats.peakWrongEntries, wrong);
    this.stats.loopsSeen += this.correctness.loops;
    this.stats.correctnessHistory.push(percent);
    if (this.stats.correctnessHistory.length > SIM.metrics.historyLength) {
      this.stats.correctnessHistory.shift();
    }
    return this.correctness;
  }

  /* ---------------- the clock ---------------- */

  /**
   * One synchronous round of the active protocol.
   * @returns {{ iteration: number, changed: boolean, exchanges: Array }}
   */
  runIteration() {
    if (this.mode === 'timers') {
      throw new Error('runIteration() is round mode only — use advance(seconds) on the clock.');
    }
    const { messages = [], changed = false } =
      this.protocol.round(this.state, this.topology, this.options) || {};

    this.iteration += 1;
    // `label` is optional and only travels when a plugin stamped one, so a
    // protocol that does not care keeps a byte-identical snapshot.
    this.lastExchanges = messages.map(({ from, to, kind, label }) =>
      label === undefined ? { from, to, kind } : { from, to, kind, label }
    );
    this.converged = !changed;
    this.countRound(messages);
    this.recordCorrectness();

    return { iteration: this.iteration, changed, exchanges: this.lastExchanges };
  }

  /** What was said, counted the same way whichever clock said it. */
  countMessages(messages) {
    this.stats.messages += messages.length;
    messages.forEach(({ kind, payload }) => {
      this.stats.messagesByKind[kind] = (this.stats.messagesByKind[kind] || 0) + 1;
      this.stats.entriesAdvertised += payloadSize(payload);
    });
  }

  countRound(messages) {
    this.stats.rounds += 1;
    this.stats.roundsSinceTopologyChange += 1;
    this.countMessages(messages);

    // Recorded once per episode: the first round that changes nothing is the
    // one that proves convergence, and later idle rounds must not inflate it.
    if (this.converged && this.stats.roundsToConverge === null) {
      this.stats.roundsToConverge = this.stats.roundsSinceTopologyChange;
    }
  }

  /**
   * Run until nothing changes: rounds in round mode, simulated seconds in timer
   * mode. The caller does not have to know which — the "Run to convergence"
   * button means the same thing in both.
   *
   * @returns {{ rounds: number, converged: boolean, seconds?: number }}
   */
  runToConvergence(maxRounds = SIM.maxConvergenceRounds) {
    if (this.mode === 'timers') return this.runToQuiet();

    let rounds = 0;
    let changed = true;
    while (changed && rounds < maxRounds) {
      changed = this.runIteration().changed;
      rounds += 1;
    }
    return { rounds, converged: !changed };
  }

  /* ---------------- the other clock ---------------- */

  /**
   * Converged, asynchronously.
   *
   * "A round changed nothing" has no meaning when every router runs on its own
   * schedule, so this is the doc's definition: no table has changed and nothing
   * but the periodic timer is outstanding, for a whole update interval of
   * simulated time. A full interval because that is how long it takes for the
   * slowest router to have had its say — anything shorter would call a network
   * settled in the gap between two transmissions.
   */
  isQuiet() {
    if (!this.clock) return this.converged;
    if (this.clock.hasPendingWork()) return false;
    if (this.clock.quietFor < this.quietSeconds) return false;
    // The last word goes to the protocol. Nothing being *said* is not the same
    // as nothing being *wrong*: a router whose neighbour went silent two and a
    // half minutes ago looks perfectly calm right up until it does not.
    if (!this.protocol.isSettled) return true;
    return Boolean(
      this.protocol.isSettled(this.state, this.topology, this.options, this.clock)
    );
  }

  /**
   * Run the event queue forward by `seconds` of simulated time.
   *
   * @returns {{ time, seconds, changed, exchanges }} — `exchanges` are the
   *   messages sent during the advance, each carrying the `at` it was sent, so
   *   the animation can play them in the order and spacing they happened in
   *   rather than all at once.
   */
  advance(seconds) {
    if (this.mode !== 'timers') {
      throw new Error('advance() is timer mode only — use runIteration() for rounds.');
    }
    const before = this.clock.now;
    this.clock.advance(seconds);
    return this.applyClock(before);
  }

  /**
   * Jump straight to the next thing that happens.
   *
   * The step control that makes the mode teachable: skipping the empty seconds
   * is exactly what "time only exists at event boundaries" buys, and it turns a
   * three-minute timeout into one click.
   */
  stepToNextEvent() {
    if (this.mode !== 'timers') {
      throw new Error('stepToNextEvent() is timer mode only.');
    }
    const before = this.clock.now;
    const ran = this.clock.advanceToNextEvent();
    return { ...this.applyClock(before), ran };
  }

  /** Advance event by event until the network goes quiet, or the cap runs out. */
  runToQuiet(maxSeconds = SIM.timers.maxConvergenceSeconds) {
    const start = this.clock.now;
    let exchanges = this.lastExchanges;

    while (!this.isQuiet() && this.clock.now - start < maxSeconds) {
      const before = this.clock.now;
      if (!this.clock.advanceToNextEvent()) {
        // Nothing at all is scheduled — which can only mean no router is up.
        // Let the quiet threshold pass rather than spinning on an empty queue.
        this.clock.advance(SIM.timers.updateInterval);
        this.applyClock(before);
        break;
      }
      // Counted per batch rather than once at the end so the transient
      // wrongness in the middle still reaches `peakWrongEntries`, and so the
      // animation gets the last batch rather than every packet at once.
      const step = this.applyClock(before);
      if (step.exchanges.length > 0) exchanges = step.exchanges;
    }

    this.lastExchanges = exchanges;
    return {
      rounds: this.stats.rounds,
      seconds: this.clock.now - start,
      converged: this.isQuiet(),
    };
  }

  /**
   * Shared tail for every way of moving the clock: bank what was sent, rescore,
   * and decide whether the network has gone quiet.
   */
  applyClock(before) {
    const messages = this.clock.drain();
    this.lastExchanges = messages.map(({ from, to, kind, label, at }) =>
      label === undefined ? { from, to, kind, at } : { from, to, kind, label, at }
    );
    this.countMessages(messages);
    this.stats.secondsSinceTopologyChange = this.clock.now - this.episodeStartedAt;
    this.stats.quietFor = this.clock.quietFor;
    this.recordCorrectness();

    this.converged = this.isQuiet();
    if (this.converged && this.stats.secondsToConverge === null) {
      // The moment things went quiet, not the moment we noticed: the network
      // settled one update interval ago and the interval is only the proof.
      this.stats.secondsToConverge = Math.max(
        0,
        this.clock.quietSince - this.episodeStartedAt
      );
    }

    return {
      time: this.clock.now,
      seconds: this.clock.now - before,
      changed: !this.converged,
      exchanges: this.lastExchanges,
      // The same messages with their payloads still attached. The snapshot
      // never carries these — it would be a large copy of something the UI has
      // no use for — but a test asking "was that route advertised as dead?"
      // has nowhere else to look.
      messages,
    };
  }

  /** Wipe learned state and return to the iteration-0 view. */
  reset() {
    this.startState();
    this.iteration = 0;
    this.lastExchanges = [];
    // A reset is a fresh run, so the cumulative work counters go too.
    this.stats = createStats();
    this.startEpisode();
    this.refresh();
    return this;
  }

  /* ---------------- paths ---------------- */

  /**
   * Walk the routing tables hop by hop. Read-only: inspecting the network never
   * advances it (invariant 8).
   */
  findPath(sourceId, destinationId) {
    const infinity = this.infinityCost;
    const tables = this.tables();
    const source = String(sourceId);
    const destination = String(destinationId);
    const fail = (status, message) => ({
      status,
      message,
      path: [],
      cost: infinity,
      tableCost: infinity,
    });

    // Spanning tree's rows are ports, so `tables[a][b]` is a port role and not a
    // route. Walking it would silently produce nonsense, and saying so leaves
    // the panel's "actual shortest path" line to do the useful half of the job.
    if (!this.hasRoutingTables) {
      return fail(
        'unsupported',
        `${this.protocol.name} builds no routing tables — there is no next hop to follow.`
      );
    }
    if (!this.topology.has(source)) return fail('missing', `Router ${source} does not exist.`);
    if (!this.topology.has(destination)) {
      return fail('missing', `Router ${destination} does not exist.`);
    }
    if (!this.topology.isActive(source)) return fail('down', `Router ${source} is down.`);
    if (!this.topology.isActive(destination)) {
      return fail('down', `Router ${destination} is down.`);
    }
    if (source === destination) {
      return {
        status: 'ok',
        message: 'Source and destination are the same router.',
        path: [source],
        cost: 0,
        tableCost: 0,
      };
    }

    const tableCost = tables[source]?.[destination]?.cost ?? infinity;
    const path = [source];
    const visited = new Set([source]);
    const hopLimit = this.topology.routerIds.length;
    let current = source;
    let cost = 0;

    while (current !== destination) {
      const entry = tables[current]?.[destination];

      if (!this.topology.isActive(current)) {
        return fail('down', `Router ${current} on the path is down.`);
      }
      if (!entry || entry.nextHop === null || this.isUnreachable(entry.cost)) {
        return {
          ...fail('unreachable', `Router ${current} has no route to ${destination}.`),
          tableCost,
        };
      }

      const nextHop = entry.nextHop;
      if (visited.has(nextHop) || path.length > hopLimit) {
        return {
          ...fail('loop', 'Routing loop detected — the tables have not converged yet.'),
          tableCost,
        };
      }

      cost += this.topology.linkCost(current, nextHop);
      path.push(nextHop);
      visited.add(nextHop);
      current = nextHop;
    }

    return { status: 'ok', message: 'Path found.', path, cost, tableCost };
  }

  /**
   * True shortest path over the live topology, independent of what the routers
   * currently believe. Protocol-independent by construction — this is the
   * yardstick every protocol is measured against.
   */
  shortestPath(sourceId, destinationId) {
    const infinity = this.infinityCost;
    const truth = this.groundTruth;
    const cost = truthCost(truth, sourceId, destinationId);
    // A real path costlier than the ceiling is one this protocol cannot
    // express, so it reports unreachable — exactly as the routers will.
    if (cost >= infinity) return { path: [], cost: infinity };
    return { path: truthPath(truth, sourceId, destinationId), cost };
  }

  /**
   * Every edge the selected router's table actually uses, following next hops
   * to every destination.
   *
   * Generic on purpose (design decision #1): walking next hops is an SPF tree
   * under link state, a policy tree under path vector and a Bellman-Ford tree
   * under DVR. One overlay, every protocol.
   */
  routeTreeEdges(sourceId) {
    const source = String(sourceId);
    const tables = this.tables();
    const edges = new Set();
    if (!this.hasRoutingTables || !tables[source]) return edges;

    /**
     * Follow every hop the tables install, not only the first.
     *
     * Without ECMP each router offers exactly one and this is the walk it
     * always was; with it on, a destination reachable two equally good ways
     * branches and both halves are drawn — which is the whole reason to look at
     * the equal-cost diamond. `trail` is per branch rather than shared, so two
     * branches meeting again at the same router is recognised for what it is
     * (they re-converged) instead of being mistaken for a loop.
     */
    const walk = (current, destination, trail, found) => {
      if (current === destination) return true;
      const entry = tables[current]?.[destination];
      if (!entry || this.isUnreachable(entry.cost)) return false;
      const hops = nextHopsOf(entry);
      if (hops.length === 0) return false;
      return hops.every((hop) => {
        if (trail.has(hop)) return false; // an unconverged loop draws nothing
        found.add([current, hop].sort(compareIds).join('|'));
        return walk(hop, destination, new Set(trail).add(hop), found);
      });
    };

    Object.keys(tables[source]).forEach((destination) => {
      const found = new Set();
      // All or nothing per destination: half a tree to somewhere unreachable is
      // a more confusing picture than none.
      if (walk(source, destination, new Set([source]), found)) {
        found.forEach((key) => edges.add(key));
      }
    });

    return edges;
  }

  /* ---------------- snapshot ---------------- */

  /** Immutable view of the whole simulation, safe to store in React state. */
  getSnapshot() {
    const { routerOptions, ...optionValues } = this.options;
    const liveTables = this.tables();
    const tables = {};
    const status = {};
    this.routerIds.forEach((id) => {
      tables[id] = cloneTable(liveTables[id] || {});
      status[id] = { isActive: this.topology.isActive(id) };
    });

    return {
      iteration: this.iteration,
      converged: this.converged,
      infinityCost: this.infinityCost,
      routerIds: this.routerIds,
      links: this.getLinks(),
      tables,
      status,
      exchanges: this.lastExchanges,
      stats: cloneStats(this.stats),
      correctness: cloneCorrectness(this.correctness),

      // Added in stage 2. Existing fields keep their meaning exactly.
      protocol: {
        id: this.protocol.id,
        name: this.protocol.name,
        summary: this.protocol.summary,
        messageLabel: this.protocol.messageLabel,
        columns: this.columnSchema(),
        // Null rather than 'Destination': the two table views spell the default
        // differently (the DOM one carries a soft hyphen so it can wrap), so
        // each supplies its own rather than one of them undoing the other's.
        rowLabel: this.protocol.rowLabel || null,
        options: this.optionSchema(),
        routerControls: this.protocol.routerControls || [],
        help: this.protocol.help || [],
        legend: this.protocol.legend || [],
        hasRoutingTables: this.hasRoutingTables,
        supportsTimers: this.supportsTimers,
        quietSeconds: this.quietSeconds,
      },
      options: optionValues,
      routerOptions: { ...routerOptions },
      decorations: this.decorations(),
      metrics: this.metrics(),

      // Added in stage 8. Round mode reports a stopped clock rather than
      // nothing, so the panels have one shape to render in either mode.
      mode: this.mode,
      seed: this.seed,
      clock: {
        time: this.time,
        quietFor: this.clock ? this.clock.quietFor : 0,
        pending: this.clock ? this.clock.pending : 0,
        nextEventAt: this.clock ? this.clock.nextEventAt : null,
      },
      eventLog: this.clock ? this.clock.recentEvents() : [],
    };
  }
}
