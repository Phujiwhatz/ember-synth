# Pulse 16 v2 — shared spec (read fully before editing)

Repo: /home/claude/ember-synth (branch `pulse16`). Plugin source in `drums/`. JUCE 8.0.4 checkout at
/home/claude/JUCE (for compile checks only — do NOT add it to the repo). Builds for real happen on GitHub
Actions (macOS); the lead agent pushes. **Do not git commit or push.**

User complaints to fix:
1. Wants to play AND record with a MIDI keyboard (ROLI Piano M, 25 keys, MPE — notes may arrive on any
   channel 1-16) and also from the computer (mouse + computer keyboard).
2. "How are you supposed to sample it — I press the button and nothing works." Pressing SMP with no sample
   just fell back to synth (looked like nothing happened), and LOAD opened a native file dialog that may not
   appear inside Logic. Loading sounds must be obvious and work from inside the plugin window.
3. Wants a built-in sound library, and a way to load more sounds.

## Ownership (only edit your own files)
- **Sounds agent**: `drums/tools/**`, `drums/library/**`
- **Engine agent**: `drums/Source/DrumEngine.h`, `drums/Source/Library.h`, `drums/Source/Library.cpp`,
  `drums/Source/PluginProcessor.h`, `drums/Source/PluginProcessor.cpp`, `drums/CMakeLists.txt`
- **UI agent**: `drums/Source/PluginEditor.h`, `drums/Source/PluginEditor.cpp`

## Built-in library format (Sounds agent produces; Engine agent consumes)
- `drums/library/library.zip` — zip whose entries are `<Category>/<Sound Name>.wav`
  (44.1 kHz, 16-bit, mono or stereo, peak ≈ -1 dBFS, leading silence trimmed, < 3 s each).
  Categories exactly: `Kicks`, `Snares`, `Claps`, `Hats`, `Cymbals`, `Toms`, `Percussion`, `FX`.
  All sounds must be ORIGINAL — synthesized by our own code. No downloaded or copied samples.
- `drums/library/kits.json`:
  ```json
  { "kits": [ { "name": "808 Classic",
                "tracks": [ { "sound": "synth", "level": 0.9, "tune": 0, "decay": 0.5, "tone": 0.5, "pan": 0 },
                            { "sound": "builtin:Snares/Tight 909.wav", "level": 0.8, "tune": 0, "decay": 0.98, "tone": 1.0, "pan": 0 },
                            ... exactly 8 entries, track order: Kick, Snare, Clap, ClosedHat, OpenHat, LowTom, HighTom, Perc ] } ] }
  ```
  `"sound": "synth"` = use that track's built-in synth voice. tune is semitones (-24..24), others 0..1.
- CMake embeds both via `juce_add_binary_data(Pulse16Data SOURCES library/library.zip library/kits.json)`
  → `BinaryData::library_zip`, `BinaryData::library_zipSize`, `BinaryData::kits_json`, `BinaryData::kits_jsonSize`.

## Sound IDs
- `builtin:<Category>/<Name>.wav` — inside the embedded zip
- `file:<absolute path>` — any audio file on disk (user library folders, drag-and-drop, file browser)
- empty string = synth voice

## Engine/Processor public API (Engine agent implements EXACTLY this; UI agent codes against it)

```cpp
// Source/Library.h
struct LibraryEntry
{
    juce::String id;        // "builtin:Kicks/Deep 808.wav" or "file:/Users/x/Music/Pulse 16 Library/Kicks/a.wav"
    juce::String name;      // "Deep 808"
    juce::String category;  // "Kicks" (user files: their parent folder name, or "User")
    bool builtIn = true;
};

class SoundLibrary
{
public:
    SoundLibrary();                                          // indexes built-ins + user folders
    void rescan();                                           // message thread
    const juce::Array<LibraryEntry>& getEntries() const;     // message thread only
    juce::StringArray getCategories() const;                 // built-in order first, then user categories
    juce::Array<juce::File> getUserFolders() const;          // includes default folder
    void addUserFolder (const juce::File&);                  // persisted (juce::PropertiesFile), rescans
    void removeUserFolder (const juce::File&);
    static juce::File getDefaultUserFolder();                // ~/Music/Pulse 16 Library (created if missing,
                                                             // with empty category subfolders + a README.txt)
    std::shared_ptr<drums::SampleData> load (const juce::String& soundId) const; // nullptr on failure
    static juce::String displayName (const juce::String& soundId);               // "Deep 808"
};

// Added to Pulse16AudioProcessor (public). Message-thread functions unless noted.
SoundLibrary library;
bool loadSound (int track, const juce::String& soundId);  // loads + switches track to sample mode ("mode" param on). "" -> synth
juce::String getSoundId (int track) const;               // "" if synth
juce::String getSoundName (int track) const;             // display name, "" if synth
void previewSound (const juce::String& soundId);         // plays once on a hidden preview voice (centre, level 0.8)
juce::StringArray getKitNames() const;
void loadKit (int kitIndex);                              // sets sounds + params for all 8 tracks
void triggerPadFromUI (int track, float velocity);        // mouse/computer keyboard; thread-safe; recorded when recording
std::atomic<bool> recording { false };                    // REC: live hits (MIDI, pads, keys) are written into the pattern
int  getLearnTrack() const;                               // -1 if not learning
void startMidiLearn (int track);                          // next MIDI note-on assigns that note to the track
void cancelMidiLearn();
int  getLearnedNote (int track) const;                    // -1 = none
juce::String describeKeymap (int track) const;            // e.g. "C1 / C" for the UI tooltip
// existing and kept: steps[][], currentStep, hitFlash[], clearPattern(), loadDefaultPattern(), isAudioFile(),
// loadSample(int, File) (now = loadSound(track, "file:"+path)), clearSample(int).
// pendingPads is replaced by triggerPadFromUI (remove pendingPads).
```

New parameters (APVTS, ParameterID version 1): `keymap` AudioParameterChoice {"Every octave", "GM drums"},
default 0; `quantize` AudioParameterBool default true.

### MIDI behaviour
- Accept note-ons on ALL channels. Velocity 0 note-on = note-off (ignore).
- Learned notes (MIDI learn) take priority.
- `Every octave` (default): in every octave, C C# D D# E F F# G → tracks 1-8; G#..B ignored.
- `GM drums`: 35/36 kick, 37/38/40 snare, 39 clap, 42/44 closed hat, 46 open hat, 41/43/45 low tom,
  47/48/50 high tom, 56 (and 54, 75, 76) perc.

### Recording behaviour
- When `recording` is true AND the sequencer is running (host playing, or RUN on), every live hit (MIDI,
  pad click, computer key) is written into steps[track][step]: value 2 (accent) if velocity ≥ 0.85, else 1.
- quantize on: nearest 16th (with swing taken into account roughly). If it rounds forward to a step that
  hasn't played yet, that step must not re-trigger this pass (no double hit).
- quantize off: the step whose window the hit falls in (floor).
- Sounds still play immediately when the hit happens.
- When the sequencer isn't running, hits just play (nothing recorded).

### State
Save/restore: params, pattern, sound IDs per track (not file paths only), learned notes, user folders are
global (PropertiesFile), not per project.

## Compile check (both code agents must pass with zero errors before finishing)
```bash
cd /home/claude/ember-synth/drums && mkdir -p /tmp/bd && \
for f in Source/*.cpp; do g++ -std=c++17 -fsyntax-only -Wall -Wextra -I /home/claude/JUCE/modules -I /tmp/bd \
 -I /usr/include/freetype2 -DJUCE_USE_XRANDR=0 -DJUCE_USE_XINERAMA=0 -DJUCE_USE_XSHM=0 -DJUCE_USE_XRENDER=0 \
 -DJUCE_USE_XCURSOR=0 -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 -DJucePlugin_Name='"Pulse 16"' $f && echo "OK $f"; done
```
`/tmp/bd/BinaryData.h` is a stub declaring the four BinaryData symbols (already created by the lead; the real one
is generated by CMake). Include it as `#include "BinaryData.h"`.
Macs use clang; avoid GCC-only extensions.
