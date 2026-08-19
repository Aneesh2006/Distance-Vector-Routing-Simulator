/**
 * generateBuiltinSources.cjs — write the built-in protocols out as editor text.
 *
 *     npm run build:sources
 *
 * Reads the protocol list from `protocols/index.js` (so a sixth protocol needs
 * no change here), runs each module through the transform, and writes one
 * generated module the browser can import.
 *
 * The generated file is committed. `builtinSources.test.js` re-runs this exact
 * transform against the real sources and fails if the two have diverged, so a
 * protocol edited without regenerating is a red test rather than a stale editor.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { transformProtocolSource } = require('./protocolSourceTransform.cjs');

const PROTOCOLS_DIR = path.join(__dirname, '..', 'src', 'engine', 'protocols');
const OUTPUT = path.join(PROTOCOLS_DIR, 'builtinSources.generated.js');

/** The protocol modules `index.js` imports, in the order it imports them. */
function protocolFiles() {
  const index = fs.readFileSync(path.join(PROTOCOLS_DIR, 'index.js'), 'utf8');
  return [...index.matchAll(/^import \{[^}]+\} from '\.\/(\w+)';$/gm)].map(
    (match) => `${match[1]}.js`
  );
}

/** Safe inside a template literal: backslashes, backticks and `${`. */
function escapeForTemplate(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function generate() {
  const entries = protocolFiles().map((file) => {
    const source = fs.readFileSync(path.join(PROTOCOLS_DIR, file), 'utf8');
    return transformProtocolSource(source, { file });
  });

  const body = entries
    .map(
      (entry) => `  /** ${entry.name} — from ${entry.file}. */\n` +
        `  '${entry.id}': \`${escapeForTemplate(entry.source)}\`,`
    )
    .join('\n\n');

  const file = `/**
 * builtinSources.generated.js — GENERATED FILE, DO NOT EDIT.
 *
 * Every shipped protocol, rewritten as something the custom-protocol editor can
 * run: imports turned into the injected \`helpers\` and \`config\`, exports
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
${body}
};

export default BUILTIN_SOURCES;
`;

  fs.writeFileSync(OUTPUT, file, 'utf8');
  return entries;
}

if (require.main === module) {
  const entries = generate();
  const written = entries.map((entry) => `${entry.id} (${entry.source.split('\n').length} lines)`);
  process.stdout.write(
    `Wrote ${path.relative(process.cwd(), OUTPUT)}\n  ${written.join('\n  ')}\n`
  );
}

module.exports = { generate, protocolFiles, escapeForTemplate, OUTPUT, PROTOCOLS_DIR };
