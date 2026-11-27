#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace
{
// General MIDI drum map (Logic's Drum Machine Designer / drum regions use this),
// plus C3..G3 (MIDI 60-67) mapped straight to tracks 1-8 for small keyboards.
int noteToTrack (int note)
{
    switch (note)
    {
        case 35: case 36:          return drums::Kick;
        case 37: case 38: case 40: return drums::Snare;
        case 39:                   return drums::Clap;
        case 42: case 44:          return drums::ClosedHat;
        case 46:                   return drums::OpenHat;
        case 41: case 43: case 45: return drums::LowTom;
        case 47: case 48: case 50: return drums::HighTom;
        case 56:                   return drums::Cowbell;
        default: break;
    }
    if (note >= 60 && note < 60 + drums::kNumTracks)
        return note - 60;
    return -1;
}

struct Event { int offset; int track; float velocity; };
}

//==============================================================================
Pulse16AudioProcessor::Pulse16AudioProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      apvts (*this, nullptr, "Pulse16", createLayout())
{
    formatManager.registerBasicFormats();

    for (int t = 0; t < drums::kNumTracks; ++t)
    {
        level[t] = apvts.getRawParameterValue (paramId ("level", t));
        tune [t] = apvts.getRawParameterValue (paramId ("tune",  t));
        decay[t] = apvts.getRawParameterValue (paramId ("decay", t));
        tone [t] = apvts.getRawParameterValue (paramId ("tone",  t));
        pan  [t] = apvts.getRawParameterValue (paramId ("pan",   t));
        mode [t] = apvts.getRawParameterValue (paramId ("mode",  t));
        hitFlash[t].store (0.0f);
    }
    runParam    = apvts.getRawParameterValue ("run");
    tempoParam  = apvts.getRawParameterValue ("tempo");
    swingParam  = apvts.getRawParameterValue ("swing");
    accentParam = apvts.getRawParameterValue ("accent");
    driveParam  = apvts.getRawParameterValue ("drive");
    masterParam = apvts.getRawParameterValue ("master");

    loadDefaultPattern();
    startTimer (1000);
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
    return layout;
}

//==============================================================================
void Pulse16AudioProcessor::prepareToPlay (double sampleRate, int)
{
    sr = sampleRate;
    for (int t = 0; t < drums::kNumTracks; ++t)
        voices[t].prepare (sr, t, 0x1234567u + (uint32_t) t * 7919u);

    lastStepIndex = std::numeric_limits<long long>::min();
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

    // 1. Pads clicked in the UI
    const uint32_t pads = pendingPads.exchange (0);
    for (int t = 0; t < drums::kNumTracks; ++t)
        if (pads & (1u << t))
            addEvent (0, t, 0.9f);

    // 2. Incoming MIDI
    for (const auto meta : midi)
    {
        const auto msg = meta.getMessage();
        if (msg.isNoteOn())
        {
            const int t = noteToTrack (msg.getNoteNumber());
            if (t >= 0) addEvent (meta.samplePosition, t, msg.getFloatVelocity());
        }
    }
    midi.clear();

    // 3. Step sequencer
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
        lastStepIndex = std::numeric_limits<long long>::min();
        lastPpqEnd = -1.0;
    }
    internalRunning = runInternal;

    if (hostPlaying || runInternal)
    {
        const double startPpq = hostPlaying ? ppq : internalPpq;
        const double ppqPerSample = juce::jmax (1.0, bpm) / 60.0 / sr;
        const double endPpq = startPpq + n * ppqPerSample;

        // Transport jumped (cycle loop, locate)? Start fresh.
        if (lastPpqEnd < 0.0 || startPpq < lastPpqEnd - 1.0e-3 || startPpq > lastPpqEnd + 0.25)
            lastStepIndex = std::numeric_limits<long long>::min();

        const double swingDelay = swingParam->load() * 0.1;   // up to ~triplet feel
        const float accentAmt = accentParam->load();
        const float normalVel = 1.0f - 0.5f * accentAmt;

        const auto kFirst = (long long) std::floor (startPpq / 0.25) - 1;
        const auto kLast  = (long long) std::floor (endPpq / 0.25);

        for (long long k = kFirst; k <= kLast; ++k)
        {
            const double when = k * 0.25 + ((k & 1) ? swingDelay : 0.0);
            if (when < startPpq - 1.0e-9 || when >= endPpq || k <= lastStepIndex)
                continue;

            const int offset = (int) ((when - startPpq) / ppqPerSample);
            const int step = (int) (((k % drums::kNumSteps) + drums::kNumSteps) % drums::kNumSteps);

            for (int t = 0; t < drums::kNumTracks; ++t)
            {
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
        lastStepIndex = std::numeric_limits<long long>::min();
        lastPpqEnd = -1.0;
    }

    // Sort events by time (insertion sort: stable, no allocation)
    for (int i = 1; i < numEvents; ++i)
    {
        const Event e = events[i];
        int j = i - 1;
        while (j >= 0 && events[j].offset > e.offset) { events[j + 1] = events[j]; --j; }
        events[j + 1] = e;
    }

    // 4. Render, splitting the block at each event for sample-accurate timing
    int pos = 0;
    for (int i = 0; i < numEvents; ++i)
    {
        renderVoices (L, R, pos, events[i].offset - pos);
        pos = events[i].offset;
        triggerTrack (events[i].track, events[i].velocity);
    }
    renderVoices (L, R, pos, n - pos);

    // 5. Master drive + volume (tanh also acts as a soft safety limiter)
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
    return path.endsWithIgnoreCase (".wav")  || path.endsWithIgnoreCase (".aif")
        || path.endsWithIgnoreCase (".aiff") || path.endsWithIgnoreCase (".flac")
        || path.endsWithIgnoreCase (".mp3")  || path.endsWithIgnoreCase (".ogg")
        || path.endsWithIgnoreCase (".m4a")  || path.endsWithIgnoreCase (".caf");
}

void Pulse16AudioProcessor::setSampleForTrack (int track, std::shared_ptr<const drums::SampleData> data)
{
    std::shared_ptr<const drums::SampleData> old;
    {
        const juce::SpinLock::ScopedLockType lock (sampleLock);
        old = samples[track];
        samples[track] = std::move (data);
    }
    if (old != nullptr)
    {
        const juce::ScopedLock sl (retiredLock);
        retired.push_back (std::move (old));   // freed later once no voice uses it
    }
}

bool Pulse16AudioProcessor::loadSample (int track, const juce::File& file)
{
    std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));
    if (reader == nullptr || reader->sampleRate <= 0.0)
        return false;

    const auto maxLen = (juce::int64) (reader->sampleRate * 20.0);  // 20 s cap
    const int len = (int) juce::jmin (reader->lengthInSamples, maxLen);
    if (len < 4) return false;

    const int numCh = juce::jlimit (1, 2, (int) reader->numChannels);
    juce::AudioBuffer<float> buf (numCh, len);
    reader->read (&buf, 0, len, 0, true, numCh > 1);

    auto data = std::make_shared<drums::SampleData>();
    data->sampleRate = reader->sampleRate;
    data->channels.resize ((size_t) numCh);
    for (int c = 0; c < numCh; ++c)
        data->channels[(size_t) c].assign (buf.getReadPointer (c), buf.getReadPointer (c) + len);

    setSampleForTrack (track, std::move (data));
    sampleFiles[track] = file;

    if (auto* p = apvts.getParameter (paramId ("mode", track)))
        p->setValueNotifyingHost (1.0f);

    return true;
}

void Pulse16AudioProcessor::clearSample (int track)
{
    setSampleForTrack (track, nullptr);
    sampleFiles[track] = juce::File();
    if (auto* p = apvts.getParameter (paramId ("mode", track)))
        p->setValueNotifyingHost (0.0f);
}

juce::String Pulse16AudioProcessor::getSampleName (int track) const
{
    return sampleFiles[track] == juce::File() ? juce::String() : sampleFiles[track].getFileNameWithoutExtension();
}

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
    juce::String pattern;
    for (int t = 0; t < drums::kNumTracks; ++t)
        for (int s = 0; s < drums::kNumSteps; ++s)
            pattern << juce::String ((int) steps[t][s].load());
    extra.setProperty ("pattern", pattern, nullptr);
    for (int t = 0; t < drums::kNumTracks; ++t)
        extra.setProperty ("sample" + juce::String (t), sampleFiles[t].getFullPathName(), nullptr);
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
            const auto path = extra["sample" + juce::String (t)].toString();
            if (path.isNotEmpty() && juce::File (path).existsAsFile())
                loadSample (t, juce::File (path));
        }
        tree.removeChild (extra, nullptr);
    }

    apvts.replaceState (tree);   // restores mode switches etc. after samples load
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
