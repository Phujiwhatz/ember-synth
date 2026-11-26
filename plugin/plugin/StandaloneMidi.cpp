// Standalone app only: switch on every connected MIDI keyboard automatically
// (JUCE's standalone wrapper leaves them all off on macOS until you tick them in Options).
#include <juce_audio_utils/juce_audio_utils.h>
#include "StandaloneMidi.h"

#if JucePlugin_Build_Standalone
 #include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#endif

namespace ember
{
bool updateStandaloneMidi (juce::StringArray& seen, juce::StringArray& enabledNames)
{
   #if JucePlugin_Build_Standalone
    auto* holder = juce::StandalonePluginHolder::getInstance();
    if (holder == nullptr)
        return false;

    auto& dm = holder->deviceManager;
    const auto devices = juce::MidiInput::getAvailableDevices();
    juce::StringArray now, names;

    for (auto& d : devices)
    {
        now.add (d.identifier);
        if (! seen.contains (d.identifier))          // new since last check: turn it on once
            dm.setMidiInputDeviceEnabled (d.identifier, true);
        if (dm.isMidiInputDeviceEnabled (d.identifier))
            names.add (d.name);
    }

    seen = now;   // unplugged devices are forgotten, so re-plugging turns them back on
    if (names == enabledNames)
        return false;
    enabledNames = names;
    return true;
   #else
    juce::ignoreUnused (seen, enabledNames);
    return false;
   #endif
}
}
