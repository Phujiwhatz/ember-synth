#pragma once
#include <juce_core/juce_core.h>
namespace ember
{
// Returns true when the list of active MIDI inputs changed (names in enabledNames).
bool updateStandaloneMidi (juce::StringArray& seen, juce::StringArray& enabledNames);
}
