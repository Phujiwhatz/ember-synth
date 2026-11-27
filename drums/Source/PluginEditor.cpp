#include "PluginEditor.h"

/*  ============================ LAYOUT (1440 x 640) ============================
    All numbers are editor pixels. Nothing overlaps; gaps are >= 4 px.

    HEADER  y 0..84 (panel colour)
      x  20..200   logo "PULSE·16" + subtitle
      x 214..384   KIT combo        (label y 12..28, combo y 32..60)
      x 398..446   REC round button (y 14..74, circle on top, "REC" text below)
      x 458..526   RUN               (y 32..60)
      x 534..602   CLEAR             (y 32..60)
      x 614..710   QUANTIZE          (y 32..60)
      x 722..872   KEYMAP combo      (label y 12..28, combo y 32..60)
      x 1070..1430 5 global knobs, 72 px pitch, 52 px knob (y 8..60), label y 60..74
                   TEMPO SWING ACCENT DRIVE MASTER

    TRACK AREA  x 10..1100 (kMainRight), column labels y 96..114
      rows: y = kRowsTop(118) + t * kRowH(56), t = 0..7  -> rows end at y 566
      x  16..108   pad (92 wide, y+5..y+51)
      x 114..264   sound-name button (y+14..y+42)
      x 268..294   "~" back-to-synth button
      x 298..342   SMP toggle
      x 350..580   5 knobs x 46: LEVEL TUNE DECAY TONE PAN (y+4..y+52)
      x 590..1096  16-step grid (31.6 px / step), same row pitch
    HINT     x 16..1100, y 572..602 (hintLabel)

    LIBRARY PANEL  x 1110..1430, y 94..604
      y 100..118 title, y 118..134 "loads into: <track>"
      y 140..166 search box
      y 172..494 category list x 1120..1214 | sound list x 1220..1420
      y 500..526 Assign (full width)
      y 532..558 Add Folder… | Open Folder
      y 564..590 Rescan      | Browse Files…

    FOOTER   y 610..640 static hint text
    ========================================================================== */

namespace
{
const char* globalIds[]    = { "tempo", "swing", "accent", "drive", "master" };
const char* globalNames[]  = { "TEMPO", "SWING", "ACCENT", "DRIVE", "MASTER" };
const char* trackIds[]     = { "level", "tune", "decay", "tone", "pan" };
const char* trackNames[]   = { "LEVEL", "TUNE", "DECAY", "TONE", "PAN" };
const char  padKeys[]      = { 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K' };
const char* trackCategory[] = { "Kicks", "Snares", "Claps", "Hats", "Hats", "Toms", "Toms", "Percussion" };

constexpr int kLibRight = 1430, kLibTop = 94, kLibBottom = 604;

juce::Font font (float size, bool bold = false)
{
    return juce::Font (juce::FontOptions (size, bold ? juce::Font::bold : juce::Font::plain));
}

bool isSoundId (const juce::String& s)
{
    return s.startsWith ("builtin:") || s.startsWith ("file:");
}

bool isCharDown (char c)
{
    return juce::KeyPress::isKeyCurrentlyDown ((int) c)
        || juce::KeyPress::isKeyCurrentlyDown ((int) juce::CharacterFunctions::toLowerCase ((juce::juce_wchar) c));
}

const char* audioWildcard = "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.ogg;*.m4a;*.caf";
}

//==============================================================================
EmberLookAndFeel::EmberLookAndFeel()
{
    setColour (juce::ResizableWindow::backgroundColourId, ui::bg);
    setColour (juce::DocumentWindow::backgroundColourId, ui::bg);
    setColour (juce::TextButton::buttonColourId, ui::panel2);
    setColour (juce::TextButton::buttonOnColourId, ui::accent);
    setColour (juce::TextButton::textColourOffId, ui::text);
    setColour (juce::TextButton::textColourOnId, juce::Colours::black);
    setColour (juce::Label::textColourId, ui::text);
    setColour (juce::BubbleComponent::backgroundColourId, ui::panel2);
    setColour (juce::BubbleComponent::outlineColourId, ui::accent);
    setColour (juce::TooltipWindow::backgroundColourId, ui::panel2);
    setColour (juce::TooltipWindow::textColourId, ui::text);
    setColour (juce::TooltipWindow::outlineColourId, ui::accent.withAlpha (0.6f));
    setColour (juce::Slider::textBoxTextColourId, ui::text);

    setColour (juce::ComboBox::backgroundColourId, ui::panel2);
    setColour (juce::ComboBox::textColourId, ui::text);
    setColour (juce::ComboBox::outlineColourId, ui::dim.withAlpha (0.5f));
    setColour (juce::ComboBox::arrowColourId, ui::accent);
    setColour (juce::ComboBox::focusedOutlineColourId, ui::accent);

    setColour (juce::PopupMenu::backgroundColourId, ui::panel);
    setColour (juce::PopupMenu::textColourId, ui::text);
    setColour (juce::PopupMenu::headerTextColourId, ui::accent);
    setColour (juce::PopupMenu::highlightedBackgroundColourId, ui::accent);
    setColour (juce::PopupMenu::highlightedTextColourId, juce::Colours::black);

    setColour (juce::ListBox::backgroundColourId, ui::bg);
    setColour (juce::ListBox::outlineColourId, ui::panel2);
    setColour (juce::ListBox::textColourId, ui::text);

    setColour (juce::TextEditor::backgroundColourId, ui::bg);
    setColour (juce::TextEditor::textColourId, ui::text);
    setColour (juce::TextEditor::highlightColourId, ui::accent.withAlpha (0.4f));
    setColour (juce::TextEditor::highlightedTextColourId, ui::text);
    setColour (juce::TextEditor::outlineColourId, ui::panel2.brighter (0.2f));
    setColour (juce::TextEditor::focusedOutlineColourId, ui::accent);
    setColour (juce::CaretComponent::caretColourId, ui::accent);

    setColour (juce::ScrollBar::thumbColourId, ui::dim);
    setColour (juce::AlertWindow::backgroundColourId, ui::panel);
    setColour (juce::AlertWindow::textColourId, ui::text);
    setColour (juce::AlertWindow::outlineColourId, ui::accent);
    setColour (juce::DirectoryContentsDisplayComponent::highlightColourId, ui::accent.withAlpha (0.5f));
    setColour (juce::DirectoryContentsDisplayComponent::textColourId, ui::text);
    setColour (juce::DirectoryContentsDisplayComponent::highlightedTextColourId, ui::text);
    setColour (juce::FileChooserDialogBox::titleTextColourId, ui::text);
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

    g.setColour (ui::panel2.brighter (slider.isMouseOverOrDragging() ? 0.3f : 0.15f));
    g.fillEllipse (juce::Rectangle<float> (radius * 2.0f, radius * 2.0f).withCentre (centre).reduced (lw + 2.0f));

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
    if (! b.isEnabled()) c = c.withAlpha (0.4f);
    if (highlighted) c = c.brighter (0.12f);
    if (down)        c = c.darker (0.2f);
    g.setColour (c);
    g.fillRoundedRectangle (r, 5.0f);
}

juce::Font EmberLookAndFeel::getTextButtonFont (juce::TextButton&, int buttonHeight)
{
    return font (juce::jmin (13.0f, (float) buttonHeight * 0.5f), true);
}

juce::Font EmberLookAndFeel::getComboBoxFont (juce::ComboBox& box)
{
    return font (juce::jmin (14.0f, (float) box.getHeight() * 0.5f));
}

juce::Font EmberLookAndFeel::getPopupMenuFont()
{
    return font (14.0f);
}

//==============================================================================
void RecButton::paintButton (juce::Graphics& g, bool highlighted, bool down)
{
    const bool on = getToggleState();
    auto b = getLocalBounds().toFloat();
    auto circle = b.removeFromTop (b.getHeight() - 16.0f).withSizeKeepingCentre (34.0f, 34.0f);

    g.setColour (on ? ui::rec : ui::panel2.brighter (highlighted ? 0.15f : 0.0f));
    g.fillEllipse (circle);
    g.setColour (ui::rec.withAlpha (on ? 1.0f : 0.8f));
    g.drawEllipse (circle.reduced (1.0f), 2.0f);

    auto dot = circle.withSizeKeepingCentre (12.0f, 12.0f);
    g.setColour (on ? juce::Colours::white : ui::rec);
    g.fillEllipse (down ? dot.reduced (1.0f) : dot);

    g.setColour (on ? ui::rec : ui::text);
    g.setFont (font (11.0f, true));
    g.drawText ("REC", b, juce::Justification::centred);
}

//==============================================================================
void PadComponent::paint (juce::Graphics& g)
{
    auto r = getLocalBounds().toFloat().reduced (2.0f);
    g.setColour (ui::panel2.interpolatedWith (ui::accent, juce::jlimit (0.0f, 1.0f, flash)));
    g.fillRoundedRectangle (r, 6.0f);

    if (learning)
    {
        g.setColour (blinkOn ? ui::accent : ui::text.withAlpha (0.4f));
        g.drawRoundedRectangle (r.reduced (1.0f), 6.0f, 2.5f);
    }
    else if (selected)
    {
        g.setColour (ui::accent);
        g.drawRoundedRectangle (r.reduced (1.0f), 6.0f, 2.0f);
    }

    const bool dark = flash > 0.5f;
    g.setColour (dark ? juce::Colours::black : ui::text);
    g.setFont (font (13.0f, true));
    g.drawText (learning ? juce::String ("LEARN") : name, r.reduced (4.0f, 0.0f), juce::Justification::centred);

    // computer-key letter in the corner
    g.setColour (dark ? juce::Colours::black.withAlpha (0.7f) : ui::dim.brighter (0.3f));
    g.setFont (font (10.0f, true));
    g.drawText (keyLabel, r.reduced (5.0f, 3.0f), juce::Justification::bottomRight);
}

void PadComponent::mouseDown (const juce::MouseEvent& e)
{
    if (e.mods.isPopupMenu())
    {
        if (onMenu) onMenu();
        return;
    }
    if (onHit) onHit (e.mods.isShiftDown() ? 1.0f : 0.8f);
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
    const float rowH = (float) getHeight() / (float) drums::kNumTracks;
    const float colW = (float) getWidth()  / (float) drums::kNumSteps;
    const int playing = proc.currentStep.load();

    for (int r = 0; r < drums::kNumTracks; ++r)
    {
        for (int c = 0; c < drums::kNumSteps; ++c)
        {
            auto cell = juce::Rectangle<float> ((float) c * colW, (float) r * rowH, colW, rowH).reduced (2.5f, 9.0f);
            const int s = proc.steps[r][c].load();
            const bool beatGroup = (c / 4) % 2 == 0;

            juce::Colour col = beatGroup ? ui::panel2.brighter (0.18f) : ui::panel2.brighter (0.06f);
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

    if (playing >= 0 && playing < drums::kNumSteps)
    {
        g.setColour (ui::text.withAlpha (0.12f));
        g.fillRect (juce::Rectangle<float> ((float) playing * colW, 0.0f, colW, (float) getHeight()).reduced (1.0f, 0.0f));
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

    // ---- Header ----
    kitBox.setTextWhenNothingSelected ("Choose a kit...");
    kitBox.addItemList (proc.getKitNames(), 1);
    kitBox.setTooltip ("Load a whole kit: sounds + settings for all 8 tracks");
    kitBox.onChange = [this]
    {
        const int idx = kitBox.getSelectedItemIndex();
        if (idx < 0) return;
        proc.loadKit (idx);
        showHint ("Loaded kit \"" + kitBox.getText() + "\"");
    };
    addAndMakeVisible (kitBox);

    recButton.setClickingTogglesState (true);
    recButton.setTooltip ("Record (R): live hits from MIDI, pads and keys are written into the pattern while it plays");
    recButton.onClick = [this]
    {
        const bool on = recButton.getToggleState();
        proc.recording.store (on);
        showHint (on ? "Recording armed - press RUN (Space) or play in Logic, then play pads/keys/MIDI"
                     : "Recording off", on);
    };
    addAndMakeVisible (recButton);

    runButton.setClickingTogglesState (true);
    runButton.setTooltip ("Run the pattern when Logic is stopped (Space). Uses the TEMPO knob.");
    addAndMakeVisible (runButton);
    runAttachment = std::make_unique<ButtonAttachment> (proc.apvts, "run", runButton);

    clearButton.setTooltip ("Clear the whole pattern");
    clearButton.onClick = [this] { proc.clearPattern(); grid.repaint(); showHint ("Pattern cleared"); };
    addAndMakeVisible (clearButton);

    quantizeButton.setClickingTogglesState (true);
    quantizeButton.setTooltip ("Snap recorded hits to the nearest 16th note");
    addAndMakeVisible (quantizeButton);
    quantizeAttachment = std::make_unique<ButtonAttachment> (proc.apvts, "quantize", quantizeButton);

    keymapBox.addItemList ({ "Every octave", "GM drums" }, 1);
    keymapBox.setTooltip ("MIDI note map. Every octave: C C# D D# E F F# G = tracks 1-8 in every octave.\n"
                          "GM drums: General MIDI drum notes (36 kick, 38 snare...). Right-click a pad to learn a note.");
    addAndMakeVisible (keymapBox);
    keymapAttachment = std::make_unique<ComboBoxAttachment> (proc.apvts, "keymap", keymapBox);

    for (int i = 0; i < kNumKnobs; ++i)
    {
        setupKnob (globalKnobs[i], globalIds[i], false);
        globalAttachments[i] = std::make_unique<SliderAttachment> (proc.apvts, globalIds[i], globalKnobs[i]);
    }

    // ---- Track rows ----
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto& row = rows[(size_t) t];

        row.pad.name = drums::trackName (t);
        row.pad.keyLabel = juce::String::charToString ((juce::juce_wchar) padKeys[t]);
        row.pad.onHit = [this, t] (float v) { selectTrack (t); hitPad (t, v); };
        row.pad.onMenu = [this, t] { selectTrack (t); showPadMenu (t); };
        addAndMakeVisible (row.pad);

        row.soundButton.setButtonText ("Synth");
        row.soundButton.setTooltip ("Click to pick a sound for this track from the library");
        row.soundButton.onClick = [this, t]
        {
            selectTrack (t);
            focusLibrary ("Pick a sound for " + juce::String (drums::trackName (t)) + " from the library  ->");
        };
        addAndMakeVisible (row.soundButton);

        row.synthButton.setButtonText (juce::String::fromUTF8 ("\xc3\x97"));
        row.synthButton.setTooltip ("Back to the built-in synth voice");
        row.synthButton.onClick = [this, t] { assignSound (t, {}); };
        addAndMakeVisible (row.synthButton);

        row.modeButton.setClickingTogglesState (true);
        row.modeButton.setTooltip ("Sample mode on/off (off = synth voice)");
        addAndMakeVisible (row.modeButton);
        row.modeAttachment = std::make_unique<ButtonAttachment> (proc.apvts, Pulse16AudioProcessor::paramId ("mode", t), row.modeButton);
        row.modeButton.onClick = [this, t]
        {
            selectTrack (t);
            if (rows[(size_t) t].modeButton.getToggleState() && proc.getSoundId (t).isEmpty())
            {
                // No sound loaded yet: don't silently fall back to synth - send the user to the library.
                if (auto* param = proc.apvts.getParameter (Pulse16AudioProcessor::paramId ("mode", t)))
                {
                    param->beginChangeGesture();
                    param->setValueNotifyingHost (0.0f);
                    param->endChangeGesture();
                }
                focusLibrary ("Pick a sound from the library  ->  (click to preview, double-click to load into "
                              + juce::String (drums::trackName (t)) + ")");
            }
        };

        for (int k = 0; k < kNumKnobs; ++k)
        {
            const auto id = Pulse16AudioProcessor::paramId (trackIds[k], t);
            setupKnob (row.knobs[k], id, k == 1 || k == 4);
            row.knobAttachments[k] = std::make_unique<SliderAttachment> (proc.apvts, id, row.knobs[k]);
        }
    }

    addAndMakeVisible (grid);

    hintLabel.setFont (font (13.0f, true));
    hintLabel.setJustificationType (juce::Justification::centredRight);
    hintLabel.setInterceptsMouseClicks (false, false);
    addAndMakeVisible (hintLabel);

    // ---- Library panel ----
    searchBox.setTextToShowWhenEmpty ("Search sounds...", ui::dim);
    searchBox.setFont (font (14.0f));
    searchBox.setIndents (8, 5);
    searchBox.onTextChange = [this] { refreshSounds(); };
    searchBox.onEscapeKey  = [this] { searchBox.clear(); refreshSounds(); grabKeyboardFocus(); };
    searchBox.onReturnKey  = [this] { if (! visible.isEmpty()) { soundList.selectRow (0); soundList.grabKeyboardFocus(); } };
    addAndMakeVisible (searchBox);

    categoryModel.getNumRowsFn = [this] { return categories.size(); };
    categoryModel.paintFn = [this] (int r, juce::Graphics& g, int w, int h, bool)
    {
        const bool sel = categories[r] == currentCategory;
        if (sel) { g.setColour (ui::accent.withAlpha (0.25f)); g.fillRect (0, 0, w, h); }
        g.setColour (sel ? ui::accent : ui::text);
        g.setFont (font (13.0f, sel));
        g.drawText (categories[r], 8, 0, w - 10, h, juce::Justification::centredLeft, true);
    };
    categoryModel.clickedFn = [this] (int r)
    {
        if (! juce::isPositiveAndBelow (r, categories.size())) return;
        currentCategory = categories[r];
        categoryList.repaint();
        refreshSounds();
    };
    categoryModel.selectionFn = categoryModel.clickedFn;
    categoryList.setModel (&categoryModel);
    categoryList.setRowHeight (24);
    categoryList.setOutlineThickness (1);
    addAndMakeVisible (categoryList);

    soundModel.getNumRowsFn = [this] { return visible.size(); };
    soundModel.paintFn = [this] (int r, juce::Graphics& g, int w, int h, bool sel)
    {
        if (! juce::isPositiveAndBelow (r, visible.size())) return;
        const auto& e = visible.getReference (r);
        const bool loaded = e.id == proc.getSoundId (selectedTrack);
        if (sel) { g.setColour (ui::accent.withAlpha (0.35f)); g.fillRect (0, 0, w, h); }
        if (loaded) { g.setColour (ui::accent); g.fillEllipse (5.0f, (float) h * 0.5f - 3.0f, 6.0f, 6.0f); }
        g.setColour (ui::text);
        g.setFont (font (13.0f, loaded));
        const int catW = currentCategory == "All" ? 62 : 0;
        g.drawText (e.name, 16, 0, w - 20 - catW, h, juce::Justification::centredLeft, true);
        if (catW > 0)
        {
            g.setColour (e.builtIn ? ui::dim.brighter (0.2f) : ui::accent.withAlpha (0.7f));
            g.setFont (font (10.0f));
            g.drawText (e.category, w - catW - 4, 0, catW, h, juce::Justification::centredRight, true);
        }
    };
    soundModel.clickedFn       = [this] (int r) { previewEntry (r); };
    soundModel.selectionFn     = [this] (int r) { previewEntry (r); };   // arrow keys audition too
    soundModel.doubleClickedFn = [this] (int r) { assignEntry (r); };
    soundModel.returnFn        = [this] (int r) { assignEntry (r); };
    soundModel.dragFn = [this] (int r) -> juce::var
    {
        return juce::isPositiveAndBelow (r, visible.size()) ? juce::var (visible.getReference (r).id) : juce::var();
    };
    soundModel.tooltipFn = [this] (int r) -> juce::String
    {
        if (! juce::isPositiveAndBelow (r, visible.size())) return {};
        const auto& e = visible.getReference (r);
        return e.name + " (" + e.category + (e.builtIn ? ", built-in" : ", " + e.id.fromFirstOccurrenceOf ("file:", false, false))
               + ")\nClick = preview, double-click = load, or drag onto a track row";
    };
    soundList.setModel (&soundModel);
    soundList.setRowHeight (22);
    soundList.setOutlineThickness (1);
    addAndMakeVisible (soundList);

    assignButton.setTooltip ("Load the selected sound into the selected track");
    assignButton.onClick = [this] { assignEntry (soundList.getSelectedRow()); };
    addAndMakeVisible (assignButton);

    addFolderButton.setButtonText (juce::String::fromUTF8 ("Add Folder\xe2\x80\xa6"));
    addFolderButton.setTooltip ("Add a folder of your own sounds to the library");
    addFolderButton.onClick = [this] { addFolder(); };
    addAndMakeVisible (addFolderButton);

    openFolderButton.setTooltip ("Open " + SoundLibrary::getDefaultUserFolder().getFullPathName()
                                 + "\nDrop audio files in there (sub-folders become categories), then press Rescan");
    openFolderButton.onClick = [this]
    {
        const auto dir = SoundLibrary::getDefaultUserFolder();
        if (! dir.startAsProcess())
            dir.revealToUser();
        showHint ("Put sounds in " + dir.getFullPathName() + ", then press Rescan");
    };
    addAndMakeVisible (openFolderButton);

    rescanButton.setTooltip ("Re-read your sound folders");
    rescanButton.onClick = [this]
    {
        proc.library.rescan();
        refreshCategories();
        refreshSounds();
        showHint ("Library rescanned: " + juce::String (proc.library.getEntries().size()) + " sounds");
    };
    addAndMakeVisible (rescanButton);

    browseButton.setButtonText (juce::String::fromUTF8 ("Browse Files\xe2\x80\xa6"));
    browseButton.setTooltip ("Pick any audio file on disk for the selected track");
    browseButton.onClick = [this] { browseFiles (selectedTrack); };
    addAndMakeVisible (browseButton);

    refreshCategories();
    refreshSounds();

    // Only the editor itself (and the search box / lists) take keyboard focus, so A-K / Space / R always work.
    for (auto* c : getChildren())
    {
        if (c == &searchBox || c == &soundList || c == &categoryList) continue;
        c->setWantsKeyboardFocus (false);
        c->setMouseClickGrabsKeyboardFocus (false);
    }
    setWantsKeyboardFocus (true);
    addMouseListener (this, true);   // see mouseDown: clicks anywhere give the editor key focus

    selectTrack (0);
    setSize (kWidth, kHeight);
    startTimerHz (30);
}

Pulse16AudioProcessorEditor::~Pulse16AudioProcessorEditor()
{
    stopTimer();
    removeMouseListener (this);
    categoryList.setModel (nullptr);
    soundList.setModel (nullptr);
    setLookAndFeel (nullptr);
}

void Pulse16AudioProcessorEditor::setupKnob (juce::Slider& s, const juce::String& paramID, bool bipolar)
{
    s.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    s.setTextBoxStyle (juce::Slider::NoTextBox, false, 0, 0);
    s.setPopupDisplayEnabled (true, true, this);
    s.getProperties().set ("bipolar", bipolar);
    if (auto* param = proc.apvts.getParameter (paramID))
    {
        s.setDoubleClickReturnValue (true, param->convertFrom0to1 (param->getDefaultValue()));
        s.setTooltip (param->getName (64) + " (double-click to reset)");
    }
    addAndMakeVisible (s);
}

//==============================================================================
void Pulse16AudioProcessorEditor::selectTrack (int track)
{
    selectedTrack = juce::jlimit (0, drums::kNumTracks - 1, track);
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto& pad = rows[(size_t) t].pad;
        if (pad.selected != (t == selectedTrack)) { pad.selected = (t == selectedTrack); pad.repaint(); }
    }
    soundList.repaint();
    repaint();
}

void Pulse16AudioProcessorEditor::focusLibrary (const juce::String& hint)
{
    // Jump to the category that matches the track (if it exists and nothing is being searched).
    const juce::String cat = trackCategory[selectedTrack];
    if (searchBox.isEmpty() && categories.contains (cat) && currentCategory != cat)
    {
        currentCategory = cat;
        categoryList.repaint();
        refreshSounds();
    }
    libraryGlow = 1.0f;
    showHint (hint, true);
    soundList.grabKeyboardFocus();
    repaint();
}

void Pulse16AudioProcessorEditor::showHint (const juce::String& message, bool important)
{
    hintLabel.setColour (juce::Label::textColourId, important ? ui::accent : ui::text.withAlpha (0.85f));
    hintLabel.setText (message, juce::dontSendNotification);
    hintTime = juce::Time::getMillisecondCounter();
}

void Pulse16AudioProcessorEditor::assignSound (int track, const juce::String& soundId)
{
    if (! juce::isPositiveAndBelow (track, drums::kNumTracks)) return;
    selectTrack (track);
    const juce::String trackName = drums::trackName (track);

    if (soundId.isEmpty())
    {
        proc.loadSound (track, {});
        showHint (trackName + " is back on the synth voice");
    }
    else if (proc.loadSound (track, soundId))
    {
        showHint ("Loaded \"" + SoundLibrary::displayName (soundId) + "\" into " + trackName);
    }
    else
    {
        showHint ("Couldn't load \"" + SoundLibrary::displayName (soundId) + "\" - is it a readable audio file?", true);
    }
    soundList.repaint();
}

void Pulse16AudioProcessorEditor::previewEntry (int index)
{
    if (! juce::isPositiveAndBelow (index, visible.size())) return;
    const auto id = visible.getReference (index).id;
    const auto now = juce::Time::getMillisecondCounter();
    // A single click fires both "clicked" and "selection changed": only preview once.
    if (id == lastPreviewId && now - lastPreviewTime < 250) return;
    lastPreviewId = id;
    lastPreviewTime = now;
    proc.previewSound (id);
}

void Pulse16AudioProcessorEditor::assignEntry (int index)
{
    if (! juce::isPositiveAndBelow (index, visible.size()))
    {
        showHint ("Select a sound in the list first", true);
        return;
    }
    assignSound (selectedTrack, visible.getReference (index).id);
}

void Pulse16AudioProcessorEditor::refreshCategories()
{
    categories.clear();
    categories.add ("All");
    categories.addArray (proc.library.getCategories());
    if (! categories.contains (currentCategory))
        currentCategory = "All";
    categoryList.updateContent();
    categoryList.repaint();
}

void Pulse16AudioProcessorEditor::refreshSounds()
{
    const auto query = searchBox.getText().trim();
    visible.clearQuick();
    for (const auto& e : proc.library.getEntries())
    {
        if (currentCategory != "All" && e.category != currentCategory) continue;
        if (query.isNotEmpty() && ! e.name.containsIgnoreCase (query) && ! e.category.containsIgnoreCase (query)) continue;
        visible.add (e);
    }
    soundList.deselectAllRows();
    soundList.updateContent();
    soundList.repaint();
}

void Pulse16AudioProcessorEditor::addFolder()
{
    chooser = std::make_unique<juce::FileChooser> ("Add a folder of sounds to the Pulse 16 library",
                                                   juce::File::getSpecialLocation (juce::File::userMusicDirectory),
                                                   "*", false);
    juce::Component::SafePointer<Pulse16AudioProcessorEditor> safe (this);
    chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectDirectories,
                          [safe] (const juce::FileChooser& fc)
                          {
                              if (safe == nullptr) return;
                              const auto dir = fc.getResult();
                              if (! dir.isDirectory()) return;
                              safe->proc.library.addUserFolder (dir);
                              safe->refreshCategories();
                              safe->refreshSounds();
                              safe->showHint ("Added " + dir.getFileName() + " - library now has "
                                              + juce::String (safe->proc.library.getEntries().size()) + " sounds");
                          });
}

void Pulse16AudioProcessorEditor::browseFiles (int track)
{
    chooser = std::make_unique<juce::FileChooser> ("Load a sound into " + juce::String (drums::trackName (track)),
                                                   SoundLibrary::getDefaultUserFolder(), audioWildcard, false);
    juce::Component::SafePointer<Pulse16AudioProcessorEditor> safe (this);
    chooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
                          [safe, track] (const juce::FileChooser& fc)
                          {
                              if (safe == nullptr) return;
                              const auto file = fc.getResult();
                              if (file.existsAsFile())
                                  safe->assignSound (track, "file:" + file.getFullPathName());
                          });
}

void Pulse16AudioProcessorEditor::showPadMenu (int track)
{
    const bool learningThis = proc.getLearnTrack() == track;
    const juce::String name = drums::trackName (track);

    juce::PopupMenu m;
    m.addSectionHeader (name + "  -  MIDI: " + proc.describeKeymap (track));
    m.addItem (1, learningThis ? "Cancel MIDI Learn" : "MIDI Learn (then play a key)");
    // NOTE: the processor API has no call to forget a learned note, so this item is shown but disabled.
    m.addItem (2, "Clear learned note", false);
    m.addSeparator();
    m.addItem (3, "Pick from library...");
    m.addItem (4, juce::String::fromUTF8 ("Load sound\xe2\x80\xa6 (file)"));
    m.addItem (5, "Use synth", proc.getSoundId (track).isNotEmpty());

    juce::Component::SafePointer<Pulse16AudioProcessorEditor> safe (this);
    m.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (&rows[(size_t) track].pad),
                     [safe, track, learningThis] (int result)
                     {
                         if (safe == nullptr) return;
                         auto& ed = *safe;
                         const juce::String n = drums::trackName (track);
                         switch (result)
                         {
                             case 1:
                                 if (learningThis) { ed.proc.cancelMidiLearn(); ed.showHint ("MIDI learn cancelled"); }
                                 else { ed.proc.startMidiLearn (track); ed.showHint ("MIDI learn: play a key on your keyboard for " + n, true); }
                                 break;
                             case 3: ed.selectTrack (track); ed.focusLibrary ("Pick a sound for " + n + " from the library  ->"); break;
                             case 4: ed.browseFiles (track); break;
                             case 5: ed.assignSound (track, {}); break;
                             default: break;
                         }
                     });
}

void Pulse16AudioProcessorEditor::hitPad (int track, float velocity)
{
    proc.triggerPadFromUI (track, velocity);
    auto& pad = rows[(size_t) track].pad;
    pad.flash = 1.0f;
    pad.repaint();
}

//==============================================================================
void Pulse16AudioProcessorEditor::timerCallback()
{
    if (! focusedOnce && isShowing())
    {
        focusedOnce = true;
        grabKeyboardFocus();
    }

    grid.repaint();
    ++blinkCounter;
    const bool blink = (blinkCounter / 8) % 2 == 0;
    const int learnTrack = proc.getLearnTrack();

    const bool rec = proc.recording.load();
    if (recButton.getToggleState() != rec)
        recButton.setToggleState (rec, juce::dontSendNotification);

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto& row = rows[(size_t) t];
        auto& pad = row.pad;
        bool dirty = false;

        const float hit = proc.hitFlash[t].exchange (0.0f);
        const float f = juce::jmax (pad.flash * 0.8f, hit);
        if (std::abs (f - pad.flash) > 0.003f) { pad.flash = f < 0.01f ? 0.0f : f; dirty = true; }

        const bool learning = learnTrack == t;
        if (learning != pad.learning || (learning && blink != pad.blinkOn))
        {
            pad.learning = learning;
            pad.blinkOn = blink;
            dirty = true;
        }
        if (dirty) pad.repaint();

        auto name = proc.getSoundName (t);
        if (name.isEmpty()) name = "Synth";
        if (name != row.shownName)
        {
            row.shownName = name;
            row.soundButton.setButtonText (name);
            const auto id = proc.getSoundId (t);
            row.soundButton.setTooltip ((id.isEmpty() ? juce::String ("Synth voice") : id)
                                        + "\nClick to pick another sound from the library");
            soundList.repaint();
        }

        const auto tip = juce::String (drums::trackName (t)) + "  -  MIDI " + proc.describeKeymap (t)
                       + "  -  key " + pad.keyLabel
                       + "\nClick to play (shift = accent). Right-click: MIDI learn / load sound.";
        if (tip != row.shownTip)
        {
            row.shownTip = tip;
            pad.setTooltip (tip);
        }
    }

    if (libraryGlow > 0.0f)
    {
        libraryGlow = libraryGlow < 0.02f ? 0.0f : libraryGlow * 0.94f;
        repaint (kLibX - 4, kLibTop - 4, kLibRight - kLibX + 8, kLibBottom - kLibTop + 8);
    }

    if (hintLabel.getText().isNotEmpty() && juce::Time::getMillisecondCounter() - hintTime > 6000)
        hintLabel.setText ({}, juce::dontSendNotification);
}

//==============================================================================
void Pulse16AudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (ui::bg);

    // Header
    g.setColour (ui::panel);
    g.fillRect (0, 0, getWidth(), kHeaderH);
    g.setColour (ui::accent);
    g.setFont (font (30.0f, true));
    g.drawText (juce::String::fromUTF8 ("PULSE\xc2\xb7" "16"), 20, 14, 180, 36, juce::Justification::centredLeft);
    g.setColour (ui::dim.brighter (0.3f));
    g.setFont (font (12.0f));
    g.drawText ("synth + sample drum machine", 22, 50, 178, 18, juce::Justification::centredLeft);

    g.setFont (font (11.0f, true));
    g.drawText ("KIT", kitBox.getX(), 12, kitBox.getWidth(), 16, juce::Justification::centredLeft);
    g.drawText ("MIDI KEYMAP", keymapBox.getX(), 12, keymapBox.getWidth(), 16, juce::Justification::centredLeft);
    for (int i = 0; i < kNumKnobs; ++i)
    {
        const auto b = globalKnobs[i].getBounds();
        g.drawText (globalNames[i], b.getCentreX() - 36, b.getBottom(), 72, 14, juce::Justification::centred);
    }

    // Column headers
    g.setColour (ui::dim.brighter (0.2f));
    const int hy = kRowsTop - 22;
    g.drawText ("PAD  (KEY)", kPadX + 2, hy, kPadW, 16, juce::Justification::centredLeft);
    g.drawText ("SOUND", kSoundX + 2, hy, kSoundW, 16, juce::Justification::centredLeft);
    g.drawText ("SMP", kSmpX, hy, kSmpW, 16, juce::Justification::centred);
    for (int k = 0; k < kNumKnobs; ++k)
        g.drawText (trackNames[k], kKnobX + k * kKnobW - 2, hy, kKnobW + 4, 16, juce::Justification::centred);

    const float colW = (float) grid.getWidth() / (float) drums::kNumSteps;
    for (int s = 0; s < drums::kNumSteps; ++s)
    {
        g.setColour (s % 4 == 0 ? ui::text : ui::dim);
        g.drawText (juce::String (s + 1), (int) ((float) kGridX + (float) s * colW), hy, (int) colW, 16, juce::Justification::centred);
    }

    // Row backgrounds
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto r = juce::Rectangle<int> (10, kRowsTop + t * kRowH, kMainRight - 10, kRowH).reduced (0, 2);
        juce::Colour c = t % 2 ? ui::panel.darker (0.2f) : ui::panel;
        if (t == selectedTrack) c = c.interpolatedWith (ui::accent, 0.10f);
        if (t == dragRow)       c = ui::accent.withAlpha (0.30f);
        g.setColour (c);
        g.fillRoundedRectangle (r.toFloat(), 6.0f);
        if (t == selectedTrack)
        {
            g.setColour (ui::accent);
            g.fillRoundedRectangle (r.withWidth (3).toFloat(), 1.5f);
        }
    }

    // Library panel
    const auto lib = juce::Rectangle<int> (kLibX, kLibTop, kLibRight - kLibX, kLibBottom - kLibTop).toFloat();
    g.setColour (ui::panel);
    g.fillRoundedRectangle (lib, 8.0f);
    if (libraryGlow > 0.0f)
    {
        g.setColour (ui::accent.withAlpha (juce::jlimit (0.0f, 1.0f, libraryGlow)));
        g.drawRoundedRectangle (lib.reduced (1.0f), 8.0f, 3.0f);
    }
    g.setColour (ui::accent);
    g.setFont (font (14.0f, true));
    g.drawText ("SOUND LIBRARY", kLibX + 10, 100, 200, 18, juce::Justification::centredLeft);
    g.setColour (ui::dim.brighter (0.4f));
    g.setFont (font (11.0f));
    g.drawText (juce::String (proc.library.getEntries().size()) + " sounds", kLibRight - 110, 100, 100, 18,
                juce::Justification::centredRight);
    g.setColour (ui::text);
    g.setFont (font (12.0f));
    g.drawText ("Loads into:  " + juce::String (drums::trackName (selectedTrack)), kLibX + 10, 118, 300, 16,
                juce::Justification::centredLeft);

    // Footer hint
    g.setColour (ui::dim.brighter (0.25f));
    g.setFont (font (12.0f));
    g.drawText (juce::String::fromUTF8 ("Keys A\xe2\x80\x93K play pads  \xc2\xb7  REC + play to record  \xc2\xb7  "
                                        "Click a sound to preview, double-click to load  \xc2\xb7  "
                                        "Right-click a pad for MIDI learn"),
                16, getHeight() - kFooterH, getWidth() - 32, kFooterH - 6, juce::Justification::centredLeft);
}

void Pulse16AudioProcessorEditor::resized()
{
    // Header (see layout block at the top of this file)
    kitBox.setBounds (214, 32, 170, 28);
    recButton.setBounds (398, 14, 48, 60);
    runButton.setBounds (458, 32, 68, 28);
    clearButton.setBounds (534, 32, 68, 28);
    quantizeButton.setBounds (614, 32, 96, 28);
    keymapBox.setBounds (722, 32, 150, 28);
    for (int i = 0; i < kNumKnobs; ++i)
        globalKnobs[i].setBounds (1070 + i * 72 + 10, 8, 52, 52);

    // Track rows
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        auto& row = rows[(size_t) t];
        const int y = kRowsTop + t * kRowH;
        row.pad.setBounds (kPadX, y + 5, kPadW, kRowH - 10);
        row.soundButton.setBounds (kSoundX, y + 14, kSoundW, kRowH - 28);
        row.synthButton.setBounds (kSynthX, y + 14, kSynthW, kRowH - 28);
        row.modeButton.setBounds (kSmpX, y + 14, kSmpW, kRowH - 28);
        for (int k = 0; k < kNumKnobs; ++k)
            row.knobs[k].setBounds (kKnobX + k * kKnobW, y + 4, kKnobW, kRowH - 8);
    }
    grid.setBounds (kGridX, kRowsTop, kMainRight - 4 - kGridX, kRowH * drums::kNumTracks);
    hintLabel.setBounds (16, kRowsTop + kRowH * drums::kNumTracks + 6, kMainRight - 16, 30);

    // Library panel
    const int inX = kLibX + 10, inW = kLibRight - kLibX - 20;   // 1120 .. 1420
    searchBox.setBounds (inX, 140, inW, 26);
    categoryList.setBounds (inX, 172, 94, 322);
    soundList.setBounds (inX + 100, 172, inW - 100, 322);
    assignButton.setBounds (inX, 500, inW, 26);
    const int half = (inW - 6) / 2;
    addFolderButton.setBounds (inX, 532, half, 26);
    openFolderButton.setBounds (inX + half + 6, 532, half, 26);
    rescanButton.setBounds (inX, 564, half, 26);
    browseButton.setBounds (inX + half + 6, 564, half, 26);
}

//==============================================================================
int Pulse16AudioProcessorEditor::rowAt (juce::Point<int> pos) const
{
    if (pos.x < 10 || pos.x >= kMainRight || pos.y < kRowsTop) return -1;
    const int r = (pos.y - kRowsTop) / kRowH;
    return r < drums::kNumTracks ? r : -1;
}

void Pulse16AudioProcessorEditor::mouseDown (const juce::MouseEvent& e)
{
    // Called for clicks on the editor and (via addMouseListener) on all child components.
    auto* src = e.eventComponent;
    const bool inLibraryInput = src == &searchBox || searchBox.isParentOf (src)
                             || src == &soundList || soundList.isParentOf (src)
                             || src == &categoryList || categoryList.isParentOf (src);
    if (! inLibraryInput)
        grabKeyboardFocus();

    if (src == this)
    {
        const int r = rowAt (e.getPosition());
        if (r >= 0) selectTrack (r);
    }
}

bool Pulse16AudioProcessorEditor::keyPressed (const juce::KeyPress& key)
{
    if (searchBox.hasKeyboardFocus (true)) return false;
    if (key.getModifiers().isCommandDown() || key.getModifiers().isCtrlDown() || key.getModifiers().isAltDown())
        return false;   // leave shortcuts to the host

    const int code = (int) juce::CharacterFunctions::toUpperCase ((juce::juce_wchar) key.getKeyCode());

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        if (code == padKeys[t])
        {
            if (! keyHeld[t])   // ignore auto-repeat
            {
                keyHeld[t] = true;
                hitPad (t, key.getModifiers().isShiftDown() ? 1.0f : 0.8f);
            }
            return true;
        }
    }

    if (key.getKeyCode() == juce::KeyPress::spaceKey)
    {
        if (! keyHeld[8])
        {
            keyHeld[8] = true;
            runButton.triggerClick();
        }
        return true;
    }

    if (code == 'R')
    {
        if (! keyHeld[9])
        {
            keyHeld[9] = true;
            recButton.triggerClick();
        }
        return true;
    }
    return false;
}

bool Pulse16AudioProcessorEditor::keyStateChanged (bool)
{
    if (searchBox.hasKeyboardFocus (true)) return false;
    bool any = false;
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        if (keyHeld[t] && ! isCharDown (padKeys[t])) keyHeld[t] = false;
        any = any || keyHeld[t];
    }
    if (keyHeld[8] && ! juce::KeyPress::isKeyCurrentlyDown (juce::KeyPress::spaceKey)) keyHeld[8] = false;
    if (keyHeld[9] && ! isCharDown ('R')) keyHeld[9] = false;
    return any || keyHeld[8] || keyHeld[9];
}

//==============================================================================
bool Pulse16AudioProcessorEditor::isInterestedInFileDrag (const juce::StringArray& files)
{
    for (const auto& f : files)
        if (Pulse16AudioProcessor::isAudioFile (f))
            return true;
    return false;
}

void Pulse16AudioProcessorEditor::fileDragMove (const juce::StringArray&, int x, int y)
{
    const int r = rowAt ({ x, y });
    if (r != dragRow) { dragRow = r; repaint(); }
}

void Pulse16AudioProcessorEditor::fileDragExit (const juce::StringArray&)
{
    dragRow = -1;
    repaint();
}

void Pulse16AudioProcessorEditor::filesDropped (const juce::StringArray& files, int x, int y)
{
    dragRow = -1;
    const int r = rowAt ({ x, y });
    if (r < 0)
    {
        showHint ("Drop audio files onto a track row to load them", true);
    }
    else
    {
        for (const auto& f : files)
            if (Pulse16AudioProcessor::isAudioFile (f))
            {
                assignSound (r, "file:" + juce::File (f).getFullPathName());
                break;
            }
    }
    repaint();
}

bool Pulse16AudioProcessorEditor::isInterestedInDragSource (const SourceDetails& details)
{
    return details.description.isString() && isSoundId (details.description.toString());
}

void Pulse16AudioProcessorEditor::itemDragMove (const SourceDetails& details)
{
    const int r = rowAt (details.localPosition);
    if (r != dragRow) { dragRow = r; repaint(); }
}

void Pulse16AudioProcessorEditor::itemDragExit (const SourceDetails&)
{
    dragRow = -1;
    repaint();
}

void Pulse16AudioProcessorEditor::itemDropped (const SourceDetails& details)
{
    dragRow = -1;
    const int r = rowAt (details.localPosition);
    if (r >= 0)
        assignSound (r, details.description.toString());
    repaint();
}
