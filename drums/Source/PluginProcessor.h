#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <limits>
#include "DrumEngine.h"
#include "Library.h"

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
    SoundLibrary library;

    // Pattern: 0 = off, 1 = on, 2 = accent. Shared between UI and audio thread.
    std::atomic<uint8_t> steps[drums::kNumTracks][drums::kNumSteps];
    std::atomic<int> currentStep { -1 };
    std::atomic<float> hitFlash[drums::kNumTracks];   // for pad lights

    // Sounds (message thread unless noted)
    bool loadSound (int track, const juce::String& soundId);  // loads + switches track to sample mode. "" -> synth
    juce::String getSoundId (int track) const;               // "" if synth
    juce::String getSoundName (int track) const;             // display name, "" if synth
    void previewSound (const juce::String& soundId);         // plays once on a hidden preview voice
    juce::StringArray getKitNames() const;
    void loadKit (int kitIndex);                              // sets sounds + params for all 8 tracks

    bool loadSample (int track, const juce::File& file);      // = loadSound (track, "file:" + path)
    void clearSample (int track);
    juce::String getSampleName (int track) const { return getSoundName (track); }

    // Live input
    void triggerPadFromUI (int track, float velocity);        // any thread; recorded when recording
    std::atomic<bool> recording { false };                    // REC: live hits are written into the pattern

    // MIDI learn
    int  getLearnTrack() const;                               // -1 if not learning
    void startMidiLearn (int track);
    void cancelMidiLearn();
    int  getLearnedNote (int track) const;                    // -1 = none
    juce::String describeKeymap (int track) const;            // e.g. "C1 / C" for the UI tooltip

    void clearPattern();
    void loadDefaultPattern();

    static bool isAudioFile (const juce::String& path);

private:
    struct Transport
    {
        bool running = false;
        double startPpq = 0.0, ppqPerSample = 0.0, swingDelay = 0.0;
    };

    void timerCallback() override;
    void triggerTrack (int track, float velocity);
    void renderVoices (float* l, float* r, int start, int num);
    void setSampleForTrack (int track, std::shared_ptr<const drums::SampleData> data);
    void retire (std::shared_ptr<const drums::SampleData> data);
    void recordHit (const Transport& tr, int offset, int track, float velocity);
    int  midiNoteToTrack (int note) const;
    void setParamValue (const juce::String& id, float value);

    drums::Voice voices[drums::kNumTracks];
    drums::Voice previewVoice;

    std::shared_ptr<const drums::SampleData> samples[drums::kNumTracks]; // guarded by sampleLock
    juce::SpinLock sampleLock;
    std::vector<std::shared_ptr<const drums::SampleData>> retired;       // freed on message thread
    juce::CriticalSection retiredLock;

    // Sound IDs per track ("" = synth). missingIds keeps a reference that failed to load so it is re-saved.
    juce::String soundIds[drums::kNumTracks], missingIds[drums::kNumTracks];
    juce::CriticalSection idLock;

    // Preview handoff (message thread -> audio thread)
    std::shared_ptr<const drums::SampleData> pendingPreview;  // guarded by previewLock
    juce::SpinLock previewLock;
    std::atomic<bool> previewPending { false };
    juce::String lastPreviewId;
    std::shared_ptr<const drums::SampleData> lastPreviewData;

    // UI pads / computer keys (lock-free)
    std::atomic<uint32_t> padMask { 0 };
    std::atomic<float> padVelocity[drums::kNumTracks];

    // MIDI learn
    std::atomic<int> learnTrack { -1 };
    std::atomic<int> learnedNote[drums::kNumTracks];

    // Recording: a live hit that rounded forward onto a step that hasn't played yet
    // suppresses that step's trigger once (audio thread only).
    long long skipStep[drums::kNumTracks];

    std::atomic<float>* level[drums::kNumTracks] {};
    std::atomic<float>* tune [drums::kNumTracks] {};
    std::atomic<float>* decay[drums::kNumTracks] {};
    std::atomic<float>* tone [drums::kNumTracks] {};
    std::atomic<float>* pan  [drums::kNumTracks] {};
    std::atomic<float>* mode [drums::kNumTracks] {};
    std::atomic<float>* runParam      = nullptr;
    std::atomic<float>* tempoParam    = nullptr;
    std::atomic<float>* swingParam    = nullptr;
    std::atomic<float>* accentParam   = nullptr;
    std::atomic<float>* driveParam    = nullptr;
    std::atomic<float>* masterParam   = nullptr;
    std::atomic<float>* keymapParam   = nullptr;
    std::atomic<float>* quantizeParam = nullptr;

    double sr = 44100.0;
    double internalPpq = 0.0, lastPpqEnd = -1.0;
    bool internalRunning = false;
    long long lastStepIndex = std::numeric_limits<long long>::min();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (Pulse16AudioProcessor)
};
