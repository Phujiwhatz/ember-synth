#!/usr/bin/env python3
"""Ember Ultimate build: inlines the shell, plugins, sample manifest and audio into ONE offline HTML file.

    python3 build.py                 -> dist/ember-ultimate.html + dist/pwa/
    python3 build.py --no-samples    -> skip embedding audio (fast dev build; samples fetched from samples/ if served)
    python3 build.py --extra a.js    -> also inline extra plugin script(s) (used by tests)
    python3 build.py --out path.html -> alternative output file (no PWA written)

Never fails because a plugin or sample is missing: it warns and carries on.
"""
import argparse, base64, hashlib, json, os, re, struct, sys, zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
CORE_ORDER = ['studio', 'mixer', 'midi', 'recorder', 'ui']
PLUGIN_ORDER = ['ember', 'pulse16', 'keys', 'acid', 'drift']


def warn(msg):
    print('  ! ' + msg, file=sys.stderr)


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def safe_script(js):
    # keep inline scripts from closing their own <script> tag
    return re.sub(r'</(script)', r'<\\/\1', js, flags=re.I).replace('<!--', '<\\!--')


def safe_style(css):
    return re.sub(r'</(style)', r'<\\/\1', css, flags=re.I)


def ordered(names, order):
    first = [n for n in order if n in names]
    return first + sorted(n for n in names if n not in order)


def core_files():
    d = os.path.join(SRC, 'core')
    js = {f[:-3] for f in os.listdir(d) if f.endswith('.js')} if os.path.isdir(d) else set()
    css = sorted(f for f in os.listdir(d) if f.endswith('.css')) if os.path.isdir(d) else []
    return [os.path.join(d, n + '.js') for n in ordered(js, CORE_ORDER)], [os.path.join(d, f) for f in css]


def plugin_files():
    d = os.path.join(SRC, 'plugins')
    if not os.path.isdir(d):
        warn('no src/plugins directory')
        return []
    ids = {f[:-3] for f in os.listdir(d) if f.endswith('.js') and not f.startswith('.')}
    out = []
    for pid in ordered(ids, PLUGIN_ORDER):
        css = os.path.join(d, pid + '.css')
        out.append((pid, os.path.join(d, pid + '.js'), css if os.path.exists(css) else None))
    return out


def load_samples(embed):
    mpath = os.path.join(ROOT, 'samples', 'manifest.json')
    if not os.path.exists(mpath):
        warn('samples/manifest.json not found — building with an empty sample library')
        return {'version': 1, 'samples': [], 'kits': {}, 'instruments': {}}, {}, 0
    try:
        manifest = json.loads(read(mpath))
    except Exception as e:  # noqa
        warn('samples/manifest.json is not valid JSON (%s) — using empty library' % e)
        return {'version': 1, 'samples': [], 'kits': {}, 'instruments': {}}, {}, 0
    data, total, missing = {}, 0, 0
    if embed:
        seen = set()
        for s in manifest.get('samples', []):
            f = s.get('file')
            if not f or f in seen:
                continue
            seen.add(f)
            p = os.path.join(ROOT, 'samples', f)
            if not os.path.exists(p):
                missing += 1
                continue
            with open(p, 'rb') as fh:
                b = fh.read()
            total += len(b)
            data[f] = base64.b64encode(b).decode('ascii')
        if missing:
            warn('%d sample file(s) listed in the manifest are missing — skipped' % missing)
    return manifest, data, total


def build_html(args, pwa=False):
    tpl = read(os.path.join(ROOT, 'index.template.html'))
    core_js, core_css = core_files()
    css = '\n'.join(safe_style(read(p)) for p in core_css)
    js = '\n;\n'.join('/* ---- %s ---- */\n' % os.path.basename(p) + safe_script(read(p)) for p in core_js)

    plugins = plugin_files()
    for extra in args.extra or []:
        if os.path.exists(extra):
            pid = os.path.splitext(os.path.basename(extra))[0]
            c = os.path.splitext(extra)[0] + '.css'
            plugins.append((pid, extra, c if os.path.exists(c) else None))
        else:
            warn('extra plugin not found: ' + extra)
    pcss, pscripts, names = [], [], []
    for pid, jsf, cssf in plugins:
        try:
            pj = read(jsf)
        except Exception as e:  # noqa
            warn('could not read %s: %s' % (jsf, e))
            continue
        names.append(pid)
        if cssf:
            pcss.append('/* ---- plugin: %s ---- */\n%s' % (pid, safe_style(read(cssf))))
        # one <script> per plugin: a syntax error in one plugin cannot take down the others
        pscripts.append('<script data-plugin="%s">\n%s\n</script>' % (pid, safe_script(pj)))

    manifest, data, total = load_samples(not args.no_samples)
    data_js = 'window.__MANIFEST__=%s;\nwindow.__SAMPLES__=%s;\nwindow.__BUILD__=%s;%s' % (
        json.dumps(manifest, separators=(',', ':')),
        json.dumps(data, separators=(',', ':')),
        json.dumps({'plugins': names, 'samples': len(data)}),
        '\nwindow.__PWA__=true;' if pwa else '')

    pwa_head = ''
    if pwa:
        pwa_head = ('<link rel="manifest" href="manifest.webmanifest">\n'
                    '<link rel="apple-touch-icon" href="icon-192.png">\n'
                    '<meta name="apple-mobile-web-app-capable" content="yes">')
    out = tpl
    for key, val in (('<!--{{PWA_HEAD}}-->', pwa_head), ('/*{{CORE_CSS}}*/', css),
                     ('/*{{PLUGIN_CSS}}*/', '\n'.join(pcss)), ('/*{{DATA}}*/', safe_script(data_js)),
                     ('/*{{CORE_JS}}*/', js), ('<!--{{PLUGIN_SCRIPTS}}-->', '\n'.join(pscripts))):
        out = out.replace(key, val, 1)
    return out, names, len(data), total


# ---------------------------------------------------------------- PWA assets
ICON_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2623"/><stop offset="1" stop-color="#151311"/></linearGradient></defs>
<rect width="512" height="512" rx="112" fill="url(#g)"/>
<rect x="56" y="56" width="400" height="400" rx="80" fill="none" stroke="#3a3530" stroke-width="8"/>
<g fill="#ec4a2c"><rect x="120" y="300" width="40" height="92" rx="8"/><rect x="186" y="230" width="40" height="162" rx="8"/>
<rect x="252" y="150" width="40" height="242" rx="8"/><rect x="318" y="200" width="40" height="192" rx="8"/></g>
<rect x="232" y="104" width="80" height="20" rx="6" fill="#f1e8d8"/>
</svg>'''


def png(size):
    """Tiny dependency-free PNG renderer of the icon (rounded square + bars)."""
    S = size / 512.0
    bars = [(120, 300, 160, 392), (186, 230, 226, 392), (252, 150, 292, 392), (318, 200, 358, 392)]

    def inside_rr(x, y, x0, y0, x1, y1, r):
        cx = min(max(x, x0 + r), x1 - r)
        cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and x0 <= x <= x1 and y0 <= y <= y1

    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            x, y = (px + 0.5) / S, (py + 0.5) / S
            if not inside_rr(x, y, 0, 0, 512, 512, 112):
                row += bytes((0, 0, 0, 0))
                continue
            t = y / 512.0
            c = (int(42 + (21 - 42) * t), int(38 + (19 - 38) * t), int(35 + (17 - 35) * t), 255)
            if any(inside_rr(x, y, a, b, cc, d, 8) for a, b, cc, d in bars):
                c = (236, 74, 44, 255)
            elif inside_rr(x, y, 232, 104, 312, 124, 6):
                c = (241, 232, 216, 255)
            row += bytes(c)
        rows.append(bytes(row))
    raw = zlib.compress(b''.join(rows), 9)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', raw) + chunk(b'IEND', b'')


def write_pwa(html, dist):
    d = os.path.join(dist, 'pwa')
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(html)
    with open(os.path.join(d, 'icon.svg'), 'w') as f:
        f.write(ICON_SVG)
    for s in (192, 512):
        p = os.path.join(d, 'icon-%d.png' % s)
        with open(p, 'wb') as f:
            f.write(png(s))
    manifest = {
        'name': 'Ember Ultimate', 'short_name': 'Ember', 'description': 'Offline browser music studio',
        'start_url': './', 'scope': './', 'display': 'standalone', 'background_color': '#0e0d0c', 'theme_color': '#1a1816',
        'icons': [{'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
                  {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
                  {'src': 'icon.svg', 'sizes': 'any', 'type': 'image/svg+xml', 'purpose': 'any'}]}
    with open(os.path.join(d, 'manifest.webmanifest'), 'w') as f:
        json.dump(manifest, f, indent=1)
    ver = hashlib.sha1(html.encode('utf-8')).hexdigest()[:12]
    sw = '''// Ember Ultimate service worker: cache-first, whole app is one file.
const CACHE = 'ember-ultimate-%s';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(r => r || fetch(e.request).then(res => {
    if (res.ok && new URL(e.request.url).origin === location.origin) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return res;
  }).catch(() => caches.match('./index.html'))));
});
''' % ver
    with open(os.path.join(d, 'sw.js'), 'w') as f:
        f.write(sw)
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-samples', action='store_true')
    ap.add_argument('--extra', action='append')
    ap.add_argument('--out')
    args = ap.parse_args()
    dist = os.path.join(ROOT, 'dist')
    os.makedirs(dist, exist_ok=True)
    html, names, nsamp, total = build_html(args)
    out = args.out or os.path.join(dist, 'ember-ultimate.html')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print('built %s (%.1f MB)' % (os.path.relpath(out, ROOT), len(html.encode('utf-8')) / 1e6))
    print('  plugins: %s' % (', '.join(names) or '(none)'))
    print('  samples embedded: %d files, %.1f MB raw' % (nsamp, total / 1e6))
    if not args.out:
        pwa_html, _, _, _ = build_html(args, pwa=True)
        d = write_pwa(pwa_html, dist)
        print('  pwa: %s/' % os.path.relpath(d, ROOT))


if __name__ == '__main__':
    main()
