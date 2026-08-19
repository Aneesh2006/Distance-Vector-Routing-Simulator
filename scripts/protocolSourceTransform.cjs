/**
 * protocolSourceTransform.cjs — a built-in protocol module, rewritten as
 * something the in-browser editor can run.
 *
 * The editor's contract is a *function body* with `helpers` and `config` in
 * scope, ending in `return protocol;`. A shipped protocol is an ES module that
 * imports those same two things and exports the object. The gap between the two
 * is three mechanical edits, and this is all of them:
 *
 *   1. the `import` lines become destructuring from the injected namespaces;
 *   2. `export` is dropped from the declarations, since there is no module;
 *   3. the id and name are reassigned at the bottom, because a protocol may not
 *      reuse a built-in's id — so an edited copy runs *alongside* the original
 *      rather than shadowing it.
 *
 * Nothing else is touched. That matters: the whole value of "open the built-in
 * in the editor" is that what opens is the real implementation, not a
 * simplified retelling of it that will quietly drift.
 *
 * ── Why this is a script rather than a runtime import ────────────────────
 *
 * The browser has no filesystem, and react-scripts offers no way to import a
 * `.js` file as text. So the transform runs at author time into a generated
 * module (`npm run build:sources`), and `builtinSources.test.js` re-runs it
 * against the real files and fails if the generated copy has fallen behind.
 * CommonJS because a plain `node scripts/…` has to be able to require it.
 */

'use strict';

/** Import specifiers this transform knows how to satisfy, and from what. */
const SOURCES = {
  '../../config': 'config',
  '../helpers': 'helpers',
};

/**
 * The one name that is the injected namespace rather than a member of it.
 * `config` *is* `SIM`, so `const SIM = config;` and every `SIM.x` in the file
 * carries on reading exactly as it did.
 */
const WHOLE_NAMESPACE = { SIM: 'config' };

const IMPORT_LINE = /^import\s*\{([^}]+)\}\s*from\s*'([^']+)';\s*$/;
const EXPORT_CONST = /^export const (\w+) = /;
const EXPORT_FUNCTION = /^export function /;
const EXPORT_DEFAULT = /^export default (\w+);\s*$/;

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

/** `import { a, b } from '…'` -> the names, tolerating `a as b` (which we reject). */
function parseNames(file, clause) {
  return clause
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      if (/\s/.test(name)) fail(file, `renamed import "${name}" is not supported.`);
      return name;
    });
}

/**
 * Rewrite one protocol module as an editor body.
 *
 * Strict on purpose: anything it does not recognise throws rather than being
 * dropped, because a silently mangled protocol would reach the user as a
 * mysterious validation failure in code they did not write.
 *
 * @param {string} source   the module, verbatim
 * @param {Object} details  `{ file, name, summary }` — `name` is only used in
 *                          the header and the renamed copy
 * @returns {{ id: string, source: string }}
 */
function transformProtocolSource(source, { file = 'protocol.js' } = {}) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');

  /** namespace -> the names taken from it, in the order they were imported. */
  const taken = { helpers: [], config: [] };
  const whole = [];
  let pluginConst = null;
  const body = [];

  lines.forEach((line) => {
    const importMatch = line.match(IMPORT_LINE);
    if (importMatch) {
      const namespace = SOURCES[importMatch[2]];
      if (!namespace) {
        fail(file, `imports "${importMatch[2]}", which the editor cannot provide.`);
      }
      parseNames(file, importMatch[1]).forEach((name) => {
        if (WHOLE_NAMESPACE[name]) {
          if (WHOLE_NAMESPACE[name] !== namespace) {
            fail(file, `"${name}" was expected to come from ${WHOLE_NAMESPACE[name]}.`);
          }
          whole.push(name);
          return;
        }
        taken[namespace].push(name);
      });
      return;
    }

    const defaultMatch = line.match(EXPORT_DEFAULT);
    if (defaultMatch) {
      pluginConst = defaultMatch[1];
      return; // replaced by the `return` we append
    }

    if (EXPORT_CONST.test(line)) {
      body.push(line.replace(EXPORT_CONST, (whole0, name) => `const ${name} = `));
      return;
    }
    if (EXPORT_FUNCTION.test(line)) {
      body.push(line.replace(EXPORT_FUNCTION, 'function '));
      return;
    }
    if (/^export\b/.test(line)) fail(file, `unrecognised export: ${line.trim()}`);

    body.push(line);
  });

  if (!pluginConst) fail(file, 'has no `export default`, so there is nothing to return.');

  const declarationOf = (name) => `const ${pluginConst} = {`;
  const start = body.findIndex((line) => line.startsWith(declarationOf(pluginConst)));
  if (start === -1) fail(file, `does not declare \`${pluginConst}\` as an object literal.`);

  const idLine = body.slice(start).find((line) => /^\s+id: '[^']+',/.test(line));
  if (!idLine) fail(file, `has no \`id\` in its \`${pluginConst}\` declaration.`);
  const id = idLine.match(/id: '([^']+)'/)[1];

  const nameLine = body.slice(start).find((line) => /^\s+name: '[^']+',/.test(line));
  const name = nameLine ? nameLine.match(/name: '([^']+)'/)[1] : id;

  const scope = [];
  whole.forEach((imported) => scope.push(`const ${imported} = ${WHOLE_NAMESPACE[imported]};`));
  Object.entries(taken).forEach(([namespace, names]) => {
    if (names.length === 0) return;
    scope.push(`const { ${names.join(', ')} } = ${namespace};`);
  });

  const header = [
    '/* ─────────────────────────────────────────────────────────────────────────',
    ` * ${name} — the shipped implementation, opened for editing.`,
    ' *',
    ` * This is src/engine/protocols/${file}, exactly as it runs in`,
    ' * the app, with three mechanical changes and nothing else:',
    ' *',
    ' *   - its import lines became the `helpers` and `config` values the editor',
    ' *     already puts in scope (just below);',
    ' *   - `export` was dropped from its declarations, since there is no module',
    ' *     system here — the source *is* a function body;',
    " *   - the id and name are reassigned at the very bottom, because a protocol",
    " *     may not reuse a built-in's id. So this copy runs alongside the",
    ' *     original rather than replacing it.',
    ' *',
    ' * Everything in between is the real thing. Change whatever you like — the',
    ' * split-horizon rule, the tie-break, the message a router sends — and press',
    ' * Validate & Activate to watch your version run on the same network.',
    ' * ───────────────────────────────────────────────────────────────────────── */',
    '',
    ...scope,
    '',
    '',
  ].join('\n');

  const footer = [
    '',
    '/* ── The only edit ────────────────────────────────────────────────────────',
    ` * "${id}" belongs to the built-in, and two protocols cannot answer to one id`,
    ' * — a shared link naming it would mean different things to different people.',
    ' * Rename these to whatever you like; they are ordinary properties.',
    ' * ─────────────────────────────────────────────────────────────────────── */',
    `${pluginConst}.id = '${id}-copy';`,
    `${pluginConst}.name = '${name} — my copy';`,
    '',
    `return ${pluginConst};`,
    '',
  ].join('\n');

  // The module's own trailing blank lines would otherwise push the footer away
  // from the code it belongs to.
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();

  return { id, name, file, source: `${header}${body.join('\n')}\n${footer}` };
}

module.exports = { transformProtocolSource };
