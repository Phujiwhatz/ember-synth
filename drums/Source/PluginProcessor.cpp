#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace
{
struct Event { int offset; int track; float velocity; };
constexpr long long kNoStep = std::numeric_limits<long long>::min();
}
//==============================================================================
Pulse16AudioProcessor::Pulse16AudioProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "Pulse16", createLayout())
{
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        level[t] = apvts.getRawParameterValue (paramId ("level", t));
        tune [t] = apvts.getRawParameterValue (paramId ("tune",  t));
        decay[t] = apvts.getRawParameterValue (paramId ("decay", t));
        tone [t] = apvts.getRawParameterValue (paramId ("tone",  t));
        pan  [t] = apvts.getRawParameterValue (paramId ("pan",   t));
        mode [t] = apvts.getRawParameterValue (paramId ("mode",  t));
        hitFlash[t].store (0.0f);
        padVelocity[t].store (0.0f);
        learnedNote[t].store (-1);
        skipStep[t] = kNoStep;
    }
    runParam    = apvts.getRawParameterValue ("run");
    tempoParam  = apvts.getRawParameterValue ("tempo");
    swingParam  = apvts.getRawParameterValue ("swing");
    accentParam = apvts.getRawParameterValue ("accent");
    driveParam  = apvts.getRawParameterValue ("drive");
    masterParam = apvts.getRawParameterValue ("master");
    keymapParam   = apvts.getRawParameterValue ("keymap");
    quantizeParam = apvts.getRawParameterValue ("quantize");

    loadDefaultPattern();
    startTimer (500);
}

Pulse16AudioProcessor::~Pulse16AudioProcessor()
{
    stopTimer();
}

juce::AudioProcessorValueTreeState::ParameterLayout Pulse16AudioProcessor::createLayout()
{
    using namespace juce;
    AudioProcessorValueTreeState::ParameterLayout layout;

    const float defaultPan[drums::kNumTracks]   = { 0.0f, 0.0f, 0.1f, 0.2f, 0.2f, -0.25f, 0.25f, -0.15f };
    const float defaultLevel[drums::kNumTracks] = { 0.9f, 0.8f, 0.65f, 0.5f, 0.5f, 0.7f, 0.65f, 0.45f };

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        const String name = String (drums::trackName (t)).toLowerCase();
        auto group = std::make_unique<AudioProcessorParameterGroup> ("track" + String (t), String (drums::trackName (t)), " | ");

        group->addChild (std::make_unique<AudioParameterFloat> (ParameterID { paramId ("level", t), 1 }, name + " level",
                                                                NormalisableRange<float> (0.0f, 1.0f), defaultLevel[t]));
        group->addChild (std::make_unique<AudioParameterFloat> (ParameterID { paramId ("tune", t), 1 }, name + " tune",
                                                                NormalisableRange<float> (-24.0f, 24.0f, 0.01f), 0.0f));
        group->addChild (std::make_unique<AudioParameterFloat> (ParameterID { paramId ("decay", t), 1 }, name + " decay",
                                                                NormalisableRange<float> (0.0f, 1.0f), 0.5f));
        group->addChild (std::make_unique<AudioParameterFloat> (ParameterID { paramId ("tone", t), 1 }, name + " tone",
                                                                NormalisableRange<float> (0.0f, 1.0f), 0.5f));
        group->addChild (std::make_unique<AudioParameterFloat> (ParameterID { paramId ("pan", t), 1 }, name + " pan",
                                                                NormalisableRange<float> (-1.0f, 1.0f), defaultPan[t]));
        group->addChild (std::make_unique<AudioParameterBool> (ParameterID { paramId ("mode", t), 1 }, name + " sample mode", false));
        layout.add (std::move (group));
    }

    layout.add (std::make_unique<AudioParameterBool>  (ParameterID { "run", 1 }, "Run (when host stopped)", false));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "tempo", 1 }, "Standalone tempo",
                                                       NormalisableRange<float> (50.0f, 200.0f, 0.1f), 120.0f));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "swing", 1 }, "Swing",
                                                       NormalisableRange<float> (0.0f, 1.0f), 0.0f));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "accent", 1 }, "Accent",
                                                       NormalisableRange<float> (0.0f, 1.0f), 0.5f));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "drive", 1 }, "Drive",
                                                       NormalisableRange<float> (0.0f, 1.0f), 0.1f));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { "master", 1 }, "Master",
                                                       NormalisableRange<float> (-36.0f, 6.0f, 0.1f), -3.0f));
    layout.add (std::make_unique<AudioParameterChoice> (ParameterID { "keymap", 1 }, "MIDI key map",
                                                        StringArray { "Every octave", "GM drums" }, 0));
    layout.add (std::make_unique<AudioParameterBool>  (ParameterID { "quantize", 1 }, "Record quantize", true));
    return layout;
}

//==============================================================================
void Pulse16AudioProcessor::prepareToPlay (double sampleRate, int)
{
    sr = sampleRate;
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        voices[t].prepare (sr, t, 0x1234567u + (uint32_t) t * 7919u);
        skipStep[t] = kNoStep;
    }
    previewVoice.prepare (sr, -1, 0x2468ACEu);   // kind -1: plays samples only, never a synth voice

    lastStepIndex = kNoStep;
    lastPpqEnd = -1.0;
}

bool Pulse16AudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
}

void Pulse16AudioProcessor::triggerTrack (int track, float velocity)
{
    drums::TriggerParams p;
    p.tune     = tune [track]->load();
    p.decay    = decay[track]->load();
    p.tone     = tone [track]->load();
    p.velocity = velocity;

    std::shared_ptr<const drums::SampleData> s;
    if (mode[track]->load() > 0.5f)
    {
        const juce::SpinLock::ScopedTryLockType lock (sampleLock);
        if (lock.isLocked())
            s = samples[track];
    }

    voices[track].trigger (p, std::move (s));   // no sample loaded -> falls back to synth

    if (track == drums::ClosedHat)
        voices[drums::OpenHat].choke();

    hitFlash[track].store (velocity);
}

void Pulse16AudioProcessor::renderVoices (float* l, float* r, int start, int num)
{
    if (num <= 0) return;

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        if (! voices[t].isActive()) continue;
        const float lv = level[t]->load();
        const float g  = lv * lv * 1.4f;
        const float a  = (pan[t]->load() + 1.0f) * drums::kPi * 0.25f;
        voices[t].render (l + start, r + start, num, std::cos (a) * g, std::sin (a) * g);
    }

    if (previewVoice.isActive())
    {
        constexpr float lv = 0.8f;
        const float g = lv * lv * 1.4f * 0.70710678f;   // centre
        previewVoice.render (l + start, r + start, num, g, g);
    }
}

int Pulse16AudioProcessor::midiNoteToTrack (int note) const
{
    for (int t = 0; t < drums::kNumTracks; ++t)
        if (learnedNote[t].load (std::memory_order_relaxed) == note)
            return t;

    const int keymap = keymapParam != nullptr ? (int) (keymapParam->load() + 0.5f) : 0;
    return drums::noteToTrack (note, keymap);
}

// Writes a live hit into the pattern (audio thread). Must be called after the transport
// for this block is known and BEFORE the sequencer steps of this block are scheduled.
void Pulse16AudioProcessor::recordHit (const Transport& tr, int offset, int track, float velocity)
{
    if (! tr.running || ! recording.load (std::memory_order_relaxed))
        return;

    const bool quantize = quantizeParam == nullptr || quantizeParam->load() > 0.5f;
    const double hitPpq = tr.startPpq + (double) offset * tr.ppqPerSample;
    const long long k = drums::recordStepFor (hitPpq, tr.swingDelay, quantize);

    steps[track][drums::stepIndexInPattern (k)].store (velocity >= 0.85f ? 2 : 1);

    // The hit already sounds now. If the sequencer hasn't played step k yet (it rounded forward,
    // or lies later in this block), don't let it trigger again on this pass.
    if (k > lastStepIndex)
        skipStep[track] = k;
}

void Pulse16AudioProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples();
    buffer.clear();
    if (buffer.getNumChannels() < 2 || n == 0) { midi.clear(); return; }

    float* L = buffer.getWritePointer (0);
    float* R = buffer.getWritePointer (1);

    constexpr int maxEvents = 512;
    Event events[maxEvents];
    int numEvents = 0;
    auto addEvent = [&] (int offset, int track, float vel)
    {
        if (numEvents < maxEvents)
            events[numEvents++] = { juce::jlimit (0, n - 1, offset), track, vel };
    };

    // 1. Transport
    double bpm = tempoParam->load();
    double ppq = 0.0;
    bool hostPlaying = false;

    if (auto* ph = getPlayHead())
    {
        if (auto pos = ph->getPosition())
        {
            if (auto b = pos->getBpm()) bpm = *b;
            if (auto p = pos->getPpqPosition())
            {
                ppq = *p;
                hostPlaying = pos->getIsPlaying();
            }
        }
    }

    const bool runInternal = ! hostPlaying && runParam->load() > 0.5f;
    if (runInternal && ! internalRunning)
    {
        internalPpq = 0.0;
        lastStepIndex = kNoStep;
        lastPpqEnd = -1.0;
    }
    internalRunning = runInternal;

    Transport tr;
    tr.running      = hostPlaying || runInternal;
    tr.startPpq     = hostPlaying ? ppq : internalPpq;
    tr.ppqPerSample = juce::jmax (1.0, bpm) / 60.0 / sr;
    tr.swingDelay   = swingParam->load() * 0.1;   // up to ~triplet feel
    const double endPpq = tr.startPpq + n * tr.ppqPerSample;

    if (tr.running)
    {
        // Transport jumped (cycle loop, locate)? Start fresh.
        if (lastPpqEnd < 0.0 || tr.startPpq < lastPpqEnd - 1.0e-3 || tr.startPpq > lastPpqEnd + 0.25)
        {
            lastStepIndex = kNoStep;
            for (auto& s : skipStep) s = kNoStep;
        }
    }

    // 2. Preview voice handoff (lock-free: try-lock only)
    if (previewPending.exchange (false))
    {
        const juce::SpinLock::ScopedTryLockType lock (previewLock);
        if (lock.isLocked())
        {
            auto s = std::move (pendingPreview);   // message thread still holds a reference (lastPreviewData)
            pendingPreview = nullptr;
            if (s != nullptr)
            {
                drums::TriggerParams p;
                previewVoice.trigger (p, std::move (s));
            }
        }
        else
        {
            previewPending.store (true);           // try again next block
        }
    }

    // 3. Pads clicked / keys pressed in the UI
    const uint32_t pads = padMask.exchange (0);
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        if (pads & (1u << t))
        {
            const float v = padVelocity[t].load (std::memory_order_relaxed);
            addEvent (0, t, v);
            recordHit (tr, 0, t, v);
        }
    }

    // 4. Incoming MIDI (all channels; velocity-0 note-ons are note-offs and ignored by isNoteOn())
    for (const auto meta : midi)
    {
        const auto msg = meta.getMessage();
        if (! msg.isNoteOn())
            continue;

        const int note = msg.getNoteNumber();
        const float vel = msg.getFloatVelocity();
        const int offset = juce::jlimit (0, n - 1, meta.samplePosition);

        const int lt = learnTrack.load();
        if (lt >= 0 && lt < drums::kNumTracks)
        {
            for (int t = 0; t < drums::kNumTracks; ++t)
                if (learnedNote[t].load() == note)
                    learnedNote[t].store (-1);
            learnedNote[lt].store (note);
            learnTrack.store (-1);
            addEvent (offset, lt, vel);
            continue;
        }

        const int t = midiNoteToTrack (note);
        if (t >= 0)
        {
            addEvent (offset, t, vel);
            recordHit (tr, offset, t, vel);
        }
    }
    midi.clear();

    // 5. Step sequencer
    if (tr.running)
    {
        const float accentAmt = accentParam->load();
        const float normalVel = 1.0f - 0.5f * accentAmt;

        const auto kFirst = (long long) std::floor (tr.startPpq / 0.25) - 1;
        const auto kLast  = (long long) std::floor (endPpq / 0.25);

        for (long long k = kFirst; k <= kLast; ++k)
        {
            const double when = drums::stepTimePpq (k, tr.swingDelay);
            if (when < tr.startPpq - 1.0e-9 || when >= endPpq || k <= lastStepIndex)
                continue;

            const int offset = (int) ((when - tr.startPpq) / tr.ppqPerSample);
            const int step = drums::stepIndexInPattern (k);

            for (int t = 0; t < drums::kNumTracks; ++t)
            {
                if (skipStep[t] == k) { skipStep[t] = kNoStep; continue; }
                const uint8_t s = steps[t][step].load (std::memory_order_relaxed);
                if (s != 0)
                    addEvent (offset, t, s == 2 ? 1.0f : normalVel);
            }
            lastStepIndex = k;
            currentStep.store (step);
        }

        lastPpqEnd = endPpq;
        if (runInternal) internalPpq = endPpq;
    }
    else
    {
        currentStep.store (-1);
        lastStepIndex = kNoStep;
        lastPpqEnd = -1.0;
        for (auto& s : skipStep) s = kNoStep;
    }

    // Sort events by time (insertion sort: stable, no allocation)
    for (int i = 1; i < numEvents; ++i)
    {
        const Event e = events[i];
        int j = i - 1;
        while (j >= 0 && events[j].offset > e.offset) { events[j + 1] = events[j]; --j; }
        events[j + 1] = e;
    }

    // 6. Render, splitting the block at each event for sample-accurate timing
    int pos = 0;
    for (int i = 0; i < numEvents; ++i)
    {
        renderVoices (L, R, pos, events[i].offset - pos);
        pos = events[i].offset;
        triggerTrack (events[i].track, events[i].velocity);
    }
    renderVoices (L, R, pos, n - pos);

    // 7. Master drive + volume (tanh also acts as a soft safety limiter)
    const float dg = 1.0f + driveParam->load() * 5.0f;
    const float makeup = 1.0f / std::sqrt (dg);
    const float gain = juce::Decibels::decibelsToGain (masterParam->load());
    for (int i = 0; i < n; ++i)
    {
        L[i] = std::tanh (L[i] * dg) * makeup * gain;
        R[i] = std::tanh (R[i] * dg) * makeup * gain;
    }
}

//==============================================================================
bool Pulse16AudioProcessor::isAudioFile (const juce::String& path)
{
    return SoundLibrary::isAudioFileName (path);
}

void Pulse16AudioProcessor::retire (std::shared_ptr<const drums::SampleData> data)
{
    if (data == nullptr) return;
    const juce::ScopedLock sl (retiredLock);
    retired.push_back (std::move (data));   // freed on the message thread once no voice uses it
}

void Pulse16AudioProcessor::setSampleForTrack (int track, std::shared_ptr<const drums::SampleData> data)
{
    std::shared_ptr<const drums::SampleData> old;
    {
        const juce::SpinLock::ScopedLockType lock (sampleLock);
        old = std::move (samples[track]);
        samples[track] = std::move (data);
    }
    retire (std::move (old));
}

void Pulse16AudioProcessor::setParamValue (const juce::String& id, float value)
{
    if (auto* p = apvts.getParameter (id))
        p->setValueNotifyingHost (p->convertTo0to1 (value));
}

bool Pulse16AudioProcessor::loadSound (int track, const juce::String& soundId)
{
    if (track < 0 || track >= drums::kNumTracks)
        return false;

    if (soundId.isEmpty())
    {
        clearSample (track);
        return true;
    }

    auto data = library.load (soundId);
    if (data == nullptr)
        return false;

    setSampleForTrack (track, std::move (data));
    {
        const juce::ScopedLock sl (idLock);
        soundIds[track] = soundId;
        missingIds[track].clear();
    }
    setParamValue (paramId ("mode", track), 1.0f);
    return true;
}

juce::String Pulse16AudioProcessor::getSoundId (int track) const
{
    if (track < 0 || track >= drums::kNumTracks) return {};
    const juce::ScopedLock sl (idLock);
    return soundIds[track];
}

juce::String Pulse16AudioProcessor::getSoundName (int track) const
{
    return SoundLibrary::displayName (getSoundId (track));
}

bool Pulse16AudioProcessor::loadSample (int track, const juce::File& file)
{
    return loadSound (track, "file:" + file.getFullPathName());
}

void Pulse16AudioProcessor::clearSample (int track)
{
    if (track < 0 || track >= drums::kNumTracks) return;
    setSampleForTrack (track, nullptr);
    {
        const juce::ScopedLock sl (idLock);
        soundIds[track].clear();
        missingIds[track].clear();
    }
    setParamValue (paramId ("mode", track), 0.0f);
}

void Pulse16AudioProcessor::previewSound (const juce::String& soundId)
{
    if (soundId.isEmpty()) return;

    std::shared_ptr<const drums::SampleData> data;
    if (soundId == lastPreviewId && lastPreviewData != nullptr)
        data = lastPreviewData;
    else
        data = library.load (soundId);

    if (data == nullptr) return;

    if (data != lastPreviewData)
    {
        retire (std::move (lastPreviewData));   // the preview voice may still be playing it
        lastPreviewData = data;
        lastPreviewId = soundId;
    }

    {
        const juce::SpinLock::ScopedLockType lock (previewLock);
        pendingPreview = std::move (data);
    }
    previewPending.store (true);
}

juce::StringArray Pulse16AudioProcessor::getKitNames() const
{
    juce::StringArray names;
    for (auto& k : library.getKits())
        names.add (k.name);
    return names;
}

void Pulse16AudioProcessor::loadKit (int kitIndex)
{
    const auto& kits = library.getKits();
    if (! juce::isPositiveAndBelow (kitIndex, kits.size()))
        return;

    const auto& kit = kits.getReference (kitIndex);
    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        const auto& kt = kit.tracks[t];
        if (kt.sound.isEmpty() || ! loadSound (t, kt.sound))
            clearSample (t);                     // synth voice (or sound missing -> synth)

        setParamValue (paramId ("level", t), kt.level);
        setParamValue (paramId ("tune",  t), kt.tune);
        setParamValue (paramId ("decay", t), kt.decay);
        setParamValue (paramId ("tone",  t), kt.tone);
        setParamValue (paramId ("pan",   t), kt.pan);
    }
}

void Pulse16AudioProcessor::triggerPadFromUI (int track, float velocity)
{
    if (track < 0 || track >= drums::kNumTracks) return;
    padVelocity[track].store (juce::jlimit (0.0f, 1.0f, velocity), std::memory_order_relaxed);
    padMask.fetch_or (1u << (uint32_t) track);
}

//==============================================================================
int Pulse16AudioProcessor::getLearnTrack() const        { return learnTrack.load(); }
void Pulse16AudioProcessor::startMidiLearn (int track)  { learnTrack.store (juce::isPositiveAndBelow (track, drums::kNumTracks) ? track : -1); }
void Pulse16AudioProcessor::cancelMidiLearn()           { learnTrack.store (-1); }

int Pulse16AudioProcessor::getLearnedNote (int track) const
{
    return juce::isPositiveAndBelow (track, drums::kNumTracks) ? learnedNote[track].load() : -1;
}

juce::String Pulse16AudioProcessor::describeKeymap (int track) const
{
    if (! juce::isPositiveAndBelow (track, drums::kNumTracks)) return {};

    // Octave numbering as in Logic Pro (middle C = C3, note 36 = C1)
    auto noteName = [] (int note) { return juce::MidiMessage::getMidiNoteName (note, true, true, 3); };

    juce::StringArray parts;
    const int learned = getLearnedNote (track);
    if (learned >= 0)
        parts.add (noteName (learned));

    const int keymap = keymapParam != nullptr ? (int) (keymapParam->load() + 0.5f) : 0;
    if (keymap == drums::KeymapGM)
    {
        juce::StringArray gm;
        for (int note = 0; note < 128; ++note)
            if (drums::noteToTrackGM (note) == track)
                gm.add (noteName (note));
        parts.add (gm.joinIntoString (", "));
    }
    else
    {
        parts.add (juce::MidiMessage::getMidiNoteName (track, true, false, 3));   // pitch class, any octave
    }
    return parts.joinIntoString (" / ");
}

//==============================================================================
void Pulse16AudioProcessor::timerCallback()
{
    const juce::ScopedLock sl (retiredLock);
    retired.erase (std::remove_if (retired.begin(), retired.end(),
                                   [] (const auto& p) { return p.use_count() <= 1; }),
                   retired.end());
}

void Pulse16AudioProcessor::clearPattern()
{
    for (auto& row : steps)
        for (auto& s : row)
            s.store (0);
}

void Pulse16AudioProcessor::loadDefaultPattern()
{
    const char* pattern[drums::kNumTracks] = {
        "x.....x.x.x.....",  // kick
        "....x.......x...",  // snare
        "............x...",  // clap
        "X.x.X.x.X.x.X...",  // closed hat   (X = accent)
        "..............x.",  // open hat
        "................",
        "................",
        "................",
    };
    for (int t = 0; t < drums::kNumTracks; ++t)
        for (int s = 0; s < drums::kNumSteps; ++s)
            steps[t][s].store (pattern[t][s] == 'X' ? 2 : pattern[t][s] == 'x' ? 1 : 0);
}

//==============================================================================
void Pulse16AudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto state = apvts.copyState();

    juce::ValueTree extra ("Pulse16Extra");
    extra.setProperty ("version", 2, nullptr);
    juce::String pattern;
    for (int t = 0; t < drums::kNumTracks; ++t)
        for (int s = 0; s < drums::kNumSteps; ++s)
            pattern << juce::String ((int) steps[t][s].load());
    extra.setProperty ("pattern", pattern, nullptr);

    {
        const juce::ScopedLock sl (idLock);
        for (int t = 0; t < drums::kNumTracks; ++t)
        {
            const auto id = soundIds[t].isNotEmpty() ? soundIds[t] : missingIds[t];
            extra.setProperty ("sound" + juce::String (t), id, nullptr);
        }
    }
    for (int t = 0; t < drums::kNumTracks; ++t)
        extra.setProperty ("learn" + juce::String (t), learnedNote[t].load(), nullptr);

    state.appendChild (extra, nullptr);

    if (auto xml = state.createXml())
        copyXmlToBinary (*xml, destData);
}

void Pulse16AudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto xml = getXmlFromBinary (data, sizeInBytes);
    if (xml == nullptr || ! xml->hasTagName (apvts.state.getType()))
        return;

    auto tree = juce::ValueTree::fromXml (*xml);
    auto extra = tree.getChildWithName ("Pulse16Extra");
    if (extra.isValid())
    {
        const auto pattern = extra["pattern"].toString();
        if (pattern.length() == drums::kNumTracks * drums::kNumSteps)
            for (int t = 0; t < drums::kNumTracks; ++t)
                for (int s = 0; s < drums::kNumSteps; ++s)
                    steps[t][s].store ((uint8_t) juce::jlimit (0, 2, pattern[t * drums::kNumSteps + s] - '0'));

        for (int t = 0; t < drums::kNumTracks; ++t)
        {
            juce::String id = extra["sound" + juce::String (t)].toString();
            if (! extra.hasProperty ("sound" + juce::String (t)))
            {
                // v1 state: plain file paths
                const auto path = extra["sample" + juce::String (t)].toString();
                if (path.isNotEmpty())
                    id = "file:" + path;
            }

            // Mode switches come back with replaceState() below, so no parameter changes here.
            auto sample = id.isNotEmpty() ? library.load (id) : nullptr;
            setSampleForTrack (t, sample);
            {
                const juce::ScopedLock sl (idLock);
                soundIds[t]   = sample != nullptr ? id : juce::String();
                missingIds[t] = sample != nullptr ? juce::String() : id;   // keep the reference so it is re-saved
            }

            const auto learnKey = "learn" + juce::String (t);
            learnedNote[t].store (extra.hasProperty (learnKey) ? juce::jlimit (-1, 127, (int) extra[learnKey]) : -1);
        }
        tree.removeChild (extra, nullptr);
    }

    apvts.replaceState (tree);
}

//==============================================================================
juce::AudioProcessorEditor* Pulse16AudioProcessor::createEditor()
{
    return new Pulse16AudioProcessorEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new Pulse16AudioProcessor();
}
