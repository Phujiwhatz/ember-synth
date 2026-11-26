#!/bin/bash
# Installs the Ember Studio AU and VST3 plugins for the current user, then refreshes Logic's plugin list.
cd "$(dirname "$0")"
echo "Installing Ember Studio..."
mkdir -p "$HOME/Library/Audio/Plug-Ins/Components" "$HOME/Library/Audio/Plug-Ins/VST3"
rm -rf "$HOME/Library/Audio/Plug-Ins/Components/Ember Studio.component" "$HOME/Library/Audio/Plug-Ins/VST3/Ember Studio.vst3"
cp -R "Ember Studio.component" "$HOME/Library/Audio/Plug-Ins/Components/"
cp -R "Ember Studio.vst3" "$HOME/Library/Audio/Plug-Ins/VST3/"
xattr -dr com.apple.quarantine "$HOME/Library/Audio/Plug-Ins/Components/Ember Studio.component" 2>/dev/null
xattr -dr com.apple.quarantine "$HOME/Library/Audio/Plug-Ins/VST3/Ember Studio.vst3" 2>/dev/null
[ -d "Ember Studio.app" ] && xattr -dr com.apple.quarantine "Ember Studio.app" 2>/dev/null
killall -9 AudioComponentRegistrar 2>/dev/null
echo ""
echo "Done! Open Logic Pro, make a Software Instrument track, and choose"
echo "  AU Instruments > Ember Studio > Ember Studio"
echo "If Logic was already open, quit and reopen it."
read -n 1 -s -r -p "Press any key to close."
