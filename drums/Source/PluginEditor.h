#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <array>
#include <functional>
#include "PluginProcessor.h"

namespace ui
{
const juce::Colour bg      { 0xff141210 };
const juce::Colour panel   { 0xff221d19 };
const juce::Colour panel2  { 0xff2c2520 };
const juce::Colour accent  { 0xffff7a2f };
const juce::Colour text    { 0xffeae1d8 };
const juce::Colour dim     { 0xff6f655c };
const juce::Colour rec     { 0xffe8392f };
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
    juce::Font getComboBoxFont (juce::ComboBox&) override;
    juce::Font getPopupMenuFont() override;
};

//==============================================================================
/** Round red record button. */
class RecButton : public juce::Button
{
public:
    RecButton() : juce::Button ("REC") {}
    void paintButton (juce::Graphics&, bool highlighted, bool down) override;
};

//==============================================================================
class PadComponent : public juce::Component,
                     public juce::SettableTooltipClient
{
public:
    std::function<void (float velocity)> onHit;
    std::function<void()> onMenu;
    juce::String name, keyLabel;
    float flash = 0.0f;
    bool selected = false, learning = false, blinkOn = false;

    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;
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
/** Generic list model driven by lambdas (used for the category and sound lists). */
class LambdaListModel : public juce::ListBoxModel
{
public:
    std::function<int()> getNumRowsFn;
    std::function<void (int, juce::Graphics&, int, int, bool)> paintFn;
    std::function<void (int)> clickedFn, doubleClickedFn, returnFn, selectionFn;
    std::function<juce::var (int)> dragFn;
    std::function<juce::String (int)> tooltipFn;

    int getNumRows() override { return getNumRowsFn ? getNumRowsFn() : 0; }
    void paintListBoxItem (int row, juce::Graphics& g, int w, int h, bool sel) override
    {
        if (paintFn) paintFn (row, g, w, h, sel);
    }
    void listBoxItemClicked (int row, const juce::MouseEvent&) override       { if (clickedFn) clickedFn (row); }
    void listBoxItemDoubleClicked (int row, const juce::MouseEvent&) override { if (doubleClickedFn) doubleClickedFn (row); }
    void returnKeyPressed (int row) override                                   { if (returnFn) returnFn (row); }
    void selectedRowsChanged (int row) override                                { if (selectionFn) selectionFn (row); }
    juce::var getDragSourceDescription (const juce::SparseSet<int>& rows) override
    {
        return (dragFn && rows.size() > 0) ? dragFn (rows[0]) : juce::var();
    }
    juce::String getTooltipForRow (int row) override { return tooltipFn ? tooltipFn (row) : juce::String(); }
};

//==============================================================================
class Pulse16AudioProcessorEditor : public juce::AudioProcessorEditor,
                                    public juce::FileDragAndDropTarget,
                                    public juce::DragAndDropContainer,
                                    public juce::DragAndDropTarget,
                                    private juce::Timer
{
public:
    explicit Pulse16AudioProcessorEditor (Pulse16AudioProcessor&);
    ~Pulse16AudioProcessorEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

    // Focus + computer keyboard
    void mouseDown (const juce::MouseEvent&) override;
    bool keyPressed (const juce::KeyPress&) override;
    bool keyStateChanged (bool isKeyDown) override;

    // Audio files dragged in from Finder
    bool isInterestedInFileDrag (const juce::StringArray& files) override;
    void fileDragMove (const juce::StringArray&, int x, int y) override;
    void fileDragExit (const juce::StringArray&) override;
    void filesDropped (const juce::StringArray& files, int x, int y) override;

    // Sounds dragged from the library list
    bool isInterestedInDragSource (const SourceDetails&) override;
    void itemDragMove (const SourceDetails&) override;
    void itemDragExit (const SourceDetails&) override;
    void itemDropped (const SourceDetails&) override;

private:
    using SliderAttachment   = juce::AudioProcessorValueTreeState::SliderAttachment;
    using ButtonAttachment   = juce::AudioProcessorValueTreeState::ButtonAttachment;
    using ComboBoxAttachment = juce::AudioProcessorValueTreeState::ComboBoxAttachment;

    // ---- Layout constants (see the layout comment block in PluginEditor.cpp) ----
    static constexpr int kWidth = 1440, kHeight = 640;
    static constexpr int kHeaderH = 84;
    static constexpr int kRowsTop = 118, kRowH = 56;
    static constexpr int kPadX = 16, kPadW = 92;
    static constexpr int kSoundX = 114, kSoundW = 150;
    static constexpr int kSynthX = 268, kSynthW = 26;
    static constexpr int kSmpX = 298, kSmpW = 44;
    static constexpr int kKnobX = 350, kKnobW = 46;
    static constexpr int kGridX = 590;
    static constexpr int kLibX = 1110;                 // library panel left edge
    static constexpr int kMainRight = kLibX - 10;      // right edge of the track area
    static constexpr int kFooterH = 30;
    static constexpr int kNumKnobs = 5;

    void timerCallback() override;
    void setupKnob (juce::Slider&, const juce::String& paramID, bool bipolar);
    int rowAt (juce::Point<int> editorPos) const;

    // Track / library actions
    void selectTrack (int track);
    void focusLibrary (const juce::String& hint);
    void showHint (const juce::String& message, bool important = false);
    void assignSound (int track, const juce::String& soundId);
    void previewEntry (int index);
    void assignEntry (int index);
    void refreshCategories();
    void refreshSounds();
    void addFolder();
    void browseFiles (int track);
    void showPadMenu (int track);
    void hitPad (int track, float velocity);

    Pulse16AudioProcessor& proc;
    EmberLookAndFeel laf;
    juce::TooltipWindow tooltipWindow { this, 600 };

    // Header
    juce::TextButton runButton { "RUN" }, clearButton { "CLEAR" }, quantizeButton { "QUANTIZE" };
    RecButton recButton;
    juce::ComboBox kitBox, keymapBox;
    std::unique_ptr<ButtonAttachment> runAttachment, quantizeAttachment;
    std::unique_ptr<ComboBoxAttachment> keymapAttachment;
    juce::Slider globalKnobs[kNumKnobs];
    std::unique_ptr<SliderAttachment> globalAttachments[kNumKnobs];

    // Track rows
    struct Row
    {
        PadComponent pad;
        juce::TextButton soundButton, synthButton, modeButton { "SMP" };
        juce::String shownName, shownTip;
        juce::Slider knobs[kNumKnobs];
        std::unique_ptr<SliderAttachment> knobAttachments[kNumKnobs];
        std::unique_ptr<ButtonAttachment> modeAttachment;
    };
    std::array<Row, drums::kNumTracks> rows;
    StepGrid grid;
    juce::Label hintLabel;

    // Library panel
    juce::TextEditor searchBox;
    LambdaListModel categoryModel, soundModel;
    juce::ListBox categoryList { "Categories", nullptr }, soundList { "Sounds", nullptr };
    juce::TextButton assignButton { "Assign" }, addFolderButton, openFolderButton { "Open Folder" },
                     rescanButton { "Rescan" }, browseButton;
    juce::StringArray categories;            // "All" + library categories
    juce::Array<LibraryEntry> visible;       // filtered sounds shown in soundList
    juce::String currentCategory { "All" };

    std::unique_ptr<juce::FileChooser> chooser;
    int selectedTrack = 0;
    int dragRow = -1;
    bool keyHeld[10] {};                      // A..K (8) + Space + R, for auto-repeat suppression
    float libraryGlow = 0.0f;
    juce::uint32 hintTime = 0;
    juce::String lastPreviewId;
    juce::uint32 lastPreviewTime = 0;
    int blinkCounter = 0;
    bool focusedOnce = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Pulse16AudioProcessorEditor)
};
