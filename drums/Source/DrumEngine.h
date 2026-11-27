// Pulse·16 — drum voice engine (no JUCE dependency, so it can be tested on its own)
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace drums
{
constexpr int   kNumTracks = 8;
constexpr int   kNumSteps  = 16;
constexpr float kPi        = 3.14159265358979f;
constexpr float kTwoPi     = 6.28318530717959f;

enum Kind { Kick = 0, Snare, Clap, ClosedHat, OpenHat, LowTom, HighTom, Cowbell };

inline const char* trackName (int t)
{
    static const char* names[] = { "KICK", "SNARE", "CLAP", "CL HAT", "OP HAT", "LO TOM", "HI TOM", "PERC" };
    return names[t];
}

//==============================================================================
struct Noise
{
    uint32_t s = 0x9E3779B9u;
    float next() noexcept
    {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return (float) (int32_t) s * (1.0f / 2147483648.0f);
    }
};

// Zero-delay-feedback state variable filter (Cytomic / Simper)
struct SVF
{
    float a1 = 0, a2 = 0, a3 = 0, k = 1, ic1 = 0, ic2 = 0;
    float low = 0, band = 0, high = 0;

    void set (float cutoff, float q, double sr) noexcept
    {
        cutoff = std::clamp (cutoff, 10.0f, (float) (sr * 0.45));
        const float g = std::tan (kPi * cutoff / (float) sr);
        k  = 1.0f / q;
        a1 = 1.0f / (1.0f + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
    }
    void reset() noexcept { ic1 = ic2 = low = band = high = 0; }
    void process (float v0) noexcept
    {
        const float v3 = v0 - ic2;
        const float v1 = a1 * ic1 + a2 * v3;
        const float v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2.0f * v1 - ic1;
        ic2 = 2.0f * v2 - ic2;
        low = v2; band = v1; high = v0 - k * v1 - v2;
    }
};

inline float polyBlep (float t, float dt) noexcept
{
    if (t < dt)        { t /= dt;          return t + t - t * t - 1.0f; }
    if (t > 1.0f - dt) { t = (t - 1.0f) / dt; return t * t + t + t + 1.0f; }
    return 0.0f;
}

// Band-limited square wave
inline float squareBL (float phase, float dt) noexcept
{
    float v = phase < 0.5f ? 1.0f : -1.0f;
    v += polyBlep (phase, dt);
    float p2 = phase + 0.5f;
    if (p2 >= 1.0f) p2 -= 1.0f;
    v -= polyBlep (p2, dt);
    return v;
}

inline void advance (float& phase, float inc) noexcept
{
    phase += inc;
    if (phase >= 1.0f) phase -= 1.0f;
}

//==============================================================================
struct SampleData
{
    std::vector<std::vector<float>> channels; // 1 or 2 channels
    double sampleRate = 44100.0;
    size_t length() const noexcept { return channels.empty() ? 0 : channels[0].size(); }
};

struct TriggerParams
{
    float tune     = 0.0f;  // semitones, -24..+24
    float decay    = 0.5f;  // 0..1
    float tone     = 0.5f;  // 0..1
    float velocity = 1.0f;  // 0..1
};

//==============================================================================
class Voice
{
public:
    void prepare (double newSampleRate, int kindIn, uint32_t seed)
    {
        sr = newSampleRate;
        kind = kindIn;
        noise.s = seed;
        active = false;
    }

    bool isActive() const noexcept { return active; }

    // Pass a sample to play it; pass nullptr to use the synth voice.
    void trigger (const TriggerParams& p, std::shared_ptr<const SampleData> s)
    {
        sample  = std::move (s);
        vel     = p.velocity;
        t       = 0;
        gainEnv = 1.0f;
        gainC   = 1.0f;
        active  = true;
        f1.reset(); f2.reset(); f3.reset();

        const float k = std::pow (2.0f, p.tune / 12.0f);

        if (sample != nullptr && sample->length() > 2)
        {
            pos   = 0.0;
            rate  = sample->sampleRate / sr * (double) k;
            env1  = 1.0f;
            env1C = p.decay >= 0.98f ? 1.0f : coef (0.03f + p.decay * p.decay * 2.5f);
            env2  = 0.0f;
            useLp = p.tone < 0.98f;
            const float cut = 150.0f * std::pow (133.0f, p.tone);
            f1.set (cut, 0.707f, sr);
            f2.set (cut, 0.707f, sr);
            return;
        }

        for (auto& ph : phase) ph = 0.0f;
        const float d = p.decay, tone = p.tone;

        switch (kind)
        {
            case Kick:
                base  = 46.0f * k;
                penv  = 1.0f;  penvC = coef (0.028f);
                env1  = 1.0f;  env1C = coef (0.06f + d * d * 1.0f);
                env2  = 1.0f;  env2C = coef (0.004f);              // click
                f1.set (3000.0f, 0.7f, sr);
                drive = 1.0f + tone * 5.0f;
                driveNorm = 1.0f / std::tanh (drive);
                break;

            case Snare:
                freq[0] = 182.0f * k;  freq[1] = 331.0f * k;
                penv = 1.0f;  penvC = coef (0.012f);
                env1 = 1.0f;  env1C = coef (0.035f + d * 0.11f);    // body
                env2 = 1.0f;  env2C = coef (0.04f + d * 0.25f);    // snares
                f1.set (1300.0f, 0.7f, sr);
                f2.set (9000.0f, 0.7f, sr);
                amt1 = 1.0f - 0.55f * tone;
                amt2 = 0.35f + 0.8f * tone;
                break;

            case Clap:
                f1.set ((850.0f + tone * 1400.0f) * k, 1.5f, sr);
                f2.set (350.0f, 0.7f, sr);
                env1 = 1.0f;
                env2 = 1.0f;  env2C = coef (0.05f + d * 0.3f);
                break;

            case ClosedHat:
            case OpenHat:
            {
                static const float ratios[6] = { 205.3f, 304.4f, 369.6f, 522.7f, 540.0f, 800.0f };
                for (int i = 0; i < 6; ++i)
                {
                    freq[i]  = ratios[i] * k;
                    phase[i] = std::abs (noise.next());
                }
                f1.set (9500.0f, 1.1f, sr);
                f2.set (5200.0f + tone * 4300.0f, 0.7f, sr);
                env1  = 1.0f;
                env1C = kind == ClosedHat ? coef (0.012f + d * 0.06f)
                                          : coef (0.06f + d * 0.6f);
                env2  = 0.0f;
                break;
            }

            case LowTom:
            case HighTom:
                base  = (kind == LowTom ? 92.0f : 142.0f) * k;
                penv  = 1.0f;  penvC = coef (0.06f);
                env1  = 1.0f;  env1C = coef (0.08f + d * 0.45f);
                env2  = 1.0f;  env2C = coef (0.012f);
                f1.set (base * 6.0f, 1.0f, sr);
                amt2  = 0.15f + tone * 0.7f;
                break;

            case Cowbell:
                freq[0] = 540.0f * k;  freq[1] = 800.0f * k;
                f1.set (1700.0f * k * (0.7f + 0.6f * tone), 1.8f, sr);
                f2.set (450.0f, 0.7f, sr);
                env1 = 1.0f;  env1C = coef (0.015f);
                env2 = 1.0f;  env2C = coef (0.05f + d * 0.35f);
                break;

            default: active = false; break;
        }
    }

    // Fast fade-out (open hat choked by closed hat)
    void choke() noexcept
    {
        if (active) gainC = coef (0.006f);
    }

    // Adds into l/r with the given channel gains.
    void render (float* l, float* r, int n, float gl, float gr) noexcept
    {
        if (! active) return;

        if (sample != nullptr) { renderSample (l, r, n, gl, gr); return; }

        for (int i = 0; i < n; ++i)
        {
            const float x = nextSynth() * vel * gainEnv;
            gainEnv *= gainC;
            l[i] += x * gl;
            r[i] += x * gr;
            ++t;

            if ((env1 < 1.0e-4f && env2 < 1.0e-4f) || gainEnv < 1.0e-4f)
            {
                active = false;
                break;
            }
        }
    }

private:
    float coef (float seconds) const noexcept
    {
        return std::exp (-1.0f / (std::max (seconds, 0.0005f) * (float) sr));
    }

    float nextSynth() noexcept
    {
        const float isr = 1.0f / (float) sr;

        switch (kind)
        {
            case Kick:
            {
                const float f = base * (1.0f + 3.2f * penv * penv + 0.6f * penv);
                advance (phase[0], f * isr);
                const float body = std::sin (kTwoPi * phase[0]) * env1;
                f1.process (noise.next());
                const float click = f1.high * env2 * 0.45f;
                penv *= penvC; env1 *= env1C; env2 *= env2C;
                return std::tanh ((body + click) * drive) * driveNorm * 0.95f;
            }

            case Snare:
            {
                const float pm = 1.0f + 0.45f * penv;
                advance (phase[0], freq[0] * pm * isr);
                advance (phase[1], freq[1] * pm * isr);
                const float body = (0.65f * std::sin (kTwoPi * phase[0])
                                  + 0.35f * std::sin (kTwoPi * phase[1])) * env1 * amt1;
                f1.process (noise.next());
                f2.process (f1.high);
                const float snares = f2.low * env2 * amt2 * 1.4f;
                penv *= penvC; env1 *= env1C; env2 *= env2C;
                return std::tanh ((body + snares) * 1.2f) * 0.85f;
            }

            case Clap:
            {
                const float ts = (float) t * isr;
                float e;
                if (ts < 0.033f)
                {
                    const float m = std::fmod (ts, 0.011f);
                    e = std::exp (-m / 0.0035f);
                }
                else
                {
                    env2 *= env2C;
                    e = env2;
                    env1 = env2;
                }
                f1.process (noise.next());
                f2.process (f1.band);
                return std::tanh (f2.high * e * 2.6f) * 0.9f;
            }

            case ClosedHat:
            case OpenHat:
            {
                float m = 0.0f;
                for (int i = 0; i < 6; ++i)
                {
                    const float dt = freq[i] * isr;
                    m += squareBL (phase[i], dt);
                    advance (phase[i], dt);
                }
                m = m * (1.0f / 6.0f) * 0.85f + noise.next() * 0.22f;
                f1.process (m);
                f2.process (f1.band);
                const float out = f2.high * env1 * 2.4f;
                env1 *= env1C;
                return std::tanh (out);
            }

            case LowTom:
            case HighTom:
            {
                const float f = base * (1.0f + 0.6f * penv);
                advance (phase[0], f * isr);
                const float body = std::sin (kTwoPi * phase[0]) * env1;
                f1.process (noise.next());
                const float attack = f1.band * env2 * amt2;
                penv *= penvC; env1 *= env1C; env2 *= env2C;
                return std::tanh ((body + attack) * 1.3f) * 0.85f;
            }

            case Cowbell:
            {
                const float d0 = freq[0] * isr, d1 = freq[1] * isr;
                const float sq = squareBL (phase[0], d0) + squareBL (phase[1], d1);
                advance (phase[0], d0);
                advance (phase[1], d1);
                f1.process (sq);
                f2.process (f1.band);
                const float out = f2.high * (0.6f * env1 + 0.4f * env2) * 0.9f;
                env1 *= env1C; env2 *= env2C;
                return std::tanh (out);
            }

            default:
                return 0.0f;
        }
    }

    void renderSample (float* l, float* r, int n, float gl, float gr) noexcept
    {
        const size_t len = sample->length();
        const float* c0 = sample->channels[0].data();
        const float* c1 = sample->channels.size() > 1 ? sample->channels[1].data() : c0;

        for (int i = 0; i < n; ++i)
        {
            const size_t idx = (size_t) pos;
            if (idx + 1 >= len) { active = false; break; }

            const float frac = (float) (pos - (double) idx);
            float a = c0[idx] + frac * (c0[idx + 1] - c0[idx]);
            float b = c1[idx] + frac * (c1[idx + 1] - c1[idx]);

            if (useLp)
            {
                f1.process (a); a = f1.low;
                f2.process (b); b = f2.low;
            }

            const float g = env1 * gainEnv * vel;
            l[i] += a * g * gl;
            r[i] += b * g * gr;

            env1    *= env1C;
            gainEnv *= gainC;
            pos     += rate;

            if (env1 < 1.0e-4f || gainEnv < 1.0e-4f) { active = false; break; }
        }
    }

    double sr = 44100.0;
    int kind = Kick;
    bool active = false;
    Noise noise;
    SVF f1, f2, f3;

    std::shared_ptr<const SampleData> sample;
    double pos = 0.0, rate = 1.0;
    bool useLp = false;

    int64_t t = 0;
    float vel = 1.0f, gainEnv = 1.0f, gainC = 1.0f;
    float base = 50.0f, penv = 0.0f, penvC = 0.0f;
    float env1 = 0.0f, env1C = 0.0f, env2 = 0.0f, env2C = 0.0f;
    float drive = 1.0f, driveNorm = 1.0f, amt1 = 1.0f, amt2 = 1.0f;
    float freq[6]  {};
    float phase[6] {};
};

//==============================================================================
// MIDI note -> track mapping (pure functions, tested headlessly)
enum KeymapMode { KeymapEveryOctave = 0, KeymapGM = 1 };

// "Every octave": C C# D D# E F F# G -> tracks 1-8 in every octave; G#..B ignored.
inline int noteToTrackEveryOctave (int note) noexcept
{
    if (note < 0 || note > 127) return -1;
    const int pc = note % 12;
    return pc < kNumTracks ? pc : -1;
}

// General MIDI drum map
inline int noteToTrackGM (int note) noexcept
{
    switch (note)
    {
        case 35: case 36:                   return Kick;
        case 37: case 38: case 40:          return Snare;
        case 39:                            return Clap;
        case 42: case 44:                   return ClosedHat;
        case 46:                            return OpenHat;
        case 41: case 43: case 45:          return LowTom;
        case 47: case 48: case 50:          return HighTom;
        case 54: case 56: case 75: case 76: return Cowbell;   // track 8 = perc
        default:                            return -1;
    }
}

inline int noteToTrack (int note, int keymapMode) noexcept
{
    return keymapMode == KeymapGM ? noteToTrackGM (note) : noteToTrackEveryOctave (note);
}

//==============================================================================
// Sequencer timeline. Step k (absolute 16th index) sounds at k * 0.25 quarter notes,
// odd steps delayed by the swing amount (in quarter notes).
inline double stepTimePpq (long long k, double swingDelayPpq) noexcept
{
    return (double) k * 0.25 + ((k & 1) ? swingDelayPpq : 0.0);
}

inline int stepIndexInPattern (long long k) noexcept
{
    return (int) (((k % kNumSteps) + kNumSteps) % kNumSteps);
}

// Which absolute step a live hit at hitPpq is recorded on.
//   quantize = true : nearest step (swing-aware)
//   quantize = false: the step whose window the hit falls in (latest step at or before the hit)
inline long long recordStepFor (double hitPpq, double swingDelayPpq, bool quantize) noexcept
{
    const long long k0 = (long long) std::floor (hitPpq / 0.25);
    const double eps = 1.0e-9;

    if (! quantize)
    {
        // Swing can push step k0 (if odd) after the hit; then the hit belongs to k0 - 1.
        for (long long k = k0 + 1; k >= k0 - 2; --k)
            if (stepTimePpq (k, swingDelayPpq) <= hitPpq + eps)
                return k;
        return k0 - 2;
    }

    long long best = k0;
    double bestDist = 1.0e30;
    for (long long k = k0 - 1; k <= k0 + 2; ++k)
    {
        const double d = std::abs (stepTimePpq (k, swingDelayPpq) - hitPpq);
        if (d < bestDist - eps) { bestDist = d; best = k; }
    }
    return best;
}

} // namespace drums
