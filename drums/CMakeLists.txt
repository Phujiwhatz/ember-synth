cmake_minimum_required(VERSION 3.22)

# Universal binary (Apple Silicon + Intel) and macOS 11+
set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "")
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")

project(Pulse16 VERSION 1.0.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Use a local JUCE folder if present, otherwise download it automatically.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/JUCE/CMakeLists.txt")
    add_subdirectory(JUCE)
else()
    include(FetchContent)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.4
        GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

if(APPLE)
    set(PULSE16_FORMATS AU VST3 Standalone)
else()
    set(PULSE16_FORMATS VST3 Standalone)
endif()

juce_add_plugin(Pulse16
    COMPANY_NAME "Ember Studio"
    BUNDLE_ID "com.emberstudio.pulse16"
    PLUGIN_MANUFACTURER_CODE Embr
    PLUGIN_CODE Pl16
    FORMATS ${PULSE16_FORMATS}
    PRODUCT_NAME "Pulse 16"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    VST3_CATEGORIES Instrument Drum
    COPY_PLUGIN_AFTER_BUILD FALSE)

# Built-in sound library + kits (BinaryData::library_zip, BinaryData::kits_json)
juce_add_binary_data(Pulse16Data SOURCES
    library/library.zip
    library/kits.json)

target_sources(Pulse16 PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/Library.cpp)

target_compile_definitions(Pulse16 PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(Pulse16
    PRIVATE
        Pulse16Data
        juce::juce_audio_utils
        juce::juce_audio_formats
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)
