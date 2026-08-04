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
 * `options.routerOptions` with every other per-router knob (the same call
 * `pathVector.js` made about LOCAL_PREF): it is configuration, not something a
 * bridge learned.
 *
 * **Message age is a field, not a wall clock.** Without it this protocol counts
 * to infinity exactly as distance vector does: kill the root and its two
 * neighbours will happily quote its vector back and forth at each other for
 * ever, each adding a link cost, because a vector naming the old root always
 * beats one naming a live bridge. 802.1D's answer is the Message Age field —
 * the root sends zero, every hop adds one, and a BPDU at MaxAge is discarded.
 * That is what terminates the count, and it is why `maxAgeRounds` is worth an
 * option rather than being a constant nobody notices.
 */

import { SIM } from '../../config';
import { compareIds } from '../helpers';

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
 * currently for. All three are *derived* from `received` every round —
 * invariant 2 — so a neighbour that falls silent stops influencing the tree
 * without anything having to be un-done.
 *
 * `Bpdu = { rootId, rootPriority, rootCost, senderId, senderPriority, age }`
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

/** Everyone forgets what `routerId` told them, and it forgets everyone. */
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
export function compareBridgeId(aId, aPriority, bId, bPriority) {
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
export function compareBpdu(a, b) {
  const byRoot = compareBridgeId(a.rootId, a.rootPriority, b.rootId, b.rootPriority);
  if (byRoot !== 0) return byRoot;
  if (a.rootCost !== b.rootCost) return a.rootCost - b.rootCost;
  return compareBridgeId(a.senderId, a.senderPriority, b.senderId, b.senderPriority);
}

/**
 * `compareAge` is false on the clock, and the distinction is worth stating.
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
      clock.log(`${routerId} timed out ${neighborId}'s BPDU (max age)`);
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
    clock.log(`${routerId}:${neighborId} → ${PORT_STATES[next].label} (${reason})`);
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
        label: `${routerId}:${neighborId} forward delay`,
      });
    }
  };

  stop();
  enter('listening', 'given a role');
  port.timer = clock.schedule(forwardDelaySeconds, step, {
    label: `${routerId}:${neighborId} forward delay`,
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
    // number, how much staleness is tolerated, is `maxAgeSeconds`.
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
    { background: true, label: `hello ${routerId}` }
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
          `${event.id} down — its neighbours keep its BPDU for up to ` +
            `${options.maxAgeSeconds}s`
        );
      } else {
        clock.log(`${event.id} up — its ports start in Blocking`);
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

const seconds = (value) => `${Math.max(0, value).toFixed(1)}s`;

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
        label: `${neighborId} ${PORT_STATES[port.state].label}`,
        value: left,
        max: options.forwardDelaySeconds,
        caption: `${seconds(left)} to ${port.state === 'listening' ? 'learning' : 'forwarding'}`,
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
            `A port given a role spends ${options.forwardDelaySeconds}s Listening and ` +
            `another ${options.forwardDelaySeconds}s Learning before it forwards anything. ` +
            `Losing a role is immediate — that asymmetry is what makes the wait safe. ` +
            `A BPDU is discarded at ${options.maxAgeSeconds}s.`,
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * The plugin
 * ------------------------------------------------------------------ */

export const spanningTree = {
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
        'The receiving port\'s cost is added before comparing, so the cheapest ' +
          'port toward the root becomes the root port — one per bridge, none on ' +
          'the root itself. The Table tab lists a bridge\'s ports rather than ' +
          'destinations, because that is genuinely all it decides.',
        'Every other port is designated if this bridge\'s own vector beats what ' +
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
          'root bridge: each bridge\'s cost to the root is exactly the cheapest ' +
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
          'root\'s news therefore has a finite lifetime, after which the ' +
          'survivors fall back to claiming the crown themselves and a real ' +
          'election happens. Watch the round counter after taking a root down: ' +
          'the delay is the max age draining away.',
        'The price is a limit on how wide a bridged network can be. A bridge ' +
          'more than max-age-minus-one hops from the root along the tree throws ' +
          'the root\'s BPDU away as too old and crowns itself, splitting the ' +
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
        `Switch Rounds to Timers and the real 802.1D clock appears: a hello ` +
          `every ${STP.helloSeconds} seconds, a forward delay of ` +
          `${STP.forwardDelaySeconds}, a max age of ${STP.maxAgeSeconds}. These ` +
          `are the actual defaults rather than compressed ones, because the ` +
          `whole point is that convergence takes the fifty seconds it really ` +
          `takes. Use the speed slider to watch it in five.`,
        `A port given a role does not start forwarding. It spends ` +
          `${STP.forwardDelaySeconds}s Listening — hearing BPDUs, forwarding ` +
          `nothing — then ${STP.forwardDelaySeconds}s Learning, building its MAC ` +
          `table and still forwarding nothing, and only then Forwarding. Thirty ` +
          `seconds in which the cable is plugged in, agreed on, and useless. ` +
          `Those links are olive in the scene, and the Ports tab shows both bars ` +
          `draining in series.`,
        'Losing a role is instant, and the asymmetry is the entire safety ' +
          'argument: two ports both waiting to come up cannot form a loop, and ' +
          'two both waiting to go down could. So blocking happens now and ' +
          'forwarding happens in thirty seconds.',
        `Load "Ring with unequal costs", run to convergence, then break a ` +
          `forwarding link. Nothing happens for up to ${STP.maxAgeSeconds}s while ` +
          `the stored BPDU ages out, then the blocked port is given a role and ` +
          `takes another ${2 * STP.forwardDelaySeconds}s to become usable. That ` +
          `total — up to ${STP.maxAgeSeconds + 2 * STP.forwardDelaySeconds} ` +
          `seconds of a network with a hole in it — is why RSTP exists.`,
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
    // Ports are registered without moving anything: `advancePort` schedules the
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
        // A copy per message: phase 2 replaces `best`, and a message has to keep
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
   * One row per port. `cost` and `nextHop` describe the bridge rather than the
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

export default spanningTree;
