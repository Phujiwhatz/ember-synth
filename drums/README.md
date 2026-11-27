# Pulse·16 — drum machine plugin for Logic Pro

8 drum tracks · synthesized 808/909-style drums **or** your own samples on every track ·
16-step sequencer locked to Logic's tempo · swing, accents, drive · plays from MIDI too.

Builds as an **Audio Unit** (what Logic uses), plus VST3 and a standalone app.

---

## Easiest: download the ready-made build
Go to this repo's **Releases**, download the newest `Pulse-16-macOS.zip`, unzip it, then right-click **Install Pulse 16.command → Open**. (GitHub builds it automatically on every push to the `pulse16` branch.)

## Build it yourself (one time, ~20 min)

### 1. Install the tools
Open **Terminal** and run:

```bash
xcode-select --install
```
Click *Install* in the popup (Apple's free compiler, ~1 GB).

Then install CMake. Easiest is Homebrew (https://brew.sh):
```bash
brew install cmake
```
(No Homebrew? Download the CMake .dmg from cmake.org, drag it to Applications, then run
`sudo "/Applications/CMake.app/Contents/bin/cmake-gui" --install`.)

### 2. Build
Unzip `Pulse16.zip` (say, into your Downloads folder), then:

```bash
cd ~/Downloads/Pulse16
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j 8
```
The first command downloads JUCE automatically (needs internet). The build takes a few minutes.
When it finishes, the plugin is in
`build/Pulse16_artefacts/Release/AU/` — copy `Pulse 16.component` into `~/Library/Audio/Plug-Ins/Components/`.

### 3. Open in Logic
1. Quit and reopen Logic Pro (it scans new plugins on launch).
2. Create a **Software Instrument** track.
3. Click the Instrument slot → **AU Instruments → Ember Studio → Pulse 16**.
4. Press play — the pattern runs in sync with Logic.

**Logic doesn't show it?** Run these, then reopen Logic:
```bash
killall -9 AudioComponentRegistrar
auval -v aumu Pl16 Embr
```
The second line validates the plugin; it should end with `AU VALIDATION SUCCEEDED`.
You can also use *Logic Pro → Settings → Plug-in Manager → Reset & Rescan Selection*.

---

## Using it

| Control | What it does |
|---|---|
| **Pads** (KICK, SNARE…) | Click to audition |
| **SMP** | Switch the track between synth and sample |
| **LOAD** | Pick a sample. Or **drag any audio file** from Finder onto a row |
| **LEVEL / TUNE / DECAY / TONE / PAN** | Per-track sound shaping (double-click resets) |
| **Step grid** | Click: off → on → accent. Right-click toggles accent. Drag to paint |
| **SWING** | Shuffles the off-beat 16ths |
| **ACCENT** | How much louder accented steps are |
| **DRIVE** | Saturation on the whole kit |
| **RUN / TEMPO** | Plays the pattern while Logic is stopped (or in the standalone app) |
| **CLEAR** | Wipes the pattern |

**What the knobs do in synth mode**
- *Kick* — Tune = pitch, Decay = boom length, Tone = punch/saturation
- *Snare* — Tone = body ↔ snares balance
- *Clap* — Tone = brightness
- *Hats* — Tone = brightness; closed hat chokes the open hat, like a real 808
- *Toms* — Tone = attack/stick noise
- *Cowbell* — Tone = filter colour

**In sample mode:** Tune = pitch (±24 semitones), Decay = fade length (all the way up = full
sample), Tone = low-pass filter (all the way up = off).

**Playing from a keyboard / MIDI regions** — standard General MIDI drum notes, so Logic's
drum patterns work: C1 kick, C#1/D1 snare, D#1 clap, F#1 closed hat, A#1 open hat,
A1 low tom, D2 high tom, G#2 cowbell. On a small keyboard, **C3–G3** play tracks 1–8 too.

Your pattern, settings and sample file locations are saved with the Logic project.
(If you move or rename a sample file, that track falls back to its synth sound.)

---

## Files
- `Source/DrumEngine.h` — the drum synthesis + sample playback
- `Source/PluginProcessor.*` — sequencer, MIDI, parameters, saving
- `Source/PluginEditor.*` — the interface
- `CMakeLists.txt` — build setup (change `COMPANY_NAME` / codes if you like)
