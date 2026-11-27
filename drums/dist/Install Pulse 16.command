#!/bin/bash
# Installs the Pulse 16 AU and VST3 plugins for the current user, then refreshes Logic's plugin list.
cd "$(dirname "$0")"
echo "Installing Pulse 16..."
mkdir -p "$HOME/Library/Audio/Plug-Ins/Components" "$HOME/Library/Audio/Plug-Ins/VST3"
rm -rf "$HOME/Library/Audio/Plug-Ins/Components/Pulse 16.component" "$HOME/Library/Audio/Plug-Ins/VST3/Pulse 16.vst3"
cp -R "Pulse 16.component" "$HOME/Library/Audio/Plug-Ins/Components/"
cp -R "Pulse 16.vst3" "$HOME/Library/Audio/Plug-Ins/VST3/"
xattr -dr com.apple.quarantine "$HOME/Library/Audio/Plug-Ins/Components/Pulse 16.component" 2>/dev/null
xattr -dr com.apple.quarantine "$HOME/Library/Audio/Plug-Ins/VST3/Pulse 16.vst3" 2>/dev/null
[ -d "Pulse 16.app" ] && xattr -dr com.apple.quarantine "Pulse 16.app" 2>/dev/null
killall -9 AudioComponentRegistrar 2>/dev/null
echo ""
echo "Done! Open Logic Pro, make a Software Instrument track, and choose"
echo "  AU Instruments > Ember Studio > Pulse 16"
echo "If Logic was already open, quit and reopen it."
read -n 1 -s -r -p "Press any key to close."
