// Ember Studio — DSP building blocks (no JUCE dependency).
// Each block mirrors the Web Audio node the browser version used, so patches sound the same.
#pragma once
#include <cmath>
#include <vector>
#include <algorithm>
#include <cstdint>
#include <array>
#include <string>

namespace ember {

constexpr double PI = 3.14159265358979323846;
constexpr double TWO_PI = 2.0 * PI;
inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }
inline double clampd(double v, double a, double b) { return v < a ? a : (v > b ? b : v); }
inline double mtof(double n) { return 440.0 * std::pow(2.0, (n - 69.0) / 12.0); }
inline double cents(double c) { return std::pow(2.0, c / 1200.0); }

// ---- fast sine table ----
struct SineTable {
    static constexpr int N = 4096;
    float t[N + 1];
    SineTable() { for (int i = 0; i <= N; ++i) t[i] = (float)std::sin(TWO_PI * i / N); }
    inline float operator()(double phase01) const {          // phase in cycles
        double p = phase01 - std::floor(phase01);
        double x = p * N; int i = (int)x; float f = (float)(x - i);
        return t[i] + (t[i + 1] - t[i]) * f;
    }
};
const SineTable& sineTable();

// ---- simple xorshift noise ----
struct Noise {
    uint32_t s = 0x12345678u;
    inline float next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (float)((int32_t)s) * (1.0f / 2147483648.0f); }
};
inline double rand01() { static Noise n; return 0.5 + 0.5 * n.next(); }

// ---- envelope that behaves like Web Audio's setValueAtTime / linearRamp / setTargetAtTime ----
// attack: linear ramp from `from` to `peak` over A; then exponential approach to peak*S (tau = D/3);
// release: exponential approach to `to` (tau = R/4).
struct Env {
    enum Stage { Idle, Attack, Decay, Release } stage = Idle;
    double v = 0, from = 0, peak = 1, target = 1, A = 0.001, coef = 0, inc = 0, sr = 48000;
    double relTo = 0;
    void start(double sr_, double from_, double peak_, double A_, double D_, double S_) {
        sr = sr_; from = from_; v = from_; peak = peak_; A = std::max(1e-4, A_);
        target = peak * S_; inc = (peak - from) / (A * sr);
        coef = std::exp(-1.0 / (std::max(0.001, D_ / 3.0) * sr));
        stage = Attack;
    }
    void setDecay(double D_, double S_) { target = peak * S_; coef = std::exp(-1.0 / (std::max(0.001, D_ / 3.0) * sr)); }
    void release(double R, double to = 0) { relTo = to; coef = std::exp(-1.0 / (std::max(0.001, R / 4.0) * sr)); stage = Release; }
    inline double next() {
        switch (stage) {
            case Attack: v += inc; if ((inc >= 0 && v >= peak) || (inc < 0 && v <= peak)) { v = peak; stage = Decay; } break;
            case Decay: v = target + (v - target) * coef; break;
            case Release: v = relTo + (v - relTo) * coef; break;
            default: break;
        }
        return v;
    }
    // advance n samples cheaply (for control-rate use)
    inline double advance(int n) { double x = v; for (int i = 0; i < n; ++i) x = next(); return x; }
};

// Exponential-ramp-then-target envelope used for filter cutoffs (Web Audio exponentialRampToValueAtTime).
struct FreqEnv {
    enum Stage { Ramp, Target, Release } stage = Ramp;
    double v = 1000, start = 1000, peak = 1000, sus = 1000, t = 0, A = 0.001, coef = 0, sr = 48000, relTo = 1000;
    void begin(double sr_, double base, double peak_, double sus_, double A_, double D_) {
        sr = sr_; start = v = std::max(1e-3, base); peak = std::max(1e-3, peak_); sus = sus_; A = std::max(1e-4, A_); t = 0;
        coef = std::exp(-1.0 / (std::max(0.001, D_ / 3.0) * sr)); stage = Ramp;
    }
    void retarget(double peak_, double sus_, double D_, double elapsed) {   // live envelope edits
        peak = std::max(1e-3, peak_); sus = sus_; coef = std::exp(-1.0 / (std::max(0.001, D_ / 3.0) * sr));
        (void)elapsed;
    }
    void release(double R, double to) { relTo = to; coef = std::exp(-1.0 / (std::max(0.001, R / 4.0) * sr)); stage = Release; }
    inline double advance(int n) {
        for (int i = 0; i < n; ++i) {
            if (stage == Ramp) { t += 1.0 / sr; if (t >= A) { v = peak; stage = Target; } else v = start * std::pow(peak / start, t / A); }
            else if (stage == Target) v = sus + (v - sus) * coef;
            else v = relTo + (v - relTo) * coef;
        }
        return v;
    }
};

// ---- one-pole smoother ----
struct Smooth {
    double v = 0, target = 0, coef = 0.999;
    void setTime(double sec, double sr) { coef = std::exp(-1.0 / (std::max(1e-4, sec) * sr)); }
    void reset(double x) { v = target = x; }
    inline double next() { v = target + (v - target) * coef; return v; }
    inline double advance(int n) { double c = std::pow(coef, n); v = target + (v - target) * c; return v; }
};

// ---- biquad, coefficients exactly as the Web Audio spec (lowpass/highpass Q is in dB) ----
struct Biquad {
    enum Type { LP, HP, BP, AP } type = LP;
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double z1[2] = {0, 0}, z2[2] = {0, 0};
    void set(Type t, double f, double Q, double sr) {
        type = t;
        f = clampd(f, 1.0, sr * 0.5 - 1.0);
        double w0 = TWO_PI * f / sr, cw = std::cos(w0), sw = std::sin(w0), alpha, a0;
        if (t == LP || t == HP) alpha = sw / (2.0 * std::pow(10.0, Q / 20.0));
        else alpha = sw / (2.0 * std::max(1e-4, Q));
        switch (t) {
            case LP: b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
            case HP: b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
            case BP: b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
            default: b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
        }
        b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
    }
    inline float process(float x, int ch = 0) {
        double y = b0 * x + z1[ch];
        z1[ch] = b1 * x - a1 * y + z2[ch];
        z2[ch] = b2 * x - a2 * y;
        return (float)y;
    }
    void reset() { z1[0] = z1[1] = z2[0] = z2[1] = 0; }
};

// ---- band-limited oscillators (PolyBLEP) matching Web Audio's sine / triangle / sawtooth / square / pulse ----
enum class Wave { Sine, Triangle, Saw, Square, Pulse };
inline Wave waveFrom(const std::string& s) {
    if (s == "sine") return Wave::Sine; if (s == "triangle") return Wave::Triangle;
    if (s == "square") return Wave::Square; if (s == "pulse") return Wave::Pulse; return Wave::Saw;
}
inline double polyblep(double t, double dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1.0; }
    if (t > 1.0 - dt) { t = (t - 1.0) / dt; return t * t + t + t + 1.0; }
    return 0.0;
}
struct Osc {
    Wave wave = Wave::Saw; double phase = 0, tri = 0;
    inline float next(double inc) {   // inc = freq / sr
        double dt = std::fabs(inc); if (dt > 0.49) dt = 0.49; double out = 0;
        switch (wave) {
            case Wave::Sine: out = sineTable()(phase); break;
            case Wave::Saw: { double p = phase + 0.5; p -= std::floor(p); out = 2.0 * p - 1.0 - polyblep(p, dt); break; }
            case Wave::Square: case Wave::Triangle: {
                double sq = phase < 0.5 ? 1.0 : -1.0; sq += polyblep(phase, dt); double p2 = phase + 0.5; p2 -= std::floor(p2); sq -= polyblep(p2, dt);
                if (wave == Wave::Square) out = sq;
                else { tri = dt * sq * 4.0 + (1.0 - dt * 0.6) * tri; out = tri; }   // leaky-integrated square
                break; }
            case Wave::Pulse: {
                const double w = 0.25; double p = phase;
                double pu = p < w ? 1.0 : -1.0; pu += polyblep(p, dt); double p2 = p + (1.0 - w); p2 -= std::floor(p2); pu -= polyblep(p2, dt);
                out = (pu + 0.5) * 0.667;   // remove DC (duty 25%) and scale like the normalised PeriodicWave
                break; }
        }
        phase += inc; phase -= std::floor(phase);
        return (float)out;
    }
};

// ---- fractional delay line ----
struct DelayLine {
    std::vector<float> buf; int w = 0, mask = 0;
    void init(double maxSec, double sr) { int n = 1; while (n < (int)(maxSec * sr) + 4) n <<= 1; buf.assign(n, 0.f); mask = n - 1; w = 0; }
    inline void push(float x) { buf[w] = x; w = (w + 1) & mask; }
    inline float read(double delaySamples) const {
        double r = (double)w - delaySamples - 1.0; while (r < 0) r += buf.size();
        int i = (int)r; float f = (float)(r - i);
        float a = buf[i & mask], b = buf[(i + 1) & mask]; return a + (b - a) * f;
    }
    void clear() { std::fill(buf.begin(), buf.end(), 0.f); }
};

// ---- Web Audio StereoPanner (equal power) for a mono source ----
inline void panGains(double pan, float& gl, float& gr) { double a = (clampd(pan, -1, 1) + 1) * PI / 4; gl = (float)std::cos(a); gr = (float)std::sin(a); }

// ---- tanh drive curve, identical to the browser's driveCurve() ----
struct Drive {
    double k = 0.01, tk = 0.01, post = 1;
    void set(double d) { k = 0.01 + d * 8; tk = std::tanh(k); post = 0.3 / (std::tanh(0.3 * k) / tk); }
    inline float process(float x) const { double c = clampd(x, -1, 1); return (float)(std::tanh(k * c) / tk * post); }
};

// ---- feedback-delay-network reverb, tuned to approximate the browser's noise-burst impulse ----
struct Reverb {
    static constexpr int NL = 8;
    DelayLine d[NL]; double len[NL]{}; double g[NL]{}; double lp[NL]{}; double damp = 0.3, sr = 48000;
    DelayLine pre;
    void init(double sr_) {
        sr = sr_; const double base[NL] = {0.0297, 0.0371, 0.0411, 0.0437, 0.0503, 0.0571, 0.0617, 0.0683};
        for (int i = 0; i < NL; ++i) { d[i].init(0.2, sr); len[i] = base[i] * sr; }
        pre.init(0.05, sr); setSize(3);
    }
    void setSize(double sec) {
        double rt60 = std::max(0.2, sec * 0.42);
        for (int i = 0; i < NL; ++i) g[i] = std::pow(10.0, -3.0 * (len[i] / sr) / rt60);
        damp = clampd(0.15 + 0.04 * sec, 0.15, 0.55);
    }
    inline void process(float inL, float inR, float& outL, float& outR) {
        pre.push(0.5f * (inL + inR)); float x = pre.read(0.012 * sr);
        double s[NL]; for (int i = 0; i < NL; ++i) s[i] = d[i].read(len[i]);
        // Householder feedback matrix
        double sum = 0; for (int i = 0; i < NL; ++i) sum += s[i]; sum *= 2.0 / NL;
        for (int i = 0; i < NL; ++i) {
            double y = (s[i] - sum) * g[i];
            lp[i] += (y - lp[i]) * (1.0 - damp); y = lp[i];
            d[i].push((float)(y + x * (i & 1 ? 0.35 : -0.35)));
        }
        outL = (float)((s[0] - s[2] + s[4] - s[6]) * 0.32);
        outR = (float)((s[1] - s[3] + s[5] - s[7]) * 0.32);
    }
};

// ---- soft clipper used on the master output (clean below 0.7) ----
inline float softClip(float x) {
    float ax = std::fabs(x); if (ax < 0.7f) return x;
    return (x < 0 ? -1.f : 1.f) * (0.7f + 0.28f * (float)std::tanh((ax - 0.7f) / 0.28f));
}

} // namespace ember
