#!/usr/bin/env python3
"""Souhrn archivu hledání (jsonl / jsonl.gz) → Markdown report na stdout.

    python3 -I tools/analyze.py hledani/2026-10-20.jsonl.gz [další soubory…] [--od 2026-10-18T03:00]

Vypíše rychlost, hledání bez výsledku, s málo výsledky a kandidáty na chybné vyřazení
(soubor obsahuje slova názvu a správnou značku dílu, ale neprošel), přijaté zkomolené názvy
a zásahy pravidel roku/délky/rebootu. Kandidáty je potřeba zkontrolovat ručně.
"""
import collections
import gzip
import json
import re
import statistics
import sys
import unicodedata

SAFE_REASONS = ('jiný díl', 'jiná sezóna', 'nepřehratelný soubor')


def norm(s):
    s = unicodedata.normalize('NFD', str(s or '').lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def load(paths):
    out = []
    for p in paths:
        op = gzip.open if p.endswith('.gz') else open
        with op(p, 'rt', encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    return out


def name_tokens(text):
    stop = {'the', 'a', 'an', 'of', 'and', 'le', 'la', 'les', 'der', 'die', 'das'}
    return [t for t in norm(text).split() if t not in stop and len(t) >= 3]


def candidates(r):
    """Neprošlé soubory, které obsahují všechna významná slova některého názvu a správný díl."""
    out = []
    ep_re = None
    if r.get('type') == 'series' and r.get('season') and r.get('episode'):
        s, e = r['season'], r['episode']
        ep_re = re.compile(r'(?:\bs0*%d\s?e0*%d\b|\b0*%dx0*%d\b)' % (s, e, s, e))
    names = [n['text'] for n in r.get('names', [])]
    for f in r.get('files', []):
        if f.get('ok') or f.get('r', '').startswith(SAFE_REASONS) or f.get('r', '').startswith('délka'):
            continue
        fn = norm(f['n'])
        words = set(fn.split())
        if not any(name_tokens(n) and all(t in words for t in name_tokens(n)) for n in names):
            continue
        if ep_re and not ep_re.search(fn):
            continue
        # film: soubor s jiným rokem (±1) je skoro vždy jiný film stejného jména
        if r.get('type') == 'movie' and r.get('year'):
            ys = [int(y) for y in re.findall(r'\b(19\d\d|20\d\d)\b', fn)]
            if ys and all(abs(y - r['year']) > 1 for y in ys):
                continue
        out.append(f)
    return out


def main():
    args = sys.argv[1:]
    since = ''
    if '--od' in args:
        i = args.index('--od')
        since = args[i + 1]
        del args[i:i + 2]
    recs = [r for r in load(args) if r.get('t', '') > since]
    if not recs:
        print('Žádné nové záznamy.')
        return
    streams = [r for r in recs if r.get('kind') == 'stream' and 'files' in r]
    cats = [r for r in recs if r.get('kind') == 'catalog']
    noname = [r for r in recs if r.get('kind') == 'stream' and 'files' not in r]
    versions = collections.Counter(r.get('v', '?') for r in streams)
    p = print
    p(f"# Report archivu hledání\n")
    p(f"- Období: {recs[0]['t'][:16]} – {recs[-1]['t'][:16]} (UTC)")
    p(f"- Hledání streamů: {len(streams)} (unikátních ID {len({r['id'] for r in streams})}), katalog: {len(cats)}, bez názvů: {len(noname)}")
    p(f"- Verze addonu: {', '.join(f'{k} ({v})' for k, v in versions.most_common())}")
    if streams:
        ms = sorted(r.get('ms', 0) for r in streams)
        p(f"- Rychlost: medián {statistics.median(ms):.0f} ms, p90 {ms[int(len(ms) * .9)]} ms, max {ms[-1]} ms")
    slow = [r for r in streams if r.get('ms', 0) > 5000]
    if slow:
        p(f"\n## Pomalá hledání (> 5 s)\n")
        for r in slow:
            p(f"- {r.get('ms')} ms – `{r['id']}` {r['names'][0]['text'] if r.get('names') else ''}")

    last = {}
    for r in streams:
        last[r['id']] = r
    zero = [r for r in last.values() if not any(f.get('sent') for f in r['files'])]
    low = [r for r in last.values() if 0 < sum(1 for f in r['files'] if f.get('sent')) <= 2]

    def head(r):
        nm = r['names'][0]['text'] if r.get('names') else '-'
        reasons = collections.Counter(f.get('r', '').split(' (')[0] for f in r['files']).most_common(4)
        return f"`{r['id']}` **{nm}** ({r.get('year')}) – {len(r['files'])} souborů; " + ', '.join(f'{k} {v}' for k, v in reasons)

    def show_cands(r, n=8):
        c = candidates(r)
        for f in c[:n]:
            p(f"    - ❓ {f.get('r')} — `{f['n'][:110]}`")
        if len(c) > n:
            p(f"    - … a dalších {len(c) - n}")
        return len(c)

    p(f"\n## Bez výsledku ({len(zero)})\n")
    for r in zero:
        p(f"- {head(r)}")
        show_cands(r)
    p(f"\n## Málo výsledků – 1 až 2 ({len(low)})\n")
    for r in low:
        p(f"- {head(r)}")
        show_cands(r, 5)

    other = [r for r in last.values() if r not in zero and r not in low and candidates(r)]
    if other:
        p(f"\n## Další kandidáti na chybné vyřazení\n")
        for r in other:
            p(f"- {head(r)}")
            show_cands(r, 5)

    fixed = [(r['id'], f) for r in last.values() for f in r['files'] if 'zkomolen' in f.get('r', '')]
    if fixed:
        p(f"\n## Zkomolené názvy ({len(fixed)}) – zkontrolovat, že sedí\n")
        for i, f in fixed[:30]:
            p(f"- {'✅' if f.get('ok') else '❌'} `{i}` {f.get('r')} — `{f['n'][:100]}`")
    sn = [(r['id'], r.get('sameName'), f) for r in last.values() for f in r['files']
          if 'starší seriál' in f.get('r', '') or 'novější seriál' in f.get('r', '')]
    if sn:
        p(f"\n## Pravidlo stejnojmenného seriálu ({len(sn)} vyřazených)\n")
        for i, y, f in sn[:30]:
            p(f"- `{i}` (jiné: {y}) {f.get('r')} — `{f['n'][:100]}`")
    dur = collections.Counter(r['id'] for r in last.values() for f in r['files'] if f.get('r', '').startswith('délka'))
    yr = collections.Counter(r['id'] for r in last.values() for f in r['files'] if f.get('r', '').startswith('rok nesedí'))
    p(f"\n## Pravidla délky a roku\n")
    p(f"- Vyřazeno podle délky: {sum(dur.values())} souborů u {len(dur)} titulů")
    p(f"- Vyřazeno podle roku: {sum(yr.values())} souborů u {len(yr)} titulů")
    for i, n in (dur + yr).most_common(8):
        r = last[i]
        p(f"  - `{i}` {r['names'][0]['text'] if r.get('names') else ''}: {n}")
    srcs = collections.Counter('hs' if f.get('src') == 'hs' else 'ws' for r in last.values() for f in r['files'] if f.get('sent'))
    p(f"\n## Zdroje odeslaných streamů\n\n- Webshare {srcs.get('ws', 0)}, Hellspy {srcs.get('hs', 0)}")


if __name__ == '__main__':
    main()
