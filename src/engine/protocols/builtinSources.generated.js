/**
 * builtinSources.generated.js — GENERATED FILE, DO NOT EDIT.
 *
 * Every shipped protocol, rewritten as something the custom-protocol editor can
 * run: imports turned into the injected `helpers` and `config`, exports
 * dropped, and the id renamed so an edited copy runs beside the original. See
 * scripts/protocolSourceTransform.cjs for the whole of what changes.
 *
 * Regenerate with:  npm run build:sources
 * Kept honest by:   builtinSources.test.js, which re-runs the transform against
 *                   the real protocol modules and fails when this file lags.
 *
 * It exists because the browser cannot read the repository. react-scripts gives
 * no way to import a .js file as text, and the alternative — a hand-written
 * "study edition" of each protocol — would be a second implementation of five
 * protocols, drifting from the first from the day it was written.
 */

/** Protocol id -> its implementation, as editor source. */
export const BUILTIN_SOURCES = {
  /** Distance Vector (RIP-style) — from distanceVector.js. */
  'dvr': `/* ─────────────────────────────────────────────────────────────────────────
 * Distance Vector (RIP-style) — the shipped implementation, opened for editing.
 *
 * This is src/engine/protocols/distanceVector.js, exactly as it runs in
 * the app, with three mechanical changes and nothing else:
 *
 *   - its import lines became the \`helpers\` and \`config\` values the editor
 *     already puts in scope (just below);
 *   - \`export\` was dropped from its declarations, since there is no module
 *     system here — the source *is* a function body;
 *   - the id and name are reassigned at the very bottom, because a protocol
 *     may not reuse a built-in's id. So this copy runs alongside the
 *     original rather than replacing it.
 *
 * Everything in between is the real thing. Change whatever you like — the
 * split-horizon rule, the tie-break, the message a router sends — and press
 * Validate & Activate to watch your version run on the same network.
 * ───────────────────────────────────────────────────────────────────────── */

const SIM = config;
const { compareIds, multipathRoute, tablesEqual } = helpers;
const { ECMP_OPTION } = config;

/**
 * distanceVector.js — Distance Vector Routing (Bellman-Ford), RIP-style.
 *
 * This is the original engine, moved behind the plugin interface with its
 * behaviour untouched. The pre-refactor test suite is the proof: it runs
 * unmodified against this file through the \`Network\` shim.
 *
 * Model
 * -----
 * Every router stores the last distance vector it heard from each neighbour.
 * Its own table is then *derived* from those vectors:
 *
 *     D(x, dest) = min over neighbours n of [ c(x, n) + D(n, dest) ]
 *
 * Deriving the table instead of patching it in place is what makes the
 * simulation deterministic: the result of a round does not depend on the order
 * messages happen to be delivered in.
 *
 * Infinity
 * --------
 * \`options.infinityCost\` is a small finite ceiling (RIP uses 16). Costs are
 * clamped to it and anything that reaches it counts as unreachable. That is
 * what makes count-to-infinity terminate rather than run forever.
 *
 * Loop avoidance
 * --------------
 * \`splitHorizon\` stops a router advertising a route back to the neighbour it
 * routes through; with \`poisonedReverse\` it advertises that route as infinite
 * instead of staying silent. Both are toggleable so the count-to-infinity
 * failure mode can still be demonstrated.
 */


/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * \`vectors\` is the only thing a router really remembers; \`tables\` is cached
 * derivation, refreshed whenever the vectors or the topology move. Caching it
 * is what lets \`tables()\` stay pure and cheap enough to call on every snapshot.
 */
function createState() {
  return {
    /** routerId -> (neighbourId -> last vector heard from it) */
    vectors: new Map(),
    /** routerId -> { dest: { nextHop, cost } } */
    tables: {},
  };
}

function vectorsOf(state, routerId) {
  let held = state.vectors.get(routerId);
  if (!held) {
    held = new Map();
    state.vectors.set(routerId, held);
  }
  return held;
}

/** Everyone forgets what \`routerId\` told them, and it forgets everyone. */
function forgetRouter(state, routerId) {
  state.vectors.delete(routerId);
  state.vectors.forEach((held) => held.delete(routerId));
}

/* ------------------------------------------------------------------ *
 * The three protocol operations
 * ------------------------------------------------------------------ */

/**
 * The distance vector a router holding \`table\` would send to \`neighborId\`,
 * with split horizon / poisoned reverse applied.
 *
 * Takes the table rather than reaching into state because the asynchronous mode
 * (\`ripTimers.js\`) keeps its routes in a different shape and has to advertise
 * them by exactly the same rules. One implementation is what makes the
 * round-mode / timer-mode equivalence test mean something: if split horizon
 * behaved even slightly differently on the clock, the two modes could converge
 * to different answers and the test would be measuring the wrong thing.
 */
function buildVector(table, options, neighborId) {
  const { splitHorizon, poisonedReverse, infinityCost } = options;
  const vector = {};

  Object.entries(table).forEach(([dest, route]) => {
    // "I only reach dest by going through you" — do not echo it back.
    const learnedFromListener = route.nextHop === neighborId && dest !== neighborId;

    if (splitHorizon && learnedFromListener) {
      if (poisonedReverse) vector[dest] = infinityCost;
      return;
    }
    vector[dest] = route.cost;
  });

  return vector;
}

/** A vector is only kept while the listener is up and still linked to the sender. */
function receive(state, topology, routerId, fromId, vector) {
  if (!topology.isActive(routerId) || !topology.hasLink(routerId, fromId)) return;
  vectorsOf(state, routerId).set(fromId, vector);
}

/**
 * Rebuild one router's table from the vectors it currently holds.
 * Returns true only on a real change — the caller relies on this for
 * convergence detection, so it must never report a spurious one.
 */
function recompute(state, topology, options, routerId, destinations) {
  const infinity = options.infinityCost;
  const router = topology.routers[routerId];
  const previousTable = state.tables[routerId] || {};
  const held = state.vectors.get(routerId);
  const next = {};

  destinations.forEach((dest) => {
    if (dest === routerId) {
      next[dest] = { nextHop: routerId, cost: 0 };
      return;
    }

    const previous = previousTable[dest];
    let bestCost = infinity;
    let bestHop = null;
    // Every neighbour that reaches \`dest\` for exactly \`bestCost\`. Only read
    // when ECMP is on; collecting it either way keeps one code path.
    let tied = new Set();

    if (router && router.isActive) {
      router.links.forEach((linkCost, neighborId) => {
        if (!topology.isActive(neighborId)) return;

        const consider = (rawCost) => {
          const cost = Math.min(infinity, rawCost);
          if (cost >= infinity) return;
          if (cost < bestCost) {
            bestCost = cost;
            bestHop = neighborId;
            tied = new Set([neighborId]);
            return;
          }
          if (cost !== bestCost) return;
          tied.add(neighborId);
          // On a tie keep the hop we already use, so routes do not flap
          // between equal-cost paths.
          if (previous && previous.nextHop === neighborId) bestHop = neighborId;
        };

        // The direct link is always a candidate, even before the neighbour has
        // said anything.
        if (neighborId === dest) consider(linkCost);

        const vector = held && held.get(neighborId);
        if (vector && vector[dest] !== undefined) {
          consider(linkCost + vector[dest]);
        }
      });
    }

    next[dest] =
      bestHop === null
        ? { nextHop: null, cost: infinity }
        : multipathRoute(bestHop, bestCost, options.ecmp ? [...tied] : null);
  });

  state.tables[routerId] = next;
  return !tablesEqual(previousTable, next);
}

/**
 * Re-derive every table. Rebuilding the container rather than patching it is
 * what drops a deleted router out of the view instead of leaving a ghost entry.
 */
function recomputeAll(state, topology, options) {
  const destinations = topology.routerIds;
  const previous = state.tables;
  state.tables = {};
  let changed = destinations.length !== Object.keys(previous).length;

  destinations.forEach((routerId) => {
    state.tables[routerId] = previous[routerId];
    if (recompute(state, topology, options, routerId, destinations)) changed = true;
  });

  return changed;
}

/* ================================================================== *
 * Timer mode — the same protocol, on a clock (RFC 2453 §3.6, §3.8, §3.9)
 *
 * Everything above this line happens in lockstep: one round, every router
 * speaks, every router listens. Real RIP does not. It broadcasts on its own
 * jittered thirty-second timer, believes what it is told until 180 seconds of
 * silence say otherwise, and then shouts about the dead route for another 120
 * before forgetting it. Those three numbers are most of why RIP has the
 * reputation it has, and the round loop hides all of them.
 *
 * Two structural differences follow from the clock, and they are the reason
 * this is a separate implementation rather than a setting:
 *
 *   - **Routes are stepped, not derived.** A round-mode table is rebuilt from
 *     the stored vectors every round (invariant 2), which is what makes it
 *     order-independent. A route with a lifecycle cannot work that way: "how
 *     long since anyone mentioned this?" is a memory, not a derivation. So this
 *     half keeps a real routing table and patches it by RFC 2453 §3.9.2's
 *     rules, exactly as the protocol does. \`tables()\` is still the derived
 *     *view* of it, so invariant 2 holds where it is about what the UI sees.
 *   - **Delivery is immediate.** A message is sent and received at the same
 *     instant; what stops that cascading forever is the 1–5 second delay before
 *     a triggered update, which is precisely what the delay is for in the RFC.
 *
 * One deliberate divergence from round mode, and it is the whole demo: when a
 * router is switched off, its neighbours are told nothing. Pulling a cable is
 * detectable — the interface goes down and routes through it die at once — but
 * a box that quietly stops answering is not, and its neighbours find out 180
 * seconds later like everybody else. Invariant 12 still holds for the router
 * itself: it forgets everything it had learned, so it cannot come back up
 * believing a lie.
 * ================================================================== */

/**
 * Per-router timer state.
 *
 * \`topology\` and \`options\` are kept here because a scheduled event runs long
 * after the call that scheduled it, and \`Simulation.setOptions\` replaces the
 * options object wholesale — a handler that closed over the old one would
 * quietly keep using the settings the user just changed. Every entry point
 * refreshes these two, so a handler always reads what is current.
 */
function createTimerState(topology, options) {
  return {
    topology,
    options,
    /** routerId -> (dest -> route) — a real routing table, patched in place. */
    routes: new Map(),
    /** routerId -> its periodic update event. */
    updates: new Map(),
    /** routerId -> a triggered update already on its way, if any. */
    triggered: new Map(),
  };
}

function routesOf(state, routerId) {
  let held = state.timers.routes.get(routerId);
  if (!held) {
    held = new Map();
    state.timers.routes.set(routerId, held);
  }
  return held;
}

const newRoute = () => ({
  nextHop: null,
  cost: 0,
  /** False once the route has timed out: metric infinity, awaiting deletion. */
  valid: true,
  /** RFC 2453 §3.10.1's route change flag — what a triggered update carries. */
  changed: false,
  /** A route to yourself cannot go stale, so it carries no timers. */
  permanent: false,
  timeout: null,
  timeoutAt: null,
  gc: null,
  gcAt: null,
});

/* ---------------- the two per-route timers ---------------- */

function stopTimeout(clock, route) {
  clock.cancel(route.timeout);
  route.timeout = null;
  route.timeoutAt = null;
}

function stopGarbageCollection(clock, route) {
  clock.cancel(route.gc);
  route.gc = null;
  route.gcAt = null;
}

/**
 * Restart the route's 180-second life. Every update from the router we route
 * through does this, which is what "no news for three minutes" measures.
 */
function restartTimeout(state, clock, routerId, dest) {
  const route = routesOf(state, routerId).get(dest);
  if (!route || route.permanent) return;
  stopTimeout(clock, route);
  route.timeoutAt = clock.now + state.timers.options.routeTimeout;
  // Background: every route a settled network holds is always counting down,
  // so an outstanding timeout says nothing about whether anything is going on.
  // A pending *deletion* is the opposite, and is scheduled without the flag.
  route.timeout = clock.schedule(
    state.timers.options.routeTimeout,
    () => expireRoute(state, clock, routerId, dest),
    { background: true, label: \`timeout \${routerId}→\${dest}\` }
  );
}

/**
 * The route has gone quiet for \`routeTimeout\`.
 *
 * It is *not* deleted: the metric goes to infinity and it stays in the table,
 * advertised loudly as dead, for another \`garbageCollection\` seconds. Deleting
 * it silently would leave every neighbour to time it out on its own schedule
 * 180 seconds later, and that staircase is a large part of why RIP is slow.
 */
function expireRoute(state, clock, routerId, dest, reason = 'timeout') {
  const route = routesOf(state, routerId).get(dest);
  if (!route || !route.valid) return;

  route.valid = false;
  route.cost = state.timers.options.infinityCost;
  route.changed = true;
  stopTimeout(clock, route);
  route.gcAt = clock.now + state.timers.options.garbageCollection;
  route.gc = clock.schedule(state.timers.options.garbageCollection, () =>
    deleteRoute(state, clock, routerId, dest)
  );

  clock.disturb();
  clock.log(\`\${routerId} route to \${dest} invalid (\${reason})\`);
  // A direct link may be able to take over from a route that has just died,
  // and the neighbours need to hear either answer.
  syncDirect(state, clock, routerId);
  announce(state, clock, routerId);
}

/**
 * Garbage collection: the dead route finally leaves the table.
 *
 * No triggered update follows. The poison has been going out with every update
 * for two minutes; there is nothing left to say.
 */
function deleteRoute(state, clock, routerId, dest) {
  const routes = routesOf(state, routerId);
  const route = routes.get(dest);
  if (!route || route.valid) return;

  stopGarbageCollection(clock, route);
  routes.delete(dest);
  clock.disturb();
  clock.log(\`\${routerId} route to \${dest} deleted (garbage collection)\`);
  syncDirect(state, clock, routerId);
  announce(state, clock, routerId);
}

/* ---------------- installing a route ---------------- */

/**
 * Install or refresh a route and start its clock again.
 *
 * Returns whether anything a neighbour would care about changed, so the caller
 * can decide whether to trigger an update. A periodic update that repeats what
 * we already believed must return false, or every thirty seconds would look
 * like news.
 */
function installRoute(state, clock, routerId, dest, nextHop, cost) {
  const routes = routesOf(state, routerId);
  let route = routes.get(dest);
  if (!route) {
    route = newRoute();
    routes.set(dest, route);
  }

  const differs = route.nextHop !== nextHop || route.cost !== cost || !route.valid;
  route.nextHop = nextHop;
  route.cost = cost;
  route.valid = true;
  // Whatever was being said about this route is no longer true: a refresh
  // during garbage collection cancels the deletion outright.
  stopGarbageCollection(clock, route);
  restartTimeout(state, clock, routerId, dest);
  if (differs) route.changed = true;
  return differs;
}

/**
 * What the wiring itself proves: a router is at most one link away from each of
 * its neighbours, and zero from itself.
 *
 * Run after anything that could change the answer — an edit, a route dying, an
 * update that made a path more expensive than the cable next to it. It only
 * ever *improves* a route, never removes one, because removing is what the
 * timeout is for.
 */
function syncDirect(state, clock, routerId) {
  const { topology } = state.timers;
  if (!topology.isActive(routerId)) return false;
  const routes = routesOf(state, routerId);
  let changed = false;

  const self = routes.get(routerId);
  if (!self || self.cost !== 0 || self.nextHop !== routerId) {
    const route = self || newRoute();
    route.nextHop = routerId;
    route.cost = 0;
    route.valid = true;
    route.permanent = true;
    routes.set(routerId, route);
  }

  topology.neighborsOf(routerId).forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) return;
    const cost = topology.linkCost(routerId, neighborId);
    const route = routes.get(neighborId);
    // Better than what we have, or a stale price on the cable itself. A cheaper
    // route learned the long way round is left alone — the direct link is a
    // candidate, not an override.
    const worthInstalling =
      !route ||
      !route.valid ||
      cost < route.cost ||
      (route.nextHop === neighborId && route.cost !== cost);
    if (!worthInstalling) return;
    if (installRoute(state, clock, routerId, neighborId, neighborId, cost)) changed = true;
  });

  if (changed) clock.disturb();
  return changed;
}

/**
 * Every route through \`deadNeighbor\` dies now, rather than in three minutes.
 *
 * This is the difference between unplugging a cable and switching a box off:
 * the interface going down is something a router can see for itself.
 */
function invalidateVia(state, clock, routerId, deadNeighbor) {
  const routes = state.timers.routes.get(routerId);
  if (!routes) return false;
  let changed = false;

  routes.forEach((route, dest) => {
    if (route.nextHop !== deadNeighbor || !route.valid || route.permanent) return;
    stopTimeout(clock, route);
    route.valid = false;
    route.cost = state.timers.options.infinityCost;
    route.changed = true;
    route.gcAt = clock.now + state.timers.options.garbageCollection;
    route.gc = clock.schedule(state.timers.options.garbageCollection, () =>
      deleteRoute(state, clock, routerId, dest)
    );
    changed = true;
  });

  if (changed) {
    clock.disturb();
    clock.log(\`\${routerId} lost its link to \${deadNeighbor} — routes through it are dead\`);
  }
  return changed;
}

/* ---------------- sending ---------------- */

/** The plain \`{ dest: { nextHop, cost } }\` view \`buildVector\` expects. */
function advertisableTable(state, routerId, onlyChanged) {
  const table = {};
  const routes = state.timers.routes.get(routerId);
  if (!routes) return table;
  routes.forEach((route, dest) => {
    if (onlyChanged && !route.changed) return;
    table[dest] = { nextHop: route.nextHop, cost: route.cost };
  });
  return table;
}

function clearChangeFlags(state, routerId) {
  const routes = state.timers.routes.get(routerId);
  if (routes) routes.forEach((route) => {
    route.changed = false;
  });
}

/**
 * Send this router's table to every neighbour, and deliver it there and then.
 *
 * A triggered update carries only the routes whose metric moved (§3.10.1) —
 * which is why the message counters make timer mode look cheap next to the
 * round loop even while it takes far longer.
 */
function sendUpdate(state, clock, routerId, { triggered = false } = {}) {
  const { topology, options } = state.timers;
  if (!topology.isActive(routerId)) return;

  const table = advertisableTable(state, routerId, triggered);
  const reached = [];

  topology.neighborsOf(routerId).forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) return;
    const payload = buildVector(table, options, neighborId);
    // Split horizon can empty a triggered update completely, and a packet
    // carrying nothing is not a packet.
    if (Object.keys(payload).length === 0) return;

    reached.push(neighborId);
    clock.emit({
      from: routerId,
      to: neighborId,
      kind: 'dv',
      payload,
      // The scene captions triggered updates differently, so the wave that
      // follows a failure can be told apart from the thirty-second drumbeat.
      ...(triggered ? { label: 'DV!' } : {}),
    });
    receiveUpdate(state, clock, neighborId, routerId, payload);
  });

  clearChangeFlags(state, routerId);
  if (reached.length > 0) {
    clock.log(
      \`\${routerId} → \${reached.join(', ')} \${triggered ? 'triggered update' : 'update'}\`
    );
  }
}

/**
 * The periodic broadcast, jittered.
 *
 * The jitter is not decoration. Routers that start together and transmit on an
 * exact interval drift into lockstep and then collide, permanently — a real,
 * documented pathology. Set \`updateJitter\` to 0 and this simulator reproduces
 * it exactly, which is the only honest way to argue for a constant.
 */
function scheduleUpdate(state, clock, routerId) {
  const { updateInterval, updateJitter } = state.timers.options;
  const spread = Math.min(updateJitter, updateInterval);
  const jitter = (clock.random() * 2 - 1) * spread;
  // Never zero: a zero-delay periodic timer would re-fire inside its own
  // handler for ever.
  const delay = Math.max(0.001, updateInterval + jitter);

  const event = clock.schedule(
    delay,
    () => {
      sendUpdate(state, clock, routerId);
      scheduleUpdate(state, clock, routerId); // the loop
    },
    { background: true, label: \`update \${routerId}\` }
  );
  state.timers.updates.set(routerId, event);
}

/**
 * Announce a metric change, after a random 1–5 second wait.
 *
 * The wait is what stops a whole neighbourhood transmitting in the same instant
 * when a link dies, and one pending update per router is enough — everything
 * that changed in the meantime rides along with it.
 */
function announce(state, clock, routerId) {
  const { options, topology } = state.timers;
  if (!options.triggeredUpdates || !topology.isActive(routerId)) return;
  const routes = state.timers.routes.get(routerId);
  if (!routes || ![...routes.values()].some((route) => route.changed)) return;
  if (state.timers.triggered.get(routerId)) return;

  const { triggeredUpdateMin: min, triggeredUpdateMax: max } = options;
  const delay = min + clock.random() * Math.max(0, max - min);
  const event = clock.schedule(delay, () => {
    state.timers.triggered.delete(routerId);
    sendUpdate(state, clock, routerId, { triggered: true });
  });
  state.timers.triggered.set(routerId, event);
  clock.disturb();
}

/* ---------------- receiving ---------------- */

/**
 * Apply one neighbour's vector, by RFC 2453 §3.9.2.
 *
 * The rule that surprises people is the second one: an update from the router
 * we already route through is believed *whatever* it says, better or worse.
 * That is what lets bad news travel at all — and, without split horizon, what
 * lets it travel round in a circle getting worse by one hop each time.
 */
function receiveUpdate(state, clock, routerId, fromId, vector) {
  const { topology, options } = state.timers;
  if (!topology.isActive(routerId) || !topology.canReach(routerId, fromId)) return;

  const infinity = options.infinityCost;
  const linkCost = topology.linkCost(routerId, fromId);
  const routes = routesOf(state, routerId);
  let changed = false;

  Object.entries(vector).forEach(([dest, metric]) => {
    // Nobody learns a route to themselves, and a destination that has been
    // deleted from the simulation is not a destination.
    if (dest === routerId || !topology.has(dest)) return;
    const cost = Math.min(infinity, linkCost + metric);
    const route = routes.get(dest);

    if (!route) {
      // Nothing to install and nothing to poison: an unreachable route we have
      // never heard of is simply not news.
      if (cost >= infinity) return;
      installRoute(state, clock, routerId, dest, fromId, cost);
      changed = true;
      return;
    }

    if (route.nextHop === fromId && !route.permanent) {
      if (cost >= infinity) {
        // Our own next hop says the destination is gone. Start the deletion
        // process now rather than waiting out the timeout — which is exactly
        // what the garbage-collection advertisement is for, and why it is worth
        // distinguishing in the log from a route nobody said anything about.
        if (route.valid) {
          expireRoute(state, clock, routerId, dest, \`poisoned by \${fromId}\`);
          changed = true;
        }
        return;
      }
      if (installRoute(state, clock, routerId, dest, fromId, cost)) changed = true;
      return;
    }

    // Any other neighbour has to be strictly better. Equal cost keeps the
    // incumbent, exactly as the round-mode tie-break does, so a route does not
    // flap between two equal paths every thirty seconds.
    if (cost < route.cost && !route.permanent) {
      installRoute(state, clock, routerId, dest, fromId, cost);
      changed = true;
    }
  });

  // An update can make our path dearer than the cable to the neighbour it runs
  // through, so the direct links get another look before anything is announced.
  if (syncDirect(state, clock, routerId)) changed = true;
  if (changed) {
    clock.disturb();
    announce(state, clock, routerId);
  }
}

/* ---------------- topology, on the clock ---------------- */

/** Add and remove per-router tables so the state matches the network. */
function syncTimerRouters(state, clock) {
  const { topology } = state.timers;
  const live = new Set(topology.routerIds);

  [...state.timers.routes.keys()].forEach((routerId) => {
    if (live.has(routerId)) return;
    state.timers.routes.get(routerId).forEach((route) => {
      stopTimeout(clock, route);
      stopGarbageCollection(clock, route);
    });
    state.timers.routes.delete(routerId);
  });

  // A destination that has been deleted from the simulation never existed as
  // far as the remaining routers are concerned — unlike one that was switched
  // off, which they have to time out for themselves.
  state.timers.routes.forEach((routes) => {
    [...routes.keys()].forEach((dest) => {
      if (live.has(dest)) return;
      const route = routes.get(dest);
      stopTimeout(clock, route);
      stopGarbageCollection(clock, route);
      routes.delete(dest);
    });
  });
}

/** Exactly one periodic update timer per router that is switched on. */
function syncSchedules(state, clock) {
  const { topology } = state.timers;

  state.timers.updates.forEach((event, routerId) => {
    if (topology.isActive(routerId)) return;
    clock.cancel(event);
    state.timers.updates.delete(routerId);
  });
  state.timers.triggered.forEach((event, routerId) => {
    if (topology.isActive(routerId)) return;
    clock.cancel(event);
    state.timers.triggered.delete(routerId);
  });

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId) || state.timers.updates.has(routerId)) return;
    scheduleUpdate(state, clock, routerId);
  });
}

/**
 * A router that is switched off forgets everything it learned (invariant 12)
 * and stops transmitting — and that is *all* that happens. Its neighbours are
 * told nothing, which is the point: they will notice in \`routeTimeout\` seconds
 * like everybody else, and watching that happen is the reason this mode exists.
 */
function powerDown(state, clock, routerId) {
  const routes = state.timers.routes.get(routerId);
  if (routes) {
    routes.forEach((route) => {
      stopTimeout(clock, route);
      stopGarbageCollection(clock, route);
    });
    routes.clear();
  }
  clock.log(
    \`\${routerId} down — its neighbours will not notice for \` +
      \`\${state.timers.options.routeTimeout}s\`
  );
}

function onTimerTopologyChange(state, topology, options, event, clock) {
  state.timers.topology = topology;
  state.timers.options = options;

  switch (event.type) {
    case 'removeLink':
      invalidateVia(state, clock, String(event.a), String(event.b));
      invalidateVia(state, clock, String(event.b), String(event.a));
      break;
    case 'removeRouter':
      topology.routerIds.forEach((id) => invalidateVia(state, clock, id, String(event.id)));
      break;
    case 'setRouterActive':
      if (!event.active) {
        powerDown(state, clock, String(event.id));
      } else {
        clock.log(\`\${event.id} up\`);
      }
      break;
    default:
      break;
  }

  syncTimerRouters(state, clock);
  syncSchedules(state, clock);
  topology.routerIds.forEach((routerId) => syncDirect(state, clock, routerId));

  // A refresh is the simulator being wired up, not something the network did,
  // so it never puts a packet on the wire: a freshly loaded preset waits for
  // its first scheduled update like a network that has just been switched on.
  if (event.type === 'refresh') {
    topology.routerIds.forEach((routerId) => clearChangeFlags(state, routerId));
    return;
  }
  topology.routerIds.forEach((routerId) => announce(state, clock, routerId));
}

/**
 * Is the network actually settled, or merely between transmissions?
 *
 * The clock can only see what is *scheduled*, and a route timeout is always
 * scheduled — so left to itself it would call the network quiet thirty seconds
 * after a router was switched off, with two and a half minutes of the staircase
 * still to come and every neighbour still believing in a box that is not there.
 *
 * Two things say otherwise, and both are decidable:
 *
 *   - a route already in garbage collection is a deletion waiting to happen;
 *   - a route whose next hop has no update timer is doomed, because the only
 *     thing that ever refreshes it has stopped transmitting.
 *
 * The second is knowledge the *simulator* has and the routers do not, and it
 * changes nothing they do — it only stops "run to convergence" reporting a
 * finish three times on the way to the real one.
 */
function timersSettled(state) {
  let settled = true;

  state.timers.routes.forEach((routes) => {
    routes.forEach((route) => {
      if (route.permanent || !settled) return;
      if (!route.valid) settled = false;
      else if (route.nextHop !== null && !state.timers.updates.has(route.nextHop)) {
        settled = false;
      }
    });
  });

  return settled;
}

/* ---------------- the timer-mode views ---------------- */

/**
 * The same shape as a round-mode table, so every consumer — the correctness
 * meter, the path finder, both table views — carries on unchanged.
 *
 * A route in garbage collection keeps its next hop and shows infinity, which is
 * exactly what the router believes and says: "I know who told me, and I no
 * longer believe them". Only deletion empties the hop, so the three stages of
 * the lifecycle are legible in the table itself.
 */
function timerTables(state, topology, options) {
  const ids = topology.routerIds;
  const view = {};

  ids.forEach((routerId) => {
    const routes = state.timers.routes.get(routerId);
    const table = {};
    ids.forEach((dest) => {
      const route = routes && routes.get(dest);
      table[dest] = route
        ? { nextHop: route.nextHop, cost: route.cost }
        : { nextHop: null, cost: options.infinityCost };
    });
    view[routerId] = table;
  });

  return view;
}

/** Seconds, as the panels spell them. */
const seconds = (value) => \`\${Math.max(0, value).toFixed(1)}s\`;

/**
 * The Timers tab: when this router next speaks, and how long every route it
 * holds has left to live.
 *
 * This is the reason to build the mode at all. Being told that a route ages out
 * after three minutes is a fact; watching the bar drain is an argument.
 */
function timerInspect(state, topology, options, routerId, clock) {
  const routes = state.timers.routes.get(routerId);
  if (!routes || !clock) return [];

  const update = state.timers.updates.get(routerId);
  const trigger = state.timers.triggered.get(routerId);
  const invalid = [...routes.values()].filter((route) => !route.valid).length;

  const bars = [...routes.entries()]
    .filter(([, route]) => !route.permanent)
    .sort(([a], [b]) => compareIds(a, b))
    .map(([dest, route]) => {
      const collecting = !route.valid;
      const total = collecting ? options.garbageCollection : options.routeTimeout;
      const deadline = collecting ? route.gcAt : route.timeoutAt;
      const left = deadline === null ? total : Math.max(0, deadline - clock.now);
      return {
        label: \`\${dest}\${collecting ? ' (dying)' : ''}\`,
        value: left,
        max: total,
        caption: \`\${seconds(left)} to \${collecting ? 'deletion' : 'timeout'}\`,
      };
    });

  return [
    {
      id: 'timers',
      label: 'Timers',
      blocks: [
        {
          type: 'rows',
          rows: [
            {
              label: 'Next update',
              value:
                update && !update.cancelled ? seconds(update.at - clock.now) : 'not scheduled',
            },
            {
              label: 'Triggered update',
              value: trigger ? \`in \${seconds(trigger.at - clock.now)}\` : 'none pending',
            },
            { label: 'Routes held', value: routes.size },
            { label: 'Dying (in GC)', value: invalid },
          ],
        },
        bars.length > 0
          ? { type: 'bars', bars }
          : { type: 'text', text: 'This router holds no route that can time out.' },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

const distanceVector = {
  id: 'dvr',
  name: 'Distance Vector (RIP-style)',
  summary: 'Routers swap distance vectors with their neighbours and run Bellman-Ford.',
  messageLabel: 'DV',

  options: [
    { key: 'splitHorizon', label: 'Split horizon', type: 'boolean', default: true },
    {
      key: 'poisonedReverse',
      label: 'Poisoned reverse',
      type: 'boolean',
      default: true,
      enabledWhen: 'splitHorizon',
    },
    {
      key: 'infinityCost',
      label: 'Infinity',
      type: 'number',
      default: SIM.defaultInfinityCost,
      min: SIM.minInfinityCost,
      max: SIM.maxInfinityCost,
    },
    // Round mode only. The asynchronous half keeps a real routing table with a
    // lifecycle per route (§3.9.2), and a set of hops there would need a set of
    // timeouts — a change to the protocol, not to how its answer is shown.
    { ...ECMP_OPTION, modes: ['rounds'] },

    // The RIP timers, shown only in timer mode — they describe nothing in a
    // world where every router speaks once per round. \`modes\` is honoured by
    // the snapshot, so the panel needs no idea that modes exist.
    {
      key: 'triggeredUpdates',
      label: 'Triggered updates',
      type: 'boolean',
      default: true,
      modes: ['timers'],
    },
    {
      key: 'updateInterval',
      label: 'Update interval (s)',
      type: 'number',
      default: SIM.timers.updateInterval,
      min: SIM.timers.minSeconds,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
    },
    {
      key: 'updateJitter',
      label: 'Update jitter (± s)',
      type: 'number',
      default: SIM.timers.updateJitter,
      min: 0,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
    },
    {
      key: 'routeTimeout',
      label: 'Route timeout (s)',
      type: 'number',
      default: SIM.timers.routeTimeout,
      min: SIM.timers.minSeconds,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
    },
    {
      key: 'garbageCollection',
      label: 'Garbage collection (s)',
      type: 'number',
      default: SIM.timers.garbageCollection,
      min: SIM.timers.minSeconds,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
    },
    {
      key: 'triggeredUpdateMin',
      label: 'Triggered delay, min (s)',
      type: 'number',
      default: SIM.timers.triggeredUpdateMin,
      min: 0,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
      enabledWhen: 'triggeredUpdates',
    },
    {
      key: 'triggeredUpdateMax',
      label: 'Triggered delay, max (s)',
      type: 'number',
      default: SIM.timers.triggeredUpdateMax,
      min: 0,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
      enabledWhen: 'triggeredUpdates',
    },
  ],

  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    // \`hops\` rather than \`id\`: identical for a route with one next hop, and a
    // comma-separated list once ECMP installs several.
    { key: 'nextHop', label: 'Next Hop', format: 'hops' },
  ],

  legend: [{ colorKey: 'packet', label: 'Distance vector in flight' }],

  help: [
    {
      heading: 'How distance vector works',
      items: [
        'Every router starts knowing only itself (cost 0) and its direct links.',
        'Each round it sends every neighbour its current best cost to every ' +
          'destination, then rebuilds its own table with Bellman-Ford: ' +
          'D(x, dest) = min over neighbours n of [ c(x, n) + D(n, dest) ].',
        'A router never learns the topology — only what its neighbours claim ' +
          'their distances are. That is exactly why it can be fooled.',
      ],
    },
    {
      heading: 'Things worth trying',
      items: [
        \`Turn off split horizon, load "Three in a line", converge, then delete \` +
          \`link 2 ↔ 3. Costs climb one hop at a time until they hit the infinity \` +
          \`ceiling (default \${SIM.defaultInfinityCost}, as in RIP) — that is \` +
          \`count-to-infinity, and the finite ceiling is what stops it.\`,
        'Leave split horizon on and break the same link: the count never starts, ' +
          'because nobody advertises a route back to the neighbour it routes through.',
        'Break a link mid-run: its two endpoints react instantly while the rest of ' +
          'the network keeps stale routes for a round or two.',
        'Watch the correctness meter rather than the CONVERGED badge — a distance ' +
          'vector network can settle on an answer that is still wrong.',
        'Load "Equal-cost diamond" and turn on "Equal-cost multipath". Router 1 ' +
          'reaches 4 two ways for the same 6, and installs both: the Next Hop ' +
          'column reads "2, 3" and the route tree draws both sides. The ' +
          'tie-break has not gone away — it is still what stops the table ' +
          'flapping — it simply no longer has to throw one of two equally good ' +
          'answers away. Real routers then hash flows across the set.',
      ],
    },
    {
      heading: 'Timer mode: the real RIP clock',
      items: [
        \`Switch Rounds to Timers in the Run panel and the lockstep goes away. Every \` +
          \`router broadcasts its whole table every \${SIM.timers.updateInterval} seconds, \` +
          \`offset by up to ±\${SIM.timers.updateJitter} so they do not all speak at once, \` +
          \`and announces a metric change after a random \` +
          \`\${SIM.timers.triggeredUpdateMin}–\${SIM.timers.triggeredUpdateMax} second wait.\`,
        \`Every route it learns has \${SIM.timers.routeTimeout} seconds to live, reset by \` +
          \`each update that mentions it. When it runs out the metric goes to infinity and \` +
          \`the route is advertised, loudly, as dead for another \` +
          \`\${SIM.timers.garbageCollection} seconds before it is deleted. Watch that in the \` +
          \`Timers tab of the router inspector — the bar is the timer.\`,
        \`The staircase: take a router down (not delete it — down) and nothing happens for \` +
          \`three minutes. Nobody told its neighbours anything, because nothing did; they \` +
          \`each find out when their own timer runs out. That is the honest picture of RIP \` +
          \`that the round loop hides.\`,
        'Pulling a cable is different, and worth doing next to it: delete a link and both ' +
          'endpoints know at once, because an interface going down is something a router ' +
          'can see for itself.',
        \`Set update jitter to 0, reset, and play: routers that started together lock into \` +
          \`transmitting in the same instant, for ever. That pathology is the entire reason \` +
          \`the random offset is in the RFC.\`,
        'Turn triggered updates off and break a link: recovery goes from seconds to the ' +
          'best part of a minute, because everyone now waits for their next scheduled ' +
          'broadcast to hear about it.',
        'Load "Async loop trap", turn triggered updates off and break 1 ↔ 5. The tables ' +
          'can loop even with split horizon and poisoned reverse on — stale news from one ' +
          'direction outruns the poison from the other. Try a few seeds: some runs are ' +
          'clean. That "sometimes" is exactly what DUAL exists to remove.',
        'Change the seed and run the same failure again. The answer never changes; the ' +
          'time it takes does. Convergence is a distribution, not a number — which is the ' +
          'one thing the round counter cannot tell you.',
        'Equal-cost multipath is not offered on the clock, and the reason is the ' +
          'shape of this half rather than an omission: a timer-mode route is a ' +
          'real table entry with its own timeout and its own garbage collection, ' +
          'so a *set* of next hops would mean a set of timers and a decision ' +
          'about what to do when one of them expires. RFC 2453 has no answer to ' +
          'that because RIP does not do it.',
      ],
    },
  ],

  createState() {
    return createState();
  },

  /**
   * Register the RIP timers. Declaring this method is what tells the app the
   * protocol can be run asynchronously at all.
   *
   * Nothing is sent here: the routers know their own links and each other's
   * distance from the wiring, and then wait for their first scheduled update
   * like a network that has just been switched on. That silence is why the
   * jitter demo works — with jitter at zero everyone's first update lands in
   * the same instant, for ever.
   */
  startTimers(state, topology, options, clock) {
    state.timers = createTimerState(topology, options);
    topology.routerIds.forEach((routerId) => syncDirect(state, clock, routerId));
    syncSchedules(state, clock);
    topology.routerIds.forEach((routerId) => clearChangeFlags(state, routerId));
    clock.log('timers started');
  },

  /**
   * Topology edits are handled by forgetting exactly what has become
   * unhearable and then re-deriving. Invariant 7: only the affected endpoints
   * react immediately, everyone else keeps their stale beliefs until the next
   * round tells them otherwise.
   */
  onTopologyChange(state, topology, options, event = {}, clock = null) {
    if (state.timers && clock) {
      return onTimerTopologyChange(state, topology, options, event, clock);
    }

    switch (event.type) {
      case 'removeRouter':
        forgetRouter(state, String(event.id));
        break;
      case 'removeLink':
        vectorsOf(state, String(event.a)).delete(String(event.b));
        vectorsOf(state, String(event.b)).delete(String(event.a));
        break;
      case 'setRouterActive':
        // Invariant 12: a router that is down forgets its neighbours' vectors
        // and they forget its, so it cannot come back up believing a lie.
        if (!event.active) forgetRouter(state, String(event.id));
        break;
      default:
        break;
    }
    return recomputeAll(state, topology, options);
  },

  /** One synchronous round: snapshot every advertisement, then deliver, then derive. */
  round(state, topology, options) {
    // Phase 1 — build all outbound messages before anything is applied.
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return;
      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.isActive(neighborId)) return;
        messages.push({
          from: routerId,
          to: neighborId,
          kind: 'dv',
          payload: buildVector(state.tables[routerId] || {}, options, neighborId),
        });
      });
    });

    // Phase 2 — deliver, then re-derive every table.
    messages.forEach(({ from, to, payload }) => receive(state, topology, to, from, payload));
    const changed = recomputeAll(state, topology, options);

    return { messages, changed };
  },

  tables(state, topology, options) {
    return state.timers ? timerTables(state, topology, options) : state.tables;
  },

  isSettled(state) {
    return !state.timers || timersSettled(state);
  },

  /**
   * Nothing to show in round mode: the table already says everything a
   * synchronous router knows. On the clock there is a second half — when it
   * next speaks, and how long each route has left.
   */
  inspect(state, topology, options, routerId, clock) {
    return state.timers ? timerInspect(state, topology, options, routerId, clock) : [];
  },

  metrics(state, topology, options) {
    if (!state.timers) return [];
    let dying = 0;
    let held = 0;
    state.timers.routes.forEach((routes, routerId) => {
      if (!topology.isActive(routerId)) return;
      routes.forEach((route) => {
        held += 1;
        if (!route.valid) dying += 1;
      });
    });
    return [
      { label: 'Routes held', value: held },
      { label: 'Routes dying', value: \`\${dying} (\${options.garbageCollection}s to go)\` },
      { label: 'Updates pending', value: state.timers.triggered.size },
    ];
  },
};

/* ── The only edit ────────────────────────────────────────────────────────
 * "dvr" belongs to the built-in, and two protocols cannot answer to one id
 * — a shared link naming it would mean different things to different people.
 * Rename these to whatever you like; they are ordinary properties.
 * ─────────────────────────────────────────────────────────────────────── */
distanceVector.id = 'dvr-copy';
distanceVector.name = 'Distance Vector (RIP-style) — my copy';

return distanceVector;
`,

  /** DUAL (EIGRP-style) — from dual.js. */
  'dual': `/* ─────────────────────────────────────────────────────────────────────────
 * DUAL (EIGRP-style) — the shipped implementation, opened for editing.
 *
 * This is src/engine/protocols/dual.js, exactly as it runs in
 * the app, with three mechanical changes and nothing else:
 *
 *   - its import lines became the \`helpers\` and \`config\` values the editor
 *     already puts in scope (just below);
 *   - \`export\` was dropped from its declarations, since there is no module
 *     system here — the source *is* a function body;
 *   - the id and name are reassigned at the very bottom, because a protocol
 *     may not reuse a built-in's id. So this copy runs alongside the
 *     original rather than replacing it.
 *
 * Everything in between is the real thing. Change whatever you like — the
 * split-horizon rule, the tie-break, the message a router sends — and press
 * Validate & Activate to watch your version run on the same network.
 * ───────────────────────────────────────────────────────────────────────── */

const SIM = config;

/**
 * dual.js — DUAL, the Diffusing Update Algorithm (EIGRP), RFC 7868 §3.3.
 *
 * Split horizon and poisoned reverse are patches. They stop the two-router
 * version of count-to-infinity and fail on any larger loop, and the reason they
 * have to be patches is that a distance is a conclusion you cannot check: when
 * a neighbour says "I can reach D for 7", nothing in that sentence says whether
 * the 7 runs back through you.
 *
 * DUAL is the actual fix, and it is the only protocol here with a proof of loop
 * freedom *at every instant* rather than after convergence. The whole proof is
 * one inequality.
 *
 * ── The feasibility condition ────────────────────────────────────────────
 *
 *   FD — feasible distance: the lowest distance to a destination this router
 *        has achieved since the destination was last stable.
 *   RD — reported distance: what a neighbour says its own distance is.
 *   FC — a neighbour is usable when **RD < FD**, strictly.
 *
 * If a neighbour's own distance is strictly less than the best this router has
 * ever managed, that neighbour cannot be routing through this router: if it
 * were, its distance would already include the cost of reaching here, which is
 * at least this router's distance, which is at least FD. So the route is
 * loop-free without asking anybody. That is the entire argument, and it is why
 * DUAL needs no infinity ceiling to terminate.
 *
 * The cheapest neighbour passing the FC is the **successor** (the installed next
 * hop); any other neighbour passing it is a **feasible successor**, a backup
 * that has already been proved safe. When the successor dies and a feasible
 * successor exists the switch is instant, local and silent.
 *
 * When it dies and none exists, the router genuinely does not know which of its
 * neighbours route through it — so it stops guessing and asks. The destination
 * goes **ACTIVE**, a QUERY goes to every neighbour, and the router waits for a
 * REPLY from all of them. Neighbours with no answer of their own go ACTIVE and
 * query onward: the computation *diffuses* outward and the replies collapse
 * back inward. That bounded distributed search is what replaces counting.
 *
 * ── Three deliberate departures from doc 05 ──────────────────────────────
 *
 * **A router that is ACTIVE for a destination reports it unreachable.** Doc 05
 * §5.3 freezes the successor and leaves the old distance in place; real EIGRP
 * freezes the *reported* distance and keeps forwarding. Both are correct, and
 * both need the full four-state DUAL machine and its query-origin bookkeeping to
 * stay correct. Saying "I am recomputing, I have no route" instead buys the
 * whole loop-freedom argument in one line — nothing can be installed through a
 * router that is advertising nothing — at the price of a transient unreachable
 * where EIGRP would have a transient sub-optimal path. The successor field is
 * still frozen (it decides who gets an immediate reply, below); it is simply not
 * *used* while the answer is unknown.
 *
 * **A router does not query a neighbour whose query it has not yet answered.**
 * A neighbour that has just queried this router has already said it has no route
 * — asking it back is asking a question it answered in the asking. This is what
 * makes the A–B–C break take two rounds rather than four, and it is what lets a
 * router at the edge of the diffusing wave finish immediately instead of
 * bouncing one more query off the router that woke it up.
 *
 * **\`rd\` lives on the entry, and there is no separate \`received\` map.** Doc 05
 * §5.1 keeps both. They are the same numbers indexed two ways, and two copies of
 * one fact drift; the per-destination map is the one the feasibility condition
 * actually reads.
 */


const DUAL = SIM.dual;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Unlike distance vector, a DUAL router's table is *not* a pure derivation of
 * what its neighbours last said: FD is a memory of what has already been
 * achieved, and the PASSIVE/ACTIVE state is a memory of what is currently being
 * asked. Those are the two things the feasibility condition is built out of, so
 * the entry is genuine per-router state and is stepped rather than rebuilt.
 * \`tables\` below it is the ordinary derived view, refreshed at the end of every
 * pass.
 */
function createState() {
  return {
    /** routerId -> (dest -> Entry) */
    topologyTable: new Map(),
    /** routerId -> (neighbourId -> messages queued for the next round) */
    outbox: new Map(),
    /** routerId -> { dest: Route } — the derived view the UI reads */
    tables: {},
  };
}

/**
 * @param {number} infinity the unreachable ceiling
 * @returns a destination nobody has heard anything about yet: no route, and an
 *   infinite feasible distance, which makes every finite report feasible. That
 *   is the correct starting point rather than a special case — a router with no
 *   route cannot be on anybody's path to anywhere.
 */
function newEntry(infinity) {
  return {
    fd: infinity,
    successor: null,
    cost: infinity,
    /** neighbourId -> the distance it last reported for this destination */
    rd: new Map(),
    state: 'passive',
    /** neighbours whose REPLY is still outstanding */
    awaiting: new Set(),
    /** neighbours that queried us and are owed a REPLY */
    queriers: new Set(),
    activeRounds: 0,
  };
}

function entriesOf(state, routerId) {
  let entries = state.topologyTable.get(routerId);
  if (!entries) {
    entries = new Map();
    state.topologyTable.set(routerId, entries);
  }
  return entries;
}

/** Read-only variant, for the views: asking a question must not create state. */
const peekEntries = (state, routerId) => state.topologyTable.get(routerId) || new Map();

function queue(state, routerId, neighborId, message) {
  let perNeighbor = state.outbox.get(routerId);
  if (!perNeighbor) {
    perNeighbor = new Map();
    state.outbox.set(routerId, perNeighbor);
  }
  const queued = perNeighbor.get(neighborId) || [];
  queued.push(message);
  perNeighbor.set(neighborId, queued);
}

function outboxEmpty(state) {
  let empty = true;
  state.outbox.forEach((perNeighbor) =>
    perNeighbor.forEach((queued) => {
      if (queued.length > 0) empty = false;
    })
  );
  return empty;
}

/** Back to knowing nothing — used when a router is switched off (invariant 12). */
function resetEntry(entry, infinity) {
  entry.fd = infinity;
  entry.successor = null;
  entry.cost = infinity;
  entry.rd.clear();
  entry.awaiting.clear();
  entry.queriers.clear();
  entry.state = 'passive';
  entry.activeRounds = 0;
}

/** What a change to this entry looks like from outside, for the \`changed\` flag. */
const signature = (entry) => \`\${entry.cost}|\${entry.successor}|\${entry.fd}|\${entry.state}\`;

/* ------------------------------------------------------------------ *
 * The core computation
 * ------------------------------------------------------------------ */

/**
 * What \`neighborId\` reports for \`dest\`, or undefined if it has said nothing.
 *
 * A directly attached destination is the one thing a router knows without being
 * told: the destination's own distance to itself is zero, and a router can see
 * its own interfaces. Since link costs are at least 1 and FD is at least 1 for
 * anything but the router itself, a reachable direct neighbour always satisfies
 * the feasibility condition — which is why a destination you are plugged into
 * can never send you ACTIVE.
 */
function reportedBy(entry, dest, neighborId) {
  if (neighborId === dest) return 0;
  return entry.rd.get(neighborId);
}

/**
 * The cheapest neighbour to route through, optionally filtered by the
 * feasibility condition.
 *
 * \`requireFeasible\` is the whole difference between the two situations DUAL
 * distinguishes: while PASSIVE only a neighbour that has *proved* it is not
 * behind us may be installed, whereas the recomputation at the end of a
 * diffusing computation may take the best of everything — every neighbour has
 * just answered, so there is nothing left to prove.
 */
function bestVia(topology, options, routerId, dest, entry, requireFeasible) {
  let best = null;

  topology.neighborsOf(routerId).forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) return;
    const rd = reportedBy(entry, dest, neighborId);
    if (rd === undefined) return;
    // RFC 7868 §3.3: strictly less than. Equality is not good enough — a
    // neighbour exactly as far away as our best could be measuring from the
    // other side of us.
    if (requireFeasible && rd >= entry.fd) return;

    const cost = topology.linkCost(routerId, neighborId) + rd;
    if (cost >= options.infinityCost) return;
    // Keep the incumbent on an exact tie so the successor does not flap
    // (invariant 4).
    if (!best || cost < best.cost || (cost === best.cost && neighborId === entry.successor)) {
      best = { neighborId, cost };
    }
  });

  return best;
}

/** The pre-verified backups: everyone else who passes the FC. */
function feasibleSuccessors(topology, options, routerId, dest, entry) {
  return topology.neighborsOf(routerId).filter((neighborId) => {
    if (neighborId === entry.successor) return false;
    if (!topology.canReach(routerId, neighborId)) return false;
    const rd = reportedBy(entry, dest, neighborId);
    if (rd === undefined || rd >= entry.fd) return false;
    return topology.linkCost(routerId, neighborId) + rd < options.infinityCost;
  });
}

/* ------------------------------------------------------------------ *
 * The finite state machine
 * ------------------------------------------------------------------ */

/**
 * PASSIVE: the ordinary case, and the one that should happen almost always.
 *
 * Two rules do all the work here, and doc 05 §5.3 flags both as easy to get
 * wrong in a way that changes the protocol completely:
 *
 *   - **FD only ever drops while PASSIVE.** If it were allowed to rise with the
 *     cost, the feasibility condition would stop proving anything, because a
 *     neighbour could satisfy it by being far away rather than by being in
 *     front. Loops become possible immediately.
 *   - **A destination with no feasible successor is not guessed at.** It goes
 *     ACTIVE and asks.
 *
 * There is a third rule here that doc 05 §5.3's pseudocode leaves out, and
 * without it the protocol converges on answers that are quietly wrong: a
 * feasible successor may be installed in silence **only while it is no worse
 * than the distance already proved achievable**, \`cost <= FD\`. Raise one link
 * cost on a ring and the reason is immediate — the old successor still reports
 * far less than FD, so it stays feasible however dear the route through it has
 * become, while the genuinely better neighbour reports *at* FD and can never
 * become feasible, because FD is not allowed to rise while PASSIVE. The route
 * would sit at 15 for ever with a 9 available. Asking instead costs one
 * diffusing computation and ends with FD reset to the truth.
 */
function passiveStep(state, topology, options, routerId, dest, entry) {
  const infinity = options.infinityCost;
  const best = bestVia(topology, options, routerId, dest, entry, true);

  if (best && best.cost <= entry.fd) {
    entry.successor = best.neighborId;
    entry.cost = best.cost;
    if (entry.cost < entry.fd) entry.fd = entry.cost;
    return;
  }

  if (entry.successor === null) {
    // Nothing to lose, so nothing to ask about. FD goes back to infinity with
    // the route: a router that admits it cannot reach a destination is not on
    // anyone's path to it, so there is nothing left for the FC to protect and
    // holding a stale bound would only lock out perfectly good future routes.
    entry.cost = infinity;
    entry.fd = infinity;
    return;
  }

  // The successor is gone or has become infeasible and nothing else qualifies.
  const ask = topology
    .neighborsOf(routerId)
    .filter((neighborId) => topology.canReach(routerId, neighborId))
    // A neighbour we owe a reply to has already told us it has no route, in the
    // act of asking. Querying it back would ask a question it has answered.
    .filter((neighborId) => !entry.queriers.has(neighborId))
    // And nobody is asked how to reach itself. Its answer is zero, it is
    // already counted as such, and a router holds no entry for its own id — so
    // the question would go unanswered until the stuck-in-active timer.
    .filter((neighborId) => neighborId !== dest);

  if (ask.length === 0) {
    // Nobody left to ask, so the diffusing computation is already over: take the
    // best of everything on file, with no feasibility test, and reset FD to it.
    const any = bestVia(topology, options, routerId, dest, entry, false);
    entry.successor = any ? any.neighborId : null;
    entry.cost = any ? any.cost : infinity;
    entry.fd = entry.cost;
    return;
  }

  entry.state = 'active';
  entry.activeRounds = 0;
  entry.awaiting = new Set(ask);
  // The successor field is frozen from here (it decides who gets an immediate
  // reply below), but the route is withdrawn: while the answer is unknown this
  // router advertises nothing for \`dest\`, so nothing can be installed through
  // it and no loop can form through it. See the header note.
  entry.cost = infinity;
  ask.forEach((neighborId) =>
    queue(state, routerId, neighborId, {
      kind: 'query',
      label: \`QRY·\${dest}\`,
      payload: { [dest]: infinity },
    })
  );
}

/**
 * ACTIVE: wait for every reply, then recompute with no feasibility test at all.
 *
 * Dropping the test is safe precisely because the wait is over: every neighbour
 * has been asked and has answered, so every reported distance on file is
 * current, and any neighbour that was routing through this router has already
 * been told that it cannot (the query said so). FD is **reset** to the new cost
 * rather than minimised — without the reset a network whose costs genuinely
 * went up could never find a feasible successor again and would go ACTIVE for
 * ever.
 */
function activeStep(state, topology, options, routerId, dest, entry, tick) {
  const infinity = options.infinityCost;
  if (tick) entry.activeRounds += 1;

  if (entry.awaiting.size === 0) {
    const best = bestVia(topology, options, routerId, dest, entry, false);
    entry.successor = best ? best.neighborId : null;
    entry.cost = best ? best.cost : infinity;
    entry.fd = entry.cost;
    entry.state = 'passive';
    return;
  }

  if (entry.activeRounds > options.maxActiveRounds) {
    // Stuck-In-Active. Real EIGRP tears the silent neighbour relationships down
    // after three minutes; here the destination is simply declared unreachable,
    // which is what stops one wedged computation hanging the simulation.
    entry.awaiting.clear();
    entry.successor = null;
    entry.cost = infinity;
    entry.fd = infinity;
    entry.state = 'passive';
  }
}

/**
 * Pay off the queries we owe.
 *
 * A PASSIVE router answers everyone with its current distance. An ACTIVE one
 * answers everyone *except its own successor* straight away — that reply carries
 * the same infinity it is already advertising, so it tells the querier nothing
 * it could act on wrongly — and defers the successor's until the computation
 * collapses. Deferring only for the successor is what keeps the diffusing
 * computation both visible and deadlock-free: two routers can only wait on each
 * other if each is the other's successor, which is a two-hop routing loop, which
 * is the thing the feasibility condition rules out.
 */
function answerQueriers(state, routerId, dest, entry) {
  [...entry.queriers].forEach((neighborId) => {
    if (entry.state === 'active' && neighborId === entry.successor) return;
    entry.queriers.delete(neighborId);
    queue(state, routerId, neighborId, {
      kind: 'reply',
      label: \`RPY·\${dest}\`,
      payload: { [dest]: entry.cost },
    });
  });
}

/**
 * Forget every neighbour that has become unhearable.
 *
 * Doing it here rather than in \`onTopologyChange\` covers every way a neighbour
 * can go away — link removed, router deleted, router switched off — with one
 * rule, and it is what stops a destination hanging until the Stuck-In-Active
 * timer when the router it was waiting on is unplugged (doc 05 §8).
 */
function purgeUnreachable(topology, routerId, entry) {
  entry.rd.forEach((_, neighborId) => {
    if (!topology.canReach(routerId, neighborId)) entry.rd.delete(neighborId);
  });
  entry.awaiting.forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) entry.awaiting.delete(neighborId);
  });
  entry.queriers.forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) entry.queriers.delete(neighborId);
  });
}

/** Add entries for new destinations, drop them for departed ones. */
function syncEntries(state, topology, options) {
  const ids = topology.routerIds;
  const live = new Set(ids);

  [...state.topologyTable.keys()].forEach((routerId) => {
    if (live.has(routerId)) return;
    state.topologyTable.delete(routerId);
    state.outbox.delete(routerId);
  });

  ids.forEach((routerId) => {
    const entries = entriesOf(state, routerId);
    [...entries.keys()].forEach((dest) => {
      if (!live.has(dest)) entries.delete(dest);
    });
    ids.forEach((dest) => {
      if (dest !== routerId && !entries.has(dest)) entries.set(dest, newEntry(options.infinityCost));
    });
  });
}

/**
 * One pass of the machine over every router and every destination.
 *
 * \`tick\` separates a round from a re-derivation: an edit re-runs the machine so
 * the endpoints react at once (invariant 7), but it must not age the
 * Stuck-In-Active counter, or editing a topology while a computation is running
 * would eventually declare it stuck without a single round having passed.
 */
function runMachine(state, topology, options, tick) {
  const infinity = options.infinityCost;
  syncEntries(state, topology, options);
  let changed = false;

  topology.routerIds.forEach((routerId) => {
    const entries = entriesOf(state, routerId);

    if (!topology.isActive(routerId)) {
      state.outbox.delete(routerId);
      entries.forEach((entry) => {
        const before = signature(entry);
        resetEntry(entry, infinity);
        if (signature(entry) !== before) changed = true;
      });
      return;
    }

    entries.forEach((entry, dest) => {
      const before = signature(entry);
      purgeUnreachable(topology, routerId, entry);
      if (entry.state === 'active') {
        activeStep(state, topology, options, routerId, dest, entry, tick);
      } else {
        passiveStep(state, topology, options, routerId, dest, entry);
      }
      answerQueriers(state, routerId, dest, entry);
      if (signature(entry) !== before) changed = true;
    });
  });

  deriveTables(state, topology, options);

  // A destination still being computed, or a message still queued, is work in
  // progress: reporting CONVERGED with a query about to leave would be a lie.
  if (!outboxEmpty(state)) changed = true;
  if (anyActive(state)) changed = true;
  return changed;
}

function anyActive(state) {
  let active = false;
  state.topologyTable.forEach((entries) =>
    entries.forEach((entry) => {
      if (entry.state === 'active') active = true;
    })
  );
  return active;
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/**
 * What \`routerId\` tells \`neighborId\` about everything it can reach.
 *
 * Split horizon is an efficiency measure here and nothing more — say so in the
 * help text. The feasibility condition already makes a route back through the
 * listener unusable, so suppressing it saves a line in a packet rather than
 * preventing a loop. That is the opposite of its role in distance vector, where
 * it is one of the two things standing between the network and counting to
 * infinity.
 */
function advertiseTo(state, topology, options, routerId, neighborId) {
  const payload = { [routerId]: 0 };

  peekEntries(state, routerId).forEach((entry, dest) => {
    if (!topology.has(dest)) return;
    if (entry.cost >= options.infinityCost) return;
    if (options.splitHorizon && entry.successor === neighborId && dest !== neighborId) return;
    payload[dest] = entry.cost;
  });

  return payload;
}

/** An update is the whole table, so a destination it omits is a withdrawal. */
function applyUpdate(state, topology, routerId, fromId, payload) {
  if (!topology.canReach(routerId, fromId)) return;
  peekEntries(state, routerId).forEach((entry, dest) => {
    const reported = payload[dest];
    if (reported === undefined) entry.rd.delete(fromId);
    else entry.rd.set(fromId, reported);
  });
}

/** A query and a reply each name exactly one destination. */
function applyDirected(state, topology, routerId, fromId, payload, kind) {
  if (!topology.canReach(routerId, fromId)) return;
  const entries = peekEntries(state, routerId);

  Object.entries(payload).forEach(([dest, reported]) => {
    const entry = entries.get(dest);
    if (!entry) return;
    entry.rd.set(fromId, reported);
    if (kind === 'reply') entry.awaiting.delete(fromId);
    // A query is also a statement — "I have lost this route" — so the reported
    // distance above matters as much as the question does.
    else entry.queriers.add(fromId);
  });
}

/* ------------------------------------------------------------------ *
 * Derived views
 * ------------------------------------------------------------------ */

function deriveTables(state, topology, options) {
  const infinity = options.infinityCost;
  const tables = {};

  topology.routerIds.forEach((routerId) => {
    const rows = {
      [routerId]: { cost: 0, nextHop: routerId, fd: 0, feasible: [], state: 'Passive' },
    };

    peekEntries(state, routerId).forEach((entry, dest) => {
      if (!topology.has(dest)) return;
      const unreachable = entry.cost >= infinity;
      rows[dest] = {
        cost: unreachable ? infinity : entry.cost,
        // A frozen successor is not an installed one: while the answer is being
        // computed there is no next hop, and the table says so rather than
        // pointing at a hop the router is not using.
        nextHop: unreachable ? null : entry.successor,
        fd: entry.fd,
        feasible: feasibleSuccessors(topology, options, routerId, dest, entry),
        state: entry.state === 'active' ? 'Active' : 'Passive',
      };
    });

    tables[routerId] = rows;
  });

  state.tables = tables;
}

/** Routers with at least one destination still being computed. */
function activeRouters(state, topology) {
  return topology.routerIds.filter((routerId) => {
    if (!topology.isActive(routerId)) return false;
    let active = false;
    peekEntries(state, routerId).forEach((entry) => {
      if (entry.state === 'active') active = true;
    });
    return active;
  });
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

const dual = {
  id: 'dual',
  name: 'DUAL (EIGRP-style)',
  summary:
    'Distance vector with a proof: a neighbour closer than your own best distance cannot be routing through you.',
  messageLabel: 'UPD',

  options: [
    {
      key: 'splitHorizon',
      label: 'Split horizon (efficiency only)',
      type: 'boolean',
      default: DUAL.splitHorizon,
    },
    {
      key: 'maxActiveRounds',
      label: 'Stuck-in-active after (rounds)',
      type: 'number',
      default: DUAL.maxActiveRounds,
      min: DUAL.minRounds,
      max: DUAL.maxRounds,
    },
    {
      key: 'infinityCost',
      label: 'Infinity (display only)',
      type: 'number',
      default: SIM.defaultInfinityCost,
      min: SIM.minInfinityCost,
      max: SIM.maxInfinityCost,
    },
  ],

  /**
   * Five columns, and the last three are the protocol. FD is the bound the
   * feasibility condition is tested against, FS is who passed it, and State is
   * whether this router is currently sure.
   */
  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    { key: 'nextHop', label: 'Successor', format: 'id' },
    { key: 'fd', label: 'FD', format: 'cost' },
    { key: 'feasible', label: 'FS', format: 'list' },
    { key: 'state', label: 'State', format: 'text' },
  ],

  legend: [
    { colorKey: 'queryPacket', label: 'QUERY — "can anyone reach this?"' },
    { colorKey: 'replyPacket', label: 'REPLY — the answer coming back' },
    { colorKey: 'routerActive', label: 'Recomputing (ACTIVE)' },
  ],

  help: [
    {
      heading: 'The feasibility condition, in one inequality',
      items: [
        'FD, the feasible distance, is the lowest cost to a destination this ' +
          'router has managed since the destination was last settled. RD, the ' +
          'reported distance, is what a neighbour says its own cost is. A ' +
          'neighbour is usable when RD < FD — strictly less.',
        'Why that proves loop freedom: if the neighbour were routing through ' +
          'me, its distance would have to include the cost of getting to me, ' +
          'which is at least my distance, which is at least FD. So a neighbour ' +
          'closer than FD cannot be behind me. No timers, no ceiling, no ' +
          'agreement with anybody — one comparison against a number I already ' +
          'had.',
        'The cheapest neighbour passing the test is the successor, the next hop ' +
          'in the table. Everyone else who passes is a feasible successor: a ' +
          'backup already proved safe, listed in the FS column.',
        'FD is not the same as Cost. It only ever falls while the destination ' +
          'is PASSIVE, and it is reset — not minimised — when a diffusing ' +
          'computation finishes. Let it rise with the cost and the inequality ' +
          'stops proving anything; never reset it and a network whose costs ' +
          'genuinely went up can never find a feasible successor again.',
        'Which is why a feasible successor may be installed in silence only ' +
          'while it is no worse than FD. Raise one link cost on a ring and you ' +
          'can watch why: the old successor still reports far below FD, so it ' +
          'stays "feasible" however dear the route through it has become, while ' +
          'the genuinely better neighbour reports exactly at FD and — since FD ' +
          'cannot rise while PASSIVE — could never become feasible. A router ' +
          'about to get worse than it has proved it can do no longer knows it ' +
          'is on the best path, so it asks instead of guessing.',
      ],
    },
    {
      heading: 'Instant failover, and the diffusing computation',
      items: [
        'Load "Feasibility trap" and converge, then select router 1 and read ' +
          'its row for 4: cost 2 through 2, and an FS column listing 5 — a ' +
          'backup already proved safe. Delete link 1 ↔ 2 and the row changes in ' +
          'the same instant, before a single round is run and without one query ' +
          'about 4 being sent. That local, silent, immediate switch is why ' +
          'EIGRP was fast.',
        'Router 1 does go ACTIVE for destination *2* at the same moment, which ' +
          'is worth understanding rather than ignoring: it just lost its direct ' +
          'link, and no third party can possibly report a distance below what ' +
          'that link cost. Losing a directly attached neighbour always costs a ' +
          'diffusing computation for that neighbour. Losing the path *through* ' +
          'one need not, and that is the case the FS column is about.',
        'Now delete 1 ↔ 5 as well. The only way left is through 3, which reports ' +
          '5 — not less than FD, which is 2 — so it fails the test even though ' +
          'the route is perfectly good. Router 1 has no proof, so it stops ' +
          'guessing: the destination goes ACTIVE, a red QUERY goes out, a green ' +
          'REPLY comes back, and the route is installed at cost 6 with FD reset ' +
          'to 6. Two rounds.',
        'On a longer chain the wave is the whole point. Load "Diameter chain", ' +
          'converge, and break 5 ↔ 6: the queries spread outward one hop per ' +
          'round, reach a router that has an answer, and the replies collapse ' +
          'back inward. Routers still waiting are tinted orange. That is a ' +
          'bounded distributed search, and it is what replaces counting to ' +
          'infinity — compare it with the same break under distance vector with ' +
          'split horizon off.',
      ],
    },
    {
      heading: 'What the proof costs',
      items: [
        'The feasibility condition is sufficient, not necessary. A route that ' +
          'is genuinely loop-free can fail it — as router 3 does in ' +
          '"Feasibility trap" — and the router then goes ACTIVE for nothing. ' +
          'DUAL never loops and never counts, but it is not free, and a network ' +
          'with one dear backup path pays for it more often than one with ' +
          'several similar paths.',
        'While a destination is ACTIVE this simulation reports it unreachable ' +
          'rather than continuing to advertise the old distance. Real EIGRP ' +
          'freezes the reported distance and keeps forwarding through the old ' +
          'successor; saying "I am recomputing" instead is what makes the ' +
          'loop-freedom argument fit in a paragraph — nothing can be installed ' +
          'through a router that is advertising nothing. The price is a ' +
          'transient unreachable where EIGRP would have a transient detour.',
        'A computation that never collapses is declared Stuck-In-Active and the ' +
          'destination goes unreachable. Real EIGRP waits three minutes and then ' +
          'tears down the neighbour relationships that never answered; the ' +
          '"Stuck-in-active after" setting is the same guard in rounds, and it ' +
          'is why a wedged query can never hang the simulation.',
        'Split horizon is on the panel because EIGRP uses it, but here it is ' +
          'housekeeping, not correctness: turn it off and the tables settle on ' +
          'exactly the same answers, because the condition — not the silence — ' +
          'is what rules out the loop. That is precisely the claim distance ' +
          'vector cannot make.',
        'The metric is the app\\'s additive link cost. Real EIGRP composes one ' +
          'from bandwidth, delay, load and reliability with configurable ' +
          'K-values (K1 = K3 = 1 by default, which reduces to bandwidth plus ' +
          'delay). That formula is arithmetic; the condition above is the ' +
          'lesson.',
      ],
    },
  ],

  createState(topology, options) {
    const state = createState();
    runMachine(state, topology, options, false);
    return state;
  },

  /**
   * Topology edits. Everything falls through to one machine pass, because
   * every edit reduces to the same two questions the machine already asks:
   * which neighbours can I still hear, and does my successor still pass the
   * test? A router that is switched off is the exception worth naming — it
   * forgets everything and is forgotten (invariant 12), which is handled in
   * the pass itself.
   */
  onTopologyChange(state, topology, options) {
    runMachine(state, topology, options, false);
  },

  /**
   * One synchronous round: send what was queued and what is currently believed,
   * then apply all of it, then step the machine.
   *
   * The explicit outbox is doc 05 §8's advice and it earns its keep: phase 1
   * stays a pure read of state, and a query queued by the machine in round N
   * travels in round N + 1 exactly like a distance-vector table change does.
   */
  round(state, topology, options) {
    // ---- Phase 1: build every message before applying any of them ----
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return;
      const queued = state.outbox.get(routerId);

      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.canReach(routerId, neighborId)) return;
        (queued ? queued.get(neighborId) || [] : []).forEach((message) =>
          messages.push({ from: routerId, to: neighborId, ...message })
        );
        messages.push({
          from: routerId,
          to: neighborId,
          kind: 'update',
          payload: advertiseTo(state, topology, options, routerId, neighborId),
        });
      });
    });
    state.outbox.clear();

    // ---- Phase 2: apply, then run the machine ----
    // Updates first, then replies, then queries: a query is the most recent
    // news a neighbour has about a destination, so it should be the last word.
    ['update', 'reply', 'query'].forEach((kind) => {
      messages.forEach((message) => {
        if (message.kind !== kind) return;
        if (kind === 'update') applyUpdate(state, topology, message.to, message.from, message.payload);
        else applyDirected(state, topology, message.to, message.from, message.payload, kind);
      });
    });

    return { messages, changed: runMachine(state, topology, options, true) };
  },

  tables(state) {
    return state.tables;
  },

  /* ---------------- what the UI shows ---------------- */

  metrics(state, topology) {
    let destinations = 0;
    let outstanding = 0;
    topology.routerIds.forEach((routerId) =>
      peekEntries(state, routerId).forEach((entry) => {
        if (entry.state !== 'active') return;
        destinations += 1;
        outstanding += entry.awaiting.size;
      })
    );

    return [
      { label: 'Routers recomputing', value: activeRouters(state, topology).length },
      { label: 'Destinations ACTIVE', value: destinations },
      { label: 'Replies outstanding', value: outstanding },
    ];
  },

  /** The orange tint draining away *is* the diffusing computation collapsing. */
  decorations(state, topology) {
    const routers = {};
    activeRouters(state, topology).forEach((routerId) => {
      routers[routerId] = 'active';
    });
    return { routers, links: {} };
  },

  /**
   * The DUAL tab: which destinations this router is still unsure about, who it
   * is waiting on, and who is waiting on it. The table columns already carry FD
   * and FS; what they cannot show is the shape of the outstanding conversation.
   */
  inspect(state, topology, options, routerId) {
    const entries = state.topologyTable.get(routerId);
    if (!entries) return [];

    const rows = [];
    entries.forEach((entry, dest) => {
      if (entry.state !== 'active') return;
      rows.push({
        key: dest,
        dest,
        awaiting: [...entry.awaiting].join(', ') || '—',
        owed: [...entry.queriers].join(', ') || '—',
        rounds: \`\${entry.activeRounds} / \${options.maxActiveRounds}\`,
      });
    });

    const queued = state.outbox.get(routerId);
    let pending = 0;
    if (queued) queued.forEach((list) => (pending += list.length));

    return [
      {
        id: 'dual',
        label: 'DUAL',
        blocks: [
          {
            type: 'rows',
            rows: [
              { label: 'Destinations ACTIVE', value: rows.length },
              { label: 'Messages queued', value: pending },
              {
                label: 'Feasible successors held',
                value: topology.routerIds.reduce((total, dest) => {
                  const entry = entries.get(dest);
                  return (
                    total +
                    (entry ? feasibleSuccessors(topology, options, routerId, dest, entry).length : 0)
                  );
                }, 0),
              },
            ],
          },
          rows.length > 0
            ? {
                type: 'table',
                columns: [
                  { key: 'dest', label: 'Dest', format: 'id' },
                  { key: 'awaiting', label: 'Awaiting', format: 'text' },
                  { key: 'owed', label: 'Owes', format: 'text' },
                  { key: 'rounds', label: 'Rounds', format: 'text' },
                ],
                rows,
              }
            : {
                type: 'text',
                text: 'Every destination is PASSIVE — nothing is being recomputed.',
              },
        ],
      },
    ];
  },
};

/* ── The only edit ────────────────────────────────────────────────────────
 * "dual" belongs to the built-in, and two protocols cannot answer to one id
 * — a shared link naming it would mean different things to different people.
 * Rename these to whatever you like; they are ordinary properties.
 * ─────────────────────────────────────────────────────────────────────── */
dual.id = 'dual-copy';
dual.name = 'DUAL (EIGRP-style) — my copy';

return dual;
`,

  /** Link State (OSPF-style) — from linkState.js. */
  'ls': `/* ─────────────────────────────────────────────────────────────────────────
 * Link State (OSPF-style) — the shipped implementation, opened for editing.
 *
 * This is src/engine/protocols/linkState.js, exactly as it runs in
 * the app, with three mechanical changes and nothing else:
 *
 *   - its import lines became the \`helpers\` and \`config\` values the editor
 *     already puts in scope (just below);
 *   - \`export\` was dropped from its declarations, since there is no module
 *     system here — the source *is* a function body;
 *   - the id and name are reassigned at the very bottom, because a protocol
 *     may not reuse a built-in's id. So this copy runs alongside the
 *     original rather than replacing it.
 *
 * Everything in between is the real thing. Change whatever you like — the
 * split-horizon rule, the tie-break, the message a router sends — and press
 * Validate & Activate to watch your version run on the same network.
 * ───────────────────────────────────────────────────────────────────────── */

const SIM = config;
const { compareIds, multipathRoute, tablesEqual } = helpers;
const { ECMP_OPTION } = config;

/**
 * linkState.js — Link-State Routing (OSPF-style), RFC 2328 in miniature.
 *
 * Distance vector says "tell your neighbours what you know about everywhere".
 * Link state says "tell everyone what you know about yourself".
 *
 * Model
 * -----
 * Each router writes one **Link State Advertisement** describing its own
 * adjacencies, stamped with a sequence number and an age, and floods it to the
 * whole network. Every router therefore ends up holding the same **Link State
 * Database** — a complete map — and reads its routing table off a Dijkstra run
 * on its own copy of that map.
 *
 * The routing computation is entirely local. The only distributed part is
 * agreeing on the map, and the only rule that agreement needs is "a strictly
 * higher sequence number wins". Nobody ever relays a *conclusion*, so no
 * conclusion can circulate: link state cannot count to infinity, and its
 * convergence time is bounded by the network diameter rather than by the link
 * costs. That contrast with \`distanceVector.js\` is the whole point of having
 * both.
 *
 * Infinity
 * --------
 * \`options.infinityCost\` survives only as a display sentinel, so \`formatCost\`
 * has something to render as "∞". Nothing here counts upward, and raising the
 * ceiling changes no behaviour beyond how large a link cost may be — which is
 * itself worth demonstrating next to distance vector, where the ceiling is load
 * bearing.
 *
 * What is simplified, and why
 * ---------------------------
 * - Hellos are implicit: one per round on every up link (see \`exchangeHellos\`).
 * - The 7-state adjacency FSM is replaced by "a new adjacency gets the whole
 *   database once" (\`resync\`) — the part of OSPF's Exchange/Loading that the
 *   simulation cannot do without.
 * - Flooding is reliable because rounds are lossless, so there are no LS
 *   acknowledgements or retransmissions.
 * - No areas, no network-LSAs, no DR election: every link here is
 *   point-to-point, which is the only case those exist for.
 */


const { linkState: LS } = SIM;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Everything a router remembers, keyed by router id at the top level so the
 * whole network's state is one object the round can walk deterministically.
 *
 * \`lsdb\` is the only thing that is really *knowledge*; \`tables\` is a cached
 * derivation of it, and the other four are the flooding machinery.
 */
function createState() {
  return {
    /** routerId -> (lsaKey -> Lsa) : this router's own copy of the map */
    lsdb: new Map(),
    /** routerId -> the sequence number it last stamped on its own router-LSA */
    selfSeq: new Map(),
    /** routerId -> (lsaKey -> seq) for the summaries it originates */
    summarySeq: new Map(),
    /** routerId -> (lsaKey -> the neighbour it arrived from, or null if self-written) */
    pending: new Map(),
    /** routerId -> (neighbourId -> consecutive rounds with no hello heard) */
    silence: new Map(),
    /** routerId -> Set<neighbourId> owed a full database copy */
    resync: new Map(),
    /** routerId -> { dest: { nextHop, cost } } */
    tables: {},
  };
}

/**
 * Where an LSA sits in a database.
 *
 * A router-LSA is keyed by its origin, exactly as it was before areas existed —
 * one router, one router-LSA, whatever areas it touches. A summary is keyed by
 * all three things that make it distinct: who wrote it, which area they put it
 * in, and what it describes.
 */
const lsaKey = (lsa) =>
  lsa.type === 'summary' ? \`S|\${lsa.origin}|\${lsa.area}|\${lsa.dest}\` : lsa.origin;

/** An LSA with no \`type\` is a router-LSA — which is what every LSA was. */
const isRouterLsa = (lsa) => Boolean(lsa) && lsa.type !== 'summary';

const mapFor = (store, routerId) => {
  let held = store.get(routerId);
  if (!held) {
    held = new Map();
    store.set(routerId, held);
  }
  return held;
};

const lsdbOf = (state, routerId) => mapFor(state.lsdb, routerId);
const pendingOf = (state, routerId) => mapFor(state.pending, routerId);
const silenceOf = (state, routerId) => mapFor(state.silence, routerId);

function resyncOf(state, routerId) {
  let held = state.resync.get(routerId);
  if (!held) {
    held = new Set();
    state.resync.set(routerId, held);
  }
  return held;
}

/**
 * A copy, because an LSA in flight must not age with the database it came from.
 * Phase 1 builds every message before phase 2 applies any of them (invariant
 * 1); sharing the object would let phase 2's ageing rewrite a message that has
 * already been "sent".
 */
const cloneLsa = (lsa) =>
  lsa.links === undefined ? { ...lsa } : { ...lsa, links: { ...lsa.links } };

/* ------------------------------------------------------------------ *
 * Areas (RFC 2328 §3, §12.4.3, §16.2)
 *
 * A single-area network — which is what every preset is until somebody says
 * otherwise — behaves exactly as it did before any of this existed: one area
 * means no border routers, no summaries and unrestricted flooding, so every
 * function below reduces to what it was.
 *
 * ── Three modelling decisions ────────────────────────────────────────────
 *
 * **An area is a property of a router, not of an interface.** Real OSPF puts
 * each interface in an area, which is what lets one router sit in two of them.
 * Per-router is one number instead of one per link, and the consequence is that
 * a link between two areas has to be assigned to one of them: it goes to the
 * **higher-numbered** area, so an ABR's link into area 1 is in area 1 and the
 * backbone keeps only backbone links. That is the real convention, and it is
 * deterministic for any pair.
 *
 * **A router is in every area its links are in**, plus its own. More than one
 * and it is an area border router: it holds two maps, runs one SPF over both,
 * and is the only thing that can carry a route across.
 *
 * **Containment is enforced by flooding, and the bidirectional check finishes
 * the job.** A router-LSA is only offered to neighbours that share an area with
 * its originator, so an area-1 LSA never reaches a pure area-0 router. An ABR's
 * own LSA does reach both areas and lists all of its links — including ones on
 * the far side — but a router that cannot see the *other* endpoint's LSA skips
 * that edge under §16.1. So the boundary needs no separate rule: it is the point
 * past which nobody can corroborate anything.
 * ------------------------------------------------------------------ */

/** The area an operator put this router in, or the backbone. */
function areaOf(options, routerId) {
  const perRouter = (options.routerOptions || {})[routerId];
  const value = perRouter && perRouter.area;
  return value === undefined ? LS.defaultArea : value;
}

/** Higher-numbered area wins, so the backbone keeps only backbone links. */
const linkAreaOf = (options, a, b) => Math.max(areaOf(options, a), areaOf(options, b));

/** Every area a router participates in: its own, plus every link's. */
function areasOf(topology, options, routerId) {
  const areas = new Set([areaOf(options, routerId)]);
  topology.neighborsOf(routerId).forEach((neighborId) => {
    areas.add(linkAreaOf(options, routerId, neighborId));
  });
  return areas;
}

/** Two routers can exchange an LSA only if they are in the same area. */
function shareArea(topology, options, a, b) {
  const mine = areasOf(topology, options, a);
  return [...areasOf(topology, options, b)].some((area) => mine.has(area));
}

const isBorderRouter = (topology, options, routerId) =>
  areasOf(topology, options, routerId).size > 1;

/** Is the network partitioned into areas at all? Nearly always no. */
function hasAreas(topology, options) {
  const rooms = (options.routerOptions || {});
  if (Object.keys(rooms).length === 0) return false;
  return topology.routerIds.some((id) => areaOf(options, id) !== LS.defaultArea);
}

/**
 * Give every router that exists a place to keep its state, and take it away
 * from routers that no longer do.
 *
 * A removed router's *LSA* is deliberately left in everyone else's database to
 * age out on its own (§5.5). That is the real behaviour, and with the
 * bidirectional check on it is also harmless: its neighbours stop advertising
 * it at once, so every edge into it is one-way and skipped.
 */
function syncRouters(state, topology) {
  topology.routerIds.forEach((routerId) => {
    lsdbOf(state, routerId);
    pendingOf(state, routerId);
    silenceOf(state, routerId);
    resyncOf(state, routerId);
    if (!state.selfSeq.has(routerId)) state.selfSeq.set(routerId, 0);
  });

  [...state.lsdb.keys()].forEach((routerId) => {
    if (!topology.has(routerId)) forgetRouter(state, routerId);
  });
}

function forgetRouter(state, routerId) {
  state.lsdb.delete(routerId);
  state.selfSeq.delete(routerId);
  state.summarySeq.delete(routerId);
  state.pending.delete(routerId);
  state.silence.delete(routerId);
  state.resync.delete(routerId);
  state.silence.forEach((heard) => heard.delete(routerId));
  state.resync.forEach((owed) => owed.delete(routerId));
}

/* ------------------------------------------------------------------ *
 * Origination (§5.2)
 * ------------------------------------------------------------------ */

/**
 * The adjacency set \`routerId\` would advertise right now.
 *
 * Two different failures are detected two different ways, which is the whole
 * reason the silence counter exists: a *link* going down is reported by the
 * router's own interface and is known instantly, while a *neighbour* going away
 * is only noticed when its hellos stop, \`deadRounds\` rounds later. Collapsing
 * the two would delete the sim's most instructive delay.
 */
function ownLinks(state, topology, options, routerId) {
  const links = {};
  if (!topology.isActive(routerId)) return links; // a down router advertises nothing
  const heard = silenceOf(state, routerId);

  topology.neighborsOf(routerId).forEach((neighborId) => {
    if ((heard.get(neighborId) || 0) >= options.deadRounds) return;
    links[neighborId] = topology.linkCost(routerId, neighborId);
  });
  return links;
}

const linksEqual = (a, b) => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
};

/**
 * Write a fresh LSA and queue it for flooding.
 *
 * Sequence numbers only ever go up, and they are kept per router rather than
 * per LSA copy: a router that goes down and comes back must carry on counting
 * from where it left off, or its first LSA after the outage would be rejected
 * as stale by everyone still holding the old one.
 */
function originate(state, topology, options, routerId) {
  const seq = (state.selfSeq.get(routerId) || 0) + 1;
  state.selfSeq.set(routerId, seq);
  lsdbOf(state, routerId).set(routerId, {
    origin: routerId,
    seq,
    age: 0,
    links: ownLinks(state, topology, options, routerId),
  });
  pendingOf(state, routerId).set(routerId, null); // null: flood it to everyone
}

/* ------------------------------------------------------------------ *
 * Summary LSAs (type 3, RFC 2328 §12.4.3)
 * ------------------------------------------------------------------ */

/**
 * What an area border router says about the other side.
 *
 * A summary carries a **distance, not a topology**: "I can reach 7, for 4".
 * That one sentence is the whole lesson of areas, and it is worth stating
 * plainly — *inside* an area OSPF is a link-state protocol with a map that
 * cannot lie to you, and *between* areas it is distance vector. Everything that
 * follows from that follows here too: no router outside an area can check a
 * summary, area 0 has to be contiguous for the distances to compose, and with
 * the backbone rule switched off the sim will count to infinity between areas
 * exactly as \`distanceVector.js\` does within one.
 *
 * An unreachable destination is advertised at the infinity ceiling rather than
 * withdrawn, which is RFC 2328's own answer (LSInfinity) and saves inventing a
 * withdrawal mechanism the flooding rules do not have.
 */
function summaryLsa(origin, area, dest, cost, seq) {
  return { type: 'summary', origin, area, dest, cost, seq, age: 0, links: undefined };
}

/**
 * Everything this router would summarise, as \`lsaKey -> Lsa\`.
 *
 * Three filters. The first is structural; the second and third are RFC 2328
 * §12.4.3, and together they are the reason the backbone exists:
 *
 *   - nothing is summarised *into* an area that already contains it. That
 *     destination is described by the area's own router-LSAs — which is also why
 *     **area 0 has to be contiguous**: split it with a non-backbone area in the
 *     middle and the two halves stop being able to describe each other at all,
 *     because neither will summarise a destination the other considers its own.
 *     Real OSPF has exactly this hole, and virtual links are the patch.
 *   - **only a router attached to the backbone summarises anything.** An ABR
 *     joining areas 1 and 2 without touching area 0 is a misconfiguration, and
 *     ignoring it is what forces inter-area traffic the long way round through
 *     the backbone instead of taking a shortcut nobody can audit.
 *   - a route this router only heard *about* is not pushed back into the
 *     backbone. It came from there.
 */
function desiredSummaries(state, topology, options, routerId) {
  const wanted = new Map();
  if (!topology.isActive(routerId) || !isBorderRouter(topology, options, routerId)) return wanted;

  const table = state.tables[routerId] || {};
  const mine = areasOf(topology, options, routerId);
  if (options.strictBackbone && !mine.has(LS.defaultArea)) return wanted;

  mine.forEach((area) => {
    topology.routerIds.forEach((dest) => {
      if (dest === routerId) return;
      if (areasOf(topology, options, dest).has(area)) return;

      const route = table[dest];
      if (!route || route.nextHop === null || route.cost >= options.infinityCost) return;
      const hearsay = route.fromArea !== undefined && route.fromArea !== null;
      if (hearsay && options.strictBackbone && area === LS.defaultArea) return;

      const lsa = summaryLsa(routerId, area, dest, route.cost, 0);
      wanted.set(lsaKey(lsa), lsa);
    });
  });

  return wanted;
}

/**
 * Re-originate wherever a summary has stopped being true, and delete the ones
 * this router should no longer be making.
 *
 * Same shape as \`reoriginateWhereNeeded\` for router-LSAs, and for the same
 * reason: the answer is *derived* from the current routing table rather than
 * tracked with a dirty flag, so a change suppressed by the rate limit is not
 * lost — it is still true next round.
 */
function reoriginateSummaries(state, topology, options) {
  let changed = false;

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return;
    const lsdb = lsdbOf(state, routerId);
    const seqs = mapFor(state.summarySeq, routerId);
    const wanted = desiredSummaries(state, topology, options, routerId);

    wanted.forEach((lsa, key) => {
      const held = lsdb.get(key);
      if (held && held.cost === lsa.cost && held.age < options.minLsIntervalRounds) return;
      if (held && held.cost === lsa.cost && held.age < options.lsaRefreshRounds) return;
      const seq = (seqs.get(key) || 0) + 1;
      seqs.set(key, seq);
      lsdb.set(key, { ...lsa, seq });
      pendingOf(state, routerId).set(key, null);
      changed = true;
    });

    // Withdrawal: a destination this router can no longer reach, or is no longer
    // allowed to talk about, goes out at the infinity ceiling so that every
    // holder of the old copy stops using it. Silence would leave the stale cost
    // in place until max age.
    lsdb.forEach((lsa, key) => {
      if (lsa.type !== 'summary' || lsa.origin !== routerId) return;
      if (wanted.has(key) || lsa.cost >= options.infinityCost) return;
      const seq = (seqs.get(key) || 0) + 1;
      seqs.set(key, seq);
      lsdb.set(key, { ...lsa, seq, age: 0, cost: options.infinityCost });
      pendingOf(state, routerId).set(key, null);
      changed = true;
    });
  });

  return changed;
}

/**
 * Re-originate wherever a router's own LSA has stopped describing it, or the
 * refresh timer has come round.
 *
 * "Needs a new LSA" is *derived* from the difference between the live adjacency
 * set and the LSA on file rather than tracked with a dirty flag, and that is
 * what makes the rate limit safe: an edit suppressed by \`minLsIntervalRounds\`
 * is not lost, it is simply still true next round and gets picked up then.
 */
function reoriginateWhereNeeded(state, topology, options) {
  let changed = false;

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return;
    const own = lsdbOf(state, routerId).get(routerId);
    // MinLSInterval: at most one re-origination per router per interval, so a
    // flapping link cannot flood the network once per edit.
    if (own && own.age < options.minLsIntervalRounds) return;

    const links = ownLinks(state, topology, options, routerId);
    const describesItself = own && linksEqual(own.links, links);
    const dueForRefresh = own && own.age >= options.lsaRefreshRounds;
    if (describesItself && !dueForRefresh) return;

    originate(state, topology, options, routerId);
    changed = true;
  });

  return changed;
}

/* ------------------------------------------------------------------ *
 * Ageing and hellos (§5.5)
 * ------------------------------------------------------------------ */

/**
 * Every LSA in every database ages by one round; at \`lsaMaxAgeRounds\` it is
 * deleted. This is the *only* way a down router's LSA ever leaves the network,
 * which is what makes the \`requireBidirectional\` demo worth watching.
 */
function ageDatabases(state, topology, options) {
  let expired = false;

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return; // a router that is off runs no timers
    const lsdb = lsdbOf(state, routerId);
    lsdb.forEach((lsa, key) => {
      lsa.age += 1;
      if (lsa.age < options.lsaMaxAgeRounds) return;
      lsdb.delete(key);
      pendingOf(state, routerId).delete(key);
      // A summary this router wrote is deleted here like any other and then
      // written again by the refresh below, which is the same cycle a router-LSA
      // goes through — the sequence number in \`summarySeq\` survives, so the
      // replacement is accepted everywhere rather than rejected as stale.
      expired = true;
    });
  });

  return expired;
}

/**
 * One hello per round on every up link, as RFC 2328's HelloInterval — modelled
 * implicitly rather than as visible messages.
 *
 * A hello on every link every round would triple the packet count and bury the
 * flooding wavefront, which is the thing actually worth watching. Nothing in
 * the protocol depends on their contents; all that matters is *when a router
 * notices silence*, and that is exactly what this counter records.
 */
function exchangeHellos(state, topology, options) {
  topology.routerIds.forEach((routerId) => {
    const heard = silenceOf(state, routerId);
    // Counters for links that no longer exist would keep a dead neighbour alive
    // in \`ownLinks\` forever.
    [...heard.keys()].forEach((neighborId) => {
      if (!topology.hasLink(routerId, neighborId)) heard.delete(neighborId);
    });

    if (!topology.isActive(routerId)) {
      heard.clear(); // it hears nothing while it is off, and relearns on revival
      return;
    }

    topology.neighborsOf(routerId).forEach((neighborId) => {
      const silent = heard.get(neighborId) || 0;
      if (!topology.isActive(neighborId)) {
        heard.set(neighborId, silent + 1);
        return;
      }
      // Heard from again after being written off: the adjacency is new, so the
      // database has to be re-exchanged. This is OSPF's Exchange/Loading, minus
      // the state machine.
      if (silent >= options.deadRounds) resyncOf(state, routerId).add(neighborId);
      heard.set(neighborId, 0);
    });
  });
}

/* ------------------------------------------------------------------ *
 * SPF (§5.4, RFC 2328 §16.1 simplified)
 * ------------------------------------------------------------------ */

const advertises = (lsdb, routerId, neighborId) => {
  const lsa = lsdb.get(routerId);
  return isRouterLsa(lsa) && lsa.links[neighborId] !== undefined;
};

/**
 * The edges leading out of \`current\`, as this database sees them.
 *
 * This one function is the difference between a link-state protocol that
 * black-holes on a stale LSA and one that does not:
 *
 *  - with \`requireBidirectional\` an edge exists only when *both* endpoints
 *    advertise it (RFC 2328 §16.1). A router that has gone away leaves an LSA
 *    claiming links its neighbours have already withdrawn, and those one-sided
 *    claims are skipped.
 *  - with the check off the database is read as an undirected graph — every
 *    adjacency anyone claims is believed, including a dead router's own — so
 *    paths keep being computed *through* the dead router until its LSA ages
 *    out. That is the failure the check exists to prevent, and it is worth
 *    seeing rather than reading about.
 */
function edgesFrom(lsdb, current, options) {
  const edges = new Map();
  const own = lsdb.get(current);

  if (isRouterLsa(own)) {
    Object.entries(own.links).forEach(([neighborId, cost]) => {
      if (options.requireBidirectional && !advertises(lsdb, neighborId, current)) return;
      edges.set(neighborId, cost);
    });
  }
  if (options.requireBidirectional) return edges;

  lsdb.forEach((lsa, key) => {
    // Summaries are distances, not adjacencies, and are no part of the graph.
    if (!isRouterLsa(lsa) || key === current || edges.has(key)) return;
    const cost = lsa.links[current];
    if (cost !== undefined) edges.set(key, cost);
  });
  return edges;
}

/** Cheapest router not yet settled; ties go to the lowest id so SPF is deterministic. */
function cheapestUnsettled(dist, settled) {
  let best = null;
  let bestCost = Infinity;
  dist.forEach((cost, routerId) => {
    if (settled.has(routerId)) return;
    const tied = cost === bestCost && best !== null && compareIds(routerId, best) < 0;
    if (cost < bestCost || tied) {
      best = routerId;
      bestCost = cost;
    }
  });
  return best;
}

/**
 * Which of two equally cheap first hops to keep.
 *
 * The incumbent — the hop this router already uses — wins, so equal-cost paths
 * do not flap from round to round; without that, convergence would never be
 * detected (invariant 4). Failing an incumbent, the lowest id, so the answer
 * does not depend on the order Dijkstra happened to settle things in.
 */
function betterHop(incumbent, held, proposed) {
  if (held === proposed) return held;
  if (incumbent !== undefined && incumbent !== null) {
    if (held === incumbent) return held;
    if (proposed === incumbent) return proposed;
  }
  return compareIds(held, proposed) <= 0 ? held : proposed;
}

/**
 * Dijkstra over one router's own database, rooted at itself.
 *
 * The next hop is *inherited from the parent* rather than recomputed: the first
 * hop of the path to a router is also the first hop of the path to everything
 * behind it. Getting that wrong is the classic link-state bug — the costs come
 * out right and the traffic still goes the wrong way.
 *
 * \`hops\` holds a *list* per destination so ECMP costs nothing structurally.
 * With the option off the list is always one long and the incumbent-sticky
 * tie-break decides it, exactly as before; with it on, equal-cost parents merge
 * their sets. Merging is safe here for a reason worth stating: every link costs
 * at least one, so a parent of a node is strictly closer to the root and has
 * therefore already settled by the time the node does — no equal-cost parent
 * can turn up afterwards and be missed.
 */
function spf(lsdb, rootId, options, previousTable) {
  const dist = new Map([[rootId, 0]]);
  const hops = new Map([[rootId, [rootId]]]);
  const settled = new Set();

  for (;;) {
    const current = cheapestUnsettled(dist, settled);
    if (current === null) break;
    settled.add(current);

    edgesFrom(lsdb, current, options).forEach((cost, neighborId) => {
      if (settled.has(neighborId)) return;
      const candidate = dist.get(current) + cost;
      const known = dist.get(neighborId);
      const proposed = current === rootId ? [neighborId] : hops.get(current);

      if (known === undefined || candidate < known) {
        dist.set(neighborId, candidate);
        hops.set(neighborId, [...proposed]);
        return;
      }
      if (candidate > known) return;

      const held = hops.get(neighborId);
      if (options.ecmp) {
        hops.set(neighborId, [...new Set([...held, ...proposed])]);
        return;
      }
      const incumbent = (previousTable[neighborId] || {}).nextHop;
      hops.set(neighborId, [betterHop(incumbent, held[0], proposed[0])]);
    });
  }

  return { dist, hops };
}

/** Self only. A router that is switched off is not routing anything. */
function darkTable(topology, routerId, options) {
  const table = {};
  topology.routerIds.forEach((dest) => {
    table[dest] =
      dest === routerId
        ? { nextHop: routerId, cost: 0 }
        : { nextHop: null, cost: options.infinityCost };
  });
  return table;
}

/**
 * The cheapest inter-area route to \`dest\`, out of every summary on file.
 *
 * Two rules from RFC 2328 §16.2, and both are visible in the demos:
 *
 *   - an **area border router** examines only the summaries it heard on the
 *     backbone. It has its own first-hand map of every area it is in, and
 *     believing another ABR's hearsay about one of them is how inter-area
 *     routing loops. Turning \`strictBackbone\` off is how to watch that happen.
 *   - the next hop is inherited from the path to the ABR, exactly as it is
 *     inherited from a parent inside the area: the first hop toward a summary's
 *     originator is the first hop toward everything the summary describes.
 */
function bestSummary(state, topology, options, routerId, dest, dist, hops) {
  const lsdb = lsdbOf(state, routerId);
  const onlyBackbone = options.strictBackbone && isBorderRouter(topology, options, routerId);
  let best = null;

  lsdb.forEach((lsa) => {
    if (lsa.type !== 'summary' || lsa.dest !== dest || lsa.origin === routerId) return;
    if (onlyBackbone && lsa.area !== LS.defaultArea) return;
    if (lsa.cost >= options.infinityCost) return; // LSInfinity: a withdrawal

    const toAbr = dist.get(lsa.origin);
    if (toAbr === undefined) return; // the ABR itself is out of reach
    const cost = toAbr + lsa.cost;
    if (cost >= options.infinityCost) return;
    // Cheapest wins; ties go to the lowest ABR id so the answer does not depend
    // on Map iteration order.
    if (best && (cost > best.cost || (cost === best.cost && compareIds(lsa.origin, best.abr) >= 0))) {
      return;
    }
    best = { cost, abr: lsa.origin, area: lsa.area, hops: hops.get(lsa.origin) };
  });

  if (!best) return null;
  return multipathRoute(best.hops[0], best.cost, options.ecmp ? best.hops : null, {
    // Which area's summary this came from, so an ABR re-advertising it can apply
    // the backbone rule — and so the inspector can say where a route came from.
    fromArea: best.area,
    viaBorder: best.abr,
  });
}

function tableFor(state, topology, options, routerId, previousTable) {
  if (!topology.isActive(routerId)) return darkTable(topology, routerId, options);

  const { dist, hops } = spf(lsdbOf(state, routerId), routerId, options, previousTable);
  const table = {};

  topology.routerIds.forEach((dest) => {
    if (dest === routerId) {
      table[dest] = { nextHop: routerId, cost: 0 };
      return;
    }
    const cost = dist.get(dest);
    // Intra-area first, and it wins whatever it costs (RFC 2328 §16): a path
    // computed from a map you hold beats a distance somebody quoted you, even a
    // cheaper one. That preference is also what stops summaries feeding summaries
    // and the areas counting to infinity at each other.
    if (cost !== undefined && cost < options.infinityCost) {
      const reached = hops.get(dest);
      table[dest] = multipathRoute(reached[0], cost, reached);
      return;
    }
    // A real path costlier than the ceiling is one the *display* cannot express,
    // so it reads as unreachable — the same call \`shortestPath\` makes, which is
    // what keeps the correctness meter agreeing with the table it scores.
    table[dest] =
      bestSummary(state, topology, options, routerId, dest, dist, hops) || {
        nextHop: null,
        cost: options.infinityCost,
      };
  });

  return table;
}

/**
 * Re-run SPF everywhere. Rebuilding the container rather than patching it is
 * what drops a deleted router out of the view instead of leaving a ghost entry.
 */
function recomputeAll(state, topology, options) {
  const previous = state.tables;
  const next = {};
  let changed = topology.routerIds.length !== Object.keys(previous).length;

  topology.routerIds.forEach((routerId) => {
    const previousTable = previous[routerId] || {};
    const table = tableFor(state, topology, options, routerId, previousTable);
    if (!tablesEqual(previousTable, table)) changed = true;
    next[routerId] = table;
  });

  state.tables = next;
  return changed;
}

/* ------------------------------------------------------------------ *
 * Flooding (§5.3)
 * ------------------------------------------------------------------ */

/**
 * The caption on the packet in the scene. Naming the origin is what turns a
 * stream of identical spheres into a visible wavefront spreading out from one
 * router.
 */
const floodLabel = (payload) => {
  if (payload.length !== 1) return \`LSA×\${payload.length}\`;
  // A summary and a router-LSA are different kinds of claim, and the packet
  // caption is the only place the difference is visible in flight.
  return payload[0].type === 'summary'
    ? \`SUM·\${payload[0].dest}\`
    : \`LSA·\${payload[0].origin}\`;
};

/** Every LSA \`routerId\` should send \`neighborId\` this round, oldest rule first. */
function payloadFor(state, topology, options, routerId, neighborId) {
  const lsdb = lsdbOf(state, routerId);
  const outbound = pendingOf(state, routerId);
  const wholeDatabase = options.floodWholeDatabase || resyncOf(state, routerId).has(neighborId);

  const keys = wholeDatabase
    ? [...lsdb.keys()]
    : // OSPF never floods an LSA back out of the interface it arrived on: the
      // neighbour that sent it obviously has it already, and re-sending would
      // make every flood echo forever.
      [...outbound.keys()].filter((key) => outbound.get(key) !== neighborId);

  return keys
    .filter((key) => lsdb.has(key))
    .map((key) => lsdb.get(key))
    // Nor to the router that wrote it — the origin holds the authoritative copy
    // by definition, and it is the only one allowed to raise the sequence.
    .filter((lsa) => lsa.origin !== neighborId)
    // Flooding is scoped to an area (§13, §12.4.3). A router-LSA is offered only
    // where its originator is known; a summary only inside the area it was
    // injected into. This is the boundary.
    .filter((lsa) =>
      lsa.type === 'summary'
        ? areasOf(topology, options, neighborId).has(lsa.area)
        : shareArea(topology, options, lsa.origin, neighborId)
    )
    .sort((a, b) => compareIds(lsaKey(a), lsaKey(b)))
    .map(cloneLsa);
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

const linkState = {
  id: 'ls',
  name: 'Link State (OSPF-style)',
  summary:
    'Routers flood their own adjacencies, build an identical map, and each run Dijkstra on it.',
  messageLabel: 'LSA',

  options: [
    {
      key: 'requireBidirectional',
      label: 'Bidirectional check (§16.1)',
      type: 'boolean',
      default: LS.requireBidirectional,
    },
    {
      key: 'floodWholeDatabase',
      label: 'Flood whole database each round',
      type: 'boolean',
      default: LS.floodWholeDatabase,
    },
    {
      key: 'strictBackbone',
      label: 'Backbone rule (§16.2)',
      type: 'boolean',
      default: LS.strictBackbone,
    },
    {
      key: 'deadRounds',
      label: 'Neighbour dead after (rounds)',
      type: 'number',
      default: LS.deadRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'lsaRefreshRounds',
      label: 'LSA refresh (rounds)',
      type: 'number',
      default: LS.lsaRefreshRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'lsaMaxAgeRounds',
      label: 'LSA max age (rounds)',
      type: 'number',
      default: LS.lsaMaxAgeRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'minLsIntervalRounds',
      label: 'Min gap between own LSAs',
      type: 'number',
      default: LS.minLsIntervalRounds,
      min: LS.minRounds,
      max: LS.maxRounds,
    },
    {
      key: 'infinityCost',
      label: 'Infinity (display only)',
      type: 'number',
      default: SIM.defaultInfinityCost,
      min: SIM.minInfinityCost,
      max: SIM.maxInfinityCost,
    },
    ECMP_OPTION,
  ],

  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    { key: 'nextHop', label: 'Next Hop', format: 'hops' },
  ],

  legend: [
    { colorKey: 'lsaPacket', label: 'LSA in flight' },
    { colorKey: 'lsdbStale', label: 'Database out of step' },
    { colorKey: 'spfTree', label: 'SPF tree (route tree overlay)' },
    { colorKey: 'areaBoundary', label: 'Area boundary' },
  ],

  help: [
    {
      heading: 'How link state works',
      items: [
        'Every router writes one advertisement — an LSA — describing only its ' +
          'own links: "I am 3, my neighbours are 2 at cost 6 and 4 at cost 2". ' +
          'It never describes anywhere else.',
        'That LSA is flooded hop by hop across the whole network. A router ' +
          'forwards a newly accepted LSA to every neighbour except the one it ' +
          'arrived from, so one LSA reaches a router d hops away in exactly d ' +
          'rounds and then stops.',
        'An arriving LSA is accepted only if its sequence number is strictly ' +
          'higher than the copy already held. That single rule is the whole ' +
          'correctness argument for flooding.',
        'Once the databases agree, every router runs Dijkstra on its own copy, ' +
          'rooted at itself. The routing computation is entirely local — the ' +
          'only distributed part is agreeing on the map.',
        'Hellos are modelled implicitly: one per round on every working link. ' +
          'A neighbour that misses "Neighbour dead after" of them is written ' +
          'off, which is how a router notices a *neighbour* dying as opposed to ' +
          'a link failing, which its own interface reports at once.',
      ],
    },
    {
      heading: 'Why it cannot count to infinity',
      items: [
        'Nobody ever relays a conclusion. A distance vector router repeats what ' +
          'its neighbour concluded, so a stale conclusion can circulate and ' +
          'climb; here a router only ever repeats a *fact* about someone else, ' +
          'stamped by the only router allowed to write it.',
        'So convergence is bounded by the network diameter and is independent ' +
          'of the link costs. Multiply every cost by ten and it still takes the ' +
          'same number of rounds — the distance-vector count would take ten ' +
          'times as many.',
        'The infinity setting is therefore only a display sentinel here: it is ' +
          'what makes an unreachable route render as ∞. Nothing counts up to ' +
          'it, and raising it changes no behaviour except how expensive a link ' +
          'is allowed to be.',
        'Transient loops still exist while two routers disagree about the map, ' +
          'but they last a round or two rather than a dozen.',
      ],
    },
    {
      heading: 'Distance vector vs link state',
      items: [
        'What a router knows: its neighbours\\' conclusions — versus everyone\\'s raw facts.',
        'What it sends: one entry per destination, to neighbours only — versus ' +
          'its own adjacencies, flooded network-wide.',
        'How the table is built: Bellman-Ford, distributed over rounds — versus ' +
          'Dijkstra, locally, in one shot.',
        'Memory per router: neighbours × destinations — versus the whole map.',
        'Real protocols: RIP and IGRP — versus OSPF (RFC 2328) and IS-IS.',
      ],
    },
    {
      heading: 'Things worth trying',
      items: [
        'Load "Diameter chain", converge, and break a link in the middle. The ' +
          'two endpoints know at once and the news reaches the far end one hop ' +
          'per round. Switch to distance vector with split horizon off and ' +
          'break the same link to watch it count instead.',
        'Turn the bidirectional check off, then take a router in the middle of ' +
          'a chain down. Its neighbours stop advertising it after four rounds, ' +
          'but its own LSA still claims those links, so everyone keeps routing ' +
          'through a router that is not there — a black hole that lasts until ' +
          'the LSA hits max age. Turn the check back on and the same failure ' +
          'clears in about five rounds. That checkbox is RFC 2328 §16.1.',
        'Select a router and switch on "Show route tree": that is its shortest ' +
          'path tree. Click a different router and watch the tree change — same ' +
          'database, different root, different answer.',
        'Open the LSDB tab and step. The ages tick up every round and snap back ' +
          'to zero when a router re-originates, which it does every "LSA ' +
          'refresh" rounds even when nothing has happened.',
        'A settled network is not a silent one: at the refresh interval every ' +
          'router re-floods its LSA, so the round counter stops reporting ' +
          'CONVERGED for a few rounds. That is honest — LSAs really are in flight.',
        'Cut a network in two and the "LSDB in sync" meter stays below full ' +
          'forever, with one half tinted. That is not a bug either: the halves ' +
          'cannot talk, so there is no longer one map to agree on, and each ' +
          'side keeps the other\\'s last known LSAs until they hit max age.',
        'Turn on "Equal-cost multipath" with "Equal-cost diamond" loaded and ' +
          'select router 1: the route tree now covers both sides of the diamond ' +
          'rather than picking one. OSPF has done this since RFC 2328 and it ' +
          'costs the SPF nothing — two parents at the same distance are simply ' +
          'both kept, and everything behind them inherits the pair.',
      ],
    },
    {
      heading: 'Areas: where link state becomes distance vector',
      items: [
        'Select a router and set its "OSPF area". Area 0 is the backbone and the ' +
          'default, so nothing changes until you move something out of it. Load ' +
          '"Two areas, one backbone" for a topology built to show this.',
        'A router-LSA is flooded only inside its own area. So a router in area 0 ' +
          'never holds the map of area 1 — it does not have the topology, and no ' +
          'amount of Dijkstra will give it one. The boundary is visible in the ' +
          'scene as a teal link, and the routers either side of it are marked ◆.',
        'What crosses the boundary instead is a summary LSA: an area border ' +
          'router, which is in both areas and holds both maps, injects into each ' +
          'one a plain "I can reach 7, for 4" about every destination in the ' +
          'other. Open the LSDB tab on a router inside an area and the rows ' +
          'beginning S are those.',
        'That is the whole lesson, and it is worth saying baldly: inside an ' +
          'area OSPF is a link-state protocol, and between areas it is distance ' +
          'vector. A summary is a distance you cannot check. Everything that ' +
          'follows from that follows here — the backbone has to be contiguous ' +
          'for the distances to compose, inter-area routes cannot be verified ' +
          'the way intra-area ones can, and the counters in Stats show inter-area ' +
          'convergence taking an extra round per boundary while the border router ' +
          'recomputes and re-summarises.',
        'Intra-area always beats inter-area, whatever it costs. A path you ' +
          'computed from a map you hold outranks a cheaper number somebody quoted ' +
          'you (§16) — and that preference is also what stops summaries feeding ' +
          'summaries and the two areas counting to infinity at each other.',
        'The "Backbone rule" checkbox is RFC 2328 §16.2: a border router believes ' +
          'summaries only from the backbone, which is what forces inter-area ' +
          'traffic through area 0. Build three areas in a line — 1, then 0, then ' +
          '2 — and it works, because area 0 is in the middle. Wire area 1 ' +
          'straight to area 2 instead and the shortcut is deliberately ignored. ' +
          'Turn the rule off and the shortcut starts working — and so does the ' +
          'loop it makes possible, because there is nothing left checking whose ' +
          'distance is whose. That is what virtual links exist to avoid.',
        'Not modelled: network-LSAs and DR election (every link here is ' +
          'point-to-point), external routes and ASBRs, stub and NSSA areas, and ' +
          'virtual links. Areas are assigned per router rather than per ' +
          'interface, so a link between two areas is counted in the ' +
          'higher-numbered one — which is where a real ABR\\'s interface into ' +
          'area 1 would be anyway.',
      ],
    },
  ],

  createState(topology, options) {
    const state = createState();
    syncRouters(state, topology);
    reoriginateWhereNeeded(state, topology, options);
    recomputeAll(state, topology, options);
    return state;
  },

  /**
   * Areas are per-router configuration, like every other \`routerControls\` knob:
   * area 0 is the backbone and the default, so a network nobody has partitioned
   * is a network in which none of this exists.
   */
  routerControls: [
    {
      key: 'area',
      label: 'OSPF area',
      type: 'number',
      scope: 'router',
      default: LS.defaultArea,
      min: LS.minArea,
      max: LS.maxArea,
    },
  ],

  /**
   * Topology edits, per doc 02 §5.6.
   *
   * Only two events need a special case; everything else falls out of the
   * question origination already asks every round — "does my LSA still describe
   * me?" — which is why a re-cost, a link break and a new link need no branch.
   */
  onTopologyChange(state, topology, options, event = {}) {
    switch (event.type) {
      case 'removeRouter':
        forgetRouter(state, String(event.id));
        break;

      case 'addLink':
        // A new adjacency has to be seeded with the database that already
        // exists, or a router wired into a running network would only ever hear
        // about future changes and never about the map it just joined.
        resyncOf(state, String(event.a)).add(String(event.b));
        resyncOf(state, String(event.b)).add(String(event.a));
        break;

      case 'setRouterActive':
        if (event.active) revive(state, topology, String(event.id));
        break;

      case 'routerOption':
        // Moving a router between areas changes who is allowed to hear its LSA,
        // and its adjacencies are now in a different area from the one they were
        // in. Real OSPF tears those down and rebuilds them, which does two
        // things, and both are needed:
        //
        //   - the router **re-originates**, so the area it has just joined is
        //     flooded a copy with a higher sequence number. Its content has not
        //     changed, so nothing else would ever send it — and a router two hops
        //     into the new area would never learn the newcomer exists.
        //   - its neighbours **resync**, which is how it learns the map of the
        //     area it has joined rather than only what changes there next.
        if (event.key === 'area') {
          const moved = String(event.routerId);
          originate(state, topology, options, moved);
          topology.neighborsOf(moved).forEach((neighborId) => {
            resyncOf(state, moved).add(neighborId);
            resyncOf(state, neighborId).add(moved);
          });
        }
        break;

      default:
        break;
    }

    syncRouters(state, topology);
    reoriginateWhereNeeded(state, topology, options);
    recomputeAll(state, topology, options);
    // An area change is an edit like any other, and this is what makes it take
    // effect at once rather than at the next round: it arrives here as a
    // \`routerOption\` event and the summaries are rewritten from the new map.
    if (reoriginateSummaries(state, topology, options)) {
      recomputeAll(state, topology, options);
    }
  },

  /** One synchronous round: flood, then age, then re-originate, then re-run SPF. */
  round(state, topology, options) {
    syncRouters(state, topology);

    // ---- Phase 1: build every message before applying any of them ----
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return; // a down router forwards nothing
      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.isActive(neighborId)) return;
        const payload = payloadFor(state, topology, options, routerId, neighborId);
        if (payload.length === 0) return;
        messages.push({
          from: routerId,
          to: neighborId,
          kind: 'lsa',
          label: floodLabel(payload),
          payload,
        });
      });
    });

    // Both queues are consumed by the act of building the messages: an LSA is
    // forwarded exactly once, on the round after it arrived.
    state.pending.forEach((outbound) => outbound.clear());
    state.resync.forEach((owed) => owed.clear());

    // ---- Phase 2: apply ----
    let databaseChanged = false;
    messages.forEach(({ from, to, payload }) => {
      const lsdb = lsdbOf(state, to);
      payload.forEach((lsa) => {
        const key = lsaKey(lsa);
        const held = lsdb.get(key);
        // Strictly newer wins; an equal or older sequence number is discarded.
        if (held && lsa.seq <= held.seq) return;
        lsdb.set(key, lsa);
        pendingOf(state, to).set(key, from);
        databaseChanged = true;
      });
    });

    exchangeHellos(state, topology, options);
    if (ageDatabases(state, topology, options)) databaseChanged = true;
    if (reoriginateWhereNeeded(state, topology, options)) databaseChanged = true;

    let tableChanged = recomputeAll(state, topology, options);
    // Summaries are derived from the routing table, so they are written after
    // SPF and take effect next round — which is exactly what a real ABR does,
    // and the one round of lag is where inter-area convergence time goes.
    if (reoriginateSummaries(state, topology, options)) {
      databaseChanged = true;
      if (recomputeAll(state, topology, options)) tableChanged = true;
    }

    // A database change counts even when no table moves: a refresh rippling
    // through a settled network is real work, and reporting "converged" while
    // LSAs are still in flight would be a lie.
    return { messages, changed: databaseChanged || tableChanged };
  },

  tables(state) {
    return state.tables;
  },

  /* ---------------- what the UI shows ---------------- */

  metrics(state, topology, options) {
    const { inSync, total, areas } = agreement(state, topology, options);
    let queued = 0;
    state.pending.forEach((outbound) => {
      queued += outbound.size;
    });

    const rows = [
      { label: 'LSDB in sync', value: \`\${inSync} / \${total}\` },
      { label: 'LSAs queued to flood', value: queued },
    ];
    // Only worth the rows once somebody has drawn a boundary; on a single-area
    // network they would read "1" and "0" for ever.
    if (hasAreas(topology, options)) {
      const borders = topology.routerIds.filter(
        (id) => topology.isActive(id) && isBorderRouter(topology, options, id)
      );
      let summaries = 0;
      state.lsdb.forEach((lsdb) => {
        lsdb.forEach((lsa) => {
          if (lsa.type === 'summary') summaries += 1;
        });
      });
      rows.push({ label: 'Areas', value: areas });
      rows.push({ label: 'Border routers', value: borders.join(', ') || '—' });
      rows.push({ label: 'Summary LSAs held', value: summaries });
    }
    return rows;
  },

  /**
   * Routers whose database does not match the majority *of their own area* are
   * tinted, so the flooding wavefront is visible as the tint draining away
   * rather than only as packets that have already gone — and border routers are
   * marked, since "which router is holding two maps?" is the first question an
   * area diagram raises.
   */
  decorations(state, topology, options) {
    const { signatures, consensus } = agreement(state, topology, options);
    const routers = {};
    const links = {};

    topology.routerIds.forEach((routerId) => {
      // Out of step wins over being a border router: one is a transient the user
      // is watching, the other is a fact about the diagram that is not going to
      // change while they look at it.
      if (signatures.has(routerId) && signatures.get(routerId) !== consensus(routerId)) {
        routers[routerId] = 'stale';
      } else if (isBorderRouter(topology, options, routerId)) {
        routers[routerId] = 'border';
      }
    });

    topology.getLinks().forEach(({ source, destination }) => {
      if (areaOf(options, source) === areaOf(options, destination)) return;
      links[[source, destination].sort(compareIds).join('|')] = 'areaBoundary';
    });

    return { routers, links };
  },

  /** The LSDB tab: what this router believes the map is, and how old it is. */
  inspect(state, topology, options, routerId) {
    const lsdb = state.lsdb.get(routerId);
    if (!lsdb) return [];

    const own = lsdb.get(routerId);
    const adjacencies = own
      ? Object.entries(own.links)
          .sort(([a], [b]) => compareIds(a, b))
          .map(([neighborId, cost]) => \`\${neighborId}@\${cost}\`)
      : [];
    const partitioned = hasAreas(topology, options);

    const rows = [...lsdb.entries()]
      .sort(([a], [b]) => compareIds(a, b))
      .map(([key, lsa]) => ({
        key,
        // A summary describes a destination rather than its originator's links,
        // so the row says which — "S 7 via 3" — instead of pretending they are
        // the same kind of statement.
        origin: lsa.type === 'summary' ? \`S \${lsa.dest}←\${lsa.origin}\` : lsa.origin,
        area: lsa.type === 'summary' ? lsa.area : areaOf(options, lsa.origin),
        seq: lsa.seq,
        age: lsa.age,
        links: lsa.type === 'summary' ? \`cost \${lsa.cost}\` : Object.keys(lsa.links).length,
      }));

    const columns = [
      { key: 'origin', label: 'Origin', format: 'text' },
      ...(partitioned ? [{ key: 'area', label: 'Area', format: 'text' }] : []),
      { key: 'seq', label: 'Seq', format: 'text' },
      { key: 'age', label: 'Age', format: 'text' },
      { key: 'links', label: 'Links', format: 'text' },
    ];

    const summaryOf = (blocks) => blocks;
    return [
      {
        id: 'lsdb',
        label: 'LSDB',
        blocks: summaryOf([
          {
            type: 'rows',
            rows: [
              ...(partitioned
                ? [
                    { label: 'Area', value: areaOf(options, routerId) },
                    {
                      label: 'In areas',
                      value: [...areasOf(topology, options, routerId)]
                        .sort((a, b) => a - b)
                        .join(', '),
                    },
                  ]
                : []),
              { label: 'Own sequence', value: own ? own.seq : '—' },
              { label: 'Advertising', value: adjacencies.join(', ') || 'nothing' },
              { label: 'Entries held', value: rows.length },
              {
                label: 'Refresh due in',
                value: own
                  ? \`\${Math.max(0, options.lsaRefreshRounds - own.age)} rounds\`
                  : '—',
              },
            ],
          },
          { type: 'table', columns, rows },
          {
            type: 'text',
            text:
              'One row per router this one has heard of. Age ticks up every ' +
              'round and resets when the origin re-originates; an entry nobody ' +
              \`refreshes is deleted at \${options.lsaMaxAgeRounds}.\` +
              (partitioned
                ? ' Rows beginning S are summaries: a cost quoted by a border ' +
                  'router, not a map you can check.'
                : ''),
          },
        ]),
      },
    ];
  },
};

/* ------------------------------------------------------------------ *
 * Database agreement
 * ------------------------------------------------------------------ */

/**
 * How far the databases have converged, by hashing each router's \`(origin, seq)\`
 * set and taking the most common answer as the consensus.
 *
 * The mode rather than a fixed reference router: while flooding is in progress
 * "the map most routers hold" is the useful yardstick, and it makes the meter
 * read 1/5 at the start and 5/5 at the end without anyone having to be right.
 */
function agreement(state, topology, options) {
  const signatures = new Map();
  /** area -> (signature -> how many routers hold it) */
  const byArea = new Map();

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId)) return;
    const lsdb = state.lsdb.get(routerId);
    // With areas, routers in different areas hold different databases on purpose,
    // so the question becomes "does everyone in *my* area agree?" — restricted to
    // the router-LSAs of that area, which is the map they are all supposed to
    // share, and asked once per area. With one area that is the whole database
    // asked once, and the answer is the one this meter has always given.
    const area = areaOf(options, routerId);
    const signature = lsdb
      ? [...lsdb.entries()]
          .filter(([, lsa]) => isRouterLsa(lsa) && areaOf(options, lsa.origin) === area)
          .sort(([a], [b]) => compareIds(a, b))
          .map(([key, lsa]) => \`\${key}:\${lsa.seq}\`)
          .join(',')
      : '';
    signatures.set(routerId, signature);
    const counts = byArea.get(area) || new Map();
    counts.set(signature, (counts.get(signature) || 0) + 1);
    byArea.set(area, counts);
  });

  /** The database most of an area holds — the useful yardstick mid-flood. */
  const consensusFor = new Map();
  let inSync = 0;
  byArea.forEach((counts, area) => {
    let best = null;
    let most = 0;
    // Insertion order is router-id order, so an even split resolves to the
    // lowest-id router's database rather than to whichever Map happened to win.
    counts.forEach((count, signature) => {
      if (count <= most) return;
      most = count;
      best = signature;
    });
    consensusFor.set(area, best);
    inSync += most;
  });

  const consensus = (routerId) => consensusFor.get(areaOf(options, routerId));
  return { signatures, consensus, inSync, total: signatures.size, areas: byArea.size };
}

/**
 * A router coming back up (§5.6). It re-originates with \`seq += 1\` and throws
 * its own database away: the network moved on while it was off, and starting
 * from a stale map would let it route on facts everyone else has already
 * retracted.
 */
function revive(state, topology, routerId) {
  lsdbOf(state, routerId).clear();
  pendingOf(state, routerId).clear();
  silenceOf(state, routerId).clear();
  topology.neighborsOf(routerId).forEach((neighborId) => {
    resyncOf(state, routerId).add(neighborId);
    resyncOf(state, neighborId).add(routerId);
  });
}

/* ── The only edit ────────────────────────────────────────────────────────
 * "ls" belongs to the built-in, and two protocols cannot answer to one id
 * — a shared link naming it would mean different things to different people.
 * Rename these to whatever you like; they are ordinary properties.
 * ─────────────────────────────────────────────────────────────────────── */
linkState.id = 'ls-copy';
linkState.name = 'Link State (OSPF-style) — my copy';

return linkState;
`,

  /** Path Vector (BGP-style) — from pathVector.js. */
  'pv': `/* ─────────────────────────────────────────────────────────────────────────
 * Path Vector (BGP-style) — the shipped implementation, opened for editing.
 *
 * This is src/engine/protocols/pathVector.js, exactly as it runs in
 * the app, with three mechanical changes and nothing else:
 *
 *   - its import lines became the \`helpers\` and \`config\` values the editor
 *     already puts in scope (just below);
 *   - \`export\` was dropped from its declarations, since there is no module
 *     system here — the source *is* a function body;
 *   - the id and name are reassigned at the very bottom, because a protocol
 *     may not reuse a built-in's id. So this copy runs alongside the
 *     original rather than replacing it.
 *
 * Everything in between is the real thing. Change whatever you like — the
 * split-horizon rule, the tie-break, the message a router sends — and press
 * Validate & Activate to watch your version run on the same network.
 * ───────────────────────────────────────────────────────────────────────── */

const SIM = config;
const { compareIds, multipathRoute, nextHopsOf } = helpers;
const { ECMP_OPTION } = config;

/**
 * pathVector.js — Path Vector Routing (BGP-style), RFC 4271 in miniature.
 *
 * Distance vector advertises "I can reach D at cost 7". The listener has no way
 * to tell whether that route runs back through itself, which is the entire
 * cause of count-to-infinity and the reason split horizon and poisoned reverse
 * exist as patches.
 *
 * Path vector advertises "I can reach D at cost 7, via B → E → D". Loop
 * prevention becomes trivial and exact: *if I am already on that path, the
 * route is useless to me — discard it* (§9.1.2). No ceiling, no split horizon,
 * no poisoned reverse, and no timer anywhere in the correctness argument.
 *
 * Policy
 * ------
 * The second thing the path buys is **policy**. Once a router can see the whole
 * path it can prefer routes for reasons other than length, and BGP's decision
 * process puts those reasons first: LOCAL_PREF outranks path length, and path
 * length outranks anything resembling a cost. Cost is step 7 of about 13 in the
 * real thing. BGP is a policy protocol first and a shortest-path protocol a
 * distant second, which is why \`preferCost\` is off by default here — and why
 * turning it on is the fastest way to see what the ordering costs you.
 *
 * Infinity
 * --------
 * \`options.infinityCost\` is a display sentinel only, as it is under link state.
 * Nothing counts up to it; it is what makes an unreachable route render as ∞,
 * and it caps how expensive a usable path may be so that the routing tables and
 * the correctness meter agree about what "unreachable" means.
 *
 * One router = one AS. That keeps the model honest without inventing a second
 * layer of entities; the two-tier version is doc 03 §7's stretch goal.
 */


const PV = SIM.pathVector;

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * Everything a router remembers is what each neighbour last told it; \`tables\`
 * is a cached derivation of that, refreshed whenever the advertisements or the
 * topology move.
 *
 * Doc 03 §4.1 also gives the state a \`localPref\` map. It does not live here:
 * LOCAL_PREF is *configuration*, the operator's policy rather than something
 * the router learned, so it rides in \`options.routerOptions\` where
 * \`Simulation.setRouterOption\` puts what the inspector collects. One copy, and
 * it resets with the protocol like every other setting.
 */
function createState() {
  return {
    /** routerId -> (neighbourId -> the table that neighbour last advertised) */
    received: new Map(),
    /** routerId -> { dest: Route } */
    tables: {},
  };
}

function receivedBy(state, routerId) {
  let held = state.received.get(routerId);
  if (!held) {
    held = new Map();
    state.received.set(routerId, held);
  }
  return held;
}

/** Everyone forgets what \`routerId\` told them, and it forgets everyone. */
function forgetRouter(state, routerId) {
  state.received.delete(routerId);
  state.received.forEach((held) => held.delete(routerId));
}

/**
 * The LOCAL_PREF \`routerId\` applies to everything it hears from \`neighborId\`.
 *
 * Sparse: a neighbour nobody has set a preference for is worth the default, so
 * the common case costs no storage and every router starts out impartial.
 */
function prefOf(options, routerId, neighborId) {
  const perRouter = (options.routerOptions || {})[routerId];
  const stored = perRouter && perRouter.localPref;
  const value = stored && stored[neighborId];
  return value === undefined ? PV.defaultLocalPref : value;
}

/* ------------------------------------------------------------------ *
 * The second tier: autonomous systems (doc 03 §7)
 *
 * One router is one AS until somebody says otherwise, which is what
 * \`asOf\` defaulting to the router's own id means — and on that default
 * every function below reduces exactly to the single-tier model, because
 * an AS path of ASes and an AS path of router ids are then the same list.
 *
 * Grouping two routers into one AS is where it gets interesting, because
 * it splits BGP in two:
 *
 *   - **eBGP**, between ASes. The sender prepends its own AS number, and
 *     the receiver rejects any path its own AS already appears in. That is
 *     the loop guard, and it is exact.
 *   - **iBGP**, inside one. Nothing is prepended — no AS is being
 *     traversed — so the guard has nothing to work with, and BGP replaces
 *     it with a blunter rule: a route learned from an iBGP peer is not
 *     passed to another one (RFC 4271 §9.2). That single sentence is why
 *     iBGP needs a full mesh, and why route reflectors exist to get out
 *     of paying for one.
 * ------------------------------------------------------------------ */

/** The AS a router belongs to; its own id unless an operator grouped it. */
function asOf(options, routerId) {
  const perRouter = (options.routerOptions || {})[routerId];
  const value = perRouter && perRouter.as;
  return value === undefined ? String(routerId) : String(value);
}

const isReflector = (options, routerId) =>
  Boolean(((options.routerOptions || {})[routerId] || {}).routeReflector);

/** Same AS on both ends: an internal session, where the path does not grow. */
const isInternal = (options, a, b) => asOf(options, a) === asOf(options, b);

/** Has anyone actually grouped two routers together? Nearly always no. */
function hasTiers(topology, options) {
  const seen = new Set();
  return topology.routerIds.some((id) => {
    const as = asOf(options, id);
    if (seen.has(as)) return true;
    seen.add(as);
    return false;
  });
}

/**
 * Prepend an AS to a path, unless it is already at the front.
 *
 * Real BGP does prepend the same AS more than once — deliberately, to make a
 * route look longer — but as a description of which ASes a packet crosses one
 * entry per AS is what the loop check reads, and collapsing the repeat is what
 * keeps two routers grouped into one AS from inflating every path through them.
 */
const prepend = (as, path) => (path[0] === as ? [...path] : [as, ...path]);

/* ------------------------------------------------------------------ *
 * The three protocol operations
 * ------------------------------------------------------------------ */

/**
 * What \`routerId\` tells \`neighborId\` this round.
 *
 * There is still no split horizon and no poisoned reverse — the path *is* the
 * loop guard and the receiver applies it, so advertising a route back to
 * someone already on its path is harmless; they drop it on sight. What the
 * neighbour's identity decides is not *whether* to speak but in which of BGP's
 * two dialects:
 *
 *   - **eBGP** (different AS): prepend this router's AS. The path grows here and
 *     nowhere else, which is why an eBGP session is the only place the loop guard
 *     gets any evidence.
 *   - **iBGP** (same AS): send the path untouched, because no AS is being
 *     crossed — and withhold anything learned from another internal peer, since
 *     an unchanged path cannot detect the loop that would make (§9.2). A route
 *     reflector is a router allowed to break that rule on purpose.
 *
 * On the default of one router per AS every session is external, so this reduces
 * to the single advertisement it always was.
 */
function advertiseTo(state, options, routerId, neighborId) {
  const table = state.tables[routerId] || {};
  const internal = isInternal(options, routerId, neighborId);
  const mine = asOf(options, routerId);
  const withhold = internal && options.ibgpNoReadvertise && !isReflector(options, routerId);
  const advertised = {};

  Object.entries(table).forEach(([dest, route]) => {
    if (route.nextHop === null) return; // no route, nothing to say
    if (withhold && route.viaIbgp) return;
    // The path is copied, not shared: phase 2 replaces every table, and a
    // message has to keep saying what was true when it was sent (invariant 1).
    advertised[dest] = {
      cost: route.cost,
      path: internal ? [...route.path] : prepend(mine, route.path),
    };
  });

  return advertised;
}

/** An advertisement is only kept while the listener is up and still linked to the sender. */
function receive(state, topology, routerId, fromId, advertised) {
  if (!topology.isActive(routerId) || !topology.hasLink(routerId, fromId)) return;
  receivedBy(state, routerId).set(fromId, advertised);
}

/**
 * BGP's decision process (§9.1.2), reduced to the four steps that mean anything
 * in a one-AS-per-router model.
 *
 * The *order* is the lesson, so it is written as one: preference, then length,
 * then cost — with \`preferCost\` swapping the middle two to show what an IGP
 * would have done instead.
 *
 * Returns false when nothing at all differs, so an equal candidate never
 * displaces the incumbent and the table cannot flap (invariant 4).
 */
function better(candidate, incumbent, options) {
  if (!incumbent) return true;
  if (candidate.pref !== incumbent.pref) return candidate.pref > incumbent.pref;

  const byLength = candidate.path.length - incumbent.path.length;
  const byCost = candidate.cost - incumbent.cost;
  // "Prefer eBGP over iBGP" is a real step of the decision process, and it sits
  // between path length and the metric. On the default of one router per AS every
  // session is external, so it is always a tie and never decides anything — it
  // only starts mattering once somebody groups two routers together.
  const byTier = Number(Boolean(candidate.viaIbgp)) - Number(Boolean(incumbent.viaIbgp));
  const order = options.preferCost
    ? [byCost, byLength, byTier]
    : [byLength, byTier, byCost];
  const decisive = order.find((difference) => difference !== 0);
  if (decisive !== undefined) return decisive < 0;

  // BGP's tie-breaks end at the lowest router id, so the answer never depends
  // on the order the neighbours happened to be walked in.
  return compareIds(candidate.nextHop, incumbent.nextHop) < 0;
}

function bestOf(candidates, options) {
  let best = null;
  candidates.forEach((candidate) => {
    if (better(candidate, best, options)) best = candidate;
  });
  return best;
}

/**
 * Pick the winner, and mark it when *policy* is what won.
 *
 * "Won by policy" is decided by asking the question twice — once for real and
 * once with every neighbour equally preferred — because that is exactly what
 * the claim means: this is not the route the length-and-cost rules would have
 * chosen. Nothing is asked twice while every preference is still equal, which
 * is the default state of the whole network.
 *
 * With ECMP on, every candidate the decision process could not separate from
 * the winner is installed alongside it. "Could not separate" means the three
 * steps that carry meaning — preference, path length, cost — because the only
 * thing left after those is the lowest-id tie-break, which exists to make the
 * answer deterministic rather than to make it better. That is also BGP's own
 * rule for multipath, and note that it is *equal cost*, not the same path: two
 * routes of the same length through different neighbours both count.
 */
function select(candidates, options) {
  const best = bestOf(candidates, options);
  if (!best) return null;

  const contested = candidates.some((candidate) => candidate.pref !== best.pref);
  const winner = !contested
    ? best
    : (() => {
        const neutral = bestOf(
          candidates.map((candidate) => ({ ...candidate, pref: 0 })),
          options
        );
        const decided =
          neutral.nextHop !== best.nextHop ||
          neutral.cost !== best.cost ||
          neutral.path.length !== best.path.length;
        return decided ? { ...best, accent: 'policy' } : best;
      })();

  if (!options.ecmp) return winner;

  const tied = candidates.filter(
    (candidate) =>
      candidate.pref === best.pref &&
      candidate.path.length === best.path.length &&
      candidate.cost === best.cost
  );
  // \`bestOf\` already ends at the lowest next-hop id, so the winner *is* the
  // first of the sorted set — which is what keeps \`path[0] === nextHop\` true,
  // since the path shown is the winner's own.
  return multipathRoute(
    winner.nextHop,
    winner.cost,
    tied.map((candidate) => candidate.nextHop),
    winner
  );
}

/**
 * Rebuild one router's table from the advertisements it currently holds.
 *
 * Deriving rather than patching is invariant 2, and it is what makes the
 * withdrawal machinery unnecessary: a neighbour that has stopped listing a
 * destination simply stops contributing a candidate for it, so the route
 * disappears the round the news arrives.
 */
function tableFor(state, topology, options, routerId, destinations) {
  const infinity = options.infinityCost;
  const held = state.received.get(routerId);
  const mine = asOf(options, routerId);
  const next = { [routerId]: { nextHop: routerId, cost: 0, path: [], pref: Infinity } };

  destinations.forEach((dest) => {
    if (dest === routerId) return;
    const candidates = [];

    topology.neighborsOf(routerId).forEach((neighborId) => {
      // False while either end is down, which is also what leaves a switched-off
      // router with nothing but the route to itself.
      if (!topology.canReach(routerId, neighborId)) return;
      const linkCost = topology.linkCost(routerId, neighborId);
      const pref = prefOf(options, routerId, neighborId);
      const internal = isInternal(options, routerId, neighborId);

      // The direct link is always a candidate, even before the neighbour has
      // said anything at all. It is locally originated rather than learned, so
      // it is never withheld from an internal peer however this router is
      // grouped — reaching your own AS is the IGP's job, not BGP's.
      if (neighborId === dest) {
        const destAs = asOf(options, dest);
        candidates.push({
          nextHop: dest,
          cost: linkCost,
          // No AS is crossed to reach something inside your own.
          path: destAs === mine ? [] : [destAs],
          pref,
          viaIbgp: false,
        });
      }

      const advertised = held && held.get(neighborId);
      const route = advertised && advertised[dest];
      if (!route) return;

      // The sender already prepended its AS if it had one to prepend, so the
      // path arrives finished.
      const path = route.path;
      // §9.1.2: "AS loop detection is done by scanning the full AS path, and
      // checking that the autonomous system number of the local system does not
      // appear in the AS path." One line, and it does the work that split
      // horizon, poisoned reverse and a finite infinity do between them in
      // distance vector — exactly, rather than approximately. It says nothing at
      // all about an internal session, which is what §9.2 is for.
      if (path.includes(mine)) return;
      if (path.length > options.maxPathLength) return;

      const cost = linkCost + route.cost;
      // A path dearer than the ceiling is one the display cannot express, so it
      // reads as unreachable — the same call \`shortestPath\` makes, which is what
      // keeps the correctness meter agreeing with the table it is scoring.
      if (cost >= infinity) return;

      candidates.push({ nextHop: neighborId, cost, path: [...path], pref, viaIbgp: internal });
    });

    // No \`viaIbgp\` on an unreachable route: there is no route, so there is no
    // session it could have been learned over, and a \`false\` there would be a
    // claim rather than an absence.
    next[dest] = select(candidates, options) || {
      nextHop: null,
      cost: infinity,
      path: [],
      pref: 0,
    };
  });

  return next;
}

/**
 * \`helpers.tablesEqual\` compares the hop and the cost, which is the whole route
 * under distance vector and link state. Here the path is both part of what a
 * router believes and part of what it advertises: two routes through the same
 * neighbour at the same cost can carry different paths, and reporting
 * "converged" while those were still moving would stop the round loop with the
 * AS Path column visibly changing under it.
 */
const samePath = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

function tablesMatch(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = a[key];
    const right = b[key];
    return (
      Boolean(right) &&
      left.cost === right.cost &&
      left.nextHop === right.nextHop &&
      samePath(nextHopsOf(left), nextHopsOf(right)) &&
      samePath(left.path, right.path)
    );
  });
}

/**
 * Re-derive every table. Rebuilding the container rather than patching it is
 * what drops a deleted router out of the view instead of leaving a ghost entry.
 */
function recomputeAll(state, topology, options) {
  const destinations = topology.routerIds;
  const previous = state.tables;
  const next = {};
  let changed = destinations.length !== Object.keys(previous).length;

  destinations.forEach((routerId) => {
    const table = tableFor(state, topology, options, routerId, destinations);
    if (!tablesMatch(previous[routerId] || {}, table)) changed = true;
    next[routerId] = table;
  });

  state.tables = next;
  return changed;
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

const pathVector = {
  id: 'pv',
  name: 'Path Vector (BGP-style)',
  summary:
    'Routers advertise the whole path to a destination, and reject any path they are already on.',
  messageLabel: 'PATH',

  options: [
    {
      key: 'preferCost',
      label: 'Prefer total cost, IGP-style',
      type: 'boolean',
      default: PV.preferCost,
    },
    {
      key: 'maxPathLength',
      label: 'Longest AS path accepted',
      type: 'number',
      default: PV.maxPathLength,
      min: PV.minPathLength,
      max: PV.pathLengthCap,
    },
    {
      key: 'ibgpNoReadvertise',
      label: 'iBGP does not re-advertise (§9.2)',
      type: 'boolean',
      default: PV.ibgpNoReadvertise,
    },
    {
      key: 'infinityCost',
      label: 'Infinity (display only)',
      type: 'number',
      default: SIM.defaultInfinityCost,
      min: SIM.minInfinityCost,
      max: SIM.maxInfinityCost,
    },
    ECMP_OPTION,
  ],

  columns: [
    { key: 'cost', label: 'Cost', format: 'cost' },
    { key: 'nextHop', label: 'Next Hop', format: 'hops' },
    { key: 'path', label: 'AS Path', format: 'path' },
  ],

  /**
   * LOCAL_PREF is per *neighbour*, not per router: policy is a statement about
   * who you are willing to route through, and a single number per router could
   * not express it.
   */
  routerControls: [
    /**
     * The AS number. Its default is the router's own id — one router, one
     * autonomous system — which is the model this protocol shipped with, so
     * giving two routers the same number is what turns the second tier on.
     */
    {
      key: 'as',
      label: 'AS number',
      type: 'number',
      scope: 'router',
      defaultFrom: 'routerId',
      min: PV.minAs,
      max: PV.maxAs,
    },
    {
      key: 'routeReflector',
      label: 'Route reflector',
      type: 'boolean',
      scope: 'router',
      default: false,
    },
    {
      key: 'localPref',
      label: 'LOCAL_PREF',
      type: 'number',
      scope: 'neighbor',
      default: PV.defaultLocalPref,
      min: PV.minLocalPref,
      max: PV.maxLocalPref,
      step: PV.localPrefStep,
    },
  ],

  legend: [
    { colorKey: 'pathPacket', label: 'Path advertisement in flight' },
    { colorKey: 'policyRoute', label: 'Route chosen by policy' },
    { colorKey: 'asBoundary', label: 'eBGP session (AS boundary)' },
  ],

  help: [
    {
      heading: 'How path vector works',
      items: [
        'Every advertisement carries the whole path, not just a distance: not ' +
          '"I can reach 4 for 7" but "I can reach 4 for 7, via 3 → 5 → 4". The ' +
          'AS Path column is that path.',
        'A router adds itself to the front of nothing and simply prepends the ' +
          'neighbour it heard the route from, then checks one thing: is my own ' +
          'id already in this path? If so the route would come straight back to ' +
          'me, so it is not considered at all (RFC 4271 §9.1.2).',
        'There is no split horizon here, and no poisoned reverse. Routers ' +
          'advertise everything to everyone — including routes that run back ' +
          'through the listener — because the listener will throw those away on ' +
          'sight. The guard moved from the sender to the receiver, and became ' +
          'exact instead of approximate.',
        'Best-path selection is an ordered list, stopping at the first step ' +
          'that decides: highest LOCAL_PREF, then shortest AS path, then lowest ' +
          'cost, then lowest neighbour id. Notice where cost sits — in real BGP ' +
          'it is step 7 of about 13.',
        'One router here is one autonomous system. Real BGP prepends an AS ' +
          'number rather than a router id, and everything above works the same ' +
          'way one level up.',
      ],
    },
    {
      heading: 'Why the Internet never counts to infinity',
      items: [
        'Load "Three in a line", converge, and delete link 2 ↔ 3. Router 1 ' +
          'holds a route to 3 with the path 2 → 3; router 2 withdraws it by ' +
          'simply not advertising it any more, and 1 has nothing else. Two ' +
          'rounds, and every loop-avoidance option is turned off because there ' +
          'are none to turn on.',
        'Do the same under distance vector with split horizon off and the cost ' +
          'climbs one hop at a time to the infinity ceiling. The difference is ' +
          'not that path vector is cleverer — it is that a distance is a ' +
          'conclusion you cannot check, and a path is one you can.',
        'So the infinity setting here is a display sentinel: it renders an ' +
          'unreachable route as ∞ and caps how dear a usable path may be. ' +
          'Nothing counts up to it.',
        'Withdrawals are implicit. Tables are re-derived from the neighbour ' +
          'tables held on file, so a destination a neighbour has stopped ' +
          'listing stops being a candidate the round the news lands.',
      ],
    },
    {
      heading: 'Path hunting',
      items: [
        'Load "Six-node ring", converge, break a link and step round by round ' +
          'with the AS Path column open. Routers try successively longer paths ' +
          'they had already been told about before settling — that is path ' +
          'hunting, the path vector analogue of counting to infinity.',
        'It terminates quickly, and the reason is visible in the column: every ' +
          'candidate path is loop-free, and there are only finitely many of ' +
          'them. Watch "Longest AS path" in Stats climb and then drop back.',
        'The one thing the path cannot prevent is a *transient* forwarding ' +
          'loop: if two routers lose their own route to a destination in the ' +
          'same instant, each may accept the other\\'s last advertisement, which ' +
          'is loop-free as written but out of date. The next round they hear ' +
          'each other\\'s new path, find themselves on it, and it is over.',
      ],
    },
    {
      heading: 'Policy beats shortest path',
      items: [
        'Select a router and its LOCAL_PREF fields appear, one per neighbour. ' +
          'Higher wins, and it is checked before path length and before cost, ' +
          'so it overrules both.',
        'Try it on "Textbook 5-node": converge, select router 2, and watch its ' +
          'route to 4 go via 5 for a cost of 7. Set LOCAL_PREF → 3 to 200 and ' +
          'the route moves to 3 for a cost of 8 — the expensive way round, on ' +
          'purpose. That is what the Internet actually does, and it surprises ' +
          'people who have only met shortest-path routing.',
        'A route won that way is marked with a pink edge in the table, and the ' +
          'link it uses is tinted in the scene. It will usually also be scored ' +
          'suboptimal by the correctness meter, which is fair: the meter ' +
          'measures distance, and policy is a decision to spend some.',
        'Turn on "Prefer total cost, IGP-style" to swap the middle two steps of ' +
          'the decision process. The protocol then agrees with the shortest ' +
          'path everywhere — which is exactly what BGP is not for.',
        'Equal-cost multipath is off by default here as it is in every real BGP ' +
          'implementation, and the decision process explains why: two routes are ' +
          'interchangeable only if nothing that carries meaning separated them. ' +
          'Turn it on and a tie has to survive preference, then length, then ' +
          'cost — everything except the final lowest-id step, which is there to ' +
          'make the answer deterministic rather than to make it better.',
      ],
    },
    {
      heading: 'Two tiers: inside an AS and between them',
      items: [
        'Select a router and it has an "AS number", defaulting to its own id — ' +
          'one router, one autonomous system, which is the model everything above ' +
          'describes. Give two neighbouring routers the *same* number and the ' +
          'second tier appears. Load "Two ASes, one peering" for a topology built ' +
          'for it.',
        'Sessions then come in two kinds, and the scene marks them: a purple link ' +
          'is eBGP, between ASes, and every other link is iBGP, inside ' +
          'one. The AS Path grows on an eBGP session and nowhere else, which is ' +
          'the whole point — a path is a list of ASes crossed, so crossing none ' +
          'adds nothing. A destination in your own AS shows an empty path.',
        'That leaves iBGP with no loop guard at all: an unchanged path cannot ' +
          'reveal a loop it never recorded. BGP\\'s answer is blunt — a route ' +
          'learned from one internal peer is never passed to another (§9.2) — and ' +
          'the "iBGP does not re-advertise" checkbox is that rule.',
        'Watch what it costs. Put three routers in one AS in a line, with only ' +
          'the far one peering outside: the middle router learns the external ' +
          'route and refuses to pass it on, so the third router never hears about ' +
          'it at all. That is not a bug — it is why iBGP has to be a full mesh ' +
          'between every pair of routers in the AS, which is n²/2 sessions.',
        'The escape is the route reflector: tick it on the middle router and ' +
          'it starts relaying, marked ◈ in the list, and the third router learns ' +
          'the route. Real reflectors carry a CLUSTER_LIST and an ORIGINATOR_ID ' +
          'to detect the loops that reflecting reintroduces; those are not ' +
          'modelled here, so two reflectors pointed at each other will briefly ' +
          'inflate a cost between them before the cheaper route wins. That ' +
          'transient is the honest shape of the problem the real fields solve.',
        'The BGP tab on a selected router lists every session, which side of the ' +
          'boundary it is, and what this router will relay from it.',
        'One more real step of the decision process becomes live with two tiers: ' +
          'prefer eBGP over iBGP, checked after path length and before cost. With ' +
          'one router per AS every session is external, so it never decides ' +
          'anything and you would not know it was there.',
      ],
    },
  ],

  createState(topology, options) {
    const state = createState();
    recomputeAll(state, topology, options);
    return state;
  },

  /**
   * Topology edits, handled by forgetting exactly what has become unhearable
   * and re-deriving. Identical to distance vector's, because the question
   * ("whose advertisements can I still believe?") is the same one — only the
   * answer the advertisements carry has changed.
   *
   * Everything else falls through to the re-derive, which is also what makes a
   * LOCAL_PREF edit take effect at once rather than at the next round: it
   * arrives here as a \`routerOption\` event.
   */
  onTopologyChange(state, topology, options, event = {}) {
    switch (event.type) {
      case 'removeRouter':
        forgetRouter(state, String(event.id));
        break;
      case 'removeLink':
        receivedBy(state, String(event.a)).delete(String(event.b));
        receivedBy(state, String(event.b)).delete(String(event.a));
        break;
      case 'setRouterActive':
        // Invariant 12: a router that is down forgets its neighbours' tables and
        // they forget its, so it cannot come back up believing a lie.
        if (!event.active) forgetRouter(state, String(event.id));
        break;
      default:
        break;
    }
    recomputeAll(state, topology, options);
  },

  /** One synchronous round: snapshot every advertisement, then deliver, then derive. */
  round(state, topology, options) {
    // Phase 1 — build all outbound messages before anything is applied.
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return;
      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.isActive(neighborId)) return;
        // One advertisement per neighbour. It used to be one for everybody,
        // because there was nothing per-listener to decide; with two tiers there
        // is — whether to prepend, and whether to speak at all.
        const payload = advertiseTo(state, options, routerId, neighborId);
        if (Object.keys(payload).length === 0) return;
        messages.push({ from: routerId, to: neighborId, kind: 'path', payload });
      });
    });

    // Phase 2 — deliver, then re-derive every table.
    messages.forEach(({ from, to, payload }) => receive(state, topology, to, from, payload));
    const changed = recomputeAll(state, topology, options);

    return { messages, changed };
  },

  tables(state) {
    return state.tables;
  },

  /* ---------------- what the UI shows ---------------- */

  /**
   * Two numbers, both of which move during the demos this protocol exists for:
   * the longest path anyone is using climbs and falls back as path hunting runs
   * its course, and the policy count is zero until somebody sets a preference.
   */
  metrics(state, topology, options) {
    let longest = 0;
    let policy = 0;

    topology.routerIds.forEach((routerId) => {
      Object.values(state.tables[routerId] || {}).forEach((route) => {
        if (route.nextHop === null) return;
        longest = Math.max(longest, route.path.length);
        if (route.accent === 'policy') policy += 1;
      });
    });

    const rows = [
      { label: 'Longest AS path', value: longest },
      { label: 'Routes chosen by policy', value: policy },
    ];

    // Only once somebody has grouped two routers together. On the default of one
    // AS per router these would read "5 / 7 / 0", which describes nothing.
    if (hasTiers(topology, options)) {
      const systems = new Set(topology.routerIds.map((id) => asOf(options, id)));
      const internal = topology
        .getLinks()
        .filter(({ source, destination }) => isInternal(options, source, destination)).length;
      const reflectors = topology.routerIds.filter((id) => isReflector(options, id));
      rows.push({ label: 'Autonomous systems', value: systems.size });
      rows.push({
        label: 'Sessions (eBGP / iBGP)',
        value: \`\${topology.getLinks().length - internal} / \${internal}\`,
      });
      rows.push({ label: 'Route reflectors', value: reflectors.join(', ') || 'none' });
    }

    return rows;
  },

  /**
   * Every first hop that is carrying traffic because of policy rather than
   * because it was the shortest way.
   *
   * Network-wide rather than per-selected-router: "these links are used for
   * reasons the shortest path would not have chosen" is the fact the LOCAL_PREF
   * demo exists to show. With every preference left at its default, nothing is
   * decorated at all.
   */
  decorations(state, topology, options) {
    const links = {};
    const routers = {};

    // The AS boundaries first, so a policy route drawn over one still wins: the
    // boundary is a fact about the diagram, and a policy route is the thing the
    // user just did.
    if (hasTiers(topology, options)) {
      topology.getLinks().forEach(({ source, destination }) => {
        if (isInternal(options, source, destination)) return;
        links[[source, destination].sort(compareIds).join('|')] = 'asBoundary';
      });
      topology.routerIds.forEach((routerId) => {
        if (isReflector(options, routerId)) routers[routerId] = 'reflector';
      });
    }

    Object.entries(state.tables).forEach(([routerId, table]) => {
      Object.values(table).forEach((route) => {
        if (route.accent !== 'policy' || route.nextHop === null) return;
        links[[routerId, route.nextHop].sort(compareIds).join('|')] = 'policy';
      });
    });

    return { links, routers };
  },

  /**
   * The BGP tab: which AS this router is in and what every session with its
   * neighbours actually is.
   *
   * Offered only once there are two tiers, because until then every session is
   * external and the table would say the same thing on every row.
   */
  inspect(state, topology, options, routerId) {
    if (!hasTiers(topology, options)) return [];

    const mine = asOf(options, routerId);
    const rows = topology.neighborsOf(routerId).map((neighborId) => {
      const internal = isInternal(options, routerId, neighborId);
      return {
        key: neighborId,
        peer: neighborId,
        as: asOf(options, neighborId),
        session: internal ? 'iBGP' : 'eBGP',
        // What this router will pass on from that peer, which is the rule that
        // surprises people.
        passesOn: internal && options.ibgpNoReadvertise && !isReflector(options, routerId)
          ? 'eBGP only'
          : 'everything',
      };
    });

    const learned = Object.values(state.tables[routerId] || {}).filter(
      (route) => route.nextHop !== null && route.viaIbgp
    ).length;

    return [
      {
        id: 'bgp',
        label: 'BGP',
        blocks: [
          {
            type: 'rows',
            rows: [
              { label: 'AS', value: mine },
              {
                label: 'Route reflector',
                value: isReflector(options, routerId) ? 'yes' : 'no',
              },
              { label: 'Routes learned by iBGP', value: learned },
            ],
          },
          {
            type: 'table',
            columns: [
              { key: 'peer', label: 'Peer', format: 'id' },
              { key: 'as', label: 'AS', format: 'text' },
              { key: 'session', label: 'Session', format: 'text' },
              { key: 'passesOn', label: 'Relays', format: 'text' },
            ],
            rows,
          },
          {
            type: 'text',
            text:
              'An eBGP session is where the AS path grows, and therefore the only ' +
              'place the loop check gets any evidence. Across an iBGP session the ' +
              'path is unchanged — so a route heard from one internal peer is not ' +
              'passed to another, unless this router is a route reflector.',
          },
        ],
      },
    ];
  },
};

/* ── The only edit ────────────────────────────────────────────────────────
 * "pv" belongs to the built-in, and two protocols cannot answer to one id
 * — a shared link naming it would mean different things to different people.
 * Rename these to whatever you like; they are ordinary properties.
 * ─────────────────────────────────────────────────────────────────────── */
pathVector.id = 'pv-copy';
pathVector.name = 'Path Vector (BGP-style) — my copy';

return pathVector;
`,

  /** Spanning Tree (802.1D) — from spanningTree.js. */
  'stp': `/* ─────────────────────────────────────────────────────────────────────────
 * Spanning Tree (802.1D) — the shipped implementation, opened for editing.
 *
 * This is src/engine/protocols/spanningTree.js, exactly as it runs in
 * the app, with three mechanical changes and nothing else:
 *
 *   - its import lines became the \`helpers\` and \`config\` values the editor
 *     already puts in scope (just below);
 *   - \`export\` was dropped from its declarations, since there is no module
 *     system here — the source *is* a function body;
 *   - the id and name are reassigned at the very bottom, because a protocol
 *     may not reuse a built-in's id. So this copy runs alongside the
 *     original rather than replacing it.
 *
 * Everything in between is the real thing. Change whatever you like — the
 * split-horizon rule, the tie-break, the message a router sends — and press
 * Validate & Activate to watch your version run on the same network.
 * ───────────────────────────────────────────────────────────────────────── */

const SIM = config;
const { compareIds } = helpers;

/**
 * spanningTree.js — the Spanning Tree Protocol (IEEE 802.1D).
 *
 * The odd one out, and deliberately so. Every other protocol here answers "how
 * do I reach D?"; this one answers "which of my links am I allowed to use at
 * all?". Ethernet frames carry no TTL, so a single loop in a switched network
 * saturates it in seconds — there is nothing to stop a broadcast frame
 * circulating for ever. Operators still want redundant links, so STP keeps
 * every cable plugged in and switches all but a spanning tree of them off,
 * ready to bring one back the moment the tree breaks.
 *
 * Three rules, all driven by comparing four numbers:
 *   1. the bridge with the lowest bridge id is the root;
 *   2. every other bridge picks one root port — its cheapest way to the root;
 *   3. every link elects one designated port, the end nearer the root.
 * Anything that is neither is blocked.
 *
 * No router ever sees the topology and no router ever computes a path, yet the
 * network collectively agrees on one tree. That is the lesson.
 *
 * ── Two deliberate departures from doc 04 ────────────────────────────────
 *
 * **Priority travels in the BPDU.** Doc 04 §4.2 compares bridge ids by looking
 * priorities up in a map shared by every bridge. That is a global read, and the
 * whole claim above is that there are none — so the vector carries the
 * priorities of the root and the sender, exactly as a real BPDU carries the
 * two-byte priority in front of the MAC. A priority change therefore reaches
 * the rest of the network at one hop per round instead of instantly, which is
 * both more honest and more interesting to watch. The priority itself lives in
 * \`options.routerOptions\` with every other per-router knob (the same call
 * \`pathVector.js\` made about LOCAL_PREF): it is configuration, not something a
 * bridge learned.
 *
 * **Message age is a field, not a wall clock.** Without it this protocol counts
 * to infinity exactly as distance vector does: kill the root and its two
 * neighbours will happily quote its vector back and forth at each other for
 * ever, each adding a link cost, because a vector naming the old root always
 * beats one naming a live bridge. 802.1D's answer is the Message Age field —
 * the root sends zero, every hop adds one, and a BPDU at MaxAge is discarded.
 * That is what terminates the count, and it is why \`maxAgeRounds\` is worth an
 * option rather than being a constant nobody notices.
 */


const STP = SIM.spanningTree;

/** Internal port roles, and how the Table tab spells them. */
const ROLE_LABELS = {
  root: 'Root',
  designated: 'Designated',
  blocked: 'Blocked',
};

const linkKey = (a, b) => [a, b].sort(compareIds).join('|');

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * A bridge remembers three things: the best vector it has heard (which is also
 * the vector it sends), which port that came in on, and what every port is
 * currently for. All three are *derived* from \`received\` every round —
 * invariant 2 — so a neighbour that falls silent stops influencing the tree
 * without anything having to be un-done.
 *
 * \`Bpdu = { rootId, rootPriority, rootCost, senderId, senderPriority, age }\`
 *
 * The real vector's fourth field is the sender's *port* id. It collapses to the
 * neighbour id here, because every link is point-to-point: there is never more
 * than one port toward the same bridge.
 */
function createState() {
  return {
    /** routerId -> the Bpdu it would send right now */
    best: new Map(),
    /** routerId -> the neighbour on its best path to the root, or null if it is the root */
    rootPort: new Map(),
    /** routerId -> (neighbourId -> 'root' | 'designated' | 'blocked') */
    roles: new Map(),
    /** routerId -> (neighbourId -> { bpdu, age }) — age counts up, not down */
    received: new Map(),
  };
}

function receivedBy(state, routerId) {
  let held = state.received.get(routerId);
  if (!held) {
    held = new Map();
    state.received.set(routerId, held);
  }
  return held;
}

/** Everyone forgets what \`routerId\` told them, and it forgets everyone. */
function forgetRouter(state, routerId) {
  state.received.delete(routerId);
  state.received.forEach((held) => held.delete(routerId));
}

/** The operator's chosen priority for a bridge, or the 802.1D default. */
function priorityOf(options, routerId) {
  const perRouter = (options.routerOptions || {})[routerId];
  const value = perRouter && perRouter.priority;
  return value === undefined ? STP.defaultPriority : value;
}

/* ------------------------------------------------------------------ *
 * Comparison
 * ------------------------------------------------------------------ */

/**
 * Bridge id = (priority, id), lowest wins.
 *
 * Priority first is the entire reason the field exists: without it the root is
 * whichever switch happens to have the lowest MAC address, which is to say
 * whichever one the manufacturer shipped first.
 */
function compareBridgeId(aId, aPriority, bId, bPriority) {
  return aPriority !== bPriority ? aPriority - bPriority : compareIds(aId, bId);
}

/**
 * 802.1D BPDU comparison: lexicographic over (root bridge, cost to root,
 * sending bridge), lowest wins, field by field.
 *
 * Note what is *not* here: nothing about the receiver, and nothing about time.
 * Two bridges handed the same pair of vectors always reach the same verdict,
 * which is why a tree computed from purely local comparisons is nonetheless
 * globally consistent.
 */
function compareBpdu(a, b) {
  const byRoot = compareBridgeId(a.rootId, a.rootPriority, b.rootId, b.rootPriority);
  if (byRoot !== 0) return byRoot;
  if (a.rootCost !== b.rootCost) return a.rootCost - b.rootCost;
  return compareBridgeId(a.senderId, a.senderPriority, b.senderId, b.senderPriority);
}

/**
 * \`compareAge\` is false on the clock, and the distinction is worth stating.
 *
 * In round mode the round *is* the clock, so a stored BPDU getting one round
 * older is the only way "this news is going stale" becomes visible, and it has
 * to count as a change. On the clock the age is elapsed time and moves whether
 * or not anything happened, so counting it would mean the network never once
 * held still — and quiet is how convergence is defined there.
 */
function sameBpdu(a, b, compareAge = true) {
  if (!a || !b) return a === b;
  return (
    a.rootId === b.rootId &&
    a.rootPriority === b.rootPriority &&
    a.rootCost === b.rootCost &&
    a.senderPriority === b.senderPriority &&
    (!compareAge || a.age === b.age)
  );
}

function sameRoles(a, b) {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  let equal = true;
  a.forEach((role, neighborId) => {
    if (b.get(neighborId) !== role) equal = false;
  });
  return equal;
}

/* ------------------------------------------------------------------ *
 * The computation
 * ------------------------------------------------------------------ */

/**
 * One bridge's view: its best vector, its root port, and a role per port.
 *
 * It starts by assuming it is the root — every bridge does, and stops as soon
 * as it hears better. There is no other initial condition, which is what makes
 * a freshly plugged-in switch safe: claiming the crown is the pessimistic
 * answer, not the optimistic one.
 */
function recompute(state, topology, options, routerId, ageOf) {
  const priority = priorityOf(options, routerId);
  const held = state.received.get(routerId);
  const active = topology.isActive(routerId);

  // The vector being compared against, not the one that will be sent: the
  // fourth field has to stay the bridge that *sent* each candidate or two
  // equal-cost ports could not be told apart at all.
  let winner = {
    rootId: routerId,
    rootPriority: priority,
    rootCost: 0,
    senderId: routerId,
    senderPriority: priority,
  };
  let rootPort = null;
  let rootAge = 0;

  if (active) {
    topology.neighborsOf(routerId).forEach((neighborId) => {
      if (!topology.canReach(routerId, neighborId)) return;
      const heard = held && held.get(neighborId);
      if (!heard) return;

      // The receiving port's cost is added before the comparison — that, and
      // only that, is how a distance accumulates in this protocol.
      const candidate = {
        rootId: heard.bpdu.rootId,
        rootPriority: heard.bpdu.rootPriority,
        rootCost: heard.bpdu.rootCost + topology.linkCost(routerId, neighborId),
        senderId: heard.bpdu.senderId,
        senderPriority: heard.bpdu.senderPriority,
      };
      if (compareBpdu(candidate, winner) >= 0) return;

      winner = candidate;
      rootPort = neighborId;
      rootAge = ageOf(heard);
    });
  }

  const best = {
    rootId: winner.rootId,
    rootPriority: winner.rootPriority,
    rootCost: winner.rootCost,
    senderId: routerId,
    senderPriority: priority,
    // A bridge relaying the root's news says how stale it is; a bridge that
    // believes it *is* the root is the origin, so it starts the count again.
    age: rootPort === null ? 0 : rootAge,
  };

  const roles = new Map();
  if (active) {
    topology.neighborsOf(routerId).forEach((neighborId) => {
      if (neighborId === rootPort) {
        roles.set(neighborId, 'root');
        return;
      }
      const heard = topology.canReach(routerId, neighborId) && held && held.get(neighborId);
      // Designated when my vector beats what I can hear on this port — with no
      // link cost added, because this comparison is about which *end* of the
      // link is nearer the root, not about how far away it is. Exactly one end
      // of every non-tree link loses, which is what makes the result a tree
      // rather than a matter of who asked first.
      roles.set(
        neighborId,
        !heard || compareBpdu(best, heard.bpdu) < 0 ? 'designated' : 'blocked'
      );
    });
  }

  return { best, rootPort, roles };
}

/**
 * Re-derive every bridge's view, and report whether anything moved.
 *
 * Rebuilding the maps rather than patching them is what drops a deleted bridge
 * out of the picture instead of leaving a ghost with opinions.
 */
/** How old a stored BPDU is when the round counter is the only clock there is. */
const storedAge = (entry) => entry.age;

function recomputeAll(state, topology, options, { ageOf = storedAge, compareAge = true } = {}) {
  const nextBest = new Map();
  const nextRootPort = new Map();
  const nextRoles = new Map();
  let changed = topology.routerIds.length !== state.best.size;

  topology.routerIds.forEach((routerId) => {
    const { best, rootPort, roles } = recompute(state, topology, options, routerId, ageOf);
    if (
      !sameBpdu(state.best.get(routerId), best, compareAge) ||
      (state.rootPort.get(routerId) ?? null) !== rootPort ||
      !sameRoles(state.roles.get(routerId), roles)
    ) {
      changed = true;
    }
    nextBest.set(routerId, best);
    nextRootPort.set(routerId, rootPort);
    nextRoles.set(routerId, roles);
  });

  state.best = nextBest;
  state.rootPort = nextRootPort;
  state.roles = nextRoles;
  return changed;
}

/**
 * Every stored BPDU gets one round older; at max age it is forgotten.
 *
 * Two failures ride on this one loop. A neighbour that stops talking is
 * eventually written off, and — the important one — a vector naming a root that
 * no longer exists cannot be kept alive indefinitely by two bridges quoting it
 * to each other, because every quote is one round older than the last.
 */
function ageStored(state, options) {
  const maxAge = options.maxAgeRounds;
  state.received.forEach((held) => {
    held.forEach((entry, neighborId) => {
      entry.age += 1;
      if (entry.age >= maxAge) held.delete(neighborId);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Derived views
 * ------------------------------------------------------------------ */

/**
 * Which links actually carry traffic.
 *
 * A link forwards only when *both* ends are non-blocked, so this is the one
 * place the two bridges' independent decisions are put side by side — and if
 * the comparison rules are right, they never disagree in a way that leaves a
 * loop.
 */
function linkVariants(state, topology) {
  const variants = {};
  topology.getLinks().forEach(({ source, destination }) => {
    const here = state.roles.get(source);
    const there = state.roles.get(destination);
    const a = here && here.get(destination);
    const b = there && there.get(source);
    const forwarding =
      topology.canReach(source, destination) &&
      Boolean(a) &&
      Boolean(b) &&
      a !== 'blocked' &&
      b !== 'blocked';
    variants[linkKey(source, destination)] = forwarding ? 'forwarding' : 'blocked';
  });
  return variants;
}

/**
 * The bridges that believe they are the root.
 *
 * Reported as a list rather than a single id because a partitioned network
 * genuinely has one root per component — that is the correct answer, not a
 * failure to converge, and hiding it behind a single "the root" would make the
 * partition demo unreadable.
 */
function rootsOf(state, topology) {
  return topology.routerIds.filter((routerId) => {
    if (!topology.isActive(routerId)) return false;
    const best = state.best.get(routerId);
    return Boolean(best) && best.rootId === routerId;
  });
}

/* ================================================================== *
 * Timer mode — the port state machine (802.1D §8.4, §8.5)
 *
 * Everything above this line decides a port's *role* and treats it as usable
 * the instant it has one. A real bridge does not: a port that has just been
 * given a role spends one forward delay Listening, hearing BPDUs but forwarding
 * nothing, then another Learning, building its MAC table but still forwarding
 * nothing, and only then Forwarding. Fifteen seconds each, and the failure that
 * started it took up to a max age — twenty — to be noticed at all.
 *
 * That is the famous ~50 seconds, and it is invisible in round mode, where a
 * round has no width. It is the whole reason to put this protocol on a clock.
 *
 * Three properties of the delay are worth having in mind, because each explains
 * a design decision below:
 *
 *   - **The delay is per port, not per bridge.** A ring break moves one port to
 *     Forwarding while the rest of the tree never wavers, so the state has to
 *     live beside the role rather than beside the bridge.
 *   - **Blocking is immediate; forwarding is not.** Losing a comparison takes
 *     a port out of service at once — that asymmetry is the entire safety
 *     argument, because two ports both waiting to come up cannot loop, and two
 *     both waiting to go down could.
 *   - **A port that keeps its role keeps its progress.** Otherwise the periodic
 *     hello would restart the timer every two seconds and nothing would ever
 *     finish coming up.
 * ================================================================== */

/** The 802.1D states, in the order a port climbs them. */
const PORT_STATES = {
  disabled: { label: 'Disabled', forwards: false },
  blocking: { label: 'Blocking', forwards: false },
  listening: { label: 'Listening', forwards: false },
  learning: { label: 'Learning', forwards: false },
  forwarding: { label: 'Forwarding', forwards: true },
};

/** What a port in a given role is *heading* for. */
const TARGET_STATE = { root: 'forwarding', designated: 'forwarding', blocked: 'blocking' };

function createTimerState(topology, options) {
  return {
    topology,
    options,
    /** routerId -> (neighbourId -> { state, since, role, timer }) */
    ports: new Map(),
    /** routerId -> its periodic hello event */
    hellos: new Map(),
  };
}

function portsOf(state, routerId) {
  let held = state.timers.ports.get(routerId);
  if (!held) {
    held = new Map();
    state.timers.ports.set(routerId, held);
  }
  return held;
}

/**
 * A stored BPDU's age *now*: what it arrived carrying, plus how long it has sat
 * here.
 *
 * 802.1D §8.6.1 does exactly this — the receiving port holds the Message Age
 * from the BPDU and increments it as time passes — and it is what makes the
 * clock's version of the max-age rule mean the same thing as the round-mode
 * version. A vector quoted around a ring of bridges that no longer hear the
 * root gets older on every hop *and* while it waits, so every copy of it dies
 * within a max age of the root falling silent instead of circulating.
 */
const agedNow = (clock) => (entry) => entry.bpdu.age + (clock.now - entry.at);

/**
 * Drop every stored BPDU that has reached max age.
 *
 * Nothing is scheduled to do this: the age is elapsed time, so the check
 * happens whenever the state is next looked at, which the hello timer
 * guarantees is at least every two seconds per bridge.
 */
function expireStored(state, clock) {
  const { maxAgeSeconds } = state.timers.options;
  const age = agedNow(clock);
  let expired = false;

  state.received.forEach((held, routerId) => {
    held.forEach((entry, neighborId) => {
      if (age(entry) < maxAgeSeconds) return;
      held.delete(neighborId);
      expired = true;
      clock.log(\`\${routerId} timed out \${neighborId}'s BPDU (max age)\`);
    });
  });

  return expired;
}

/**
 * Move one port toward the state its role implies, and schedule the next step.
 *
 * Three rules, and the asymmetry between the first two is the safety argument:
 *
 *   - **Down is immediate.** A port that has lost its comparison stops
 *     forwarding now, before the bridge that beat it starts. Two ports both
 *     waiting to come up cannot loop; two both waiting to go down could.
 *   - **Up costs two forward delays**, one for Listening and one for Learning —
 *     which is why the classic figure is 2 × 15 and not 3 × 15. Blocking is left
 *     the instant a role arrives; it is the two states above it that wait.
 *   - **A port already climbing is left alone**, whichever forwarding role it
 *     now holds. Re-arming the countdown on every hello would leave it climbing
 *     for ever (a hello every two seconds, a climb of thirty), and restarting it
 *     when a port merely changes which *kind* of forwarding port it is would
 *     punish a bridge for having agreed with its neighbours.
 *
 * Exactly one timer per port, always: the guard is the port's own state rather
 * than a live-timer check, so no path can leave two countdowns running on the
 * same port and no path can leave a non-forwarding port with none.
 */
function advancePort(state, clock, routerId, neighborId, role) {
  const ports = portsOf(state, routerId);
  const { forwardDelaySeconds } = state.timers.options;
  let port = ports.get(neighborId);

  if (!port) {
    // 802.1D's initial condition, and the pessimistic one: a bridge that has
    // just been plugged in forwards nothing until it has been told it may.
    port = { state: 'blocking', since: clock.now, role: null, timer: null };
    ports.set(neighborId, port);
  }

  const target = role === null ? 'disabled' : TARGET_STATE[role];
  port.role = role;

  const stop = () => {
    clock.cancel(port.timer);
    port.timer = null;
  };

  const enter = (next, reason) => {
    if (port.state === next) return;
    port.state = next;
    port.since = clock.now;
    clock.disturb();
    clock.log(\`\${routerId}:\${neighborId} → \${PORT_STATES[next].label} (\${reason})\`);
  };

  if (target !== 'forwarding') {
    stop();
    enter(target, role === null ? 'port disabled' : 'lost the comparison');
    return;
  }
  if (port.state === 'forwarding') {
    stop();
    return;
  }
  // Already on the way up: leave the countdown exactly where it is.
  if (port.state === 'listening' || port.state === 'learning') return;

  const step = () => {
    port.timer = null;
    enter(port.state === 'listening' ? 'learning' : 'forwarding', 'forward delay');
    if (port.state !== 'forwarding') {
      port.timer = clock.schedule(forwardDelaySeconds, step, {
        label: \`\${routerId}:\${neighborId} forward delay\`,
      });
    }
  };

  stop();
  enter('listening', 'given a role');
  port.timer = clock.schedule(forwardDelaySeconds, step, {
    label: \`\${routerId}:\${neighborId} forward delay\`,
  });
}

/** Bring the port map into line with the roles the comparison just produced. */
function syncPorts(state, clock) {
  const { topology } = state.timers;

  [...state.timers.ports.keys()].forEach((routerId) => {
    if (topology.has(routerId)) return;
    state.timers.ports.get(routerId).forEach((port) => clock.cancel(port.timer));
    state.timers.ports.delete(routerId);
  });

  topology.routerIds.forEach((routerId) => {
    const ports = portsOf(state, routerId);
    const roles = state.roles.get(routerId);

    [...ports.keys()].forEach((neighborId) => {
      if (topology.hasLink(routerId, neighborId)) return;
      clock.cancel(ports.get(neighborId).timer);
      ports.delete(neighborId);
    });

    topology.neighborsOf(routerId).forEach((neighborId) => {
      advancePort(state, clock, routerId, neighborId, (roles && roles.get(neighborId)) || null);
    });
  });
}

/**
 * Recompute, then let every port catch up with its new role.
 *
 * One function for every entry point — a hello arriving, a BPDU expiring, a
 * cable being pulled — because the answer to all three is the same: compare the
 * vectors again, and move the ports the comparison affected.
 */
function settleTimers(state, clock) {
  const { topology, options } = state.timers;
  if (recomputeAll(state, topology, options, { ageOf: agedNow(clock), compareAge: false })) {
    clock.disturb();
  }
  syncPorts(state, clock);
}

/**
 * Send this bridge's vector to every neighbour and deliver it there and then.
 *
 * The root's own hello is what all the others relay, so a bridge transmits on
 * its own timer rather than only when it has something new — that steady
 * two-second drumbeat is how silence becomes detectable at all.
 */
function sendHello(state, clock, routerId) {
  const { topology, options } = state.timers;
  if (!topology.isActive(routerId)) return;
  const best = state.best.get(routerId);
  if (!best) return;

  topology.neighborsOf(routerId).forEach((neighborId) => {
    if (!topology.canReach(routerId, neighborId)) return;
    // The age the receiver will hold: what we hold, plus this hop. The
    // per-hop increment is not an option because it is not a knob on a real
    // switch either — 802.1D fixes it at one second — and the interesting
    // number, how much staleness is tolerated, is \`maxAgeSeconds\`.
    const bpdu = { ...best, age: best.age + STP.messageAgeIncrement };
    if (bpdu.age >= options.maxAgeSeconds) return; // too stale to be worth sending on
    clock.emit({ from: routerId, to: neighborId, kind: 'bpdu', payload: bpdu });
    receiveBpdu(state, clock, neighborId, routerId, bpdu);
  });
}

/**
 * Store an arriving BPDU with the instant it landed, so its age can be read as
 * elapsed time rather than tracked with a counter that would need its own timer.
 */
function receiveBpdu(state, clock, routerId, fromId, bpdu) {
  const { topology, options } = state.timers;
  if (!topology.canReach(routerId, fromId)) return;
  if (bpdu.age >= options.maxAgeSeconds) return;

  const held = receivedBy(state, routerId);
  const previous = held.get(fromId);
  held.set(fromId, { bpdu, at: clock.now });
  // A vector identical to the one already on file is a refresh, not news. Saying
  // so is what lets a settled bridged network go quiet while still transmitting
  // every two seconds.
  if (!previous || !sameBpdu(previous.bpdu, bpdu, false)) clock.disturb();
  settleTimers(state, clock);
}

function scheduleHello(state, clock, routerId) {
  const event = clock.schedule(
    state.timers.options.helloSeconds,
    () => {
      // Discard what has gone stale and re-compare *before* transmitting, so the
      // age this bridge relays is the age it currently holds rather than the one
      // it held a hello ago. Expiry is checked here rather than scheduled
      // because the age is elapsed time, and the hello is already the thing that
      // happens often enough to notice.
      if (expireStored(state, clock)) clock.disturb();
      settleTimers(state, clock);
      sendHello(state, clock, routerId);
      scheduleHello(state, clock, routerId); // the loop
    },
    // Background: a settled bridged network still sends a BPDU every two
    // seconds for ever, so an outstanding hello says nothing about whether
    // anything is going on. A forward delay is the opposite — a port is
    // mid-transition — and is scheduled without the flag.
    { background: true, label: \`hello \${routerId}\` }
  );
  state.timers.hellos.set(routerId, event);
}

/** Exactly one hello timer per bridge that is switched on. */
function syncHellos(state, clock) {
  const { topology } = state.timers;

  state.timers.hellos.forEach((event, routerId) => {
    if (topology.isActive(routerId) && topology.has(routerId)) return;
    clock.cancel(event);
    state.timers.hellos.delete(routerId);
  });

  topology.routerIds.forEach((routerId) => {
    if (!topology.isActive(routerId) || state.timers.hellos.has(routerId)) return;
    scheduleHello(state, clock, routerId);
  });
}

function onTimerTopologyChange(state, topology, options, event, clock) {
  state.timers.topology = topology;
  state.timers.options = options;

  switch (event.type) {
    case 'removeRouter':
      forgetRouter(state, String(event.id));
      break;
    case 'removeLink':
      // An interface going down is something a bridge sees for itself, so both
      // ends forget at once. A bridge that is merely switched off is not: its
      // neighbours wait out the max age like everybody else, which is the
      // difference this mode exists to show.
      receivedBy(state, String(event.a)).delete(String(event.b));
      receivedBy(state, String(event.b)).delete(String(event.a));
      break;
    case 'setRouterActive':
      if (!event.active) {
        forgetRouter(state, String(event.id));
        clock.log(
          \`\${event.id} down — its neighbours keep its BPDU for up to \` +
            \`\${options.maxAgeSeconds}s\`
        );
      } else {
        clock.log(\`\${event.id} up — its ports start in Blocking\`);
      }
      break;
    default:
      break;
  }

  syncHellos(state, clock);
  settleTimers(state, clock);
}

/**
 * Is the tree actually settled, or merely between hellos?
 *
 * A port mid-transition schedules a forward delay, which the clock can see, so
 * the only thing left for the protocol to add is the bridge's own view: no port
 * may still be on its way somewhere. Both together are what stop "run to
 * convergence" reporting a finish fifteen seconds into a thirty-second climb.
 */
function portsSettled(state) {
  let settled = true;
  state.timers.ports.forEach((ports, routerId) => {
    if (!state.timers.topology.isActive(routerId)) return;
    ports.forEach((port) => {
      const target = port.role === null ? 'disabled' : TARGET_STATE[port.role];
      if (port.state !== target) settled = false;
    });
  });
  return settled;
}

/* ---------------- the timer-mode views ---------------- */

/** A port's state, or the role-implied answer when there is no clock. */
function portStateOf(state, routerId, neighborId, role) {
  if (!state.timers) return null;
  const port = state.timers.ports.get(routerId)?.get(neighborId);
  if (port) return port.state;
  return role === null ? 'disabled' : TARGET_STATE[role];
}

/**
 * Which links carry traffic, on the clock.
 *
 * The same both-ends rule as round mode, but asking about *forwarding* rather
 * than about not being blocked — because in between there are two states that
 * are neither. A link with one end still Learning gets its own colour, since
 * "plugged in, agreed on, and carrying nothing for another fifteen seconds" is
 * the single most surprising thing about 802.1D.
 */
function timerLinkVariants(state, topology) {
  const variants = {};

  topology.getLinks().forEach(({ source, destination }) => {
    const here = state.roles.get(source);
    const there = state.roles.get(destination);
    const a = portStateOf(state, source, destination, (here && here.get(destination)) || null);
    const b = portStateOf(state, destination, source, (there && there.get(source)) || null);
    const usable = topology.canReach(source, destination);
    const forwards = (name) => Boolean(name) && PORT_STATES[name].forwards;
    const climbing = (name) => name === 'listening' || name === 'learning';

    let variant = 'blocked';
    if (usable && forwards(a) && forwards(b)) variant = 'forwarding';
    else if (usable && (climbing(a) || climbing(b)) && !(a === 'blocking' || b === 'blocking')) {
      variant = 'learning';
    }
    variants[linkKey(source, destination)] = variant;
  });

  return variants;
}

const seconds = (value) => \`\${Math.max(0, value).toFixed(1)}s\`;

/**
 * The Ports tab: what every port is doing, and how long it has left to do it.
 *
 * This is the reason to build the mode. "A port takes thirty seconds to start
 * forwarding" is a fact; watching two bars drain in series is an argument.
 */
function timerInspect(state, topology, options, routerId, clock) {
  if (!state.timers || !clock) return [];
  const ports = state.timers.ports.get(routerId);
  if (!ports) return [];

  const hello = state.timers.hellos.get(routerId);
  const held = state.received.get(routerId);
  const age = agedNow(clock);

  const bars = [...ports.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .filter(([, port]) => port.state !== 'blocking' && port.state !== 'disabled')
    .filter(([, port]) => port.state !== 'forwarding')
    .map(([neighborId, port]) => {
      const left = Math.max(0, options.forwardDelaySeconds - (clock.now - port.since));
      return {
        label: \`\${neighborId} \${PORT_STATES[port.state].label}\`,
        value: left,
        max: options.forwardDelaySeconds,
        caption: \`\${seconds(left)} to \${port.state === 'listening' ? 'learning' : 'forwarding'}\`,
      };
    });

  const rows = [...ports.entries()]
    .sort(([a], [b]) => compareIds(a, b))
    .map(([neighborId, port]) => {
      const heard = held && held.get(neighborId);
      return {
        key: neighborId,
        port: neighborId,
        state: PORT_STATES[port.state].label,
        role: port.role ? ROLE_LABELS[port.role] : '—',
        // How stale the news on this port is — the number that decides whether a
        // dead root is still believed in.
        age: heard ? seconds(age(heard)) : '—',
      };
    });

  return [
    {
      id: 'ports',
      label: 'Ports',
      blocks: [
        {
          type: 'rows',
          rows: [
            {
              label: 'Next hello',
              value: hello && !hello.cancelled ? seconds(hello.at - clock.now) : 'not scheduled',
            },
            {
              label: 'Ports forwarding',
              value: [...ports.values()].filter((port) => PORT_STATES[port.state].forwards)
                .length,
            },
            { label: 'Ports coming up', value: bars.length },
          ],
        },
        {
          type: 'table',
          columns: [
            { key: 'port', label: 'Port', format: 'id' },
            { key: 'state', label: 'State', format: 'text' },
            { key: 'role', label: 'Role', format: 'text' },
            { key: 'age', label: 'BPDU age', format: 'text' },
          ],
          rows,
        },
        bars.length > 0
          ? { type: 'bars', bars }
          : { type: 'text', text: 'Every port has reached the state its role calls for.' },
        {
          type: 'text',
          text:
            \`A port given a role spends \${options.forwardDelaySeconds}s Listening and \` +
            \`another \${options.forwardDelaySeconds}s Learning before it forwards anything. \` +
            \`Losing a role is immediate — that asymmetry is what makes the wait safe. \` +
            \`A BPDU is discarded at \${options.maxAgeSeconds}s.\`,
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

const spanningTree = {
  id: 'stp',
  name: 'Spanning Tree (802.1D)',
  summary:
    'Bridges elect a root and switch off every link outside the tree, keeping redundancy without loops.',
  messageLabel: 'BPDU',

  /**
   * The one protocol here with nothing to score against shortest paths: its
   * rows are ports, not destinations. The correctness meter, the per-router
   * chips and the route-tree overlay all switch themselves off.
   */
  hasRoutingTables: false,

  options: [
    {
      key: 'maxAgeRounds',
      label: 'BPDU max age (rounds)',
      type: 'number',
      default: STP.maxAgeRounds,
      min: STP.minRounds,
      max: STP.maxRounds,
      modes: ['rounds'],
    },
    {
      key: 'infinityCost',
      label: 'Cost ceiling (link costs stay below)',
      type: 'number',
      default: SIM.defaultInfinityCost,
      min: SIM.minInfinityCost,
      max: SIM.maxInfinityCost,
    },

    // 802.1D's real timers, offered only on the clock. In round mode a round has
    // no width, so "fifteen seconds Listening" describes nothing.
    {
      key: 'helloSeconds',
      label: 'Hello interval (s)',
      type: 'number',
      default: STP.helloSeconds,
      min: SIM.timers.minSeconds,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
    },
    {
      key: 'forwardDelaySeconds',
      label: 'Forward delay (s)',
      type: 'number',
      default: STP.forwardDelaySeconds,
      min: 0,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
    },
    {
      key: 'maxAgeSeconds',
      label: 'Max age (s)',
      type: 'number',
      default: STP.maxAgeSeconds,
      min: SIM.timers.minSeconds,
      max: SIM.timers.maxSeconds,
      modes: ['timers'],
    },
  ],

  /**
   * Bridges speak every two seconds, so waiting RIP's thirty to call the tree
   * settled would be waiting for nothing. Three hellos is long enough that a
   * bridge about to change its mind has had the chance to.
   */
  quietSeconds: STP.quietSeconds,

  /**
   * Ports, not destinations — so the first column is labelled accordingly.
   *
   * Cost to root is plain text rather than a cost: there is no such thing as an
   * unreachable root here (a bridge nobody can reach is simply its own root at
   * zero), so rendering a dear-but-real tree as ∞ would be a lie.
   */
  rowLabel: 'Port',
  columns: [
    { key: 'role', label: 'Role', format: 'text' },
    // Only on the clock: a port has a *state* distinct from its role only once
    // there is time for it to take thirty seconds crossing between them.
    { key: 'state', label: 'State', format: 'text', modes: ['timers'] },
    { key: 'cost', label: 'Cost to Root', format: 'text' },
    { key: 'nextHop', label: 'Toward Root', format: 'id' },
  ],

  routerControls: [
    {
      key: 'priority',
      label: 'Bridge priority',
      type: 'number',
      scope: 'router',
      default: STP.defaultPriority,
      min: STP.minPriority,
      max: STP.maxPriority,
      step: STP.priorityStep,
    },
  ],

  legend: [
    { colorKey: 'bpduPacket', label: 'BPDU in flight' },
    { colorKey: 'routerRoot', label: 'Root bridge' },
    { colorKey: 'linkBlocked', label: 'Blocked — forwards nothing' },
    // Only ever seen on the clock, but a legend that changed with the mode would
    // be one more thing to notice than it is worth.
    { colorKey: 'linkLearning', label: 'Coming up (timer mode)' },
  ],

  help: [
    {
      heading: 'How spanning tree works',
      items: [
        'Every bridge starts by claiming to be the root, and stops the moment ' +
          'it hears from a better one. "Better" means a lower bridge id, which ' +
          'is the priority followed by the id — priority first, so an operator ' +
          'can choose the root instead of leaving it to whichever switch has ' +
          'the lowest MAC address.',
        'A BPDU carries four things: whose root this is, what it costs the ' +
          'sender to get there, who sent it, and how many hops ago the root ' +
          'issued it. Bridges compare those field by field, lowest wins, and ' +
          'that comparison is the entire protocol.',
        'The receiving port\\'s cost is added before comparing, so the cheapest ' +
          'port toward the root becomes the root port — one per bridge, none on ' +
          'the root itself. The Table tab lists a bridge\\'s ports rather than ' +
          'destinations, because that is genuinely all it decides.',
        'Every other port is designated if this bridge\\'s own vector beats what ' +
          'it can hear on that port, and blocked otherwise. Exactly one end of ' +
          'each link outside the tree loses that comparison, which is why the ' +
          'result is a tree and not a stand-off.',
        'A link forwards only when both of its ends are non-blocked. Green ' +
          'links are the tree; dark grey links are still plugged in, still ' +
          'exchanging BPDUs, and carrying nothing else.',
      ],
    },
    {
      heading: 'Why blocking beats unplugging',
      items: [
        'An Ethernet frame has no TTL. One loop and a single broadcast frame ' +
          'circulates for ever, multiplying at every junction, and the network ' +
          'saturates in seconds. This is not a slow degradation — it is the ' +
          'classic broadcast storm, and it is why a switched network cannot ' +
          'simply tolerate a loop the way an IP network tolerates one.',
        'So the redundant cable stays in the rack, blocked. It costs nothing ' +
          'while the tree is healthy and it is already there when the tree ' +
          'breaks. Load "Ring with unequal costs", break a green link, and ' +
          'watch the dark one come alive a few rounds later without anybody ' +
          'touching anything.',
        'Notice that the surviving tree is a shortest-path tree rooted at the ' +
          'root bridge: each bridge\\'s cost to the root is exactly the cheapest ' +
          'way there. It is not a shortest-path tree between any other pair, ' +
          'which is the standing complaint about STP — traffic between two ' +
          'access switches may go all the way up to the root and back down.',
      ],
    },
    {
      heading: 'Move the root yourself',
      items: [
        'Select a bridge and its priority field appears. Drop it below 32768 ' +
          'and that bridge becomes the root regardless of its id; the tree ' +
          'reshapes around it over the next few rounds as the news travels one ' +
          'hop per round.',
        'This is the experiment worth doing on "Redundant core": the root ' +
          'should be a core switch, and by default it is only the one that ' +
          'happens to have the lowest id. Set the other core to 4096 and watch ' +
          'every access bridge re-home.',
        'Then take the root down entirely. A new root is elected, but not ' +
          'instantly — see below.',
      ],
    },
    {
      heading: 'Max age, and the diameter limit',
      items: [
        'Kill the root and its neighbours are left holding its vector, which ' +
          'still beats anything a live bridge can claim. Left alone they would ' +
          'quote it back and forth for ever, each adding a link cost: spanning ' +
          'tree counts to infinity just as distance vector does.',
        'The fix is the age field. The root sends zero, every hop adds one, and ' +
          'a BPDU at "BPDU max age" is discarded rather than stored. The old ' +
          'root\\'s news therefore has a finite lifetime, after which the ' +
          'survivors fall back to claiming the crown themselves and a real ' +
          'election happens. Watch the round counter after taking a root down: ' +
          'the delay is the max age draining away.',
        'The price is a limit on how wide a bridged network can be. A bridge ' +
          'more than max-age-minus-one hops from the root along the tree throws ' +
          'the root\\'s BPDU away as too old and crowns itself, splitting the ' +
          'network into two trees that both think they are right. Real 802.1D ' +
          'has exactly this trade-off at MaxAge 20 s, and it is where the ' +
          'recommended limit of seven bridges comes from. Raise the setting ' +
          'before building anything wider.',
        'In round mode a port goes straight to its role, because a round has no ' +
          'width to spend waiting. Switch the Run panel to Timers and it does ' +
          'not — see below.',
      ],
    },
    {
      heading: 'Timer mode: the fifty seconds',
      items: [
        \`Switch Rounds to Timers and the real 802.1D clock appears: a hello \` +
          \`every \${STP.helloSeconds} seconds, a forward delay of \` +
          \`\${STP.forwardDelaySeconds}, a max age of \${STP.maxAgeSeconds}. These \` +
          \`are the actual defaults rather than compressed ones, because the \` +
          \`whole point is that convergence takes the fifty seconds it really \` +
          \`takes. Use the speed slider to watch it in five.\`,
        \`A port given a role does not start forwarding. It spends \` +
          \`\${STP.forwardDelaySeconds}s Listening — hearing BPDUs, forwarding \` +
          \`nothing — then \${STP.forwardDelaySeconds}s Learning, building its MAC \` +
          \`table and still forwarding nothing, and only then Forwarding. Thirty \` +
          \`seconds in which the cable is plugged in, agreed on, and useless. \` +
          \`Those links are olive in the scene, and the Ports tab shows both bars \` +
          \`draining in series.\`,
        'Losing a role is instant, and the asymmetry is the entire safety ' +
          'argument: two ports both waiting to come up cannot form a loop, and ' +
          'two both waiting to go down could. So blocking happens now and ' +
          'forwarding happens in thirty seconds.',
        \`Load "Ring with unequal costs", run to convergence, then break a \` +
          \`forwarding link. Nothing happens for up to \${STP.maxAgeSeconds}s while \` +
          \`the stored BPDU ages out, then the blocked port is given a role and \` +
          \`takes another \${2 * STP.forwardDelaySeconds}s to become usable. That \` +
          \`total — up to \${STP.maxAgeSeconds + 2 * STP.forwardDelaySeconds} \` +
          \`seconds of a network with a hole in it — is why RSTP exists.\`,
        'RSTP (802.1w) replaces the wait with a proposal/agreement handshake ' +
          'between neighbours: a port that can prove its neighbour agrees goes ' +
          'straight to Forwarding, and failover drops to well under a second. ' +
          'PVST+ and MSTP then added one tree per VLAN, or per group of them. ' +
          'Nothing here models those; what is modelled is the problem they solve.',
        'Take the root down in timer mode and watch the Ports tab of a survivor: ' +
          'the BPDU age column climbs, because a stored vector gets older both ' +
          'as it is quoted from hop to hop and as it sits there. That is what ' +
          'stops a dead root being believed in for ever — the same argument as ' +
          'the round-mode max age, in seconds instead of rounds.',
      ],
    },
  ],

  createState(topology, options) {
    const state = createState();
    recomputeAll(state, topology, options);
    return state;
  },

  /**
   * Topology edits: forget what has become unhearable, then re-derive.
   *
   * Nothing needs to be re-elected by hand. A bridge that loses its root port
   * simply finds a different winner — or none, and crowns itself — the next
   * time the vectors are compared, which is now.
   */
  onTopologyChange(state, topology, options, event = {}, clock = null) {
    if (state.timers && clock) {
      return onTimerTopologyChange(state, topology, options, event, clock);
    }

    switch (event.type) {
      case 'removeRouter':
        forgetRouter(state, String(event.id));
        break;

      case 'removeLink':
        receivedBy(state, String(event.a)).delete(String(event.b));
        receivedBy(state, String(event.b)).delete(String(event.a));
        break;

      case 'setRouterActive':
        // Invariant 12: a bridge that is down forgets what it heard and is
        // forgotten, so it cannot come back up still believing in an election
        // that has since been re-run without it.
        if (!event.active) forgetRouter(state, String(event.id));
        break;

      default:
        break;
    }
    return recomputeAll(state, topology, options);
  },

  /**
   * Register the hello timers. Declaring this method is what tells the app the
   * protocol can be run on the clock at all.
   *
   * Every port starts in Blocking, which is 802.1D's own initial condition and
   * the pessimistic one: a bridge that has just been plugged in must not forward
   * anything until it has heard enough to know it is allowed to. Nothing is
   * transmitted here — the first hello is one hello away, exactly as it is on a
   * network that has just been switched on.
   */
  startTimers(state, topology, options, clock) {
    state.timers = createTimerState(topology, options);
    recomputeAll(state, topology, options, {
      ageOf: agedNow(clock),
      compareAge: false,
    });
    syncHellos(state, clock);
    // Ports are registered without moving anything: \`advancePort\` schedules the
    // climb out of Blocking, and every port genuinely does start there.
    syncPorts(state, clock);
    clock.log('bridges powered on — every port starts in Blocking');
  },

  /**
   * The tree is settled when no port is still on its way somewhere.
   *
   * The clock can already see the forward-delay events; this adds the half only
   * the protocol knows, and it is what stops "run to convergence" reporting a
   * finish fifteen seconds into a thirty-second climb.
   */
  isSettled(state) {
    return !state.timers || portsSettled(state);
  },

  /** Nothing to add in round mode; on the clock, a port state and two timers. */
  inspect(state, topology, options, routerId, clock) {
    return timerInspect(state, topology, options, routerId, clock);
  },

  /** One synchronous round: everyone speaks, then everyone listens, then everyone thinks. */
  round(state, topology, options) {
    // ---- Phase 1: build every message before applying any of them ----
    const messages = [];
    topology.routerIds.forEach((routerId) => {
      if (!topology.isActive(routerId)) return;
      const bpdu = state.best.get(routerId);
      if (!bpdu) return;
      topology.neighborsOf(routerId).forEach((neighborId) => {
        if (!topology.isActive(neighborId)) return;
        // A copy per message: phase 2 replaces \`best\`, and a message has to keep
        // saying what was true when it was sent (invariant 1).
        messages.push({ from: routerId, to: neighborId, kind: 'bpdu', payload: { ...bpdu } });
      });
    });

    // ---- Phase 2: store, age, recompute ----
    messages.forEach(({ from, to, payload }) => {
      // Sent, but too stale to act on. Real bridges transmit these too; it is
      // the receiver that refuses them, and that asymmetry is what bounds how
      // far out-of-date news can travel.
      if (payload.age >= options.maxAgeRounds) return;
      receivedBy(state, to).set(from, { bpdu: payload, age: payload.age });
    });
    ageStored(state, options);

    return { messages, changed: recomputeAll(state, topology, options) };
  },

  /**
   * One row per port. \`cost\` and \`nextHop\` describe the bridge rather than the
   * port — its distance from the root and the way there — which is why they
   * repeat down the column: the interesting per-row value is the role.
   */
  tables(state, topology) {
    const tables = {};
    topology.routerIds.forEach((routerId) => {
      const roles = state.roles.get(routerId);
      const best = state.best.get(routerId);
      const rootPort = state.rootPort.get(routerId) ?? null;
      const rows = {};

      topology.neighborsOf(routerId).forEach((neighborId) => {
        const role = (roles && roles.get(neighborId)) || null;
        // The State column is only declared in timer mode, so this is null in
        // round mode and the column that would have shown it is not there.
        const portState = portStateOf(state, routerId, neighborId, role);
        rows[neighborId] = role
          ? {
              role: ROLE_LABELS[role],
              state: portState ? PORT_STATES[portState].label : null,
              cost: best.rootCost,
              nextHop: rootPort,
            }
          : // A bridge that is switched off holds no election and forwards
            // nothing; saying so beats leaving the last roles on screen.
            { role: 'Disabled', state: 'Disabled', cost: null, nextHop: null };
      });

      tables[routerId] = rows;
    });
    return tables;
  },

  /* ---------------- what the UI shows ---------------- */

  metrics(state, topology) {
    const roots = rootsOf(state, topology);
    const variants = Object.values(
      state.timers ? timerLinkVariants(state, topology) : linkVariants(state, topology)
    );
    const count = (name) => variants.filter((variant) => variant === name).length;

    const rows = [
      {
        label: roots.length === 1 ? 'Root bridge' : 'Root bridges',
        value: roots.join(', ') || '—',
      },
      { label: 'Links forwarding', value: count('forwarding') },
      { label: 'Links blocked', value: count('blocked') },
    ];
    // Only worth a row when it can be non-zero: in round mode a port reaches its
    // role in the instant it is given one, and a permanent "0" would suggest the
    // transition is being modelled when it is not.
    if (state.timers) rows.push({ label: 'Links coming up', value: count('learning') });
    return rows;
  },

  /**
   * The whole visual payoff: the tree in green, everything else dark, and a
   * crown on the bridge that won — plus, on the clock, the ports that have been
   * chosen and are still thirty seconds from being usable.
   */
  decorations(state, topology) {
    const routers = {};
    rootsOf(state, topology).forEach((routerId) => {
      routers[routerId] = 'root';
    });
    return {
      links: state.timers ? timerLinkVariants(state, topology) : linkVariants(state, topology),
      routers,
    };
  },
};

/* ── The only edit ────────────────────────────────────────────────────────
 * "stp" belongs to the built-in, and two protocols cannot answer to one id
 * — a shared link naming it would mean different things to different people.
 * Rename these to whatever you like; they are ordinary properties.
 * ─────────────────────────────────────────────────────────────────────── */
spanningTree.id = 'stp-copy';
spanningTree.name = 'Spanning Tree (802.1D) — my copy';

return spanningTree;
`,
};

export default BUILTIN_SOURCES;
