#!/usr/bin/env python3
"""Import the Pulse 16 built-in sound library into Ember Ultimate.

Reads library.zip (entries '<Category>/<Sound Name>.wav', 44.1 kHz PCM) from the Pulse 16
source tree, encodes every WAV to AAC/.m4a under samples/pulse16/<category>/<slug>.m4a and
merges one manifest entry per sound into samples/manifest.json:

    { "id": "p16-snares-classic-808-snare", "file": "pulse16/snares/classic-808-snare.m4a",
      "category": "pulse16", "p16": "Snares/Classic 808 Snare.wav", "group": "Snares",
      "name": "Classic 808 Snare", "root": 60, "channels": 1, "duration": 0.42 }

`p16` keeps the original zip path so Pulse 16 kit references such as
'builtin:Snares/Classic 808 Snare.wav' resolve. Encoding matches tools/render_samples.py:
1024 frames of silence are prepended (ffmpeg's AAC encoder mangles a loud first frame) and
hidden again with -output_ts_offset, so the MP4 edit list skips priming + pad and decoded
hits start at sample 0. Silence is appended too so end rounding only trims silence.

Idempotent: existing non-pulse16 entries are never touched; pulse16 entries are replaced
in place (same id) or appended. Re-encodes only when the .m4a is missing (use --force).

Usage: python3 tools/import_pulse16_library.py [--zip path/to/library.zip] [--force] [--verify]
"""
import argparse, io, json, os, re, subprocess, sys, wave, zipfile
import numpy as np

SR = 44100
PAD = 1024
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'samples')
FFMPEG = '/usr/local/bin/ffmpeg' if os.path.exists('/usr/local/bin/ffmpeg') else 'ffmpeg'
DEFAULT_ZIP = '/home/claude/pulse16-src/drums/library/library.zip'
CATEGORIES = ['Kicks', 'Snares', 'Claps', 'Hats', 'Cymbals', 'Toms', 'Percussion', 'FX']


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def read_wav(data):
    w = wave.open(io.BytesIO(data))
    ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, '<i2').astype(np.float32) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        v = np.where(v >= 1 << 23, v - (1 << 24), v)
        x = v.astype(np.float32) / float(1 << 23)
    elif sw == 4:
        x = np.frombuffer(raw, '<i4').astype(np.float32) / 2147483648.0
    else:
        x = (np.frombuffer(raw, np.uint8).astype(np.float32) - 128) / 128.0
    return x.reshape(-1, ch), sr


def encode(x, sr, path, kbps=128, cutoff=20000):
    ch = x.shape[1]
    pad = int(round(PAD * sr / SR))
    x = np.concatenate([np.zeros((pad, ch)), x, np.zeros((pad, ch))]).astype('<f4')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cmd = [FFMPEG, '-v', 'error', '-y', '-f', 'f32le', '-ar', str(sr), '-ac', str(ch), '-i', '-',
           '-c:a', 'aac', '-b:a', f'{kbps}k', '-cutoff', str(cutoff),
           '-output_ts_offset', '-%.6f' % (pad / sr), '-movflags', '+faststart', path]
    subprocess.run(cmd, input=x.tobytes(), check=True)


def decode(path, ch, sr):
    r = subprocess.run([FFMPEG, '-v', 'error', '-i', path, '-f', 'f32le', '-ac', str(ch), '-ar', str(sr), '-'],
                       capture_output=True, check=True)
    return np.frombuffer(r.stdout, '<f4').reshape(-1, ch)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zip', default=DEFAULT_ZIP)
    ap.add_argument('--force', action='store_true', help='re-encode even if the .m4a exists')
    ap.add_argument('--verify', action='store_true', help='decode each file and compare onset/length to the WAV')
    a = ap.parse_args()
    if not os.path.exists(a.zip):
        sys.exit('library.zip not found: ' + a.zip)

    z = zipfile.ZipFile(a.zip)
    names = [n for n in z.namelist() if n.lower().endswith('.wav') and '/' in n]
    rank = {c: i for i, c in enumerate(CATEGORIES)}
    names.sort(key=lambda n: (rank.get(n.split('/')[0], 99), n.lower()))

    entries, worst = [], []
    for n in names:
        cat, fname = n.split('/', 1)
        name = os.path.splitext(fname)[0]
        x, sr = read_wav(z.read(n))
        rel = 'pulse16/%s/%s.m4a' % (slug(cat), slug(name))
        path = os.path.join(OUT, rel)
        if a.force or not os.path.exists(path):
            encode(x, sr, path)
        entries.append(dict(id='p16-%s-%s' % (slug(cat), slug(name)), file=rel, category='pulse16', p16=n,
                            group=cat, name=name, root=60, channels=int(x.shape[1]),
                            duration=round(x.shape[0] / sr, 4)))
        if a.verify:
            y = decode(path, x.shape[1], sr)
            L = min(len(x), len(y))
            on_x = int(np.argmax(np.abs(x[:, 0]) > 0.05))
            on_y = int(np.argmax(np.abs(y[:, 0]) > 0.05))
            err = float(np.sqrt(np.mean((x[:L] - y[:L]) ** 2)) / (np.sqrt(np.mean(x[:L] ** 2)) + 1e-9))
            worst.append((n, len(y) - len(x), on_y - on_x, round(err, 4)))

    mpath = os.path.join(OUT, 'manifest.json')
    man = json.load(open(mpath)) if os.path.exists(mpath) else {'version': 1, 'samples': [], 'kits': {}, 'instruments': {}}
    by_id = {e['id']: e for e in entries}
    samples, seen = [], set()
    for s in man.get('samples', []):
        if s.get('id') in by_id:
            if s.get('category') != 'pulse16':
                sys.exit('id clash with a non-pulse16 entry: ' + s['id'])
            samples.append(by_id[s['id']])     # replace in place
            seen.add(s['id'])
        elif s.get('category') == 'pulse16':
            continue                           # stale pulse16 entry (sound removed from the zip)
        else:
            samples.append(s)
    added = [e for e in entries if e['id'] not in seen]
    samples.extend(added)
    man['samples'] = samples
    with open(mpath, 'w') as f:
        json.dump(man, f, separators=(',', ':'))

    total = sum(os.path.getsize(os.path.join(OUT, e['file'])) for e in entries)
    print('pulse16: %d sounds (%d new, %d updated), %.2f MB of m4a; manifest now has %d samples'
          % (len(entries), len(added), len(seen), total / 1e6, len(samples)))
    if a.verify:
        # (the ffmpeg CLI ignores the edit-list end trim, so the decoded length includes the silent
        #  tail pad; browsers honour it. Only onsets of sharp hits are checked.)
        bad = [w for w in worst if abs(w[2]) > 4 and not w[0].startswith('FX/')]
        print('verify: length diff / onset diff (frames) / rel. error; worst:',
              sorted(worst, key=lambda w: -w[3])[:4])
        print('verify problems:', len(bad), bad[:10])


if __name__ == '__main__':
    main()
