#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "BinaryData.h"

EmberProcessor::EmberProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    uiState = juce::String::fromUTF8 (BinaryData::default_state_json, BinaryData::default_state_jsonSize);
    engine.onParam = [this] (int slot, const std::string& key, double value)
    {
        std::lock_guard<std::mutex> g (paramMx);
        if (paramChanges.size() < 256) paramChanges.emplace_back (slot, key, value);
    };
    engine.setState (ember::Json::parse (uiState.toStdString()));
}

bool EmberProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

void EmberProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    engine.prepare (sampleRate, samplesPerBlock);
    engine.postState (getUIState().toStdString());
}

void EmberProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int n = buffer.getNumSamples();
    const int chans = buffer.getNumChannels();
    if (chans == 0 || n == 0) return;

    double bpm = 0;
    if (auto* ph = getPlayHead())
        if (auto pos = ph->getPosition())
            if (auto b = pos->getBpm()) bpm = *b;

    float* L = buffer.getWritePointer (0);
    float* R = chans > 1 ? buffer.getWritePointer (1) : nullptr;
    std::vector<float> monoR;
    if (R == nullptr) { monoR.assign ((size_t) n, 0.0f); R = monoR.data(); }

    // render between MIDI events so notes land on the right sample
    int pos = 0;
    for (const auto meta : midi)
    {
        const int at = juce::jlimit (0, n, meta.samplePosition);
        if (at > pos) { engine.process (L + pos, R + pos, at - pos, bpm); pos = at; }
        engine.midi (meta.data, meta.numBytes);
    }
    if (pos < n) engine.process (L + pos, R + pos, n - pos, bpm);

    if (chans == 1) for (int i = 0; i < n; ++i) L[i] = 0.5f * (L[i] + R[i]);
    for (int c = 2; c < chans; ++c) buffer.clear (c, 0, n);
}

void EmberProcessor::setStateFromUI (const juce::String& json)
{
    { const juce::ScopedLock sl (stateLock); uiState = json; }
    engine.postState (json.toStdString());
}

void EmberProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::MemoryOutputStream out (destData, false);
    out.writeString ("EMBERSTUDIO1");
    out.writeString (getUIState());
}

void EmberProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    juce::MemoryInputStream in (data, (size_t) sizeInBytes, false);
    if (in.readString() != "EMBERSTUDIO1") return;
    const auto json = in.readString();
    if (json.isEmpty()) return;
    setStateFromUI (json);
    ++stateVersion;   // tells an open editor to reload
}

std::vector<std::tuple<int, std::string, double>> EmberProcessor::takeParamChanges()
{
    std::lock_guard<std::mutex> g (paramMx);
    std::vector<std::tuple<int, std::string, double>> out;
    out.swap (paramChanges);
    return out;
}

juce::File EmberProcessor::userPatchFile()
{
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
               .getChildFile ("Ember Studio").getChildFile ("user-patches.json");
}

juce::String EmberProcessor::loadUserPatches() const
{
    const auto f = userPatchFile();
    return f.existsAsFile() ? f.loadFileAsString() : juce::String();
}

void EmberProcessor::saveUserPatches (const juce::String& json) const
{
    const auto f = userPatchFile();
    f.getParentDirectory().createDirectory();
    f.replaceWithText (json);
}

juce::AudioProcessorEditor* EmberProcessor::createEditor() { return new EmberEditor (*this); }

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new EmberProcessor(); }
