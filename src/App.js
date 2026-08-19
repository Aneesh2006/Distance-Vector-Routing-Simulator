/**
 * App.js — controls and state for the routing protocol simulator.
 *
 * The `Simulation` instance in `networkRef` is the single source of truth for
 * the topology and whatever the active protocol has learned. React state only
 * ever holds:
 *   - `positions`: where each router sits in 3D (a view concern, not a protocol one),
 *   - `snapshot`:  an immutable copy of the engine, refreshed after every change,
 *   - transient UI state (form fields, selection, packets in flight).
 *
 * Every mutation goes through `commit()`, so the engine and the UI can never
 * drift apart — which is what the old "rebuild the whole Network on every edit"
 * approach could not guarantee.
 *
 * Since the protocol refactor nothing in here names a protocol. Options, table
 * columns, packet labels, decorations, legend entries, help text and per-router
 * knobs all arrive in the snapshot, so a new protocol is a new plugin and no
 * change at all to this file.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { Canvas } from '@react-three/fiber';
import Network3D from './Network3D';
import HelpModal from './HelpModal';
import ComparisonModal from './ComparisonModal';
import Modal from './Modal';
import { PROTOCOLS, Simulation, compareIds } from './DvrAlgorithm';
import {
  DEFAULT_PROTOCOL_ID,
  customProtocolList,
  isBuiltinProtocolId,
  unregisterCustomProtocol,
} from './engine/protocols';
import {
  clearStoredProtocol,
  restoreCustomProtocol,
  writeWasActive,
} from './customProtocolSession';
import { decodeScenario, scenarioFromUrl, scenarioUrl } from './engine/scenario';
import { SCENE, SIM, maxLinkCostFor } from './config';
import { DEFAULT_PRESET, PRESETS, PRESET_GROUPS, autoPosition } from './presets';
import {
  ClockReadout,
  CorrectnessMeter,
  EventLog,
  RouterScore,
  Sparkline,
  StatsPanel,
} from './Scoreboard';
import {
  InspectorBlocks,
  ProtocolOptions,
  RouterControls,
  RoutingTable,
  SceneLegend,
  routerDecoration,
  toNumber,
} from './ProtocolPanel';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Lowest positive integer not already used as a router id. */
function nextFreeId(existingIds) {
  const used = new Set(existingIds);
  let candidate = 1;
  while (used.has(String(candidate))) candidate += 1;
  return String(candidate);
}

function buildWorld(preset, protocolId, optionOverrides, run) {
  const network = new Simulation(undefined, protocolId, optionOverrides, run);
  const positions = {};
  preset.routers.forEach((router) => {
    network.addRouter(router.id, { refresh: false });
    positions[router.id] = { x: router.x, y: router.y, z: router.z };
  });
  preset.links.forEach((link) => {
    network.addLink(link.source, link.destination, link.cost, { refresh: false });
  });
  network.refresh();
  return { network, positions };
}

/**
 * Rebuild a world from a shared link.
 *
 * Deliberately the same shape as `buildWorld` — routers, then links, then one
 * refresh — because a scenario is a topology plus settings and nothing else. The
 * per-router knobs are applied last, after the wiring exists, since a LOCAL_PREF
 * towards a neighbour that has not been added yet is meaningless.
 */
function buildFromScenario(scenario) {
  const network = new Simulation(undefined, scenario.protocolId, scenario.options, {
    mode: scenario.mode,
    seed: scenario.seed,
  });
  const positions = {};

  scenario.routers.forEach((router, index) => {
    network.addRouter(router.id, { refresh: false });
    positions[router.id] =
      router.x === undefined ? autoPosition(index) : { x: router.x, y: router.y, z: router.z };
  });
  scenario.links.forEach((link) => {
    network.addLink(link.source, link.destination, link.cost, { refresh: false });
  });
  Object.entries(scenario.routerOptions).forEach(([routerId, knobs]) => {
    Object.entries(knobs).forEach(([key, value]) => {
      if (value !== null && typeof value === 'object') {
        Object.entries(value).forEach(([neighborId, inner]) => {
          network.setRouterOption(routerId, key, inner, neighborId);
        });
        return;
      }
      network.setRouterOption(routerId, key, value);
    });
  });
  // Switched off last: `setRouterActive` is a topology event every plugin reacts
  // to, and it should react to the finished network rather than a partial one.
  scenario.routers.forEach((router) => {
    if (!router.isActive) network.setRouterActive(router.id, false, { refresh: false });
  });

  network.refresh();
  return { network, positions };
}

/**
 * The one lazily loaded module in the app.
 *
 * The editor brings a syntax-highlighting engine with it — about as much
 * JavaScript again as the entire rest of the app — and most people never open
 * it. Split out, it is a chunk that is fetched the first time somebody clicks
 * "Write a custom protocol…", and the initial load is exactly what it was
 * before the feature existed.
 */
const CustomProtocolModal = React.lazy(() => import('./CustomProtocolModal'));

const linkKey = (source, destination) => [source, destination].sort(compareIds).join('|');

/** Status-line tones. At module scope because the opening world sets one too. */
const info = (text) => ({ tone: 'info', text });
const warn = (text) => ({ tone: 'warning', text });
const good = (text) => ({ tone: 'success', text });

/**
 * A panel section that can be folded away.
 *
 * `<details>` rather than a state flag: the browser already knows how to do
 * this, it is keyboard-operable and correctly announced for free, and the
 * open/closed state does not need to survive in React state.
 *
 * Every section in both panels is one of these (design decision #7), because by
 * stage 9 the right-hand panel has eight of them and the left five, and a user
 * who is watching one thing should be able to put the other seven away. What
 * `defaultOpen` decides is only what is unfolded on a fresh load: the controls
 * needed to make anything happen at all, and nothing else.
 */
function CollapsibleSection({ title, defaultOpen = false, children }) {
  return (
    <details className="control-section control-section--collapsible" open={defaultOpen}>
      <summary>
        <h2>{title}</h2>
      </summary>
      {children}
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

/**
 * The world to open with: whatever a shared link describes, or the default
 * preset.
 *
 * Read once, synchronously, before the first render — a scenario that arrived in
 * the URL is not a change of state, it *is* the initial state, and loading it
 * afterwards would show the user a network they did not ask for first.
 */
function openingWorld() {
  const fallback = (status) => ({
    ...buildWorld(DEFAULT_PRESET, PROTOCOLS[0].id),
    name: DEFAULT_PRESET.name,
    optionsByProtocol: {},
    status,
  });

  const text = scenarioFromUrl(typeof window === 'undefined' ? '' : window.location.href);
  if (!text) {
    return fallback(info(`Loaded "${DEFAULT_PRESET.name}". Run a round to start the exchange.`));
  }

  const scenario = decodeScenario(text);
  if (!scenario.ok) {
    return fallback(
      warn(`${scenario.warnings.join(' ')} Loaded "${DEFAULT_PRESET.name}" instead.`)
    );
  }

  return {
    ...buildFromScenario(scenario),
    name: 'Shared scenario',
    // Remembered per protocol like any other settings, so switching away and
    // back does not quietly discard what the link asked for.
    optionsByProtocol: { [scenario.protocolId]: scenario.options },
    status:
      scenario.warnings.length > 0
        ? warn(`Loaded a shared scenario. ${scenario.warnings.join(' ')}`)
        : good('Loaded a shared scenario from the link.'),
  };
}

function App() {
  /**
   * Whatever this tab was running before the reload, brought back *before* the
   * world is built.
   *
   * Order matters twice: the dropdown has the protocol from the very first
   * render rather than popping in a moment later, and a shared link that names
   * it — one the user made in this tab — can still resolve it, instead of
   * silently falling back to the default.
   */
  const customRef = useRef(null);
  if (customRef.current === null) {
    customRef.current = restoreCustomProtocol();
  }

  const worldRef = useRef(null);
  if (worldRef.current === null) {
    worldRef.current = openingWorld();
  }

  const networkRef = useRef(worldRef.current.network);
  const packetTimerRef = useRef(null);
  const packetSequenceRef = useRef(0);
  /**
   * Option values per protocol id, so switching away and back — or loading a
   * new preset — does not silently reset the settings the user chose. The
   * schemas differ per protocol, so one shared object would not do.
   */
  const optionsByProtocolRef = useRef(worldRef.current.optionsByProtocol);
  /**
   * The custom protocol's source, in memory.
   *
   * A ref rather than state on purpose: the editor writes on every keystroke,
   * and routing that through `App` would re-render the whole scene per
   * character. `sessionStorage` is the copy that survives a reload; this one is
   * only so reopening the dialog is instant, and so a private window that
   * refuses storage still keeps the code for as long as the tab is open.
   */
  const customSourceRef = useRef(customRef.current.source);

  const [positions, setPositions] = useState(() => worldRef.current.positions);
  const [snapshot, setSnapshot] = useState(() => worldRef.current.network.getSnapshot());

  /**
   * The registry cannot be observed — it is a `Map` — so the list React renders
   * from lives here, and every registration goes through a setter that refreshes
   * it. `allProtocols()` remains the truth for everything that resolves an id.
   */
  const [customProtocols, setCustomProtocols] = useState(() => customProtocolList());
  const [customActiveId, setCustomActiveId] = useState(customRef.current.activeId);
  const [showCustomProtocol, setShowCustomProtocol] = useState(false);

  const [status, setStatus] = useState(() => {
    const opening = worldRef.current.status;
    if (!customRef.current.error) return opening;
    return warn(
      `${opening.text} The custom protocol from this tab could not be restored: ` +
        `${customRef.current.error} Its code is still in the editor.`
    );
  });

  // Router form
  const [routerX, setRouterX] = useState('0');
  const [routerY, setRouterY] = useState('0');
  const [routerZ, setRouterZ] = useState('0');
  const [autoPlace, setAutoPlace] = useState(true);

  // Link form
  const [linkSource, setLinkSource] = useState('');
  const [linkDestination, setLinkDestination] = useState('');
  const [linkCost, setLinkCost] = useState(String(SIM.defaultLinkCost));

  // Path finder
  const [pathSource, setPathSource] = useState('');
  const [pathDestination, setPathDestination] = useState('');
  const [pathResult, setPathResult] = useState(null);
  const [highlightedPath, setHighlightedPath] = useState([]);
  const [showRouteTree, setShowRouteTree] = useState(false);

  const [selectedRouter, setSelectedRouter] = useState(null);
  const [inspectorTab, setInspectorTab] = useState('table');
  const [animationSeconds, setAnimationSeconds] = useState(SIM.animation.defaultSeconds);
  const [packets, setPackets] = useState([]);

  // Timer mode. `playing` drives the only loop in the app that runs by itself;
  // `speed` is simulated seconds per real second, so the protocol's constants
  // stay the RFC's and only the watching is sped up.
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SIM.timers.defaultSpeed);
  const [seedText, setSeedText] = useState(String(SIM.timers.defaultSeed));

  const [fitSignal, setFitSignal] = useState(0);
  const [showHelp, setShowHelp] = useState(true);
  const [showConvergence, setShowConvergence] = useState(false);
  const [showComparison, setShowComparison] = useState(false);
  // Only so the comparison table can name what it ran on. The live counts
  // travel with it, so an edited preset still describes itself honestly.
  const [presetName, setPresetName] = useState(() => worldRef.current.name);

  // The only timer in the app; make sure it never outlives the component.
  useEffect(() => () => clearTimeout(packetTimerRef.current), []);

  const network = networkRef.current;
  const { routerIds, links, tables, infinityCost, correctness, stats, protocol, options } =
    snapshot;
  const timed = snapshot.mode === 'timers';
  const downRouters = new Set(
    routerIds.filter((id) => snapshot.status[id] && !snapshot.status[id].isActive)
  );
  const maxCost = maxLinkCostFor(infinityCost);
  // Something has to have happened before "converged" means anything, and what
  // counts as something differs: a round in one mode, a second in the other.
  const converged = snapshot.converged && (timed ? snapshot.clock.time > 0 : snapshot.iteration > 0);

  /** Pull a fresh immutable view out of the engine. */
  function commit(message) {
    setSnapshot(network.getSnapshot());
    if (message) setStatus(message);
  }

  /** Anything that changes the topology invalidates a displayed path. */
  function clearPath() {
    setHighlightedPath([]);
    setPathResult(null);
  }

  /**
   * Turn what the engine just sent into animated spheres.
   *
   * `spreadSeconds` is the stretch of *simulated* time the messages came from.
   * A round has no width, so everything leaves at once; a second of timer mode
   * does, and playing it back in proportion is what makes the jittered updates
   * look jittered instead of arriving in one synchronised volley — which is
   * precisely the thing the mode exists to disprove.
   */
  function spawnPackets(exchanges, spreadSeconds = 0) {
    clearTimeout(packetTimerRef.current);
    if (exchanges.length === 0 || animationSeconds <= 0) {
      setPackets([]);
      return;
    }
    const duration = animationSeconds * 1000;
    const startedAt = performance.now();
    const sequence = packetSequenceRef.current;
    packetSequenceRef.current += 1;

    const stamps = exchanges.map((exchange) => exchange.at).filter(Number.isFinite);
    const first = stamps.length > 0 ? Math.min(...stamps) : 0;
    const span = stamps.length > 0 ? Math.max(...stamps) - first : 0;
    const window =
      spreadSeconds > 0 && span > 0
        ? Math.min((span / Math.max(speed, 1)) * 1000, SIM.timers.maxSpreadMs)
        : 0;
    const offsetOf = (exchange) =>
      window === 0 || !Number.isFinite(exchange.at)
        ? 0
        : (window * (exchange.at - first)) / span;

    setPackets(
      exchanges.map((exchange, index) => ({
        key: `${sequence}-${index}`,
        from: exchange.from,
        to: exchange.to,
        // The scene colours the sphere from its kind. The caption prefers what
        // the message itself said (an LSA names the router that wrote it), then
        // the protocol's own label.
        kind: exchange.kind,
        label: exchange.label || protocol.messageLabel,
        startedAt: startedAt + offsetOf(exchange),
        duration,
      }))
    );
    packetTimerRef.current = setTimeout(() => setPackets([]), duration + window + 60);
  }

  /* ---------------- topology ---------------- */

  function addRouter() {
    // Read the live engine, not `snapshot`: React batches events, so two rapid
    // clicks would otherwise both compute the same id and the second would be
    // silently dropped.
    const existing = network.routerIds;
    const id = nextFreeId(existing);
    const placement = autoPlace
      ? autoPosition(existing.length)
      : {
          x: toNumber(routerX, 0, SIM.coordinate),
          y: toNumber(routerY, 0, SIM.coordinate),
          z: toNumber(routerZ, 0, SIM.coordinate),
        };

    network.addRouter(id);
    setPositions((previous) => ({ ...previous, [id]: placement }));
    clearPath();
    commit(info(`Router ${id} added. It starts out knowing only itself.`));
  }

  function deleteRouter(id) {
    network.removeRouter(id);
    setPositions((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    if (selectedRouter === id) setSelectedRouter(null);
    if (linkSource === id) setLinkSource('');
    if (linkDestination === id) setLinkDestination('');
    if (pathSource === id) setPathSource('');
    if (pathDestination === id) setPathDestination('');
    clearPath();
    commit(warn(`Router ${id} removed. Run rounds to let its neighbours notice.`));
  }

  function toggleRouterPower(id) {
    const goingDown = !downRouters.has(id);
    network.setRouterActive(id, !goingDown);
    clearPath();
    commit(
      goingDown
        ? warn(`Router ${id} is down. It stops advertising immediately.`)
        : good(`Router ${id} is back up.`)
    );
  }

  function addLink() {
    if (!linkSource || !linkDestination) {
      setStatus(warn('Pick both a source and a destination router.'));
      return;
    }
    if (linkSource === linkDestination) {
      setStatus(warn('A router cannot link to itself.'));
      return;
    }
    if (network.hasLink(linkSource, linkDestination)) {
      setStatus(warn(`Routers ${linkSource} and ${linkDestination} are already linked.`));
      return;
    }
    const cost = toNumber(linkCost, SIM.defaultLinkCost, {
      min: SIM.minLinkCost,
      max: maxCost,
    });
    network.addLink(linkSource, linkDestination, cost);
    clearPath();
    commit(info(`Link ${linkSource} ↔ ${linkDestination} added with cost ${cost}.`));
  }

  function updateLinkCost(source, destination, raw) {
    const cost = toNumber(raw, SIM.defaultLinkCost, { min: SIM.minLinkCost, max: maxCost });
    network.setLinkCost(source, destination, cost);
    clearPath();
    commit(info(`Link ${source} ↔ ${destination} now costs ${cost}.`));
  }

  function deleteLink(source, destination) {
    network.removeLink(source, destination);
    clearPath();
    commit(
      warn(
        `Link ${source} ↔ ${destination} failed. Both endpoints noticed at once; ` +
          'the rest of the network still has stale routes.'
      )
    );
  }

  function loadPreset(presetId) {
    const preset = PRESETS.find((item) => item.id === presetId);
    if (!preset) return;

    // The mode and the seed are settings, not part of the topology, so a new
    // preset arrives on the clock the user is already running.
    const world = buildWorld(preset, protocol.id, optionsByProtocolRef.current[protocol.id], {
      mode: snapshot.mode,
      seed: snapshot.seed,
    });
    worldRef.current = world;
    networkRef.current = world.network;

    setPlaying(false);
    setPositions(world.positions);
    setSnapshot(world.network.getSnapshot());
    setPresetName(preset.name);
    setSelectedRouter(null);
    setLinkSource('');
    setLinkDestination('');
    setPathSource('');
    setPathDestination('');
    clearPath();
    setPackets([]);
    setShowConvergence(false);
    setFitSignal((value) => value + 1);
    setStatus(info(`Loaded "${preset.name}". ${preset.summary}`));
  }

  /**
   * Swap the algorithm without touching the wiring.
   *
   * The topology, the router positions and the ground truth all survive; only
   * what the routers had learned is thrown away. That is what makes two
   * protocols comparable on identical input.
   *
   * `force` is for the one case where the id has not changed but the protocol
   * behind it has: re-activating an edited custom protocol replaces the
   * registration under the same id, and the state built by the previous version
   * has to go with it.
   */
  function selectProtocol(protocolId, { force = false } = {}) {
    if (protocolId === protocol.id && !force) return;
    setPlaying(false);
    network.setProtocol(protocolId, optionsByProtocolRef.current[protocolId]);
    setPackets([]);
    setShowConvergence(false);
    setInspectorTab('table');
    clearPath();
    commit(
      info(
        `Switched to ${network.protocol.name}. ${network.protocol.summary} ` +
          'The topology is unchanged; the round counter starts again.'
      )
    );
  }

  /* ---------------- custom protocols ---------------- */

  /**
   * A protocol the user just wrote has passed compile, contract check and smoke
   * run before it reaches here — `attemptActivation` registered it, and this is
   * only the app catching up with the registry.
   */
  function activateCustomProtocol(plugin) {
    /**
     * The editor holds one protocol, so the app holds one.
     *
     * Activating under a *new* id — loading a different template, or renaming
     * the one that was there — retires the previous registration. Leaving it
     * would strand it in the dropdown with no source behind it, nothing left to
     * edit it with, and a Remove button that now names something else; a reload
     * would then drop it silently, because only one source is ever stored.
     */
    const retired = customActiveId && customActiveId !== plugin.id ? customActiveId : null;
    if (retired) {
      unregisterCustomProtocol(retired);
      delete optionsByProtocolRef.current[retired];
    }
    // Re-activating an edited plugin can change the option *schema*, so values
    // remembered under this id belong to a protocol that no longer exists.
    delete optionsByProtocolRef.current[plugin.id];
    setCustomProtocols(customProtocolList());
    setCustomActiveId(plugin.id);
    writeWasActive(true);
    selectProtocol(plugin.id, { force: true });
    setStatus(
      good(
        `"${plugin.name}" is running. It is in the protocol dropdown and in the ` +
          'comparison table, exactly like a built-in one.' +
          (retired ? ` "${retired}" made way for it — the editor holds one at a time.` : '')
      )
    );
  }

  /**
   * Take the registration away, keeping the code.
   *
   * Switching away first is not tidiness: `setProtocol` resolves the id through
   * the registry, so unregistering while it is selected would leave the
   * simulation holding a protocol nothing could look up again.
   */
  function removeCustomProtocol() {
    const id = customActiveId;
    if (!id) return;
    if (protocol.id === id) selectProtocol(DEFAULT_PROTOCOL_ID, { force: true });
    unregisterCustomProtocol(id);
    delete optionsByProtocolRef.current[id];
    setCustomProtocols(customProtocolList());
    setCustomActiveId(null);
    writeWasActive(false);
    setStatus(info(`Custom protocol "${id}" removed. Its code is still in the editor.`));
  }

  /** The explicit wipe: registration, stored source and stored flag all go. */
  function clearCustomProtocol() {
    const id = customActiveId;
    if (id && protocol.id === id) selectProtocol(DEFAULT_PROTOCOL_ID, { force: true });
    if (id) delete optionsByProtocolRef.current[id];
    clearStoredProtocol(id);
    customSourceRef.current = '';
    setCustomProtocols(customProtocolList());
    setCustomActiveId(null);
    setStatus(info('Custom protocol cleared — the code and the registration are both gone.'));
  }

  /* ---------------- algorithm ---------------- */

  function guardRunnable() {
    if (routerIds.length === 0) {
      setStatus(warn('Add at least one router first.'));
      return false;
    }
    if (links.length === 0) {
      setStatus(warn('Add at least one link before running a round.'));
      return false;
    }
    return true;
  }

  function runIteration() {
    if (!guardRunnable()) return;

    // Only celebrate the transition into convergence, not every click after it.
    const wasConverged = converged;
    const result = network.runIteration();
    spawnPackets(result.exchanges);
    setSnapshot(network.getSnapshot());

    if (result.changed) {
      setStatus(info(`Round ${result.iteration} complete. Tables are still changing.`));
    } else if (wasConverged) {
      setStatus(info(`Round ${result.iteration} ran and changed nothing — still converged.`));
    } else {
      setShowConvergence(true);
      setStatus(good(`Converged after ${result.iteration} rounds — no table changed.`));
    }
  }

  function runToConvergence() {
    if (!guardRunnable()) return;

    const wasConverged = converged;
    const run = network.runToConvergence();
    const { rounds, converged: didConverge } = run;
    // In timer mode the run covers however long it took; the packets from its
    // final step are the ones worth showing, all at once.
    spawnPackets(network.lastExchanges);
    setSnapshot(network.getSnapshot());

    if (timed) {
      setStatus(
        didConverge
          ? good(`Quiet after ${Math.round(run.seconds)} simulated seconds.`)
          : warn(
              `Still not quiet after the ${SIM.timers.maxConvergenceSeconds}-second safety limit.`
            )
      );
      if (didConverge && !wasConverged) setShowConvergence(true);
      return;
    }

    if (rounds === 0 || (wasConverged && didConverge)) {
      setStatus(info('Already converged — nothing left to exchange.'));
    } else if (didConverge) {
      setShowConvergence(true);
      setStatus(good(`Converged after ${rounds} more round${rounds === 1 ? '' : 's'}.`));
    } else {
      setStatus(
        warn(
          `Stopped after the ${SIM.maxConvergenceRounds}-round safety limit without converging.`
        )
      );
    }
  }

  /* ---------------- the other clock ---------------- */

  /** Shared tail for every control that moves simulated time forward. */
  function stepClock(run) {
    if (!guardRunnable()) return null;
    const result = run(network);
    spawnPackets(result.exchanges, result.seconds);
    setSnapshot(network.getSnapshot());
    return result;
  }

  function stepSeconds() {
    const result = stepClock((simulation) => simulation.advance(SIM.timers.stepSeconds));
    if (result) {
      setStatus(
        info(
          `Advanced ${SIM.timers.stepSeconds}s. ${
            result.exchanges.length === 0
              ? 'Nothing was due.'
              : `${result.exchanges.length} message(s) went out.`
          }`
        )
      );
    }
  }

  function stepToNextEvent() {
    const result = stepClock((simulation) => simulation.stepToNextEvent());
    if (!result) return;
    setStatus(
      result.ran
        ? info(
            `Skipped ${Math.round(result.seconds)}s to the next event — nothing happens in ` +
              'between, so nothing has to be simulated.'
          )
        : warn('Nothing is scheduled. Every router is switched off.')
    );
  }

  /**
   * The play loop: the only thing in the app that advances by itself.
   *
   * Ten ticks a second rather than one per animation frame — each tick is a
   * full React render, and the physics does not care, because the clock is
   * advanced by however much real time actually passed rather than by a fixed
   * step.
   */
  useEffect(() => {
    if (!playing || !timed) return undefined;
    let last = performance.now();

    const id = setInterval(() => {
      const now = performance.now();
      const elapsed = Math.min((now - last) / 1000, SIM.timers.maxRealStep);
      last = now;
      stepClock((simulation) => simulation.advance(elapsed * speed));
    }, SIM.timers.tickMs);

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, timed, speed, animationSeconds]);

  // Playing a clock that no longer exists would be a timer with nothing to do.
  useEffect(() => {
    if (!timed && playing) setPlaying(false);
  }, [timed, playing]);

  function selectMode(mode) {
    if (mode === snapshot.mode) return;
    setPlaying(false);
    network.setMode(mode);
    setPackets([]);
    setShowConvergence(false);
    setInspectorTab('table');
    clearPath();
    // Deliberately says nothing about *which* timers: they are RIP's 30 / 180 / 120
    // under one protocol and 802.1D's 2 / 15 / 20 under another, and naming either
    // here would be wrong for the other. The Protocol panel lists whichever apply.
    commit(
      info(
        mode === 'timers'
          ? 'Timer mode: the lockstep is gone. Every router now runs on its own clock, ' +
              "with this protocol's real timers — press Play, or step to the next event."
          : 'Round mode: one round, every router speaks, every router listens.'
      )
    );
  }

  function applySeed(raw) {
    const seed = toNumber(raw, SIM.timers.defaultSeed, {
      min: SIM.timers.minSeed,
      max: SIM.timers.maxSeed,
    });
    setSeedText(String(seed));
    setPlaying(false);
    network.setSeed(seed);
    setPackets([]);
    setShowConvergence(false);
    clearPath();
    commit(info(`Seed ${seed}. The run starts again and will play out identically every time.`));
  }

  /**
   * The comparison runs on a copy, so it is safe at any moment — but on a
   * network with no links every row would report the same nothing, which is a
   * worse answer than the warning `guardRunnable` already gives.
   */
  function openComparison() {
    if (!guardRunnable()) return;
    setShowComparison(true);
  }

  /**
   * Put the whole scenario in the address bar, and on the clipboard if the
   * browser will allow it.
   *
   * The URL is updated either way, with `replaceState` rather than a navigation
   * so the back button still means what it did — the address bar is the reliable
   * half, since clipboard access needs a permission the user may have refused
   * and an insecure origin does not get at all.
   */
  async function shareScenario() {
    const url = scenarioUrl(network.getSnapshot(), positions, window.location.href);
    window.history.replaceState(null, '', url);

    // A link carries a protocol *id*, never code — which is the whole reason a
    // custom protocol is safe to run at all. Whoever opens this one will not
    // have the plugin, and `scenario.js` falls back to the default rather than
    // refusing the link, so say so before they wonder why it looks different.
    const custom = !isBuiltinProtocolId(protocol.id);
    const caveat = custom
      ? ' Your custom protocol is not in it — code never travels in a link — so it ' +
        'opens on the default protocol for anyone else.'
      : '';

    try {
      await navigator.clipboard.writeText(url);
      setStatus(
        (custom ? warn : good)(
          'Link copied. It carries the topology, the protocol, every setting and ' +
            `the seed — but not how far the run has got, so it always starts fresh.${caveat}`
        )
      );
    } catch (error) {
      // Refused, or no clipboard at all on this origin. The address bar is the
      // scenario now, which is the thing that actually had to happen.
      setStatus(
        (custom ? warn : info)(
          `The address bar now holds this scenario — copy it from there.${caveat}`
        )
      );
    }
  }

  function resetTables() {
    setPlaying(false);
    network.reset();
    setPackets([]);
    setShowConvergence(false);
    clearPath();
    commit(info('Tables reset. Each router knows only what it can see for itself again.'));
  }

  function updateOptions(partial) {
    network.setOptions(partial);
    optionsByProtocolRef.current[protocol.id] = {
      ...optionsByProtocolRef.current[protocol.id],
      ...partial,
    };
    setShowConvergence(false);
    clearPath();
    commit(info('Protocol settings changed. Run more rounds to see the effect.'));
  }

  function updateRouterOption(key, value, neighborId) {
    network.setRouterOption(selectedRouter, key, value, neighborId);
    setShowConvergence(false);
    clearPath();
    commit(info(`Router ${selectedRouter}: ${key} set to ${value}.`));
  }

  /* ---------------- path finder ---------------- */

  function findPath() {
    if (!pathSource || !pathDestination) {
      setStatus(warn('Pick a source and a destination for the path.'));
      return;
    }
    const walked = network.findPath(pathSource, pathDestination);
    const optimal = network.shortestPath(pathSource, pathDestination);

    setPathResult({ walked, optimal });
    setHighlightedPath(walked.status === 'ok' ? walked.path : optimal.path);

    if (walked.status !== 'ok') {
      setStatus(warn(walked.message));
    } else if (walked.cost !== optimal.cost) {
      setStatus(
        warn('The tables route this the long way round — they have not converged yet.')
      );
    } else {
      setStatus(good(`Path found: ${walked.path.join(' → ')} (cost ${walked.cost}).`));
    }
  }

  function selectRouter(id) {
    setSelectedRouter((current) => (current === id ? null : id));
  }

  /* ---------------- render ---------------- */

  const selectedTable = selectedRouter ? tables[selectedRouter] : null;
  // A down router is not scored, so its rows simply carry no class.
  const selectedCorrectness =
    (selectedRouter && correctness && correctness.entries[selectedRouter]) || {};

  // Derived from the live engine, but keyed on the snapshot so it is recomputed
  // exactly when the tables are — never per frame.
  const routeTreeEdges = useMemo(
    () =>
      showRouteTree && selectedRouter && protocol.hasRoutingTables
        ? network.routeTreeEdges(selectedRouter)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network, snapshot, selectedRouter, showRouteTree, protocol.hasRoutingTables]
  );

  const inspectorTabs = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => (selectedRouter ? network.inspect(selectedRouter) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network, snapshot, selectedRouter]
  );
  // Fall back to the table whenever the active tab has gone away — switching
  // protocol or selecting a different router can both remove one.
  const activeTab =
    inspectorTab !== 'table' && inspectorTabs.some((tab) => tab.id === inspectorTab)
      ? inspectorTab
      : 'table';
  const activeTabData = inspectorTabs.find((tab) => tab.id === activeTab);

  /**
   * Arrow-key movement within a tab strip, as a tablist is meant to behave.
   *
   * Only the selected tab is in the tab order (`tabIndex` above), so without this
   * the other tabs would be unreachable from the keyboard entirely — the trade a
   * roving tabindex makes, and this is the other half of it.
   */
  function moveTab(event, currentId) {
    const ids = ['table', ...inspectorTabs.map((tab) => tab.id)];
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    let next = null;
    if (step !== undefined) {
      next = ids[(ids.indexOf(currentId) + step + ids.length) % ids.length];
    } else if (event.key === 'Home') next = ids[0];
    else if (event.key === 'End') next = ids[ids.length - 1];
    if (next === null) return;

    event.preventDefault();
    setInspectorTab(next);
    // The newly selected tab is the one that should hold focus, and it only
    // becomes focusable once React has re-rendered with the new tabIndex.
    requestAnimationFrame(() => {
      const button = document.getElementById(`tab-${next}`);
      if (button) button.focus();
    });
  }

  const routerOptions = routerIds.map((id) => (
    <option key={id} value={id}>
      Router {id}
    </option>
  ));

  const presetGroups = PRESET_GROUPS.map((group) => ({
    group,
    presets: PRESETS.filter((preset) => preset.group === group),
  })).filter((entry) => entry.presets.length > 0);

  return (
    <div className="App">
      <HelpModal
        isOpen={showHelp}
        onClose={() => setShowHelp(false)}
        protocol={protocol}
      />

      {/* Mounted only while open, so opening it is what runs the comparison —
          the numbers can never lag a topology edited behind it. */}
      {showComparison && (
        <ComparisonModal
          onClose={() => setShowComparison(false)}
          topology={network.topology}
          links={links}
          topologyName={presetName}
        />
      )}

      {/* Mounted only while open, and fetched only when first opened. The draft
          it holds lives in sessionStorage rather than in this component, so
          neither unmounting it nor reloading the page can lose it. */}
      {showCustomProtocol && (
        <React.Suspense
          fallback={
            <Modal onClose={() => setShowCustomProtocol(false)} label="Loading the editor">
              <p>Loading the editor…</p>
            </Modal>
          }
        >
          <CustomProtocolModal
            onClose={() => setShowCustomProtocol(false)}
            initialSource={customSourceRef.current}
            activeId={customActiveId}
            onSourceChange={(text) => {
              customSourceRef.current = text;
            }}
            onActivate={activateCustomProtocol}
            onRemove={removeCustomProtocol}
            onClear={clearCustomProtocol}
          />
        </React.Suspense>
      )}

      {showConvergence && (
        <Modal
          onClose={() => setShowConvergence(false)}
          label={timed ? 'Network is quiet' : 'Network has converged'}
          className="modal-content--success"
        >
          <h2>{timed ? 'Quiet' : 'Converged'}</h2>
          <p>
            {timed
              ? `Nothing has changed for a full ${protocol.quietSeconds}-second ` +
                'stretch, and nothing is part-way through happening — the routers ' +
                'are still talking, they just have nothing new to say.'
              : 'A full round passed with nothing changing.'}{' '}
            {protocol.hasRoutingTables
              ? 'Every router now holds the best answer it can see — which is not ' +
                'always the right one; check the correctness meter.'
              : 'Every router now holds the best answer it can see.'}
          </p>
          <button type="button" onClick={() => setShowConvergence(false)}>
            OK
          </button>
        </Modal>
      )}

      <div className="app-container">
        {/* ---------------- left panel ---------------- */}
        {/* Labelled regions, so both panels are landmarks a screen reader can
            jump straight to rather than tabbing through the scene to reach. */}
        <div className="left-panel" role="region" aria-label="Topology controls">
          <CollapsibleSection title="Topology" defaultOpen>
            <div className="form-group">
              <label htmlFor="protocol">Protocol</label>
              <select
                id="protocol"
                value={protocol.id}
                onChange={(event) => selectProtocol(event.target.value)}
              >
                {PROTOCOLS.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
                {/* Grouped rather than appended: a protocol somebody wrote ten
                    minutes ago and one that ships with the app are not the same
                    kind of thing, and the dropdown should not pretend they are. */}
                {customProtocols.length > 0 && (
                  <optgroup label="Custom (this tab only)">
                    {customProtocols.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            <button
              type="button"
              className="ghost"
              onClick={() => setShowCustomProtocol(true)}
              title="Write a routing protocol and run it in this tab"
            >
              {customActiveId ? `Custom protocol: ${customActiveId}` : 'Write a custom protocol…'}
            </button>
            <div className="form-group">
              <label htmlFor="preset">Preset</label>
              <select
                id="preset"
                defaultValue={DEFAULT_PRESET.id}
                onChange={(event) => loadPreset(event.target.value)}
              >
                {presetGroups.map(({ group, presets }) => (
                  <optgroup key={group} label={group}>
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <button type="button" className="secondary" onClick={() => setFitSignal((v) => v + 1)}>
              Fit view to network
            </button>
          </CollapsibleSection>

          <CollapsibleSection title="Add Router">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={autoPlace}
                onChange={(event) => setAutoPlace(event.target.checked)}
              />
              <span>Place automatically</span>
            </label>

            {!autoPlace && (
              <>
                {[
                  ['X', routerX, setRouterX],
                  ['Y', routerY, setRouterY],
                  ['Z', routerZ, setRouterZ],
                ].map(([axis, value, setValue]) => (
                  <div className="form-group" key={axis}>
                    <label htmlFor={`axis-${axis}`}>{axis}</label>
                    <input
                      id={`axis-${axis}`}
                      type="number"
                      value={value}
                      min={SIM.coordinate.min}
                      max={SIM.coordinate.max}
                      step={SIM.coordinate.step}
                      onChange={(event) => setValue(event.target.value)}
                    />
                  </div>
                ))}
              </>
            )}

            <button type="button" onClick={addRouter}>
              Add Router
            </button>
          </CollapsibleSection>

          <CollapsibleSection title={`Routers (${routerIds.length})`} defaultOpen>
            {routerIds.length === 0 ? (
              <p className="empty-note">No routers yet.</p>
            ) : (
              <ul className="entity-list">
                {routerIds.map((id) => {
                  const decoration = routerDecoration(
                    snapshot.decorations.routers[id],
                    selectedRouter === id
                  );
                  return (
                    <li key={id} className="entity-row">
                      <button
                        type="button"
                        className={`chip ${selectedRouter === id ? 'chip--active' : ''}`}
                        style={decoration.style}
                        onClick={() => selectRouter(id)}
                        title={decoration.title || 'Inspect this router'}
                      >
                        Router {id}
                        {decoration.suffix}
                      </button>
                      <span className="entity-actions">
                        {protocol.hasRoutingTables && (
                          <RouterScore score={correctness && correctness.routers[id]} />
                        )}
                        {/* `title` is a tooltip and is not reliably announced;
                            `aria-label` is what carries the meaning of a button
                            whose visible text is one word or a symbol. Both,
                            because the tooltip is worth having for a mouse. */}
                        <button
                          type="button"
                          className={downRouters.has(id) ? 'icon icon--warn' : 'icon'}
                          onClick={() => toggleRouterPower(id)}
                          title={downRouters.has(id) ? 'Bring router up' : 'Take router down'}
                          aria-label={
                            downRouters.has(id)
                              ? `Bring router ${id} back up`
                              : `Take router ${id} down`
                          }
                        >
                          {downRouters.has(id) ? 'Up' : 'Down'}
                        </button>
                        <button
                          type="button"
                          className="icon icon--danger"
                          onClick={() => deleteRouter(id)}
                          title="Delete router"
                          aria-label={`Delete router ${id}`}
                        >
                          ✕
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Add Link">
            <div className="form-group">
              <label htmlFor="link-source">Source</label>
              <select
                id="link-source"
                value={linkSource}
                onChange={(event) => setLinkSource(event.target.value)}
              >
                <option value="">Select…</option>
                {routerOptions}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="link-destination">Destination</label>
              <select
                id="link-destination"
                value={linkDestination}
                onChange={(event) => setLinkDestination(event.target.value)}
              >
                <option value="">Select…</option>
                {routerOptions}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="link-cost">Cost</label>
              <input
                id="link-cost"
                type="number"
                value={linkCost}
                min={SIM.minLinkCost}
                max={maxCost}
                onChange={(event) => setLinkCost(event.target.value)}
              />
            </div>
            <p className="hint">
              Costs run from {SIM.minLinkCost} to {maxCost} (one below the infinity ceiling).
            </p>
            <button type="button" onClick={addLink}>
              Add Link
            </button>
          </CollapsibleSection>

          <CollapsibleSection title={`Links (${links.length})`} defaultOpen>
            {links.length === 0 ? (
              <p className="empty-note">No links yet.</p>
            ) : (
              <ul className="entity-list">
                {links.map((link) => (
                  <li key={linkKey(link.source, link.destination)} className="entity-row">
                    <span className="chip chip--static">
                      {link.source} ↔ {link.destination}
                    </span>
                    <span className="entity-actions">
                      <input
                        className="cost-input"
                        type="number"
                        value={link.cost}
                        min={SIM.minLinkCost}
                        max={maxCost}
                        title="Link cost"
                        aria-label={`Cost of the link between ${link.source} and ${link.destination}`}
                        onChange={(event) =>
                          updateLinkCost(link.source, link.destination, event.target.value)
                        }
                      />
                      <button
                        type="button"
                        className="icon icon--danger"
                        onClick={() => deleteLink(link.source, link.destination)}
                        title="Break this link"
                        aria-label={`Break the link between ${link.source} and ${link.destination}`}
                      >
                        ✕
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleSection>
        </div>

        {/* ---------------- centre ---------------- */}
        <div className="visualization-container">
          <div className="visualization">
            <Canvas camera={SCENE.camera}>
              <Network3D
                routers={positions}
                links={links}
                selectedRouter={selectedRouter}
                onRouterClick={selectRouter}
                routingTable={selectedTable}
                routingColumns={protocol.columns}
                routingRowLabel={protocol.rowLabel}
                routingCorrectness={selectedCorrectness}
                decorations={snapshot.decorations}
                routeTreeEdges={routeTreeEdges}
                packets={packets}
                highlightedPath={highlightedPath}
                downRouters={downRouters}
                infinityCost={infinityCost}
                fitSignal={fitSignal}
              />
            </Canvas>

            <div className="iteration-display">
              <div className="iteration-counter">
                {timed ? (
                  <>
                    <ClockReadout time={snapshot.clock.time} />
                    <span className="iteration-counter__aside">Round {snapshot.iteration}</span>
                  </>
                ) : (
                  <>Round {snapshot.iteration}</>
                )}
                {converged && (
                  <span className="badge badge--success">
                    {timed ? 'QUIET' : 'CONVERGED'}
                  </span>
                )}
                {protocol.hasRoutingTables && <CorrectnessMeter correctness={correctness} />}
              </div>
              {protocol.hasRoutingTables && <Sparkline values={stats.correctnessHistory} />}
              {/*
                The status line is the app's only running commentary — what the
                last click did, and whether it worked. `polite` so it is read
                after whatever the user was doing rather than interrupting it,
                and `atomic` because a half-replaced sentence is worse than a
                late one.
              */}
              <div
                className={`iteration-status iteration-status--${status.tone}`}
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {status.text}
              </div>
            </div>

            <SceneLegend entries={protocol.legend} />
          </div>
        </div>

        {/* ---------------- right panel ---------------- */}
        <div
          className="right-panel"
          role="region"
          aria-label="Protocol and inspection controls"
        >
          <CollapsibleSection title="Run" defaultOpen>
            {/* Only offered for protocols that declared timers. The others are
                not broken in timer mode — they simply have no idea what a
                second is, and a toggle that did nothing would be worse than
                one that is not there. */}
            {protocol.supportsTimers && (
              <div
                className="tab-strip tab-strip--modes"
                role="group"
                aria-label="Which clock to run on"
              >
                {[
                  ['rounds', 'Rounds'],
                  ['timers', 'Timers'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    // A group of pressed-state buttons rather than a tablist: it
                    // reuses the strip's look because it is the same gesture, but
                    // it switches what the *simulation* does rather than which
                    // view of it is shown, and calling it a tablist would promise
                    // a panel that does not exist.
                    aria-pressed={snapshot.mode === id}
                    className={`tab ${snapshot.mode === id ? 'tab--active' : ''}`}
                    onClick={() => selectMode(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {timed ? (
              <>
                <button type="button" onClick={() => setPlaying((value) => !value)}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={stepSeconds}
                  disabled={playing}
                >
                  Step {SIM.timers.stepSeconds}s
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={stepToNextEvent}
                  disabled={playing}
                >
                  Step to Next Event
                </button>
              </>
            ) : (
              <button type="button" onClick={runIteration}>
                Run Next Round
              </button>
            )}

            <button
              type="button"
              className="secondary"
              onClick={runToConvergence}
              disabled={playing}
            >
              Run to Convergence
            </button>
            <button type="button" className="ghost" onClick={resetTables}>
              Reset Tables
            </button>
            <button type="button" className="secondary" onClick={openComparison}>
              Compare Protocols
            </button>
            <button type="button" className="ghost" onClick={shareScenario}>
              Copy Shareable Link
            </button>

            {timed && (
              <>
                <div className="form-group">
                  <label htmlFor="clock-speed">Speed</label>
                  {/* A slider announces its raw value, so "10" would be read
                      without saying 10 of what. `aria-valuetext` is the units. */}
                  <input
                    id="clock-speed"
                    type="range"
                    min={SIM.timers.minSpeed}
                    max={SIM.timers.maxSpeed}
                    step={1}
                    value={speed}
                    aria-valuetext={`${speed} simulated seconds per real second`}
                    onChange={(event) => setSpeed(Number(event.target.value))}
                  />
                  <span className="animation-speed-value">{speed}×</span>
                </div>
                <div className="form-group">
                  <label htmlFor="clock-seed">Seed</label>
                  <input
                    id="clock-seed"
                    type="number"
                    value={seedText}
                    min={SIM.timers.minSeed}
                    max={SIM.timers.maxSeed}
                    onChange={(event) => setSeedText(event.target.value)}
                    onBlur={(event) => applySeed(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') applySeed(event.target.value);
                    }}
                  />
                </div>
                <p className="hint">
                  Speed is simulated seconds per real second, so only the watching is sped
                  up — the protocol's own timers stay at the values its RFC gives them, and
                  they are listed in the Protocol panel. The seed drives every jittered
                  decision, so the same number replays the same run exactly.
                </p>
              </>
            )}
          </CollapsibleSection>

          <CollapsibleSection title="Protocol" defaultOpen>
            <p className="hint">{protocol.summary}</p>
            <ProtocolOptions
              schema={protocol.options}
              values={options}
              onChange={updateOptions}
            />
          </CollapsibleSection>

          <CollapsibleSection title="Stats">
            <StatsPanel
              stats={stats}
              correctness={correctness}
              metrics={snapshot.metrics}
              mode={snapshot.mode}
              time={snapshot.clock.time}
            />
          </CollapsibleSection>

          {/* Only in timer mode: in round mode the round counter and the packet
              animation already say everything the log would. */}
          {timed && (
            <CollapsibleSection title="Event Log" defaultOpen>
              <EventLog entries={snapshot.eventLog} limit={SIM.timers.eventLogVisible} />
            </CollapsibleSection>
          )}

          <CollapsibleSection title="Animation">
            <div className="form-group">
              <label htmlFor="animation-speed">Packet time</label>
              <input
                id="animation-speed"
                type="range"
                min={SIM.animation.minSeconds}
                max={SIM.animation.maxSeconds}
                step={SIM.animation.step}
                value={animationSeconds}
                aria-valuetext={`${animationSeconds} seconds per packet`}
                onChange={(event) => setAnimationSeconds(Number(event.target.value))}
              />
              <span className="animation-speed-value">{animationSeconds}s</span>
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="Path Finder">
            <div className="form-group">
              <label htmlFor="path-source">From</label>
              <select
                id="path-source"
                value={pathSource}
                onChange={(event) => setPathSource(event.target.value)}
              >
                <option value="">Select…</option>
                {routerOptions}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="path-destination">To</label>
              <select
                id="path-destination"
                value={pathDestination}
                onChange={(event) => setPathDestination(event.target.value)}
              >
                <option value="">Select…</option>
                {routerOptions}
              </select>
            </div>
            <button
              type="button"
              onClick={findPath}
              disabled={!pathSource || !pathDestination}
            >
              Find Path
            </button>
            <button
              type="button"
              className="ghost"
              onClick={clearPath}
              disabled={highlightedPath.length === 0}
            >
              Clear Path
            </button>

            {protocol.hasRoutingTables && (
              <>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={showRouteTree}
                    onChange={(event) => setShowRouteTree(event.target.checked)}
                  />
                  <span>Show route tree</span>
                </label>
                <p className="hint">
                  Every link the selected router's table actually uses, followed to each
                  destination.
                </p>
              </>
            )}

            {pathResult && (
              <div className="path-result">
                <p>
                  <strong>Routing tables say:</strong>{' '}
                  {pathResult.walked.status === 'ok'
                    ? `${pathResult.walked.path.join(' → ')} (cost ${pathResult.walked.cost})`
                    : pathResult.walked.message}
                </p>
                <p>
                  <strong>Actual shortest:</strong>{' '}
                  {pathResult.optimal.path.length > 0
                    ? `${pathResult.optimal.path.join(' → ')} (cost ${pathResult.optimal.cost})`
                    : 'No path exists'}
                </p>
                {pathResult.walked.status === 'ok' &&
                  pathResult.walked.cost !== pathResult.optimal.cost && (
                    <p className="path-result__warning">
                      The tables have not converged yet — run more rounds.
                    </p>
                  )}
              </div>
            )}
          </CollapsibleSection>

          <CollapsibleSection
            title={selectedRouter ? `Router ${selectedRouter}` : 'Router Inspector'}
            defaultOpen
          >
            {!selectedRouter && (
              <p className="empty-note">Click a router in the scene or the list to inspect it.</p>
            )}
            {selectedRouter && !selectedTable && (
              <p className="empty-note">Router {selectedRouter} is no longer in the network.</p>
            )}
            {selectedRouter && selectedTable && (
              <>
                {inspectorTabs.length > 0 && (
                  <div className="tab-strip" role="tablist" aria-label="Router inspector views">
                    {[{ id: 'table', label: 'Table' }, ...inspectorTabs].map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        id={`tab-${tab.id}`}
                        aria-selected={activeTab === tab.id}
                        aria-controls="inspector-panel"
                        // Only the selected tab is in the tab order; the arrow
                        // keys move between them, which is what a tablist is
                        // supposed to do and what stops five tabs costing five
                        // presses to get past.
                        tabIndex={activeTab === tab.id ? 0 : -1}
                        className={`tab ${activeTab === tab.id ? 'tab--active' : ''}`}
                        onClick={() => setInspectorTab(tab.id)}
                        onKeyDown={(event) => moveTab(event, tab.id)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                )}

                <RouterControls
                  controls={protocol.routerControls}
                  routerId={selectedRouter}
                  neighbors={links
                    .filter(
                      (link) =>
                        link.source === selectedRouter || link.destination === selectedRouter
                    )
                    .map((link) =>
                      link.source === selectedRouter ? link.destination : link.source
                    )}
                  values={snapshot.routerOptions}
                  onChange={updateRouterOption}
                />

                <div
                  id="inspector-panel"
                  role="tabpanel"
                  aria-labelledby={`tab-${activeTab}`}
                >
                  {activeTab === 'table' ? (
                    <RoutingTable
                      table={selectedTable}
                      columns={protocol.columns}
                      rowLabel={protocol.rowLabel}
                      correctness={selectedCorrectness}
                      hasRoutingTables={protocol.hasRoutingTables}
                      infinityCost={infinityCost}
                    />
                  ) : (
                    <InspectorBlocks
                      blocks={activeTabData && activeTabData.blocks}
                      infinityCost={infinityCost}
                    />
                  )}
                </div>
              </>
            )}
          </CollapsibleSection>
        </div>
      </div>

      <button
        type="button"
        className="help-button"
        onClick={() => setShowHelp(true)}
        title="Help"
        aria-label="Open help"
      >
        ?
      </button>
    </div>
  );
}

export default App;
