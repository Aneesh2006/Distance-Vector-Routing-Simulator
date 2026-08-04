/**
 * scenario.js — a whole simulator state as one string, and back again.
 *
 * The Stage 8 seed field made a run reproducible: a topology plus a number
 * always plays out identically. This is the other half — the topology, and
 * everything else that decides what happens — so a scenario can be sent to
 * somebody rather than described to them. "Load the ring, switch to Link State,
 * put 4 and 5 in area 1, break 3–5" becomes a link.
 *
 * ── Why a hand-rolled format ─────────────────────────────────────────────
 *
 * JSON in the fragment would be simpler and about four times longer, and a URL
 * that wraps in an email is a URL nobody clicks. So the encoding is positional
 * and terse — but it is *text*, not a binary blob behind base64, because the one
 * thing worse than a long URL is one that cannot be read, diffed or fixed by
 * hand when a field is added.
 *
 * Fields are separated by `~`, records within a field by `,`, and parts within a
 * record by `_` — not by `.`, which is a decimal point: router positions carry
 * one, and a separator that also appears inside a value is not a separator.
 *
 *     v1~<protocol>~<mode>_<seed>~<routers>~<links>~<options>~<routerOptions>
 *
 *     routers        id_x_y_z[_d]         `d` marks a router that is switched off
 *     links          a_b_cost
 *     options        key_value            booleans as 1/0, numbers as themselves
 *     routerOptions  router_key_value     or router_key_neighbour_value
 *
 * ── Two rules the format follows ─────────────────────────────────────────
 *
 * **Only what differs from the defaults is written.** A protocol's own option
 * defaults are recovered by `defaultsFrom` on the way back in, so a link is
 * short when nothing has been fiddled with, and — more importantly — a link
 * written today keeps working when a default changes tomorrow *or* when a new
 * option is added, because absence means "whatever the protocol says".
 *
 * **Nothing here throws.** A truncated, hand-edited or version-skewed link
 * yields the parts it can and reports what it could not, because the alternative
 * is a blank page for a user who has no idea what the string was meant to be.
 */

import { SIM } from '../config';
import { defaultsFrom } from './Simulation';
import { compareIds } from './helpers';
import { getProtocol, DEFAULT_PROTOCOL_ID } from './protocols';

/** Bumped only if a change makes an old link unreadable rather than incomplete. */
export const SCENARIO_VERSION = 'v1';

// All three are safe in a URL fragment, and none of them is a decimal point.
const FIELD = '~';
const RECORD = ',';
const PART = '_';

/**
 * Positions survive the round trip to one decimal place.
 *
 * `autoPosition` already rounds to a tenth and the manual inputs step by one, so
 * this loses nothing anybody typed — and it keeps a seven-router topology inside
 * a link that fits on a line.
 */
const round = (value) => Math.round(Number(value) * 10) / 10;

/** Positional encoding cannot survive a separator inside a value. */
const isSafeId = (id) => !/[~,_]/.test(String(id));

/* ------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------ */

function encodeValue(value) {
  if (value === true) return '1';
  if (value === false) return '0';
  return String(value);
}

/**
 * Booleans come back as booleans and numbers as numbers, decided by the option
 * schema rather than by guessing at the text — `'1'` is a perfectly good number
 * and a perfectly good boolean, and only the schema knows which was meant.
 */
function decodeValue(text, type) {
  if (type === 'boolean') return text === '1' || text === 'true';
  const value = Number(text);
  return Number.isFinite(value) ? value : text;
}

/**
 * Only the options that differ from the protocol's own defaults.
 *
 * That is what makes a link forward-compatible: an option added next month is
 * absent from every link written today, and absent means "the default", which is
 * exactly right.
 */
function encodeOptions(protocol, options) {
  const defaults = defaultsFrom(protocol.options);
  return (protocol.options || [])
    .filter((option) => options[option.key] !== undefined)
    .filter((option) => options[option.key] !== defaults[option.key])
    .map((option) => `${option.key}${PART}${encodeValue(options[option.key])}`)
    .join(RECORD);
}

/**
 * The per-router knobs, flattened.
 *
 * A router-scoped value is `router.key.value` and a neighbour-scoped one is
 * `router.key.neighbour.value`; the arity tells them apart on the way back,
 * which is why neither an id nor a key may contain a separator.
 */
function encodeRouterOptions(routerOptions) {
  const records = [];
  Object.entries(routerOptions || {})
    .sort(([a], [b]) => compareIds(a, b))
    .forEach(([routerId, knobs]) => {
      if (!isSafeId(routerId)) return;
      Object.entries(knobs)
        .sort(([a], [b]) => compareIds(a, b))
        .forEach(([key, value]) => {
          if (value === null || value === undefined) return;
          if (typeof value === 'object') {
            Object.entries(value)
              .sort(([a], [b]) => compareIds(a, b))
              .forEach(([neighborId, inner]) => {
                if (!isSafeId(neighborId)) return;
                records.push(
                  [routerId, key, neighborId, encodeValue(inner)].join(PART)
                );
              });
            return;
          }
          records.push([routerId, key, encodeValue(value)].join(PART));
        });
    });
  return records.join(RECORD);
}

/**
 * A whole scenario as one string.
 *
 * @param {Object} snapshot   from `Simulation.getSnapshot()`
 * @param {Object} positions  `{ routerId: { x, y, z } }` — the view's, not the engine's
 */
export function encodeScenario(snapshot, positions = {}) {
  const routers = snapshot.routerIds
    .filter(isSafeId)
    .map((id) => {
      const at = positions[id] || { x: 0, y: 0, z: 0 };
      const parts = [id, round(at.x), round(at.y), round(at.z)];
      // A trailing marker rather than a boolean column, so the common case — a
      // router that is switched on — costs nothing at all.
      if (snapshot.status[id] && !snapshot.status[id].isActive) parts.push('d');
      return parts.join(PART);
    })
    .join(RECORD);

  const links = snapshot.links
    .filter((link) => isSafeId(link.source) && isSafeId(link.destination))
    .map((link) => [link.source, link.destination, link.cost].join(PART))
    .join(RECORD);

  const protocol = getProtocol(snapshot.protocol.id);
  // The seed is only ever consulted on the clock, so a round-mode link does not
  // carry one — and two links describing the same round-mode scenario are then
  // the same string.
  const run =
    snapshot.mode === 'timers' ? `timers${PART}${snapshot.seed}` : 'rounds';

  return [
    SCENARIO_VERSION,
    snapshot.protocol.id,
    run,
    routers,
    links,
    encodeOptions(protocol, snapshot.options),
    encodeRouterOptions(snapshot.routerOptions),
  ].join(FIELD);
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

const split = (text, separator) => (text ? text.split(separator).filter(Boolean) : []);

/**
 * Parse a scenario string into everything `App` needs to rebuild itself.
 *
 * Never throws, and never returns a half-built world: either the string yields a
 * usable scenario or `ok` is false and the caller carries on with the preset it
 * already had. `warnings` collects what was dropped, so a link mangled by an
 * email client says so instead of silently arriving as a different network.
 *
 * @returns {{ ok, protocolId, mode, seed, routers, links, options, routerOptions,
 *            warnings }}
 */
export function decodeScenario(text) {
  const warnings = [];
  const fail = (message) => ({ ok: false, warnings: [...warnings, message] });

  const raw = String(text || '').trim();
  if (raw === '') return fail('Nothing to load.');

  const fields = raw.split(FIELD);
  if (fields[0] !== SCENARIO_VERSION) {
    return fail(
      `This link is in format "${fields[0]}", and this build reads ` +
        `"${SCENARIO_VERSION}".`
    );
  }
  const [, protocolText, runText, routerText, linkText, optionText, routerOptionText] =
    fields;

  let protocol;
  try {
    protocol = getProtocol(protocolText);
  } catch (error) {
    warnings.push(`Unknown protocol "${protocolText}" — using the default.`);
    protocol = getProtocol(DEFAULT_PROTOCOL_ID);
  }

  const runParts = split(runText, PART);
  const mode = runParts[0] === 'timers' ? 'timers' : 'rounds';
  const seedValue = Number(runParts[1]);
  const seed = Number.isFinite(seedValue) ? seedValue : SIM.timers.defaultSeed;

  const routers = [];
  const seen = new Set();
  split(routerText, RECORD).forEach((record) => {
    const [id, x, y, z, flag] = record.split(PART);
    if (!id || seen.has(id)) {
      warnings.push(`Skipped a router record: "${record}".`);
      return;
    }
    seen.add(id);
    const at = [x, y, z].map(Number);
    if (at.some((value) => !Number.isFinite(value))) {
      warnings.push(`Router ${id} had no usable position; placing it automatically.`);
      routers.push({ id, isActive: flag !== 'd' });
      return;
    }
    routers.push({ id, x: at[0], y: at[1], z: at[2], isActive: flag !== 'd' });
  });

  // A string that carried router records none of which parsed is broken. One
  // that carried no router field at all — truncated before it, or genuinely an
  // empty network — is not, and opening it empty beats refusing it.
  if (routers.length === 0 && routerText) {
    return fail('No routers could be read from this link.');
  }

  const links = [];
  split(linkText, RECORD).forEach((record) => {
    const [source, destination, cost] = record.split(PART);
    // A link to a router that is not in the string would be silently dropped by
    // the topology; saying so is what tells the user the link was truncated.
    if (!seen.has(source) || !seen.has(destination)) {
      warnings.push(`Skipped link "${record}": one end is missing.`);
      return;
    }
    const value = Number(cost);
    links.push({
      source,
      destination,
      cost: Number.isFinite(value) ? value : SIM.defaultLinkCost,
    });
  });

  const byKey = new Map((protocol.options || []).map((option) => [option.key, option]));
  const options = {};
  split(optionText, RECORD).forEach((record) => {
    const [key, ...rest] = record.split(PART);
    const option = byKey.get(key);
    if (!option) {
      // An option this build has never heard of — an older link, or a newer one.
      // Dropping it is right: the protocol's default is a defined answer and a
      // value nothing reads is not.
      warnings.push(`Ignored unknown setting "${key}".`);
      return;
    }
    options[key] = decodeValue(rest.join(PART), option.type);
  });

  const controls = new Map(
    (protocol.routerControls || []).map((control) => [control.key, control])
  );
  const routerOptions = {};
  split(routerOptionText, RECORD).forEach((record) => {
    const parts = record.split(PART);
    const [routerId, key] = parts;
    const control = controls.get(key);
    if (!control || parts.length < 3 || parts.length > 4) {
      warnings.push(`Ignored per-router setting "${record}".`);
      return;
    }
    const value = decodeValue(parts[parts.length - 1], control.type);
    const knobs = routerOptions[routerId] || {};
    if (parts.length === 4) {
      knobs[key] = { ...(knobs[key] || {}), [parts[2]]: value };
    } else {
      knobs[key] = value;
    }
    routerOptions[routerId] = knobs;
  });

  return {
    ok: true,
    protocolId: protocol.id,
    mode,
    seed,
    routers,
    links,
    options,
    routerOptions,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * The URL
 * ------------------------------------------------------------------ */

/**
 * The fragment, not the query string.
 *
 * A fragment is never sent to the server, so a scenario stays entirely between
 * the person who made the link and the person who opened it — and on a static
 * host it needs no routing rule to work.
 */
export function scenarioUrl(snapshot, positions, href) {
  const base = String(href || '').split('#')[0];
  return `${base}#${encodeScenario(snapshot, positions)}`;
}

/** The scenario in a URL, or null when there is not one. */
export function scenarioFromUrl(href) {
  const fragment = String(href || '').split('#')[1];
  if (!fragment) return null;
  // Some clients percent-encode the fragment, which turns `,` into `%2C`.
  // Decoding a string that was never encoded is a no-op, so this is safe either
  // way — and a malformed escape is used as it came rather than thrown on.
  let text = fragment;
  try {
    text = decodeURIComponent(fragment);
  } catch (error) {
    // A malformed escape sequence — use it as it came.
  }
  if (!text.startsWith(`${SCENARIO_VERSION}${FIELD}`)) return null;
  return text;
}
