/*
 * tests_zero_stock_filter.js — the Nelson>Colne pick list must only contain
 * items Nelson can actually spare.
 *
 * History (both 2026-09-16, same day, two passes by the user):
 *   pass 1  hide source stock <= 0  — the shelf is empty, the walk is wasted.
 *           80 of 172 forward rows.
 *   pass 2  ALSO hide source stock == 1 — "where it shows 1 left in nelson dont
 *           show that either". Moving the last one does not fix a shortage, it
 *           relocates it. A further 43 rows; 172 -> 49 on the day.
 * Expressed as minSourceStock = 2 rather than two separate booleans, so the
 * threshold is one number to change and the reverse direction can be switched
 * on by replacing null with a number.
 *
 * THE UNKNOWN CASE IS LOAD-BEARING. A barcode absent from the stock map gives
 * null and MUST still be shown. "We have no figure" is not "there are none";
 * treating them alike would silently shrink the list wherever the stock report
 * has a coverage gap, and that failure is invisible — the row just is not there.
 */
function buildItems(rows, dir) {
  return rows
    .map(r => ({
      name: r.name,
      barcode: r.barcode,
      nelsonStock: dir.stock[r.barcode] !== undefined ? dir.stock[r.barcode] : null,
    }))
    .filter(it => dir.minSourceStock == null || it.nelsonStock === null || it.nelsonStock >= dir.minSourceStock);
}

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failures++; console.log('FAIL  ' + label + '\n  got  ' + JSON.stringify(got) + '\n  want ' + JSON.stringify(want)); }
  else console.log('ok    ' + label);
}

const rows = [
  { name: 'plenty',           barcode: 'A' },   // 3
  { name: 'exactly two',      barcode: 'E' },   // 2  <- boundary, must be KEPT
  { name: 'last one left',    barcode: 'F' },   // 1  <- boundary, must be HIDDEN
  { name: 'zero at source',   barcode: 'B' },   // 0
  { name: 'negative',         barcode: 'C' },   // -1
  { name: 'not in stock map', barcode: 'D' },   // absent -> null
];
const stock = { A: 3, E: 2, F: 1, B: 0, C: -1 };

const fwd = { stock, minSourceStock: 2 };
check('forward keeps only what the source can spare',
      buildItems(rows, fwd).map(i => i.barcode), ['A', 'E', 'D']);

check('boundary: exactly 2 is KEPT',
      buildItems([{ name: 'e', barcode: 'E' }], fwd).length, 1);

check('boundary: exactly 1 is HIDDEN (would strip the source to nil)',
      buildItems([{ name: 'f', barcode: 'F' }], fwd).length, 0);

check('zero is hidden', buildItems([{ name: 'b', barcode: 'B' }], fwd).length, 0);
check('negative is hidden', buildItems([{ name: 'c', barcode: 'C' }], fwd).length, 0);

check('an unknown stock figure is NOT treated as none',
      buildItems([{ name: 'd', barcode: 'D' }], fwd).length, 1);

const rev = { stock, minSourceStock: null };
check('reverse is unfiltered — every row survives',
      buildItems(rows, rev).map(i => i.barcode), ['A', 'E', 'F', 'B', 'C', 'D']);

check('a list with nothing sparable comes back empty, not throwing',
      buildItems([{ name: 'f', barcode: 'F' }, { name: 'b', barcode: 'B' }], fwd), []);

const strict = { stock, minSourceStock: 3 };
check('the threshold is a real number, not a hardcoded 2',
      buildItems(rows, strict).map(i => i.barcode), ['A', 'D']);

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall passed');
process.exit(failures ? 1 : 0);
