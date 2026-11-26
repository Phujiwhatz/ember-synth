#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include "../core/engine.h"
#include <deque>

class EmberProcessor : public juce::AudioProcessor
{
public:
    EmberProcessor();
    ~EmberProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    using AudioProcessor::processBlock;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Ember Studio"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    bool supportsMPE() const override { return true; }
    double getTailLengthSeconds() const override { return 4.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Ember Studio"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // ---- used by the editor ----
    void setStateFromUI (const juce::String& json);
    juce::String getUIState() const { const juce::ScopedLock sl (stateLock); return uiState; }
    void noteFromUI (int key, int vel, bool on) { engine.postMidi ((uint8_t) (on ? 0x90 : 0x80), (uint8_t) key, (uint8_t) (on ? juce::jlimit (1, 127, vel) : 0)); }
    void panicFromUI() { engine.postPanic(); }
    juce::String loadUserPatches() const;
    void saveUserPatches (const juce::String& json) const;
    ember::Engine& getEngine() { return engine; }
    // MIDI-CC parameter changes waiting to be shown in the UI
    std::vector<std::tuple<int, std::string, double>> takeParamChanges();
    std::atomic<int> stateVersion { 0 };   // bumps when the host restores a project

private:
    ember::Engine engine;
    juce::String uiState;
    juce::CriticalSection stateLock;
    std::mutex paramMx;
    std::vector<std::tuple<int, std::string, double>> paramChanges;
    static juce::File userPatchFile();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EmberProcessor)
};
