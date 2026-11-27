#!/usr/bin/env python3
"""Ember Ultimate offline sample-library renderer.

Synthesises every sample in ultimate/samples/ from scratch (no downloads), encodes
to AAC/.m4a with ffmpeg and writes samples/manifest.json in the CONTRACT format.

Techniques
  * grand      modal piano: stretched (inharmonic, B coefficient) partials, 1-3 detuned
               strings per note, per-partial frequency-dependent two-stage decay,
               strike-position comb, velocity-dependent hammer low-pass, hammer thump,
               soundboard modal IR convolution, hall reverb.
  * epiano     FM tine (ratio-1 body + ratio-14 tine ping) through an asymmetric
               pickup non-linearity -> velocity-dependent "bark".
  * plucks     extended Karplus-Strong (one-pole loss filter, all-pass fine tuning,
               pluck-position comb, two polarisations) + body modal IR.
  * mallets    modal bars (tuned 1:4:10 marimba / vibes), resonator tube, mallet noise.
  * strings / choir / pads / textures
               additive & polyBLEP ensembles with vibrato, drift and formants. Every
               modulation and oscillator frequency is snapped to a multiple of
               SR/loopLength so the sustain section is *exactly* periodic -> the loop is
               seamless by construction (plus a tiny safety crossfade).
  * drums      analog-modelled 808/909 (pitch-env kicks, bridged-T style tones,
               six-square-oscillator metal for hats/cymbals/cowbell, multi-burst claps),
               an acoustic kit (membrane modes, snare wires, cymbal partial clouds, room)
               and a lo-fi kit (saturation, sample-rate/bit reduction, vinyl crackle).

AAC priming: ffmpeg writes an MP4 edit list; Chrome's decodeAudioData and Safari honour
it (verified: decoded length and onset are sample-exact), so starts are tight and loop
points (seconds) line up.

Usage:  python3 tools/render_samples.py [--only grand,808] [--verify] [--png]
"""
import os, sys, json, math, subprocess, hashlib, argparse, time, shutil
import numpy as np
from scipy import signal
from scipy.optimize import brentq
from multiprocessing import Pool

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'samples')
FFMPEG = '/usr/local/bin/ffmpeg' if os.path.exists('/usr/local/bin/ffmpeg') else 'ffmpeg'
NOTE_NAMES = ['c', 'cs', 'd', 'ds', 'e', 'f', 'fs', 'g', 'gs', 'a', 'as', 'b']
PEAK = 10 ** (-1 / 20)
PAD = 1024
RAWDIR = os.environ.get('EMBER_RAW_CACHE', '/tmp/ember-samples-raw')  # float32 renders kept for --verify


def note_name(m):
    return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"


def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def seed_of(*a):
    return int(hashlib.md5(repr(a).encode()).hexdigest()[:8], 16)


def ns(sec):
    return int(round(sec * SR))


def T(n):
    return np.arange(n) / SR


# ----------------------------------------------------------------------------- filters
def _sos(kind, fc, order):
    if isinstance(fc, (list, tuple)):
        fc = [min(max(f, 5), SR * 0.49) for f in fc]
    else:
        fc = min(max(fc, 5), SR * 0.49)
    return signal.butter(order, fc, kind, fs=SR, output='sos')


def lp(x, fc, order=2):
    return signal.sosfilt(_sos('low', fc, order), x, axis=0)


def hp(x, fc, order=2):
    return signal.sosfilt(_sos('high', fc, order), x, axis=0)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_sos('band', [lo, hi], order), x, axis=0)


def lp1(x, fc):
    a = math.exp(-2 * math.pi * fc / SR)
    return signal.lfilter([1 - a], [1, -a], x, axis=0)


def hp1(x, fc):
    a = math.exp(-2 * math.pi * fc / SR)
    return signal.lfilter([(1 + a) / 2, -(1 + a) / 2], [1, -a], x, axis=0)


def peq(x, f0, gain_db, q):
    A = 10 ** (gain_db / 40)
    w = 2 * math.pi * min(f0, SR * 0.45) / SR
    al = math.sin(w) / (2 * q)
    b = [1 + al * A, -2 * math.cos(w), 1 - al * A]
    a = [1 + al / A, -2 * math.cos(w), 1 - al / A]
    return signal.lfilter(b, a, x, axis=0)


def reson(x, f0, bw):
    """Constant 0 dB peak-gain band-pass resonator."""
    f0 = min(f0, SR * 0.45)
    w = 2 * math.pi * f0 / SR
    q = max(f0 / bw, 0.3)
    al = math.sin(w) / (2 * q)
    return signal.lfilter([al, 0, -al], [1 + al, -2 * math.cos(w), 1 - al], x, axis=0)


# ----------------------------------------------------------------------------- oscillators
def modes(n, freqs, amps, rates, phases=None, t0=0):
    """Sum of exponentially decaying sines. rates are decay rates (1/s, T60 = 6.91/rate)."""
    out = np.zeros(n)
    t = T(n)
    if phases is None:
        phases = np.zeros(len(freqs))
    for f, a, r, ph in zip(freqs, amps, rates, phases):
        if f <= 0 or f >= SR * 0.46 or a == 0:
            continue
        L = n if r <= 0 else min(n, int(11.5 / r * SR) + 1)
        tt = t[:L]
        out[:L] += a * np.exp(-r * tt) * np.sin(2 * np.pi * f * tt + ph)
    return out


def blep_saw_phase(ph, dt):
    """Band-limited saw (-1..1) from an unwrapped phase (cycles) and per-sample increment."""
    p = ph % 1.0
    y = 2 * p - 1
    dt = np.broadcast_to(dt, p.shape)
    m1 = p < dt
    tt = p[m1] / dt[m1]
    y[m1] -= tt + tt - tt * tt - 1
    m2 = p > 1 - dt
    tt = (p[m2] - 1) / dt[m2]
    y[m2] -= tt * tt + tt + tt + 1
    return y


def saw(f, n, ph0=0.0):
    dt = f / SR
    return blep_saw_phase(ph0 + np.arange(n) * dt, np.full(n, dt))


def square(f, n, ph0=0.0):
    return 0.5 * (saw(f, n, ph0) - saw(f, n, ph0 + 0.5))


def sweep_phase(freq):
    """phase (radians) from instantaneous frequency array, starting at 0"""
    return 2 * np.pi * np.concatenate([[0], np.cumsum(freq[:-1])]) / SR


def noise(n, rng):
    return rng.standard_normal(n)


def pnoise(Ns, lo, hi, rng, n_out=None):
    """Periodic (period Ns samples) band-limited zero-mean noise, unit std."""
    nb = Ns // 2 + 1
    fr = np.arange(nb) * SR / Ns
    spec = np.zeros(nb, complex)
    sel = (fr >= lo) & (fr <= hi) & (fr > 0)
    k = int(sel.sum())
    if k == 0:
        sel[1] = True
        k = 1
    spec[sel] = rng.standard_normal(k) + 1j * rng.standard_normal(k)
    x = np.fft.irfft(spec, Ns)
    x /= (x.std() + 1e-12)
    if n_out is None:
        return x
    reps = n_out // Ns + 1
    return np.tile(x, reps)[:n_out]


def env_ad(n, a, d):
    t = T(n)
    return (1 - np.exp(-t / max(a, 1e-5))) * np.exp(-t / d)


# ----------------------------------------------------------------------------- reverb / IR
def make_ir(rt60, length=None, stereo=False, predelay=0.008, hf_ratio=0.45, seed=1,
            er=0.5, diffuse_in=0.012, bright=1.0):
    length = length or min(rt60 * 1.0, 3.0)
    n = ns(length)
    rng = np.random.default_rng(seed)
    chs = 2 if stereo else 1
    t = T(n)
    ir = np.zeros((n + ns(predelay) + 1, chs))
    for c in range(chs):
        w = rng.standard_normal(n)
        lo = lp(w, 1200 * bright)
        hi = w - lo
        sl = 6.91 / rt60
        sh = 6.91 / (rt60 * hf_ratio)
        d = lo * np.exp(-sl * t) + 0.8 * hi * np.exp(-sh * t)
        d *= 1 - np.exp(-t / diffuse_in)
        d /= np.sqrt(np.sum(d ** 2))
        # early reflections
        e = np.zeros(n)
        for _ in range(10):
            ti = rng.uniform(0.003, 0.045)
            k = ns(ti)
            if k < n:
                e[k] += rng.choice([-1, 1]) * rng.uniform(0.4, 1.0) * math.exp(-ti / 0.05)
        e = lp(e, 6000 * bright)
        if np.any(e):
            e /= np.sqrt(np.sum(e ** 2))
        d = d + er * e
        d = lp(d, 12000 * bright, 1)
        pd = ns(predelay)
        ir[pd:pd + n, c] = d
    ir /= np.sqrt(np.sum(ir ** 2) / chs)
    return ir


def add_reverb(x, ir, wet, circular=False, wet_hp=0):
    """x: (n,) or (n,c). Returns (n_out, ch) with dry + wet (wet input optionally high-passed)."""
    if x.ndim == 1:
        x = x[:, None]
    xw = hp(x, wet_hp, 2) if wet_hp else x
    chs = max(x.shape[1], ir.shape[1])
    n = x.shape[0]
    if circular:
        out = np.zeros((n, chs))
        for c in range(chs):
            xc = x[:, c % x.shape[1]]
            ic = ir[:, c % ir.shape[1]]
            if len(ic) > n:
                ic = ic[:n]
            H = np.fft.rfft(ic, n)
            out[:, c] = xc + wet * np.fft.irfft(np.fft.rfft(xw[:, c % x.shape[1]]) * H, n)
        return out
    m = n + ir.shape[0] - 1
    out = np.zeros((m, chs))
    for c in range(chs):
        xc = x[:, c % x.shape[1]]
        out[:n, c] += xc
        out[:, c] += wet * signal.fftconvolve(xw[:, c % x.shape[1]], ir[:, c % ir.shape[1]])
    return out


def modal_ir(length, modes_spec, rng, n_random=0, flo=200, fhi=4000, tau_lo=0.05, tau_hi=0.01,
             direct=1.0):
    """Body/soundboard IR: direct impulse + resonant modes."""
    n = ns(length)
    t = T(n)
    ir = np.zeros(n)
    for f, tau, a in modes_spec:
        ir += a * np.exp(-t / tau) * np.sin(2 * np.pi * f * t)
    for _ in range(n_random):
        f = math.exp(rng.uniform(math.log(flo), math.log(fhi)))
        fr = (math.log(f) - math.log(flo)) / (math.log(fhi) - math.log(flo))
        tau = tau_lo * (tau_hi / tau_lo) ** fr
        ir += rng.uniform(0.2, 1.0) * (flo / f) ** 0.5 * np.exp(-t / tau) * np.sin(
            2 * np.pi * f * t + rng.uniform(0, 6.28))
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-12
    ir[0] += direct
    return ir


# ----------------------------------------------------------------------------- finishing
def as2d(x):
    return x[:, None] if x.ndim == 1 else x


def fade(x, fin=0.0, fout=0.0):
    x = as2d(x).copy()
    n = x.shape[0]
    a = min(ns(fin), n)
    if a > 1:
        x[:a] *= (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a)))[:, None]
    b = min(ns(fout), n)
    if b > 1:
        x[-b:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, b)))[:, None]
    return x


def finish(x, *, lead_trim=False, trim_db=-62, fout=0.02, fin=0.0003, max_len=None,
           keep_len=False, dc=True):
    x = as2d(np.asarray(x, float))
    if dc:
        x = hp1(x, 8.0)
    if max_len is not None:
        x = x[:ns(max_len)]
    mono = np.max(np.abs(x), axis=1)
    pk = mono.max() + 1e-12
    if lead_trim:
        idx = int(np.argmax(mono > pk * 10 ** (-50 / 20)))
        x = x[max(0, idx - 2):]
        mono = mono[max(0, idx - 2):]
    if not keep_len:
        envv = signal.lfilter([1 - 0.999], [1, -0.999], mono)  # rough follower
        thr = pk * 10 ** (trim_db / 20)
        above = np.nonzero(np.maximum(envv, mono) > thr)[0]
        end = int(above[-1]) + ns(0.01) if len(above) else x.shape[0]
        x = x[:min(end, x.shape[0])]
    x = fade(x, fin, fout)
    pk = np.max(np.abs(x)) + 1e-12
    x = x * (PEAK / pk)
    assert np.all(np.isfinite(x))
    return x


def loop_finish(x, ls, le, xf=0.02, tail=0.25):
    """x periodic after ls with period (le-ls). Safety crossfade + continue tail from ls."""
    x = as2d(np.asarray(x, float))
    x = hp1(x, 8.0)
    L = le - ls
    k = min(ns(xf), L // 4, ls)
    pre = x[ls - k:ls].copy()
    end = x[le - k:le].copy()
    w = np.linspace(0, 1, k)[:, None]
    rho = np.sum(pre * end) / (np.sqrt(np.sum(pre ** 2) * np.sum(end ** 2)) + 1e-12)
    g_out, g_in = 1 - w, w
    norm = np.sqrt(g_out ** 2 + g_in ** 2 + 2 * max(rho, -0.5) * g_out * g_in)
    x[le - k:le] = (end * g_out + pre * g_in) / norm
    nt = ns(tail)
    tailseg = x[ls:ls + nt].copy()
    x = np.concatenate([x[:le], tailseg], axis=0)
    x = fade(x, 0.0003, tail * 0.9)
    pk = np.max(np.abs(x)) + 1e-12
    x = x * (PEAK / pk)
    return x, rho


# ----------------------------------------------------------------------------- periodic grid
def grid(f0, Lt, even=False):
    """Pick loop length Ns (samples) holding an integer number M of f0 cycles (~Lt s).
    Returns Ns, u (Hz per grid step = SR/Ns), M; f0q = M*u (error < 0.01 cent)."""
    M = max(1, int(round(f0 * Lt)))
    if even and M % 2:
        M += 1
    Ns = int(round(M * SR / f0))
    return Ns, SR / Ns, M


def qrate(rate, u):
    return max(1, int(round(rate / u))) * u


# ============================================================================= INSTRUMENTS
BSCALE = 1.0


def repitch(x, cents):
    """Tiny pitch shift by cubic-spline resampling (length preserved)."""
    from scipy.interpolate import make_interp_spline
    r = 2 ** (cents / 1200)
    n = len(x)
    pos = np.arange(n) * r
    sp = make_interp_spline(np.arange(n), x, k=3)
    y = sp(np.clip(pos, 0, n - 1))
    y[pos > n - 1] = 0
    return y


def r_grand(m, vel, seed):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    dur = float(np.interp(m, [21, 48, 72, 96, 108], [8.0, 6.5, 4.8, 3.0, 2.2]))
    n = ns(dur)
    t = T(n)
    B = BSCALE * float(np.interp(m, [21, 40, 60, 84, 108], [0.06, 0.08, 0.3, 0.4, 0.5])) * 10 ** float(np.interp(m, [21, 40, 60, 84, 108], [-3.75, -3.7, -3.45, -2.8, -1.95]))
    T60 = float(np.interp(m, [21, 48, 60, 72, 84, 96, 108], [20, 15, 11, 7.5, 4.5, 2.2, 1.0]))
    s1 = 6.91 / T60
    nstr = 1 if m < 28 else (2 if m < 35 else 3)
    det = np.array({1: [0.0], 2: [-0.4, 0.4], 3: [-0.55, 0.0, 0.55]}[nstr]) * rng.uniform(0.7, 1.3)
    x0 = float(np.interp(m, [21, 108], [1 / 7.2, 1 / 10.0]))
    fc = max(380 + 5200 * vel ** 2.0, f0 * (1.2 + 3.5 * vel))
    lowcut = float(np.interp(m, [21, 60], [70, 40]))
    att = (1 - np.exp(-t / (0.0005 + 0.0016 * (1 - vel))))
    out = np.zeros(n)
    k = 1
    fmax = 17000
    while k <= 170:
        fk = k * f0 * math.sqrt((1 + B * k * k) / (1 + B))  # stretch relative to the fundamental
        if fk > fmax:
            break
        a = (abs(math.sin(math.pi * k * x0)) + 0.04) / k ** 0.35
        a /= math.sqrt(1 + (fk / fc) ** 4)
        a /= math.sqrt(1 + (lowcut / fk) ** 2)
        a *= rng.uniform(0.8, 1.2)
        sk = s1 * (1 + 0.012 * (k - 1)) + 3.5e-7 * fk * fk
        w = 0.07
        L = min(n, int(11.5 / (0.22 * sk) * SR) + 1)
        tt = t[:L]
        e = (1 - w) * np.exp(-sk * tt) + w * np.exp(-0.22 * sk * tt)
        car = np.zeros(L)
        for d in det:
            fd = fk * 2 ** (d / 1200)
            car += np.sin(2 * np.pi * fd * tt + rng.uniform(0, 2 * np.pi))
        out[:L] += a * e * car / len(det)
        k += 1
    out *= att
    out /= np.max(np.abs(out)) + 1e-12
    # hammer thump + key/frame knock
    thump = lp(noise(n, rng), 250 + 2200 * vel) * np.exp(-t / 0.010)
    thump /= np.max(np.abs(thump)) + 1e-12
    knock = modes(n, [62, 110, 175, 260], [1, .7, .5, .3], [6.91 / .09, 6.91 / .07, 6.91 / .05, 6.91 / .04])
    knock /= np.max(np.abs(knock)) + 1e-12
    out = out + (0.04 + 0.10 * vel ** 2) * thump * float(np.interp(m, [21, 108], [1, 0.4])) \
        + (0.03 + 0.05 * vel) * knock
    # soundboard
    sb = modal_ir(0.3, [], rng, n_random=60, flo=70, fhi=5000, tau_lo=0.12, tau_hi=0.012, direct=0)
    out = out + 0.30 * signal.fftconvolve(out, sb)[:n]
    out = lp(out, 15000, 1)
    # Residual stretch makes the perceived (periodicity) pitch slightly sharp of the exact
    # fundamental. Split the difference so both sit within a few cents of the root.
    fy = float(np.median([yin_pitch(out[ns(0.25) + k * 4096:][:8192], fmin=f0 / 2.2,
                                    fmax=min(f0 * 1.6, SR / 4))[0] for k in range(5)]))
    c = 1200 * math.log2(fy / f0)
    if abs(c) < 30:
        out = repitch(out, -c / 2)
    ir = make_ir(1.7, 1.8, seed=11, hf_ratio=0.4, predelay=0.015)
    y = add_reverb(out, ir, 0.11)[:n]
    y = fade(y, 0, min(1.0, dur * 0.25))
    return finish(y, trim_db=-70, keep_len=True, fout=0.0)


def r_epiano(m, vel, seed):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    dur = float(np.interp(m, [28, 60, 100], [5.0, 4.0, 2.2]))
    n = ns(dur)
    t = T(n)
    T60 = float(np.interp(m, [28, 48, 60, 72, 84, 100], [9, 7, 5.5, 4, 2.8, 1.6]))
    s = 6.91 / T60
    amp = (1 - np.exp(-t / 0.0007)) * (0.8 * np.exp(-s * t) + 0.2 * np.exp(-3 * s * t))
    hscale = float(np.interp(m, [28, 60, 100], [1.25, 1.0, 0.45]))
    I1 = ((0.25 + 1.7 * vel ** 2) * np.exp(-t / (0.10 + 0.35 * (1 - vel))) + 0.10) * hscale
    I2 = (0.4 + 1.6 * vel) * np.exp(-t / 0.007) * float(np.interp(m, [28, 100], [1.0, 0.3]))
    pc = 2 * np.pi * f0 * t
    mod2 = np.sin(2 * np.pi * f0 * 14.0 * t) if f0 * 14 * 2 < SR * 0.45 else 0
    x = np.sin(pc + I1 * np.sin(pc) + I2 * mod2) * amp
    if f0 * 6.27 < SR * 0.42:
        x += (0.05 + 0.12 * vel) * np.exp(-t / 0.06) * np.sin(2 * np.pi * f0 * 6.27 * t) * amp
    d = 0.5 + 2.6 * vel ** 2
    off = 0.32
    y = (np.tanh(d * (x + off)) - math.tanh(d * off)) / (d * (1 - math.tanh(d * off) ** 2))
    y = hp(y, 35)
    y = lp(y, 6500 + 4000 * vel, 1)
    y /= np.max(np.abs(y))
    thunk = lp(noise(n, rng), 700) * np.exp(-t / 0.012)
    y += 0.03 * vel * thunk / (np.max(np.abs(thunk)) + 1e-9)
    ir = make_ir(1.0, 1.0, seed=12, hf_ratio=0.5)
    y = add_reverb(y, ir, 0.06)[:n]
    y = fade(y, 0, 0.6)
    return finish(y, trim_db=-70, keep_len=True, fout=0.0)


# ---------------------------------------------------------------- Karplus-Strong
def ks(f0, n, T60, p, exc, detune=0.0):
    f = f0 * 2 ** (detune / 1200)
    D = SR / f
    w = 2 * np.pi * f / SR
    Hlp = (1 - p) / (1 - p * np.exp(-1j * w))
    lpd = -np.angle(Hlp) / w
    N = int(math.floor(D - lpd - 0.15))
    d = D - lpd - N

    def apd(c):
        H = (c + np.exp(-1j * w)) / (1 + c * np.exp(-1j * w))
        return -np.unwrap([np.angle(H)])[0] / w - d

    try:
        c = brentq(apd, -0.95, 0.999)
    except ValueError:
        c = (1 - d) / (1 + d)
    g = math.exp(-6.91 / (T60 * f)) / abs(Hlp)
    g = min(g, 0.99995)
    b = np.polymul([1, -p], [1, c])
    a = np.zeros(N + 2)
    a[:3] += b
    a[N] -= g * (1 - p) * c
    a[N + 1] -= g * (1 - p)
    return signal.lfilter(b, a, exc[:n])


def calibrate(y, f0, start=0.25):
    """Split any residual difference between periodicity pitch and fundamental (loss-filter
    dispersion) so both sit on the root."""
    W = 16384
    fys = [yin_pitch(y[w0:w0 + W], fmin=f0 / 2.2, fmax=min(f0 * 1.6, SR / 4))[0]
           for w0 in range(ns(start), min(len(y) - W, ns(start) + 9 * 2048), 2048)]
    seg = y[ns(0.05):][:1 << 18]
    nfft = 1 << 18
    sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), nfft))
    cf = 1200 * math.log2(harm_centroid(sp, np.arange(len(sp)) * SR / nfft, f0, H=2) / f0)
    if fys and f0 < 1000:
        cy = 1200 * math.log2(float(np.median(fys)) / f0)
        c = (cy + cf) / 2 if abs(cy) < 30 else cf
    else:
        c = cf
    return repitch(y, -c) if abs(c) < 30 else y


def pluck_exc(f0, n, rng, beta, fc, shape=0.5):
    P = max(4, int(SR / f0))
    e = np.zeros(n)
    burst = lp(rng.standard_normal(P + 64), fc, 2)[64:]
    tri = np.interp(np.arange(P), [0, beta * P, P], [0, 1, 0])
    win = np.sin(np.linspace(0, np.pi, P))
    seg = (1 - shape) * burst / (np.std(burst) + 1e-9) * win + shape * 2.0 * (tri - tri.mean())
    e[:P] = seg
    k = max(1, int(round(beta * P)))
    e2 = e.copy()
    e2[k:] -= e[:-k]
    return e2


def r_guitar(m, vel, seed):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    dur = float(np.interp(m, [40, 64, 88], [4.0, 3.2, 2.0]))
    n = ns(dur)
    t = T(n)
    T60 = float(np.interp(m, [40, 64, 88], [5.0, 3.2, 1.4]))
    p = float(np.interp(m, [40, 88], [0.62, 0.30]))
    exc = pluck_exc(f0, n, rng, 0.17, 1800 + 2500 * vel, shape=0.55)
    y = ks(f0, n, T60, p, exc) + 0.35 * ks(f0, n, T60 * 0.8, p + 0.05, exc, detune=0.9)
    y = y / (np.max(np.abs(y)) + 1e-9)
    body = modal_ir(0.25, [(98, 0.09, 1.2), (196, 0.05, 0.7), (225, 0.05, 0.6), (400, 0.03, 0.5),
                           (520, 0.025, 0.4), (660, 0.02, 0.3)], rng, n_random=30, flo=700, fhi=4500,
                    tau_lo=0.03, tau_hi=0.006, direct=0)
    y = 0.65 * y + 0.55 * signal.fftconvolve(y, body)[:n]
    y += 0.02 * vel * lp(noise(n, rng), 3000) * np.exp(-t / 0.005)
    y = lp(y, 9000, 1)
    ir = make_ir(0.9, 0.9, seed=13, hf_ratio=0.5)
    y = add_reverb(y, ir, 0.09)[:n, 0]
    y = calibrate(y, f0)
    y = fade(y, 0.0002, 0.4)
    return finish(y, trim_db=-70, keep_len=True, fout=0.0)


def r_harp(m, vel, seed):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    dur = float(np.interp(m, [24, 60, 103], [6.0, 4.5, 2.2]))
    n = ns(dur)
    t = T(n)
    T60 = float(np.interp(m, [24, 48, 72, 103], [11, 7, 4.0, 1.6]))
    p = float(np.interp(m, [24, 103], [0.45, 0.12]))
    exc = pluck_exc(f0, n, rng, 0.42, 1200 + 1500 * vel, shape=0.75)
    y = ks(f0, n, T60, p, exc) + 0.25 * ks(f0, n, T60 * 0.7, p, exc, detune=-0.7)
    y = y / (np.max(np.abs(y)) + 1e-9)
    body = modal_ir(0.3, [(130, 0.08, 0.6), (260, 0.06, 0.5)], rng, n_random=35, flo=150, fhi=3500,
                    tau_lo=0.06, tau_hi=0.008, direct=0)
    y = 0.75 * y + 0.4 * signal.fftconvolve(y, body)[:n]
    y = lp(y, 8000, 1)
    ir = make_ir(2.0, 2.0, seed=14, hf_ratio=0.45, predelay=0.02)
    y = add_reverb(y, ir, 0.16)[:n, 0]
    y = calibrate(y, f0)
    y = fade(y, 0.0002, 0.6)
    return finish(y, trim_db=-70, keep_len=True, fout=0.0)


def r_fbass(m, vel, seed):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    dur = float(np.interp(m, [28, 67], [3.6, 2.6]))
    n = ns(dur)
    t = T(n)
    T60 = float(np.interp(m, [28, 67], [7.0, 3.5]))
    exc = pluck_exc(f0, n, rng, 0.22, 900 + 900 * vel, shape=0.7)
    y = ks(f0, n, T60, 0.42, exc) + 0.2 * ks(f0, n, T60, 0.45, exc, detune=0.5)
    P = SR / f0
    k = max(1, int(round(0.24 * P)))
    y2 = y.copy()
    y2[k:] -= 0.55 * y[:-k]
    y = y2 / (np.max(np.abs(y2)) + 1e-9)
    y = np.tanh(1.4 * y) / math.tanh(1.4)
    y += 0.06 * lp(noise(n, rng), 600) * np.exp(-t / 0.008)
    y = lp(y, 4200, 2)
    y = hp(y, 28, 2)
    y = fade(y, 0.0002, 0.35)
    return finish(y, trim_db=-70, keep_len=True, fout=0.0)


# ---------------------------------------------------------------- mallets
def r_bar(m, vel, seed, kind):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    if kind == 'marimba':
        dur = float(np.interp(m, [45, 96], [2.6, 1.0]))
        tau1 = float(np.interp(m, [45, 70, 96], [1.3, 0.7, 0.28]))
        ratios = [1.0, 3.98, 9.85, 17.2]
        amps = [1.0, 0.22 + 0.2 * vel, 0.05 + 0.08 * vel, 0.02 * vel]
        taus = [tau1, tau1 * 0.22, tau1 * 0.08, tau1 * 0.04]
        tube = 0.35
        att = 0.0009
    else:
        dur = float(np.interp(m, [53, 89], [5.0, 3.0]))
        tau1 = float(np.interp(m, [53, 89], [2.2, 0.9]))
        ratios = [1.0, 4.0, 10.02, 13.6]
        amps = [1.0, 0.18 + 0.15 * vel, 0.06 + 0.1 * vel, 0.03 * vel]
        taus = [tau1, tau1 * 0.3, tau1 * 0.09, tau1 * 0.05]
        tube = 0.25
        att = 0.0006
    n = ns(dur)
    t = T(n)
    fr = [f0 * r for r in ratios]
    y = modes(n, fr, amps, [1 / tt for tt in taus])
    y += tube * (1 - np.exp(-t / 0.012)) * np.exp(-t / (tau1 * 1.25)) * np.sin(2 * np.pi * f0 * 1.0015 * t)
    y *= (1 - np.exp(-t / att))
    y /= np.max(np.abs(y)) + 1e-9
    if kind == 'marimba':
        click = bp(noise(n, rng), 1500, 5000) * np.exp(-t / 0.002)
        thud = lp(noise(n, rng), 500) * np.exp(-t / 0.006)
        y += (0.05 + 0.1 * vel) * click / (np.max(np.abs(click)) + 1e-9) + 0.04 * thud / (np.max(np.abs(thud)) + 1e-9)
    else:
        ting = bp(noise(n, rng), 3000, 9000) * np.exp(-t / 0.0015)
        y += (0.03 + 0.06 * vel) * ting / (np.max(np.abs(ting)) + 1e-9)
    ir = make_ir(1.3, 1.3, seed=15, hf_ratio=0.5)
    y = add_reverb(y, ir, 0.10)[:n]
    y = fade(y, 0.0001, 0.5)
    return finish(y, trim_db=-70, keep_len=True, fout=0.0)


# ---------------------------------------------------------------- looped ensembles
def ens_voice(n, Ns, u, base_cycles, rng, *, det_steps, vib_rate, vib_cents, drift_cents,
              vib_delay=0.35, am=0.0):
    """One polyBLEP saw voice, exactly periodic (period Ns) after the vibrato fade."""
    t = T(n)
    fv = (base_cycles + det_steps) * u
    vr = qrate(vib_rate, u)
    vf = np.clip((t - vib_delay) / 0.5, 0, 1)
    vf = vf * vf * (3 - 2 * vf)
    dev = fv * (2 ** (vib_cents / 1200) - 1)
    drift = pnoise(Ns, 0.1, 4.0, rng, n) * fv * (2 ** (drift_cents / 1200) - 1)
    finst = fv + dev * vf * np.sin(2 * np.pi * vr * t + rng.uniform(0, 6.28)) + drift
    ph = rng.uniform(0, 1) + np.cumsum(finst) / SR
    y = blep_saw_phase(ph, finst / SR)
    if am:
        y *= 1 + am * (0.6 * np.sin(2 * np.pi * vr * t + 1.0) * vf + 0.4 * pnoise(Ns, 0.2, 6, rng, n))
    return y


def centred_steps(f0, u, nv, sd_cents, rng):
    """Symmetric (zero-mean) ensemble detune in grid steps so the ensemble centres on f0."""
    half = np.abs(rng.normal(0, sd_cents, nv // 2))
    st = [int(round(f0 * (2 ** (c / 1200) - 1) / u)) for c in half]
    out = st + [-x for x in st] + ([0] if nv % 2 else [])
    rng.shuffle(out)
    return out


def attack_env(n, a, delay=0.0):
    t = T(n) - delay
    x = np.clip(t / a, 0, 1)
    return x * x * (3 - 2 * x)


def r_strings(m, seed):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    Ns, u, M = grid(f0, 3.0)
    Ls = ns(1.9)
    n = Ls + Ns + ns(0.4)
    out = np.zeros((n, 2))
    nv = 10
    stepsv = centred_steps(f0, u, nv, 5, rng)
    for v in range(nv):
        steps = stepsv[v]
        y = ens_voice(n, Ns, u, M, rng, det_steps=steps, vib_rate=rng.uniform(4.7, 6.0),
                      vib_cents=rng.uniform(6, 13), drift_cents=3.0, vib_delay=rng.uniform(0.15, 0.4), am=0.04)
        y *= attack_env(n, rng.uniform(0.12, 0.32), rng.uniform(0, 0.04)) * rng.uniform(0.7, 1.0)
        pan = (v / (nv - 1)) * 1.6 - 0.8 + rng.uniform(-0.1, 0.1)
        out[:, 0] += y * math.cos((pan + 1) * math.pi / 4)
        out[:, 1] += y * math.sin((pan + 1) * math.pi / 4)
    sc = float(np.interp(m, [28, 45, 60, 72], [0.42, 0.58, 0.85, 1.0]))
    for f, g, q in [(275, 6, 2.0), (460, 4, 2.5), (1050, 2.5, 2), (2600, 5, 1.4), (4400, 2, 2)]:
        out = peq(out, f * sc, g, q)
    out = peq(out, 1500 * sc, -3, 1.5)
    out = lp(out, float(np.interp(m, [28, 60, 96], [3500, 7000, 9000])), 2)
    out = hp(out, 35, 2)
    out /= np.max(np.abs(out[Ls:Ls + Ns])) + 1e-9
    bow = pnoise(Ns, 2000, 7000, rng, n)
    envb = attack_env(n, 0.2)
    for c in range(2):
        out[:, c] += 0.012 * np.roll(bow, c * 997) * envb
    ir = make_ir(2.0, 1.3, stereo=True, seed=21, hf_ratio=0.45, predelay=0.02)
    y = add_reverb(out, ir, 0.24, wet_hp=120)[:n]
    y, rho = loop_finish(y, Ls, Ls + Ns, xf=0.03, tail=0.4)
    return y, (Ls / SR, (Ls + Ns) / SR)


VOWELS = {
    'ah': [(730, 90, 1.0), (1150, 110, 0.55), (2600, 160, 0.3), (3300, 220, 0.18), (4000, 300, 0.08)],
    'oo': [(330, 70, 1.0), (800, 90, 0.35), (2300, 160, 0.08), (3200, 220, 0.05), (4000, 300, 0.03)],
}


def r_choir(m, seed, vowel):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    Ns, u, M = grid(f0, 3.0)
    Ls = ns(2.1)
    n = Ls + Ns + ns(0.4)
    nv = 8
    src = np.zeros((n, 2))
    stepsv = centred_steps(f0, u, nv, 4.5, rng)
    for v in range(nv):
        steps = stepsv[v]
        y = ens_voice(n, Ns, u, M, rng, det_steps=steps, vib_rate=rng.uniform(4.4, 5.6),
                      vib_cents=rng.uniform(8, 15), drift_cents=3.0, vib_delay=rng.uniform(0.2, 0.5), am=0.06)
        y = lp1(y, max(f0 * 1.5, 200))  # glottal tilt (-12 dB/oct overall)
        y *= attack_env(n, rng.uniform(0.25, 0.5), rng.uniform(0, 0.08)) * rng.uniform(0.7, 1.0)
        pan = (v / (nv - 1)) * 1.4 - 0.7
        src[:, 0] += y * math.cos((pan + 1) * math.pi / 4)
        src[:, 1] += y * math.sin((pan + 1) * math.pi / 4)
    src /= np.max(np.abs(src)) + 1e-9
    breath = np.stack([pnoise(Ns, 200, 9000, rng, n), pnoise(Ns, 200, 9000, rng, n)], 1) * attack_env(n, 0.3)[:, None]
    src = src + 0.06 * breath
    shift = float(np.interp(m, [48, 72, 84], [1.0, 1.12, 1.18]))
    out = np.zeros_like(src)
    for F, bw, g in VOWELS[vowel]:
        F2 = F * shift
        if F2 == VOWELS[vowel][0][0] * shift:
            F2 = max(F2, f0 * 1.02)  # F1 tracks a high fundamental (centred, no pitch bias)
        out += g * reson(src, F2, bw * shift)
    out = lp(hp(out, 80, 2), 9000, 2)
    out /= np.max(np.abs(out[Ls:Ls + Ns])) + 1e-9
    ir = make_ir(2.6, 1.6, stereo=True, seed=22, hf_ratio=0.45, predelay=0.025)
    y = add_reverb(out, ir, 0.32, wet_hp=150)[:n]
    y, rho = loop_finish(y, Ls, Ls + Ns, xf=0.03, tail=0.4)
    return y, (Ls / SR, (Ls + Ns) / SR)


def r_warmpad(m, seed):
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    Ns, u, M = grid(f0, 4.0, even=True)
    Ls = ns(2.2)
    n = Ls + Ns + ns(0.5)
    t = T(n)
    out = np.zeros((n, 2))
    spread = [-11, -6, -2.5, 2.5, 6, 11]
    # symmetric, all-distinct detune steps (two saws on one line would phase-cancel)
    pos = []
    for c in [2.5, 6, 11]:
        st = max(1, int(round(f0 * (2 ** (c / 1200) - 1) / u)))
        while pos and st <= pos[-1]:
            st += 1
        pos.append(st)
    stepsv = [-pos[2], -pos[1], -pos[0], pos[0], pos[1], pos[2]]
    for i, c in enumerate(spread):
        steps = stepsv[i]
        fv = (M + steps) * u
        y = saw(fv, n, rng.uniform(0, 1))
        pan = -0.7 + 1.4 * i / (len(spread) - 1)
        out[:, 0] += y * math.cos((pan + 1) * math.pi / 4)
        out[:, 1] += y * math.sin((pan + 1) * math.pi / 4)
    sub = np.sin(2 * np.pi * (M // 2) * u * t) * float(np.interp(m, [36, 54, 66], [0.22, 0.12, 0.0]))
    out += sub[:, None]
    fc = min(f0 * 3 + 700, 4200)
    out = lp(out, fc, 4)
    out = peq(out, 220, 2, 0.8)
    # periodic slow filter "breathing" via crossfade between bright/dark versions
    bright = lp(out, min(fc * 2.2, 9000), 2) - out
    lfo = 0.5 + 0.5 * np.sin(2 * np.pi * qrate(0.25, u) * t)
    out = out + 0.5 * bright * lfo[:, None]
    # stereo chorus with periodic LFO
    ch = np.zeros_like(out)
    rate = qrate(0.5, u)
    idx = np.arange(n)
    hi_ = hp(out, 250, 2)
    for c in range(2):
        d = (0.011 + 0.0025 * np.sin(2 * np.pi * rate * t + c * np.pi * 0.66)) * SR
        ch[:, c] = out[:, c] + 0.6 * np.interp(idx - d, idx, hi_[:, 1 - c])
    out = ch * attack_env(n, 0.6)[:, None]
    out /= np.max(np.abs(out[Ls:Ls + Ns])) + 1e-9
    ir = make_ir(2.8, 1.6, stereo=True, seed=23, hf_ratio=0.5, predelay=0.02)
    y = add_reverb(out, ir, 0.3, wet_hp=250)[:n]
    y, rho = loop_finish(y, Ls, Ls + Ns, xf=0.03, tail=0.5)
    return y, (Ls / SR, (Ls + Ns) / SR)


def r_sub(m, seed):
    f0 = mtof(m)
    Ns, u, M = grid(f0, 0.6)
    Ls = ns(0.35)
    n = Ls + Ns + ns(0.1)
    t = T(n)
    f = M * u
    ph = 2 * np.pi * f * t
    y = np.sin(ph) + 0.10 * np.sin(2 * ph) + 0.035 * np.sin(3 * ph)
    y += 0.5 * np.exp(-t / 0.05) * (0.3 * np.sin(2 * ph) + 0.15 * np.sin(3 * ph) + 0.08 * np.sin(4 * ph))
    y = np.tanh(1.3 * y) / math.tanh(1.3)
    y *= attack_env(n, 0.004)
    y, rho = loop_finish(y, Ls, Ls + Ns, xf=0.005, tail=0.08)
    return y, (Ls / SR, (Ls + Ns) / SR)


def r_texture(m, seed, kind):
    """Circularly-constructed evolving texture: exactly periodic over ~8 s."""
    rng = np.random.default_rng(seed)
    f0 = mtof(m)
    Ns, u, M = grid(f0, 8.0)
    t = T(Ns)
    P = np.zeros((Ns, 2))
    if kind == 'glass':
        parts = [(1, 1.0), (2, 0.5), (3, 0.25), (4, 0.3), (2.756, 0.35), (5.404, 0.22), (6, 0.12),
                 (8, 0.12), (8.933, 0.12), (12, 0.06), (13.34, 0.05), (16, 0.04)]
        for r, a in parts:
            for side in range(2):
                fq = round(r * f0 / u + rng.integers(-1, 2)) * u
                if fq > 15000:
                    continue
                lfo = (0.5 + 0.5 * np.sin(2 * np.pi * rng.integers(1, 4) * u * t + rng.uniform(0, 6.28))) ** 2
                P[:, side] += a * lfo * np.sin(2 * np.pi * fq * t + rng.uniform(0, 6.28))
        # sparkles: circular grains
        for _ in range(26):
            r = rng.choice([4, 6, 8, 10, 12, 16])
            fq = r * f0 * rng.choice([1.0, 1.0, 1.0012])
            if fq > 14000:
                fq /= 2
            L = ns(rng.uniform(0.3, 1.0))
            g = np.sin(2 * np.pi * fq * T(L)) * np.exp(-T(L) / (L / SR / 4)) * (1 - np.exp(-T(L) / 0.003))
            pos = rng.integers(0, Ns)
            idx = (pos + np.arange(L)) % Ns
            pan = rng.uniform(0, 1)
            P[idx, 0] += 0.12 * g * math.cos(pan * math.pi / 2)
            P[idx, 1] += 0.12 * g * math.sin(pan * math.pi / 2)
        P = lp(np.concatenate([P, P]), 11000, 2)[Ns:]
        rt, wet = 4.0, 0.45
    else:  # air: breathy noise through harmonic resonators, slowly sweeping
        base = np.stack([pnoise(Ns, 60, 14000, rng), pnoise(Ns, 60, 14000, rng)], 1)
        base2 = np.concatenate([base, base])
        acc = np.zeros_like(base2)
        for h in [1, 2, 3, 4, 5, 6, 8, 10, 12]:
            fq = h * f0
            if fq > 12000:
                break
            r = reson(base2, fq, max(0.8, fq * 0.0015))
            lfo = (0.5 + 0.5 * np.sin(2 * np.pi * rng.integers(1, 4) * u * np.arange(2 * Ns) / SR
                                      + rng.uniform(0, 6.28))) ** 1.5
            acc += r * lfo[:, None] / h ** 0.5
        acc = acc[Ns:]
        acc /= np.max(np.abs(acc)) + 1e-9
        hiss = lp(hp(base2, 3000, 2), 12000, 2)[Ns:]
        swell = 0.5 + 0.5 * np.sin(2 * np.pi * u * t)
        P = acc + 0.05 * hiss * swell[:, None] / (np.max(np.abs(hiss)) + 1e-9)
        rt, wet = 3.5, 0.4
    P /= np.max(np.abs(P)) + 1e-9
    ir = make_ir(rt, min(rt, 3.0), stereo=True, seed=24, hf_ratio=0.5, predelay=0.03)
    P = add_reverb(P, ir, wet, circular=True)
    P = hp1(np.concatenate([P, P]), 8.0)[Ns:]
    intro = ns(2.0)
    x = np.concatenate([P[Ns - intro:], P, P[:ns(1.0)]], 0)
    x[:intro] *= (attack_env(intro, intro / SR))[:, None]
    x = fade(x, 0, 0.9)
    x *= PEAK / (np.max(np.abs(x)) + 1e-12)
    return x, (intro / SR, (intro + Ns) / SR)


# ============================================================================= DRUMS
def _n(x):
    return x / (np.max(np.abs(x)) + 1e-12)


F808 = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]


def metal(n, freqs, rng):
    return sum(square(f, n, rng.uniform(0, 1)) for f in freqs) / len(freqs)


def cloud(n, rng, k, flo, fhi, tau_lo, tau_hi, tilt=0.3, build=0.0):
    t = T(n)
    out = np.zeros(n)
    fs = np.exp(rng.uniform(math.log(flo), math.log(fhi), k))
    for f in fs:
        fr = (math.log(f) - math.log(flo)) / (math.log(fhi) - math.log(flo))
        tau = tau_lo * (tau_hi / tau_lo) ** fr * rng.uniform(0.7, 1.3)
        L = min(n, ns(tau * 7))
        tt = t[:L]
        e = np.exp(-tt / tau)
        if build:
            e *= 1 - np.exp(-tt / (0.0005 + build * fr))
        out[:L] += rng.uniform(0.3, 1) * (flo / f) ** tilt * e * np.sin(2 * np.pi * f * tt + rng.uniform(0, 6.28))
    return out


def kick808(rng, tune=49, decay=0.5, n=1.6):
    n = ns(n)
    t = T(n)
    f = tune * (1 + 0.55 * np.exp(-t / 0.02))
    body = np.sin(sweep_phase(f)) * np.exp(-t / decay)
    click = np.sin(2 * np.pi * 1400 * t) * np.exp(-t / 0.0012)
    return np.tanh(1.4 * (body + 0.18 * click)) / math.tanh(1.4)


def kick909(rng):
    n = ns(0.9)
    t = T(n)
    f = 52 * (1 + 3.0 * np.exp(-t / 0.006) + 0.45 * np.exp(-t / 0.045))
    env = np.exp(-(t / 0.33) ** 1.4)
    body = np.tanh(2.0 * np.sin(sweep_phase(f)) * env) / math.tanh(2.0)
    click = hp(noise(n, rng), 1800) * np.exp(-t / 0.0025)
    imp = lp(np.r_[np.ones(20), np.zeros(n - 20)], 5000)
    return body + 0.22 * _n(click) + 0.35 * _n(imp)


def snare808(rng):
    n = ns(0.5)
    t = T(n)
    b = 0.75 * np.sin(2 * np.pi * 238 * t) * np.exp(-t / 0.07) + 0.4 * np.sin(2 * np.pi * 476 * t) * np.exp(-t / 0.04)
    nz = hp(lp(noise(n, rng), 9000), 1800) * np.exp(-t / 0.1)
    return b + 0.55 * _n(nz) * (1 - np.exp(-t / 0.001))


def snare909(rng):
    n = ns(0.55)
    t = T(n)
    f = 188 * (1 + 0.3 * np.exp(-t / 0.012))
    ph = sweep_phase(f)
    tone = (np.sin(ph) + 0.4 * np.sin(1.78 * ph)) * np.exp(-t / 0.075)
    nz = hp(lp(noise(n, rng), 8500), 550) * (0.7 * np.exp(-t / 0.16) + 0.3 * np.exp(-t / 0.05))
    return 0.6 * _n(tone) + 0.75 * _n(nz)


def clap(rng, f=1150, bursts=(0, 0.0105, 0.021, 0.032), tail=0.14, width=1.7, n=0.7):
    n = ns(n)
    t = T(n)
    nz = bp(noise(n, rng), f / width, f * width)
    e = np.zeros(n)
    for i, b in enumerate(bursts):
        tt = np.clip(t - b, 0, None)
        e += (t >= b) * np.exp(-tt / 0.0042) * (0.8 if i < len(bursts) - 1 else 1.0)
    lb = bursts[-1]
    e += (t >= lb) * 0.55 * np.exp(-np.clip(t - lb, 0, None) / tail)
    return nz * e


def rim808(rng):
    n = ns(0.12)
    t = T(n)
    x = (0.6 * np.sin(2 * np.pi * 455 * t) + np.sin(2 * np.pi * 1667 * t)) * np.exp(-t / 0.011)
    return np.tanh(3 * hp(x, 350)) * 1.0


def tom808(rng, f, decay):
    n = ns(decay * 6)
    t = T(n)
    fr = f * (1 + 0.25 * np.exp(-t / 0.03))
    x = np.sin(sweep_phase(fr)) * np.exp(-t / decay)
    x += 0.04 * lp(noise(n, rng), 3000) * np.exp(-t / 0.03)
    return x


def tom909(rng, f, decay):
    n = ns(decay * 6)
    t = T(n)
    fr = f * (1 + 0.55 * np.exp(-t / 0.05))
    ph = sweep_phase(fr)
    x = (np.sin(ph) + 0.25 * np.sin(2.02 * ph)) * np.exp(-t / decay)
    x += 0.15 * lp(noise(n, rng), 4000) * np.exp(-t / 0.05)
    return x


def hat808(rng, decay, n):
    n = ns(n)
    t = T(n)
    m = metal(n, F808, rng)
    x = hp(bp(m, 6500, 13000, 2), 7000, 2)
    return x * (1 - np.exp(-t / 0.0006)) * np.exp(-t / decay)


def cym808(rng, kind):
    n = ns(3.8 if kind == 'crash' else 4.0)
    t = T(n)
    m = metal(n, F808, rng)
    m2 = metal(n, [f * 1.4987 for f in F808], rng)
    if kind == 'crash':
        lo = bp(m, 2800, 5000) * np.exp(-t / 0.45)
        hi = hp(m * 0.6 + m2 * 0.4, 7000, 2) * np.exp(-t / 1.0)
        nz = hp(noise(n, rng), 6000) * np.exp(-t / 0.8)
        return 0.6 * _n(lo) + _n(hi) + 0.25 * _n(nz)
    bell = bp(m2, 2500, 4200) * np.exp(-t / 0.35)
    wash = hp(m, 6500, 2) * np.exp(-t / 1.3)
    return 0.6 * _n(bell) + _n(wash)


def cowbell808(rng):
    n = ns(0.6)
    t = T(n)
    m = square(540, n, 0.1) + square(800, n, 0.3)
    x = bp(m, 600, 3200, 2)
    return x * (0.65 * np.exp(-t / 0.012) + 0.35 * np.exp(-t / 0.13))


def maracas(rng, decay=0.028, fc=5500):
    n = ns(0.25)
    t = T(n)
    return hp(noise(n, rng), fc, 2) * (1 - np.exp(-t / 0.0025)) * np.exp(-t / decay)


def conga808(rng, f=370, decay=0.11):
    n = ns(0.6)
    t = T(n)
    fr = f * (1 + 0.12 * np.exp(-t / 0.008))
    return np.sin(sweep_phase(fr)) * np.exp(-t / decay) + 0.1 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.01)


def claves(rng, f=2500, decay=0.022):
    n = ns(0.2)
    t = T(n)
    return np.sin(2 * np.pi * f * t) * np.exp(-t / decay)


def zap(rng, f1=3000, f0=80, tau=0.025, decay=0.12, up=False):
    n = ns(0.5)
    t = T(n)
    if up:
        f = 150 + 3500 * (1 - np.exp(-t / 0.08))
    else:
        f = f0 + f1 * np.exp(-t / tau)
    ph = sweep_phase(f)
    return np.sin(ph + 0.8 * np.sin(0.5 * ph)) * np.exp(-t / decay)


def quant(x, bits):
    q = 2 ** (bits - 1)
    s = np.max(np.abs(x)) + 1e-12
    return np.round(x / s * q) / q * s


def hat909(rng, decay, n):
    n = ns(n)
    t = T(n)
    a = metal(n, [263, 400, 421, 474, 587, 845], rng)
    b = metal(n, [317, 538, 659, 711, 913, 1123], rng)
    x = hp(a * b * 2 + 0.25 * noise(n, rng) * 0.3, 7500, 2)
    src = x * np.exp(-t / (decay * 1.4))
    src = quant(src, 7)
    return src * (1 - np.exp(-t / 0.0005)) * np.exp(-t / decay)


def cym909(rng, kind):
    n = ns(4.0)
    t = T(n)
    if kind == 'crash':
        x = cloud(n, rng, 260, 500, 16000, 0.9, 1.3, tilt=0.15, build=0.01)
        x = hp(x, 1500) + 0.4 * _n(hp(noise(n, rng), 5000)) * np.exp(-t / 0.9) * np.max(np.abs(x))
        return quant(x, 7) * np.exp(-t / 1.4)
    x = cloud(n, rng, 200, 1500, 15000, 1.6, 1.8, tilt=0.2)
    bell = modes(n, [610, 1460, 2320, 3540], [0.5, 0.6, 0.4, 0.3], [4, 5, 7, 9])
    return quant(hp(x, 2500) + 0.5 * bell * np.max(np.abs(x)), 7)


def tamb(rng):
    n = ns(0.5)
    t = T(n)
    x = np.zeros(n)
    for _ in range(10):
        st = ns(rng.uniform(0, 0.02))
        L = n - st
        tt = T(L)
        j = cloud(L, rng, 6, 5000, 13000, 0.12, 0.08, tilt=0)
        x[st:] += j * rng.uniform(0.5, 1)
    skin = modes(n, [290, 470], [1, 0.5], [40, 60]) * 0.4
    return hp(x, 3500) + 0.3 * _n(skin) * np.max(np.abs(x))


def kick_ac(rng, f=56, n=0.9):
    n = ns(n)
    t = T(n)
    out = np.zeros(n)
    for r, a, tau in [(1, 1, 0.32), (1.5, 0.35, 0.11), (1.98, 0.2, 0.07), (2.44, 0.12, 0.05)]:
        fr = f * r * (1 + 0.09 * np.exp(-t / 0.035))
        out += a * np.sin(sweep_phase(fr)) * np.exp(-t / tau)
    beater = hp(noise(n, rng), 1800) * np.exp(-t / 0.0028)
    thump = lp(noise(n, rng), 250) * np.exp(-t / 0.022)
    x = out + 0.25 * _n(beater) + 0.35 * _n(thump)
    return np.tanh(1.2 * x)


MEMB = [1.0, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501]


def snare_ac(rng, f=190, wires=0.8, n=0.75):
    n = ns(n)
    t = T(n)
    fr = [f * r for r in MEMB]
    amps = [1, 0.65, 0.45, 0.35, 0.3, 0.22, 0.2, 0.15]
    taus = [0.16, 0.09, 0.075, 0.065, 0.055, 0.05, 0.045, 0.04]
    body = np.zeros(n)
    for fq, a, tau in zip(fr, amps, taus):
        ff = fq * (1 + 0.04 * np.exp(-t / 0.02))
        body += a * np.sin(sweep_phase(ff) + rng.uniform(0, 6)) * np.exp(-t / tau)
    body *= 1 - np.exp(-t / 0.0004)
    env_w = np.convolve(np.abs(body), np.ones(64) / 64, 'same')
    wn = bp(noise(n, rng), 1800, 9500) * (0.5 * env_w / (env_w.max() + 1e-9) + 0.5 * np.exp(-t / 0.13))
    wn *= np.clip(t / 0.002, 0, 1)
    stick = hp(noise(n, rng), 3000) * np.exp(-t / 0.0015)
    return 0.8 * _n(body) + wires * _n(wn) + 0.3 * _n(stick)


def clap_ac(rng):
    n = ns(0.6)
    out = np.zeros(n)
    for _ in range(4):
        off = rng.uniform(0, 0.018)
        c = clap(rng, f=rng.uniform(1000, 1700), bursts=(0, rng.uniform(0.006, 0.01)), tail=0.05, width=1.9, n=0.6)
        k = ns(off)
        out[k:] += c[:n - k] * rng.uniform(0.6, 1)
    return out


def rim_ac(rng):
    n = ns(0.25)
    x = modes(n, [480, 1750, 3150, 5200, 820], [0.6, 1, 0.6, 0.3, 0.4], [6.91 / .05, 6.91 / .035, 6.91 / .025, 6.91 / .015, 6.91 / .04])
    t = T(n)
    x += 0.4 * np.max(np.abs(x)) * _n(hp(noise(n, rng), 2500) * np.exp(-t / 0.002))
    x += 0.15 * np.max(np.abs(x)) * _n(snare_ac(rng, wires=0.3, n=0.25))
    return x


def hat_ac(rng, decay, n):
    n = ns(n)
    t = T(n)
    c = cloud(n, rng, 140, 3000, 17000, decay, decay * 0.8, tilt=0.1)
    nz = hp(noise(n, rng), 6000, 2) * np.exp(-t / (decay * 0.8))
    chick = bp(noise(n, rng), 2000, 6000) * np.exp(-t / 0.004)
    x = _n(c) + 0.5 * _n(nz) + 0.25 * _n(chick)
    return x * (1 - np.exp(-t / 0.0004))


def crash_ac(rng, n=4.5, dark=1.0):
    n = ns(n)
    t = T(n)
    c = cloud(n, rng, 320, 350 * dark, 16000 * dark, 1.3, 1.9, tilt=0.18, build=0.02)
    wash = hp(noise(n, rng), 3500 * dark, 2) * np.exp(-t / 1.5) * (1 - np.exp(-t / 0.02))
    stick = hp(noise(n, rng), 2000) * np.exp(-t / 0.003)
    return _n(c) + 0.3 * _n(wash) + 0.2 * _n(stick)


def ride_ac(rng):
    n = ns(3.6)
    t = T(n)
    bell = modes(n, [523, 1318, 2135, 3240, 4410, 5600], [0.7, 1.0, 0.7, 0.5, 0.35, 0.25],
                 [6.91 / 2.0, 6.91 / 1.6, 6.91 / 1.2, 6.91 / 0.9, 6.91 / 0.7, 6.91 / 0.5])
    c = cloud(n, rng, 260, 900, 15000, 2.2, 2.4, tilt=0.25)
    tick = bp(noise(n, rng), 3000, 9000) * np.exp(-t / 0.004)
    return 0.45 * _n(bell) + _n(c) + 0.35 * _n(tick)


def cowbell_ac(rng):
    n = ns(0.7)
    x = modes(n, [562, 845, 1330, 1690, 2600, 3420], [1, 0.8, 0.45, 0.35, 0.2, 0.1],
              [6.91 / .35, 6.91 / .25, 6.91 / .14, 6.91 / .12, 6.91 / .07, 6.91 / .05])
    t = T(n)
    x += 0.3 * np.max(np.abs(x)) * _n(hp(noise(n, rng), 2000) * np.exp(-t / 0.002))
    return x


def shaker_ac(rng):
    n = ns(0.3)
    t = T(n)
    x = np.zeros(n)
    times = np.clip(rng.normal(0.035, 0.018, 500), 0, 0.25)
    for tt in times:
        k = ns(tt)
        x[k] += rng.uniform(-1, 1)
    x = bp(x, 3000, 12000, 2)
    x = lp1(np.convolve(x, np.exp(-np.arange(40) / 8.0), 'full')[:n], 14000)
    return x * (1 - np.exp(-t / 0.004))


def woodblock(rng):
    n = ns(0.3)
    t = T(n)
    x = modes(n, [880, 2290, 3900], [1, 0.4, 0.15], [6.91 / 0.07, 6.91 / 0.035, 6.91 / 0.02])
    return x + 0.3 * np.max(np.abs(x)) * _n(hp(noise(n, rng), 3000) * np.exp(-t / 0.0015))


def bongo(rng, f=420):
    n = ns(0.5)
    t = T(n)
    out = np.zeros(n)
    for r, a, tau in [(1, 1, 0.12), (1.59, 0.4, 0.06), (2.14, 0.25, 0.04), (2.65, 0.15, 0.03)]:
        out += a * np.sin(sweep_phase(f * r * (1 + 0.05 * np.exp(-t / 0.02)))) * np.exp(-t / tau)
    return out + 0.25 * _n(hp(noise(n, rng), 2500) * np.exp(-t / 0.002))


def snap(rng):
    n = ns(0.3)
    t = T(n)
    x = bp(noise(n, rng), 1800, 4500) * np.exp(-t / 0.009)
    x += 0.5 * _n(modes(n, [1200, 2650], [1, 0.6], [140, 200]))
    return x


def reverse_crash(rng):
    c = tailfade(crash_ac(rng, n=2.0), 0.5)
    c = c[::-1].copy()
    n = len(c)
    c = c * np.linspace(0, 1, n) ** 1.5
    return c


def tailfade(x, frac=0.35):
    """Smoothly end a generated source so nothing is truncated mid-decay."""
    n = len(x)
    k = int(n * frac)
    x = np.array(x, float)
    x[n - k:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, k))
    return x


def room(x, rt=0.45, wet=0.18, seed=5, bright=1.0):
    x = tailfade(x)
    ir = make_ir(rt, rt * 1.1, seed=seed, hf_ratio=0.5, predelay=0.004, er=1.0, bright=bright)
    return add_reverb(x, ir, wet)[:, 0]


def lofi(x, rng, hold=2, bits=10, lpf=6500, drive=1.8, crackle=1.0):
    x = _n(tailfade(x))
    x = np.tanh(drive * x) / math.tanh(drive)
    n = len(x)
    if hold > 1:
        x = np.repeat(x[::hold], hold)[:n]
    q = 2 ** (bits - 1)
    x = np.round(x * q) / q
    x = lp(x, lpf, 2)
    x = hp(x, 35, 2)
    if crackle:
        follow = lp1(np.abs(x), 15)
        follow = follow / (follow.max() + 1e-9)
        cr = np.zeros(n)
        k = rng.integers(0, n, max(1, int(n / SR * 25)))
        cr[k] = rng.uniform(-1, 1, len(k)) * rng.uniform(0.2, 1, len(k)) ** 3
        cr = bp(cr, 800, 6000)
        hiss = lp(noise(n, rng), 5000) * 0.004
        x = x + crackle * (0.06 * _n(cr) + hiss) * np.clip(follow * 3, 0, 1)
    return x


PADS = ['kick', 'snare', 'clap', 'rim', 'hat-closed', 'hat-open', 'tom-low', 'tom-mid', 'tom-high',
        'crash', 'ride', 'cowbell', 'shaker', 'perc1', 'perc2', 'fx']

KIT_LABELS = {
    '808': ['Kick', 'Snare', 'Clap', 'Rim', 'CH', 'OH', 'Lo Tom', 'Mid Tom', 'Hi Tom', 'Cymbal', 'Ride',
            'Cowbell', 'Maracas', 'Conga', 'Claves', 'Zap'],
    '909': ['Kick', 'Snare', 'Clap', 'Rim', 'CH', 'OH', 'Lo Tom', 'Mid Tom', 'Hi Tom', 'Crash', 'Ride',
            'Cowbell', 'Shaker', 'Conga', 'Tamb', 'Laser'],
    'acoustic': ['Kick', 'Snare', 'Clap', 'X-Stick', 'CH', 'OH', 'Floor Tom', 'Rack Tom', 'Hi Tom', 'Crash',
                 'Ride', 'Cowbell', 'Shaker', 'Tamb', 'Woodblock', 'Rev Crash'],
    'lofi': ['Kick', 'Snare', 'Clap', 'Rim', 'CH', 'OH', 'Lo Tom', 'Mid Tom', 'Hi Tom', 'Crash', 'Ride',
             'Cowbell', 'Shaker', 'Snap', 'Bongo', 'Spin'],
}
KIT_NAMES = {'808': 'TR-808ish', '909': 'TR-909ish', 'acoustic': 'Studio Acoustic', 'lofi': 'Lo-Fi Dust'}
PAD_GAIN = {'kick': 1.0, 'snare': 0.85, 'clap': 0.8, 'rim': 0.6, 'hat-closed': 0.5, 'hat-open': 0.45,
            'tom-low': 0.8, 'tom-mid': 0.8, 'tom-high': 0.8, 'crash': 0.45, 'ride': 0.45, 'cowbell': 0.55,
            'shaker': 0.5, 'perc1': 0.7, 'perc2': 0.7, 'fx': 0.6}


def r_drum(kit, pad, seed):
    rng = np.random.default_rng(seed)
    lead = True
    if kit == '808':
        x = {
            'kick': lambda: kick808(rng),
            'snare': lambda: snare808(rng),
            'clap': lambda: clap(rng),
            'rim': lambda: rim808(rng),
            'hat-closed': lambda: hat808(rng, 0.035, 0.3),
            'hat-open': lambda: hat808(rng, 0.32, 1.4),
            'tom-low': lambda: tom808(rng, 92, 0.26),
            'tom-mid': lambda: tom808(rng, 138, 0.22),
            'tom-high': lambda: tom808(rng, 196, 0.19),
            'crash': lambda: cym808(rng, 'crash'),
            'ride': lambda: cym808(rng, 'ride'),
            'cowbell': lambda: cowbell808(rng),
            'shaker': lambda: maracas(rng),
            'perc1': lambda: conga808(rng),
            'perc2': lambda: claves(rng),
            'fx': lambda: zap(rng),
        }[pad]()
        x = room(x, 0.3, 0.04, seed=8)
    elif kit == '909':
        x = {
            'kick': lambda: kick909(rng),
            'snare': lambda: snare909(rng),
            'clap': lambda: clap(rng, f=1250, bursts=(0, 0.009, 0.019, 0.028), tail=0.2),
            'rim': lambda: np.tanh(2.5 * hp(modes(ns(0.1), [520, 1720, 2600], [0.5, 1, 0.3], [180, 260, 300]), 300)),
            'hat-closed': lambda: hat909(rng, 0.04, 0.35),
            'hat-open': lambda: hat909(rng, 0.38, 1.5),
            'tom-low': lambda: tom909(rng, 100, 0.3),
            'tom-mid': lambda: tom909(rng, 142, 0.26),
            'tom-high': lambda: tom909(rng, 190, 0.22),
            'crash': lambda: cym909(rng, 'crash'),
            'ride': lambda: cym909(rng, 'ride'),
            'cowbell': lambda: bp(square(587, ns(0.5), 0.2) + square(845, ns(0.5), 0.6), 650, 3500)
            * (0.6 * np.exp(-T(ns(0.5)) / 0.01) + 0.4 * np.exp(-T(ns(0.5)) / 0.11)),
            'shaker': lambda: maracas(rng, 0.045, 4500) * (1 - np.exp(-T(ns(0.25)) / 0.008)),
            'perc1': lambda: conga808(rng, 260, 0.14),
            'perc2': lambda: tamb(rng),
            'fx': lambda: zap(rng, up=True, decay=0.18),
        }[pad]()
        x = room(x, 0.4, 0.06, seed=9)
    elif kit == 'acoustic':
        x = {
            'kick': lambda: room(kick_ac(rng), 0.5, 0.10),
            'snare': lambda: room(snare_ac(rng), 0.7, 0.22),
            'clap': lambda: room(clap_ac(rng), 0.8, 0.35),
            'rim': lambda: room(rim_ac(rng), 0.6, 0.2),
            'hat-closed': lambda: room(hat_ac(rng, 0.045, 0.4), 0.5, 0.12),
            'hat-open': lambda: room(hat_ac(rng, 0.55, 2.2), 0.6, 0.12),
            'tom-low': lambda: room(_tom_ac(rng, 82, 0.55), 0.7, 0.2),
            'tom-mid': lambda: room(_tom_ac(rng, 112, 0.45), 0.7, 0.2),
            'tom-high': lambda: room(_tom_ac(rng, 150, 0.38), 0.7, 0.2),
            'crash': lambda: room(crash_ac(rng), 0.9, 0.12),
            'ride': lambda: room(ride_ac(rng), 0.9, 0.12),
            'cowbell': lambda: room(cowbell_ac(rng), 0.6, 0.15),
            'shaker': lambda: room(shaker_ac(rng), 0.5, 0.15),
            'perc1': lambda: room(tamb(rng), 0.6, 0.15),
            'perc2': lambda: room(woodblock(rng), 0.6, 0.18),
            'fx': lambda: reverse_crash(rng),
        }[pad]()
        if pad == 'fx':
            lead = False
            x = fade(x, 0, 0.004)[:, 0]
    else:  # lofi
        src = {
            'kick': lambda: kick808(rng, tune=54, decay=0.28, n=0.9) + 0.4 * _n(kick_ac(rng, 60, 0.9)),
            'snare': lambda: room(snare_ac(rng, 175, 1.0, 0.45), 0.5, 0.25, bright=0.6),
            'clap': lambda: room(clap_ac(rng), 0.5, 0.3, bright=0.6),
            'rim': lambda: rim_ac(rng),
            'hat-closed': lambda: hat_ac(rng, 0.035, 0.3),
            'hat-open': lambda: hat_ac(rng, 0.35, 1.2),
            'tom-low': lambda: tom808(rng, 85, 0.24),
            'tom-mid': lambda: tom808(rng, 120, 0.2),
            'tom-high': lambda: tom808(rng, 165, 0.17),
            'crash': lambda: crash_ac(rng, n=2.2, dark=0.7),
            'ride': lambda: ride_ac(rng)[:ns(2.5)],
            'cowbell': lambda: cowbell808(rng),
            'shaker': lambda: shaker_ac(rng),
            'perc1': lambda: room(snap(rng), 0.5, 0.25),
            'perc2': lambda: bongo(rng),
            'fx': lambda: _spin(rng),
        }[pad]()
        cfg = dict(hold=2, bits=10, lpf=6500, drive=1.8)
        if pad in ('hat-closed', 'hat-open', 'crash', 'ride', 'shaker'):
            cfg.update(lpf=8500, drive=1.3, bits=9)
        if pad in ('kick',):
            cfg.update(lpf=5000, drive=2.4, bits=12)
        if pad == 'snare':
            cfg.update(hold=3, bits=8, lpf=7000)
        x = lofi(src, rng, **cfg)
    return finish(x, lead_trim=lead, trim_db=-60, fout=0.015, fin=0.00015)


def _tom_ac(rng, f, decay):
    n = ns(decay * 5)
    t = T(n)
    out = np.zeros(n)
    for r, a, tau in [(1, 1, decay), (1.5, 0.35, decay * 0.35), (1.98, 0.2, decay * 0.2), (2.44, 0.12, decay * 0.12)]:
        out += a * np.sin(sweep_phase(f * r * (1 + 0.07 * np.exp(-t / 0.08)))) * np.exp(-t / tau)
    stick = hp(noise(n, rng), 2500) * np.exp(-t / 0.002)
    head = bp(noise(n, rng), 300, 2500) * np.exp(-t / 0.03)
    return _n(out) + 0.25 * _n(stick) + 0.12 * _n(head)


def _spin(rng):
    n = ns(0.9)
    t = T(n)
    f = 900 * np.exp(-t / 0.25) + 40
    ph = sweep_phase(f)
    x = (np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3 * ph)) * np.exp(-t / 0.35)
    x += 0.3 * bp(noise(n, rng), 300, 3000) * np.exp(-t / 0.3)
    return x


# ============================================================================= CATALOGUE
def roots(lo, hi, step):
    r = list(range(lo, hi + 1, step))
    if r[-1] != hi and hi - r[-1] >= step // 2:
        r.append(hi)
    return r


INSTRUMENTS = {
    # id: (name, category, folder, range(lo,hi), roots, vel layers, release, looped, kbps, stereo)
    'grand': ('Concert Grand', 'keys', 'keys/grand', (21, 108), roots(21, 108, 3), [0.38, 0.9], 0.45, False, 96, False),
    'epiano': ('Tine E-Piano', 'keys', 'keys/epiano', (28, 103), roots(28, 100, 3), [0.4, 0.95], 0.3, False, 96, False),
    'strings': ('Ensemble Strings', 'pads', 'pads/strings', (28, 100), roots(30, 94, 4), [1.0], 0.5, True, 128, True),
    'choir': ('Choir Aah', 'pads', 'pads/choir-aah', (40, 91), roots(48, 84, 4), [1.0], 0.7, True, 128, True),
    'choir-ooh': ('Choir Ooh', 'pads', 'pads/choir-ooh', (40, 91), roots(48, 84, 4), [1.0], 0.7, True, 128, True),
    'pluck-guitar': ('Nylon Guitar', 'plucks', 'plucks/guitar', (40, 88), roots(40, 88, 3), [0.75], 0.25, False, 96, False),
    'harp': ('Concert Harp', 'plucks', 'plucks/harp', (24, 103), roots(24, 103, 4), [0.75], 0.9, False, 96, False),
    'marimba': ('Marimba', 'keys', 'keys/marimba', (45, 96), roots(45, 96, 4), [0.75], 0.35, False, 96, False),
    'vibes': ('Vibraphone', 'keys', 'keys/vibes', (53, 89), roots(53, 89, 4), [0.7], 1.0, False, 96, False),
    'sub-bass': ('Sub Bass', 'bass', 'bass/sub', (24, 64), roots(24, 60, 6), [1.0], 0.08, True, 96, False),
    'finger-bass': ('Finger Bass', 'bass', 'bass/finger', (28, 67), roots(28, 67, 3), [0.75], 0.12, False, 96, False),
    'warm-pad': ('Warm Pad', 'pads', 'pads/warm', (36, 96), roots(36, 84, 6), [1.0], 1.2, True, 128, True),
    'glass-texture': ('Glass Texture', 'textures', 'textures/glass', (36, 96), [48, 60, 72], [1.0], 2.5, True, 128, True),
    'air-texture': ('Air Texture', 'textures', 'textures/air', (36, 96), [48, 60, 72], [1.0], 2.5, True, 128, True),
}


def render_inst(inst, m, vel):
    s = seed_of(inst, m, vel)
    if inst == 'grand':
        return r_grand(m, vel, s), None
    if inst == 'epiano':
        return r_epiano(m, vel, s), None
    if inst == 'pluck-guitar':
        return r_guitar(m, vel, s), None
    if inst == 'harp':
        return r_harp(m, vel, s), None
    if inst == 'finger-bass':
        return r_fbass(m, vel, s), None
    if inst in ('marimba', 'vibes'):
        return r_bar(m, vel, s, inst), None
    if inst == 'strings':
        return r_strings(m, s)
    if inst == 'choir':
        return r_choir(m, s, 'ah')
    if inst == 'choir-ooh':
        return r_choir(m, s, 'oo')
    if inst == 'warm-pad':
        return r_warmpad(m, s)
    if inst == 'sub-bass':
        return r_sub(m, s)
    if inst == 'glass-texture':
        return r_texture(m, s, 'glass')
    if inst == 'air-texture':
        return r_texture(m, s, 'air')
    raise KeyError(inst)


# ============================================================================= ENCODE
def encode(x, path, kbps, cutoff=None):
    x = as2d(x)
    ch = x.shape[1]
    # ffmpeg's native AAC encoder mangles a loud first frame (measured up to +5 dB overshoot),
    # so 1024 samples of silence are prepended and hidden again by shifting timestamps:
    # the MP4 edit list then skips priming + pad (Chrome decodeAudioData is sample-exact).
    # Silence is appended too, so end-of-stream rounding only ever trims silence.
    x = np.concatenate([np.zeros((PAD, ch)), x, np.zeros((PAD, ch))]).astype('<f4')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = [FFMPEG, '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', str(ch), '-i', '-',
           '-c:a', 'aac', '-b:a', f'{kbps}k']
    if cutoff:
        cmd += ['-cutoff', str(cutoff)]
    cmd += ['-output_ts_offset', '-%.6f' % (PAD / SR), '-movflags', '+faststart', path]
    subprocess.run(cmd, input=x.tobytes(), check=True)


def decode(path, ch):
    r = subprocess.run([FFMPEG, '-v', 'error', '-i', path, '-f', 'f32le', '-ac', str(ch), '-ar', str(SR), '-'],
                       capture_output=True, check=True)
    return np.frombuffer(r.stdout, '<f4').reshape(-1, ch)


def job(spec):
    t0 = time.time()
    kind = spec['kind']
    if kind == 'drum':
        x = r_drum(spec['kit'], spec['pad'], seed_of(spec['kit'], spec['pad']))
        loop = None
    else:
        x, loop = render_inst(spec['inst'], spec['root'], spec['vel'])
    x = as2d(x)
    if not spec['stereo'] and x.shape[1] > 1:
        x = x.mean(1, keepdims=True)
        x *= PEAK / (np.max(np.abs(x)) + 1e-12)
    path = os.path.join(OUT, spec['file'])
    encode(x, path, spec['kbps'], spec.get('cutoff'))
    raw = os.path.join(RAWDIR, spec['file'].replace('/', '__') + '.npy')
    os.makedirs(os.path.dirname(raw), exist_ok=True)
    np.save(raw, x.astype(np.float32))
    return dict(id=spec['id'], frames=x.shape[0], ch=x.shape[1], loop=loop, secs=time.time() - t0,
                bytes=os.path.getsize(path))


def build_specs(only=None):
    specs = []
    for kit in ['808', '909', 'acoustic', 'lofi']:
        if only and kit not in only:
            continue
        for i, pad in enumerate(PADS):
            specs.append(dict(kind='drum', kit=kit, pad=pad, id=f'kit-{kit}-{pad}', file=f'kit-{kit}/{pad}.m4a',
                              root=36 + i, kbps=128, cutoff=20000, stereo=False))
    for inst, (name, cat, folder, rng_, rts, vels, rel, looped, kbps, stereo) in INSTRUMENTS.items():
        if only and inst not in only:
            continue
        for m in rts:
            for li, v in enumerate(vels):
                suf = f'-v{li + 1}' if len(vels) > 1 else ''
                specs.append(dict(kind='inst', inst=inst, root=m, vel=v, layer=li + 1,
                                  id=f'{cat}-{inst}-{note_name(m)}{suf}', file=f'{folder}/{note_name(m)}{suf}.m4a',
                                  kbps=kbps, cutoff=17000 if not stereo else 16000, stereo=stereo))
    return specs


def build_manifest(specs, results):
    res = {r['id']: r for r in results}
    samples = []
    kits = {}
    instruments = {}
    for s in specs:
        r = res[s['id']]
        if s['kind'] == 'drum':
            samples.append(dict(id=s['id'], file=s['file'], category='drums', kit=s['kit'], pad=s['pad'],
                                root=s['root'], gain=PAD_GAIN[s['pad']],
                                duration=round(r['frames'] / SR, 4)))
            k = kits.setdefault(s['kit'], dict(name=KIT_NAMES[s['kit']], pads=list(PADS),
                                               labels=KIT_LABELS[s['kit']],
                                               ids=[f"kit-{s['kit']}-{p}" for p in PADS]))
        else:
            name, cat, folder, rng_, rts, vels, rel, looped, kbps, stereo = INSTRUMENTS[s['inst']]
            loop = None
            if r['loop']:
                loop = {'start': round(r['loop'][0], 6), 'end': round(r['loop'][1], 6)}
            samples.append(dict(id=s['id'], file=s['file'], category=cat, instrument=s['inst'], root=s['root'],
                                velLayer=s['layer'], loop=loop, channels=r['ch'],
                                duration=round(r['frames'] / SR, 4)))
    for inst, (name, cat, folder, rng_, rts, vels, rel, looped, kbps, stereo) in INSTRUMENTS.items():
        if not any(s.get('inst') == inst for s in specs):
            continue
        zones = []
        nv = len(vels)
        bounds = [0.0, 1.0] if nv == 1 else [0.0, 0.6, 1.0]
        for li in range(nv):
            for i, m in enumerate(rts):
                lo = 0 if i == 0 else (rts[i - 1] + m) // 2 + 1
                hi = 127 if i == len(rts) - 1 else (m + rts[i + 1]) // 2
                suf = f'-v{li + 1}' if nv > 1 else ''
                zones.append(dict(id=f'{cat}-{inst}-{note_name(m)}{suf}', root=m, lo=lo, hi=hi,
                                  velLo=bounds[li], velHi=bounds[li + 1]))
        instruments[inst] = dict(name=name, category=cat, range=list(rng_), zones=zones, release=rel, loop=looped)
    return {'version': 1, 'samples': samples, 'kits': kits, 'instruments': instruments}


# ============================================================================= VERIFY
def verify(manifest):
    problems = []
    ids = {s['id']: s for s in manifest['samples']}
    total = 0
    for s in manifest['samples']:
        p = os.path.join(OUT, s['file'])
        if not os.path.exists(p):
            problems.append(f"missing file {s['file']}")
            continue
        total += os.path.getsize(p)
        ch = s.get('channels', 1)
        y = decode(p, ch)
        raw = np.load(os.path.join(RAWDIR, s['file'].replace('/', '__') + '.npy'))
        if not np.all(np.isfinite(y)):
            problems.append(f"{s['id']}: NaN")
        pk = float(np.max(np.abs(y)))
        if pk >= 0.999 or pk < 0.5:
            problems.append(f"{s['id']}: peak {pk:.3f}")
        if y.shape[0] < raw.shape[0] or y.shape[0] > raw.shape[0] + 4096:
            problems.append(f"{s['id']}: decoded len {y.shape[0]} vs {raw.shape[0]}")
        m = np.max(np.abs(y), 1)
        on = int(np.argmax(m > 0.05 * pk))
        if s['category'] == 'drums' and s['pad'] not in ('fx', 'shaker') and on > 40:
            problems.append(f"{s['id']}: onset at {on}")
        dc = float(np.abs(y.mean(0)).max())
        if dc > 0.01:
            problems.append(f"{s['id']}: DC {dc:.4f}")
        # click check at end: last 64 samples should be ~silent
        if np.max(np.abs(y[raw.shape[0] - 64:raw.shape[0]])) > 0.02:
            problems.append(f"{s['id']}: tail not faded")
        # alignment against raw render
        k = min(8192, raw.shape[0])
        ey, er = lp1(np.abs(y[:k, 0]), 150), lp1(np.abs(raw[:k, 0]), 150)
        aerr = np.sqrt(np.mean((ey - er) ** 2)) / (np.sqrt(np.mean(er ** 2)) + 1e-9)
        if aerr > 0.15:
            problems.append(f"{s['id']}: decoded start misaligned/garbled (rel err {aerr:.3f})")
        if s.get('loop'):
            ls = int(round(s['loop']['start'] * SR))
            le = int(round(s['loop']['end'] * SR))
            if not (0 < ls < le <= y.shape[0]):
                problems.append(f"{s['id']}: bad loop {ls}-{le}")
                continue
            # seam: what plays after le-1 is ls. Compare the 256 samples either side.
            # true periodicity test (before the safety crossfade region)
            a0, a1 = le - 4500, le - 1500
            ref = raw[a0:a1]
            seg = raw[a0 - (le - ls):a1 - (le - ls)]
            err = np.sqrt(np.mean((seg - ref) ** 2)) / (np.sqrt(np.mean(ref ** 2)) + 1e-9)
            jump = np.max(np.abs(raw[ls] - raw[le - 1]))
            step = np.percentile(np.abs(np.diff(raw[ls:le], axis=0)), 99.9)
            s['_seam'] = (round(float(err), 4), round(float(jump), 4), round(float(step), 4))
            if err > 0.12 or jump > 2.5 * step:
                problems.append(f"{s['id']}: loop seam err {err:.3f} jump {jump:.3f} step {step:.3f}")
    for k, kit in manifest['kits'].items():
        if len(kit['pads']) != 16:
            problems.append(f"kit {k}: {len(kit['pads'])} pads")
        for i in kit['ids']:
            if i not in ids:
                problems.append(f"kit {k}: unresolved {i}")
    for name, inst in manifest['instruments'].items():
        bands = sorted({(z['velLo'], z['velHi']) for z in inst['zones']})
        for b in bands:
            zs = sorted([z for z in inst['zones'] if (z['velLo'], z['velHi']) == b], key=lambda z: z['lo'])
            exp = 0
            for z in zs:
                if z['id'] not in ids:
                    problems.append(f"{name}: unresolved {z['id']}")
                if z['lo'] != exp or not (z['lo'] <= z['root'] <= z['hi']):
                    problems.append(f"{name}: zone gap/overlap at {z}")
                exp = z['hi'] + 1
            if exp != 128:
                problems.append(f"{name}: zones end at {exp - 1}")
    return problems, total


def pngs(manifest, ids, outdir):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    os.makedirs(outdir, exist_ok=True)
    byid = {s['id']: s for s in manifest['samples']}
    for i in ids:
        s = byid[i]
        y = decode(os.path.join(OUT, s['file']), s.get('channels', 1))[:, 0]
        fig, ax = plt.subplots(2, 1, figsize=(10, 5.5))
        tt = np.arange(len(y)) / SR
        ax[0].plot(tt, y, lw=0.4)
        ax[0].set_title(i)
        if s.get('loop'):
            for v in s['loop'].values():
                ax[0].axvline(v, color='r')
        ax[1].specgram(y, NFFT=2048, Fs=SR, noverlap=1536, cmap='magma', vmin=-130)
        ax[1].set_ylim(0, 12000 if s['category'] != 'drums' else 20000)
        fig.tight_layout()
        fig.savefig(os.path.join(outdir, i + '.png'), dpi=70)
        plt.close(fig)


def yin_pitch(x, fmin=25, fmax=2500, thr=0.12):
    W = len(x) // 2
    tmax = min(int(SR / fmin), W - 2)
    tmin = int(SR / fmax)
    xf = np.fft.rfft(x, 2 * len(x))
    ac = np.fft.irfft(xf * np.conj(xf))[:tmax + 2]
    cs = np.concatenate([[0], np.cumsum(x ** 2)])
    taus = np.arange(tmax + 2)
    # d(tau) over window [0,W): sum (x[j]-x[j+tau])^2 approximated with full-overlap energies
    e0 = cs[W]
    e1 = cs[taus + W] - cs[taus]
    acw = np.array([np.dot(x[:W], x[t:t + W]) for t in taus])
    d = e0 + e1 - 2 * acw
    cm = np.ones_like(d)
    cm[1:] = d[1:] * np.arange(1, len(d)) / (np.cumsum(d[1:]) + 1e-12)
    cand = np.nonzero(cm[tmin:tmax] < thr)[0]
    if len(cand):
        t0 = cand[0] + tmin
        t = t0
        while t + 1 < tmax and cm[t + 1] < cm[t]:
            t += 1
        w = max(3, int(t0 * 0.15))  # skip ripple dips: deepest point just past the crossing
        t2 = t0 + int(np.argmin(cm[t0:min(tmax, t0 + w)]))
        if cm[t2] < cm[t]:
            t = t2
    else:
        t = int(np.argmin(cm[tmin:tmax])) + tmin
    a, b_, c = cm[t - 1], cm[t], cm[t + 1]
    den = a - 2 * b_ + c
    tt = t + (0.5 * (a - c) / den if den else 0)
    return SR / tt, float(cm[t])


def fund_peak(x, f0):
    n = 1 << 16
    seg = x[:n] if len(x) >= n else np.pad(x, (0, n - len(x)))
    sp = np.abs(np.fft.rfft(seg * np.hanning(n)))
    fr = np.arange(len(sp)) * SR / n
    lo, hi = np.searchsorted(fr, f0 * 2 ** (-0.6)), np.searchsorted(fr, f0 * 2 ** 0.6)
    k = lo + int(np.argmax(sp[lo:hi]))
    # power-weighted centroid of the fundamental region (+-50 cents): for detuned ensembles
    # this is the ensemble centre rather than whichever single voice is loudest
    a0, a1 = np.searchsorted(fr, f0 * 2 ** (-50 / 1200)), np.searchsorted(fr, f0 * 2 ** (50 / 1200)) + 1
    pw = sp[a0:a1] ** 2
    cen = float(np.sum(pw * fr[a0:a1]) / (np.sum(pw) + 1e-20))
    # how dominant is the octave below?
    sub = np.max(sp[np.searchsorted(fr, f0 / 2 * 0.97):np.searchsorted(fr, f0 / 2 * 1.03) + 1])
    return cen, float(sub / (sp[k] + 1e-12))


def harm_centroid(sp, fr, f0, H=4):
    """Pitch estimate: power-weighted centroid of harmonics 1..H (each +-40 cents, divided by
    its harmonic number) - averages out reverb colouration of individual ensemble lines."""
    num = den = 0.0
    for h in range(1, H + 1):
        fh = f0 * h
        if fh > SR * 0.4:
            break
        a0 = np.searchsorted(fr, fh * 2 ** (-40 / 1200))
        a1 = np.searchsorted(fr, fh * 2 ** (40 / 1200)) + 1
        pw = sp[a0:a1].astype(float) ** 2
        if pw.sum() <= 0:
            continue
        c = float(np.sum(pw * fr[a0:a1]) / pw.sum()) / h
        w = pw.sum() / h ** 2
        num += w * c
        den += w
    return num / den


def pitch_report(man, only=None, tol=5.0):
    """Pitch of every pitched sample vs its manifest root (raw float renders).
    yin  = periodicity ("perceived") pitch, median over many windows of the sustain;
    fund = power-weighted centroid of the fundamental region (+-50 cents). For loops this is
           computed on exactly one loop period, whose FFT bins are exact harmonics.
    sub  = level of the octave-below region relative to the fundamental (octave-error guard)."""
    bad = []
    rows = []
    for s in man['samples']:
        if s['category'] == 'drums' or (only and s['instrument'] not in only):
            continue
        raw = np.load(os.path.join(RAWDIR, s['file'].replace('/', '__') + '.npy')).mean(1)
        f0 = mtof(s['root'])
        if s.get('loop'):
            ls, le = int(round(s['loop']['start'] * SR)), int(round(s['loop']['end'] * SR))
            per = raw[ls:le]
            sp = np.abs(np.fft.rfft(per))
            fr = np.arange(len(sp)) * SR / len(per)
            st = ls
        else:
            seg = raw[ns(0.05):]
            nfft = 1 << 18
            seg = seg[:nfft]
            sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), nfft))
            fr = np.arange(len(sp)) * SR / nfft
            st = ns(0.25)
        fp = harm_centroid(sp, fr, f0)
        a0 = np.searchsorted(fr, f0 * 2 ** (-50 / 1200))
        a1 = np.searchsorted(fr, f0 * 2 ** (50 / 1200)) + 1
        s0 = np.searchsorted(fr, f0 / 2 * 0.97)
        s1 = np.searchsorted(fr, f0 / 2 * 1.03) + 1
        subr = float(sp[s0:s1].max() / (sp[a0:a1].max() + 1e-12))
        W = 16384
        fys = [yin_pitch(raw[w0:w0 + W], fmin=f0 / 2.2, fmax=min(f0 * 1.6, SR / 4))[0]
               for w0 in range(st, (le - W) if s.get('loop') else min(len(raw) - W, st + 9 * 2048), 2048)]
        fy = float(np.median(fys))  # loops: median over the whole loop (vibrato averages out)
        cy = 1200 * math.log2(fy / f0)
        cp = 1200 * math.log2(fp / f0)
        inharm = s['instrument'] in ('glass-texture', 'air-texture')
        ytol = tol if f0 < 1000 else 12  # YIN lag resolution is coarse for very short periods
        ok = abs(cp) <= tol and (abs(cy) <= ytol or inharm) and subr < 0.5
        rows.append((s['id'], round(cy, 1), round(cp, 1), round(subr, 2)))
        if not ok:
            bad.append(rows[-1])
    return rows, bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--png', default='')
    ap.add_argument('--pitch', action='store_true')
    ap.add_argument('--jobs', type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    mpath = os.path.join(OUT, 'manifest.json')
    if a.pitch:
        man = json.load(open(mpath))
        rows, bad = pitch_report(man, set(a.only.split(',')) if a.only else None)
        worst = sorted(rows, key=lambda r: -max(abs(r[1]), abs(r[2])))[:8]
        print(f'pitch-checked {len(rows)} samples (yin cents, fundamental-peak cents, sub-octave ratio)')
        print('worst:', worst)
        print('out of tolerance:', len(bad))
        for b in bad:
            print('  ', b)
        return
    if a.png:
        man = json.load(open(mpath))
        pngs(man, a.png.split(','), os.path.join(ROOT, 'tests', 'sample-previews'))
        return
    if not a.verify:
        only = set(a.only.split(',')) if a.only else None
        specs = build_specs(only)
        t0 = time.time()
        specs_sorted = sorted(specs, key=lambda s: -({'grand': 6, 'strings': 4, 'choir': 4, 'choir-ooh': 4,
                                                       'warm-pad': 3, 'harp': 3}.get(s.get('inst'), 1)))
        with Pool(a.jobs) as pool:
            results = []
            for i, r in enumerate(pool.imap_unordered(job, specs_sorted)):
                results.append(r)
                if i % 20 == 0:
                    print(f'  {i + 1}/{len(specs)}  {r["id"]}  {r["secs"]:.1f}s', flush=True)
        print(f'rendered {len(results)} in {time.time() - t0:.0f}s')
        if only:
            # merge into existing manifest
            old = json.load(open(mpath)) if os.path.exists(mpath) else None
            full = build_specs(None)
            prev = {}
            if old:
                for s in old['samples']:
                    lp_ = s.get('loop')
                    prev[s['id']] = dict(id=s['id'], frames=int(round(s['duration'] * SR)),
                                         ch=s.get('channels', 1),
                                         loop=(lp_['start'], lp_['end']) if lp_ else None)
            for r in results:
                prev[r['id']] = r
            specs = [s for s in full if s['id'] in prev]
            results = list(prev.values())
        man = build_manifest(specs, results)
        with open(mpath, 'w') as f:
            json.dump(man, f, separators=(',', ':'))
    man = json.load(open(mpath))
    problems, total = verify(man)
    seams = [(s['id'], s['_seam']) for s in man['samples'] if '_seam' in s]
    print(f"samples {len(man['samples'])}  kits {len(man['kits'])}  instruments {len(man['instruments'])}  "
          f"total {total / 1e6:.2f} MB")
    for sid, sm in seams[:400]:
        pass
    worst = sorted(seams, key=lambda x: -x[1][0])[:5]
    print('worst loop seams (relErr, jump, p99.9 step):', worst)
    print('problems:', len(problems))
    for p in problems[:60]:
        print('  ', p)


if __name__ == '__main__':
    main()
