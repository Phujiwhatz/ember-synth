#!/usr/bin/env python3
"""Replace the synthesized 'grand' with the Salamander Grand Piano V3 (real recordings).

Salamander Grand Piano V3 by Alexander Holm — CC BY 3.0
(https://creativecommons.org/licenses/by/3.0/), via github.com/sfzinstruments/SalamanderGrandPiano.
Changes made here: 4 of the 16 velocity layers, trimmed lengths with fade-outs, resampled to
44.1 kHz and encoded as AAC.

Usage: python3 tools/import_salamander.py /path/to/SalamanderGrandPiano/Samples
"""
import os, sys, json, subprocess
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render_samples as R   # reuse encode() (AAC priming fix) and constants

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/SalamanderGrandPiano/Samples'
ROOT = R.ROOT
OUTDIR = os.path.join(ROOT, 'samples', 'keys', 'grand')
MAN = os.path.join(ROOT, 'samples', 'manifest.json')
LAYERS = [(3, 0.0, 0.36), (7, 0.36, 0.6), (11, 0.6, 0.82), (15, 0.82, 1.0)]   # (salamander vel, velLo, velHi)
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
CREDIT = 'Salamander Grand Piano V3 by Alexander Holm (CC BY 3.0)'


def sal_name(m):
    return f'{NAMES[m % 12]}{m // 12 - 1}'


def load(path):
    r = subprocess.run([R.FFMPEG, '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(R.SR),
                        '-af', 'aresample=resampler=soxr', '-'], capture_output=True, check=True)
    return np.frombuffer(r.stdout, '<f4').reshape(-1, 2).astype(np.float64)


def max_len(m):          # seconds kept: long bass, shorter treble (natural decay is shorter up there)
    return float(np.interp(m, [21, 60, 84, 108], [16, 11, 7, 4.5]))


def main():
    roots = list(range(21, 109, 3))          # A0, C1, D#1 ... C8
    assert roots[-1] == 108 and len(roots) == 30
    raw = {}
    for m in roots:
        for sv, _, _ in LAYERS:
            p = os.path.join(SRC, f'{sal_name(m)}v{sv}.flac')
            x = load(p)
            a = np.abs(x).max(axis=1)
            on = int(np.argmax(a > a.max() * 10 ** (-40 / 20)))       # onset at -40 dB re peak
            x = x[max(0, on - int(0.002 * R.SR)):]
            n = min(len(x), int(max_len(m) * R.SR))
            x = x[:n].copy()
            fo = min(int(1.2 * R.SR), n // 3)                           # gentle fade-out
            x[n - fo:] *= np.linspace(1, 0, fo)[:, None] ** 2
            x[:16] *= np.linspace(0, 1, 16)[:, None]                    # no click at start
            x -= x.mean(axis=0)
            raw[(m, sv)] = x
    # one gain per layer (keeps the piano's natural balance across the keyboard)
    gains = {sv: R.PEAK / max(np.abs(raw[(m, sv)]).max() for m in roots) for sv, _, _ in LAYERS}

    man = json.load(open(MAN))
    old = [s for s in man['samples'] if s.get('instrument') == 'grand']
    for s in old:
        try: os.remove(os.path.join(ROOT, 'samples', s['file']))
        except FileNotFoundError: pass
    man['samples'] = [s for s in man['samples'] if s.get('instrument') != 'grand']

    zones, total = [], 0
    for i, m in enumerate(roots):
        lo = 0 if i == 0 else m - 1
        hi = 127 if i == len(roots) - 1 else m + 1
        for li, (sv, vlo, vhi) in enumerate(LAYERS, 1):
            x = raw[(m, sv)] * gains[sv]
            sid = f'keys-grand-{R.note_name(m)}-v{li}'
            rel = f'keys/grand/{R.note_name(m)}-v{li}.m4a'
            path = os.path.join(ROOT, 'samples', rel)
            R.encode(x, path, 112)
            total += os.path.getsize(path)
            man['samples'].append({'id': sid, 'file': rel, 'category': 'keys', 'instrument': 'grand', 'root': m,
                                   'velLayer': li, 'loop': None, 'channels': 2,
                                   'duration': round(len(x) / R.SR, 3)})
            zones.append({'id': sid, 'root': m, 'lo': lo, 'hi': hi, 'velLo': vlo, 'velHi': vhi})
        print(sal_name(m), end=' ', flush=True)
    man['instruments']['grand'] = {'name': 'Concert Grand', 'category': 'keys', 'range': [21, 108],
                                   'zones': zones, 'release': 0.5, 'loop': False, 'credit': CREDIT,
                                   'description': 'Yamaha C5 · 4 velocity layers · real recordings'}
    json.dump(man, open(MAN, 'w'), indent=1)
    print(f'\n{len(zones)} samples, {total / 1e6:.1f} MB, layer gains', {k: round(v, 2) for k, v in gains.items()})


if __name__ == '__main__':
    main()
