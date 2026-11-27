PULSE 16 — drum machine for Logic Pro (AU), other DAWs (VST3), plus a standalone app

INSTALL (easiest)
1. Right-click "Install Pulse 16.command" and choose Open (then Open again if macOS asks).
   It copies the plugins into your Plug-Ins folders and refreshes Logic's plugin list.
2. Quit and reopen Logic Pro, make a Software Instrument track, and pick
   AU Instruments > Ember Studio > Pulse 16.

INSTALL BY HAND (if the installer won't open)
Open Terminal and run these lines one at a time (drag the files from this folder):
   cp -R "Pulse 16.component" ~/Library/Audio/Plug-Ins/Components/
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/Components/"Pulse 16.component"
   killall -9 AudioComponentRegistrar
Then restart Logic.

SOUNDS
- KIT menu (top left): load one of 8 ready-made kits (808, 909, Trap, Lo-Fi, Techno...).
- SOUND LIBRARY (right side): 100 built-in drum sounds.
    Click a sound = preview it.  Double-click (or Assign, or drag it onto a row) = load it
    into the selected track. Click a track's name/sound button to select that track.
- The x button next to a sound switches that track back to its synth drum.
- MORE SOUNDS: drop .wav / .aif / .mp3 / .flac files into  Music > Pulse 16 Library
  (Open Folder takes you there), then press Rescan. Add Folder... adds any other folder,
  e.g. a sample pack you downloaded. You can also drag audio files from Finder onto a row.

PLAY
- MIDI keyboard: in every octave, C C# D D# E F F# G play tracks 1-8.
  (Switch MIDI KEYMAP to "GM drums" to use Logic's standard drum notes instead.)
- Computer keyboard: A S D F G H J K play tracks 1-8. Space = Run, R = Rec.
  Click once on the plugin window first so it receives the keys.
- Click the pads with the mouse.
- MIDI learn: right-click a pad > MIDI Learn, then press any key on your keyboard.

RECORD
- Recording your playing as MIDI in Logic works like any instrument: arm the track and record.
- To record into Pulse 16's own step pattern: turn on REC, start Logic playing (or press RUN),
  and play. Hits snap to the nearest 16th when QUANTIZE is on. Hard hits become accents.

STEP GRID
- Click a step: off > on > accent. Right-click toggles accent. Drag to paint.
- Knobs: Level, Tune, Decay, Tone, Pan (double-click resets). SWING, ACCENT, DRIVE, MASTER up top.

NOTES
- This build isn't notarised by Apple, which is why macOS needs the quarantine flag removed.
- Your pattern, sounds and learned keys are saved with your Logic project.
