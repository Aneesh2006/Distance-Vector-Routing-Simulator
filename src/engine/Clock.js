/**
 * Clock.js — the virtual clock the asynchronous mode runs on.
 *
 * Every protocol before this one has run in lockstep: one round, everybody
 * speaks, everybody listens. Real routers do not do that, and the numbers the
 * round loop produces are only meaningful if you already know that. This is the
 * other clock.
 *
 * Time only exists at event boundaries
 * ------------------------------------
 * `now` never moves except onto an event's timestamp or onto the target of an
 * `advance()`. So a thousand simulated seconds in which nothing happens cost
 * nothing to simulate, the UI can run at any speed without changing the physics,
 * and a test can jump three minutes forward to watch a route time out without
 * waiting three minutes.
 *
 * Ties are FIFO
 * -------------
 * Two events scheduled for the same instant fire in the order they were
 * scheduled. Without that rule the simulation would depend on heap-sift order,
 * which is an implementation detail, and the determinism the seeded PRNG buys
 * would be given straight back. `seq` is what enforces it.
 *
 * The clock is also the wire
 * --------------------------
 * In an event-driven simulation everything that happens happens *at a time*:
 * a message is sent at a time and a route dies at a time. So the outbox, the
 * event log and the "when was anything last going on?" mark all live here
 * rather than beside here, and all three are stamped from `now` by
 * construction. Nothing has to remember to timestamp itself, and nothing can
 * disagree with the clock about when it happened.
 *
 * The seeded generator belongs here for the same reason: every random decision
 * in this mode is a decision about *when* — how much to jitter an update, how
 * long to sit on a triggered one — so resetting the clock and resetting the
 * randomness are the same act, and a scenario is a topology plus a seed.
 */

import { SIM } from '../config';
import { createRandom } from './helpers';

/* ------------------------------------------------------------------ *
 * Min-heap
 *
 * A binary heap rather than a sorted array: a periodic timer re-schedules
 * itself on every firing, so pushes are as common as pops and keeping the whole
 * queue sorted would be the expensive half.
 * ------------------------------------------------------------------ */

/** Earlier time first; same time, earlier `seq` first. */
function before(a, b) {
  return a.at !== b.at ? a.at < b.at : a.seq < b.seq;
}

function siftUp(heap, start) {
  let index = start;
  while (index > 0) {
    const parent = (index - 1) >> 1; // eslint-disable-line no-bitwise
    if (!before(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function siftDown(heap, start) {
  let index = start;
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && before(heap[left], heap[smallest])) smallest = left;
    if (right < heap.length && before(heap[right], heap[smallest])) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

export class Clock {
  constructor({ seed = SIM.timers.defaultSeed, logLength = SIM.timers.eventLogLength } = {}) {
    this.now = 0;
    this.heap = [];
    this.nextSeq = 0;
    this.logLength = logLength;
    this.seed = seed;
    this.random = createRandom(seed);

    /**
     * When something last happened that was not merely the periodic timer
     * going off. Convergence in this mode is defined against it — see
     * `Simulation.isQuiet` — so it is the clock's business rather than a
     * protocol's.
     */
    this.quietSince = 0;

    /** Messages emitted since the last `drain()`, for the packet animation. */
    this.outbox = [];
    /** Ring buffer of what happened, newest last. */
    this.events = [];
    /**
     * True when an `advance()` hit the runaway-cascade guard. A zero-delay
     * event that re-schedules itself would otherwise hang the browser, and
     * failing loudly beats a frozen tab.
     */
    this.overran = false;
  }

  /* ---------------- the queue ---------------- */

  /**
   * Run `run(clock)` in `delay` simulated seconds.
   *
   * `background` marks a timer a *settled* network still has outstanding —
   * RIP's thirty-second broadcast, and the timeout ticking on every route it
   * holds. Convergence detection ignores those (doc 06's "non-periodic
   * events"), because otherwise nothing could ever be called converged: a
   * network at rest still talks, and every route it knows is always counting
   * down. A triggered update or a pending deletion is the opposite — those
   * exist only because something is going on.
   *
   * @returns {Object} the event, which the caller may `cancel()`
   */
  schedule(delay, run, { background = false, label = null } = {}) {
    const event = {
      at: this.now + Math.max(0, delay),
      seq: this.nextSeq,
      run,
      background,
      label,
      cancelled: false,
    };
    this.nextSeq += 1;
    this.heap.push(event);
    siftUp(this.heap, this.heap.length - 1);
    return event;
  }

  /**
   * Cancel a scheduled event.
   *
   * Lazily: the entry stays in the heap and is skipped when it surfaces. Real
   * removal would mean an index into a structure that moves on every push, and
   * a route's garbage-collection timer is cancelled far less often than the heap
   * is touched — so the cheap half is the one worth optimising.
   */
  cancel(event) {
    if (!event || event.cancelled) return false;
    event.cancelled = true;
    return true;
  }

  peek() {
    // Cancelled events are skipped rather than removed, so the head of the heap
    // is not necessarily a real event. Drop the dead ones so `nextEventAt` and
    // `pending` tell the truth.
    while (this.heap.length > 0 && this.heap[0].cancelled) this.pop();
    return this.heap[0] || null;
  }

  pop() {
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      siftDown(this.heap, 0);
    }
    return top;
  }

  /** When the next live event fires, or null if the queue is empty. */
  get nextEventAt() {
    const next = this.peek();
    return next ? next.at : null;
  }

  /** Live events still queued. */
  get pending() {
    this.peek();
    return this.heap.filter((event) => !event.cancelled).length;
  }

  /** Is anything still waiting to fire that a settled network would not have? */
  hasPendingWork() {
    this.peek();
    return this.heap.some((event) => !event.cancelled && !event.background);
  }

  /* ---------------- running ---------------- */

  /**
   * Run every event due within `seconds` and land exactly on the target.
   *
   * Landing exactly matters: the UI advances by whatever fraction of a second
   * the last animation frame took, and a clock that only ever stopped on event
   * boundaries would drift away from the wall clock that drives it.
   */
  advance(seconds) {
    const until = this.now + Math.max(0, seconds);
    let ran = 0;

    for (;;) {
      const next = this.peek();
      if (!next || next.at > until) break;
      if (ran >= SIM.timers.maxEventsPerAdvance) {
        // Stop on the last event actually run rather than on `until`, so the
        // events not reached stay in the future instead of being silently
        // skipped over.
        this.overran = true;
        return ran;
      }
      this.pop();
      this.now = next.at;
      next.run(this);
      ran += 1;
    }

    this.now = until;
    return ran;
  }

  /**
   * Jump to the next event and run everything scheduled for that instant.
   *
   * Everything, not just the first: two events sharing a timestamp happen at
   * the same moment, and stepping between them would show the user a state that
   * exists only inside the simulator. Returns false when the queue is empty.
   */
  advanceToNextEvent() {
    const next = this.nextEventAt;
    if (next === null) return false;
    this.advance(next - this.now);
    return true;
  }

  /* ---------------- the wire ---------------- */

  /** Record a message as sent now. `Simulation.advance` drains these. */
  emit(message) {
    this.outbox.push({ ...message, at: this.now });
    return message;
  }

  drain() {
    const sent = this.outbox;
    this.outbox = [];
    return sent;
  }

  /**
   * "Something is going on." Resets the quiet timer.
   *
   * A route changed, an edit landed, a triggered update is on its way — the
   * things that mean the network has not settled. Deliberately *not* called by
   * the periodic update timer or by a route timeout being restarted, because a
   * RIP network that has completely settled still broadcasts every thirty
   * seconds and still ages every route it holds — and would otherwise never be
   * allowed to call itself converged.
   */
  disturb() {
    this.quietSince = this.now;
    return this;
  }

  /** Simulated seconds since anything but the periodic timer happened. */
  get quietFor() {
    return this.now - this.quietSince;
  }

  /**
   * Note something worth narrating: a transmission, a route timing out, a
   * router waking up. Capped, because this runs for simulated hours and the
   * panel only ever shows the tail.
   */
  log(text) {
    this.events.push({ at: this.now, text });
    if (this.events.length > this.logLength) this.events.shift();
    return this;
  }

  /** Newest first, which is the order the panel reads in. */
  recentEvents(limit = this.logLength) {
    return this.events.slice(-limit).reverse();
  }
}

export default Clock;
