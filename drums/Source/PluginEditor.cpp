#include "PluginEditor.h"

namespace
{
const char* globalIds[]    = { "tempo", "swing", "accent", "drive", "master" };
const char* globalNames[]  = { "TEMPO", "SWING", "ACCENT", "DRIVE", "MASTER" };
const char* trackIds[]     = { "level", "tune", "decay", "tone", "pan" };
const char* trackNames[]   = { "LEVEL", "TUNE", "DECAY", "TONE", "PAN" };
}

//==============================================================================
EmberLookAndFeel::EmberLookAndFeel()
{
    setColour (juce::ResizableWindow::backgroundColourId, ui::bg);
    setColour (juce::TextButton::buttonColourId, ui::panel2);
    setColour (juce::TextButton::buttonOnColourId, ui::accent);
    setColour (juce::TextButton::textColourOffId, ui::text);
    setColour (juce::TextButton::textColourOnId, juce::Colours::black);
    setColour (juce::Label::textColourId, ui::text);
    setColour (juce::BubbleComponent::backgroundColourId, ui::panel2);
    setColour (juce::BubbleComponent::outlineColourId, ui::accent);
    setColour (juce::TooltipWindow::textColourId, ui::text);
    setColour (juce::Slider::textBoxTextColourId, ui::text);
}

void EmberLookAndFeel::drawRotarySlider (juce::Graphics& g, int x, int y, int w, int h, float pos,
                                         float startAngle, float endAngle, juce::Slider& slider)
{
    const auto bounds = juce::Rectangle<int> (x, y, w, h).toFloat().reduced (3.0f);
    const float radius = juce::jmin (bounds.getWidth(), bounds.getHeight()) * 0.5f;
    const auto centre = bounds.getCentre();
    const float lw = 3.0f, arcR = radius - lw * 0.5f;
    const float angle = startAngle + pos * (endAngle - startAngle);
    const bool bipolar = (bool) slider.getProperties()["bipolar"];
    const float fromAngle = bipolar ? (startAngle + endAngle) * 0.5f : startAngle;

    g.setColour (ui::panel2.brighter (0.15f));
    g.fillEllipse (bounds.reduced (lw + 2.0f));

    juce::Path track;
    track.addCentredArc (centre.x, centre.y, arcR, arcR, 0.0f, startAngle, endAngle, true);
    g.setColour (ui::dim.withAlpha (0.5f));
    g.strokePath (track, juce::PathStrokeType (lw, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));

    if (std::abs (angle - fromAngle) > 0.01f)
    {
        juce::Path value;
        value.addCentredArc (centre.x, centre.y, arcR, arcR, 0.0f,
                             juce::jmin (fromAngle, angle), juce::jmax (fromAngle, angle), true);
        g.setColour (ui::accent);
        g.strokePath (value, juce::PathStrokeType (lw, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));
    }

    const auto tip  = centre.getPointOnCircumference (radius - lw - 4.0f, angle);
    const auto root = centre.getPointOnCircumference (radius * 0.2f, angle);
    g.setColour (ui::text);
    g.drawLine ({ root, tip }, 2.0f);
}

void EmberLookAndFeel::drawButtonBackground (juce::Graphics& g, juce::Button& b, const juce::Colour&,
                                             bool highlighted, bool down)
{
    auto r = b.getLocalBounds().toFloat().reduced (1.0f);
    auto c = b.getToggleState() ? ui::accent : ui::panel2;
    if (highlighted) c = c.brighter (0.12f);
    if (down)        c = c.darker (0.2f);
    g.setColour (c);
    g.fillRoundedRectangle (r, 5.0f);
}

juce::Font EmberLookAndFeel::getTextButtonFont (juce::TextButton&, int buttonHeight)
{
    return juce::Font (juce::FontOptions (juce::jmin (13.0f, buttonHeight * 0.5f), juce::Font::bold));
}

//==============================================================================
void PadComponent::paint (juce::Graphics& g)
{
    auto r = getLocalBounds().toFloat().reduced (2.0f);
    g.setColour (ui::panel2.interpolatedWith (ui::accent, juce::jlimit (0.0f, 1.0f, flash)));
    g.fillRoundedRectangle (r, 6.0f);
    g.setColour (flash > 0.5f ? juce::Colours::black : ui::text);
    g.setFont (juce::Font (juce::FontOptions (13.0f, juce::Font::bold)));
    g.drawText (name, r, juce::Justification::centred);
}

//==============================================================================
bool StepGrid::cellAt (juce::Point<int> pos, int& row, int& col) const
{
    if (! getLocalBounds().contains (pos)) return false;
    row = pos.y * drums::kNumTracks / getHeight();
    col = pos.x * drums::kNumSteps / getWidth();
    return row >= 0 && row < drums::kNumTracks && col >= 0 && col < drums::kNumSteps;
}

void StepGrid::paint (juce::Graphics& g)
{
    const float rowH = getHeight() / (float) drums::kNumTracks;
    const float colW = getWidth()  / (float) drums::kNumSteps;
    const int playing = proc.currentStep.load();

    for (int r = 0; r < drums::kNumTracks; ++r)
    {
        for (int c = 0; c < drums::kNumSteps; ++c)
        {
            auto cell = juce::Rectangle<float> (c * colW, r * rowH, colW, rowH).reduced (2.5f, 7.0f);
            const int s = proc.steps[r][c].load();
            const bool beatGroup = (c / 4) % 2 == 0;

            juce::Colour col = beatGroup ? ui::panel2 : ui::panel2.darker (0.25f);
            if (s == 1) col = ui::accent.withAlpha (0.6f);
            if (s == 2) col = ui::accent;
            if (c == playing) col = col.brighter (s ? 0.35f : 0.5f);

            g.setColour (col);
            g.fillRoundedRectangle (cell, 4.0f);

            if (s == 2)
            {
                g.setColour (juce::Colours::white.withAlpha (0.9f));
                g.fillEllipse (cell.withSizeKeepingCentre (6.0f, 6.0f));
            }
        }
    }
}

void StepGrid::mouseDown (const juce::MouseEvent& e)
{
    int r, c;
    if (! cellAt (e.getPosition(), r, c)) return;
    const int current = proc.steps[r][c].load();
    // Click cycles off -> on -> accent -> off. Right/ctrl-click toggles accent directly.
    if (e.mods.isPopupMenu())
        paintValue = current == 2 ? 1 : 2;
    else
        paintValue = (current + 1) % 3;
    proc.steps[r][c].store ((uint8_t) paintValue);
    lastRow = r; lastCol = c;
    repaint();
}

void StepGrid::mouseDrag (const juce::MouseEvent& e)
{
    int r, c;
    if (! cellAt (e.getPosition(), r, c) || (r == lastRow && c == lastCol)) return;
    proc.steps[r][c].store ((uint8_t) paintValue);
    lastRow = r; lastCol = c;
    repaint();
}

//==============================================================================
Pulse16AudioProcessorEditor::Pulse16AudioProcessorEditor (Pulse16AudioProcessor& p)
    : AudioProcessorEditor (&p), proc (p), grid (p)
{
    setLookAndFeel (&laf);

    runButton.setClickingTogglesState (true);
    runButton.setTooltip ("Play the pattern when Logic is stopped (uses the Tempo knob)");
    addAndMakeVisible (runButton);
    runAttachment = std::make_unique<ButtonAttachment> (proc.apvts, "run", runButton);

    clearButton.onClick = [this] { proc.clearPattern(); grid.repaint(); };
    addAndMakeVisible (clearButton);

    for (int i = 0; i < kNumKnobs; ++i)
    {
        setupKnob (globalKnobs[i], globalIds[i], false);
        globalAttachments[i] = std::make_unique<SliderAttachment> (proc.apvts, globalIds[i], globalKnobs[i]);
    }

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto& row = rows[(size_t) t];

        row.pad.name = drums::trackName (t);
        row.pad.onHit = [this, t] { proc.pendingPads.fetch_or (1u << t); };
        addAndMakeVisible (row.pad);

        row.modeButton.setClickingTogglesState (true);
        row.modeButton.setTooltip ("Sample mode (off = synth)");
        addAndMakeVisible (row.modeButton);
        row.modeAttachment = std::make_unique<ButtonAttachment> (proc.apvts, Pulse16AudioProcessor::paramId ("mode", t), row.modeButton);

        row.loadButton.setTooltip ("Load a sample (or drag an audio file onto this row)");
        row.loadButton.onClick = [this, t] { openSampleChooser (t); };
        addAndMakeVisible (row.loadButton);

        row.sampleLabel.setFont (juce::Font (juce::FontOptions (12.0f)));
        row.sampleLabel.setColour (juce::Label::textColourId, ui::dim.brighter (0.4f));
        row.sampleLabel.setMinimumHorizontalScale (0.6f);
        addAndMakeVisible (row.sampleLabel);

        for (int k = 0; k < kNumKnobs; ++k)
        {
            const auto id = Pulse16AudioProcessor::paramId (trackIds[k], t);
            setupKnob (row.knobs[k], id, k == 1 || k == 4);
            row.knobAttachments[k] = std::make_unique<SliderAttachment> (proc.apvts, id, row.knobs[k]);
        }
    }

    addAndMakeVisible (grid);
    setSize (kWidth, kHeight);
    startTimerHz (30);
}

Pulse16AudioProcessorEditor::~Pulse16AudioProcessorEditor()
{
    stopTimer();
    setLookAndFeel (nullptr);
}

void Pulse16AudioProcessorEditor::setupKnob (juce::Slider& s, const juce::String& paramID, bool bipolar)
{
    s.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    s.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
    s.setPopupDisplayEnabled (true, true, this);
    s.getProperties().set ("bipolar", bipolar);
    if (auto* param = proc.apvts.getParameter (paramID))
        s.setDoubleClickReturnValue (true, param->convertFrom0to1 (param->getDefaultValue()));
    addAndMakeVisible (s);
}

void Pulse16AudioProcessorEditor::openSampleChooser (int track)
{
    chooser = std::make_unique<juce::FileChooser> ("Load sample for " + juce::String (drums::trackName (track)),
                                                   juce::File(), "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.ogg;*.m4a;*.caf");
    chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                          [this, track] (const juce::FileChooser& fc)
                          {
                              const auto file = fc.getResult();
                              if (file.existsAsFile() && ! proc.loadSample (track, file))
                                  rows[(size_t) track].sampleLabel.setText ("can't read file", juce::dontSendNotification);
                          });
}

void Pulse16AudioProcessorEditor::timerCallback()
{
    grid.repaint();

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto& row = rows[(size_t) t];
        const float hit = proc.hitFlash[t].exchange (0.0f);
        const float f = juce::jmax (row.pad.flash * 0.8f, hit);
        if (std::abs (f - row.pad.flash) > 0.003f)
        {
            row.pad.flash = f < 0.01f ? 0.0f : f;
            row.pad.repaint();
        }

        auto name = proc.getSampleName (t);
        if (name.isEmpty()) name = "synth";
        if (name != row.shownName)
        {
            row.shownName = name;
            row.sampleLabel.setText (name, juce::dontSendNotification);
        }
    }
}

//==============================================================================
void Pulse16AudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (ui::bg);

    // Header
    g.setColour (ui::panel);
    g.fillRect (0, 0, getWidth(), 84);
    g.setColour (ui::accent);
    g.setFont (juce::Font (juce::FontOptions (30.0f, juce::Font::bold)));
    g.drawText (juce::String::fromUTF8 ("PULSE\xc2\xb7" "16"), 20, 14, 220, 36, juce::Justification::centredLeft);
    g.setColour (ui::dim.brighter (0.3f));
    g.setFont (juce::Font (juce::FontOptions (12.0f)));
    g.drawText ("synth + sample drum machine", 22, 50, 240, 18, juce::Justification::centredLeft);

    g.setFont (juce::Font (juce::FontOptions (11.0f, juce::Font::bold)));
    for (int i = 0; i < kNumKnobs; ++i)
    {
        const auto b = globalKnobs[i].getBounds();
        g.drawText (globalNames[i], b.getX() - 10, b.getBottom(), b.getWidth() + 20, 14, juce::Justification::centred);
    }

    // Column headers
    g.setColour (ui::dim.brighter (0.2f));
    const int hy = kRowsTop - 20;
    g.drawText ("SOUND", 18, hy, 100, 16, juce::Justification::centredLeft);
    g.drawText ("SOURCE", 112, hy, 100, 16, juce::Justification::centredLeft);
    for (int k = 0; k < kNumKnobs; ++k)
        g.drawText (trackNames[k], kKnobX + k * kKnobW - 4, hy, kKnobW + 8, 16, juce::Justification::centred);

    const float colW = grid.getWidth() / (float) drums::kNumSteps;
    for (int s = 0; s < drums::kNumSteps; ++s)
    {
        g.setColour (s % 4 == 0 ? ui::text : ui::dim);
        g.drawText (juce::String (s + 1), (int) (kGridX + s * colW), hy, (int) colW, 16, juce::Justification::centred);
    }

    // Row backgrounds
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto r = juce::Rectangle<int> (10, kRowsTop + t * kRowH, getWidth() - 20, kRowH).reduced (0, 2);
        g.setColour (t == dragRow ? ui::accent.withAlpha (0.25f) : (t % 2 ? ui::panel.darker (0.2f) : ui::panel));
        g.fillRoundedRectangle (r.toFloat(), 6.0f);
    }

    // Footer hint
    g.setColour (ui::dim.brighter (0.2f));
    g.setFont (juce::Font (juce::FontOptions (12.0f)));
    g.drawText ("Click steps: off > on > accent (right-click = accent)  |  Drag audio files onto a row  |  "
                "MIDI: GM drum map (C1 = kick) or C3-G3 = tracks 1-8  |  Double-click a knob to reset",
                16, getHeight() - 30, getWidth() - 32, 20, juce::Justification::centredLeft);
}

void Pulse16AudioProcessorEditor::resized()
{
    runButton.setBounds (290, 26, 72, 32);
    clearButton.setBounds (372, 26, 72, 32);

    for (int i = 0; i < kNumKnobs; ++i)
        globalKnobs[i].setBounds (760 + i * 82, 10, 52, 52);

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto& row = rows[(size_t) t];
        const int y = kRowsTop + t * kRowH;
        row.pad.setBounds (16, y + 6, 90, kRowH - 12);
        row.modeButton.setBounds (112, y + 12, 44, kRowH - 24);
        row.loadButton.setBounds (160, y + 12, 50, kRowH - 24);
        row.sampleLabel.setBounds (214, y + 6, 102, kRowH - 12);
        for (int k = 0; k < kNumKnobs; ++k)
            row.knobs[k].setBounds (kKnobX + k * kKnobW, y + 4, kKnobW, kRowH - 8);
    }

    grid.setBounds (kGridX, kRowsTop, getWidth() - kGridX - 14, kRowH * drums::kNumTracks);
}

//==============================================================================
int Pulse16AudioProcessorEditor::rowAt (int y) const
{
    const int r = (y - kRowsTop) / kRowH;
    return (y >= kRowsTop && r < drums::kNumTracks) ? r : -1;
}

bool Pulse16AudioProcessorEditor::isInterestedInFileDrag (const juce::StringArray& files)
{
    for (const auto& f : files)
        if (Pulse16AudioProcessor::isAudioFile (f))
            return true;
    return false;
}

void Pulse16AudioProcessorEditor::fileDragMove (const juce::StringArray&, int, int y)
{
    const int r = rowAt (y);
    if (r != dragRow) { dragRow = r; repaint(); }
}

void Pulse16AudioProcessorEditor::fileDragExit (const juce::StringArray&)
{
    dragRow = -1;
    repaint();
}

void Pulse16AudioProcessorEditor::filesDropped (const juce::StringArray& files, int, int y)
{
    dragRow = -1;
    const int r = rowAt (y);
    if (r >= 0)
        for (const auto& f : files)
            if (Pulse16AudioProcessor::isAudioFile (f))
            {
                if (! proc.loadSample (r, juce::File (f)))
                    rows[(size_t) r].sampleLabel.setText ("can't read file", juce::dontSendNotification);
                break;
            }
    repaint();
}
