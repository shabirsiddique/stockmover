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
import argparse, csv, datetime, difflib, json, os, re, sys

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


def csv_block_barcodes(text, name):
    """Barcodes from a `const NAME = `...`;` CSV template literal.

    SAMPLE_CSV is CSV text in backticks, not an object, so it must not be sent
    through block()/json.loads. Fails loudly rather than returning an empty set:
    an empty set here would silently make the coverage denominator wrong in the
    passing direction, which is the exact failure mode this file exists to stop.
    """
    m = re.search(r'const\s+%s\s*=\s*`(.*?)`;' % name, text, flags=re.S)
    if not m:
        raise SystemExit('CSV block not found: %s' % name)
    rows = [r for r in m.group(1).splitlines() if r.strip()]
    if len(rows) < 2:
        raise SystemExit('%s has no data rows -- refusing to continue' % name)
    hdr = [h.strip().lstrip('\ufeff') for h in next(csv.reader([rows[0]]))]
    if 'Barcode' not in hdr:
        raise SystemExit('%s header has no Barcode column: %r' % (name, hdr))
    i = hdr.index('Barcode')
    out = set()
    for r in csv.reader(rows[1:]):
        if len(r) > i and r[i].strip():
            out.add(r[i].strip())
    if not out:
        raise SystemExit('%s yielded no barcodes -- refusing to continue' % name)
    return out


def load_never_at_nelson(path):
    """Barcodes confirmed absent from Nelson's range. Missing file -> empty."""
    try:
        raw = json.load(open(path, encoding='utf-8'))
    except FileNotFoundError:
        return {}
    out = {}
    for k, v in raw.items():
        if k.startswith('_'):
            continue
        if isinstance(v, dict):
            out.update(v)
    return out


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
    ap.add_argument('--allow-app-change', metavar='REASON',
                    help='Permit non-header differences outside the data blocks, for a '
                         'DELIBERATE change to HTML/CSS/JS. Requires a reason, which is '
                         'printed and belongs in the run-log entry. Never pass this to '
                         'silence a diff you did not intend -- read every line first; an '
                         'unexplained line here means app logic changed by accident.')
    ap.add_argument('--allow-low-coverage', metavar='REASON',
                    help='Permit nelson coverage below 95%%, for a build where the shortfall '
                         'is EXPLAINED -- typically new lines Colne has taken that Nelson '
                         'does not stock at all, so their barcodes are absent from the Nelson '
                         'stock report. Requires a reason, which is printed and belongs in the '
                         'run-log entry. Before passing this, list the missing barcodes and '
                         'confirm they are genuinely absent from the source report rather '
                         'than lost in parsing -- a coverage drop caused by a broken export '
                         'or a truncated block looks identical from here.')
    ap.add_argument('--never-at-nelson', metavar='PATH',
                    default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         'never_at_nelson.json'),
                    help='JSON list of barcodes Nelson does not range at all. These are '
                         'excluded from the coverage denominator so the figure measures '
                         'UNEXPLAINED misses. See the file for maintenance rules.')
    a = ap.parse_args()

    old = open(a.old, encoding='utf-8').read()
    new = open(a.new, encoding='utf-8').read()

    # 1. Version constants -- by value, never by diff. A constant stale in BOTH
    #    files produces no diff at all; that blind spot shipped the 14 Aug stamp
    #    and the 15 Aug date.
    #
    #    BUILD_DATE is "D Mon YYYY HH:MM" as of 2026-08-17. The time matters:
    #    the job runs 4x daily and stock moves between slots, so the date alone
    #    cannot tell staff whether the list predates the pick they just did.
    #    Assert BOTH halves -- date is today AND the time actually advanced --
    #    because a date-only check would pass a build whose clock never moved,
    #    which is exactly the class of bug that shipped the stale 14 Aug stamp.
    today = datetime.date.today().strftime('%-d %b %Y')
    nd, ns, od, os_ = const(new, 'BUILD_DATE'), const(new, 'BUILD_STAMP'), \
        const(old, 'BUILD_DATE'), const(old, 'BUILD_STAMP')
    m = re.match(r'^(\d{1,2} \w{3} \d{4}) (\d{2}:\d{2})$', nd)
    check(bool(m), 'BUILD_DATE matches "D Mon YYYY HH:MM" (got %r)' % nd)
    if m:
        check(m.group(1) == today,
              'BUILD_DATE date part == today (%r, was %r)' % (nd, od))
        check(nd != od, 'BUILD_DATE advanced (%r -> %r)' % (od, nd))
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

    # 3. Stock-map coverage, measured on rows that COULD have matched.
    #
    #    The raw ratio (matched / all Colne warning rows) was being waived on every
    #    run by 2026-08-19 because a fixed set of lines Nelson does not range at all
    #    can never match. Worse, the raw figure moved the wrong way: as picks cleared
    #    the warnings list the denominator shrank while that set stayed fixed, so it
    #    read 94.9 -> 93.9 -> 93.2% across 18 Aug while unmatched rows went 17 -> 17
    #    -> 16, i.e. coverage was flat-to-better while the number said "worse".
    #    Excluding known-unrangeable barcodes makes a miss mean something again.
    never = load_never_at_nelson(a.never_at_nelson)

    # Stale-entry guard: if Nelson now stocks a listed line, the entry is wrong and
    # must be removed, or it will hide a real miss forever. Fail, never warn.
    resurfaced = sorted(set(never) & set(block(new, 'NELSON_STOCK_MAP')))
    check(not resurfaced,
          'never_at_nelson.json has no stale entries%s'
          % ('' if not resurfaced else
             ' -- Nelson now stocks %s; remove them from the file' % ', '.join(resurfaced)))

    if a.rows:
        rows_bc = csv_block_barcodes(new, 'SAMPLE_CSV')
        nsm = set(block(new, 'NELSON_STOCK_MAP'))
        unmatched = rows_bc - nsm
        excluded = sorted(unmatched & set(never))
        unexplained = sorted(unmatched - set(never))
        denom = a.rows - len(excluded)

        print('     rows=%d  matched=%d  unmatched=%d  (known-unrangeable=%d, '
              'unexplained=%d)' % (a.rows, counts['NELSON_STOCK_MAP'][1],
                                   len(unmatched), len(excluded), len(unexplained)))
        for b in excluded:
            print('       excluded  %-14s %s' % (b, never[b]))
        for b in unexplained:
            print('       UNEXPLAINED %s' % b)

        raw = 100.0 * counts['NELSON_STOCK_MAP'][1] / a.rows
        cov = 100.0 * (denom - len(unexplained)) / denom if denom else 0.0
        label = ('nelson coverage %d/%d (%.1f%%) >= 95%% '
                 '[raw %.1f%% before excluding %d unrangeable]'
                 % (denom - len(unexplained), denom, cov, raw, len(excluded)))
        if cov < 95.0 and a.allow_low_coverage:
            print('     NOTE low coverage permitted: %s' % a.allow_low_coverage)
            check(True, label + ' [waived]')
        else:
            check(cov >= 95.0, label)

    # 4. Non-data diff: only the expected header-comment lines may differ.
    diff = [l for l in difflib.unified_diff(strip_data(old).splitlines(),
                                            strip_data(new).splitlines(), lineterm='', n=0)
            if l[:1] in '+-' and l[:3] not in ('---', '+++')]
    for l in diff:
        print('     ' + l[:200])
    if a.allow_app_change:
        print('     NOTE app change permitted: %s' % a.allow_app_change)
        print('     %d non-data diff line(s) accepted -- read them above.' % len(diff))
    else:
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
