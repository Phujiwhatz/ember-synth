#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <limits>
#include "DrumEngine.h"

class Pulse16AudioProcessor : public juce::AudioProcessor,
                              private juce::Timer
{
public:
    Pulse16AudioProcessor();
    ~Pulse16AudioProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override  { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 1.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    //==============================================================================
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    static juce::String paramId (const char* base, int track) { return juce::String (base) + juce::String (track); }

    juce::AudioProcessorValueTreeState apvts;

    // Pattern: 0 = off, 1 = on, 2 = accent. Shared between UI and audio thread.
    std::atomic<uint8_t> steps[drums::kNumTracks][drums::kNumSteps];
    std::atomic<int> currentStep { -1 };
    std::atomic<uint32_t> pendingPads { 0 };          // UI pad clicks (bitmask)
    std::atomic<float> hitFlash[drums::kNumTracks];   // for pad lights

    bool loadSample (int track, const juce::File& file);   // message thread
    void clearSample (int track);
    juce::String getSampleName (int track) const;
    void clearPattern();
    void loadDefaultPattern();

    static bool isAudioFile (const juce::String& path);

private:
    void timerCallback() override;
    void triggerTrack (int track, float velocity);
    void renderVoices (float* l, float* r, int start, int num);
    void setSampleForTrack (int track, std::shared_ptr<const drums::SampleData> data);

    drums::Voice voices[drums::kNumTracks];

    std::shared_ptr<const drums::SampleData> samples[drums::kNumTracks]; // guarded by sampleLock
    juce::SpinLock sampleLock;
    std::vector<std::shared_ptr<const drums::SampleData>> retired;       // freed on message thread
    juce::CriticalSection retiredLock;
    juce::File sampleFiles[drums::kNumTracks];
    juce::AudioFormatManager formatManager;

    std::atomic<float>* level[drums::kNumTracks] {};
    std::atomic<float>* tune [drums::kNumTracks] {};
    std::atomic<float>* decay[drums::kNumTracks] {};
    std::atomic<float>* tone [drums::kNumTracks] {};
    std::atomic<float>* pan  [drums::kNumTracks] {};
    std::atomic<float>* mode [drums::kNumTracks] {};
    std::atomic<float>* runParam    = nullptr;
    std::atomic<float>* tempoParam  = nullptr;
    std::atomic<float>* swingParam  = nullptr;
    std::atomic<float>* accentParam = nullptr;
    std::atomic<float>* driveParam  = nullptr;
    std::atomic<float>* masterParam = nullptr;

    double sr = 44100.0;
    double internalPpq = 0.0, lastPpqEnd = -1.0;
    bool internalRunning = false;
    long long lastStepIndex = std::numeric_limits<long long>::min();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Pulse16AudioProcessor)
};
