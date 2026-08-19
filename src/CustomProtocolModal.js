/**
 * CustomProtocolModal.js — write a routing protocol, in the browser, and run it.
 *
 * The app was refactored so that nothing outside `engine/protocols/` names a
 * protocol: the option panel, the table columns, the packet colours, the legend,
 * the help text, the inspector tabs and the per-router knobs are all rendered
 * from whatever the active plugin declares. A user-written protocol therefore
 * needs no UI of its own — this dialog exists only to get one *into* the
 * registry, and everything downstream treats it exactly like a built-in.
 *
 * Four things happen here and nothing else:
 *
 *   - an editor, seeded from a template or a file the user picked;
 *   - the draft, kept in `sessionStorage` on every keystroke (debounced), so a
 *     reload never costs anybody their code;
 *   - Validate & Activate, which is `attemptActivation` — compile, then the
 *     contract check, then a real four-router smoke run — and nothing is
 *     registered unless all three pass;
 *   - the results, in full. A compile error names a line; a contract error names
 *     the field; a warning says what will look odd and then gets out of the way,
 *     because a protocol that is wrong on purpose is a legitimate thing to build
 *     in a simulator whose whole point is watching protocols be wrong.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import Modal from './Modal';
import {
  CUSTOM_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  builtinTemplates,
  findTemplate,
  templateSource,
} from './engine/protocols/customTemplates';
import { attemptActivation, writeStoredSource } from './customProtocolSession';

/** How long after the last keystroke the draft is written to sessionStorage. */
const SAVE_DEBOUNCE_MS = 400;

const EDITOR_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLine: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: false,
  highlightSelectionMatches: false,
};

/** What the file picker will accept. Anything textual — it is source either way. */
const ACCEPTED_FILES = '.js,.mjs,.txt,text/javascript,text/plain';

/**
 * The validator writes field names in backticks, the way the contract does.
 *
 * Rendering them as code rather than leaving the punctuation on screen: half of
 * every message is an identifier the user has to find in their own source, and
 * `messageLabel` set apart from the prose is far easier to spot than
 * messageLabel buried in it.
 */
function CodeText({ text }) {
  return String(text)
    .split('`')
    .map((part, index) =>
      index % 2 === 1 ? (
        // eslint-disable-next-line react/no-array-index-key
        <code key={index}>{part}</code>
      ) : (
        // eslint-disable-next-line react/no-array-index-key
        <React.Fragment key={index}>{part}</React.Fragment>
      )
    );
}

function CustomProtocolModal({
  onClose,
  initialSource,
  activeId,
  onSourceChange,
  onActivate,
  onRemove,
  onClear,
}) {
  const [source, setSource] = useState(
    () => initialSource || templateSource(DEFAULT_TEMPLATE_ID)
  );
  const [result, setResult] = useState(null);
  const [notice, setNotice] = useState(null);

  // Five entries built from the live plugin objects; cheap, but there is no
  // reason to rebuild the list on every keystroke.
  const builtins = useMemo(() => builtinTemplates(), []);

  const fileRef = useRef(null);
  const saveTimerRef = useRef(null);
  // The latest text, readable from the unmount cleanup — which runs after the
  // last render and so cannot see `source` through the closure it was created in.
  const latestRef = useRef(source);

  /**
   * Persist the draft, debounced.
   *
   * Debounced rather than per-keystroke because this is a synchronous write of
   * the whole document; 400 ms is far below the interval at which anybody
   * reloads a page, and the unmount cleanup flushes whatever is outstanding.
   */
  useEffect(() => {
    latestRef.current = source;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      writeStoredSource(source);
      onSourceChange(source);
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Closing the dialog must not be able to lose the last few characters typed.
  useEffect(
    () => () => {
      writeStoredSource(latestRef.current);
      onSourceChange(latestRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /**
   * Load a starting point: one of the two templates, or one of the five shipped
   * protocols.
   *
   * A built-in opens as its *real* source — the module the app is running,
   * extracted at build time rather than retold — with its id renamed at the
   * bottom so the copy runs beside the original instead of fighting it for the
   * name. Which means the first thing a curious person can do is press Activate
   * and see nothing change, and the second is start breaking things.
   */
  function loadTemplate(id) {
    const template = findTemplate(id);
    if (!template) return;

    setSource(template.source);
    setResult(null);
    setNotice(
      template.builtin
        ? `Opened the real ${template.label} implementation — the module the app is ` +
            'running. The last two lines rename it, so activating gives you a copy ' +
            'alongside the original rather than a replacement for it.'
        : `Loaded the ${template.label.toLowerCase()}. It compiles and runs as it stands.`
    );
  }

  /**
   * Upload only ever fills the editor.
   *
   * The file takes the same road as typed code — Validate & Activate, the same
   * checks, the same errors — because a plugin from a file is no more
   * trustworthy than one from the clipboard, and having two ways in would mean
   * two things to keep in step.
   */
  function readFile(event) {
    const file = event.target.files && event.target.files[0];
    // Cleared straight away so picking the same file twice still fires a change.
    event.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      setSource(String(reader.result || ''));
      setResult(null);
      setNotice(`Loaded ${file.name} into the editor. Nothing has run yet.`);
    };
    reader.onerror = () => setNotice(`Could not read ${file.name}.`);
    reader.readAsText(file);
  }

  function activate() {
    setNotice(null);
    const outcome = attemptActivation(source);
    setResult(outcome);
    if (!outcome.ok) return;

    // Remember across reloads only once it has actually worked, so a tab that
    // was mid-edit comes back with the code but without trying to run it.
    writeStoredSource(source);
    onSourceChange(source);
    onActivate(outcome.plugin);
  }

  function remove() {
    setResult(null);
    setNotice('Removed. The dropdown is back to the built-in protocols.');
    onRemove();
  }

  function clear() {
    setSource('');
    setResult(null);
    setNotice('Cleared. Nothing is left in this tab.');
    onClear();
  }

  const failed = result && !result.ok;
  const warnings = (result && result.warnings) || [];

  return (
    <Modal
      onClose={onClose}
      label="Write a custom protocol"
      className="modal-content--custom"
    >
      <h2>Custom protocol</h2>

      <p>
        Write a plugin and it joins the protocol dropdown for this tab. Everything
        else follows from what you declare: the settings panel, the table columns,
        the packet colours, the legend and the help text are all rendered from the
        plugin, and a protocol that implements <code>startTimers</code> can be run
        on the virtual clock too.
      </p>

      <p>
        You do not have to start from nothing. <strong>Open in editor</strong> also
        offers all five shipped protocols, and what opens is the source the app is
        actually running — so you can take split horizon out of distance vector,
        change what a link-state router floods, or give spanning tree a different
        tie-break, and watch your version run beside the original.
      </p>

      {/* Said once, plainly, and above the editor rather than under it. */}
      <p className="custom-protocol__trust">
        <strong>This code runs in your browser tab, with full access to the page</strong>
        {' '}— exactly like typing into the developer console. Only paste code you
        trust. It is never uploaded, never written to disk, and never travels in a
        shareable link; it lives in this tab and disappears when you close it.
      </p>

      <div className="custom-protocol__toolbar">
        <label className="custom-protocol__template">
          <span>Open in editor</span>
          <select
            value=""
            onChange={(event) => loadTemplate(event.target.value)}
            aria-label="Open a template or a built-in protocol in the editor"
          >
            <option value="">Choose…</option>
            <optgroup label="Start from scratch">
              {CUSTOM_TEMPLATES.map((template) => (
                <option key={template.id} value={template.id} title={template.summary}>
                  {template.label}
                </option>
              ))}
            </optgroup>
            {/* The real modules, not simplified retellings of them — which is
                why they are worth offering at all. */}
            <optgroup label="Edit a built-in protocol">
              {builtins.map((template) => (
                <option key={template.id} value={template.id} title={template.summary}>
                  {template.label}
                </option>
              ))}
            </optgroup>
          </select>
        </label>

        <button type="button" className="secondary" onClick={() => fileRef.current.click()}>
          Upload .js
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_FILES}
          onChange={readFile}
          className="custom-protocol__file"
          tabIndex={-1}
          aria-hidden="true"
        />

        <button type="button" onClick={activate}>
          Validate &amp; Activate
        </button>

        {activeId && (
          <button type="button" className="ghost" onClick={remove}>
            Remove "{activeId}"
          </button>
        )}
        <button type="button" className="ghost" onClick={clear}>
          Clear
        </button>
      </div>

      <div className="custom-protocol__editor">
        <CodeMirror
          value={source}
          height="340px"
          extensions={[javascript()]}
          basicSetup={EDITOR_SETUP}
          onChange={(value) => setSource(value)}
          aria-label="Protocol source code"
        />
      </div>

      <p className="hint">
        The source is a function body with <code>helpers</code> and{' '}
        <code>config</code> in scope, ending in <code>return protocol;</code> — the
        templates say which fields are required and why. Validating runs your
        protocol on a hidden four-router network: it has to converge, survive a
        broken link, and be honest about whether anything changed.
      </p>

      {notice && <p className="custom-protocol__notice">{notice}</p>}

      {result && result.ok && (
        <div className="custom-protocol__result custom-protocol__result--ok" role="status">
          <strong>Activated.</strong> "{result.plugin.name}" is selected in the protocol
          dropdown, and it is in the comparison table too.
        </div>
      )}

      {failed && result.compileError && (
        <div className="custom-protocol__result custom-protocol__result--bad" role="alert">
          <strong>It did not compile.</strong>
          <p className="custom-protocol__error">{result.compileError}</p>
        </div>
      )}

      {failed && !result.compileError && result.errors.length > 0 && (
        <div className="custom-protocol__result custom-protocol__result--bad" role="alert">
          <strong>
            Not activated — {result.errors.length}{' '}
            {result.errors.length === 1 ? 'problem' : 'problems'}:
          </strong>
          <ul>
            {result.errors.map((message) => (
              <li key={message}>
                <CodeText text={message} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="custom-protocol__result custom-protocol__result--warn">
          <strong>
            {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'} — worth
            reading, but {result.ok ? 'it is running anyway' : 'not what blocked it'}:
          </strong>
          <ul>
            {warnings.map((message) => (
              <li key={message}>
                <CodeText text={message} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <button type="button" onClick={onClose}>
        Close
      </button>
    </Modal>
  );
}

export default CustomProtocolModal;
