// Ember Studio as a proper Mac app: native window (full screen, zoom, remembers its size and place),
// a real menu bar, MIDI keyboards switched on automatically, and the sound saved between launches.
// Compiled only into the Standalone target (see CMakeLists.txt).

#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_plugin_client/Standalone/juce_StandaloneFilterWindow.h>
#include "PluginProcessor.h"

namespace ember
{
using namespace juce;

class MainWindow final : public DocumentWindow
{
public:
    MainWindow (StandalonePluginHolder& h, PropertySet& props)
        : DocumentWindow ("Ember Studio", Colour (0xff120c0b), DocumentWindow::allButtons),
          holder (h), settings (props)
    {
        setUsingNativeTitleBar (true);

        if (auto* ed = holder.processor->createEditorIfNeeded())
        {
            setContentOwned (ed, true);
            const auto area = Desktop::getInstance().getDisplays().getPrimaryDisplay()->userArea;
            centreWithSize (jmin (ed->getWidth(), (int) (area.getWidth() * 0.92)),
                            jmin (ed->getHeight(), (int) (area.getHeight() * 0.92)));
        }
        else
        {
            centreWithSize (900, 600);
        }

        setResizable (true, false);
        setResizeLimits (720, 520, 4000, 3000);

        const auto saved = settings.getValue ("mainWindow");
        if (saved.isNotEmpty())
            restoreWindowStateFromString (saved);

        setVisible (true);
    }

    ~MainWindow() override
    {
        settings.setValue ("mainWindow", getWindowStateAsString());
        clearContentComponent();   // the editor has to go before the processor does
    }

    void closeButtonPressed() override { JUCEApplication::getInstance()->systemRequestedQuit(); }

private:
    StandalonePluginHolder& holder;
    PropertySet& settings;
};

class App final : public JUCEApplication, private MenuBarModel
{
public:
    App()
    {
        PropertiesFile::Options o;
        o.applicationName     = "Ember Studio";
        o.filenameSuffix      = ".settings";
        o.osxLibrarySubFolder = "Application Support";
        o.folderName          = "";
        props.setStorageParameters (o);
    }

    const String getApplicationName() override    { return "Ember Studio"; }
    const String getApplicationVersion() override { return "1.0"; }
    bool moreThanOneInstanceAllowed() override    { return false; }
    void anotherInstanceStarted (const String&) override { if (window) window->toFront (true); }

    void initialise (const String&) override
    {
        holder = std::make_unique<StandalonePluginHolder> (props.getUserSettings(), false, String{}, nullptr,
                                                           Array<StandalonePluginHolder::PluginInOuts>{},
                                                           true /* switch on MIDI keyboards automatically */);
        window = std::make_unique<MainWindow> (*holder, *props.getUserSettings());

       #if JUCE_MAC
        PopupMenu appleExtras;
        appleExtras.addItem (idSettings, "Audio & MIDI Settings...");
        MenuBarModel::setMacMainMenu (this, &appleExtras);
       #endif
    }

    void shutdown() override
    {
       #if JUCE_MAC
        MenuBarModel::setMacMainMenu (nullptr);
       #endif
        window = nullptr;
        holder = nullptr;   // saves the current sound
        props.saveIfNeeded();
    }

    void systemRequestedQuit() override
    {
        if (holder) holder->savePluginState();
        if (window) props.getUserSettings()->setValue ("mainWindow", window->getWindowStateAsString());
        props.saveIfNeeded();

        if (ModalComponentManager::getInstance()->cancelAllModalComponents())
            Timer::callAfterDelay (100, [] { if (auto* a = JUCEApplicationBase::getInstance()) a->systemRequestedQuit(); });
        else
            quit();
    }

private:
    enum { idSettings = 1, idPanic, idFullScreen };

    StringArray getMenuBarNames() override { return { "Sound", "Window" }; }

    PopupMenu getMenuForIndex (int index, const String&) override
    {
        PopupMenu m;
        if (index == 0)
        {
            m.addItem (idPanic, "All Notes Off");
            m.addSeparator();
            m.addItem (idSettings, "Audio & MIDI Settings...");
        }
        else
        {
            m.addItem (idFullScreen, "Toggle Full Screen");
        }
        return m;
    }

    void menuItemSelected (int id, int) override
    {
        if (id == idSettings && holder)
            holder->showAudioSettingsDialog();
        else if (id == idPanic && holder)
            panicAll();
        else if (id == idFullScreen && window)
            window->setFullScreen (! window->isFullScreen());
    }

    void panicAll()
    {
        if (auto* p = dynamic_cast<EmberProcessor*> (holder->processor.get()))
            p->panicFromUI();
    }

    ApplicationProperties props;
    std::unique_ptr<StandalonePluginHolder> holder;
    std::unique_ptr<MainWindow> window;
};
} // namespace ember

juce::JUCEApplicationBase* juce_CreateApplication() { return new ember::App(); }
