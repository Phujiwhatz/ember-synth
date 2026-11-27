#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <array>
#include "PluginProcessor.h"

namespace ui
{
const juce::Colour bg      { 0xff141210 };
const juce::Colour panel   { 0xff221d19 };
const juce::Colour panel2  { 0xff2c2520 };
const juce::Colour accent  { 0xffff7a2f };
const juce::Colour text    { 0xffeae1d8 };
const juce::Colour dim     { 0xff6f655c };
}

//==============================================================================
class EmberLookAndFeel : public juce::LookAndFeel_V4
{
public:
    EmberLookAndFeel();
    void drawRotarySlider (juce::Graphics&, int x, int y, int w, int h, float pos,
                           float startAngle, float endAngle, juce::Slider&) override;
    void drawButtonBackground (juce::Graphics&, juce::Button&, const juce::Colour&,
                               bool highlighted, bool down) override;
    juce::Font getTextButtonFont (juce::TextButton&, int buttonHeight) override;
};

//==============================================================================
class PadComponent : public juce::Component
{
public:
    std::function<void()> onHit;
    juce::String name;
    float flash = 0.0f;

    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override { if (onHit) onHit(); }
};

//==============================================================================
class StepGrid : public juce::Component
{
public:
    explicit StepGrid (Pulse16AudioProcessor& p) : proc (p) {}
    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;
    void mouseDrag (const juce::MouseEvent&) override;

private:
    bool cellAt (juce::Point<int> pos, int& row, int& col) const;
    Pulse16AudioProcessor& proc;
    int paintValue = 0, lastRow = -1, lastCol = -1;
};

//==============================================================================
class Pulse16AudioProcessorEditor : public juce::AudioProcessorEditor,
                                    public juce::FileDragAndDropTarget,
                                    private juce::Timer
{
public:
    explicit Pulse16AudioProcessorEditor (Pulse16AudioProcessor&);
    ~Pulse16AudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

    bool isInterestedInFileDrag (const juce::StringArray& files) override;
    void fileDragMove (const juce::StringArray&, int x, int y) override;
    void fileDragExit (const juce::StringArray&) override;
    void filesDropped (const juce::StringArray& files, int x, int y) override;

private:
    using SliderAttachment = juce::AudioProcessorValueTreeState::SliderAttachment;
    using ButtonAttachment = juce::AudioProcessorValueTreeState::ButtonAttachment;

    static constexpr int kWidth = 1180, kHeight = 572;
    static constexpr int kRowsTop = 112, kRowH = 52;
    static constexpr int kKnobX = 320, kKnobW = 44, kGridX = 548;
    static constexpr int kNumKnobs = 5;

    void timerCallback() override;
    void setupKnob (juce::Slider&, const juce::String& paramID, bool bipolar);
    void openSampleChooser (int track);
    int rowAt (int y) const;

    Pulse16AudioProcessor& proc;
    EmberLookAndFeel laf;
    juce::TooltipWindow tooltipWindow { this, 600 };

    juce::TextButton runButton { "RUN" }, clearButton { "CLEAR" };
    std::unique_ptr<ButtonAttachment> runAttachment;

    juce::Slider globalKnobs[kNumKnobs];
    std::unique_ptr<SliderAttachment> globalAttachments[kNumKnobs];

    struct Row
    {
        PadComponent pad;
        juce::TextButton modeButton { "SMP" }, loadButton { "LOAD" };
        juce::Label sampleLabel;
        juce::String shownName;
        juce::Slider knobs[kNumKnobs];
        std::unique_ptr<SliderAttachment> knobAttachments[kNumKnobs];
        std::unique_ptr<ButtonAttachment> modeAttachment;
    };
    std::array<Row, drums::kNumTracks> rows;

    StepGrid grid;
    std::unique_ptr<juce::FileChooser> chooser;
    int dragRow = -1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Pulse16AudioProcessorEditor)
};
