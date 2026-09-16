/*
 * tests_capped_need.js — the quantity on screen must never strip the source.
 *
 * Why this exists (production bug, 2026-09-16)
 * -------------------------------------------
 * minSourceStock hid items the source could not supply, and was believed to
 * implement "never leave Nelson empty". It did not. It gated WHETHER a row
 * appeared; it never touched the QUANTITY on that row. So an item with 2 at
 * Nelson and a Reorder of 2 passed the filter and then told the picker to take
 * both. The user caught it in the shop: "the 38 blazer was transferred within
 * the last hour... anything we've one left in Nelson you should not have taken
 * out." 6 of 36 live rows were affected, two asking for more than the source
 * held at all.
 *
 * The lesson worth keeping: a guard that controls admission is not the same as
 * a guard that controls the instruction. Check the number the human acts on.
 */
function cappedNeed(need, sourceStock, minSourceStock) {
  if (minSourceStock == null || sourceStock === null) return need;
  const sparable = sourceStock - (minSourceStock - 1);
  return Math.max(1, Math.min(need, sparable));
}

let failures = 0;
function check(label, got, want) {
  if (got !== want) { failures++; console.log('FAIL  ' + label + '  got ' + got + ' want ' + want); }
  else console.log('ok    ' + label + '  -> ' + got);
}

// The two real rows that exposed the bug.
check('CPA Boys Blazer 38: Nelson 2, Colne needs 2 -> take 1', cappedNeed(2, 2, 2), 1);
check('Fishermore Jumper 34": Nelson 2, needs 2 -> take 1',    cappedNeed(2, 2, 2), 1);
// Worse cases from the same list: asking for more than the source holds.
check('CPA Tie Draco-Red: Nelson 2, needs 3 -> take 1',        cappedNeed(3, 2, 2), 1);
check('Fishermore Tie St Andrew: Nelson 3, needs 5 -> take 2', cappedNeed(5, 3, 2), 2);

// Plenty in stock: the requirement is untouched.
check('Nelson 10, needs 3 -> take 3 (no cap applied)',         cappedNeed(3, 10, 2), 3);
check('Nelson 4, needs 3 -> take 3, leaves 1',                 cappedNeed(3, 4, 2), 3);
check('Nelson 3, needs 3 -> take 2, leaves 1',                 cappedNeed(3, 3, 2), 2);

// Never returns 0 — the row only exists because something was sparable.
check('Nelson 2, needs 1 -> take 1',                           cappedNeed(1, 2, 2), 1);

// Unknown source stock: do not invent a cap.
check('unknown source stock -> requirement passes through',    cappedNeed(4, null, 2), 4);
// Unfiltered direction (Colne>Nelson today): no cap at all.
check('minSourceStock null -> requirement passes through',     cappedNeed(4, 1, null), 4);

// The reserve tracks minSourceStock rather than being hardcoded to 1.
check('minSourceStock 3 keeps 2 back: Nelson 5, needs 9 -> 3', cappedNeed(9, 5, 3), 3);
check('minSourceStock 1 keeps 0 back: Nelson 2, needs 9 -> 2', cappedNeed(9, 2, 1), 2);

// Invariant sweep: across a wide range, taking `need` must never drop the
// source below minSourceStock-1, and must never exceed what was asked for.
let violations = 0;
for (let stock = 2; stock <= 30; stock++) {
  for (let want = 1; want <= 30; want++) {
    const take = cappedNeed(want, stock, 2);
    if (stock - take < 1) violations++;
    if (take > want) violations++;
    if (take < 1) violations++;
  }
}
check('invariant sweep (841 combinations): no violations', violations, 0);

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall passed');
process.exit(failures ? 1 : 0);
