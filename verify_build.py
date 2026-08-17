#!/usr/bin/env python3
"""Step 3 sanity checks for a Stock Mover rebuild.

Usage:  python3 verify_build.py --old index.html --new /tmp/index_new.html

Exits non-zero and prints FAIL lines if any check does not pass. Written because
the checks were being retyped from the skill each session and a hand-written
regex got LOCATION_MAP wrong on 2026-08-17: LOCATION_MAP is a single ~57k-char
line, so a lazy `\\{.*?\\n\\}` pattern runs past the end of the block and swallows
the rest of the file. That mistake is silent in the dangerous direction -- it can
make the non-data diff compare almost nothing and report a clean pass. Block
extraction here is brace-matched, never regex-delimited.
"""
import argparse, datetime, difflib, json, re, sys

DICT_BLOCKS = ['IMAGE_MAP', 'LOCATION_MAP', 'NELSON_STOCK_MAP', 'SRC_STOCK_REV']
CSV_BLOCKS = ['SAMPLE_CSV_REV', 'SAMPLE_CSV']  # longest name first: SAMPLE_CSV is a prefix
EXPECTED_HEADER_DIFFS = 3  # sample row count/date, images resolved, nelson stock map date

fails = []


def check(ok, msg):
    print(("OK   " if ok else "FAIL ") + msg)
    if not ok:
        fails.append(msg)


def span(text, name):
    """Return (start, brace_open, end) of `const NAME = {...};` by brace matching."""
    m = re.search(r'const\s+%s\s*=\s*\{' % name, text)
    if not m:
        raise SystemExit('block not found: %s' % name)
    i = m.end() - 1
    depth = 0
    for j in range(i, len(text)):
        if text[j] == '{':
            depth += 1
        elif text[j] == '}':
            depth -= 1
            if depth == 0:
                return (m.start(), i, j + 1)
    raise SystemExit('unbalanced braces in %s' % name)


def block(text, name):
    """Parse a JS object literal block. Fails loudly -- never returns {} on error."""
    s = span(text, name)
    body = re.sub(r',(\s*\})', r'\1', text[s[1]:s[2]])  # JS allows a trailing comma, JSON does not
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        raise SystemExit('%s failed to parse (%s) -- refusing to continue' % (name, e))


def const(text, name):
    m = re.search(r'%s\s*=\s*"([^"]*)"' % name, text)
    if not m:
        raise SystemExit('version constant missing: %s' % name)
    return m.group(1)


def strip_data(text):
    for name in DICT_BLOCKS:
        s = span(text, name)
        text = text[:s[0]] + '<<%s>>' % name + text[s[2]:]
    for name in CSV_BLOCKS:
        text = re.sub(r'const\s+%s\s*=\s*`.*?`;' % name, '<<%s>>' % name, text, flags=re.S)
    text = re.sub(r'BUILD_DATE\s*=\s*"[^"]*"', 'BUILD_DATE=<<>>', text)
    text = re.sub(r'BUILD_STAMP\s*=\s*"[^"]*"', 'BUILD_STAMP=<<>>', text)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--old', required=True, help='currently deployed index.html')
    ap.add_argument('--new', required=True, help='freshly built index.html')
    ap.add_argument('--rows', type=int, help='row count reported by build_index.py')
    a = ap.parse_args()

    old = open(a.old, encoding='utf-8').read()
    new = open(a.new, encoding='utf-8').read()

    # 1. Version constants -- by value, never by diff. A constant stale in BOTH
    #    files produces no diff at all; that blind spot shipped the 14 Aug stamp
    #    and the 15 Aug date.
    today = datetime.date.today().strftime('%-d %b %Y')
    nd, ns, od, os_ = const(new, 'BUILD_DATE'), const(new, 'BUILD_STAMP'), \
        const(old, 'BUILD_DATE'), const(old, 'BUILD_STAMP')
    check(nd == today, 'BUILD_DATE == today (%r, was %r)' % (nd, od))
    check(ns != os_, 'BUILD_STAMP moved (%r -> %r)' % (os_, ns))

    # 2. Carried-forward blocks intact.
    counts = {n: (len(block(old, n)), len(block(new, n))) for n in DICT_BLOCKS}
    for n, (o, b) in counts.items():
        print('     %-18s old=%5d new=%5d' % (n, o, b))
    check(counts['IMAGE_MAP'][1] >= counts['IMAGE_MAP'][0],
          'IMAGE_MAP >= previous (%d -> %d) -- it is cumulative, never filter it'
          % counts['IMAGE_MAP'])
    check(counts['LOCATION_MAP'][1] == 2040,
          'LOCATION_MAP == 2040 (got %d)' % counts['LOCATION_MAP'][1])

    # 3. Stock-map coverage.
    if a.rows:
        cov = 100.0 * counts['NELSON_STOCK_MAP'][1] / a.rows
        check(cov >= 95.0, 'nelson coverage %d/%d (%.1f%%) >= 95%%'
              % (counts['NELSON_STOCK_MAP'][1], a.rows, cov))

    # 4. Non-data diff: only the expected header-comment lines may differ.
    diff = [l for l in difflib.unified_diff(strip_data(old).splitlines(),
                                            strip_data(new).splitlines(), lineterm='', n=0)
            if l[:1] in '+-' and l[:3] not in ('---', '+++')]
    for l in diff:
        print('     ' + l[:200])
    check(len(diff) <= EXPECTED_HEADER_DIFFS * 2,
          'non-data diff is %d lines, expected <= %d (%d header comments)'
          % (len(diff), EXPECTED_HEADER_DIFFS * 2, EXPECTED_HEADER_DIFFS))
    check(all('=====' in l for l in diff),
          'every non-data diff line is a header comment (app logic unchanged)')

    # 5. File size.
    check(len(new) >= len(old) * 0.92,
          'size held: %.1fKB -> %.1fKB (a sharp drop means a carried-forward block truncated)'
          % (len(old) / 1024, len(new) / 1024))

    print('\n%d check(s) FAILED' % len(fails) if fails else '\nall checks passed')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
