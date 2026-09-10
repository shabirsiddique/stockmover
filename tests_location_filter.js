// tests_location_filter.js — guards against the All-Locations export trap.
//
// Epos Now's Stock Levels location filter silently resets to "All Locations"
// (24 Aug, 26 Aug, 10 Sep 2026). The CSV looks normal but every CurrentStock is
// the company-wide total, which credits one store with both stores' stock and
// sends staff hunting for items that are not there. On 10 Sep 2026 a bad export
// reached the build step and was caught only by eye.
//
// browser_export.js now refuses such an export two independent ways:
//   1. the location the SERVER says it applied must match the one requested
//   2. the data itself must not be ~100% CurrentStock == TotalStock
//      (genuine single-location exports measured 55-65% equal on 10 Sep)
//
// Run:  node tests_location_filter.js     (exit 0 = all pass)

const fs = require('fs');
const path = require('path');
global.crypto = require('crypto').webcrypto;

function mkCsv(nrows, allLocations) {
  let out = 'Name,Barcode,CurrentStock,TotalStock\n';
  for (let i = 0; i < nrows; i++) {
    const c = i % 20;
    const t = allLocations ? c : (i % 3 === 0 ? c : c + 1 + (i % 5));
    out += 'Item ' + i + ',10000000' + String(i).padStart(3, '0') + ',' + c + ',' + t + '\n';
  }
  return out;
}
function makeForm(locValue) {
  return {
    querySelector(sel) {
      if (sel.includes('ddlLocations')) return { value: locValue };
      if (sel.includes('ExportCSVButton'))
        return { name: 'ctl00$MainContent$ExportButtons$ExportCSVButton', value: 'Export' };
      return null;
    }
  };
}

global.FormData = class {
  constructor() { this._ = []; }
  set(k, v) { this._.push([k, v]); }
  append(k, v) { this._.push([k, v]); }
  [Symbol.iterator]() { return this._[Symbol.iterator](); }
};
global.URLSearchParams = class { constructor(p) { this.pairs = p; } };
global.DOMParser = class { parseFromString() { return { forms: { Form1: global.__NEXT_FORM } }; } };
global.location = { href: 'https://www.eposnowhq.com/Pages/Reporting/StockReport.aspx' };
global.document = { forms: { Form1: makeForm('27417') } };
global.window = {};

let step = 0;
global.fetch = async () => {
  step++;
  if (step % 2 === 1) return { status: 200, text: async () => '<html/>' };
  return { status: 200, text: async () => global.__CSV };
};

eval(fs.readFileSync(path.join(__dirname, 'browser_export.js'), 'utf8'));
const SM = global.window.__SM;

let failures = 0;
function report(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

(async () => {
  // 1. Happy path: server applies the requested location, data is filtered.
  global.__NEXT_FORM = makeForm('27417'); global.__CSV = mkCsv(300, false); step = 0;
  try {
    const r = JSON.parse(await SM.grabTwoStep('27417'));
    report('genuine single-location export is accepted',
           r.applied === '27417' && r.pctEqual < 95, 'pctEqual=' + r.pctEqual);
  } catch (e) { report('genuine single-location export is accepted', false, e.message); }

  // 2. Filter reset: the server hands back All Locations.
  global.__NEXT_FORM = makeForm(''); global.__CSV = mkCsv(300, true); step = 0;
  try {
    await SM.grabTwoStep('27417');
    report('filter reset is refused', false, 'export was allowed through');
  } catch (e) { report('filter reset is refused', /LOCATION NOT APPLIED/.test(e.message)); }

  // 3. Form reports the right location but the DATA is all-locations. The
  //    server-side check cannot see this; the data check must.
  global.__NEXT_FORM = makeForm('27417'); global.__CSV = mkCsv(300, true); step = 0;
  try {
    await SM.grabTwoStep('27417');
    report('all-locations DATA is refused even when the form looks right', false,
           'export was allowed through');
  } catch (e) {
    report('all-locations DATA is refused even when the form looks right',
           /ALL LOCATIONS/.test(e.message));
  }

  // 4. Below the row floor the data check must stay quiet — a tiny report is
  //    legitimately near-100% equal and must not be blocked.
  global.__NEXT_FORM = makeForm('27417'); global.__CSV = mkCsv(20, true); step = 0;
  try {
    const r = JSON.parse(await SM.grabTwoStep('27417'));
    report('small report below the row floor is not blocked', r.rows === 20);
  } catch (e) { report('small report below the row floor is not blocked', false, e.message); }

  console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
