# Implementation Plan — Custom Protocol Editor

Let users write (or upload) their own routing-protocol plugin in the browser, validate it
against the existing plugin contract, and run it in the simulator. Code lives only in the
current tab (sessionStorage) — never on disk, never in share links.

## Why this is cheap here

The app was refactored so that *nothing outside `engine/protocols/` names a protocol*.
`Simulation` consumes any object that satisfies the plugin contract documented at the top
of [Simulation.js](src/engine/Simulation.js) (lines 15–69), and the whole UI renders from
the snapshot: options panel, table columns, packet labels, legend, help text, inspector
tabs, per-router knobs. A custom protocol therefore needs **zero UI special-casing** —
the only missing piece is a way to get a user-authored object into the registry.

Timer mode also comes free: `Simulation.supportsTimers` is just
`typeof protocol.startTimers === 'function'`, so a custom plugin that implements
`startTimers` runs on the virtual clock with no extra work.

---

## Stage 1 — Make the registry dynamic

**File: `src/engine/protocols/index.js`**

Today `PROTOCOLS` is a static array and `getProtocol(id)` searches it. Change to:

```js
const BUILTINS = [distanceVector, linkState, pathVector, spanningTree, dual];
const custom = new Map();               // id -> plugin, session-lifetime only

export const PROTOCOLS = BUILTINS;      // untouched — existing imports/tests keep working
export function registerCustomProtocol(plugin) { /* reject id collisions, then set */ }
export function unregisterCustomProtocol(id) { ... }
export function allProtocols() { return [...BUILTINS, ...custom.values()]; }
export function getProtocol(id) { /* look in custom first, then BUILTINS, then throw */ }
```

Rules:
- A custom id must not collide with a built-in id (`dvr`, `lsr`, …). Recommend the
  loader auto-prefixes nothing but the validator *rejects* collisions with a clear message.
- React can't observe a `Map`, so the **App holds the source of truth for rendering**
  (Stage 4); the registry is only what `Simulation`/`scenario.js` resolve ids against.

**File: `src/engine/compare.js`** — switch its `PROTOCOLS` import to `allProtocols()`
so custom protocols automatically appear in the comparison modal.

**File: `src/App.js` (dropdown, ~line 863)** — render from `allProtocols()` driven by a
small piece of state (`customProtocolVersion` counter or the custom list itself) so the
dropdown updates when a protocol is registered/removed.

## Stage 2 — Loader: source text → plugin object

**New file: `src/engine/protocols/customLoader.js`**

```js
export function compileProtocol(source) -> { ok, plugin?, error? }
```

- Wrap with `new Function('helpers', 'config', source)` and call it with a frozen
  helpers namespace and the `SIM` config. The template ends with `return protocol;`,
  so the source *is* the function body — no module system to fake.
- Injected `helpers`: `compareIds`, `tablesEqual`, `cloneTable`, `multipathRoute`,
  `nextHopsOf`, `formatCost` from [helpers.js](src/engine/helpers.js) — the same
  utilities the built-ins use, so user code can follow the same idioms. Injected
  `config`: the `SIM` object (read-only via `Object.freeze` of a copy).
- Syntax errors and throw-on-load errors are caught and returned as `{ ok: false,
  error }` with the message (and line number when the browser provides one).
- **No sandbox.** The code runs on the main thread with full page access, exactly like
  the browser devtools console. That is acceptable for a self-serve testing tool and
  must be stated in the editor UI ("This code runs in your browser tab. Only paste code
  you trust."). A Web-Worker sandbox was considered and rejected: the plugin contract is
  synchronous (`round()`, `tables()` called per snapshot), and making it async would
  ripple through the entire engine.
- Known limitation to document: an infinite loop inside `round()` freezes the tab.
  The smoke test's round cap catches the common case before activation, but cannot
  prevent it in general.

## Stage 3 — Validator: contract check + smoke test

**New file: `src/engine/protocols/validateProtocol.js`**

```js
export function validateProtocol(plugin) -> { errors: [], warnings: [] }
```

**Contract check** (shape, before anything runs):
- Required: `id` (non-empty string, no collision with built-ins), `name`, `summary`,
  `messageLabel`, `createState`/`round`/`tables` functions, `options` and `columns`
  arrays with the documented field shapes (`key/label/type/default` for options,
  `key/label/format` with a known format for columns).
- Optional fields type-checked when present: `onTopologyChange`, `startTimers`,
  `isSettled`, `decorations`, `metrics`, `inspect`, `help`, `legend`,
  `routerControls`, `hasRoutingTables`, `quietSeconds`.

**Smoke test** (runs the plugin for real, in a throwaway `Simulation`):
1. Build a hidden 4-router topology (a triangle plus a tail — has both a loop and a
   leaf) with the plugin already registered under a temporary id.
2. `runToConvergence(50)` — must not throw, must converge within the cap.
3. Assert the contract's semantic rules:
   - `round()` returns `{ messages, changed }`; every message has `from`/`to`/`kind`;
     `from`→`to` is an actual link (warning if not).
   - `tables()` returns an object keyed by router id; when `hasRoutingTables !== false`,
     every entry has `nextHop`/`cost`, and converged costs match ground truth
     (`groundTruth.js`) — a *warning*, not an error, since being wrong can be the
     point of a teaching protocol.
   - After convergence, one more `round()` must report `changed: false`
     (the "changed is honest" rule the convergence detector depends on).
4. Then a topology edit (remove one link), run to convergence again — exercises
   `onTopologyChange`.
5. If `startTimers` exists: rebuild in timer mode, `runToQuiet()` with a seconds cap,
   assert no throw.

Errors block activation; warnings are shown but allow it.

## Stage 4 — UI: editor modal

**New file: `src/CustomProtocolModal.js`** (reuses [Modal.js](src/Modal.js), styled like
[HelpModal.js](src/HelpModal.js) / [ComparisonModal.js](src/ComparisonModal.js))

Layout:
- **CodeMirror editor** (`@uiw/react-codemirror` + `@codemirror/lang-javascript`,
  new dependencies) with the app's dark theme.
- Toolbar: **Load template** (dropdown: "Minimal skeleton" / "Worked example"),
  **Upload .js** (hidden `<input type="file" accept=".js,.mjs,.txt">` + `FileReader`;
  upload only fills the editor — same validate/activate path as typed code),
  **Validate & Activate**, **Remove protocol** (when one is active).
- Results panel below the editor: compile error, or the validator's error/warning list,
  or "Activated — selected in the protocol dropdown."
- The trust notice from Stage 2.

**App wiring (`src/App.js`):**
- New state: `{ source, activeCustomId }`; a "Custom protocol…" button next to the
  protocol dropdown (or as the last `<option>`) opens the modal.
- Activate flow: `compileProtocol` → `validateProtocol` → `registerCustomProtocol` →
  `selectProtocol(plugin.id)` (existing function, ~line 456). Re-activating with the
  same id replaces the registration and calls `setProtocol` again so state is rebuilt.
- Remove flow: if the custom protocol is selected, switch to `DEFAULT_PROTOCOL_ID`
  first, then unregister.
- Edge cases:
  - Options memory: `optionsByProtocol` keyed by id already handles customs; clear the
    entry on remove/replace so stale option values don't leak into a changed schema.
  - Share links ([scenario.js](src/engine/scenario.js) already falls back to the
    default protocol on an unknown id, lines 216–219): when the share UI is used while
    a custom protocol is active, show a warning that the link will open with the
    default protocol — code never travels in URLs.

**Persistence (sessionStorage, this tab only):**
- Key `customProtocol.source`, written on editor change (debounced).
- On app mount: if present, restore into the editor; if it previously activated
  cleanly (flag `customProtocol.wasActive`), silently recompile + revalidate +
  re-register. On any failure, keep the source in the editor and surface the error —
  never lose the user's code.
- Explicit "Clear" wipes both keys. Nothing ever touches `localStorage` or the server.

## Stage 5 — Templates

**New file: `src/engine/protocols/customTemplates.js`** exporting two template strings:

1. **Minimal skeleton** — every required field with an inline comment quoting the
   contract line it satisfies, `round()` returning no messages, tables of
   self-routes only. Compiles and validates as-is, so the user starts from green.
2. **Worked example** — a ~80-line naive distance-vector (no split horizon, no
   timers): enough to watch packets fly and count-to-infinity happen, small enough
   to read whole. Comments point at the two hard rules: *build all messages before
   applying any* and *`changed` must never lie*.

Both receive `helpers` and `config` as in-scope names and end with `return protocol;`.

## Stage 6 — Tests

- `customLoader.test.js`: valid source compiles; syntax error and load-time throw
  produce `{ ok: false }` with a message; helpers are actually reachable from user code.
- `validateProtocol.test.js`: each required field missing → named error; id collision →
  error; a plugin whose `round()` throws / never converges / returns bad shapes →
  named smoke-test error; the naive-DV template passes with zero errors.
- `registry` tests in the existing `protocols` suite: register/lookup/unregister,
  collision rejection, `allProtocols()` ordering (built-ins first).
- One integration test: compile the worked-example template, register, run a real
  `Simulation` to convergence on the "Three in a line" shape, assert correct tables.
- Existing suites must pass untouched — `PROTOCOLS` keeps its meaning, and the
  convergence smoke test in `Simulation.test.js` keeps iterating built-ins only.

## Build order & effort

| # | Stage | Size |
|---|-------|------|
| 1 | Dynamic registry + compare.js/App dropdown switch to `allProtocols()` | S |
| 2 | Loader (`new Function` + injected helpers) | S |
| 3 | Validator (contract + smoke test) | M — the heart of the feature |
| 4 | Templates | M — mostly writing, needs care to be teach-quality |
| 5 | Editor modal + App wiring + sessionStorage | M |
| 6 | Tests | M |

1 → 2 → 3 can land with tests before any UI exists (validate via console). 4 before 5
so the modal ships with something to load. Dependencies added: `@uiw/react-codemirror`,
`@codemirror/lang-javascript` (works with react-scripts 5 / React 19).

## Explicit non-goals

- No persistence beyond the tab session; no saving to disk, no library of protocols.
- No sandboxing / capability restriction of user code (documented in-UI instead).
- No custom code in share links — links fall back to the default protocol with a warning.
- No protection against a hand-written infinite loop after activation (cap-limited
  during the smoke test only).
