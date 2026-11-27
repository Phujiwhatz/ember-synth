// Pulse·16 — sound library: built-in sounds (embedded zip) + user folders on disk
#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_data_structures/juce_data_structures.h>
#include <memory>
#include "DrumEngine.h"

struct LibraryEntry
{
    juce::String id;        // "builtin:Kicks/Deep 808.wav" or "file:/Users/x/Music/Pulse 16 Library/Kicks/a.wav"
    juce::String name;      // "Deep 808"
    juce::String category;  // "Kicks" (user files: their parent folder name, or "User")
    bool builtIn = true;
};

// One track of a kit from kits.json
struct KitTrack
{
    juce::String sound;     // "" = synth, otherwise a sound ID
    float level = 0.8f, tune = 0.0f, decay = 0.5f, tone = 0.5f, pan = 0.0f;
};

struct Kit
{
    juce::String name;
    KitTrack tracks[drums::kNumTracks];
};

class SoundLibrary
{
public:
    SoundLibrary();                                          // indexes built-ins + user folders
    void rescan();                                           // message thread
    const juce::Array<LibraryEntry>& getEntries() const;     // message thread only
    juce::StringArray getCategories() const;                 // built-in order first, then user categories
    juce::Array<juce::File> getUserFolders() const;          // includes default folder
    void addUserFolder (const juce::File&);                  // persisted (juce::PropertiesFile), rescans
    void removeUserFolder (const juce::File&);
    static juce::File getDefaultUserFolder();                // ~/Music/Pulse 16 Library (created if missing)
    std::shared_ptr<drums::SampleData> load (const juce::String& soundId) const; // nullptr on failure
    static juce::String displayName (const juce::String& soundId);               // "Deep 808"

    // Kits parsed from the embedded kits.json (falls back to one all-synth kit if none).
    const juce::Array<Kit>& getKits() const { return kits; }

    static const juce::StringArray& builtInCategories();
    static bool isAudioFileName (const juce::String& path);

private:
    void indexBuiltIns();
    void parseKits();
    void scanFolder (const juce::File& root, int& count);
    juce::PropertiesFile& props() const;
    juce::Array<juce::File> getExtraFolders() const;
    void setExtraFolders (const juce::Array<juce::File>&);

    juce::Array<LibraryEntry> entries;
    juce::Array<LibraryEntry> builtInEntries;
    juce::Array<Kit> kits;
    mutable std::unique_ptr<juce::PropertiesFile> properties;
    mutable juce::AudioFormatManager formatManager;
    mutable juce::CriticalSection loadLock;   // load() may be called from non-message threads (state restore)

    JUCE_DECLARE_NON_COPYABLE (SoundLibrary)
};
