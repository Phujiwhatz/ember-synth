#include "Library.h"
#include "BinaryData.h"
#include <algorithm>
#include <cstring>

namespace
{
constexpr int kMaxUserFiles = 5000;
constexpr int kMaxVisited   = 100000;   // stop runaway scans of huge folders
constexpr double kMaxSeconds = 20.0;

const char* const kBuiltInPrefix = "builtin:";
const char* const kFilePrefix    = "file:";

std::shared_ptr<drums::SampleData> decode (std::unique_ptr<juce::AudioFormatReader> reader)
{
    if (reader == nullptr || reader->sampleRate <= 0.0 || reader->numChannels == 0)
        return nullptr;

    const auto maxLen = (juce::int64) (reader->sampleRate * kMaxSeconds);
    const int len = (int) juce::jmin (reader->lengthInSamples, maxLen);
    if (len < 4) return nullptr;

    const int numCh = juce::jlimit (1, 2, (int) reader->numChannels);
    juce::AudioBuffer<float> buf (numCh, len);
    buf.clear();
    if (! reader->read (&buf, 0, len, 0, true, numCh > 1))
        return nullptr;

    auto data = std::make_shared<drums::SampleData>();
    data->sampleRate = reader->sampleRate;
    data->channels.resize ((size_t) numCh);
    for (int c = 0; c < numCh; ++c)
        data->channels[(size_t) c].assign (buf.getReadPointer (c), buf.getReadPointer (c) + len);
    return data;
}

int categoryRank (const juce::String& cat)
{
    const int i = SoundLibrary::builtInCategories().indexOf (cat);
    return i >= 0 ? i : 1000;
}
}

//==============================================================================
const juce::StringArray& SoundLibrary::builtInCategories()
{
    static const juce::StringArray cats { "Kicks", "Snares", "Claps", "Hats", "Cymbals", "Toms", "Percussion", "FX" };
    return cats;
}

bool SoundLibrary::isAudioFileName (const juce::String& path)
{
    static const char* const exts[] = { ".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a", ".caf" };
    for (auto* e : exts)
        if (path.endsWithIgnoreCase (e))
            return true;
    return false;
}

SoundLibrary::SoundLibrary()
{
    formatManager.registerBasicFormats();
    indexBuiltIns();
    parseKits();
    rescan();
}

//==============================================================================
void SoundLibrary::indexBuiltIns()
{
    builtInEntries.clear();
    if (BinaryData::library_zipSize <= 0 || BinaryData::library_zip == nullptr)
        return;

    juce::MemoryInputStream stream (BinaryData::library_zip, (size_t) BinaryData::library_zipSize, false);
    juce::ZipFile zip (stream);

    for (int i = 0; i < zip.getNumEntries(); ++i)
    {
        const auto* e = zip.getEntry (i);
        if (e == nullptr) continue;

        const auto path = e->filename.replaceCharacter ('\\', '/');
        if (path.endsWithChar ('/') || path.startsWith ("__MACOSX") || ! isAudioFileName (path))
            continue;

        const auto fileName = path.fromLastOccurrenceOf ("/", false, false);
        if (fileName.startsWithChar ('.'))
            continue;

        LibraryEntry entry;
        entry.id       = kBuiltInPrefix + path;
        entry.name     = fileName.upToLastOccurrenceOf (".", false, false);
        entry.category = path.containsChar ('/') ? path.upToFirstOccurrenceOf ("/", false, false) : juce::String ("FX");
        entry.builtIn  = true;
        builtInEntries.add (entry);
    }

    std::stable_sort (builtInEntries.begin(), builtInEntries.end(), [] (const LibraryEntry& a, const LibraryEntry& b)
    {
        const int ra = categoryRank (a.category), rb = categoryRank (b.category);
        if (ra != rb) return ra < rb;
        if (a.category != b.category) return a.category.compareNatural (b.category) < 0;
        return a.name.compareNatural (b.name) < 0;
    });
}

void SoundLibrary::parseKits()
{
    kits.clear();

    if (BinaryData::kits_jsonSize > 0 && BinaryData::kits_json != nullptr)
    {
        const auto json = juce::JSON::parse (juce::String::fromUTF8 (BinaryData::kits_json, BinaryData::kits_jsonSize));
        if (auto* arr = json.getProperty ("kits", juce::var()).getArray())
        {
            for (const auto& k : *arr)
            {
                Kit kit;
                kit.name = k.getProperty ("name", juce::var()).toString();
                if (kit.name.isEmpty())
                    kit.name = "Kit " + juce::String (kits.size() + 1);

                if (auto* tracks = k.getProperty ("tracks", juce::var()).getArray())
                {
                    for (int t = 0; t < juce::jmin (drums::kNumTracks, tracks->size()); ++t)
                    {
                        const auto& tv = tracks->getReference (t);
                        auto& kt = kit.tracks[t];
                        auto sound = tv.getProperty ("sound", juce::var()).toString().trim();
                        kt.sound = sound.equalsIgnoreCase ("synth") ? juce::String() : sound;

                        auto num = [&tv] (const char* key, float def, float lo, float hi)
                        {
                            const auto v = tv.getProperty (key, juce::var());
                            return juce::jlimit (lo, hi, (v.isDouble() || v.isInt() || v.isInt64()) ? (float) (double) v : def);
                        };
                        kt.level = num ("level", 0.8f, 0.0f, 1.0f);
                        kt.tune  = num ("tune",  0.0f, -24.0f, 24.0f);
                        kt.decay = num ("decay", 0.5f, 0.0f, 1.0f);
                        kt.tone  = num ("tone",  0.5f, 0.0f, 1.0f);
                        kt.pan   = num ("pan",   0.0f, -1.0f, 1.0f);
                    }
                }
                kits.add (kit);
            }
        }
    }

    if (kits.isEmpty())
    {
        // Fallback so the kit menu is never empty: the plugin's default synth kit.
        const float defaultPan[drums::kNumTracks]   = { 0.0f, 0.0f, 0.1f, 0.2f, 0.2f, -0.25f, 0.25f, -0.15f };
        const float defaultLevel[drums::kNumTracks] = { 0.9f, 0.8f, 0.65f, 0.5f, 0.5f, 0.7f, 0.65f, 0.45f };
        Kit kit;
        kit.name = "Pulse Synth";
        for (int t = 0; t < drums::kNumTracks; ++t)
        {
            kit.tracks[t].level = defaultLevel[t];
            kit.tracks[t].pan   = defaultPan[t];
        }
        kits.add (kit);
    }
}

//==============================================================================
juce::File SoundLibrary::getDefaultUserFolder()
{
    auto dir = juce::File::getSpecialLocation (juce::File::userMusicDirectory).getChildFile ("Pulse 16 Library");

    if (! dir.isDirectory())
    {
        if (dir.createDirectory().wasOk())
        {
            for (auto& c : builtInCategories())
                dir.getChildFile (c).createDirectory();

            dir.getChildFile ("README.txt").replaceWithText (
                "Pulse 16 Library\n"
                "================\n\n"
                "Drop .wav/.aif/.mp3/.flac files here, then press Rescan in Pulse 16.\n\n"
                "Put sounds in a category folder (Kicks, Snares, Claps, Hats, Cymbals, Toms, Percussion, FX)\n"
                "or make your own folders - the folder name becomes the category in the browser.\n"
                "Files placed directly in this folder show up under \"User\".\n\n"
                "Also supported: .aiff .ogg .m4a .caf (sounds longer than 20 seconds are cut off).\n"
                "You can add more folders from the library browser inside Pulse 16.\n");
        }
    }
    return dir;
}

juce::PropertiesFile& SoundLibrary::props() const
{
    if (properties == nullptr)
    {
        juce::PropertiesFile::Options o;
        o.applicationName     = "Pulse 16";
        o.filenameSuffix      = "settings";
        o.folderName          = "Pulse 16";
        o.osxLibrarySubFolder = "Application Support";
        o.storageFormat       = juce::PropertiesFile::storeAsXML;
        o.millisecondsBeforeSaving = 0;
        properties = std::make_unique<juce::PropertiesFile> (o);
    }
    return *properties;
}

juce::Array<juce::File> SoundLibrary::getExtraFolders() const
{
    juce::Array<juce::File> result;
    auto lines = juce::StringArray::fromLines (props().getValue ("userFolders"));
    for (auto& l : lines)
        if (l.trim().isNotEmpty() && juce::File::isAbsolutePath (l.trim()))
            result.addIfNotAlreadyThere (juce::File (l.trim()));
    return result;
}

void SoundLibrary::setExtraFolders (const juce::Array<juce::File>& folders)
{
    juce::StringArray lines;
    for (auto& f : folders)
        lines.add (f.getFullPathName());
    props().setValue ("userFolders", lines.joinIntoString ("\n"));
    props().saveIfNeeded();
}

juce::Array<juce::File> SoundLibrary::getUserFolders() const
{
    juce::Array<juce::File> result;
    result.add (getDefaultUserFolder());
    for (auto& f : getExtraFolders())
        result.addIfNotAlreadyThere (f);
    return result;
}

void SoundLibrary::addUserFolder (const juce::File& folder)
{
    if (folder == juce::File() || folder == getDefaultUserFolder())
        return;

    auto extras = getExtraFolders();
    extras.addIfNotAlreadyThere (folder);
    setExtraFolders (extras);
    rescan();
}

void SoundLibrary::removeUserFolder (const juce::File& folder)
{
    auto extras = getExtraFolders();
    extras.removeAllInstancesOf (folder);
    setExtraFolders (extras);
    rescan();
}

//==============================================================================
void SoundLibrary::scanFolder (const juce::File& root, int& count)
{
    if (! root.isDirectory()) return;

    juce::Array<LibraryEntry> found;
    int visited = 0;

    for (const auto& it : juce::RangedDirectoryIterator (root, true, "*", juce::File::findFiles))
    {
        if (++visited > kMaxVisited || count >= kMaxUserFiles)
            break;

        const auto f = it.getFile();
        const auto fileName = f.getFileName();
        if (fileName.startsWithChar ('.') || it.isHidden() || ! isAudioFileName (fileName))
            continue;

        const auto parent = f.getParentDirectory();
        LibraryEntry e;
        e.id       = kFilePrefix + f.getFullPathName();
        e.name     = f.getFileNameWithoutExtension();
        e.category = parent == root ? juce::String ("User") : parent.getFileName();
        e.builtIn  = false;
        found.add (e);
        ++count;
    }

    std::stable_sort (found.begin(), found.end(), [] (const LibraryEntry& a, const LibraryEntry& b)
    {
        const int ra = categoryRank (a.category), rb = categoryRank (b.category);
        if (ra != rb) return ra < rb;
        if (a.category != b.category) return a.category.compareNatural (b.category) < 0;
        return a.name.compareNatural (b.name) < 0;
    });
    entries.addArray (found);
}

void SoundLibrary::rescan()
{
    if (properties != nullptr)
        properties->reload();   // another plugin instance may have changed the folder list

    entries = builtInEntries;

    const auto folders = getUserFolders();
    int count = 0;
    for (int i = 0; i < folders.size(); ++i)
    {
        // Skip folders nested inside another listed folder (they are scanned already).
        bool nested = false;
        for (int j = 0; j < folders.size(); ++j)
            if (i != j && folders[i].isAChildOf (folders[j]))
                nested = true;
        if (! nested)
            scanFolder (folders[i], count);
    }
}

const juce::Array<LibraryEntry>& SoundLibrary::getEntries() const
{
    return entries;
}

juce::StringArray SoundLibrary::getCategories() const
{
    juce::StringArray cats (builtInCategories());
    juce::StringArray extra;
    for (auto& e : entries)
        if (! cats.contains (e.category))
            extra.addIfNotAlreadyThere (e.category);
    extra.sortNatural();
    cats.addArray (extra);
    return cats;
}

//==============================================================================
std::shared_ptr<drums::SampleData> SoundLibrary::load (const juce::String& soundId) const
{
    const juce::ScopedLock sl (loadLock);

    if (soundId.startsWith (kBuiltInPrefix))
    {
        if (BinaryData::library_zipSize <= 0 || BinaryData::library_zip == nullptr)
            return nullptr;

        const auto path = soundId.substring ((int) strlen (kBuiltInPrefix));
        juce::MemoryInputStream stream (BinaryData::library_zip, (size_t) BinaryData::library_zipSize, false);
        juce::ZipFile zip (stream);

        const int index = zip.getIndexOfFileName (path, true);
        if (index < 0) return nullptr;

        juce::MemoryBlock block;
        {
            std::unique_ptr<juce::InputStream> entryStream (zip.createStreamForEntry (index));
            if (entryStream == nullptr) return nullptr;
            entryStream->readIntoMemoryBlock (block);
        }
        if (block.getSize() == 0) return nullptr;

        return decode (std::unique_ptr<juce::AudioFormatReader> (
            formatManager.createReaderFor (std::make_unique<juce::MemoryInputStream> (std::move (block)))));
    }

    if (soundId.startsWith (kFilePrefix))
    {
        const juce::File f (soundId.substring ((int) strlen (kFilePrefix)));
        if (! f.existsAsFile()) return nullptr;
        return decode (std::unique_ptr<juce::AudioFormatReader> (formatManager.createReaderFor (f)));
    }

    return nullptr;
}

juce::String SoundLibrary::displayName (const juce::String& soundId)
{
    if (soundId.isEmpty()) return {};
    auto path = soundId.fromFirstOccurrenceOf (":", false, false).replaceCharacter ('\\', '/');
    auto fileName = path.fromLastOccurrenceOf ("/", false, false);
    return fileName.containsChar ('.') ? fileName.upToLastOccurrenceOf (".", false, false) : fileName;
}
