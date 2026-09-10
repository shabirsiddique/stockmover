/*
 * browser_export.js — pull Epos Now report CSVs out of the page, with no
 * dependency on the ~/Downloads folder mount.
 *
 * Why this exists
 * ---------------
 * The normal route is: click "Export to .csv", let Chrome save the file to
 * ~/Downloads, read it from the sandbox mount. That works, but the mount needs
 * the user to approve the folder, which a scheduled run cannot do on its own.
 *
 * This module fetches the same CSV via the report's own authenticated form
 * POST, optionally reduces it, and renders it into the DOM so it can be read
 * back with get_page_text. Nothing touches the filesystem.
 *
 * Transport limits (measured 2026-08-15):
 *   - javascript_tool truncates its result at roughly 1 KB. Never return CSV
 *     text from it directly.
 *   - javascript_tool BLOCKS base64-looking output entirely, so gzip+base64 is
 *     not an option however small it compresses to.
 *   - get_page_text returned 14,109 chars in a single call intact. Its upper
 *     bound is unknown, hence emit() chunks and checksums every chunk.
 *
 * Integrity
 * ---------
 * Every payload carries a SHA-256 computed in the page. Whatever reads it back
 * MUST recompute the hash over the reconstructed file and abort on mismatch.
 * That is what makes it safe to move barcodes staff scan against through a
 * text channel: silent corruption becomes a loud failure.
 *
 * Usage
 * -----
 *   1. Paste this whole file into javascript_tool. It returns 'ready'.
 *   2. await __SM.grab({locationId, keep, columns})   -> metadata + stores text
 *   3. __SM.emit(i)                                   -> render chunk i to DOM
 *      then read it with get_page_text, per chunk, verifying each sha.
 *      The chunk is fenced between <<<SMBEGIN>>> and <<<SMEND>>>; slice between
 *      those markers. get_page_text strips leading/trailing whitespace, so an
 *      unfenced chunk that begins or ends with a space comes back corrupt.
 *
 * The Stock Levels page ignores locationId in the FormData — you must set the
 * dropdown and click Apply on the live page first, then grab() with no
 * locationId. The Stock Warnings page accepts locationId directly.
 *
 * Reducing the Stock Levels report
 * --------------------------------
 * Pass keep = every barcode appearing in either warnings export, and
 * columns = ['Barcode','CurrentStock','TotalStock']. That is all build_index.py
 * reads from it. Verified 2026-08-15: 7,505 rows / 1.2 MB reduces to 395 rows /
 * 14 KB and rebuilds all six data blocks byte-identically.
 *
 * Carry the keep list between pages in localStorage under 'SM_KEEP' — it is the
 * same origin, and window globals do not survive navigation.
 */
window.__SM = (function () {
  const CHUNK = 10000;
  const BEGIN = '<<<SMBEGIN>>>';
  const END = '<<<SMEND>>>';

  function parseCsv(t) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) {
        if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  const esc = v => /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const ser = rows => rows.map(r => r.map(esc).join(',')).join('\n') + '\n';

  async function sha256(s) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function grab(opts) {
    opts = opts || {};
    const btn = document.getElementsByName('ctl00$MainContent$ExportButtons$ExportCSVButton')[0];
    if (!btn) throw new Error('export button not found — wrong page?');
    const f = btn.form;                    // NOT document.forms[0] — that is the site search
    const fd = new FormData(f);
    if (opts.locationId) fd.set('ctl00$MainContent$filterControl$ddlLocations', opts.locationId);
    fd.append(btn.name, btn.value);
    const r = await fetch(f.action || location.href, {
      method: 'POST', body: new URLSearchParams([...fd]), credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    let t = await r.text();
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);      // strip BOM before the CSV check
    if (t.slice(0, 5) !== 'Name,') {
      throw new Error('not CSV: status ' + r.status + ' body=' + JSON.stringify(t.slice(0, 120)));
    }
    const rows = parseCsv(t);
    const head = rows[0], body = rows.slice(1).filter(x => x.length > 1);
    let outHead = head, outBody = body;
    if (opts.keep) {
      const bi = head.indexOf('Barcode');
      if (bi < 0) throw new Error('no Barcode column');
      const keep = new Set(opts.keep);
      outBody = outBody.filter(x => keep.has((x[bi] || '').trim()));
    }
    if (opts.columns) {
      const idx = opts.columns.map(c => {
        const i = head.indexOf(c);
        if (i < 0) throw new Error('missing column ' + c);
        return i;
      });
      outHead = opts.columns;
      outBody = outBody.map(x => idx.map(i => x[i] === undefined ? '' : x[i]));
    }
    const out = ser([outHead].concat(outBody));
    window.__SM_TEXT = out;
    return JSON.stringify({
      status: r.status, fullRows: body.length, outRows: outBody.length,
      bytes: out.length, sha256: await sha256(out),
      chunks: Math.ceil(out.length / CHUNK)
    });
  }

  // Stock Levels needs a TWO-STEP replay: post the Apply postback, then build
  // the export request from the form the SERVER returns (its viewstate already
  // has the location applied). Posting reconstructed fields returns page HTML.
  //
  // CRITICAL — VERIFY THE APPLIED LOCATION BEFORE EXPORTING. The filter
  // silently resets to "All Locations" (24 Aug, 26 Aug, 10 Sep 2026). The CSV
  // that comes back looks perfectly normal but every CurrentStock is the
  // company-wide total, which credits one store with both stores' stock. On
  // 10 Sep that got as far as a built index.html and was caught only by eye.
  // The returned form carries the location the server actually applied, so
  // read it back and refuse to export if it is not the one asked for — exact,
  // not a heuristic. Then check the data too, in case the form ever lies.
  // Covered by tests_location_filter.js.
  async function grabTwoStep(locationId, opts) {
    opts = opts || {};
    const post = async (body) => fetch(location.href, {
      method: 'POST', body: new URLSearchParams([...body]), credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const f0 = document.forms['Form1'];   // NOT 'aspnetForm' — that does not exist
    if (!f0) throw new Error("form 'Form1' not found — wrong page?");
    const fd0 = new FormData(f0);
    fd0.set('ctl00$MainContent$filterControl$ddlLocations', locationId);
    fd0.append('ctl00$MainContent$FetchFromServer', 'Apply');
    const r1 = await post(fd0);
    const doc = new DOMParser().parseFromString(await r1.text(), 'text/html');
    const f1 = doc.forms['Form1'];
    if (!f1) throw new Error('no Form1 in apply response ' + r1.status);

    const sel = f1.querySelector('select[name*="ddlLocations"]');
    const applied = sel ? sel.value : null;
    if (applied !== locationId) {
      throw new Error('LOCATION NOT APPLIED: asked for ' + locationId +
        ', server returned ' + JSON.stringify(applied) + '. Refusing to export — ' +
        'this is how an All-Locations report gets mistaken for a single store.');
    }

    const eb = f1.querySelector('input[name*="ExportCSVButton"]');
    if (!eb) throw new Error('no export button in apply response');
    const fd1 = new FormData(f1);
    fd1.append(eb.name, eb.value);
    const r2 = await post(fd1);
    let t = await r2.text();
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    if (t.slice(0, 5) !== 'Name,') {
      throw new Error('not CSV: status ' + r2.status + ' body=' + JSON.stringify(t.slice(0, 120)));
    }
    // Independent data-side check: an All-Locations export has
    // CurrentStock == TotalStock on every row. Genuine single-location exports
    // measured 55-65% equal (10 Sep 2026).
    const rows = parseCsv(t);
    const head = rows[0];
    const ci = head.indexOf('CurrentStock'), ti = head.indexOf('TotalStock');
    let equal = 0, n = 0;
    if (ci >= 0 && ti >= 0) {
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].length <= Math.max(ci, ti)) continue;
        n++;
        if (parseFloat(rows[i][ci] || '0') === parseFloat(rows[i][ti] || '0')) equal++;
      }
    }
    const pctEqual = n ? 100 * equal / n : 0;
    if (n >= 50 && pctEqual >= 95 && !opts.allowUnfiltered) {
      throw new Error('export for ' + locationId + ' looks like ALL LOCATIONS: ' +
        'CurrentStock == TotalStock on ' + pctEqual.toFixed(1) + '% of ' + n +
        ' rows (expect 55-65%). Refusing.');
    }
    window.__SM_RAW = t;
    return JSON.stringify({
      location: locationId, applied: applied, status: r2.status,
      rows: n, pctEqual: +pctEqual.toFixed(1), bytes: t.length
    });
  }

  // Render one chunk into the DOM for get_page_text. Returns its own sha so a
  // truncated read fails loudly instead of silently losing rows.
  //
  // The payload is fenced between BEGIN/END sentinels because get_page_text
  // STRIPS LEADING AND TRAILING WHITESPACE from what it returns (observed
  // 2026-08-16: a chunk boundary landed mid-field on 'US ' and the trailing
  // space was silently dropped, one byte short). Without the fence the reader
  // cannot tell a stripped space from a chunk that genuinely ended there. With
  // it, the whitespace sits in the interior of the returned text and survives.
  // Slice between the sentinels, then verify sha256 — never trust the raw read.
  async function emit(i) {
    const s = window.__SM_TEXT.slice(i * CHUNK, (i + 1) * CHUNK);
    const pre = document.createElement('pre');
    pre.id = 'smout';
    pre.textContent = BEGIN + s + END;
    document.body.innerHTML = '';
    document.body.appendChild(pre);
    return JSON.stringify({
      chunk: i, len: s.length, sha256: await sha256(s),
      fenced: true, begin: BEGIN, end: END
    });
  }


  // --- __SM_NORM__ ---------------------------------------------------------
  // Pre-normalise Epos Now's '2.00000' integers to '2' BEFORE transport.
  // build_index.py's num() does this anyway, so it is lossless, and it shrinks
  // the payload by roughly a third (measured 2026-08-22: Colne warnings
  // 28,334 -> 20,594 bytes, Nelson 12,298 -> 8,914). ONLY these five columns,
  // and ONLY values matching /^-?\d+\.0+$/ — anything with a non-zero
  // fraction is left verbatim and counted in `skipped`, which MUST be 0.
  // Do not extend this to TotalStock or any other column.
  function norm(text) {
    const COLS = ['CurrentStock','MinStock','MaxStock','OnOrder','Reorder'];
    const rows = parseCsv(text);
    const head = rows[0];
    const idx = COLS.map(c => head.indexOf(c)).filter(i => i >= 0);
    let changed = 0, skipped = 0;
    for (let r = 1; r < rows.length; r++) {
      for (const i of idx) {
        const v = rows[r][i];
        if (v === undefined) continue;
        if (/^-?\d+\.0+$/.test(v)) { rows[r][i] = String(parseInt(v, 10)); changed++; }
        else if (/^-?\d*\.\d+$/.test(v)) { skipped++; }
      }
    }
    return { text: ser(rows), changed, skipped };
  }

  return { grab, grabTwoStep, emit, parseCsv, sha256, norm, CHUNK };
})();
'ready'
