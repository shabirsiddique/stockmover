#!/usr/bin/env python3
"""
build_index.py — regenerate the embedded data blocks in Stock Mover's index.html.

Stock Mover (https://shabirsiddique.github.io/stockmover/) is a single
self-contained HTML file with no runtime fetching: every dataset is baked in.
This script replaces those blocks in place and leaves all HTML, CSS and app
logic untouched.

Usage
-----
  python3 build_index.py \
      --index         index.html \
      --colne-warn    StockWarnings_<date>_<time>.csv \
      --nelson-warn   StockWarnings_<date>_<time>.csv \
      --nelson-stock  StockReport_<date>_<time>.csv \
     [--colne-stock   StockReport_<date>_<time>.csv] \
     [--images        images.json] \
     [--locations     locations.json] \
     [--out           index.html]

Only --index and --colne-warn are strictly required; any block whose source is
omitted is carried forward unchanged from the existing file. That means a
partial run degrades gracefully instead of blanking data.

Blocks written
--------------
  Forward (Nelson -> Colne)      SAMPLE_CSV        Colne warnings
                                 NELSON_STOCK_MAP  Nelson stock levels
  Reverse (Colne -> Nelson)      SAMPLE_CSV_REV    Nelson warnings
                                 SRC_STOCK_REV     Colne stock levels
  Shared                         LOCATION_MAP      Nelson stockroom route
                                 IMAGE_MAP         Shopify photos by barcode

LOCATION_MAP describes the Nelson stockroom only. Colne has no sub-location
mapping, so the reverse direction sorts by category/name and hides the location
pill — that is intended behaviour, not missing data.

Colne stock
-----------
The Epos Now Stock Levels report exposes both CurrentStock (the filtered
location) and TotalStock (all locations). When --colne-stock is not supplied,
Colne stock is derived from the Nelson report as TotalStock - CurrentStock.
The derivation is validated against the Colne warnings export and the match
rate is printed; a poor match rate means you should export Colne directly.
"""

import argparse
import csv
import datetime as _dt
import json
import re
import sys


# --------------------------------------------------------------------------
# CSV helpers
# --------------------------------------------------------------------------

def read_csv(path):
    """Read an Epos Now export. Returns (fieldnames, list-of-dicts)."""
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        return reader.fieldnames, list(reader)


def num(value):
    """Epos Now writes numbers as '0.00000000000'. Return a tidy int."""
    try:
        return int(round(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def warnings_to_csv_text(rows, fieldnames):
    """
    Re-emit a warnings export as compact CSV for embedding.

    Numeric columns are collapsed from '2.00000' to '2' — this is what keeps the
    embedded blocks a sane size. Quoting is left to the csv module so product
    names containing commas or inch marks (e.g. 'FM Girls Blazer 34"') survive.
    """
    numeric = {"CurrentStock", "MinStock", "MaxStock", "OnOrder", "Reorder"}
    out = []
    writer = csv.writer(out.append.__self__ if False else _LineSink(out),
                        lineterminator="\n")
    writer.writerow(fieldnames)
    for row in rows:
        writer.writerow([
            num(row.get(f)) if f in numeric else (row.get(f) or "")
            for f in fieldnames
        ])
    return "".join(out).rstrip("\n")


class _LineSink:
    """Minimal file-like sink so csv.writer can build an in-memory string."""

    def __init__(self, bucket):
        self._bucket = bucket

    def write(self, text):
        self._bucket.append(text)


def stock_map(rows, field="CurrentStock"):
    """barcode -> stock level, skipping rows with no barcode."""
    out = {}
    for row in rows:
        barcode = (row.get("Barcode") or "").strip()
        if barcode:
            out[barcode] = num(row.get(field))
    return out


def derive_colne_stock(nelson_rows):
    """Colne stock = TotalStock - CurrentStock, from the Nelson-filtered report."""
    out = {}
    for row in nelson_rows:
        barcode = (row.get("Barcode") or "").strip()
        if not barcode:
            continue
        derived = num(row.get("TotalStock")) - num(row.get("CurrentStock"))
        out[barcode] = max(derived, 0)
    return out


# --------------------------------------------------------------------------
# Block replacement
# --------------------------------------------------------------------------

def replace_block(html, name, literal, header=None):
    """
    Replace `const <name> = ...;` with `literal`, optionally rewriting the
    `// ===== ... =====` comment directly above it.

    Matches lazily up to the first `;` that ends the declaration. Raises if the
    block is missing rather than appending — a missing block means the file is
    not the shape we think it is, and silently adding one would produce a
    plausible-looking but wrong build.
    """
    pattern = re.compile(
        r"(?P<header>//\s*=====[^\n]*=====\n)?"
        r"(?P<decl>const\s+%s\s*=\s*)(?P<body>.*?)(?P<end>;\s*\n)" % re.escape(name),
        re.S,
    )
    match = pattern.search(html)
    if not match:
        raise SystemExit(
            "error: block '%s' not found in index.html — refusing to guess.\n"
            "       The file layout may have changed; inspect it before rebuilding."
            % name
        )

    head = match.group("header") or ""
    if header is not None:
        head = "// ===== %s =====\n" % header

    return html[:match.start()] + head + match.group("decl") + literal + ";\n" + html[match.end():]


def js_template_literal(text):
    """Embed CSV inside a JS backtick template, escaping what would break it."""
    return "`" + text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${") + "`"


def bump_build_stamp(html):
    """
    Refresh `const BUILD_STAMP = "YYYYMMDD-HHMMSS";`.

    The app polls its own URL on load and on regaining focus, compares this
    value with the served copy, and hard-reloads if they differ. That is the
    only mechanism that updates phones and iOS home-screen installs, which
    otherwise cache index.html indefinitely. A build that does not move the
    stamp deploys correctly and is never seen by staff.
    """
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    html, n = re.subn(r'(const\s+BUILD_STAMP\s*=\s*")[^"]*(")',
                      r"\g<1>%s\g<2>" % stamp, html, count=1)
    if n != 1:
        raise SystemExit("error: BUILD_STAMP not found — phones would not "
                         "pick up this build. Refusing to continue.")
    return html, stamp


def set_build_date(html, stamp_label):
    """
    Refresh `const BUILD_DATE = "D Mon YYYY HH:MM";` — the "data as of" label
    staff actually read in the app.

    Includes the time as well as the date (added 2026-08-17 at the user's
    request). The job runs four times a day and stock moves between slots, so
    a date alone cannot tell staff whether the list in front of them predates
    the pick they just did. Keep the date first so it stays readable at a
    glance; the time is what makes it actionable.

    This is separate from BUILD_STAMP: the stamp drives the auto-updater and is
    not shown anywhere; this string is the human-facing label. On 2026-08-15 a build
    shipped correct 303-row data still labelled "14 Aug 2026", because only the
    stamp was being bumped. A stale date here is worse than a stale stamp —
    staff see a date they trust and assume the picks are yesterday's.
    """
    html, n = re.subn(r'(const\s+BUILD_DATE\s*=\s*")[^"]*(")',
                      r"\g<1>%s\g<2>" % stamp_label, html, count=1)
    if n != 1:
        raise SystemExit("error: BUILD_DATE not found — the app would show a "
                         "stale data date. Refusing to continue.")
    return html


def js_object(mapping, indent=False):
    if indent:
        return json.dumps(mapping, indent=2, ensure_ascii=False)
    return json.dumps(mapping, separators=(",", ":"), ensure_ascii=False)


def existing_block(html, name):
    """
    Pull an existing JS object literal back out, so it can be carried forward.

    These blocks are JavaScript, not JSON: a hand-edited one may carry a
    trailing comma, which json.loads rejects. Strip those before parsing —
    returning {} on a parse failure would silently discard the whole map (and
    e.g. blank every product photo) while still looking like a clean run.
    """
    match = re.search(r"const\s+%s\s*=\s*(\{.*?\});\s*\n" % re.escape(name), html, re.S)
    if not match:
        return {}
    body = re.sub(r",(\s*[}\]])", r"\1", match.group(1))
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise SystemExit(
            "error: could not parse existing %s (%s).\n"
            "       Refusing to continue — proceeding would drop the whole block."
            % (name, exc)
        )


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index", default="index.html")
    ap.add_argument("--colne-warn", required=True,
                    help="Stock Warnings export, Colne (location 32350)")
    ap.add_argument("--nelson-warn",
                    help="Stock Warnings export, Nelson (location 27417)")
    ap.add_argument("--nelson-stock",
                    help="Stock Levels export filtered to Nelson")
    ap.add_argument("--colne-stock",
                    help="Stock Levels export filtered to Colne. Omit to derive "
                         "it from the Nelson report as TotalStock - CurrentStock.")
    ap.add_argument("--images", help="JSON: barcode -> Shopify image URL")
    ap.add_argument("--locations", help="JSON: barcode -> Nelson stockroom location")
    ap.add_argument("--out", help="Output path (defaults to --index, in place)")
    args = ap.parse_args()

    html = open(args.index, encoding="utf-8").read()
    now = _dt.datetime.now()
    # Header comments carry the date only — they are provenance, not a label,
    # and a time there would churn the non-data diff on every same-day rebuild.
    today = now.strftime("%-d %b %Y")
    # BUILD_DATE carries date + time; see set_build_date().
    build_label = now.strftime("%-d %b %Y %H:%M")
    report = []

    # --- forward: Colne warnings -------------------------------------------
    fields, colne_rows = read_csv(args.colne_warn)
    html = replace_block(
        html, "SAMPLE_CSV",
        js_template_literal(warnings_to_csv_text(colne_rows, fields)),
        header="EMBEDDED SAMPLE DATA (from EPOSNow Stock Warnings, Colne location, "
               "%d items, %s)" % (len(colne_rows), today),
    )
    report.append("rows: %d" % len(colne_rows))

    # --- forward: Nelson stock ---------------------------------------------
    nelson_rows = []
    if args.nelson_stock:
        _, nelson_rows = read_csv(args.nelson_stock)
        nelson_map = stock_map(nelson_rows)
        # Keep only barcodes the forward direction can ask about. The full
        # report is ~7,500 rows; embedding all of it would bloat index.html by
        # roughly 100KB for data the app never reads.
        wanted_fwd = {(r.get("Barcode") or "").strip() for r in colne_rows}
        nelson_map = {k: v for k, v in nelson_map.items() if k in wanted_fwd}
        html = replace_block(
            html, "NELSON_STOCK_MAP", js_object(nelson_map),
            header="EMBEDDED NELSON STOCK MAP (barcode -> Current Stock at Nelson, "
                   "from EPOSNow Stock Levels report, %s)" % today,
        )
        covered = sum(1 for r in colne_rows
                      if (r.get("Barcode") or "").strip() in nelson_map)
        pct = 100.0 * covered / len(colne_rows) if colne_rows else 0.0
        report.append("nelson: %d/%d (%.1f%%)" % (covered, len(colne_rows), pct))
        if pct < 90:
            print("warning: Nelson coverage %.1f%% is well below the usual 97-98%%."
                  % pct, file=sys.stderr)

    # --- reverse: Nelson warnings ------------------------------------------
    rev_rows = []
    if args.nelson_warn:
        rev_fields, rev_rows = read_csv(args.nelson_warn)
        html = replace_block(
            html, "SAMPLE_CSV_REV",
            js_template_literal(warnings_to_csv_text(rev_rows, rev_fields)),
        )
        report.append("reverse rows: %d" % len(rev_rows))

    # --- reverse: Colne stock ----------------------------------------------
    colne_map = None
    if args.colne_stock:
        _, colne_stock_rows = read_csv(args.colne_stock)
        colne_map = stock_map(colne_stock_rows)
        report.append("colne stock: exported")
    elif nelson_rows:
        colne_map = derive_colne_stock(nelson_rows)
        # Validate the derivation against the Colne warnings export, which
        # independently reports Colne's CurrentStock for every warned line.
        checked = matched = 0
        for row in colne_rows:
            barcode = (row.get("Barcode") or "").strip()
            if barcode in colne_map:
                checked += 1
                if colne_map[barcode] == num(row.get("CurrentStock")):
                    matched += 1
        if checked:
            rate = 100.0 * matched / checked
            report.append("colne stock: derived, %d/%d exact (%.1f%%)"
                          % (matched, checked, rate))
            if rate < 95:
                print("warning: derived Colne stock matches only %.1f%% of the "
                      "warnings export — export Colne directly instead."
                      % rate, file=sys.stderr)

    if colne_map is not None:
        # Keep only barcodes the reverse direction can actually ask about.
        if rev_rows:
            wanted = {(r.get("Barcode") or "").strip() for r in rev_rows}
            colne_map = {k: v for k, v in colne_map.items() if k in wanted}
        html = replace_block(html, "SRC_STOCK_REV", js_object(colne_map))

    # --- shared: location map ----------------------------------------------
    if args.locations:
        locations = json.load(open(args.locations, encoding="utf-8"))
        merged = {**existing_block(html, "LOCATION_MAP"), **locations}
        html = replace_block(
            html, "LOCATION_MAP", js_object(merged),
            header="EMBEDDED LOCATION MAP (barcode -> location, %d items)" % len(merged),
        )

    # --- shared: image map --------------------------------------------------
    # The header is rewritten on every run, even when no new images are
    # supplied: the resolved count is relative to today's row count, so
    # carrying the old header forward would leave it quietly wrong.
    current = existing_block(html, "IMAGE_MAP")
    new_images = json.load(open(args.images, encoding="utf-8")) if args.images else {}
    added = sum(1 for k in new_images if k not in current)
    merged = {**current, **new_images}   # carry forward, never drop
    if merged:
        resolved = sum(1 for r in colne_rows
                       if (r.get("Barcode") or "").strip() in merged)
        html = replace_block(
            html, "IMAGE_MAP", js_object(merged, indent=True),
            header="EMBEDDED IMAGE MAP (barcode -> Shopify product photo URL, "
                   "%d of %d items resolved)" % (resolved, len(colne_rows)),
        )
        report.append("images +%d" % added)

    html, stamp = bump_build_stamp(html)
    html = set_build_date(html, build_label)
    report.append("stamp %s" % stamp)

    out_path = args.out or args.index
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)

    print("built %s | %s" % (out_path, " | ".join(report)))


if __name__ == "__main__":
    main()
