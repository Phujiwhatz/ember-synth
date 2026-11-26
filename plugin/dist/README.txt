EMBER STUDIO — plugin for Logic Pro (AU), other DAWs (VST3), plus a standalone app

INSTALL (easiest)
1. Right-click "Install Ember Studio.command" and choose Open (then Open again if macOS asks).
   It copies the plugins into your Plug-Ins folders and refreshes Logic's plugin list.
2. Open Logic Pro, make a Software Instrument track, and pick
   AU Instruments > Ember Studio > Ember Studio.

INSTALL BY HAND (if the installer won't open)
Open Terminal and run these lines one at a time (drag the files from this folder):
   cp -R "Ember Studio.component" ~/Library/Audio/Plug-Ins/Components/
   xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/Components/"Ember Studio.component"
   killall -9 AudioComponentRegistrar
Then restart Logic.

NOTES
- This build isn't notarised by Apple, which is why macOS needs the quarantine flag removed.
- Your saved patches live in ~/Library/Application Support/Ember Studio/user-patches.json.
- To move patches from the web version: Library > Export there, then Library > Import in the plugin.
- MPE: in Logic, turn on MPE for the track's MIDI input if you want per-note bends and pressure from your ROLI Piano M.
