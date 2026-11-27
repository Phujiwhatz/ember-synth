#include "engine.h"
#include <algorithm>

namespace ember {

const SineTable& sineTable() { static SineTable t; return t; }
static const char* DEV_KEYS[] = {"mpeMode", "bendRange", "gBend", "transpose", "octave", "tempo"};
static constexpr int MAXV = 16;
static constexpr int CTRL = 32;   // control-rate block

// ---------------- shared slot effects ----------------
void SlotFX::prepare(double s) {
    sr = s; chL.init(0.06, sr); chR.init(0.06, sr); dl.init(2.2, sr); dr.init(2.2, sr); rev.init(sr);
    dHP.set(Biquad::HP, 180, 0, sr); dLP.set(Biquad::LP, 3800, 0, sr);
    for (Smooth* m : {&sOut, &sWet, &sDry, &sDMix, &sRMix, &sFb}) m->setTime(0.02, sr);
}
void SlotFX::set(const Params& P) {
    drive.set(P("drive", 0.15));
    sWet.target = P("chorus", 0.4) * 0.8; sDry.target = 1 - P("chorus", 0.4) * 0.35;
    dTime = P("dTime", 0.375); sFb.target = P("dFb", 0.35); sDMix.target = P("dMix", 0.15);
    sRMix.target = P("rMix", 0.25); sOut.target = P("volume", 0.8) * 2.4;
    double rs = P("rSize", 3); if (std::fabs(rs - rSize) > 0.05) { rSize = rs; rev.setSize(rs); }
}
void SlotFX::process(float* L, float* R, int n) {
    for (int i = 0; i < n; ++i) {
        float l = drive.process(L[i]), r = drive.process(R[i]);
        // chorus: two modulated delays fed from the mono sum, opposite modulation
        chPhase += 0.42 / sr; if (chPhase >= 1) chPhase -= 1;
        double lfo = sineTable()(chPhase);
        float mono = 0.5f * (l + r); chL.push(mono); chR.push(mono);
        float wl = chL.read((0.011 + 0.0022 * lfo) * sr), wr = chR.read((0.016 - 0.0026 * lfo) * sr);
        double dry = sDry.next(), wet = sWet.next();
        float fl = (float)(l * dry + wl * wet), fr = (float)(r * dry + wr * wet);
        // ping-pong delay
        double dmix = sDMix.next(), fb = sFb.next();
        float dlo = dl.read(dTime * sr), dro = dr.read(dTime * sr);
        float din = dHP.process((float)(0.5f * (fl + fr) * dmix), 0) + dLP.process((float)(dro * fb), 0);
        dl.push(din); dr.push(dlo);
        float doL = dlo * 0.9f, doR = dro * 0.9f;
        // reverb
        double rmix = sRMix.next(); float rl, rr;
        rev.process((float)((fl + doL) * rmix), (float)((fr + doR) * rmix), rl, rr);
        double g = sOut.next();
        L[i] = (float)((fl + doL + rl * 0.9f) * g);
        R[i] = (float)((fr + doR + rr * 0.9f) * g);
    }
}

// ---------------- engine ----------------
Engine::Engine() {
    for (int i = 0; i < 2; ++i) slots[i].idx = i;
    slots[0].instr = "ember"; slots[1].instr = "strings";
    dev.n = {{"bendRange", 48}, {"gBend", 2}, {"transpose", 0}, {"octave", 0}, {"tempo", 120}}; dev.s = {{"mpeMode", "auto"}};
    scopeBuf.assign(4096, 0.f);
}
void prewarmTables();
void Engine::prepare(double s, int mb) {
    prewarmTables();
    sr = s; maxBlock = mb; bendS.setTime(0.004, sr);
    for (auto& sl : slots) { sl.bufL.assign(CTRL, 0); sl.bufR.assign(CTRL, 0); sl.vL.assign(CTRL, 0); sl.vR.assign(CTRL, 0); sl.fx.prepare(sr); sl.sGain.setTime(0.02, sr); buildSlot(sl); }
}
bool Engine::isMember(int ch) const { return dev.str("mpeMode", "auto") == "auto" && ch != 0 && ch != 15; }
int Engine::noteFor(const Slot& s, int key) const {
    int n = key + (int)s.P("transpose", 0) + 12 * (int)s.P("octave", 0) + (s.idx == 1 ? 12 * bOct : 0);
    return std::max(0, std::min(127, n));
}
void Engine::buildSlot(Slot& s) {
    s.voices.clear(); s.monoStack.clear(); s.arp = ArpState(); s.lastFreq = 0;
    s.inst = makeInstrument(s.instr);
    if (s.inst) s.inst->prepare(sr);
    applyCore(s);
}
void Engine::applyCore(Slot& s) {
    const Params& P = s.P;
    s.lfoRate = P("lfoRate", 5); s.lfoVib = P("lfoVib", 0); s.modVib = P("modVib", 30); s.pressVib = P("pressVib", 0);
    s.pressAmp = P("pressAmp", 0.3); s.velSens = P("velSens", 0.6); s.glide = P("glide", 0); s.bendRange = P("bendRange", 48);
    s.playMode = P.str("playMode", "poly"); s.glideMode = P.str("glideMode", "always");
    s.fx.set(P);
    s.sGain.target = s.idx == 1 ? bVol : 1.0;
    if (s.inst) s.inst->live(s, "");
}

void Engine::setState(const Json& st) {
    if (st.has("mode")) mode = st["mode"].str();
    if (st.has("splitNote")) splitNote = (int)st["splitNote"].num(60);
    if (st.has("bVol")) bVol = st["bVol"].num(0.8);
    if (st.has("bOct")) bOct = (int)st["bOct"].num(0);
    if (st.has("dev")) for (auto& kv : st["dev"].o) dev.set(kv.first, kv.second);
    const Json& sl = st["slots"];
    for (int i = 0; i < 2 && i < (int)sl.a.size(); ++i) {
        Slot& s = slots[i]; const Json& js = sl.a[i];
        std::string instr = js["instr"].str(); if (instr.empty()) instr = s.instr;
        Params P = Params::fromJson(js["P"]);
        for (auto k : DEV_KEYS) { if (dev.n.count(k)) P.n[k] = dev.n[k]; if (dev.s.count(k)) P.s[k] = dev.s[k]; }
        if (instr != s.instr || !s.inst) { s.instr = instr; s.P = P; buildSlot(s); continue; }
        Params old = s.P; s.P = P;
        if (old.str("playMode") != P.str("playMode")) { s.monoStack.clear(); for (auto& v : s.voices) releaseVoice(s, *v); }
        if (!arpActive(s)) { s.arp.held.clear(); s.arp.running = false; }
        applyCore(s);
        for (auto& kv : P.n) { auto it = old.n.find(kv.first); if (it == old.n.end() || it->second != kv.second) { s.inst->live(s, kv.first); for (auto& v : s.voices) v->live(P); } }
        for (auto& kv : P.s) { auto it = old.s.find(kv.first); if (it == old.s.end() || it->second != kv.second) s.inst->live(s, kv.first); }
    }
    std::lock_guard<std::mutex> g(stateMx); stateStr = st.dump();
}

// ---------------- notes ----------------
void Engine::noteOn(int key, int vel, int ch) {
    if (isMember(ch)) chPress[ch] = 0;
    std::vector<int> ts;
    if (mode == "single") ts = {0}; else if (mode == "layer") ts = {0, 1}; else ts = {key < splitNote ? 1 : 0};
    keySlots[key * 16 + ch] = ts;
    for (int i : ts) slotNoteOn(slots[i], key, vel, ch, 0, false);
}
void Engine::noteOff(int key, int ch) {
    auto it = keySlots.find(key * 16 + ch);
    std::vector<int> ts = it != keySlots.end() ? it->second : std::vector<int>{0, 1};
    if (it != keySlots.end()) keySlots.erase(it);
    for (int i : ts) slotNoteOff(slots[i], key, ch);
}
void Engine::slotNoteOn(Slot& s, int key, int vel, int ch, double, bool fromArp, Voice** made) {
    if (!s.inst) return;
    if (!fromArp && arpActive(s)) { arpAdd(s, key, vel, ch); return; }
    bool overlap = false; for (auto& v : s.voices) if (!v->rel) overlap = true;
    if (s.playMode != "poly" && !fromArp) {
        s.monoStack.erase(std::remove_if(s.monoStack.begin(), s.monoStack.end(), [&](auto& m) { return m.key == key && m.ch == ch; }), s.monoStack.end());
        s.monoStack.push_back({key, vel, ch});
        Voice* cur = nullptr; for (auto& v : s.voices) if (!v->rel && v->mono) { cur = v.get(); break; }
        if (cur && s.playMode == "legato") { retuneVoice(s, *cur, key, ch); return; }
        overlap = s.monoStack.size() > 1;
        for (auto& v : s.voices) if (v->mono && !v->rel) releaseVoice(s, *v, 0.008);
    }
    for (auto& v : s.voices) if (v->key == key && v->ch == ch && !v->rel) releaseVoice(s, *v, 0.02);
    int alive = 0; Voice* oldRel = nullptr; Voice* oldest = nullptr;
    for (auto& v : s.voices) if (!v->killed) { ++alive; if (!oldest) oldest = v.get(); if (v->rel && !oldRel) oldRel = v.get(); }
    if (alive >= MAXV) killVoice(oldRel ? *oldRel : *oldest);
    Voice* v = startVoice(s, key, vel, ch, overlap);
    if (made) *made = v;
}
Voice* Engine::startVoice(Slot& s, int key, int vel, int ch, bool overlap) {
    int note = noteFor(s, key); double f = mtof(note);
    double gf = (s.glide > 0.001 && (s.glideMode == "always" || overlap) && s.lastFreq > 0) ? s.lastFreq : 0;
    s.lastFreq = f;
    NoteInfo ni; ni.f = f; ni.note = note; ni.vel = vel; ni.sr = sr;
    {   // same curve as the browser version: 'Velocity' sets the range (0 = none, 100% = 36 dB)
        const double x = std::clamp(vel / 127.0, 0.0, 1.0), range = s.velSens > 0 ? 36 * std::pow(s.velSens, 0.7) : 0;
        ni.velG = std::pow(10.0, -range * std::pow(1 - x, 1.4) / 20);
    }
    for (auto& v : s.voices) if (!v->rel) ni.othersHeld = true;
    auto vp = s.inst->makeVoice(s, ni);
    if (!vp) return nullptr;
    Voice& v = *vp; v.key = key; v.note = note; v.ch = ch; v.vel = vel; v.mono = s.playMode != "poly";
    v.pressS.setTime(0.012, sr); v.timbreS.setTime(0.01, sr); v.bendS.setTime(0.004, sr);
    v.pressS.reset(chPress[ch]); v.timbreS.reset(isMember(ch) ? chTimbre[ch] : 0);
    v.bendS.reset(isMember(ch) ? chBend[ch] * s.bendRange * 100 : 0);
    if (gf > 0) { v.glideCents = 1200 * std::log2(gf / f); v.glideStep = v.glideCents / (s.glide * sr); }
    s.voices.push_back(std::move(vp));
    return s.voices.back().get();
}
void Engine::retuneVoice(Slot& s, Voice& v, int key, int ch) {
    int note = noteFor(s, key); double cur = v.note * 100.0 + v.glideCents;
    bool g = s.glide > 0.001 && (s.glideMode == "always" || s.monoStack.size() > 1);
    v.glideCents = g ? cur - note * 100.0 : 0; v.glideStep = g ? v.glideCents / (s.glide * sr) : 0;
    if (v.ch != ch) { v.ch = ch; v.bendS.reset(isMember(ch) ? chBend[ch] * s.bendRange * 100 : 0); }
    v.key = key; v.note = note; v.sus = false; s.lastFreq = mtof(note);
    v.retune(mtof(note));
}
void Engine::releaseVoice(Slot&, Voice& v, double fast) {
    if (v.rel) return; v.rel = true;
    if (fast > 0) { v.fading = true; v.vcaCoef = std::exp(-1.0 / (fast / 4 * sr)); v.relLeft = fast * 2 + 0.05; }
    else v.relLeft = v.release();
}
void Engine::killVoice(Voice& v) { v.rel = v.killed = true; v.fading = true; v.vcaCoef = std::exp(-1.0 / (0.005 * sr)); v.relLeft = 0.05; }
void Engine::slotNoteOff(Slot& s, int key, int ch) {
    for (auto& h : s.arp.held) if (h.key == key) { arpRemove(s, key); return; }
    if (s.playMode != "poly") {
        s.monoStack.erase(std::remove_if(s.monoStack.begin(), s.monoStack.end(), [&](auto& m) { return m.key == key && m.ch == ch; }), s.monoStack.end());
        Voice* cur = nullptr; for (auto& v : s.voices) if (!v->rel && v->mono) { cur = v.get(); break; }
        if (cur && cur->key == key && cur->ch == ch) {
            if (!s.monoStack.empty()) { auto nx = s.monoStack.back(); slotNoteOn(s, nx.key, nx.vel, nx.ch, 0, false); }
            else if (sustain) cur->sus = true; else releaseVoice(s, *cur);
        }
        return;
    }
    for (auto& v : s.voices) if (v->key == key && v->ch == ch && !v->rel) { if (sustain) v->sus = true; else releaseVoice(s, *v); }
}
void Engine::setSustain(bool on) {
    sustain = on; if (on) return;
    for (auto& s : slots) {
        if (s.P.str("arpHold", "off") != "on") { auto& h = s.arp.held; h.erase(std::remove_if(h.begin(), h.end(), [](auto& x) { return !x.down; }), h.end()); if (h.empty()) s.arp.running = false; }
        for (auto& v : s.voices) if (v->sus && !v->rel) { v->sus = false; releaseVoice(s, *v); }
    }
}
void Engine::panic() {
    sustain = false;
    for (auto& s : slots) { s.monoStack.clear(); s.arp.held.clear(); s.arp.running = false; for (auto& v : s.voices) releaseVoice(s, *v, 0.02); }
    for (int i = 0; i < 16; ++i) chBend[i] = chPress[i] = chTimbre[i] = 0;
    globalBend = 0; keySlots.clear(); arpOffs.clear();
}

// ---------------- arpeggiator ----------------
static double rateBeats(const std::string& r) {
    if (r == "1/1") return 4; if (r == "1/2") return 2; if (r == "1/4") return 1; if (r == "1/8") return 0.5;
    if (r == "1/8T") return 1.0 / 3; if (r == "1/16T") return 1.0 / 6; if (r == "1/32") return 0.125; return 0.25;
}
void Engine::arpAdd(Slot& s, int key, int vel, int ch) {
    auto& a = s.arp;
    if (s.P.str("arpHold", "off") == "on" && a.fresh) { a.held.clear(); a.fresh = false; }
    a.held.erase(std::remove_if(a.held.begin(), a.held.end(), [&](auto& h) { return h.key == key; }), a.held.end());
    a.held.push_back({key, vel, ch, a.order++, true});
    if (!a.running) { a.running = true; a.idx = 0; a.next = now; }
}
void Engine::arpRemove(Slot& s, int key) {
    auto& a = s.arp; auto it = std::find_if(a.held.begin(), a.held.end(), [&](auto& h) { return h.key == key; }); if (it == a.held.end()) return;
    it->down = false;
    if (s.P.str("arpHold", "off") == "on") { bool any = false; for (auto& h : a.held) if (h.down) any = true; if (!any) a.fresh = true; return; }
    if (sustain) return;
    a.held.erase(it); if (a.held.empty()) a.running = false;
}
std::vector<ArpState::H> Engine::arpSeq(const Slot& s) const {
    auto ns = s.arp.held; std::string m = s.P.str("arpMode", "off");
    if (m == "played") std::sort(ns.begin(), ns.end(), [](auto& a, auto& b) { return a.order < b.order; });
    else std::sort(ns.begin(), ns.end(), [](auto& a, auto& b) { return a.key < b.key; });
    std::vector<ArpState::H> seq; int oct = std::max(1, (int)s.P("arpOct", 1));
    for (int o = 0; o < oct; ++o) for (auto h : ns) { h.key += 12 * o; seq.push_back(h); }
    if (m == "down") std::reverse(seq.begin(), seq.end());
    if (m == "updown" && seq.size() > 2) { for (int i = (int)seq.size() - 2; i >= 1; --i) seq.push_back(seq[i]); }
    return seq;
}
void Engine::arpTick(Slot& s, int n) {
    auto& a = s.arp; if (!a.running) return;
    if (!arpActive(s)) { a.held.clear(); a.running = false; return; }
    double bpm = hostBpm > 0 ? hostBpm : dev("tempo", 120);
    double step = 60.0 / bpm * rateBeats(s.P.str("arpRate", "1/16"));
    if (a.next < now - 0.2) a.next = now;
    double end = now + n / sr;
    while (a.next < end) {
        auto seq = arpSeq(s); if (seq.empty()) { a.running = false; return; }
        std::vector<ArpState::H> notes; std::string m = s.P.str("arpMode");
        if (m == "chord") notes.assign(seq.begin(), seq.begin() + std::min(seq.size(), s.arp.held.size()));
        else if (m == "random") notes.push_back(seq[(size_t)(rand01() * seq.size()) % seq.size()]);
        else notes.push_back(seq[(size_t)(a.idx % (long)seq.size())]);
        for (auto& h : notes) { Voice* v = nullptr; slotNoteOn(s, h.key, h.vel, h.ch, 0, true, &v); if (v) arpOffs.push_back({&s, v, a.next + std::max(0.02, step * s.P("arpGate", 0.5))}); }
        a.idx++; a.next += step;
    }
}

// ---------------- MIDI ----------------
static double ccMap(const std::string& instr, int cc, double x, std::string& key) {
    if (instr == "ember" || instr == "wt") {
        if (cc == 74) { key = instr == "wt" ? "wtPos" : "cutoff"; return instr == "wt" ? x : 40 * std::pow(18000.0 / 40, x); }
        key = "res"; return 0.3 + 17.7 * std::pow(x, 1.6);
    }
    if (instr == "fm") { if (cc == 74) { key = "tone"; return 300 * std::pow(60.0, x); } key = "fb"; return x; }
    if (instr == "organ") { if (cc == 74) { key = "orgDrive"; return x; } key = "orgTone"; return 1500 * std::pow(10.0, x); }
    if (cc == 74) { key = "bright"; return 300 * std::pow(40.0, x); } key = "phDepth"; return x;
}
void Engine::midi(const uint8_t* d, int len) {
    if (len < 1) return;
    int st = d[0], cmd = st & 0xF0, ch = st & 0x0F, d1 = len > 1 ? d[1] : 0, d2 = len > 2 ? d[2] : 0;
    if (cmd == 0x90 && d2 > 0) noteOn(d1, d2, ch);
    else if (cmd == 0x80 || (cmd == 0x90 && d2 == 0)) noteOff(d1, ch);
    else if (cmd == 0xE0) {
        double n = (((d2 << 7) | d1) - 8192) / 8192.0;
        if (isMember(ch)) { chBend[ch] = n; for (auto& s : slots) for (auto& v : s.voices) if (v->ch == ch) v->bendS.target = n * s.bendRange * 100; }
        else globalBend = n;
    }
    else if (cmd == 0xD0) { chPress[ch] = d1 / 127.0; for (auto& s : slots) for (auto& v : s.voices) if (v->ch == ch) v->pressS.target = d1 / 127.0; }
    else if (cmd == 0xA0) { for (auto& s : slots) for (auto& v : s.voices) if (v->key == d1) v->pressS.target = d2 / 127.0; }
    else if (cmd == 0xB0) {
        if (d1 == 74 && isMember(ch)) { chTimbre[ch] = (d2 - 64) / 64.0; for (auto& s : slots) for (auto& v : s.voices) if (v->ch == ch) v->timbreS.target = chTimbre[ch]; }
        else if (d1 == 1) { modWheel = d2 / 127.0; for (auto& s : slots) if (s.inst) s.inst->modWheel(s, modWheel); }
        else if (d1 == 64) setSustain(d2 >= 64);
        else if (d1 == 74 || d1 == 71) {
            for (auto& s : slots) { if (mode == "single" && s.idx == 1) continue; std::string k; double v = ccMap(s.instr, d1, d2 / 127.0, k);
                s.P.n[k] = v; if (s.inst) s.inst->live(s, k); for (auto& vv : s.voices) vv->live(s.P); if (onParam) onParam(s.idx, k, v); }
        }
        else if (d1 == 7) { for (auto& s : slots) { s.P.n["volume"] = d2 / 127.0 * 2; s.fx.set(s.P); if (onParam) onParam(s.idx, "volume", s.P.n["volume"]); } }
        else if (d1 == 120 || d1 == 123) panic();
    }
}

// ---------------- audio ----------------
void Engine::renderSlot(Slot& s, float* L, float* R, int n) {
    std::fill(s.bufL.begin(), s.bufL.begin() + n, 0.f); std::fill(s.bufR.begin(), s.bufR.begin() + n, 0.f);
    s.lfoPhase += s.lfoRate * n / sr; s.lfoPhase -= std::floor(s.lfoPhase);
    Block b; b.sr = sr; b.lfo = sineTable()(s.lfoPhase); b.modWheel = modWheel;
    double gb = bendS.advance(n);
    for (auto& vp : s.voices) {
        Voice& v = *vp;
        double press = v.pressS.advance(n), tim = v.timbreS.advance(n), vb = v.bendS.advance(n);
        if (v.glideCents != 0) { double g = v.glideCents - v.glideStep * n; if ((v.glideStep > 0 && g < 0) || (v.glideStep < 0 && g > 0) || v.glideStep == 0) g = 0; v.glideCents = g; }
        b.press = press; b.timbre = tim;
        b.pitchCents = gb + vb + v.glideCents + b.lfo * (s.lfoVib + modWheel * s.modVib + s.pressVib * press);
        std::fill(s.vL.begin(), s.vL.begin() + n, 0.f); std::fill(s.vR.begin(), s.vR.begin() + n, 0.f);
        v.render(s.vL.data(), s.vR.data(), n, b);
        double pamp = 1 - 0.7 * s.pressAmp + 0.9 * s.pressAmp * press;
        for (int i = 0; i < n; ++i) {
            if (v.fading) v.vca *= v.vcaCoef;
            float g2 = (float)(v.vca * pamp); s.bufL[i] += s.vL[i] * g2; s.bufR[i] += s.vR[i] * g2;
        }
        v.age += n / sr; if (v.rel) v.relLeft -= n / sr;
    }
    s.voices.erase(std::remove_if(s.voices.begin(), s.voices.end(), [](auto& v) { return v->rel && (v->relLeft <= 0 || (v->fading && v->vca < 1e-4)); }), s.voices.end());
    if (s.inst) s.inst->processChain(s, s.bufL.data(), s.bufR.data(), n, b);
    s.fx.process(s.bufL.data(), s.bufR.data(), n);
    double g = s.sGain.advance(n);
    for (int i = 0; i < n; ++i) { L[i] += (float)(s.bufL[i] * g); R[i] += (float)(s.bufR[i] * g); }
}
void Engine::drainPending() {
    std::unique_lock<std::mutex> g(pendMx, std::try_to_lock); if (!g.owns_lock()) return;
    if (hasPendState) { Json j = Json::parse(pendState); hasPendState = false; setState(j); }
    for (auto& m : pendMidi) midi(m.data(), 3); pendMidi.clear();
    if (pendPanic) { panic(); pendPanic = false; }
}
void Engine::process(float* L, float* R, int n, double bpm) {
    drainPending();
    hostBpm = bpm;
    std::fill(L, L + n, 0.f); std::fill(R, R + n, 0.f);
    bendS.target = globalBend * dev("gBend", 2) * 100;
    for (int off = 0; off < n; off += CTRL) {
        int m = std::min(CTRL, n - off);
        for (auto& s : slots) arpTick(s, m);
        for (size_t i = 0; i < arpOffs.size();) {
            auto& po = arpOffs[i];
            if (po.at <= now + m / sr) {
                for (auto& v : po.s->voices) if (v.get() == po.v) { releaseVoice(*po.s, *v); break; }
                arpOffs.erase(arpOffs.begin() + i);
            } else ++i;
        }
        for (auto& s : slots) renderSlot(s, L + off, R + off, m);
        now += m / sr;
    }
    for (int i = 0; i < n; ++i) { L[i] = softClip(L[i]); R[i] = softClip(R[i]); scopeBuf[scopeW] = L[i]; scopeW = (scopeW + 1) % (int)scopeBuf.size(); }
    updateSnap();
}
void Engine::updateSnap() {
    std::unique_lock<std::mutex> g(snapMx, std::try_to_lock); if (!g.owns_lock()) return;
    snap.keys = activeKeys();
    for (int i = 0; i < 2; ++i) {
        snap.meter[i] = filterMeter(i); snap.pos[i] = 0;
        for (auto it = slots[i].voices.rbegin(); it != slots[i].voices.rend(); ++it) if (!(*it)->rel) { snap.pos[i] = (*it)->screenPos(); break; }
        snap.rotor[i][0] = screenValue(i, 0); snap.rotor[i][1] = screenValue(i, 1);
    }
}
void Engine::scope(float* out, int n) const {
    int N = (int)scopeBuf.size(); int start = (scopeW - n + N * 2) % N;
    for (int i = 0; i < n; ++i) out[i] = scopeBuf[(start + i) % N];
}
double Engine::filterMeter(int si) const {
    const Slot& s = slots[si];
    for (auto it = s.voices.rbegin(); it != s.voices.rend(); ++it) if (!(*it)->killed) { double m = (*it)->meter(); if (m > 0) return m; }
    return -1;
}
std::vector<int> Engine::activeKeys() const {
    std::vector<int> k;
    for (auto& s : slots) { for (auto& v : s.voices) if (!v->rel || v->sus) k.push_back(v->key); for (auto& h : s.arp.held) k.push_back(h.key); }
    std::sort(k.begin(), k.end()); k.erase(std::unique(k.begin(), k.end()), k.end()); return k;
}
double Engine::screenValue(int si, int which) const { return slots[si].inst ? slots[si].inst->screenValue(which) : 0; }

} // namespace ember
