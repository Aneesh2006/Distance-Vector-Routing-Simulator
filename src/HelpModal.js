/**
 * HelpModal.js — the one help dialog.
 *
 * Split in two since the protocol refactor: the shared sections are true whatever
 * is loaded and live here; everything protocol-specific comes from
 * `protocol.help`, which the active plugin supplies as plain `{ heading, items }`
 * data. So the help text changes when the dropdown does, without this file
 * learning a sixth dialect.
 *
 * "Shared" has to be read strictly, and that is the trap this file fell into
 * once: a sentence about split horizon or DV spheres is not shared, it is
 * distance vector's, and leaving it here made every other protocol's help
 * quietly wrong. Nothing below names a protocol. What it does cover is the
 * apparatus every protocol is measured by — the scoreboard, the two clocks, the
 * comparison table, the shareable link — because those are the same whichever
 * one is loaded, and none of them is discoverable by looking at the scene.
 */

import React from 'react';
import Modal from './Modal';
import { SIM } from './config';

/**
 * The sections that do not depend on the active protocol.
 *
 * Data rather than markup, in the same `{ heading, items }` shape a plugin
 * supplies, so the two are rendered by one loop and cannot drift apart in
 * appearance. The protocol's own sections are spliced in the middle: after the
 * apparatus, before the camera, which is where someone reading top to bottom
 * wants them.
 */
const SHARED_SECTIONS = [
  {
    heading: 'Getting started',
    items: [
      'Pick a protocol and a preset, or add routers and link them together. Both ' +
        'dropdowns are at the top left; the presets are grouped by the question ' +
        'each one exists to answer.',
      'Press Run Next Round — or Play, if you have switched the Run panel to ' +
        'Timers — and watch the messages travel.',
      'Click a router, in the scene or in the list, to inspect what it knows. ' +
        'Some protocols add tabs there: a link-state database, a set of timers, ' +
        'a bridge\'s ports.',
      'Keep going until the counter reports CONVERGED (or QUIET, on the clock), ' +
        'then read the meter beside it. Settled and correct are different ' +
        'questions, and the next section is about the difference.',
    ],
  },
  {
    heading: 'Converged is not the same as correct',
    items: [
      'CONVERGED means one thing only: nothing changed last round. A network can ' +
        'converge on an answer that is wrong — a stale route through a router ' +
        'that is no longer there, or two halves of a partition each certain about ' +
        'the other — and the badge would happily claim success.',
      'So beside it is the real score: "Tables correct: 18 / 25". Every routing ' +
        'table entry is compared against the true shortest path, computed from the ' +
        'topology rather than from anything a router believes. The sparkline under ' +
        'it is that percentage per round since the last edit, which is why a link ' +
        'break shows as a visible dip and a slow crawl back.',
      'Wrong entries are tinted in the table, and the legend under it names only ' +
        'the kinds currently on screen: amber for a route that works but is not ' +
        'the cheapest, red for one that believes the wrong thing — unreachable ' +
        'when it is not, reachable when it is not, or pointing into a loop.',
      'Each router carries its own score in the list, so "which router is wrong?" ' +
        'is answered without opening anything.',
    ],
  },
  {
    heading: 'Reading the scene',
    items: [
      'Cubes are routers; the amber one is selected, grey ones are switched off.',
      'Green tubes are links, labelled with their cost. Undecorated links pulse ' +
        'gently; a link a protocol has something to say about holds still and ' +
        'changes colour — blocked, on the tree, carrying a policy route, crossing ' +
        'an area or an AS boundary. The legend at the bottom left lists whichever ' +
        'of those the active protocol uses.',
      'Coloured spheres are messages in flight, captioned with what they are. ' +
        'Each protocol has its own colour, and some label individual messages: an ' +
        'advertisement names the router that wrote it, a triggered update is ' +
        'marked apart from a scheduled one.',
      'Routers can be tinted too, and marked in the list: a root bridge, a router ' +
        'still recomputing, a database out of step, an area border router.',
      'Orange links and a cyan pulse trace the path from the Path Finder. Turn on ' +
        '"Show route tree" with a router selected and every link its table ' +
        'actually uses lights up — which is the shortest-path tree under one ' +
        'protocol and a policy tree under another, from the same toggle.',
      'A cost of ∞ means unreachable. It is a small finite ceiling rather than a ' +
        'true infinity, which is what the Infinity setting sets, and for one ' +
        'protocol that ceiling is load-bearing rather than cosmetic.',
    ],
  },
  {
    heading: 'Two clocks',
    items: [
      'Rounds mode is lockstep: one round, every router speaks, every router ' +
        'listens, and the round has no width. It is the clearest way to watch an ' +
        'algorithm and it is not how any real network behaves.',
      `Timers mode gives every router its own clock, in real seconds, with the ` +
        `protocol's real constants. Convergence there is defined as quiet — no ` +
        `table has changed and nothing but the periodic timers is outstanding, ` +
        `for long enough to be sure — and the "Quiet for" row in Stats is that ` +
        `definition ticking over rather than a claim you have to take on trust.`,
      'The toggle only appears for protocols that have timers. The others are not ' +
        'broken on the clock; they simply have no idea what a second is.',
      `On the clock, the speed slider is simulated seconds per real second, so a ` +
        `three-minute timeout becomes ${Math.round(180 / SIM.timers.defaultSpeed)} ` +
        `seconds of watching without the protocol's own numbers changing. The seed ` +
        `drives every jittered decision: the same seed replays the same run ` +
        `exactly, and a different one changes how long it takes but never the ` +
        `answer. Convergence is a distribution, not a number.`,
      'Step to Next Event skips the empty seconds — nothing happens between ' +
        'events, so nothing has to be simulated — and the Event Log narrates what ' +
        'did, timestamped.',
    ],
  },
  {
    heading: 'Comparing protocols, and sharing what you built',
    items: [
      'Compare Protocols runs every protocol from cold on a copy of the current ' +
        'topology and puts the results in one table: rounds to converge, ' +
        'messages, entries advertised, peak wrong entries, loops seen. Nothing it ' +
        'does touches the live simulation.',
      'Pick an event and each protocol is measured again on the way back from it, ' +
        'so all six columns describe one recovery and can be read across. Distance ' +
        'vector appears twice, with split horizon on and off, because running the ' +
        'same protocol under two settings belongs in the comparison too.',
      'Entries advertised counts payload rather than packets, and it is the column ' +
        'that keeps the table honest: one protocol sends far fewer, far bigger ' +
        'messages, and counting only packets would flatter it.',
      'Every row runs at that protocol\'s own defaults rather than at your live ' +
        'settings, so the table is reproducible from one open to the next.',
      'Copy Shareable Link puts the whole scenario in the address bar — topology, ' +
        'positions, protocol, every setting, the per-router knobs and the seed. ' +
        'What it does not carry is how far the run has got, so whoever opens it ' +
        'starts where you started rather than where you finished.',
    ],
  },
  {
    heading: 'Writing your own protocol',
    items: [
      '"Write a custom protocol…", under the protocol dropdown, opens an editor. ' +
        'A plugin is a plain object — an id, a name, a table of settings, some ' +
        'columns, and three functions — and once it validates it joins the ' +
        'dropdown, the comparison table and everything else, exactly like a ' +
        'built-in one. Start from the minimal skeleton or the worked example.',
      'Or start from one of the five that ship with the app: the same menu opens ' +
        'any of them, and what opens is the source the simulator is actually ' +
        'running rather than a simplified retelling of it. Only the id and the ' +
        'name are changed, at the very bottom, so your copy runs beside the ' +
        'original instead of replacing it — which means you can put the two in ' +
        'the comparison table together and measure what your change cost.',
      'Validate & Activate compiles the code, checks it against the contract, and ' +
        'then actually runs it on a hidden four-router network: it has to converge, ' +
        'survive a broken link, and be honest about whether anything changed. ' +
        'Errors block activation and name the field or the rule; warnings do not, ' +
        'because a protocol that gets the wrong answer is a perfectly good thing to ' +
        'build here.',
      'The code runs in your browser tab with full access to the page, like ' +
        'anything typed into the developer console — so only paste code you trust. ' +
        'It is never uploaded and never written to disk.',
      'It lives in this tab and nowhere else. A shareable link carries a protocol ' +
        'id rather than any code, so a link made while your own protocol is ' +
        'selected opens on the default one for whoever receives it — and closing ' +
        'the tab is what removes it.',
    ],
  },
];

const CAMERA_SECTION = {
  heading: 'Camera',
  items: [
    'Drag with the left mouse button to orbit.',
    'Scroll or pinch to zoom.',
    'Drag with the right mouse button to pan.',
    '"Fit view to network" re-frames everything if you get lost.',
  ],
};

function HelpModal({ isOpen, onClose, protocol }) {
  if (!isOpen) return null;

  const name = protocol ? protocol.name : 'Routing';
  const sections = [
    ...SHARED_SECTIONS,
    ...((protocol && protocol.help) || []),
    CAMERA_SECTION,
  ];

  return (
    <Modal
      onClose={onClose}
      label="Routing protocol simulator help"
      className="modal-content--help"
    >
      <h2>Routing Protocol Simulator</h2>

      <p>
        <strong>{name}.</strong> {protocol && protocol.summary}
      </p>

      {sections.map((section) => (
        <React.Fragment key={section.heading}>
          <h3>{section.heading}</h3>
          <ul>
            {section.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </React.Fragment>
      ))}

      <button type="button" onClick={onClose}>
        Got it
      </button>
    </Modal>
  );
}

export default HelpModal;
