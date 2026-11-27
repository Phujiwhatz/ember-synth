# Generates fake multisample instruments + manifest.json for the Keys harness.
import numpy as np, wave, json, os
D = os.path.dirname(os.path.abspath(__file__))
SR = 44100
def mtof(m): return 440 * 2 ** ((m - 69) / 12)
def write(path, x):
    full = os.path.join(D, path); os.makedirs(os.path.dirname(full), exist_ok=True)
    x = np.clip(x / (np.max(np.abs(x)) + 1e-9) * 0.8, -1, 1)
    if x.ndim == 1: x = np.stack([x, x], 1)
    with wave.open(full, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype('<i2').tobytes())
samples, inst = [], {}
def add(iid, name, cat, zones, release, loop):
    inst[iid] = dict(name=name, category=cat, zones=zones, release=release, loop=loop)
# grand: 3 roots x 2 vel layers
zones = []
for root, lo, hi in [(48, 21, 54), (60, 55, 66), (72, 67, 108)]:
    for L, (vlo, vhi, nh) in enumerate([(0, 0.55, 3), (0.55, 1, 9)]):
        f = mtof(root); t = np.arange(int(SR * 2.5)) / SR
        x = sum(np.sin(2*np.pi*f*k*t) / k**1.3 * np.exp(-t*(1.2+0.6*k)) for k in range(1, nh+1))
        x *= np.minimum(1, t / 0.003)
        sid = f'fx-grand-{root}-v{L}'; fn = f'grand/{root}_v{L}.wav'; write(fn, x)
        samples.append(dict(id=sid, file=fn, category='keys', instrument='fx-grand', root=root, velLayer=L, loop=None))
        zones.append(dict(id=sid, root=root, lo=lo, hi=hi, velLo=vlo, velHi=vhi))
add('fx-grand', 'Test Grand', 'keys', zones, 0.5, False)
# pad: looped
zones = []
for root, lo, hi in [(48, 0, 59), (72, 60, 127)]:
    f0 = mtof(root); n = 300; N = round(n * SR / f0); f = n * SR / N
    t = np.arange(int(SR * 3)) / SR
    x = sum(np.sin(2*np.pi*f*k*t + k) / k for k in range(1, 6)) * np.minimum(1, t / 0.4)
    ls = int(SR * 1.0); le = ls + N
    sid = f'fx-pad-{root}'; fn = f'pad/{root}.wav'; write(fn, x)
    lp = dict(start=ls / SR, end=le / SR)
    samples.append(dict(id=sid, file=fn, category='pads', instrument='fx-pad', root=root, velLayer=0, loop=lp))
    zones.append(dict(id=sid, root=root, lo=lo, hi=hi, velLo=0, velHi=1, loop=lp))
add('fx-pad', 'Test Pad', 'pads', zones, 1.2, True)
# bass
f = mtof(36); t = np.arange(int(SR * 2)) / SR
x = (np.sin(2*np.pi*f*t) + 0.4*np.sin(4*np.pi*f*t)) * np.exp(-t*1.5)
write('bass/36.wav', x)
samples.append(dict(id='fx-bass-36', file='bass/36.wav', category='bass', instrument='fx-bass', root=36, velLayer=0, loop=None))
add('fx-bass', 'Test Bass', 'bass', [dict(id='fx-bass-36', root=36, lo=0, hi=127, velLo=0, velHi=1)], 0.2, False)
# pluck (Karplus-Strong)
f = mtof(60); N = int(SR * 1.5); p = SR / f; buf = np.random.RandomState(1).uniform(-1, 1, int(p)); out = np.zeros(N)
for i in range(N):
    out[i] = buf[i % len(buf)]; buf[i % len(buf)] = 0.5 * (buf[i % len(buf)] + buf[(i + 1) % len(buf)]) * 0.996
write('pluck/60.wav', out)
samples.append(dict(id='fx-pluck-60', file='pluck/60.wav', category='plucks', instrument='fx-pluck', root=60, velLayer=0, loop=None))
add('fx-pluck', 'Test Pluck', 'plucks', [dict(id='fx-pluck-60', root=60, lo=0, hi=127, velLo=0, velHi=1)], 0.3, False)
# a standalone sample for import test: A3 (220 Hz) tone
t = np.arange(int(SR * 1.5)) / SR
write('import_a3.wav', sum(np.sin(2*np.pi*220*k*t) / k for k in range(1, 5)) * np.exp(-t))
json.dump(dict(version=1, samples=samples, kits={}, instruments=inst), open(os.path.join(D, 'manifest.json'), 'w'), indent=1)
print('ok', len(samples))
