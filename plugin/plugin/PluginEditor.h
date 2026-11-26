#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include "PluginProcessor.h"

class EmberEditor : public juce::AudioProcessorEditor, private juce::Timer
{
public:
    explicit EmberEditor (EmberProcessor&);
    ~EmberEditor() override = default;
    void resized() override;
    void paint (juce::Graphics& g) override { g.fillAll (juce::Colour (0xff121110)); }

private:
    void timerCallback() override;
    void sendInit();
    std::optional<juce::WebBrowserComponent::Resource> getResource (const juce::String& url);
    juce::WebBrowserComponent::Options makeOptions();

    EmberProcessor& proc;
    juce::WebBrowserComponent web;
    bool ready = false;
    int seenVersion = 0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EmberEditor)
};
