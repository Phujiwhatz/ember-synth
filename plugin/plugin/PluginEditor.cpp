#include "PluginEditor.h"
#include "StandaloneMidi.h"
#include "BinaryData.h"

static juce::String varToString (const juce::var& v, const char* key)
{
    if (auto* o = v.getDynamicObject()) return o->getProperty (key).toString();
    return {};
}

juce::WebBrowserComponent::Options EmberEditor::makeOptions()
{
    return juce::WebBrowserComponent::Options{}
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider ([this] (const juce::String& url) { return getResource (url); })
        .withEventListener ("ready", [this] (juce::var) { ready = true; sendInit(); })
        .withEventListener ("state", [this] (juce::var v) { proc.setStateFromUI (varToString (v, "json")); })
        .withEventListener ("note", [this] (juce::var v)
        {
            if (auto* o = v.getDynamicObject())
                proc.noteFromUI ((int) o->getProperty ("key"), (int) o->getProperty ("vel"), (bool) o->getProperty ("on"));
        })
        .withEventListener ("panic", [this] (juce::var) { proc.panicFromUI(); })
        .withEventListener ("saveUser", [this] (juce::var v) { proc.saveUserPatches (varToString (v, "json")); });
}

EmberEditor::EmberEditor (EmberProcessor& p)
    : AudioProcessorEditor (p), proc (p), web (makeOptions())
{
    seenVersion = proc.stateVersion.load();
    addAndMakeVisible (web);
    web.goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
    setResizable (true, true);
    setResizeLimits (720, 520, 2600, 2000);
    setSize (1240, 900);
    startTimerHz (30);
}

void EmberEditor::resized() { web.setBounds (getLocalBounds()); }

std::optional<juce::WebBrowserComponent::Resource> EmberEditor::getResource (const juce::String& url)
{
    const auto path = url.fromFirstOccurrenceOf (juce::WebBrowserComponent::getResourceProviderRoot(), false, false);
    if (path.isEmpty() || path == "/" || path.startsWith ("index") || path.startsWith ("/index"))
    {
        juce::WebBrowserComponent::Resource r;
        r.data.resize ((size_t) BinaryData::ui_htmlSize);
        std::memcpy (r.data.data(), BinaryData::ui_html, r.data.size());
        r.mimeType = "text/html";
        return r;
    }
    return std::nullopt;
}

void EmberEditor::sendInit()
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("state", proc.getUIState());
    o->setProperty ("user", proc.loadUserPatches());
    web.emitEventIfBrowserIsVisible ("init", juce::var (o));
    midiNames = juce::StringArray { "?" };   // make the next MIDI check re-send the device list
    midiCountdown = 0;
}

void EmberEditor::sendMidiDevices()
{
    auto* o = new juce::DynamicObject();
    juce::Array<juce::var> list;
    for (auto& n : midiNames) list.add (n);
    o->setProperty ("devices", list);
    web.emitEventIfBrowserIsVisible ("midi", juce::var (o));
}

void EmberEditor::timerCallback()
{
    if (! ready) return;
    if (proc.stateVersion.load() != seenVersion) { seenVersion = proc.stateVersion.load(); sendInit(); }

    if (proc.wrapperType == juce::AudioProcessor::wrapperType_Standalone && --midiCountdown <= 0)
    {
        midiCountdown = 30;   // check about once a second for keyboards being plugged in or out
        if (ember::updateStandaloneMidi (midiSeen, midiNames))
            sendMidiDevices();
    }

    auto& eng = proc.getEngine();
    const auto snap = eng.getSnap();
    auto* o = new juce::DynamicObject();

    float sc[1024];
    eng.scope (sc, 1024);
    juce::Array<juce::var> scope; scope.ensureStorageAllocated (1024);
    for (float x : sc) scope.add (x);
    o->setProperty ("scope", scope);

    juce::Array<juce::var> keys; for (int k : snap.keys) keys.add (k);
    o->setProperty ("keys", keys);
    o->setProperty ("meter", juce::Array<juce::var> { snap.meter[0], snap.meter[1] });
    o->setProperty ("pos", juce::Array<juce::var> { snap.pos[0], snap.pos[1] });
    o->setProperty ("rotor", juce::Array<juce::var> { juce::var (juce::Array<juce::var> { snap.rotor[0][0], snap.rotor[0][1] }),
                                                      juce::var (juce::Array<juce::var> { snap.rotor[1][0], snap.rotor[1][1] }) });
    web.emitEventIfBrowserIsVisible ("tick", juce::var (o));

    for (auto& [slot, key, value] : proc.takeParamChanges())
    {
        auto* p = new juce::DynamicObject();
        p->setProperty ("slot", slot);
        p->setProperty ("key", juce::String (key));
        p->setProperty ("value", value);
        web.emitEventIfBrowserIsVisible ("param", juce::var (p));
    }
}
