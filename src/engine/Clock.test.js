/**
 * Clock.test.js — the virtual clock, on its own.
 *
 * Everything the asynchronous mode does rests on three properties: events fire
 * in time order, ties fire in scheduling order, and `advance` lands exactly on
 * its target. The first two are what make a seeded run reproducible; the third
 * is what lets the UI drive the clock from animation frames without the physics
 * drifting. They are cheap to state here and expensive to debug three layers up.
 */

import { Clock } from './Clock';
import { createRandom } from './helpers';
import { SIM } from '../config';

/** Records `label` at the time it fired, so order and timing assert together. */
const recorder = () => {
  const fired = [];
  return {
    fired,
    at: (label) => (clock) => fired.push(`${label}@${clock.now}`),
  };
};

describe('event order', () => {
  test('events fire in time order, whatever order they were scheduled in', () => {
    const clock = new Clock();
    const { fired, at } = recorder();

    clock.schedule(30, at('c'));
    clock.schedule(10, at('a'));
    clock.schedule(20, at('b'));
    clock.advance(100);

    expect(fired).toEqual(['a@10', 'b@20', 'c@30']);
  });

  test('same-time events fire in scheduling order', () => {
    const clock = new Clock();
    const { fired, at } = recorder();

    // FIFO on ties is what keeps a seeded run reproducible: without it the
    // order would come from how the heap happened to sift.
    clock.schedule(5, at('first'));
    clock.schedule(5, at('second'));
    clock.schedule(5, at('third'));
    clock.advance(5);

    expect(fired).toEqual(['first@5', 'second@5', 'third@5']);
  });

  test('scheduling from inside a handler works — this is the periodic pattern', () => {
    const clock = new Clock();
    const fired = [];

    const tick = (self) => {
      fired.push(self.now);
      if (fired.length < 4) self.schedule(10, tick, { background: true });
    };
    clock.schedule(10, tick, { background: true });
    clock.advance(100);

    expect(fired).toEqual([10, 20, 30, 40]);
  });

  test('an event scheduled for the current instant still runs this advance', () => {
    const clock = new Clock();
    const fired = [];

    clock.schedule(10, (self) => {
      fired.push('outer');
      self.schedule(0, () => fired.push('inner'));
    });
    clock.advance(10);

    expect(fired).toEqual(['outer', 'inner']);
    expect(clock.now).toBe(10);
  });
});

describe('advance', () => {
  test('runs everything due and lands exactly on the target', () => {
    const clock = new Clock();
    const { fired, at } = recorder();

    clock.schedule(1, at('a'));
    clock.schedule(2.5, at('b'));
    clock.schedule(9, at('c'));

    expect(clock.advance(5)).toBe(2);
    expect(fired).toEqual(['a@1', 'b@2.5']);
    // Exactly 5, not 2.5: the UI advances by whatever fraction of a second the
    // last frame took, and a clock that only stopped on events would drift.
    expect(clock.now).toBe(5);

    clock.advance(5);
    expect(fired).toEqual(['a@1', 'b@2.5', 'c@9']);
    expect(clock.now).toBe(10);
  });

  test('an event exactly on the boundary is included', () => {
    const clock = new Clock();
    const fired = [];
    clock.schedule(10, () => fired.push('due'));

    clock.advance(10);
    expect(fired).toEqual(['due']);
  });

  test('advancing over nothing costs nothing and still moves time', () => {
    const clock = new Clock();
    expect(clock.advance(10000)).toBe(0);
    expect(clock.now).toBe(10000);
  });

  test('a negative or zero advance never rewinds the clock', () => {
    const clock = new Clock();
    clock.advance(5);
    clock.advance(-100);
    expect(clock.now).toBe(5);
  });

  test('a runaway cascade is stopped rather than allowed to hang', () => {
    const clock = new Clock();
    let count = 0;
    const spin = (self) => {
      count += 1;
      self.schedule(0, spin);
    };
    clock.schedule(1, spin);

    clock.advance(10);
    expect(clock.overran).toBe(true);
    expect(count).toBe(SIM.timers.maxEventsPerAdvance);
    // Stopped on the last event run, not on the target: the events not reached
    // stay in the future rather than being silently skipped.
    expect(clock.now).toBe(1);
  });
});

describe('cancellation', () => {
  test('a cancelled event never runs', () => {
    const clock = new Clock();
    const fired = [];

    const doomed = clock.schedule(10, () => fired.push('doomed'));
    clock.schedule(20, () => fired.push('kept'));
    expect(clock.cancel(doomed)).toBe(true);
    // Cancelling twice is not an error, and not a second cancellation either.
    expect(clock.cancel(doomed)).toBe(false);

    clock.advance(100);
    expect(fired).toEqual(['kept']);
  });

  test('cancelled events do not count as pending', () => {
    const clock = new Clock();
    const first = clock.schedule(10, () => {});
    clock.schedule(20, () => {});

    expect(clock.pending).toBe(2);
    expect(clock.nextEventAt).toBe(10);

    clock.cancel(first);
    expect(clock.pending).toBe(1);
    expect(clock.nextEventAt).toBe(20);
  });

  test('background events are not pending work', () => {
    const clock = new Clock();
    clock.schedule(30, () => {}, { background: true });
    expect(clock.pending).toBe(1);
    // A network that is quiet still talks: RIP broadcasts every 30 seconds
    // whether or not anything has happened, and every route it holds is always
    // counting down. Convergence detection has to ignore those and count only
    // the events that mean something is going on.
    expect(clock.hasPendingWork()).toBe(false);

    clock.schedule(3, () => {});
    expect(clock.hasPendingWork()).toBe(true);
  });
});

describe('stepping to the next event', () => {
  test('jumps to the event and runs everything at that instant', () => {
    const clock = new Clock();
    const { fired, at } = recorder();

    clock.schedule(7, at('a'));
    clock.schedule(7, at('b'));
    clock.schedule(9, at('c'));

    expect(clock.advanceToNextEvent()).toBe(true);
    // Both, not just the first: two events sharing a timestamp happen at the
    // same moment, and stepping between them would show a state that exists
    // only inside the simulator.
    expect(fired).toEqual(['a@7', 'b@7']);
    expect(clock.now).toBe(7);

    clock.advanceToNextEvent();
    expect(fired).toEqual(['a@7', 'b@7', 'c@9']);
  });

  test('reports an empty queue rather than moving time', () => {
    const clock = new Clock();
    clock.advance(4);
    expect(clock.advanceToNextEvent()).toBe(false);
    expect(clock.now).toBe(4);
  });
});

describe('the wire', () => {
  test('messages are stamped with the time they were sent', () => {
    const clock = new Clock();
    clock.schedule(12, (self) => self.emit({ from: '1', to: '2', kind: 'dv' }));
    clock.advance(20);

    expect(clock.drain()).toEqual([{ from: '1', to: '2', kind: 'dv', at: 12 }]);
    // Drained, so the next advance reports only what it sent.
    expect(clock.drain()).toEqual([]);
  });

  test('the log is a ring buffer, newest last', () => {
    const clock = new Clock({ logLength: 3 });
    ['a', 'b', 'c', 'd'].forEach((text, index) => {
      clock.advance(1);
      clock.log(text);
      expect(clock.events[clock.events.length - 1]).toEqual({ at: index + 1, text });
    });

    expect(clock.events.map((entry) => entry.text)).toEqual(['b', 'c', 'd']);
    expect(clock.recentEvents(2).map((entry) => entry.text)).toEqual(['d', 'c']);
  });
});

describe('createRandom', () => {
  test('the same seed replays the same sequence', () => {
    const a = createRandom(7);
    const b = createRandom(7);
    const drawn = Array.from({ length: 20 }, () => a());

    expect(drawn.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(drawn).toEqual(drawn.map(() => b()));
  });

  test('different seeds diverge immediately', () => {
    expect(createRandom(1)()).not.toBe(createRandom(2)());
  });
});
