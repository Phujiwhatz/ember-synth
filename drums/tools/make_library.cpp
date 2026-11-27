// Pulse 16 — built-in sound library generator.
// Every sound here is ORIGINAL: synthesized from scratch by the code below (oscillators, noise,
// filters, modal resonators, a small reverb). No samples are read or copied.
//
// Build:  g++ -std=c++17 -O2 make_library.cpp -o make_library
// Run:    ./make_library <outDir>      -> writes <outDir>/<Category>/<Name>.wav (44.1 kHz, 16-bit mono)

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>
#include <sys/stat.h>

namespace
{
constexpr double SR = 44100.0;
constexpr float kPi = 3.14159265358979f;
constexpr float kTwoPi = 6.28318530717959f;
using Buf = std::vector<float>;

//==============================================================================
// Helpers (same algorithms as the engine's: xorshift noise, Simper SVF, polyBLEP)
struct Noise
{
    uint32_t s;
    explicit Noise (uint32_t seed = 0x9E3779B9u) : s (seed ? seed : 1u) {}
    float next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (float) (int32_t) s * (1.0f / 2147483648.0f); }
};

struct SVF
{
    float a1 = 0, a2 = 0, a3 = 0, k = 1, ic1 = 0, ic2 = 0, low = 0, band = 0, high = 0;
    void set (float cutoff, float q)
    {
        cutoff = std::clamp (cutoff, 10.0f, (float) (SR * 0.45));
        const float g = std::tan (kPi * cutoff / (float) SR);
        k = 1.0f / q; a1 = 1.0f / (1.0f + g * (g + k)); a2 = g * a1; a3 = g * a2;
    }
    void process (float v0)
    {
        const float v3 = v0 - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2.0f * v1 - ic1; ic2 = 2.0f * v2 - ic2;
        low = v2; band = v1; high = v0 - k * v1 - v2;
    }
    float lp (float x) { process (x); return low; }
    float bp (float x) { process (x); return band; }
    float hp (float x) { process (x); return high; }
};

inline float polyBlep (float t, float dt)
{
    if (t < dt) { t /= dt; return t + t - t * t - 1.0f; }
    if (t > 1.0f - dt) { t = (t - 1.0f) / dt; return t * t + t + t + 1.0f; }
    return 0.0f;
}
inline float squareBL (float ph, float dt)
{
    float v = ph < 0.5f ? 1.0f : -1.0f;
    v += polyBlep (ph, dt);
    float p2 = ph + 0.5f; if (p2 >= 1.0f) p2 -= 1.0f;
    return v - polyBlep (p2, dt);
}
inline float sawBL (float ph, float dt) { return 2.0f * ph - 1.0f - polyBlep (ph, dt); }

inline int ns (float sec) { return std::max (1, (int) (sec * SR)); }
inline float tsec (int i) { return (float) i / (float) SR; }
inline float expEnv (float t, float tau) { return std::exp (-t / std::max (1e-5f, tau)); }
inline float softClip (float x, float drive) { return drive <= 1.0f ? x : std::tanh (x * drive) / std::tanh (drive); }

void mixInto (Buf& dst, const Buf& src, float gain = 1.0f, int offset = 0)
{
    if ((int) dst.size() < offset + (int) src.size()) dst.resize (offset + src.size(), 0.0f);
    for (size_t i = 0; i < src.size(); ++i) dst[offset + i] += src[i] * gain;
}
float peakOf (const Buf& b) { float p = 0; for (float v : b) p = std::max (p, std::fabs (v)); return p; }
void normalize (Buf& b, float target = 1.0f) { float p = peakOf (b); if (p > 0) for (auto& v : b) v *= target / p; }

//==============================================================================
// Processing blocks
Buf lowpass (Buf b, float f, float q = 0.707f) { SVF s; s.set (f, q); for (auto& v : b) v = s.lp (v); return b; }
Buf highpass (Buf b, float f, float q = 0.707f) { SVF s; s.set (f, q); for (auto& v : b) v = s.hp (v); return b; }
Buf bandpass (Buf b, float f, float q) { SVF s; s.set (f, q); for (auto& v : b) v = s.bp (v); return b; }
Buf drive (Buf b, float d) { normalize (b); for (auto& v : b) v = softClip (v, d); return b; }

// Lo-fi: sample-rate reduction + bit depth reduction + gentle low-pass ("dusty sampler")
Buf crush (Buf b, float rateHz, int bits, float lpHz = 9000.0f)
{
    normalize (b);
    const float step = (float) SR / rateHz; float acc = 0, held = 0;
    const float levels = (float) (1 << (bits - 1));
    for (auto& v : b)
    {
        acc += 1.0f;
        if (acc >= step) { acc -= step; held = std::round (v * levels) / levels; }
        v = held;
    }
    return lowpass (b, lpHz, 0.6f);
}

// Small mono Freeverb-style reverb (8 combs + 4 allpasses). Returns dry+wet, with tail.
Buf reverb (const Buf& in, float room, float damp, float wet, float tailSec = 1.2f)
{
    static const int combT[8] = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
    static const int apT[4] = { 556, 441, 341, 225 };
    Buf out (in.size() + ns (tailSec), 0.0f);
    std::vector<Buf> comb (8), ap (4); std::vector<int> ci (8, 0), ai (4, 0); std::vector<float> filt (8, 0);
    for (int c = 0; c < 8; ++c) comb[c].assign (combT[c], 0.0f);
    for (int a = 0; a < 4; ++a) ap[a].assign (apT[a], 0.0f);
    const float fb = 0.7f + 0.28f * room;
    for (size_t i = 0; i < out.size(); ++i)
    {
        const float x = i < in.size() ? in[i] * 0.015f : 0.0f;
        float y = 0;
        for (int c = 0; c < 8; ++c)
        {
            float o = comb[c][ci[c]];
            filt[c] = o * (1.0f - damp) + filt[c] * damp;
            comb[c][ci[c]] = x + filt[c] * fb;
            if (++ci[c] >= combT[c]) ci[c] = 0;
            y += o;
        }
        for (int a = 0; a < 4; ++a)
        {
            float bo = ap[a][ai[a]];
            ap[a][ai[a]] = y + bo * 0.5f;
            y = bo - y;
            if (++ai[a] >= apT[a]) ai[a] = 0;
        }
        const float dry = i < in.size() ? in[i] : 0.0f;
        out[i] = dry * (1.0f - 0.5f * wet) + y * wet * 3.0f;
    }
    return out;
}

// Gate (for 80s gated reverb)
Buf gate (Buf b, float openSec, float releaseSec)
{
    for (size_t i = 0; i < b.size(); ++i)
    {
        float t = tsec ((int) i);
        if (t > openSec) b[i] *= expEnv (t - openSec, releaseSec);
    }
    return b;
}

Buf reversed (Buf b) { std::reverse (b.begin(), b.end()); return b; }

//==============================================================================
// Generators

// Sine/triangle body with exponential pitch sweep.
struct Body
{
    float len = 0.6f, fStart = 160, fEnd = 50, pDecay = 0.04f, aDecay = 0.3f, hold = 0.0f;
    float tri = 0.0f;        // 0 = sine, 1 = triangle-ish (more harmonics)
    float pDecay2 = 0.0f, fMid = 0.0f; // optional second, slower pitch drift (808 droop)
};
Buf body (const Body& p)
{
    Buf b (ns (p.len)); double ph = 0;
    for (int i = 0; i < (int) b.size(); ++i)
    {
        float t = tsec (i);
        float f = p.fEnd + (p.fStart - p.fEnd) * expEnv (t, p.pDecay);
        if (p.pDecay2 > 0) f += p.fMid * expEnv (t, p.pDecay2);
        ph += f / SR; ph -= std::floor (ph);
        float s = std::sin (kTwoPi * (float) ph);
        if (p.tri > 0) // self phase-modulation adds harmonics (brighter, "punchier" body)
            s = s * (1 - p.tri) + std::sin (kTwoPi * (float) ph + p.tri * 1.2f * std::sin (kTwoPi * (float) ph)) * p.tri;
        float a = t < p.hold ? 1.0f : expEnv (t - p.hold, p.aDecay);
        b[i] = s * a;
    }
    return b;
}

// Filtered noise burst. type: 0 = lp, 1 = bp, 2 = hp
Buf noiseBurst (float len, float decay, int type, float f, float q, uint32_t seed = 1, float attack = 0.0005f,
                float fEnd = -1.0f, float sweepTau = 0.05f)
{
    Buf b (ns (len)); Noise n (seed); SVF s; s.set (f, q);
    for (int i = 0; i < (int) b.size(); ++i)
    {
        float t = tsec (i);
        if (fEnd > 0 && (i & 15) == 0) s.set (fEnd + (f - fEnd) * expEnv (t, sweepTau), q);
        s.process (n.next());
        float x = type == 0 ? s.low : type == 1 ? s.band : s.high;
        float a = std::min (1.0f, t / attack) * expEnv (t, decay);
        b[i] = x * a;
    }
    return b;
}

// Metallic oscillator bank (six square waves at inharmonic ratios, like classic analog hats).
Buf metal (float len, float base, float decay, float hpHz, float bpHz, float bpQ, float noiseMix = 0.0f,
           uint32_t seed = 7, float attack = 0.0003f, const float* ratios = nullptr)
{
    static const float r808[6] = { 1.0f, 1.4826f, 1.8007f, 2.5465f, 2.6304f, 3.8968f };
    const float* r = ratios ? ratios : r808;
    Buf b (ns (len)); float ph[6] = { 0.1f, 0.3f, 0.5f, 0.7f, 0.2f, 0.9f };
    Noise n (seed); SVF bp, hp; bp.set (bpHz, bpQ); hp.set (hpHz, 0.7f);
    for (int i = 0; i < (int) b.size(); ++i)
    {
        float t = tsec (i), s = 0;
        for (int k = 0; k < 6; ++k)
        {
            float dt = base * r[k] / (float) SR;
            ph[k] += dt; if (ph[k] >= 1) ph[k] -= 1;
            s += squareBL (ph[k], dt);
        }
        s = s / 6.0f * (1 - noiseMix) + n.next() * noiseMix;
        float x = hp.hp (bp.bp (s));
        b[i] = x * std::min (1.0f, t / attack) * expEnv (t, decay);
    }
    return b;
}

// Modal resonator bank: decaying sinusoids (acoustic-ish membranes, bars, bells).
struct Mode { float ratio, amp, decay; };
Buf modal (float len, float f0, const std::vector<Mode>& modes, float pitchBend = 0.0f, float bendTau = 0.05f,
           float attack = 0.0008f)
{
    Buf b (ns (len)); std::vector<double> ph (modes.size(), 0.0);
    for (int i = 0; i < (int) b.size(); ++i)
    {
        float t = tsec (i), s = 0;
        float bend = 1.0f + pitchBend * expEnv (t, bendTau);
        for (size_t m = 0; m < modes.size(); ++m)
        {
            float f = f0 * modes[m].ratio * bend;
            if (f > SR * 0.45) continue;
            ph[m] += f / SR; ph[m] -= std::floor (ph[m]);
            s += modes[m].amp * std::sin (kTwoPi * (float) ph[m]) * expEnv (t, modes[m].decay);
        }
        b[i] = s * std::min (1.0f, t / attack);
    }
    return b;
}

// Membrane mode ratios (circular drumhead, Bessel zeros)
const std::vector<float> kMembrane = { 1.0f, 1.594f, 2.136f, 2.296f, 2.653f, 2.918f, 3.156f, 3.501f };

Buf membrane (float len, float f0, float decay, float brightness, float bend, uint32_t seed = 3)
{
    std::vector<Mode> m; Noise n (seed);
    for (size_t k = 0; k < kMembrane.size(); ++k)
    {
        float amp = std::pow (brightness, (float) k) * (0.7f + 0.3f * std::fabs (n.next()));
        m.push_back ({ kMembrane[k], amp, decay / (1.0f + 0.6f * (float) k) });
    }
    return modal (len, f0, m, bend, 0.06f);
}

//==============================================================================
// Instrument recipes

struct KickP
{
    float len = 0.7f, fStart = 180, fEnd = 50, pDecay = 0.035f, aDecay = 0.25f, hold = 0.0f;
    float click = 0.25f, clickHz = 3500, drv = 1.0f, tri = 0.0f, lp = 0.0f;
    float droop = 0.0f, droopTau = 0.3f;
    uint32_t seed = 11;
};
Buf kick (const KickP& p)
{
    Body bd; bd.len = p.len; bd.fStart = p.fStart; bd.fEnd = p.fEnd; bd.pDecay = p.pDecay; bd.aDecay = p.aDecay;
    bd.hold = p.hold; bd.tri = p.tri; bd.fMid = p.droop; bd.pDecay2 = p.droop > 0 ? p.droopTau : 0.0f;
    Buf b = body (bd);
    if (p.click > 0)
    {
        Buf c = noiseBurst (0.02f, 0.003f, 1, p.clickHz, 0.8f, p.seed);
        normalize (c); mixInto (b, c, p.click);
    }
    if (p.drv > 1) b = drive (b, p.drv);
    if (p.lp > 0) b = lowpass (b, p.lp);
    return b;
}

struct SnareP
{
    float len = 0.5f, f1 = 185, f2 = 330, bodyDecay = 0.06f, bend = 0.25f, bodyLevel = 0.6f;
    float noiseLevel = 0.8f, noiseDecay = 0.14f, noiseHz = 5000, noiseQ = 0.6f, noiseHp = 1500;
    float snap = 0.2f, drv = 1.0f; uint32_t seed = 21;
};
Buf snare (const SnareP& p)
{
    Body a; a.len = p.len; a.fStart = p.f1 * (1 + p.bend); a.fEnd = p.f1; a.pDecay = 0.02f; a.aDecay = p.bodyDecay;
    Body c = a; c.fStart = p.f2 * (1 + p.bend); c.fEnd = p.f2; c.aDecay = p.bodyDecay * 0.7f;
    Buf b = body (a); mixInto (b, body (c), 0.6f);
    normalize (b); for (auto& v : b) v *= p.bodyLevel;
    // snare wires: band-limited noise (high-passed for snap, low-passed so it isn't fizzy)
    Buf nz = lowpass (highpass (noiseBurst (p.len, p.noiseDecay, 1, p.noiseHz * 0.75f, p.noiseQ, p.seed), p.noiseHp), 8000);
    normalize (nz); mixInto (b, nz, p.noiseLevel);
    if (p.snap > 0) { Buf s = noiseBurst (0.01f, 0.002f, 2, 6000, 0.7f, p.seed + 1); normalize (s); mixInto (b, s, p.snap); }
    if (p.drv > 1) b = drive (b, p.drv);
    return b;
}

struct ClapP
{
    int bursts = 4; float spacing = 0.011f, burstDecay = 0.004f, tail = 0.18f, hz = 1200, q = 1.2f;
    float tailLevel = 0.8f, hp = 400; uint32_t seed = 31; float jitter = 0.3f;
};
Buf clap (const ClapP& p)
{
    Buf b; Noise j (p.seed + 99);
    for (int k = 0; k < p.bursts; ++k)
    {
        float off = k * p.spacing * (1.0f + p.jitter * j.next());
        Buf x = noiseBurst (0.03f, p.burstDecay, 1, p.hz, p.q, p.seed + k * 7);
        normalize (x); mixInto (b, x, 0.85f + 0.15f * j.next(), ns (std::max (0.0f, off)));
    }
    Buf t = noiseBurst (p.tail * 5, p.tail, 1, p.hz, p.q, p.seed + 50);
    normalize (t); mixInto (b, t, p.tailLevel, ns ((p.bursts - 1) * p.spacing));
    return highpass (b, p.hp);
}

struct TomP { float len = 0.6f, f = 120, bend = 0.5f, bendTau = 0.06f, decay = 0.25f, noise = 0.15f, tri = 0.0f; uint32_t seed = 41; };
Buf tom (const TomP& p)
{
    Body bd; bd.len = p.len; bd.fStart = p.f * (1 + p.bend); bd.fEnd = p.f; bd.pDecay = p.bendTau; bd.aDecay = p.decay; bd.tri = p.tri;
    Buf b = body (bd);
    if (p.noise > 0) { Buf n = noiseBurst (0.1f, 0.02f, 1, p.f * 8, 0.8f, p.seed); normalize (n); mixInto (b, n, p.noise); }
    return b;
}

//==============================================================================
// Post-processing: DC removal, trim leading silence, tail fade, length cap, -1 dBFS normalize.
Buf finish (Buf b, float maxSec = 2.95f)
{
    // DC blocker (~12 Hz)
    { float x1 = 0, y1 = 0; const float r = 1.0f - kTwoPi * 12.0f / (float) SR;
      for (auto& v : b) { float y = v - x1 + r * y1; x1 = v; y1 = y; v = y; } }
    for (auto& v : b) if (! std::isfinite (v)) v = 0.0f;
    float pk = peakOf (b); if (pk <= 0) return Buf (ns (0.05f), 0.0f);
    const float thr = pk * 0.001f; // -60 dB
    int start = 0; while (start < (int) b.size() && std::fabs (b[start]) < thr) ++start;
    start = std::max (0, start - 8);
    int end = (int) b.size() - 1; while (end > start && std::fabs (b[end]) < thr) --end;
    end = std::min ((int) b.size(), end + ns (0.01f));
    end = std::min (end, start + ns (maxSec));
    Buf o (b.begin() + start, b.begin() + end);
    // fade-in a few samples only if we cut into non-silence, fade-out over last 10% (5..150 ms)
    const int fin = std::min ((int) o.size(), 8);
    for (int i = 0; i < fin; ++i) o[i] *= (float) i / (float) fin;
    const int fo = std::clamp ((int) (o.size() * 0.1), ns (0.005f), ns (0.15f));
    for (int i = 0; i < fo && i < (int) o.size(); ++i)
    {
        float g = (float) i / (float) fo; o[o.size() - 1 - i] *= g * g;
    }
    // remove any residual DC from truncation, then normalize to -1 dBFS
    normalize (o, std::pow (10.0f, -1.0f / 20.0f));
    o.back() = 0.0f;
    return o;
}

bool writeWav (const std::string& path, const Buf& b)
{
    FILE* f = std::fopen (path.c_str(), "wb"); if (! f) return false;
    auto w32 = [&] (uint32_t v) { std::fwrite (&v, 4, 1, f); };
    auto w16 = [&] (uint16_t v) { std::fwrite (&v, 2, 1, f); };
    const uint32_t dataBytes = (uint32_t) b.size() * 2;
    std::fwrite ("RIFF", 1, 4, f); w32 (36 + dataBytes); std::fwrite ("WAVE", 1, 4, f);
    std::fwrite ("fmt ", 1, 4, f); w32 (16); w16 (1); w16 (1); w32 ((uint32_t) SR); w32 ((uint32_t) SR * 2); w16 (2); w16 (16);
    std::fwrite ("data", 1, 4, f); w32 (dataBytes);
    for (float v : b)
    {
        int s = (int) std::lround (std::clamp (v, -1.0f, 1.0f) * 32767.0f);
        int16_t x = (int16_t) std::clamp (s, -32768, 32767); std::fwrite (&x, 2, 1, f);
    }
    std::fclose (f); return true;
}

struct Sound { const char* cat; const char* name; std::function<Buf()> make; };

//==============================================================================
std::vector<Sound> buildSounds()
{
    std::vector<Sound> v;
    auto add = [&] (const char* c, const char* n, std::function<Buf()> f) { v.push_back ({ c, n, std::move (f) }); };

    //---------------------------------------------------------------- Kicks (16)
    add ("Kicks", "Deep 808", [] { KickP p; p.len = 2.2f; p.fStart = 120; p.fEnd = 46; p.pDecay = 0.05f; p.aDecay = 0.65f; p.hold = 0.05f; p.click = 0.12f; p.drv = 1.3f; return kick (p); });
    add ("Kicks", "Long 808 Boom", [] { KickP p; p.len = 2.9f; p.fStart = 110; p.fEnd = 41; p.pDecay = 0.06f; p.aDecay = 1.0f; p.hold = 0.1f; p.click = 0.08f; p.droop = 6; p.droopTau = 0.6f; p.drv = 1.6f; return kick (p); });
    add ("Kicks", "Short 808", [] { KickP p; p.len = 0.6f; p.fStart = 150; p.fEnd = 52; p.pDecay = 0.04f; p.aDecay = 0.13f; p.click = 0.2f; return kick (p); });
    add ("Kicks", "Tight 909", [] { KickP p; p.len = 0.5f; p.fStart = 320; p.fEnd = 55; p.pDecay = 0.022f; p.aDecay = 0.15f; p.click = 0.45f; p.clickHz = 4500; p.drv = 1.8f; return kick (p); });
    add ("Kicks", "Punchy 909", [] { KickP p; p.len = 0.8f; p.fStart = 280; p.fEnd = 50; p.pDecay = 0.03f; p.aDecay = 0.26f; p.hold = 0.02f; p.click = 0.35f; p.drv = 2.2f; p.tri = 0.2f; return kick (p); });
    add ("Kicks", "Trap Sub Kick", [] { KickP p; p.len = 2.6f; p.fStart = 200; p.fEnd = 43; p.pDecay = 0.025f; p.aDecay = 0.85f; p.hold = 0.15f; p.click = 0.3f; p.drv = 2.5f; return kick (p); });
    add ("Kicks", "Trap Knock", [] { KickP p; p.len = 0.5f; p.fStart = 380; p.fEnd = 62; p.pDecay = 0.018f; p.aDecay = 0.12f; p.click = 0.6f; p.clickHz = 2500; p.drv = 3.5f; return kick (p); });
    add ("Kicks", "Dusty Lo-Fi Kick", [] { KickP p; p.len = 0.6f; p.fStart = 200; p.fEnd = 55; p.pDecay = 0.03f; p.aDecay = 0.18f; p.click = 0.3f; p.drv = 2.0f;
        return crush (kick (p), 14000, 9, 4500); });
    add ("Kicks", "Boom Bap Thump", [] { KickP p; p.len = 0.7f; p.fStart = 170; p.fEnd = 58; p.pDecay = 0.035f; p.aDecay = 0.2f; p.click = 0.5f; p.clickHz = 1800; p.drv = 2.6f; p.tri = 0.3f;
        return crush (kick (p), 26000, 12, 7000); });
    add ("Kicks", "Techno Rumble", [] { KickP p; p.len = 0.6f; p.fStart = 260; p.fEnd = 50; p.pDecay = 0.025f; p.aDecay = 0.2f; p.click = 0.3f; p.drv = 3.0f;
        Buf k = kick (p); Buf r = lowpass (reverb (k, 0.8f, 0.5f, 1.0f, 1.0f), 180, 0.9f); r = drive (r, 2.5f);
        normalize (k); normalize (r); mixInto (k, r, 0.55f, ns (0.06f)); return k; });
    add ("Kicks", "Hard Techno Kick", [] { KickP p; p.len = 0.7f; p.fStart = 420; p.fEnd = 48; p.pDecay = 0.02f; p.aDecay = 0.25f; p.hold = 0.03f; p.click = 0.4f; p.drv = 5.0f; p.lp = 9000; return kick (p); });
    add ("Kicks", "Acoustic Kick", [] {
        Buf b = membrane (0.6f, 58, 0.22f, 0.35f, 0.25f, 5);
        Buf beater = noiseBurst (0.03f, 0.004f, 1, 2800, 0.9f, 6); normalize (beater); normalize (b);
        mixInto (b, beater, 0.35f);
        Buf shell = modal (0.4f, 140, { { 1, 1, 0.05f }, { 2.3f, 0.5f, 0.03f } }); normalize (shell); mixInto (b, shell, 0.15f);
        return lowpass (b, 6000); });
    add ("Kicks", "Room Kick", [] {
        Buf b = membrane (0.6f, 62, 0.2f, 0.4f, 0.3f, 8);
        Buf beater = noiseBurst (0.03f, 0.005f, 1, 2400, 0.9f, 9); normalize (beater); normalize (b); mixInto (b, beater, 0.3f);
        return lowpass (reverb (b, 0.55f, 0.4f, 0.35f, 0.9f), 5000); });
    add ("Kicks", "Electro Kick", [] { KickP p; p.len = 0.6f; p.fStart = 600; p.fEnd = 55; p.pDecay = 0.012f; p.aDecay = 0.2f; p.click = 0.0f; p.tri = 0.6f; p.drv = 1.6f; return kick (p); });
    add ("Kicks", "Soft Felt Kick", [] { KickP p; p.len = 0.6f; p.fStart = 110; p.fEnd = 52; p.pDecay = 0.05f; p.aDecay = 0.2f; p.click = 0.05f; p.lp = 900; return kick (p); });
    add ("Kicks", "Distorted Punch", [] { KickP p; p.len = 0.6f; p.fStart = 500; p.fEnd = 60; p.pDecay = 0.015f; p.aDecay = 0.16f; p.hold = 0.04f; p.click = 0.5f; p.drv = 8.0f; p.lp = 7000; return kick (p); });

    //---------------------------------------------------------------- Snares (14)
    add ("Snares", "Classic 808 Snare", [] { SnareP p; p.f1 = 238; p.f2 = 476; p.bodyDecay = 0.07f; p.bend = 0.1f; p.bodyLevel = 0.8f; p.noiseLevel = 0.6f; p.noiseDecay = 0.12f; p.noiseHz = 7000; p.noiseHp = 2500; p.snap = 0.1f; return snare (p); });
    add ("Snares", "Snappy 808", [] { SnareP p; p.f1 = 250; p.f2 = 500; p.bodyDecay = 0.05f; p.bodyLevel = 0.5f; p.noiseLevel = 0.9f; p.noiseDecay = 0.18f; p.noiseHz = 6500; p.noiseHp = 2000; p.snap = 0.3f; return snare (p); });
    add ("Snares", "Tight 909", [] { SnareP p; p.f1 = 190; p.f2 = 340; p.bodyDecay = 0.05f; p.bend = 0.35f; p.bodyLevel = 0.65f; p.noiseLevel = 0.8f; p.noiseDecay = 0.09f; p.noiseHz = 5500; p.snap = 0.35f; p.drv = 1.5f; return snare (p); });
    add ("Snares", "Fat 909", [] { SnareP p; p.len = 0.6f; p.f1 = 175; p.f2 = 310; p.bodyDecay = 0.09f; p.bend = 0.4f; p.bodyLevel = 0.8f; p.noiseLevel = 0.85f; p.noiseDecay = 0.2f; p.noiseHz = 4500; p.snap = 0.3f; p.drv = 2.0f; return snare (p); });
    add ("Snares", "Trap Snare", [] { SnareP p; p.f1 = 210; p.f2 = 380; p.bodyDecay = 0.06f; p.bodyLevel = 0.6f; p.noiseLevel = 0.9f; p.noiseDecay = 0.16f; p.noiseHz = 3800; p.noiseQ = 0.8f; p.snap = 0.5f; p.drv = 2.4f;
        Buf b = snare (p); Buf r = reverb (b, 0.5f, 0.5f, 0.2f, 0.4f); return r; });
    add ("Snares", "Dusty Lo-Fi Snare", [] { SnareP p; p.f1 = 200; p.f2 = 350; p.bodyDecay = 0.07f; p.noiseLevel = 0.85f; p.noiseDecay = 0.14f; p.noiseHz = 3500; p.snap = 0.3f; p.drv = 2.0f;
        return crush (snare (p), 11025, 8, 5000); });
    add ("Snares", "Boom Bap Crack", [] { SnareP p; p.f1 = 220; p.f2 = 420; p.bodyDecay = 0.05f; p.bodyLevel = 0.7f; p.noiseLevel = 1.0f; p.noiseDecay = 0.13f; p.noiseHz = 2800; p.noiseQ = 0.9f; p.snap = 0.6f; p.drv = 3.0f;
        return crush (snare (p), 22050, 12, 8000); });
    add ("Snares", "Techno Snare", [] { SnareP p; p.f1 = 260; p.f2 = 520; p.bodyDecay = 0.04f; p.bodyLevel = 0.5f; p.noiseLevel = 0.9f; p.noiseDecay = 0.1f; p.noiseHz = 6000; p.noiseHp = 3000; p.snap = 0.4f; p.drv = 2.5f;
        return reverb (snare (p), 0.4f, 0.6f, 0.25f, 0.4f); });
    add ("Snares", "Acoustic Snare", [] {
        Buf head = membrane (0.4f, 196, 0.12f, 0.6f, 0.08f, 12); normalize (head);
        Buf wires = lowpass (highpass (noiseBurst (0.5f, 0.15f, 1, 4200, 0.5f, 13, 0.002f), 1200), 8500); normalize (wires);
        Buf stick = noiseBurst (0.01f, 0.0015f, 2, 5000, 0.7f, 14); normalize (stick);
        mixInto (head, wires, 0.75f); mixInto (head, stick, 0.3f); return lowpass (head, 11000); });
    add ("Snares", "Room Snare", [] {
        Buf head = membrane (0.4f, 190, 0.11f, 0.6f, 0.08f, 15); normalize (head);
        Buf wires = lowpass (highpass (noiseBurst (0.5f, 0.14f, 1, 4000, 0.5f, 16, 0.002f), 1200), 8000); normalize (wires);
        mixInto (head, wires, 0.8f); return reverb (head, 0.7f, 0.45f, 0.45f, 1.1f); });
    add ("Snares", "Brush Snare", [] {
        Buf b = noiseBurst (0.5f, 0.12f, 1, 3500, 0.4f, 17, 0.012f); Buf h = membrane (0.3f, 200, 0.06f, 0.5f, 0.02f, 18);
        normalize (b); normalize (h); mixInto (b, h, 0.25f); return lowpass (b, 7000); });
    add ("Snares", "Electro Snare", [] { SnareP p; p.f1 = 300; p.f2 = 450; p.bend = 0.8f; p.bodyDecay = 0.05f; p.bodyLevel = 0.7f; p.noiseLevel = 0.7f; p.noiseDecay = 0.1f; p.noiseHz = 8000; p.noiseHp = 4000; p.snap = 0.2f; return snare (p); });
    add ("Snares", "Gated 80s Snare", [] { SnareP p; p.f1 = 180; p.f2 = 330; p.bodyDecay = 0.08f; p.bodyLevel = 0.7f; p.noiseLevel = 0.9f; p.noiseDecay = 0.15f; p.noiseHz = 4000; p.snap = 0.4f; p.drv = 1.5f;
        return gate (reverb (snare (p), 0.9f, 0.3f, 0.9f, 0.6f), 0.22f, 0.02f); });
    add ("Snares", "Piccolo Snare", [] {
        Buf head = membrane (0.3f, 330, 0.07f, 0.65f, 0.06f, 19); normalize (head);
        Buf wires = lowpass (highpass (noiseBurst (0.4f, 0.1f, 1, 5000, 0.6f, 20, 0.001f), 2000), 8500); normalize (wires);
        mixInto (head, wires, 0.7f); return head; });

    //---------------------------------------------------------------- Claps (10)
    add ("Claps", "808 Clap", [] { ClapP p; p.hz = 1100; p.q = 1.0f; p.tail = 0.16f; return reverb (clap (p), 0.3f, 0.6f, 0.15f, 0.3f); });
    add ("Claps", "909 Clap", [] { ClapP p; p.hz = 1400; p.q = 1.3f; p.spacing = 0.009f; p.tail = 0.12f; p.hp = 700; return clap (p); });
    add ("Claps", "Trap Clap", [] { ClapP p; p.bursts = 5; p.hz = 1600; p.q = 1.0f; p.spacing = 0.008f; p.tail = 0.1f; p.seed = 33;
        return reverb (drive (clap (p), 2.0f), 0.5f, 0.5f, 0.3f, 0.5f); });
    add ("Claps", "Big Room Clap", [] { ClapP p; p.hz = 1200; p.tail = 0.2f; p.seed = 35; return reverb (clap (p), 0.85f, 0.35f, 0.6f, 1.6f); });
    add ("Claps", "Dusty Lo-Fi Clap", [] { ClapP p; p.hz = 1000; p.q = 1.0f; p.tail = 0.14f; p.seed = 37; return crush (clap (p), 11025, 8, 4500); });
    add ("Claps", "Tight Clap", [] { ClapP p; p.bursts = 3; p.hz = 1800; p.q = 1.5f; p.spacing = 0.007f; p.tail = 0.06f; p.hp = 900; p.seed = 39; return clap (p); });
    add ("Claps", "Finger Snap", [] {
        Buf b = noiseBurst (0.15f, 0.025f, 1, 2600, 2.5f, 41, 0.0004f); normalize (b);
        Buf t = modal (0.1f, 1800, { { 1, 1, 0.02f }, { 1.7f, 0.4f, 0.012f } }); normalize (t); mixInto (b, t, 0.3f);
        return reverb (highpass (b, 800), 0.3f, 0.6f, 0.15f, 0.3f); });
    add ("Claps", "Layered Clap", [] { ClapP a; a.hz = 1100; a.seed = 43; ClapP b2; b2.hz = 2200; b2.q = 1.6f; b2.spacing = 0.013f; b2.seed = 45; b2.tail = 0.1f;
        Buf b = clap (a); normalize (b); Buf c = clap (b2); normalize (c); mixInto (b, c, 0.6f); SnareP s; s.noiseLevel = 0.0f; s.snap = 0; s.bodyLevel = 1;
        Buf bd = snare (s); normalize (bd); mixInto (b, bd, 0.2f); return reverb (b, 0.5f, 0.5f, 0.2f, 0.5f); });
    add ("Claps", "Techno Clap", [] { ClapP p; p.hz = 1500; p.q = 2.0f; p.tail = 0.18f; p.hp = 1000; p.seed = 47;
        return reverb (clap (p), 0.75f, 0.6f, 0.5f, 1.2f); });
    add ("Claps", "Gated Clap", [] { ClapP p; p.hz = 1250; p.tail = 0.15f; p.seed = 49;
        return gate (reverb (clap (p), 0.9f, 0.3f, 0.9f, 0.5f), 0.2f, 0.015f); });

    //---------------------------------------------------------------- Hats (14)
    add ("Hats", "808 Closed Hat", [] { return metal (0.2f, 300, 0.035f, 7000, 10000, 1.0f, 0.0f, 51); });
    add ("Hats", "808 Open Hat", [] { return metal (0.9f, 300, 0.22f, 7000, 10000, 1.0f, 0.0f, 52); });
    add ("Hats", "909 Closed Hat", [] { return metal (0.2f, 420, 0.03f, 8000, 11000, 0.8f, 0.55f, 53); });
    add ("Hats", "909 Open Hat", [] { return metal (1.0f, 420, 0.28f, 7500, 10500, 0.8f, 0.55f, 54); });
    add ("Hats", "Trap Hat Tick", [] { return metal (0.1f, 360, 0.014f, 9000, 12000, 1.0f, 0.3f, 55); });
    add ("Hats", "Trap Open Hat", [] { return metal (0.7f, 360, 0.15f, 8000, 11500, 0.9f, 0.35f, 56); });
    add ("Hats", "Dusty Lo-Fi Hat", [] { return crush (metal (0.2f, 330, 0.03f, 6000, 9000, 0.8f, 0.5f, 57), 22050, 7, 9500); });
    add ("Hats", "Dusty Lo-Fi Open Hat", [] { return crush (metal (0.7f, 330, 0.17f, 6000, 9000, 0.8f, 0.5f, 58), 22050, 7, 9500); });
    add ("Hats", "Techno Hat", [] { return reverb (metal (0.15f, 470, 0.022f, 9000, 12500, 1.2f, 0.4f, 59), 0.4f, 0.6f, 0.2f, 0.3f); });
    add ("Hats", "Techno Open Hat", [] { return metal (0.6f, 470, 0.12f, 8500, 12000, 1.3f, 0.4f, 60, 0.004f); });
    add ("Hats", "Acoustic Closed Hat", [] {
        static const float r[6] = { 1.0f, 1.342f, 1.919f, 2.213f, 2.71f, 3.317f };
        Buf b = metal (0.25f, 590, 0.04f, 6000, 9000, 0.5f, 0.45f, 61, 0.0005f, r);
        Buf stick = noiseBurst (0.01f, 0.002f, 1, 4000, 1.0f, 62); normalize (stick); normalize (b); mixInto (b, stick, 0.2f); return b; });
    add ("Hats", "Acoustic Open Hat", [] {
        static const float r[6] = { 1.0f, 1.342f, 1.919f, 2.213f, 2.71f, 3.317f };
        return metal (1.4f, 590, 0.4f, 5500, 8500, 0.5f, 0.45f, 63, 0.001f, r); });
    add ("Hats", "Pedal Hat", [] {
        static const float r[6] = { 1.0f, 1.342f, 1.919f, 2.213f, 2.71f, 3.317f };
        Buf b = metal (0.15f, 560, 0.02f, 5000, 7500, 0.6f, 0.4f, 64, 0.003f, r);
        Buf chick = noiseBurst (0.05f, 0.012f, 1, 1500, 1.2f, 65); normalize (b); normalize (chick); mixInto (b, chick, 0.35f); return b; });
    add ("Hats", "Electro Hat", [] { return noiseBurst (0.15f, 0.025f, 2, 9500, 0.9f, 66); });

    //---------------------------------------------------------------- Cymbals (8)
    static const float cymR[6] = { 1.0f, 1.483f, 1.932f, 2.546f, 2.63f, 3.897f };
    add ("Cymbals", "Bright Crash", [] {
        Buf b = metal (2.9f, 480, 0.9f, 4000, 7500, 0.4f, 0.55f, 71, 0.002f, cymR);
        Buf n = highpass (noiseBurst (2.9f, 0.7f, 1, 6000, 0.4f, 72, 0.002f), 3000); normalize (b); normalize (n); mixInto (b, n, 0.5f); return b; });
    add ("Cymbals", "Dark Crash", [] {
        Buf b = metal (2.9f, 350, 1.0f, 2500, 4500, 0.4f, 0.5f, 73, 0.003f, cymR);
        return lowpass (b, 6000); });
    add ("Cymbals", "Ride", [] {
        Buf b = metal (2.5f, 520, 0.8f, 4500, 8000, 0.7f, 0.3f, 74, 0.0005f, cymR); normalize (b);
        Buf ping = modal (2.5f, 620, { { 1, 0.6f, 0.6f }, { 2.08f, 0.5f, 0.5f }, { 2.94f, 0.4f, 0.4f }, { 4.12f, 0.3f, 0.3f } }); normalize (ping);
        mixInto (b, ping, 0.25f); return b; });
    add ("Cymbals", "Ride Bell", [] {
        Buf b = modal (2.5f, 820, { { 1, 1, 0.9f }, { 1.506f, 0.6f, 0.7f }, { 2.0f, 0.5f, 0.8f }, { 2.74f, 0.4f, 0.5f }, { 3.3f, 0.3f, 0.4f }, { 4.4f, 0.2f, 0.3f } });
        Buf w = metal (1.5f, 520, 0.4f, 5000, 8000, 0.7f, 0.3f, 75, 0.0005f, cymR); normalize (b); normalize (w); mixInto (b, w, 0.3f); return b; });
    add ("Cymbals", "China", [] {
        Buf b = metal (2.2f, 410, 0.6f, 2500, 5000, 0.3f, 0.6f, 76, 0.001f, cymR); return highpass (drive (b, 3.0f), 1200); });
    add ("Cymbals", "Splash", [] {
        Buf b = metal (1.2f, 620, 0.3f, 5000, 9000, 0.5f, 0.5f, 77, 0.001f, cymR); return b; });
    add ("Cymbals", "808 Cymbal", [] { return metal (2.5f, 300, 0.7f, 6000, 8500, 0.6f, 0.15f, 78, 0.001f); });
    add ("Cymbals", "Dusty Lo-Fi Crash", [] {
        Buf b = metal (2.5f, 450, 0.75f, 3500, 7000, 0.4f, 0.55f, 79, 0.002f, cymR); return crush (b, 16000, 8, 6500); });

    //---------------------------------------------------------------- Toms (10)
    add ("Toms", "808 Low Tom", [] { TomP p; p.len = 1.2f; p.f = 90; p.bend = 0.25f; p.bendTau = 0.12f; p.decay = 0.4f; p.noise = 0.08f; return tom (p); });
    add ("Toms", "808 Mid Tom", [] { TomP p; p.len = 1.0f; p.f = 130; p.bend = 0.25f; p.bendTau = 0.1f; p.decay = 0.33f; p.noise = 0.08f; return tom (p); });
    add ("Toms", "808 High Tom", [] { TomP p; p.len = 0.9f; p.f = 185; p.bend = 0.25f; p.bendTau = 0.09f; p.decay = 0.28f; p.noise = 0.08f; return tom (p); });
    add ("Toms", "909 Low Tom", [] { TomP p; p.f = 100; p.bend = 0.6f; p.bendTau = 0.05f; p.decay = 0.25f; p.noise = 0.25f; p.tri = 0.3f; return drive (tom (p), 1.5f); });
    add ("Toms", "909 High Tom", [] { TomP p; p.f = 170; p.bend = 0.6f; p.bendTau = 0.045f; p.decay = 0.2f; p.noise = 0.25f; p.tri = 0.3f; return drive (tom (p), 1.5f); });
    add ("Toms", "Acoustic Floor Tom", [] {
        Buf b = membrane (1.4f, 82, 0.45f, 0.5f, 0.12f, 81); normalize (b);
        Buf st = noiseBurst (0.02f, 0.003f, 1, 2500, 0.8f, 82); normalize (st); mixInto (b, st, 0.2f); return b; });
    add ("Toms", "Acoustic Rack Tom", [] {
        Buf b = membrane (1.1f, 145, 0.35f, 0.5f, 0.1f, 83); normalize (b);
        Buf st = noiseBurst (0.02f, 0.003f, 1, 3000, 0.8f, 84); normalize (st); mixInto (b, st, 0.2f); return b; });
    add ("Toms", "Room Tom", [] {
        Buf b = membrane (1.0f, 115, 0.32f, 0.5f, 0.1f, 85); return reverb (b, 0.7f, 0.4f, 0.4f, 1.1f); });
    add ("Toms", "Syndrum Zap Tom", [] { TomP p; p.len = 0.8f; p.f = 110; p.bend = 3.0f; p.bendTau = 0.09f; p.decay = 0.3f; p.noise = 0.0f; return tom (p); });
    add ("Toms", "Dusty Lo-Fi Tom", [] { TomP p; p.f = 120; p.bend = 0.4f; p.decay = 0.25f; p.noise = 0.2f; return crush (tom (p), 11025, 8, 4000); });

    //---------------------------------------------------------------- Percussion (16)
    add ("Percussion", "808 Cowbell", [] {
        Buf b (ns (0.7f)); float p1 = 0, p2 = 0; SVF bp; bp.set (1800, 1.5f);
        for (int i = 0; i < (int) b.size(); ++i)
        {
            float t = tsec (i), d1 = 540.0f / (float) SR, d2 = 800.0f / (float) SR;
            p1 += d1; if (p1 >= 1) p1 -= 1; p2 += d2; if (p2 >= 1) p2 -= 1;
            float s = squareBL (p1, d1) + squareBL (p2, d2);
            float env = 0.6f * expEnv (t, 0.015f) + 0.4f * expEnv (t, 0.2f);
            b[i] = bp.bp (s) * env;
        }
        return b; });
    add ("Percussion", "808 Clave", [] { return modal (0.25f, 2500, { { 1, 1, 0.035f }, { 2.7f, 0.15f, 0.02f } }, 0.0f, 0.05f, 0.0002f); });
    add ("Percussion", "808 Rimshot", [] {
        Buf b = modal (0.2f, 1700, { { 1, 1, 0.012f }, { 0.27f, 0.7f, 0.02f } }, 0, 0.05f, 0.0002f);
        return highpass (b, 300); });
    add ("Percussion", "Woody Rimshot", [] {
        Buf b = modal (0.25f, 470, { { 1, 1, 0.03f }, { 2.4f, 0.6f, 0.02f }, { 4.1f, 0.4f, 0.015f } }, 0, 0.05f, 0.0002f); normalize (b);
        Buf n = noiseBurst (0.05f, 0.006f, 1, 3500, 1.0f, 91); normalize (n); mixInto (b, n, 0.4f); return b; });
    add ("Percussion", "Woodblock", [] { return modal (0.3f, 880, { { 1, 1, 0.06f }, { 2.57f, 0.4f, 0.03f }, { 4.9f, 0.2f, 0.015f } }, 0.02f, 0.01f, 0.0003f); });
    add ("Percussion", "High Conga", [] {
        Buf b = modal (0.6f, 330, { { 1, 1, 0.2f }, { 1.59f, 0.25f, 0.06f }, { 2.14f, 0.2f, 0.05f }, { 2.65f, 0.1f, 0.03f } }, 0.06f, 0.04f);
        Buf s = noiseBurst (0.02f, 0.003f, 1, 2000, 1.0f, 92); normalize (b); normalize (s); mixInto (b, s, 0.2f); return b; });
    add ("Percussion", "Low Conga", [] {
        Buf b = modal (0.8f, 220, { { 1, 1, 0.26f }, { 1.59f, 0.25f, 0.07f }, { 2.14f, 0.2f, 0.05f }, { 2.65f, 0.1f, 0.03f } }, 0.08f, 0.05f);
        Buf s = noiseBurst (0.02f, 0.003f, 1, 1800, 1.0f, 93); normalize (b); normalize (s); mixInto (b, s, 0.2f); return b; });
    add ("Percussion", "Bongo", [] {
        Buf b = modal (0.4f, 470, { { 1, 1, 0.11f }, { 1.59f, 0.3f, 0.04f }, { 2.3f, 0.2f, 0.03f } }, 0.05f, 0.03f);
        Buf s = noiseBurst (0.02f, 0.002f, 1, 3000, 1.0f, 94); normalize (b); normalize (s); mixInto (b, s, 0.25f); return b; });
    add ("Percussion", "Shaker", [] {
        Buf b = highpass (noiseBurst (0.25f, 0.05f, 1, 7000, 1.0f, 95, 0.03f), 4000);
        return b; });
    add ("Percussion", "Tambourine", [] {
        static const float r[6] = { 1.0f, 1.17f, 1.43f, 1.61f, 1.97f, 2.31f };
        Buf b; for (int k = 0; k < 3; ++k) { Buf j = metal (0.5f, 2900, 0.13f, 5000, 9000, 1.0f, 0.4f, 96 + k, 0.001f, r); normalize (j); mixInto (b, j, 0.8f - 0.2f * k, ns (0.006f * k)); }
        return b; });
    add ("Percussion", "Triangle", [] { return modal (2.5f, 1250, { { 1, 1, 1.4f }, { 2.76f, 0.6f, 1.2f }, { 5.4f, 0.4f, 0.9f }, { 8.93f, 0.25f, 0.7f }, { 3.03f, 0.2f, 1.0f } }, 0, 0.05f, 0.0002f); });
    add ("Percussion", "Agogo", [] {
        Buf a = modal (0.6f, 900, { { 1, 1, 0.25f }, { 2.12f, 0.35f, 0.12f }, { 3.4f, 0.2f, 0.08f } }, 0, 0.05f, 0.0003f);
        return a; });
    add ("Percussion", "Timbale", [] {
        Buf b = modal (0.8f, 400, { { 1, 1, 0.25f }, { 1.5f, 0.6f, 0.2f }, { 2.21f, 0.5f, 0.12f }, { 2.95f, 0.3f, 0.1f }, { 3.6f, 0.25f, 0.08f } }, 0.03f, 0.03f);
        Buf s = noiseBurst (0.3f, 0.05f, 1, 5000, 0.8f, 99); normalize (b); normalize (s); mixInto (b, s, 0.3f); return b; });
    add ("Percussion", "Kalimba Pluck", [] { return modal (1.5f, 523.25f, { { 1, 1, 0.5f }, { 5.9f, 0.25f, 0.06f }, { 3.0f, 0.06f, 0.15f } }, 0, 0.05f, 0.0005f); });
    add ("Percussion", "Metal Ping", [] { return modal (1.8f, 740, { { 1, 1, 0.8f }, { 1.37f, 0.5f, 0.6f }, { 2.71f, 0.4f, 0.5f }, { 3.94f, 0.3f, 0.3f }, { 5.12f, 0.2f, 0.2f } }, 0, 0.05f, 0.0002f); });
    add ("Percussion", "Tabla Bend", [] {
        Buf b (ns (0.7f)); double ph = 0;
        for (int i = 0; i < (int) b.size(); ++i)
        { float t = tsec (i); float f = 150 + 70 * (1 - expEnv (t, 0.06f)); ph += f / SR; ph -= std::floor (ph);
          b[i] = (std::sin (kTwoPi * (float) ph) + 0.3f * std::sin (2 * kTwoPi * (float) ph)) * expEnv (t, 0.22f); }
        Buf s = noiseBurst (0.02f, 0.003f, 1, 2500, 1.0f, 100); normalize (b); normalize (s); mixInto (b, s, 0.15f); return b; });

    //---------------------------------------------------------------- FX (10)
    add ("FX", "Noise Riser", [] {
        Buf b (ns (2.8f)); Noise n (111); SVF s;
        for (int i = 0; i < (int) b.size(); ++i)
        { float t = tsec (i), x = t / 2.8f; if ((i & 15) == 0) s.set (300 + 9000 * x * x, 2.0f);
          b[i] = s.bp (n.next()) * x * x; }
        return b; });
    add ("FX", "Downlifter", [] {
        Buf b (ns (2.0f)); Noise n (112); SVF s; double ph = 0;
        for (int i = 0; i < (int) b.size(); ++i)
        { float t = tsec (i); if ((i & 15) == 0) s.set (8000 * expEnv (t, 0.5f) + 150, 1.5f);
          float f = 60 + 900 * expEnv (t, 0.4f); ph += f / SR; ph -= std::floor (ph);
          b[i] = (s.bp (n.next()) + 0.3f * std::sin (kTwoPi * (float) ph)) * expEnv (t, 0.6f); }
        return b; });
    add ("FX", "Laser Zap", [] {
        Buf b (ns (0.35f)); float ph = 0;
        for (int i = 0; i < (int) b.size(); ++i)
        { float t = tsec (i), f = 120 + 4000 * expEnv (t, 0.04f), dt = f / (float) SR; ph += dt; if (ph >= 1) ph -= 1;
          b[i] = squareBL (ph, dt) * expEnv (t, 0.1f); }
        return lowpass (b, 9000); });
    add ("FX", "Sci-Fi Blip", [] {
        Buf b (ns (0.4f)); float ph = 0;
        for (int i = 0; i < (int) b.size(); ++i)
        { float t = tsec (i), f = 600 + 900 * std::sin (kTwoPi * 18 * t) * expEnv (t, 0.2f) + 1200 * (1 - expEnv (t, 0.08f)), dt = f / (float) SR;
          ph += dt; if (ph >= 1) ph -= 1; b[i] = sawBL (ph, dt) * expEnv (t, 0.12f); }
        return lowpass (b, 5000, 2.0f); });
    add ("FX", "Big Impact", [] {
        KickP p; p.len = 2.0f; p.fStart = 160; p.fEnd = 35; p.pDecay = 0.08f; p.aDecay = 0.6f; p.click = 0.5f; p.drv = 2.5f;
        Buf b = kick (p); normalize (b);
        Buf n = noiseBurst (1.5f, 0.3f, 0, 3000, 0.7f, 113, 0.001f, 200, 0.3f); normalize (n); mixInto (b, n, 0.5f);
        return reverb (b, 0.9f, 0.4f, 0.6f, 1.5f); });
    add ("FX", "Sub Drop", [] { KickP p; p.len = 2.5f; p.fStart = 140; p.fEnd = 28; p.pDecay = 0.5f; p.aDecay = 0.9f; p.hold = 0.2f; p.click = 0.0f; p.drv = 1.5f; return kick (p); });
    add ("FX", "Reverse Cymbal", [] {
        Buf b = metal (2.0f, 480, 0.6f, 4000, 7500, 0.4f, 0.55f, 114, 0.002f, cymR); return reversed (b); });
    add ("FX", "Glitch Burst", [] {
        Buf b (ns (0.5f)); Noise n (115); float ph = 0; float f = 400;
        for (int i = 0; i < (int) b.size(); ++i)
        { if (i % ns (0.03f) == 0) f = 200 + 3000 * std::fabs (n.next());
          float dt = f / (float) SR; ph += dt; if (ph >= 1) ph -= 1;
          float gateOn = ((i / ns (0.015f)) % 3) != 2 ? 1.0f : 0.0f;
          b[i] = squareBL (ph, dt) * gateOn * expEnv (tsec (i), 0.25f); }
        return crush (b, 8000, 5, 7000); });
    add ("FX", "Whoosh", [] {
        Buf b (ns (1.4f)); Noise n (116); SVF s;
        for (int i = 0; i < (int) b.size(); ++i)
        { float t = tsec (i), x = t / 1.4f, env = std::sin (kPi * std::pow (x, 0.7f)); if ((i & 15) == 0) s.set (400 + 5000 * env * env, 3.0f);
          b[i] = s.bp (n.next()) * env * env; }
        return b; });
    add ("FX", "Vinyl Crackle Hit", [] {
        Buf b (ns (1.2f)); Noise n (117);
        for (int i = 0; i < (int) b.size(); ++i) { float r = n.next(); b[i] = (std::fabs (r) > 0.995f ? r : 0.0f) + 0.03f * n.next(); }
        b = bandpass (b, 2500, 0.6f);
        KickP p; p.len = 0.5f; p.fStart = 150; p.fEnd = 55; p.aDecay = 0.15f; Buf k = crush (kick (p), 11025, 8, 3000);
        normalize (b); normalize (k); for (size_t i = 0; i < b.size(); ++i) b[i] *= 0.5f * expEnv (tsec ((int) i), 0.5f); mixInto (b, k, 0.8f); return b; });

    add ("FX", "Metallic Impact", [] {
        Buf b = modal (2.5f, 95, { { 1, 1, 0.9f }, { 2.32f, 0.7f, 0.7f }, { 3.71f, 0.5f, 0.5f }, { 5.13f, 0.4f, 0.4f }, { 7.9f, 0.3f, 0.3f }, { 11.2f, 0.2f, 0.2f } }, 0.05f, 0.05f, 0.0003f);
        Buf n = noiseBurst (0.3f, 0.05f, 1, 3000, 0.7f, 118); normalize (b); normalize (n); mixInto (b, n, 0.4f);
        return reverb (drive (b, 2.0f), 0.8f, 0.5f, 0.4f, 1.0f); });
    add ("FX", "Robot Chirp", [] {
        Buf b (ns (0.45f)); float ph = 0; Noise n (119); float f = 800;
        for (int i = 0; i < (int) b.size(); ++i)
        { if (i % ns (0.045f) == 0) f = 500 + 1500 * std::fabs (n.next());
          float t = tsec (i), ff = f * (1.0f + 0.5f * std::sin (kTwoPi * 30 * t)), dt = ff / (float) SR;
          ph += dt; if (ph >= 1) ph -= 1; b[i] = squareBL (ph, dt) * (0.5f + 0.5f * std::sin (kTwoPi * 22 * t)) * expEnv (t, 0.18f); }
        return lowpass (b, 4000, 1.5f); });

    return v;
}
} // namespace

int main (int argc, char** argv)
{
    const std::string out = argc > 1 ? argv[1] : "library_src";
    mkdir (out.c_str(), 0755);
    auto sounds = buildSounds();
    int ok = 0;
    for (auto& s : sounds)
    {
        const std::string dir = out + "/" + s.cat; mkdir (dir.c_str(), 0755);
        Buf b = finish (s.make());
        const std::string path = dir + "/" + s.name + ".wav";
        if (writeWav (path, b)) ++ok; else std::fprintf (stderr, "failed: %s\n", path.c_str());
    }
    std::printf ("wrote %d / %zu sounds to %s\n", ok, sounds.size(), out.c_str());
    return ok == (int) sounds.size() ? 0 : 1;
}
