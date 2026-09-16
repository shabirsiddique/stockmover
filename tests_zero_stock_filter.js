/*
 * tests_zero_stock_filter.js — the Nelson>Colne pick list must not contain
 * items Nelson has none of.
 *
 * Added 2026-09-16. The Colne stock-warnings report says Colne is LOW on
 * something; it says nothing about whether Nelson can supply it. On the day
 * this was added, 80 of 172 forward rows (47%) had Nelson stock 0 or less —
 * every one of those sent a picker to an empty shelf.
 *
 * The rule, exactly: hide when we HAVE a source-stock figure and it is <= 0.
 * A barcode absent from the stock map yields null and MUST still be shown —
 * "we don't know" is not "there are none", and silently hiding unknowns would
 * quietly shrink the list as coverage gaps appear.
 *
 * Colne>Nelson is deliberately NOT filtered (user's decision, 16 Sep). If that
 * changes, flip hideZeroSource in DIRECTIONS and the last case here should be
 * updated to match.
 */
function buildItems(rows, dir) {
  return rows
    .map(r => ({
      name: r.name,
      barcode: r.barcode,
      nelsonStock: dir.stock[r.barcode] !== undefined ? dir.stock[r.barcode] : null,
    }))
    .filter(it => !dir.hideZeroSource || it.nelsonStock === null || it.nelsonStock > 0);
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log('FAIL  ' + label + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  else console.log('ok    ' + label);
}

const rows = [
  { name: 'has stock',        barcode: 'A' },
  { name: 'zero at source',   barcode: 'B' },
  { name: 'negative',         barcode: 'C' },
  { name: 'not in stock map', barcode: 'D' },
];
const stock = { A: 3, B: 0, C: -1 };   // D deliberately absent

const fwd = { stock, hideZeroSource: true };
check('forward keeps only pickable rows',
      buildItems(rows, fwd).map(i => i.barcode), ['A', 'D']);

check('forward: an unknown stock figure is NOT treated as zero',
      buildItems([{ name: 'unknown', barcode: 'D' }], fwd).length, 1);

check('forward: negative stock is hidden like zero',
      buildItems([{ name: 'neg', barcode: 'C' }], fwd).length, 0);

const rev = { stock, hideZeroSource: false };
check('reverse is untouched — every row survives',
      buildItems(rows, rev).map(i => i.barcode), ['A', 'B', 'C', 'D']);

check('a list that is entirely zero-stock comes back empty, not crashing',
      buildItems([{ name: 'z', barcode: 'B' }], fwd), []);

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall passed');
process.exit(failures ? 1 : 0);
