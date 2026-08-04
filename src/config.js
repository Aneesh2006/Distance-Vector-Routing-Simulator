/**
 * config.js — the single source of truth for every tunable constant.
 *
 * Nothing in this project should contain a magic number or a literal colour.
 * If you want to retune the simulator or restyle the scene, do it here.
 */

/* ------------------------------------------------------------------ *
 * Palette
 *
 * These values are mirrored into CSS custom properties by applyTheme()
 * (called from index.js), so the DOM and the 3D scene always agree.
 * App.css declares the same variables as a no-JS fallback.
 * ------------------------------------------------------------------ */
export const COLORS = {
  // UI chrome
  primary: '#2196f3',
  primaryDark: '#1976d2',
  primaryLight: '#bbdefb',
  accent: '#ff5722',
  success: '#4caf50',
  warning: '#ff9800',
  error: '#f44336',
  textPrimary: '#333333',
  textSecondary: '#666666',
  backgroundLight: '#f9f9f9',
  backgroundWhite: '#ffffff',
  borderColor: '#e0e0e0',

  // 3D scene
  routerIdle: '#b3e5fc',
  routerHovered: '#4fc3f7',
  routerSelected: '#ffb300',
  routerDown: '#9e9e9e',
  link: '#2e7d32',
  linkHovered: '#1565c0',
  linkHighlighted: '#ff3d00',
  linkDown: '#bdbdbd',
  packet: '#1a237e',
  pathPulse: '#00aaff',

  // Per-protocol accents. Declared together so the palette stays comparable
  // rather than accumulating one near-duplicate blue per protocol; each is
  // consumed by the stage named beside it.
  lsaPacket: '#7b1fa2', // link state — the flooding wavefront
  pathPacket: '#00838f', // path vector
  bpduPacket: '#5d4037', // spanning tree
  queryPacket: '#d32f2f', // DUAL — the red wave out
  replyPacket: '#388e3c', // DUAL — the green wave back
  spfTree: '#6a1b9a', // the route-tree overlay
  linkBlocked: '#37474f', // spanning tree — a link that forwards nothing
  linkLearning: '#afb42b', // spanning tree on the clock — a port still coming up
  routerRoot: '#fbc02d', // spanning tree — the elected root bridge
  routerActive: '#e64a19', // DUAL — a router with a destination in ACTIVE
  lsdbStale: '#8d6e63', // link state — a database out of step
  areaBoundary: '#00695c', // link state — the edge of an OSPF area
  // Path vector — a route won by policy rather than by length or cost. Kept
  // well away from the blues: this marks a *deliberate* detour, and it has to
  // be told apart at a glance from the chrome, the path pulse and the SPF tree.
  policyRoute: '#c2185b',
  asBoundary: '#4527a0', // path vector — an eBGP session, the edge of an AS

  gridMajor: '#8a8a8a',
  gridMinor: '#c4c4c4',
  label: '#101010',
  labelOutline: '#ffffff',
  panelSurface: '#0d47a1',
  panelText: '#ffffff',
  panelMuted: '#90caf9',
};

/**
 * Blend a palette colour to an `rgba()` string.
 *
 * The correctness tints are the same hues as the palette, only faint, so they
 * are derived here rather than added as a second set of near-duplicate colour
 * literals that could drift out of step with COLORS.
 */
export function withAlpha(hex, alpha) {
  const value = String(hex).replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return hex;
  // eslint-disable-next-line no-bitwise
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

/**
 * How each routing-table entry is drawn once it has been classified against
 * ground truth (see `engine/groundTruth.js`).
 *
 * One map for both views: `tint` is the DOM row background alpha over white,
 * `sceneTint` the opacity of the plane behind the same row in the 3D panel,
 * which sits on a dark surface and so needs to be far more opaque to read.
 * `optimal` is deliberately untinted — a correct table should look calm.
 */
export const CORRECTNESS_STYLES = {
  optimal: { colorKey: null, label: 'Optimal', tint: 0, sceneTint: 0, bold: false },
  suboptimal: {
    colorKey: 'warning',
    label: 'Suboptimal — a cheaper path exists',
    tint: 0.2,
    sceneTint: 0.5,
    bold: false,
  },
  'stale-unreachable': {
    colorKey: 'error',
    label: 'Stale — believes unreachable, but a path exists',
    tint: 0.14,
    sceneTint: 0.4,
    bold: false,
  },
  phantom: {
    colorKey: 'error',
    label: 'Black hole — believes reachable, but no path exists',
    tint: 0.24,
    sceneTint: 0.62,
    bold: true,
  },
  looping: {
    colorKey: 'error',
    label: 'Loop — following next hops revisits a router',
    tint: 0.24,
    sceneTint: 0.62,
    bold: true,
  },
};

/**
 * How an in-flight message is drawn, keyed by the `kind` its protocol stamped
 * on it.
 *
 * One map rather than a branch per protocol in the scene: `spawnPackets` passes
 * `kind` straight through from the snapshot and `Packet` looks the style up, so
 * adding a protocol adds a row here and nothing else.
 */
export const MESSAGE_STYLES = {
  dv: { colorKey: 'packet', label: 'DV' },
  lsa: { colorKey: 'lsaPacket', label: 'LSA' },
  path: { colorKey: 'pathPacket', label: 'PATH' },
  bpdu: { colorKey: 'bpduPacket', label: 'BPDU' },
  update: { colorKey: 'packet', label: 'UPD' },
  query: { colorKey: 'queryPacket', label: 'QRY' },
  reply: { colorKey: 'replyPacket', label: 'RPY' },
};

/** Fallback for a message whose kind has no entry yet. */
export const DEFAULT_MESSAGE_STYLE = { colorKey: 'packet', label: 'MSG' };

export function messageStyle(kind) {
  return MESSAGE_STYLES[kind] || DEFAULT_MESSAGE_STYLE;
}

/**
 * Protocol "decorations": styling hints a plugin emits for links and routers.
 *
 * They only ever *tint*. Selection, failure and path highlighting still win
 * (see the precedence rules in `Network3D`), so no decoration can make an
 * existing affordance disappear — a blocked link the user has selected a path
 * through must still read as on the path.
 */
export const LINK_DECORATIONS = {
  blocked: { colorKey: 'linkBlocked', opacity: 0.3, label: 'Blocked — forwards nothing' },
  // Spanning tree's other half. The ordinary link green, on purpose: the tree a
  // bridged network settles on *is* the network, and painting it a novelty
  // colour would suggest an overlay rather than the plain truth. What marks it
  // out is that a decorated link holds still while an undecorated one pulses.
  forwarding: { colorKey: 'link', opacity: 0.95, label: 'Forwarding — on the spanning tree' },
  // Spanning tree on the clock: a port that has been given a role but is still
  // working through Listening and Learning. Thirty seconds of a link that is
  // neither blocked nor usable is the single most surprising thing about
  // 802.1D, so it gets its own colour rather than being drawn as either.
  learning: {
    colorKey: 'linkLearning',
    opacity: 0.9,
    label: 'Coming up — listening, then learning',
  },
  tree: { colorKey: 'spfTree', opacity: 0.95, label: 'On the route tree' },
  policy: { colorKey: 'policyRoute', opacity: 0.95, label: 'Carrying a route chosen by policy' },
  // Link state with areas: a link whose two ends are in different areas. No
  // router-LSA crosses it, and everything that does is a summary.
  areaBoundary: {
    colorKey: 'areaBoundary',
    opacity: 0.95,
    label: 'Area boundary — only summaries cross it',
  },
  // Path vector with two tiers: an eBGP session. The AS number is prepended
  // here and nowhere else, so this is where loop detection gets its evidence.
  asBoundary: {
    colorKey: 'asBoundary',
    opacity: 0.95,
    label: 'eBGP session — the AS path grows here',
  },
};

/**
 * Accents a protocol can flag on a *single route* by setting `route.accent`.
 *
 * Correctness already owns the row background, and the two must be legible at
 * once — a policy route is very often also suboptimal, which is the entire
 * point of policy — so an accent is drawn as a left-hand edge instead of a
 * second background wash.
 */
export const ROUTE_ACCENTS = {
  policy: {
    colorKey: 'policyRoute',
    width: 3,
    label: 'Chosen by policy (LOCAL_PREF), not by path length or cost',
  },
};

/**
 * `tint` is the alpha the same colour is drawn at behind a router's chip in the
 * Routers list — the 3D scene fills the whole cube, which a list row cannot do
 * without becoming unreadable.
 */
export const ROUTER_DECORATIONS = {
  root: { colorKey: 'routerRoot', suffix: ' ★', tint: 0.24, label: 'Root bridge' },
  active: { colorKey: 'routerActive', suffix: '', tint: 0.18, label: 'Recomputing (ACTIVE)' },
  stale: { colorKey: 'lsdbStale', suffix: '', tint: 0.2, label: 'Database out of step' },
  border: {
    colorKey: 'areaBoundary',
    suffix: ' ◆',
    tint: 0.2,
    label: 'Area border router — holds two maps and summarises between them',
  },
  reflector: {
    colorKey: 'asBoundary',
    suffix: ' ◈',
    tint: 0.2,
    label: 'Route reflector — passes iBGP routes on, which iBGP otherwise cannot',
  },
};

/** COLORS key -> CSS custom property name. */
const CSS_VARIABLES = {
  primary: '--primary',
  primaryDark: '--primary-dark',
  primaryLight: '--primary-light',
  accent: '--accent',
  success: '--success',
  warning: '--warning',
  error: '--error',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  backgroundLight: '--background-light',
  backgroundWhite: '--background-white',
  borderColor: '--border-color',
};

/** Push the palette into the document so CSS and WebGL share one definition. */
export function applyTheme(element) {
  const root = element || (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root) return;
  Object.entries(CSS_VARIABLES).forEach(([key, cssVar]) => {
    root.style.setProperty(cssVar, COLORS[key]);
  });
}

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */
export const SIM = {
  /**
   * "Infinity" for the protocol. Real distance-vector protocols use a small
   * finite ceiling (RIP uses 16) precisely so that count-to-infinity
   * terminates instead of looping forever. Any cost that reaches this value
   * is treated as unreachable.
   */
  defaultInfinityCost: 16,
  minInfinityCost: 4,
  maxInfinityCost: 99,

  // Link costs must stay strictly below infinityCost to be usable.
  defaultLinkCost: 1,
  minLinkCost: 1,

  // Safety cap for "run to convergence" so a pathological topology can never
  // hang the browser.
  maxConvergenceRounds: 200,

  /**
   * The scoreboard: how the simulation is measured against ground truth.
   *
   * `historyLength` caps the correctness sparkline. It is a ring of *rounds
   * since the last edit*, not of all time, because the interesting question is
   * "how far through this recovery are we?" — an unbounded history would
   * compress exactly the dip you want to see.
   */
  metrics: {
    historyLength: 60,
    sparkline: { width: 150, height: 26, strokeWidth: 1.6 },
  },

  /**
   * Link-state timers, expressed in rounds rather than seconds.
   *
   * The *ratios* are RFC 2328's (dead = 4 × hello, maxAge = 2 × refresh); only
   * the absolute scale is compressed so the behaviour is watchable. The 2:1
   * maxAge/refresh ratio in particular is deliberate in the RFC — a refreshed
   * LSA gets a full refresh period to propagate before the old copy expires
   * anywhere — so keep it if you retune these, or the sim will produce flaps
   * the real protocol cannot.
   */
  linkState: {
    /** Rounds of silence before a neighbour is declared dead (RouterDeadInterval). */
    deadRounds: 4,
    /** Rounds between unprompted re-originations of a router's own LSA (LSRefreshTime). */
    lsaRefreshRounds: 30,
    /** Rounds after which an LSA nobody refreshed is deleted (MaxAge). */
    lsaMaxAgeRounds: 60,
    /** Smallest gap between two re-originations by the same router (MinLSInterval). */
    minLsIntervalRounds: 1,
    /** Ignore an edge unless both endpoints advertise it (RFC 2328 §16.1). */
    requireBidirectional: true,
    /** Teaching mode: flood the entire database every round instead of only changes. */
    floodWholeDatabase: false,
    // Bounds for the timer inputs in the options panel.
    minRounds: 1,
    maxRounds: 200,

    /**
     * Areas (RFC 2328 §3, doc 02 §3's stretch goal).
     *
     * Area 0 is the backbone and is the default, so a network nobody has
     * partitioned behaves exactly as it did before areas existed. `maxArea` is
     * small on purpose: the lesson is what a boundary does, and eight of them on
     * thirty routers is already more than anyone can read.
     */
    defaultArea: 0,
    minArea: 0,
    maxArea: 8,
    /** Enforce RFC 2328 §16.2: an area border router trusts only the backbone. */
    strictBackbone: true,
  },

  /**
   * Path vector (BGP-style).
   *
   * Note what is *absent*: no timers, no infinity ceiling that matters, no
   * loop-avoidance switches. Correctness here comes from the path carried in
   * every advertisement, so the only tunables are policy and a sanity bound.
   */
  pathVector: {
    /** LOCAL_PREF applied to a neighbour nobody has set one for; higher wins. */
    defaultLocalPref: 100,
    minLocalPref: 0,
    maxLocalPref: 999,
    /** Step for the per-neighbour LOCAL_PREF input, since 1 at a time is useless. */
    localPrefStep: 10,
    /** false = BGP order (path length first). true = prefer total cost, like an IGP. */
    preferCost: false,
    /** Longest AS path accepted; beyond it a destination reads as unreachable. */
    maxPathLength: 16,
    // Bounds for that input — a cap on the cap. Real BGP has no such limit at
    // all; it exists here so the effect of squeezing it is watchable.
    minPathLength: 1,
    pathLengthCap: 64,

    /**
     * The two-tier model (doc 03 §7).
     *
     * Each router is given an AS number; routers sharing one are in the same
     * autonomous system. The AS_PATH then carries AS numbers rather than router
     * ids, loop detection runs on those, and the eBGP/iBGP distinction becomes
     * available — which is what makes the "iBGP does not re-advertise" rule, and
     * therefore route reflectors, expressible at all.
     *
     * `defaultAs` for everybody means one AS per network, at which point every
     * session is internal and the whole tier collapses to nothing — so a
     * topology nobody has divided behaves exactly as it did before.
     */
    defaultAs: 1,
    minAs: 1,
    maxAs: 64,
    /** RFC 4271 §9.2: a route learned by iBGP is not re-advertised by iBGP. */
    ibgpNoReadvertise: true,
  },

  /**
   * Spanning tree (802.1D), in rounds rather than seconds.
   *
   * `maxAgeRounds` is the one that does real work. A BPDU carries how long ago
   * the root sent it, incremented once per hop, and anything at or past this
   * ceiling is thrown away — which is what stops a dead root's vector from
   * circulating for ever between two bridges that keep repeating it to each
   * other. The price is the famous 802.1D diameter limit: a bridge more than
   * `maxAgeRounds - 1` hops from the root along the tree never keeps its BPDU,
   * so raise this before building anything wider. The real protocol has exactly
   * the same trade-off at MaxAge 20 s, which is where "seven bridges" comes
   * from.
   */
  spanningTree: {
    /** The real 802.1D default. Lower wins, and it is compared before the id. */
    defaultPriority: 32768,
    minPriority: 0,
    maxPriority: 65535,
    /** Real switches only accept multiples of 4096, so the input steps in them. */
    priorityStep: 4096,
    maxAgeRounds: 6,
    // Bounds for the timer input in the options panel.
    minRounds: 2,
    maxRounds: 100,

    /**
     * 802.1D's real timers, in seconds, for timer mode.
     *
     * These are the actual defaults rather than compressed ones, for the same
     * reason RIP's are: the entire point of putting spanning tree on a clock is
     * that a port takes two forward delays — thirty seconds — to begin
     * forwarding, and that up to a max age passes before anyone notices the
     * failure that started it. Those two numbers added together are the ~50
     * seconds that made RSTP necessary, and a compressed value would prove
     * nothing.
     */
    helloSeconds: 2,
    forwardDelaySeconds: 15,
    maxAgeSeconds: 20,
    /**
     * Seconds added to a BPDU's age at every hop (802.1D's Message Age
     * increment). With the holding time added on receipt this is what makes the
     * age of a dead root's vector climb as it is quoted around, so the copies
     * all expire within a max age of the root falling silent rather than
     * circulating for ever.
     */
    messageAgeIncrement: 1,
    /**
     * Seconds of no change before the network counts as settled. Three hellos:
     * long enough that a bridge which was about to change its mind has had the
     * chance, short enough that it is not most of the demo.
     */
    quietSeconds: 6,
  },

  /**
   * DUAL (EIGRP-style).
   *
   * Two settings, and only one of them is about correctness — which is the
   * point. `maxActiveRounds` is the Stuck-In-Active guard (real EIGRP: three
   * minutes), a safety net rather than a mechanism: a diffusing computation
   * that has not collapsed by then is declared lost rather than waited on for
   * ever. Split horizon is pure efficiency here; the feasibility condition
   * already proves loop freedom, so turning it off changes how much is said,
   * not what is believed.
   */
  dual: {
    /** Rounds a destination may stay ACTIVE before it is declared stuck. */
    maxActiveRounds: 20,
    /** EIGRP does apply split horizon; DUAL does not need it for correctness. */
    splitHorizon: true,
    // Bounds for the timer input in the options panel.
    minRounds: 1,
    maxRounds: 200,
  },

  /**
   * Asynchronous mode: the real RIP timers (RFC 2453 §3.6), in seconds.
   *
   * These are the *actual* protocol values, not compressed ones, because the
   * whole point of the mode is that convergence takes the three minutes it
   * really takes. What the UI scales is wall-clock — `defaultSpeed` simulated
   * seconds per real second — so the 180 s staircase stays 180 s of protocol
   * and becomes eighteen seconds of watching.
   *
   * Two of them are counter-intuitive enough to be worth stating outright:
   * `updateJitter` exists to stop routers that started together drifting into
   * synchronised transmission (a documented pathology — set it to 0 and this
   * simulator reproduces it exactly), and `garbageCollection` exists so a dead
   * route is advertised, loudly, as dead rather than quietly dropped.
   */
  timers: {
    /** Seconds between unprompted full-table broadcasts. */
    updateInterval: 30,
    /** ± this many seconds of jitter on each one; 0 reproduces synchronisation. */
    updateJitter: 5,
    /** Seconds without a refresh before a route is declared invalid. */
    routeTimeout: 180,
    /** Further seconds an invalid route is advertised as unreachable before deletion. */
    garbageCollection: 120,
    /** A metric change is announced after a random delay in this window. */
    triggeredUpdateMin: 1,
    triggeredUpdateMax: 5,

    /** Simulated seconds per real second when running continuously. */
    defaultSpeed: 10,
    minSpeed: 1,
    maxSpeed: 120,
    /** How far "Step" jumps, in simulated seconds. */
    stepSeconds: 1,

    /** Seeded so a given scenario always plays out identically. */
    defaultSeed: 1,
    minSeed: 0,
    maxSeed: 999999,

    /** Bounds for the timer inputs in the options panel. */
    minSeconds: 1,
    maxSeconds: 600,

    /** How many log lines the engine keeps; the panel shows the tail of this. */
    eventLogLength: 200,
    /** How many of them the panel shows. */
    eventLogVisible: 20,

    /**
     * The play loop's tick, in real milliseconds. Ten a second: fast enough to
     * look continuous, slow enough that each tick is one React render rather
     * than sixty.
     */
    tickMs: 100,
    /**
     * Longest real step a single tick may take, in seconds. A backgrounded tab
     * fires its timers late; without this the sim would leap several minutes
     * the moment the tab came back.
     */
    maxRealStep: 0.5,
    /** Longest wall-clock window packets from one step are spread over, in ms. */
    maxSpreadMs: 400,
    /**
     * Runaway guard. A zero-delay event that re-schedules itself would spin
     * forever inside one `advance()`, and a frozen tab is a worse failure than
     * a reported one.
     */
    maxEventsPerAdvance: 20000,
    /** Safety cap for "run to convergence" in timer mode, in simulated seconds. */
    maxConvergenceSeconds: 3600,
  },

  // Router placement when the user does not pick coordinates by hand.
  layout: {
    radius: 7,
    ringCapacity: 8,
    ringSpacing: 4,
    heightStep: 2.5,
  },

  // Bounds for the manual X/Y/Z coordinate fields.
  coordinate: { min: -25, max: 25, step: 1 },

  animation: {
    defaultSeconds: 1,
    minSeconds: 0.25,
    maxSeconds: 4,
    step: 0.25,
  },
};

/** Highest link cost that still counts as reachable for a given ceiling. */
export function maxLinkCostFor(infinityCost) {
  return Math.max(SIM.minLinkCost, infinityCost - 1);
}

/**
 * The one option more than one protocol shares, declared once so the three that
 * support it cannot drift into three spellings of the same switch.
 *
 * Off by default, and off means *exactly* today's behaviour: one next hop,
 * chosen by the incumbent-sticky tie-break. Turning it on installs every hop
 * that reaches the destination for the same cost, which is what a real router
 * does — it then hashes flows across them — and which is invisible until a
 * topology has two equally good answers.
 *
 * Not offered by DUAL or by RIP's timer mode, and the reason is the same in
 * both: their routes are stepped rather than derived. A DUAL successor is
 * frozen while the destination is ACTIVE and the feasibility condition is
 * argued about exactly one of them, and a RIP route carries its own timers, so
 * a *set* of hops in either place is a change to the protocol rather than to
 * how its answer is presented.
 */
export const ECMP_OPTION = {
  key: 'ecmp',
  label: 'Equal-cost multipath',
  type: 'boolean',
  default: false,
};

/* ------------------------------------------------------------------ *
 * 3D scene geometry
 * ------------------------------------------------------------------ */
export const SCENE = {
  camera: { position: [14, 12, 18], fov: 50, near: 0.1, far: 1000 },

  /**
   * "Fit view" framing. `radius / sin(fov/2)` already fits the bounding sphere
   * exactly, so padding only needs to add a little breathing room.
   */
  fit: { padding: 1.15, minDistance: 9 },

  /**
   * Directional rather than point lights: since three r155 point lights use
   * physical units and fall off with distance, so their brightness would
   * change as the topology grows. Directional light does not decay.
   */
  lights: {
    ambientIntensity: 1.1,
    keyPosition: [10, 16, 12],
    keyIntensity: 2.2,
    fillPosition: [-12, -4, -10],
    fillIntensity: 0.9,
  },

  grid: {
    // The grid resizes itself to whatever the topology needs.
    cellSize: 2,
    minExtent: 20,
    maxExtent: 200,
    padding: 8,
  },

  router: {
    size: 1,
    labelSize: 0.45,
    labelOutline: 0.03,
    labelLift: 1,
    downOpacity: 0.35,
    idleOpacity: 0.85,
  },

  link: {
    radius: 0.06,
    radialSegments: 10,
    labelSize: 0.32,
    labelOutline: 0.035,
    labelLift: 0.35,
    minLength: 1e-4,
    idleOpacity: 0.75,
    highlightOpacity: 0.95,
    pulseSpeed: 3,
    pulseDepth: 0.15,
  },

  packet: {
    radius: 0.26,
    segments: 14,
    pulseDepth: 0.3,
    pulseCycles: 4,
    labelSize: 0.26,
    labelOutline: 0.02,
  },

  pathPulse: {
    radius: 0.24,
    segments: 16,
    loopSeconds: 2.5,
    pulseDepth: 0.2,
    pulseCycles: 6,
  },

  /**
   * Floating routing-table panel attached to the selected router.
   *
   * The panel sizes itself to the active protocol's column count rather than
   * to a hard-coded three: path vector adds an AS path, DUAL adds FD, FS and
   * State, and a fixed width would either crop them or waste half the panel on
   * distance vector's two.
   */
  table: {
    columnWidth: 1.8,
    minColumns: 3,
    rowHeight: 0.34,
    headerHeight: 1.15,
    footerPadding: 0.35,
    titleSize: 0.3,
    headerSize: 0.24,
    rowSize: 0.22,
    surfaceOpacity: 0.92,
    /** Margin either side of the correctness tint behind a row. */
    rowTintInset: 0.18,
    /** Width of the accent bar a plugin can flag on a single route. */
    accentWidth: 0.09,
    /** Candidate offsets from the router; the least crowded one wins. */
    offsets: [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ],
    offsetDistance: 4.2,
  },
};
