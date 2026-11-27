PULSE 16 — drum machine for Logic Pro (AU), other DAWs (VST3), plus a standalone app

INSTALL (easiest)
1. Right-click "Install Pulse 16.command" and choose Open (then Open again if macOS asks).
   It copies the plugins into your Plug-Ins folders and refreshes Logic's plugin list.
2. Open Logic Pro, make a Software Instrument track, and pick
   AU Instruments > Ember Studio > Pulse 16.
3. Press play in Logic — the pattern runs in sync with Logic's tempo.

INSTALL BY HAND (if the installer won't open)
Open Terminal and run these lines one at a time (drag the files from this folder):
   cp -R "Pulse 16.component" ~/Library/Audio/Plug-Ins/Components/
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/Components/"Pulse 16.component"
   killall -9 AudioComponentRegistrar
Then restart Logic.

USING IT
- Click a pad (KICK, SNARE...) to hear it.
- SMP switches a track between synth drum and sample. LOAD picks a sample, or drag an audio
  file from Finder straight onto a row.
- Steps: click = off > on > accent. Right-click toggles accent. Drag to paint.
- Knobs: Level, Tune, Decay, Tone, Pan. Double-click resets.
- RUN plays the pattern while Logic is stopped (uses the TEMPO knob).
- MIDI: General MIDI drum notes (C1 kick, D1 snare, D#1 clap, F#1 closed hat, A#1 open hat,
  A1 low tom, D2 high tom, G#2 cowbell), or C3-G3 for tracks 1-8.

NOTES
- This build isn't notarised by Apple, which is why macOS needs the quarantine flag removed.
- Sample file locations are saved with your Logic project; if you move a sample, that track
  falls back to its synth sound.
