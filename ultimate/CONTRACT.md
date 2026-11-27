# Ember Ultimate: shared contract (read before writing code)

Goal: ONE self-contained, fully OFFLINE HTML file (`dist/ember-ultimate.html`) that the
user opens from their Mac on an airplane. No network at runtime: no CDNs, no Google
Fonts, no fetch() of remote URLs. Use system font stacks only. The user has a ROLI
Piano M (MIDI + MPE: per-note pitch bend on member channels, channel pressure) and
mostly uses Chrome. It must look polished (dark, "studio hardware" aesthetic consistent
with the existing Ember Studio in `../synth.html`).

## Layout (repo: /home/claude/ember-synth, project root: ultimate/)
```
ultimate/
  CONTRACT.md            this file
  src/core/              shell: studio core, mixer, transport, MIDI, storage, UI chrome  (agent: shell)
  src/plugins/<id>.js    one file per plugin; optional src/plugins/<id>.css
  samples/               rendered audio + samples/manifest.json                         (agent: samples)
  tests/                 each agent's own harness + playwright scripts
  build.py               inlines everything into dist/ember-ultimate.html              (agent: shell)
  dist/
```
Only write inside YOUR files. Never edit another agent's files. Plain browser JS (no
modules, no bundler, no npm installs, network is off). Each plugin file is a plain
script that calls `Studio.registerPlugin({...})` at load time. Wrap the file in an IIFE.
All CSS must be scoped under `.plug-<id>` (the shell gives each plugin a container
`<div class="plug plug-<id>">`). Never use global ids or element selectors like `body`, `button {}`.

## window.Studio API (implemented by the shell; plugins consume it)
```js
Studio.registerPlugin(def)        // call at script load
Studio.ctx                        // AudioContext (exists by the time init() is called)
Studio.samples.manifest           // parsed samples/manifest.json
Studio.samples.get(id)            // -> Promise<AudioBuffer> (decoded + cached)
Studio.samples.byCategory(cat)    // -> manifest entries
Studio.samples.importFile(file, {category})  // user file -> stored in IndexedDB, returns entry {id,...}; get(id) works after
Studio.storage.get(key) / set(key, value)   // async, IndexedDB, values may be JSON or Blob/ArrayBuffer
Studio.transport = { bpm, playing, swing (0..0.5),
  on(evt, fn) }  // evts: 'step' fn(step16, time) fired ~100ms ahead with exact AudioContext time
                 // for every 16th note while playing (step16 counts from 0 at start);
                 // 'start' fn(time); 'stop' fn(); 'bpm' fn(bpm)
Studio.toast(msg)                 // small notification
```
Lookahead scheduling: plugins schedule audio at the given `time`, never with setTimeout.

## Plugin definition
```js
{
  id: 'pulse16', name: 'Pulse 16', kind: 'drums' | 'instrument' | 'fx',
  color: '#ff5a36',               // accent color for tab/channel strip
  icon: '<svg ...>',              // optional 20px inline SVG
  async init(ctx, out, Studio) {}, // build audio graph; connect everything to `out` (a GainNode the shell owns: channel strip)
  mount(el) {},                   // render UI into el (called once, lazily, when tab first shown). Fill the width; height ≈ 560px min.
  noteOn(note, vel, time, info) {}, // vel 0..1, info = {ch, mpe:boolean}
  noteOff(note, time, info) {},
  bend(semitones, info) {},       // info.ch: per-note for MPE member channels; global otherwise
  pressure(value, info) {},       // 0..1
  cc(num, value01, info) {},      // 1 = mod wheel, 64 = sustain
  allNotesOff() {},
  getState() { return {...} },    // JSON-serialisable; used for project save + autosave
  setState(s) {},
}
```
MIDI/QWERTY input goes to the plugin whose tab is selected ("armed"). Plugins with
their own sequencer (Pulse 16, Acid) play via the transport whether or not armed.
Drum plugins map notes 36–51 to their 16 pads.

## Samples (samples/manifest.json)
```json
{ "version": 1,
  "samples": [ { "id": "kit-808-kick", "file": "kit-808/kick.m4a", "category": "drums",
                 "kit": "808", "pad": "kick", "root": 36 },
               { "id": "keys-grand-c4", "file": "keys/grand/c4.m4a", "category": "keys",
                 "instrument": "grand", "root": 60, "velLayer": 1, "loop": null } ],
  "kits": { "808": {"name": "TR-808ish", "pads": ["kick","snare",...16 ids]} },
  "instruments": { "grand": {"name": "Concert Grand", "category":"keys",
                   "zones": [ {"id":"keys-grand-c4","root":60,"lo":57,"hi":62,"velLo":0,"velHi":1} ],
                   "release": 0.6, "loop": false } }
}
```
`loop` when present = {"start": sec, "end": sec} for sustained sounds. Categories:
drums, keys, bass, pads, plucks, textures, fx.

## Shell UI (for reference)
Top bar: logo, transport (play/stop, BPM, swing, metronome), MIDI status, project menu.
Left: plugin tabs. Bottom: mixer strip per plugin (vol, pan, mute, solo, reverb send,
delay send, meter) + master. On-screen + QWERTY keyboard (A W S E D F T G Y H U J K, Z/X octave).

## Testing
Make `tests/<id>-harness.html` with a minimal mock of Studio (copy from tests/mock-studio.js if
the shell agent has written it, otherwise write your own tiny mock in your harness).
Serve with `python3 -m http.server` from ultimate/ and drive headless Chrome via Playwright
(node: `require('playwright')`, chromium at /usr/bin/google-chrome via `executablePath`,
args ['--autoplay-policy=no-user-gesture-required']). Check: no console errors, UI renders
(take a screenshot and LOOK at it with Read), audio actually produces non-silent output
(e.g. render through an OfflineAudioContext or tap an AnalyserNode and check RMS).
