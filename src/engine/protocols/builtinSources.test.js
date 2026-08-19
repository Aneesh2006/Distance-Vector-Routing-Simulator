/**
 * builtinSources.test.js — the built-in protocols, opened in the editor.
 *
 * "Load a built-in and edit it" is only worth having if what opens is the real
 * implementation. A hand-written study edition of a thousand-line protocol
 * would be a second implementation of it, wrong within a week and wrong in a
 * way nobody would notice — so the source is extracted from the modules
 * mechanically, and this file is what keeps that claim true. Three things are
 * checked, in increasing order of how much they would hurt to get wrong:
 *
 *   1. **The extract is current.** The transform is re-run here against the
 *      real modules, so editing a protocol without regenerating is a red test
 *      rather than a stale editor.
 *   2. **It runs.** Every extract compiles, passes the contract check and
 *      survives the smoke run — the same gate a user's own code goes through.
 *   3. **It is the same protocol.** Registered and run beside the built-in on
 *      the same topology, it has to converge in the same number of rounds, send
 *      the same number of messages and produce identical tables. That is the
 *      assertion that would catch a transform which silently dropped a line.
 */

import fs from 'fs';
import path from 'path';
import { transformProtocolSource } from '../../../scripts/protocolSourceTransform.cjs';
import { BUILTIN_SOURCES } from './builtinSources.generated';
import { compileProtocol } from './customLoader';
import { validateProtocol } from './validateProtocol';
import {
  BUILTIN_TEMPLATE_PREFIX,
  allTemplates,
  builtinTemplates,
  findTemplate,
} from './customTemplates';
import {
  PROTOCOLS,
  customProtocolList,
  registerCustomProtocol,
  unregisterCustomProtocol,
} from './index';
import { Simulation } from '../Simulation';

const PROTOCOLS_DIR = path.join(__dirname);

/** The same five-node fixture the rest of the engine suites measure on. */
const SAMPLE_TOPOLOGY = {
  N1: [{ neighbor: 'N2', cost: 1 }],
  N2: [
    { neighbor: 'N1', cost: 1 },
    { neighbor: 'N3', cost: 6 },
    { neighbor: 'N5', cost: 3 },
  ],
  N3: [
    { neighbor: 'N2', cost: 6 },
    { neighbor: 'N4', cost: 2 },
  ],
  N4: [
    { neighbor: 'N3', cost: 2 },
    { neighbor: 'N5', cost: 4 },
  ],
  N5: [
    { neighbor: 'N2', cost: 3 },
    { neighbor: 'N4', cost: 4 },
  ],
};

/** protocol id -> the module it came from, read from the registry's own imports. */
function moduleFiles() {
  const index = fs.readFileSync(path.join(PROTOCOLS_DIR, 'index.js'), 'utf8');
  return [...index.matchAll(/^import \{[^}]+\} from '\.\/(\w+)';$/gm)].map(
    (match) => `${match[1]}.js`
  );
}

const EXTRACTS = moduleFiles().map((file) => {
  const source = fs.readFileSync(path.join(PROTOCOLS_DIR, file), 'utf8');
  return transformProtocolSource(source, { file });
});

afterEach(() => {
  customProtocolList().forEach((entry) => unregisterCustomProtocol(entry.id));
});

describe('the generated extract', () => {
  test('covers every built-in protocol', () => {
    expect(Object.keys(BUILTIN_SOURCES).sort()).toEqual(
      PROTOCOLS.map((protocol) => protocol.id).sort()
    );
  });

  test.each(EXTRACTS.map((entry) => [entry.file, entry]))(
    '%s is up to date — run `npm run build:sources` if this fails',
    (file, entry) => {
      expect(BUILTIN_SOURCES[entry.id]).toBe(entry.source);
    }
  );

  test.each(EXTRACTS.map((entry) => [entry.file, entry]))(
    '%s keeps the implementation verbatim',
    (file, entry) => {
      const original = fs
        .readFileSync(path.join(PROTOCOLS_DIR, file), 'utf8')
        .replace(/\r\n/g, '\n');

      // Every line of the module that is not an import or an export survives,
      // in order. This is the claim the header in the editor makes.
      const kept = original
        .split('\n')
        .filter((line) => !/^import |^export default /.test(line))
        .map((line) => line.replace(/^export (const|function) /, '$1 '))
        .filter((line) => line.trim() !== '');
      const produced = entry.source.split('\n');

      let cursor = 0;
      kept.forEach((line) => {
        cursor = produced.indexOf(line, cursor);
        expect({ line, found: cursor !== -1 }).toEqual({ line, found: true });
        cursor += 1;
      });
    }
  );
});

describe('the template menu', () => {
  test('offers every built-in beside the two blank-page templates', () => {
    const builtins = builtinTemplates();

    expect(builtins.map((entry) => entry.id)).toEqual(
      PROTOCOLS.map((protocol) => `${BUILTIN_TEMPLATE_PREFIX}${protocol.id}`)
    );
    // Labels come from the live plugin, so renaming a protocol renames the menu.
    expect(builtins.map((entry) => entry.label)).toEqual(
      PROTOCOLS.map((protocol) => protocol.name)
    );
    expect(allTemplates()).toHaveLength(2 + PROTOCOLS.length);
    expect(findTemplate('builtin:dvr').source).toBe(BUILTIN_SOURCES.dvr);
    expect(findTemplate('builtin:nope')).toBeNull();
  });
});

describe.each(PROTOCOLS.map((protocol) => [protocol.id, protocol]))(
  'the editable copy of %s',
  (id, builtin) => {
    const compile = () => {
      const compiled = compileProtocol(BUILTIN_SOURCES[id]);
      expect(compiled.error).toBeNull();
      expect(compiled.ok).toBe(true);
      return compiled.plugin;
    };

    test('compiles, and renames itself so it can run beside the original', () => {
      const plugin = compile();
      expect(plugin.id).toBe(`${id}-copy`);
      expect(plugin.name).toBe(`${builtin.name} — my copy`);
      // Everything else is the built-in's own declaration.
      expect(plugin.summary).toBe(builtin.summary);
      expect(plugin.messageLabel).toBe(builtin.messageLabel);
      expect(plugin.options.map((option) => option.key)).toEqual(
        builtin.options.map((option) => option.key)
      );
      expect(typeof plugin.startTimers).toBe(typeof builtin.startTimers);
    });

    test('passes the same gate a user-written protocol passes', () => {
      const { errors } = validateProtocol(compile());
      expect(errors).toEqual([]);
    });

    /**
     * The assertion that makes the feature worth having: run side by side on
     * the same network, the copy and the original are the same protocol.
     */
    test('behaves identically to the built-in it came from', () => {
      const plugin = registerCustomProtocol(compile());

      const original = new Simulation(SAMPLE_TOPOLOGY, id);
      const copy = new Simulation(SAMPLE_TOPOLOGY, plugin.id);

      const originalRun = original.runToConvergence();
      const copyRun = copy.runToConvergence();

      expect(copyRun).toEqual(originalRun);
      expect(copy.tables()).toEqual(original.tables());
      expect(copy.stats.messages).toBe(original.stats.messages);
      expect(copy.stats.entriesAdvertised).toBe(original.stats.entriesAdvertised);
      expect(copy.stats.roundsToConverge).toBe(original.stats.roundsToConverge);

      // …and through a failure, which is where two implementations that merely
      // look alike come apart.
      original.removeLink('N2', 'N3');
      copy.removeLink('N2', 'N3');
      expect(copy.runToConvergence()).toEqual(original.runToConvergence());
      expect(copy.tables()).toEqual(original.tables());
    });

    test('runs on the clock too, when the original does', () => {
      if (typeof builtin.startTimers !== 'function') {
        expect(new Simulation(SAMPLE_TOPOLOGY, id).supportsTimers).toBe(false);
        return;
      }
      const plugin = registerCustomProtocol(compile());

      const original = new Simulation(SAMPLE_TOPOLOGY, id, undefined, { mode: 'timers' });
      const copy = new Simulation(SAMPLE_TOPOLOGY, plugin.id, undefined, { mode: 'timers' });
      expect(copy.supportsTimers).toBe(true);

      const originalRun = original.runToQuiet();
      const copyRun = copy.runToQuiet();

      expect(copyRun.converged).toBe(originalRun.converged);
      expect(copyRun.seconds).toBe(originalRun.seconds);
      expect(copy.tables()).toEqual(original.tables());
    });
  }
);
