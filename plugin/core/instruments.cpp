// The five Ember Studio instruments, ported from the browser engines.
#include "engine.h"
#include <map>

namespace ember {

static inline double velBright(double vel) { return vel / 127.0; }
// Web Audio StereoPanner applied to a stereo signal
static inline void stereoPan(float& l, float& r, double pan) {
    if (pan <= 0) { double x = (pan + 1) * PI / 2; float gl = (float)std::cos(x), gr = (float)std::sin(x); float nl = l + r * gl; float nr = r * gr; l = nl; r = nr; }
    else { double x = pan * PI / 2; float gl = (float)std::cos(x), gr = (float)std::sin(x); float nl = l * gl; float nr = r + l * gr; l = nl; r = nr; }
}

// =====================================================================
// Ember·16 — analog-style subtractive voice
// =====================================================================
struct EmberVoice : Voice {
    Slot* s; double sr, f, base; int note;
    struct O { Osc osc; double mult, det; float gl, gr; float lvl; bool fm; };
    std::vector<O> oscs; Osc fmOsc; double fmMult = 0, fmDev = 0, fmTarget = 0, fmCoef = 1;
    double noiseLvl = 0; Noise nz; Biquad f1, f2; FreqEnv fenv; Env amp; double pk = 0.2; double fR = 0.5;
    double vel;
    EmberVoice(Slot& sl, const NoteInfo& ni) : s(&sl), sr(ni.sr), f(ni.f), note(ni.note), vel(ni.vel) {
        const Params& P = sl.P;
        double f1q = std::pow(2.0, P("o1Oct", 0)); int n1 = std::max(1, (int)P("o1Uni", 1)); double width = P("width", 0.8);
        Wave w1 = waveFrom(P.str("o1Wave", "sawtooth"));
        for (int i = 0; i < n1; ++i) {
            double r = n1 > 1 ? (double)i / (n1 - 1) - 0.5 : 0; O o; o.osc.wave = w1; o.osc.phase = n1 > 1 ? rand01() : 0; o.mult = f1q; o.det = r * 2 * P("o1Spread", 12);
            o.lvl = (float)(P("o1Level", 0.8) / std::sqrt((double)n1)); o.fm = true;
            if (n1 > 1) panGains(r * 1.6 * width, o.gl, o.gr); else o.gl = o.gr = 1; oscs.push_back(o);
        }
        if (P("fmAmt", 0) > 0) { fmMult = f1q * P("fmRatio", 1); fmOsc.wave = Wave::Sine; fmDev = P("fmAmt", 0) * f * f1q * P("fmRatio", 1) * (0.4 + 0.6 * vel / 127); fmTarget = fmDev * 0.06; fmCoef = std::exp(-1.0 / (std::max(0.001, P("fmDecay", 1) / 3) * sr)); }
        if (P("o2Level", 0.5) > 0) {
            double m = std::pow(2.0, P("o2Oct", 0) + P("o2Semi", 0) / 12); int n2 = std::max(1, (int)P("o2Uni", 1)); Wave w2 = waveFrom(P.str("o2Wave", "sawtooth"));
            for (int i = 0; i < n2; ++i) { double r = n2 > 1 ? (double)i / (n2 - 1) - 0.5 : 0; O o; o.osc.wave = w2; o.osc.phase = n2 > 1 ? rand01() : 0; o.mult = m;
                o.det = P("o2Detune", 7) + r * 2 * P("o1Spread", 12) * 0.8; o.lvl = (float)(P("o2Level", 0.5) / std::sqrt((double)n2)); o.fm = false;
                if (n2 > 1) panGains(-r * 1.6 * width, o.gl, o.gr); else o.gl = o.gr = 1; oscs.push_back(o); }
        }
        if (P("subLevel", 0) > 0) { O o; o.osc.wave = Wave::Sine; o.mult = f1q / 2; o.det = 0; o.lvl = (float)(P("subLevel", 0) * 0.9); o.gl = o.gr = 1; o.fm = false; oscs.push_back(o); }
        noiseLvl = P("noise", 0) * 0.35;
        base = 1000 * std::pow(2.0, P("keyTrack", 0.5) * (note - 60) / 12.0);
        startEnvs(P, 0);
        pk = 0.2 * ni.velG; amp.start(sr, 0, pk, P("aA", 0.005), P("aD", 0.5), P("aS", 0.8));
    }
    void startEnvs(const Params& P, double) {
        double envOct = P("fEnv", 1) * (1 - P("velFilt", 0.3) + P("velFilt", 0.3) * vel / 127);
        double peak = clampd(base * std::pow(2.0, envOct), 10, 22000), sus = clampd(base * std::pow(2.0, envOct * P("fS", 0.4)), 10, 22000);
        fenv.begin(sr, base, peak, sus, P("fA", 0.005), P("fD", 0.5)); fR = P("fR", 0.5);
    }
    void live(const Params& P) override {
        if (rel) return;
        double envOct = P("fEnv", 1) * (1 - P("velFilt", 0.3) + P("velFilt", 0.3) * vel / 127);
        fenv.retarget(clampd(base * std::pow(2.0, envOct), 10, 22000), clampd(base * std::pow(2.0, envOct * P("fS", 0.4)), 10, 22000), P("fD", 0.5), age);
        if (fenv.stage == FreqEnv::Ramp) fenv.A = std::max(1e-4, P("fA", 0.005));
        if (amp.stage == Env::Attack) { amp.A = std::max(1e-4, P("aA", 0.005)); amp.inc = (pk - amp.v) / std::max(1.0, (amp.A - age) * sr); }
        amp.setDecay(P("aD", 0.5), P("aS", 0.8));
    }
    void render(float* L, float* R, int n, const Block& b) override {
        const Params& P = s->P;
        double res = P("res", 1); double fc = fenv.advance(n) * (P("cutoff", 2000) / 1000) * cents(P("lfoFilt", 0) * b.lfo + P("pressFilt", 1200) * b.press + P("timbreFilt", 1800) * b.timbre);
        f1.set(Biquad::LP, fc, res, sr); f2.set(Biquad::LP, fc, std::min(res * 0.35, 2.0), sr);
        double pm = cents(b.pitchCents);
        for (int i = 0; i < n; ++i) {
            double fmv = 0; if (fmDev > 0) { fmv = fmOsc.next(f * fmMult * pm / sr) * fmDev; fmDev = fmTarget + (fmDev - fmTarget) * fmCoef; }
            float l = 0, r = 0;
            for (auto& o : oscs) { double fr = (f * o.mult + (o.fm ? fmv : 0)) * pm * cents(o.det); float x = o.osc.next(fr / sr) * o.lvl; l += x * o.gl; r += x * o.gr; }
            if (noiseLvl > 0) { float x = nz.next() * (float)noiseLvl; l += x; r += x; }
            l *= 0.5f; r *= 0.5f;
            l = f2.process(f1.process(l, 0), 0); r = f2.process(f1.process(r, 1), 1);
            float a = (float)amp.next(); L[i] += l * a; R[i] += r * a;
        }
    }
    double release() override { fenv.release(fR, base); amp.release(s->P("aR", 0.4)); return s->P("aR", 0.4) * 2 + 0.05; }
    void retune(double nf) override { f = nf; }
    double meter() const override { return fenv.v * s->P("cutoff", 2000) / 1000; }
};
struct EmberInst : Instrument {
    void prepare(double) override {}
    void live(Slot&, const std::string&) override {}
    std::unique_ptr<Voice> makeVoice(Slot& s, const NoteInfo& ni) override { return std::make_unique<EmberVoice>(s, ni); }
};

// =====================================================================
// Ion FM — 4-operator FM
// =====================================================================
struct Alg { std::vector<std::pair<int, int>> mods; std::vector<int> car; };
static const std::map<std::string, Alg>& fmAlgs() {
    static const std::map<std::string, Alg> a = {
        {"1", {{{4, 3}, {3, 2}, {2, 1}}, {1}}}, {"2", {{{2, 1}, {4, 3}}, {1, 3}}}, {"3", {{{2, 1}, {3, 1}, {4, 1}}, {1}}},
        {"4", {{{4, 3}, {3, 1}, {2, 1}}, {1}}}, {"5", {{{4, 1}, {4, 2}, {4, 3}}, {1, 2, 3}}}, {"6", {{{3, 2}, {2, 1}}, {1, 4}}},
        {"7", {{{2, 1}}, {1, 3, 4}}}, {"8", {{}, {1, 2, 3, 4}}}};
    return a;
}
struct FMVoice : Voice {
    Slot* s; double sr, f; Alg alg; double ph[5]{}, ratio[5]{}, det[5]{}, out[5]{}; Env env[5]; double rel_[5]{};
    bool car[5]{}; double pressK[5]{}, timbreK[5]{}; double beta = 0, y1 = 0, y2 = 0; std::vector<int> modsInto[5];
    FMVoice(Slot& sl, const NoteInfo& ni) : s(&sl), sr(ni.sr), f(ni.f) {
        const Params& P = sl.P; auto it = fmAlgs().find(P.str("alg", "1")); alg = it == fmAlgs().end() ? fmAlgs().at("1") : it->second;
        for (int c : alg.car) car[c] = true;
        for (auto& m : alg.mods) modsInto[m.second].push_back(m.first);
        double hi = std::max(0, ni.note - 60), ks = std::pow(2.0, -P("keyScale", 0.3) * hi / 24), velM = 1 - P("velMod", 0.6) + P("velMod", 0.6) * ni.vel / 127;
        beta = P("fb", 0) > 0.02 ? P("fb", 0) * 1.6 : 0;
        for (int i = 1; i <= 4; ++i) {
            std::string k = std::to_string(i); ratio[i] = P("rat" + k, 1); det[i] = P("det" + k, 0);
            double L = P("lvl" + k, 0.4), D = P("dec" + k, 1) * (car[i] ? ks : std::sqrt(ks)), fq = f * ratio[i];
            double peak = car[i] ? L * 0.13 / std::sqrt((double)alg.car.size()) * ni.velG : std::pow(L, 1.5) * 9 * fq * velM * std::pow(ks, 0.6);
            env[i].start(sr, 0, peak, P("atk" + k, 0.002), D, P("sus" + k, 0.3)); rel_[i] = P("rel" + k, 0.4);
            if (!car[i] && P("pressMod", 0.4) > 0) { pressK[i] = fq * 4 * P("pressMod", 0.4) * std::max(0.15, L); timbreK[i] = fq * 2 * P("pressMod", 0.4) * std::max(0.15, L); }
        }
    }
    void render(float* L, float* R, int n, const Block& b) override {
        double pm = cents(b.pitchCents); const SineTable& st = sineTable();
        double add[5]; for (int i = 1; i <= 4; ++i) add[i] = car[i] ? 0 : pressK[i] * b.press + timbreK[i] * b.timbre;
        for (int k = 0; k < n; ++k) {
            double e[5]; for (int i = 1; i <= 4; ++i) e[i] = env[i].next() + add[i];
            for (int i = 4; i >= 1; --i) {
                double fm = 0; for (int m : modsInto[i]) fm += out[m];
                double fr = (f * ratio[i] + fm) * pm * cents(det[i]);
                double sv;
                if (i == 4 && beta > 0) { sv = std::sin(TWO_PI * ph[4] + beta * (y1 + y2) * 0.5); y2 = y1; y1 = sv; }
                else sv = st(ph[i]);
                out[i] = sv * e[i];
                ph[i] += fr / sr; ph[i] -= std::floor(ph[i]);
            }
            double sum = 0; for (int c : alg.car) sum += out[c];
            L[k] += (float)sum; R[k] += (float)sum;
        }
    }
    double release() override { double end = 0; for (int i = 1; i <= 4; ++i) { env[i].release(rel_[i]); end = std::max(end, rel_[i] * 2 + 0.05); } return end; }
    void retune(double nf) override { f = nf; }
};
struct FMInst : Instrument {
    Biquad tone; double sr = 48000; double lastTone = -1;
    void prepare(double s) override { sr = s; }
    void live(Slot&, const std::string&) override {}
    std::unique_ptr<Voice> makeVoice(Slot& s, const NoteInfo& ni) override { return std::make_unique<FMVoice>(s, ni); }
    void processChain(Slot& s, float* L, float* R, int n, const Block&) override {
        double t = s.P("tone", 12000); if (t != lastTone) { tone.set(Biquad::LP, t, 0.5, sr); lastTone = t; }
        for (int i = 0; i < n; ++i) { L[i] = tone.process(L[i], 0); R[i] = tone.process(R[i], 1); }
    }
};

// =====================================================================
// Prism WT — wavetable synth (same tables and band-limiting as the browser worklet)
// =====================================================================
constexpr int WT_F = 32, WT_N = 1024, WT_M = 9;
static void fft(std::vector<double>& re, std::vector<double>& im, bool inv) {
    size_t n = re.size();
    for (size_t i = 1, j = 0; i < n; ++i) { size_t bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { std::swap(re[i], re[j]); std::swap(im[i], im[j]); } }
    for (size_t len = 2; len <= n; len <<= 1) {
        double ang = (inv ? 2 : -2) * PI / len, wr = std::cos(ang), wi = std::sin(ang);
        for (size_t i = 0; i < n; i += len) { double cr = 1, ci = 0;
            for (size_t j = 0; j < len / 2; ++j) { size_t a = i + j, b2 = a + len / 2; double tr = re[b2] * cr - im[b2] * ci, ti = re[b2] * ci + im[b2] * cr;
                re[b2] = re[a] - tr; im[b2] = im[a] - ti; re[a] += tr; im[a] += ti; double ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr; } }
    }
}
struct Table { std::vector<float> data; };
static double wtTime(const std::string& id, double p, double x) {
    if (id == "pwm") return p < 0.5 - 0.46 * x ? 1 : -1;
    if (id == "sync") return std::sin(TWO_PI * p * (1 + 7 * x));
    if (id == "growl") return std::sin(TWO_PI * p + 6 * x * std::sin(4 * PI * p));
    if (id == "crush") { int Lv = (int)std::lround(64 * std::pow(1 - x, 2)) + 2; double s = p < 0.5 ? 2 * p : 2 * p - 2; return std::round(s * Lv) / Lv; }
    // basic shapes: sine -> triangle -> saw -> square
    double sh[4] = {std::sin(TWO_PI * p), p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4, p < 0.5 ? 2 * p : 2 * p - 2, p < 0.5 ? 1.0 : -1.0};
    double s = x * 3; int i = std::min(2, (int)std::floor(s)); double fr = s - i; return sh[i] * (1 - fr) + sh[i + 1] * fr;
}
static double wtSpec(const std::string& id, int k, double x) {
    if (id == "vocal") {
        static const double V[5][3] = {{800, 1150, 2900}, {400, 1600, 2700}, {270, 2300, 3000}, {450, 800, 2830}, {325, 700, 2530}};
        double s = x * 4; int i = std::min(3, (int)std::floor(s)); double fr = s - i, fq = k * 130.0, a = 0; const double bw[3] = {90, 120, 170}, g[3] = {1, 0.5, 0.25};
        for (int j = 0; j < 3; ++j) { double F = V[i][j] * (1 - fr) + V[i + 1][j] * fr; a += g[j] * std::exp(-((fq - F) * (fq - F)) / (2 * bw[j] * bw[j])); }
        return a / std::sqrt((double)k) * 0.9 + (k == 1 ? 0.2 : 0);
    }
    if (id == "sweep") { double c = 1 + 38 * x; return std::exp(-((k - c) * (k - c)) / 18) + (k == 1 ? 0.45 : 0); }
    if (id == "bells") { const int Pp[8] = {1, 3, 5, 9, 13, 17, 23, 29}; for (int j = 0; j < 8; ++j) if (Pp[j] == k) return (0.55 + 0.45 * std::cos(TWO_PI * (x * 1.5 + j * 0.17))) / std::sqrt(j + 1.0); return 0; }
    // organ morph
    static const std::map<int, std::pair<double, double>> A = {{1, {1, 0.6}}, {2, {0.8, 0.2}}, {3, {0.6, 0.9}}, {4, {0.5, 0.3}}, {6, {0.15, 0.7}}, {8, {0.1, 0.6}}, {10, {0, 0.4}}, {12, {0, 0.35}}, {16, {0, 0.3}}};
    auto it = A.find(k); return it == A.end() ? 0 : it->second.first * (1 - x) + it->second.second * x;
}
static const Table& wtTable(std::string id) {
    static std::map<std::string, Table> cache; static std::mutex mx; std::lock_guard<std::mutex> g(mx);
    static const char* ids[] = {"basic", "pwm", "vocal", "sync", "growl", "sweep", "bells", "crush", "organ"};
    bool known = false; for (auto k : ids) if (id == k) known = true; if (!known) id = "basic";
    auto it = cache.find(id); if (it != cache.end()) return it->second;
    Table t; t.data.assign((size_t)WT_F * WT_M * WT_N, 0.f);
    bool isTime = (id == "basic" || id == "pwm" || id == "sync" || id == "growl" || id == "crush");
    const int S = 2048;
    for (int fr = 0; fr < WT_F; ++fr) {
        double x = fr / (double)(WT_F - 1); std::vector<double> hr(513, 0), hi(513, 0);
        if (isTime) { std::vector<double> re(S), im(S, 0); for (int i = 0; i < S; ++i) re[i] = wtTime(id, i / (double)S, x); fft(re, im, false); for (int k = 1; k <= 512; ++k) { hr[k] = re[k] * 2 / S; hi[k] = im[k] * 2 / S; } }
        else for (int k = 1; k <= 512; ++k) hi[k] = -wtSpec(id, k, x);
        double norm = 1;
        for (int m = 0; m < WT_M; ++m) {
            int cap = 512 >> m; std::vector<double> re(WT_N, 0), im(WT_N, 0);
            for (int k = 1; k <= std::min(cap, 511); ++k) { re[k] = hr[k] / 2; im[k] = hi[k] / 2; re[WT_N - k] = hr[k] / 2; im[WT_N - k] = -hi[k] / 2; }
            fft(re, im, true);
            if (m == 0) { double pk = 0; for (double v : re) pk = std::max(pk, std::fabs(v)); norm = pk > 1e-6 ? 0.9 / pk : 1; }
            float* dst = &t.data[((size_t)fr * WT_M + m) * WT_N]; for (int i = 0; i < WT_N; ++i) dst[i] = (float)(re[i] * norm);
        }
    }
    return cache.emplace(id, std::move(t)).first->second;
}
struct WTOsc {
    const Table* tb = nullptr; int U = 1; std::vector<double> ph, mul; std::vector<float> gl, gr;
    void init(const Table& t, int uni, double spread, double width) {
        tb = &t; U = std::max(1, uni); ph.resize(U); mul.resize(U); gl.resize(U); gr.resize(U);
        for (int u = 0; u < U; ++u) { double r = U > 1 ? ((double)u / (U - 1) - 0.5) * 2 : 0; ph[u] = U > 1 ? rand01() : 0; mul[u] = std::pow(2.0, r * spread / 1200);
            double a = (r * width + 1) * PI / 4; gl[u] = (float)(std::cos(a) / std::sqrt((double)U)); gr[u] = (float)(std::sin(a) / std::sqrt((double)U)); }
    }
    inline void next(double f, double pos, double sr, float& l, float& r) {
        const float* D = tb->data.data(); pos = clampd(pos, 0, 1);
        double fp = pos * (WT_F - 1); int f0 = (int)std::floor(fp), f1 = std::min(WT_F - 1, f0 + 1); double fx = fp - f0;
        for (int u = 0; u < U; ++u) {
            double inc = f * mul[u] / sr, allowed = 0.5 / inc; int m = 0; while (m < WT_M - 1 && (512 >> m) > allowed) ++m;
            double p = ph[u] * WT_N; int i0 = (int)p, i1 = (i0 + 1) & (WT_N - 1); double px = p - i0;
            size_t b0 = ((size_t)f0 * WT_M + m) * WT_N, b1 = ((size_t)f1 * WT_M + m) * WT_N;
            double a = D[b0 + i0] + (D[b0 + i1] - D[b0 + i0]) * px, bb = D[b1 + i0] + (D[b1 + i1] - D[b1 + i0]) * px, sv = a + (bb - a) * fx;
            l += (float)(sv * gl[u]); r += (float)(sv * gr[u]);
            double q = ph[u] + inc; if (q >= 1) q -= 1; ph[u] = q;
        }
    }
};
struct WTVoice : Voice {
    Slot* s; double sr, f, base; int note; double vel;
    WTOsc A, B; bool hasB = false; double bMult = 1, bDet = 0, bLvl = 0; Osc sub; double subLvl = 0, noiseLvl = 0; Noise nz;
    Env posEnv; std::vector<Biquad> flt; std::vector<Biquad::Type> types; FreqEnv fenv; Env amp; double fR;
    WTVoice(Slot& sl, const NoteInfo& ni) : s(&sl), sr(ni.sr), f(ni.f), note(ni.note), vel(ni.vel) {
        const Params& P = sl.P;
        A.init(wtTable(P.str("wtTable", "basic")), (int)P("uni", 3), P("spread", 14), P("width", 0.8));
        if (P("bLevel", 0) > 0) { hasB = true; B.init(wtTable(P.str("bTable", "basic")), 1, 0, 0); bMult = std::pow(2.0, P("bSemi", 12) / 12); bDet = P("bDet", 5); bLvl = P("bLevel", 0); }
        subLvl = P("subLevel", 0) * 0.8; sub.wave = Wave::Sine; noiseLvl = P("noise", 0) * 0.35;
        posEnv.start(sr, 0, P("pEnv", 0), P("pA", 0.5), P("pD", 1.5), P("pS", 0.5));
        std::string ft = P.str("fType", "lp24");
        if (ft == "lp12") types = {Biquad::LP}; else if (ft == "bp") types = {Biquad::BP}; else if (ft == "hp") types = {Biquad::HP}; else types = {Biquad::LP, Biquad::LP};
        flt.resize(types.size());
        base = 1000 * std::pow(2.0, P("keyTrack", 0.5) * (note - 60) / 12.0);
        double envOct = P("fEnv", 1) * (1 - P("velFilt", 0.3) + P("velFilt", 0.3) * vel / 127);
        fenv.begin(sr, base, clampd(base * std::pow(2.0, envOct), 10, 22000), clampd(base * std::pow(2.0, envOct * P("fS", 0.5)), 10, 22000), P("fA", 0.005), P("fD", 0.6));
        fR = P("fR", 0.6);
        amp.start(sr, 0, 0.22 * ni.velG, P("aA", 0.005), P("aD", 0.6), P("aS", 0.85));
    }
    void render(float* L, float* R, int n, const Block& b) override {
        const Params& P = s->P; double res = P("res", 1.2);
        double fc = fenv.advance(n) * (P("cutoff", 4000) / 1000) * cents(P("lfoFilt", 0) * b.lfo + P("pressFilt", 900) * b.press);
        for (size_t i = 0; i < flt.size(); ++i) flt[i].set(types[i], fc, i ? std::min(res * 0.35, 2.0) : res, sr);
        double pm = cents(b.pitchCents), fr = f * pm;
        double posMod = P("lfoPos", 0) * b.lfo + P("pressPos", 0.3) * b.press + P("pressPos", 0.3) * 0.5 * b.timbre;
        double posA = P("wtPos", 0.3) + posMod, posB = P("bPos", 0.5) + posMod;
        for (int i = 0; i < n; ++i) {
            double pe = posEnv.next(); float l = 0, r = 0;
            A.next(fr, posA + pe, sr, l, r);
            if (hasB) { float bl = 0, br = 0; B.next(fr * bMult * cents(bDet), posB + pe, sr, bl, br); l += bl * (float)bLvl; r += br * (float)bLvl; }
            if (subLvl > 0) { float x = sub.next(fr * 0.5 / sr) * (float)subLvl; l += x; r += x; }
            if (noiseLvl > 0) { float x = nz.next() * (float)noiseLvl; l += x; r += x; }
            l *= 0.9f; r *= 0.9f;
            for (auto& q : flt) { l = q.process(l, 0); r = q.process(r, 1); }
            float a = (float)amp.next(); L[i] += l * a; R[i] += r * a;
        }
    }
    double release() override { fenv.release(fR, base); amp.release(s->P("aR", 0.5)); return s->P("aR", 0.5) * 2 + 0.05; }
    void retune(double nf) override { f = nf; }
    double meter() const override { return fenv.v * s->P("cutoff", 4000) / 1000; }
    double screenPos() const override { return posEnv.v; }
};
struct WTInst : Instrument {
    void prepare(double) override {}
    void live(Slot& s, const std::string& k) override { if (k.empty() || k == "wtTable") wtTable(s.P.str("wtTable", "basic")); if (k.empty() || k == "bTable") wtTable(s.P.str("bTable", "basic")); }
    std::unique_ptr<Voice> makeVoice(Slot& s, const NoteInfo& ni) override { return std::make_unique<WTVoice>(s, ni); }
};

// =====================================================================
// Tonewheel B3 — drawbar organ, percussion, scanner, drive, rotary speaker
// =====================================================================
static const int DB_HARM[9] = {1, 3, 2, 4, 6, 8, 10, 12, 16};
struct OrganVoice : Voice {
    Slot* s; double sr, f; double ph = 0; Env amp; double percLvl = 0, percCoef = 0, percPh = 0, percMult = 0; double clickLvl = 0, clickCoef = 0; Biquad clickBP; Noise nz;
    OrganVoice(Slot& sl, const NoteInfo& ni) : s(&sl), sr(ni.sr), f(ni.f) {
        const Params& P = sl.P;
        amp.start(sr, 0, ni.velG * 0.36, 0.005, 1, 1);
        std::string perc = P.str("perc", "off");
        if (perc != "off" && !ni.othersHeld) { percMult = perc == "2nd" ? 2 : 3; percLvl = (P.str("percVol", "normal") == "soft" ? 0.09 : 0.18) * ni.velG; percCoef = std::exp(-1.0 / ((P.str("percDecay", "fast") == "fast" ? 0.12 : 0.38) * sr)); }
        if (P("click", 0.4) > 0) { clickLvl = P("click", 0.4) * 0.22; clickCoef = std::exp(-1.0 / (0.004 * sr)); clickBP.set(Biquad::BP, 1200 + rand01() * 2500, 1.2, sr); }
    }
    void render(float* L, float* R, int n, const Block& b) override {
        const Params& P = s->P; double pm = cents(b.pitchCents), f0 = f / 2 * pm; const SineTable& st = sineTable();
        double amps[9]; double nyq = sr * 0.5;
        for (int h = 0; h < 9; ++h) { double d = std::floor(P("db" + std::to_string(h + 1), h < 3 ? 8 : 0)); amps[h] = (d > 0 && DB_HARM[h] * f0 < nyq) ? 0.13 * std::pow(10.0, -(8 - d) * 3 / 20) : 0; }
        for (int i = 0; i < n; ++i) {
            double x = 0; for (int h = 0; h < 9; ++h) if (amps[h] > 0) x += amps[h] * st(ph * DB_HARM[h]);
            ph += f0 / sr; if (ph >= 1) ph -= 1;
            if (percLvl > 1e-5) { x += st(percPh) * percLvl; percPh += f * percMult * pm / sr; percPh -= std::floor(percPh); percLvl *= percCoef; }
            float a = (float)amp.next(); float y = (float)x * a;
            if (clickLvl > 1e-5) { y += clickBP.process(nz.next(), 0) * (float)clickLvl; clickLvl *= clickCoef; }
            L[i] += y; R[i] += y;
        }
    }
    double release() override { double r = s->P("orgRel", 0.04); amp.release(r); return r * 2 + 0.05; }
    void retune(double nf) override { f = nf; }
};
struct OrganInst : Instrument {
    double sr = 48000; Biquad tone; double lastTone = -1;
    DelayLine scan; double scanPh = 0; Smooth sDepth, sDry, sWet; Drive drv; double lastDrive = -1;
    Smooth sByp, sRot;
    struct Rotor { Biquad flt; DelayLine del; double ph = 0, speed = 0.8, target = 0.8, upTau, downTau, base, dDepth, aDepth, pDepth; } drum, horn;
    double modW = 0;
    void prepare(double s) override {
        sr = s; scan.init(0.02, sr); for (Smooth* m : {&sDepth, &sDry, &sWet, &sByp, &sRot}) m->setTime(0.03, sr);
        drum.flt.set(Biquad::LP, 800, 0.6, sr); horn.flt.set(Biquad::HP, 800, 0.6, sr);
        drum.del.init(0.03, sr); horn.del.init(0.03, sr);
        drum.base = 0.004; drum.dDepth = 0.00025; drum.aDepth = 0.15; drum.pDepth = 0.35; drum.upTau = 1.4; drum.downTau = 2.2; drum.speed = 0.7;
        horn.base = 0.002; horn.dDepth = 0.0006; horn.aDepth = 0.35; horn.pDepth = 0.8; horn.upTau = 0.35; horn.downTau = 0.55; horn.speed = 0.8;
    }
    std::string speedMode(const Slot& s) const { std::string r = s.P.str("rotary", "slow"); if (r == "off") return "off"; return ((r == "fast") != (modW > 0.5)) ? "fast" : "slow"; }
    void live(Slot& s, const std::string&) override {
        const Params& P = s.P; static const std::map<std::string, std::array<double, 3>> SC = {{"off", {0, 1, 0}}, {"V1", {0.00025, 0, 1}}, {"V2", {0.0005, 0, 1}}, {"V3", {0.0009, 0, 1}}, {"C1", {0.00025, 0.6, 0.6}}, {"C2", {0.0005, 0.6, 0.6}}, {"C3", {0.0009, 0.6, 0.6}}};
        auto it = SC.find(P.str("scan", "C3")); auto sc = it == SC.end() ? SC.at("off") : it->second;
        sDepth.target = sc[0]; sDry.target = sc[1]; sWet.target = sc[2];
        double d = P("orgDrive", 0.2) * 0.9; if (d != lastDrive) { drv.set(d); lastDrive = d; }
        std::string sp = speedMode(s); sByp.target = sp == "off" ? 1 : 0; sRot.target = sp == "off" ? 0 : 1;
        horn.target = sp == "fast" ? 6.7 : 0.8; drum.target = sp == "fast" ? 5.8 : 0.7;
    }
    void modWheel(Slot& s, double x) override { modW = x; live(s, ""); }
    std::unique_ptr<Voice> makeVoice(Slot& s, const NoteInfo& ni) override { return std::make_unique<OrganVoice>(s, ni); }
    void processChain(Slot& s, float* L, float* R, int n, const Block&) override {
        double t = s.P("orgTone", 9000); if (t != lastTone) { tone.set(Biquad::LP, t, 0.4, sr); lastTone = t; }
        for (Rotor* r : {&horn, &drum}) { double tau = r->target > r->speed ? r->upTau : r->downTau; r->speed = r->target + (r->speed - r->target) * std::exp(-n / (tau * sr)); }
        const SineTable& st = sineTable();
        for (int i = 0; i < n; ++i) {
            float l = tone.process(L[i], 0), r = tone.process(R[i], 1);
            scanPh += 6.9 / sr; if (scanPh >= 1) scanPh -= 1;
            float m = 0.5f * (l + r); scan.push(m); float w = scan.read((0.0015 + sDepth.next() * st(scanPh)) * sr);
            double dry = sDry.next(), wet = sWet.next(); l = (float)(l * dry + w * wet); r = (float)(r * dry + w * wet);
            l = drv.process(l); r = drv.process(r);
            double byp = sByp.next(), rot = sRot.next(); float ol = (float)(l * byp), orr = (float)(r * byp);
            if (rot > 1e-4) {
                for (Rotor* ro : {&drum, &horn}) {
                    ro->ph += ro->speed / sr; if (ro->ph >= 1) ro->ph -= 1;
                    double sn = st(ro->ph), co = st(ro->ph + 0.25);
                    float x = ro->flt.process((float)(0.5 * (l + r) * rot), 0);
                    ro->del.push(x); float y = ro->del.read((ro->base + sn * ro->dDepth) * sr) * (float)(1 + co * ro->aDepth);
                    y *= 0.6f;   // calibrated to the browser version's rotary level
                    float yl = y, yr = y; stereoPan(yl, yr, co * ro->pDepth); ol += yl; orr += yr;
                }
            }
            L[i] = ol; R[i] = orr;
        }
    }
    double screenValue(int which) const override { return which == 0 ? horn.speed : drum.speed; }
};

// =====================================================================
// Ensemble 70 — string machine, choir formants, ensemble chorus, phaser
// =====================================================================
struct StringsVoice : Voice {
    Slot* s; double sr, f; struct R_ { Osc o; double mult, det, lvl; bool choir; }; std::vector<R_> regs;
    Biquad form[3]; double formG[3]{}; Biquad lp; double base, bow, aA; double lpV, lpCoef; Env amp;
    StringsVoice(Slot& sl, const NoteInfo& ni) : s(&sl), sr(ni.sr), f(ni.f) {
        const Params& P = sl.P; double drift = P("drift", 6);
        auto add = [&](Wave w, double mult, double lvl, bool choir) { if (lvl <= 0) return; R_ r; r.o.wave = w; r.o.phase = rand01(); r.mult = mult; r.det = (rand01() * 2 - 1) * drift; r.lvl = lvl * 0.42; r.choir = choir; regs.push_back(r); };
        add(Wave::Saw, 0.5, P("lvl16", 0.3), false); add(Wave::Saw, 1, P("lvl8", 0.8), false); add(Wave::Pulse, 1, P("lvlViola", 0.3), false); add(Wave::Saw, 2, P("lvl4", 0.5), false);
        if (P("choir", 0) > 0) {
            add(Wave::Saw, 1, P("choir", 0) * 1.6, true);
            std::string vw = P.str("vowel", "ah"); double F[3][2];
            if (vw == "oo") { double t[3][2] = {{300, 1}, {870, 0.45}, {2240, 0.2}}; std::copy(&t[0][0], &t[0][0] + 6, &F[0][0]); }
            else if (vw == "ee") { double t[3][2] = {{270, 1}, {2290, 0.4}, {3010, 0.3}}; std::copy(&t[0][0], &t[0][0] + 6, &F[0][0]); }
            else if (vw == "oh") { double t[3][2] = {{450, 1}, {800, 0.55}, {2830, 0.2}}; std::copy(&t[0][0], &t[0][0] + 6, &F[0][0]); }
            else { double t[3][2] = {{700, 1}, {1220, 0.5}, {2600, 0.28}}; std::copy(&t[0][0], &t[0][0] + 6, &F[0][0]); }
            for (int i = 0; i < 3; ++i) { form[i].set(Biquad::BP, F[i][0], 9, sr); formG[i] = F[i][1] * 3.2; }
        }
        base = 1000 * std::pow(2.0, P("keyTrack", 0.4) * (ni.note - 60) / 12.0); bow = P("bow", 0.6); aA = P("aA", 0.35);
        lpV = std::pow(2.0, -bow); lpCoef = std::exp(-1.0 / (std::max(0.01, aA) * 0.7 * sr));
        amp.start(sr, 0, 0.142 * ni.velG, aA, std::max(0.2, aA), P("aS", 1));
    }
    void render(float* L, float* R, int n, const Block& b) override {
        const Params& P = s->P; double pm = cents(b.pitchCents);
        lpV = 1 + (lpV - 1) * std::pow(lpCoef, n);
        lp.set(Biquad::LP, base * lpV * (P("bright", 3200) / 1000) * cents(P("pressBright", 0.5) * 2400 * b.press), 0.5, sr);
        for (int i = 0; i < n; ++i) {
            double v = 0, c = 0;
            for (auto& r : regs) { double x = r.o.next(f * r.mult * pm * cents(r.det) / sr) * r.lvl; if (r.choir) c += x; else v += x; }
            if (c != 0) for (int k = 0; k < 3; ++k) v += form[k].process((float)c, 0) * formG[k];
            float y = lp.process((float)v, 0) * (float)amp.next(); L[i] += y; R[i] += y;
        }
    }
    double release() override { double r = s->P("aR", 1.2); amp.release(r); return r * 2 + 0.05; }
    void retune(double nf) override { f = nf; }
};
struct StringsInst : Instrument {
    double sr = 48000; DelayLine d[3]; double slowPh = 0, fastPh = 0; Smooth sWet, sDry, sPWet, sPDry; double depth = 0.8;
    Biquad ap[6]; double phPh = 0;
    void prepare(double s) override { sr = s; for (auto& x : d) x.init(0.04, sr); for (Smooth* m : {&sWet, &sDry, &sPWet, &sPDry}) m->setTime(0.03, sr); }
    void live(Slot& s, const std::string&) override {
        const Params& P = s.P; depth = P("ensDepth", 0.8);
        sWet.target = P("ensMix", 0.85) * 1.1; sDry.target = 1 - P("ensMix", 0.85) * 0.75;
        sPWet.target = P("phMix", 0) * 0.8; sPDry.target = 1 - P("phMix", 0) * 0.2;
    }
    std::unique_ptr<Voice> makeVoice(Slot& s, const NoteInfo& ni) override { return std::make_unique<StringsVoice>(s, ni); }
    void processChain(Slot& s, float* L, float* R, int n, const Block&) override {
        const Params& P = s.P; const SineTable& st = sineTable();
        phPh += P("phRate", 0.25) * n / sr; phPh -= std::floor(phPh);
        double apF = 500 * cents(st(phPh) * P("phDepth", 0) * 2400);
        for (auto& a : ap) a.set(Biquad::AP, apF, 0.6, sr);
        for (int i = 0; i < n; ++i) {
            slowPh += 0.62 / sr; fastPh += 6.1 / sr; if (slowPh >= 1) slowPh -= 1; if (fastPh >= 1) fastPh -= 1;
            float in = 0.5f * (L[i] + R[i]); float y[3];
            for (int k = 0; k < 3; ++k) { d[k].push(in); double off = k / 3.0; y[k] = d[k].read((0.008 + st(slowPh + off) * 0.0019 * depth + st(fastPh + off) * 0.00028 * depth) * sr); }
            double wet = sWet.next(), dry = sDry.next();
            float el = (float)(L[i] * dry + (y[0] + 0.5f * y[1]) * wet), er = (float)(R[i] * dry + (y[2] + 0.5f * y[1]) * wet);
            float pl = el, pr = er; for (auto& a : ap) { pl = a.process(pl, 0); pr = a.process(pr, 1); }
            double pw = sPWet.next(), pd = sPDry.next();
            L[i] = (float)(el * pd + pl * pw); R[i] = (float)(er * pd + pr * pw);
        }
    }
};

void prewarmTables() { for (auto id : {"basic", "pwm", "vocal", "sync", "growl", "sweep", "bells", "crush", "organ"}) wtTable(id); }

std::unique_ptr<Instrument> makeInstrument(const std::string& id) {
    if (id == "fm") return std::make_unique<FMInst>();
    if (id == "wt") return std::make_unique<WTInst>();
    if (id == "organ") return std::make_unique<OrganInst>();
    if (id == "strings") return std::make_unique<StringsInst>();
    return std::make_unique<EmberInst>();
}

} // namespace ember
