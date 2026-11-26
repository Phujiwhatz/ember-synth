// Ember Studio engine: two instrument slots (layer / split), MPE, arpeggiator, effects.
#pragma once
#include "dsp.h"
#include "json.h"
#include <memory>
#include <unordered_map>
#include <string>
#include <vector>
#include <mutex>
#include <atomic>
#include <functional>

namespace ember {

// ---------- parameters: numbers + strings, looked up by name ----------
struct Params {
    std::unordered_map<std::string, double> n;
    std::unordered_map<std::string, std::string> s;
    double operator()(const std::string& k, double def = 0) const { auto it = n.find(k); return it == n.end() ? def : it->second; }
    std::string str(const std::string& k, const std::string& def = "") const { auto it = s.find(k); return it == s.end() ? def : it->second; }
    void set(const std::string& k, const Json& v) { if (v.t == Json::Str) { s[k] = v.s; n.erase(k); } else if (v.isNum()) { n[k] = v.num(); s.erase(k); } }
    static Params fromJson(const Json& o) { Params p; for (auto& kv : o.o) p.set(kv.first, kv.second); return p; }
    Json toJson() const { Json o; o.t = Json::Obj; for (auto& kv : n) o.o[kv.first] = Json(kv.second); for (auto& kv : s) o.o[kv.first] = Json(kv.second); return o; }
};

struct Slot;
// per-block control values shared with a voice
struct Block {
    double sr = 48000;
    double pitchCents = 0;   // total pitch offset for this voice (bend, vibrato, glide)
    double press = 0, timbre = 0;
    double lfo = 0;          // slot LFO value (-1..1) at this block
    double modWheel = 0;
};

struct NoteInfo {
    double f = 440, ratio = 1, sr = 48000; int note = 60; double vel = 100, velG = 1; bool glide = false; double glideTime = 0;
    bool othersHeld = false;
};

struct Voice {
    virtual ~Voice() = default;
    // render n samples (adds into L/R) using block-constant controls
    virtual void render(float* L, float* R, int n, const Block& b) = 0;
    virtual double release() = 0;                // begin release; returns seconds until silent
    virtual void retune(double f) { (void)f; }   // legato: new base frequency
    virtual double meter() const { return -1; } // filter cutoff for the meter (Hz) or -1
    virtual double screenPos() const { return 0; } // wavetable morph offset for the display
    virtual void live(const Params&) {}          // live parameter edits while sounding

    // --- bookkeeping owned by the core ---
    int key = 60, note = 60, ch = 0; double vel = 100;
    bool rel = false, sus = false, killed = false, mono = false;
    double age = 0, relLeft = 1e9;               // seconds since start, seconds of release left
    double bendCents = 0; Smooth pressS, timbreS, bendS;
    double glideCents = 0, glideStep = 0;        // glide: cents still to travel, cents per sample
    double vca = 1, vcaCoef = 1; bool fading = false;
    bool finishedFlag = false;
};

struct Instrument {
    virtual ~Instrument() = default;
    virtual void prepare(double sr) = 0;
    virtual void live(Slot& s, const std::string& key) = 0;      // apply parameter change
    virtual std::unique_ptr<Voice> makeVoice(Slot& s, const NoteInfo& ni) = 0;
    // instrument effect chain (organ rotary, string ensemble...). In-place on stereo buffers.
    virtual void processChain(Slot& s, float* L, float* R, int n, const Block& b) { (void)s; (void)L; (void)R; (void)n; (void)b; }
    virtual void modWheel(Slot& s, double x) { (void)s; (void)x; }
    virtual double screenValue(int which) const { (void)which; return 0; }   // UI read-outs (rotor speed...)
};
std::unique_ptr<Instrument> makeInstrument(const std::string& id);

// ---------- shared effects per slot (drive, chorus, ping-pong delay, reverb) ----------
struct SlotFX {
    double sr = 48000; Drive drive; DelayLine chL, chR; double chPhase = 0; double chWet = 0, chDry = 1;
    DelayLine dl, dr; Biquad dHP, dLP; double dTime = 0.375, dFb = 0.35, dMix = 0.15;
    Reverb rev; double rMix = 0.25, rSize = -1; double outGain = 1.92;
    Smooth sOut, sWet, sDry, sDMix, sRMix, sFb;
    void prepare(double sr_);
    void set(const Params& P);
    void process(float* L, float* R, int n);
};

struct ArpState { struct H { int key, vel, ch, order; bool down; }; std::vector<H> held; int order = 0; long idx = 0; double next = 0; bool running = false, fresh = false; };

struct Slot {
    int idx = 0; std::string instr; Params P; std::unique_ptr<Instrument> inst;
    std::vector<std::unique_ptr<Voice>> voices; std::vector<std::unique_ptr<Voice>> fadingOut;
    struct MonoKey { int key, vel, ch; }; std::vector<MonoKey> monoStack;
    double lastFreq = 0; double lfoPhase = 0; SlotFX fx; ArpState arp;
    std::vector<float> bufL, bufR, vL, vR;
    double gain = 1; Smooth sGain;
    // cached core params
    double lfoRate = 5, lfoVib = 0, modVib = 30, pressVib = 0, pressAmp = 0.3, velSens = 0.6, glide = 0, bendRange = 48;
    std::string playMode = "poly", glideMode = "always";
};

class Engine {
  public:
    Engine();
    void prepare(double sampleRate, int maxBlock);
    // full state from the UI or a saved project: {mode, splitNote, bVol, bOct, dev:{...}, slots:[{instr, P}], ui:{...}}
    void setState(const Json& st);
    std::string getState() const { std::lock_guard<std::mutex> g(stateMx); return stateStr; }
    // MIDI: raw 1-3 byte message
    void midi(const uint8_t* d, int len);
    void uiNote(int key, int vel, bool on) { uint8_t m[3] = {(uint8_t)(on ? 0x90 : 0x80), (uint8_t)key, (uint8_t)(on ? vel : 0)}; midi(m, 3); }
    void panic();
    void process(float* L, float* R, int n, double hostBpm = 0);
    // thread-safe versions for the UI thread (applied at the start of the next audio block)
    void postState(const std::string& json) { std::lock_guard<std::mutex> g(pendMx); pendState = json; hasPendState = true; }
    void postMidi(uint8_t a, uint8_t b, uint8_t c) { std::lock_guard<std::mutex> g(pendMx); pendMidi.push_back({a, b, c}); }
    void postPanic() { std::lock_guard<std::mutex> g(pendMx); pendPanic = true; }
    // called when a MIDI CC changes a parameter (so the UI can follow)
    std::function<void(int, const std::string&, double)> onParam;

    // read-outs for the UI: a snapshot the audio thread refreshes after each block (safe to read from the UI thread)
    struct Snap { std::vector<int> keys; double meter[2] = {-1, -1}; double pos[2] = {0, 0}; double rotor[2][2] = {{0.8, 0.7}, {0.8, 0.7}}; };
    Snap getSnap() const { std::lock_guard<std::mutex> g(snapMx); return snap; }
    void scope(float* out, int n) const;
    double filterMeter(int slot) const;
    std::vector<int> activeKeys() const;
    double screenValue(int slot, int which) const;

  private:
    friend struct Tests;
    double sr = 48000; int maxBlock = 512;
    Slot slots[2];
    std::string mode = "single"; int splitNote = 60; double bVol = 0.8; int bOct = 0;
    Params dev; double tempo = 120;
    bool sustain = false; double modWheel = 0; double globalBend = 0; Smooth bendS;
    double chBend[16]{}, chPress[16]{}, chTimbre[16]{};
    std::unordered_map<int, std::vector<int>> keySlots;
    std::string stateStr; mutable std::mutex stateMx;
    std::vector<float> scopeBuf; int scopeW = 0;
    double hostBpm = 0;
    mutable std::mutex snapMx; Snap snap; void updateSnap();
    std::mutex pendMx; std::string pendState; bool hasPendState = false, pendPanic = false; std::vector<std::array<uint8_t, 3>> pendMidi;
    void drainPending();

    bool isMember(int ch) const;
    void buildSlot(Slot& s);
    void applyCore(Slot& s);
    void noteOn(int key, int vel, int ch);
    void noteOff(int key, int ch);
    void slotNoteOn(Slot& s, int key, int vel, int ch, double delaySec, bool fromArp, Voice** made = nullptr);
    void slotNoteOff(Slot& s, int key, int ch);
    Voice* startVoice(Slot& s, int key, int vel, int ch, bool overlap);
    void releaseVoice(Slot& s, Voice& v, double fast = 0);
    void killVoice(Voice& v);
    void retuneVoice(Slot& s, Voice& v, int key, int ch);
    int noteFor(const Slot& s, int key) const;
    void setSustain(bool on);
    // arpeggiator
    bool arpActive(const Slot& s) const { auto m = s.P.str("arpMode", "off"); return m != "off" && !m.empty(); }
    void arpAdd(Slot& s, int key, int vel, int ch);
    void arpRemove(Slot& s, int key);
    void arpTick(Slot& s, int n);
    std::vector<ArpState::H> arpSeq(const Slot& s) const;
    struct PendingOff { Slot* s; Voice* v; double at; };
    std::vector<PendingOff> arpOffs;
    double now = 0;   // seconds since start
    void renderSlot(Slot& s, float* L, float* R, int n);
};

} // namespace ember
