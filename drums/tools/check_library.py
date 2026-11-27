#!/usr/bin/env python3
"""Quality-check library.zip and verify kits.json.

Per file: format (44.1 kHz / 16-bit), peak ~ -1 dBFS, no clipping, no DC, leading silence trimmed,
tail ends at zero, duration < 3 s, spectral centroid in a sensible range for its category.
kits.json: SPEC format, 8 tracks per kit, every builtin: reference present in the zip.
"""
import cmath
import io
import json
import math
import struct
import sys
import wave
import zipfile

CATEGORIES = ["Kicks", "Snares", "Claps", "Hats", "Cymbals", "Toms", "Percussion", "FX"]
# loose sanity ranges for spectral centroid (Hz)
CENTROID = {"Kicks": (40, 1500), "Snares": (300, 8000), "Claps": (500, 6000), "Hats": (4000, 16000),
            "Cymbals": (2500, 14000), "Toms": (60, 2000), "Percussion": (100, 12000), "FX": (40, 12000)}


def read_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        fmt = (w.getframerate(), w.getsampwidth(), w.getnchannels())
        raw = w.readframes(w.getnframes())
    n = len(raw) // 2
    s = struct.unpack("<%dh" % n, raw)
    ch = fmt[2]
    mono = [sum(s[i:i + ch]) / ch / 32768.0 for i in range(0, n, ch)]
    return fmt, mono


def fft(x):
    n = len(x)
    if n <= 1:
        return x
    even, odd = fft(x[0::2]), fft(x[1::2])
    t = [cmath.exp(-2j * math.pi * k / n) * odd[k] for k in range(n // 2)]
    return [even[k] + t[k] for k in range(n // 2)] + [even[k] - t[k] for k in range(n // 2)]


def centroid(x, sr):
    N = 4096
    seg = x[:N] + [0.0] * max(0, N - len(x))
    win = [seg[i] * (0.5 - 0.5 * math.cos(2 * math.pi * i / (N - 1))) for i in range(N)]
    mag = [abs(c) for c in fft(win)[:N // 2]]
    tot = sum(mag)
    return sum(m * i * sr / N for i, m in enumerate(mag)) / tot if tot else 0.0


def main(zpath, kpath, verbose=True):
    errors, warns = [], []
    names = set()
    per_cat = {c: 0 for c in CATEGORIES}
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            nm = info.filename
            names.add(nm)
            parts = nm.split("/")
            if len(parts) != 2 or parts[0] not in CATEGORIES or not parts[1].endswith(".wav"):
                errors.append("bad entry name: " + nm)
                continue
            per_cat[parts[0]] += 1
            (sr, sw, ch), x = read_wav(z.read(nm))
            if sr != 44100 or sw != 2:
                errors.append("%s: format %d Hz %d-bit" % (nm, sr, sw * 8))
            dur = len(x) / sr
            peak = max(abs(v) for v in x)
            rms = math.sqrt(sum(v * v for v in x) / len(x))
            dc = sum(x) / len(x)
            clipped = sum(1 for v in x if abs(v) >= 0.9999)
            pk_db = 20 * math.log10(peak) if peak > 0 else -999
            rms_db = 20 * math.log10(rms) if rms > 0 else -999
            first = next((i for i, v in enumerate(x) if abs(v) > peak * 0.001), 0)
            c = centroid(x, sr)
            lo, hi = CENTROID[parts[0]]
            if any(v != v for v in x): errors.append(nm + ": NaN")
            if not (-1.6 < pk_db < -0.5): errors.append("%s: peak %.2f dBFS" % (nm, pk_db))
            if clipped: errors.append("%s: %d clipped samples" % (nm, clipped))
            if abs(dc) > 0.01: warns.append("%s: DC offset %.4f" % (nm, dc))
            if dur >= 3.0 or dur < 0.03: errors.append("%s: duration %.2fs" % (nm, dur))
            if first > 20: errors.append("%s: %d samples of leading silence" % (nm, first))
            if abs(x[-1]) > 0.001: errors.append("%s: tail does not end at zero" % nm)
            if not (lo <= c <= hi): warns.append("%s: centroid %.0f Hz outside %d..%d" % (nm, c, lo, hi))
            if verbose:
                print("%-40s %5.2fs  peak %6.2f dB  rms %6.1f dB  centroid %6.0f Hz" % (nm, dur, pk_db, rms_db, c))

    with open(kpath) as f:
        kits = json.load(f)["kits"]
    keys = {"sound", "level", "tune", "decay", "tone", "pan"}
    for kit in kits:
        tr = kit["tracks"]
        if len(tr) != 8:
            errors.append("kit %s: %d tracks" % (kit["name"], len(tr)))
        for t in tr:
            if set(t.keys()) != keys:
                errors.append("kit %s: bad keys %s" % (kit["name"], sorted(t.keys())))
            s = t["sound"]
            if s.startswith("builtin:"):
                if s[len("builtin:"):] not in names:
                    errors.append("kit %s: missing %s" % (kit["name"], s))
            elif s != "synth":
                errors.append("kit %s: bad sound id %s" % (kit["name"], s))
            if not (-24 <= t["tune"] <= 24): errors.append("kit %s: tune range" % kit["name"])
            for k in ("level", "decay", "tone"):
                if not (0 <= t[k] <= 1): errors.append("kit %s: %s range" % (kit["name"], k))
            if not (-1 <= t["pan"] <= 1): errors.append("kit %s: pan range" % kit["name"])

    print("\nper category:", per_cat, " total:", sum(per_cat.values()))
    print("kits:", [k["name"] for k in kits])
    for w in warns: print("WARN ", w)
    for e in errors: print("ERROR", e)
    if errors:
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], verbose="-q" not in sys.argv)
