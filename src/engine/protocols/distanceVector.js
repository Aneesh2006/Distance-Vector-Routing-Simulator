/**
 * distanceVector.js — Distance Vector Routing (Bellman-Ford), RIP-style.
 *
 * This is the original engine, moved behind the plugin interface with its
 * behaviour untouched. The pre-refactor test suite is the proof: it runs
 * unmodified against this file through the `Network` shim.
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
 * `options.infinityCost` is a small finite ceiling (RIP uses 16). Costs are
 * clamped to it and anything that reaches it counts as unreachable. That is
 * what makes count-to-infinity terminate rather than run forever.
 *
 * Loop avoidance
 * --------------
 * `splitHorizon` stops a router advertising a route back to the neighbour it
 * routes through; with `poisonedReverse` it advertises that route as infinite
 * instead of staying silent. Both are toggleable so the count-to-infinity
 * failure mode can still be demonstrated.
 */

import { ECMP_OPTION, SIM } from '../../config';
import { compareIds, multipathRoute, tablesEqual } from '../helpers';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * `vectors` is the only thing a router really remembers; `tables` is cached
 * derivation, refreshed whenever the vectors or the topology move. Caching it
 * is what lets `tables()` stay pure and cheap enough to call on every snapshot.
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

/** Everyone forgets what `routerId` told them, and it forgets everyone. */
function forgetRouter(state, routerId) {
  state.vectors.delete(routerId);
  state.vectors.forEach((held) => held.delete(routerId));
}

/* ------------------------------------------------------------------ *
 * The three protocol operations
 * ------------------------------------------------------------------ */

/**
 * The distance vector a router holding `table` would send to `neighborId`,
 * with split horizon / poisoned reverse applied.
 *
 * Takes the table rather than reaching into state because the asynchronous mode
 * (`ripTimers.js`) keeps its routes in a different shape and has to advertise
 * them by exactly the same rules. One implementation is what makes the
 * round-mode / timer-mode equivalence test mean something: if split horizon
 * behaved even slightly differently on the clock, the two modes could converge
 * to different answers and the test would be measuring the wrong thing.
 */
export function buildVector(table, options, neighborId) {
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
    // Every neighbour that reaches `dest` for exactly `bestCost`. Only read
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
 *     rules, exactly as the protocol does. `tables()` is still the derived
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
 * `topology` and `options` are kept here because a scheduled event runs long
 * after the call that scheduled it, and `Simulation.setOptions` replaces the
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
    { background: true, label: `timeout ${routerId}→${dest}` }
  );
}

/**
 * The route has gone quiet for `routeTimeout`.
 *
 * It is *not* deleted: the metric goes to infinity and it stays in the table,
 * advertised loudly as dead, for another `garbageCollection` seconds. Deleting
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
  clock.log(`${routerId} route to ${dest} invalid (${reason})`);
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
  clock.log(`${routerId} route to ${dest} deleted (garbage collection)`);
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
 * Every route through `deadNeighbor` dies now, rather than in three minutes.
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
    clock.log(`${routerId} lost its link to ${deadNeighbor} — routes through it are dead`);
  }
  return changed;
}

/* ---------------- sending ---------------- */

/** The plain `{ dest: { nextHop, cost } }` view `buildVector` expects. */
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
      `${routerId} → ${reached.join(', ')} ${triggered ? 'triggered update' : 'update'}`
    );
  }
}

/**
 * The periodic broadcast, jittered.
 *
 * The jitter is not decoration. Routers that start together and transmit on an
 * exact interval drift into lockstep and then collide, permanently — a real,
 * documented pathology. Set `updateJitter` to 0 and this simulator reproduces
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
    { background: true, label: `update ${routerId}` }
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
          expireRoute(state, clock, routerId, dest, `poisoned by ${fromId}`);
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
 * told nothing, which is the point: they will notice in `routeTimeout` seconds
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
    `${routerId} down — its neighbours will not notice for ` +
      `${state.timers.options.routeTimeout}s`
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
        clock.log(`${event.id} up`);
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
const seconds = (value) => `${Math.max(0, value).toFixed(1)}s`;

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
        label: `${dest}${collecting ? ' (dying)' : ''}`,
        value: left,
        max: total,
        caption: `${seconds(left)} to ${collecting ? 'deletion' : 'timeout'}`,
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
              value: trigger ? `in ${seconds(trigger.at - clock.now)}` : 'none pending',
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

export const distanceVector = {
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
    // world where every router speaks once per round. `modes` is honoured by
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
    // `hops` rather than `id`: identical for a route with one next hop, and a
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
        `Turn off split horizon, load "Three in a line", converge, then delete ` +
          `link 2 ↔ 3. Costs climb one hop at a time until they hit the infinity ` +
          `ceiling (default ${SIM.defaultInfinityCost}, as in RIP) — that is ` +
          `count-to-infinity, and the finite ceiling is what stops it.`,
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
        `Switch Rounds to Timers in the Run panel and the lockstep goes away. Every ` +
          `router broadcasts its whole table every ${SIM.timers.updateInterval} seconds, ` +
          `offset by up to ±${SIM.timers.updateJitter} so they do not all speak at once, ` +
          `and announces a metric change after a random ` +
          `${SIM.timers.triggeredUpdateMin}–${SIM.timers.triggeredUpdateMax} second wait.`,
        `Every route it learns has ${SIM.timers.routeTimeout} seconds to live, reset by ` +
          `each update that mentions it. When it runs out the metric goes to infinity and ` +
          `the route is advertised, loudly, as dead for another ` +
          `${SIM.timers.garbageCollection} seconds before it is deleted. Watch that in the ` +
          `Timers tab of the router inspector — the bar is the timer.`,
        `The staircase: take a router down (not delete it — down) and nothing happens for ` +
          `three minutes. Nobody told its neighbours anything, because nothing did; they ` +
          `each find out when their own timer runs out. That is the honest picture of RIP ` +
          `that the round loop hides.`,
        'Pulling a cable is different, and worth doing next to it: delete a link and both ' +
          'endpoints know at once, because an interface going down is something a router ' +
          'can see for itself.',
        `Set update jitter to 0, reset, and play: routers that started together lock into ` +
          `transmitting in the same instant, for ever. That pathology is the entire reason ` +
          `the random offset is in the RFC.`,
        'Turn triggered updates off and break a link: recovery goes from seconds to the ' +
          'best part of a minute, because everyone now waits for their next scheduled ' +
          'broadcast to hear about it.',
        'Load "Async loop trap", turn triggered updates off and break 1 ↔ 7. The tables ' +
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
      { label: 'Routes dying', value: `${dying} (${options.garbageCollection}s to go)` },
      { label: 'Updates pending', value: state.timers.triggered.size },
    ];
  },
};

export default distanceVector;
