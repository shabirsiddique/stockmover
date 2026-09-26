#!/usr/bin/env python3
"""verify_downloads.py — prove Epos Now CSVs saved to ~/Downloads match the
in-page fetch, before building from them.

Route 0 (form.submit() into Downloads, first used 26 Sep 2026) produces files
that never passed through the page's own checksum. This mirrors
browser_export.js parseCsv/ser/reduceAndNorm/ck exactly so a downloaded file
can be compared against the FNV values the page reported:

  python3 verify_downloads.py --colne-warn A.csv --nelson-warn B.csv \
      --nelson-stock C.csv --colne-stock D.csv \
      --expect colneW=54252644 nelsonW=1096830634 \
               nelsonL_sorted=2051766751 colneL_sorted=20634822

Warnings are compared as-is (FNV of the normalised text). Stock Levels are
compared SORTED, because Epos Now does not keep row order stable between
exports. The in-page sorted checksum is:
  ck([head].concat(lines.slice(1).sort()).join('\\n')+'\\n')
It also recomputes pctEqual on each raw stock report and fails at >= 95%
(the All-Locations trap). It exits non-zero on any mismatch.
"""
import argparse, re, sys
# Mirrors browser_export.js parseCsv/ser/reduceAndNorm/ck so a downloaded CSV
# can be proven identical to what the in-page fetch produced.
def ck(s):
    h = 2166136261
    for c in s:
        h = ((h ^ ord(c)) * 16777619) & 0xFFFFFFFF
    return h

def parse(t):
    rows, row, cur, q, i = [], [], '', False, 0
    while i < len(t):
        c = t[i]
        if q:
            if c == '"':
                if i + 1 < len(t) and t[i+1] == '"': cur += '"'; i += 1
                else: q = False
            else: cur += c
        elif c == '"': q = True
        elif c == ',': row.append(cur); cur = ''
        elif c == '\r': pass
        elif c == '\n': row.append(cur); cur = ''; rows.append(row); row = []
        else: cur += c
        i += 1
    if cur != '' or row: row.append(cur); rows.append(row)
    return rows

esc = lambda v: '"' + v.replace('"', '""') + '"' if re.search(r'[",\n\r]', v) else v
ser = lambda rows: '\n'.join(','.join(esc(x) for x in r) for r in rows) + '\n'

def reduce_norm(text, keep=None, cols=None):
    rows = parse(text); head = rows[0]; bi = head.index('Barcode')
    body = [x for x in rows[1:] if len(x) > 1]
    if keep is not None: body = [x for x in body if x[bi].strip() in keep]
    oh, ob = head, body
    if cols:
        idx = [head.index(c) for c in cols]; oh = cols
        ob = [[x[i] if i < len(x) else '' for i in idx] for x in body]
    nidx = [oh.index(c) for c in ['CurrentStock','MinStock','MaxStock','OnOrder','Reorder'] if c in oh]
    skipped = 0
    for r in ob:
        for i in nidx:
            v = r[i]
            if re.fullmatch(r'-?\d+\.0+', v): r[i] = str(int(v.split('.')[0]))
            elif re.fullmatch(r'-?\d*\.\d+', v): skipped += 1
    return ser([oh] + ob), skipped

def load(p):
    t = open(p, encoding='utf-8', newline='').read()
    return t[1:] if t.startswith('﻿') else t

def srt(t):
    L = [x for x in t.split('\n') if x]
    return '\n'.join([L[0]] + sorted(L[1:])) + '\n'

def pct_equal(raw):
    r = parse(raw); h = r[0]; ci, ti = h.index('CurrentStock'), h.index('TotalStock')
    b = [x for x in r[1:] if len(x) > max(ci, ti)]
    eq = sum(float(x[ci] or 0) == float(x[ti] or 0) for x in b)
    return len(b), 100 * eq / len(b) if b else 0

def main():
    ap = argparse.ArgumentParser()
    for a in ('colne-warn', 'nelson-warn', 'nelson-stock', 'colne-stock'):
        ap.add_argument('--' + a, required=True)
    ap.add_argument('--expect', nargs='*', default=[], help='key=fnv pairs from the page')
    a = ap.parse_args()
    exp = dict(e.split('=', 1) for e in a.expect)
    cw, s1 = reduce_norm(load(a.colne_warn)); nw, s2 = reduce_norm(load(a.nelson_warn))
    keep = set()
    for t in (cw, nw):
        r = parse(t); bi = r[0].index('Barcode'); keep |= {x[bi].strip() for x in r[1:] if x[bi]}
    cols = ['Barcode', 'CurrentStock', 'TotalStock']
    got, fail = {}, False
    got['colneW'], got['nelsonW'] = ck(cw), ck(nw)
    for k, p in (('nelsonL', a.nelson_stock), ('colneL', a.colne_stock)):
        raw = load(p); red, _ = reduce_norm(raw, keep, cols)
        got[k] = ck(red); got[k + '_sorted'] = ck(srt(red))
        n, pe = pct_equal(raw)
        ok = pe < 95
        print(('OK  ' if ok else 'FAIL') + f' {k}: {n} raw rows, CurrentStock==TotalStock {pe:.1f}% (expect 55-65%)')
        fail |= not ok
    if s1 or s2:
        print(f'FAIL normalisation skipped {s1}+{s2} non-integer values (must be 0)'); fail = True
    print(f'     keep set: {len(keep)} barcodes')
    for k, v in exp.items():
        ok = str(got.get(k)) == v
        print(('OK  ' if ok else 'FAIL') + f' {k}: file {got.get(k)} vs page {v}')
        fail |= not ok
    if not exp:
        print('FAIL no --expect values given: nothing was compared against the page'); fail = True
    sys.exit(1 if fail else 0)

if __name__ == '__main__':
    main()
