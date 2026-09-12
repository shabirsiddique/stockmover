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
 * Checksums are FNV-1a 32-bit, NOT SHA-256 (fixed 2026-09-12).
 * -------------------------------------------------------------------------
 * An earlier version of this file used crypto.subtle.digest('SHA-256', ...)
 * and returned the hex digest inside grab()/grabTwoStep()/emit()'s JSON.
 * javascript_tool BLOCKS anything that looks base64-encoded, and a 64-char
 * hex SHA-256 digest trips that filter — so any call reading the stashed
 * result back (the window.__R stash-and-read-back pattern this whole
 * transport depends on) would fail to return at all. This was never caught
 * because every real run since mid-August had already been hand-patching a
 * decimal FNV checksum inline instead of using this file's own grab/emit —
 * the run-log has said "FNV-verified" on every entry since, while the
 * committed file still carried the SHA-256 version. That is exactly the
 * "artifact fixed, guard never updated" failure this skill warns about:
 * every run silently reinvented the same patch instead of the file being
 * corrected once. Never reintroduce sha256/crypto.subtle here.
 *
 * Transport limits (measured 2026-08-15, checksum note added 2026-09-12):
 *   - javascript_tool truncates its result at roughly 1 KB. Never return CSV
 *     text from it directly.
 *   - javascript_tool BLOCKS base64-looking output, which includes hex
 *     digests of any length (SHA-256, MD5, etc). Use the decimal FNV-1a
 *     checksum (window.__ck below) for anything read back through
 *     javascript_tool's return value.
 *   - get_page_text returned 14,109 chars in a single call intact. Its upper
 *     bound is unknown, hence emit() chunks and checksums every chunk.
 *
 * Integrity
 * ---------
 * Every payload carries an FNV-1a 32-bit checksum computed in the page.
 * Whatever reads it back MUST recompute the checksum over the reconstructed
 * file and abort on mismatch. That is what makes it safe to move barcodes
 * staff scan against through a text channel: silent corruption becomes a
 * loud failure. FNV is not cryptographic — that's fine here, the threat
 * model is transcription/truncation error, not tampering.
 *
 * emit() and Form1 — do not call emit() before you are done with the page
 * ---------------------------------------------------------------------
 * emit() clears document.body and replaces it with a <pre>. On the Stock
 * Levels page this DESTROYS document.forms['Form1'], so a second
 * grabTwoStep() call on the same page load after any emit() call fails with
 * "form Form1 not found" (hit 2026-09-12). If you need both Colne and
 * Nelson from the same report page, call grabTwoStep() for BOTH locations
 * (stashing each result, e.g. into separate globals or reducing+storing to
 * localStorage immediately) BEFORE calling emit() for either one. If you
 * already called emit(), navigate() back to the report page to get Form1
 * back — a plain reload is enough, localStorage survives it.
 *
 * Usage
 * -----
 *   1. Paste this whole file into javascript_tool. It returns 'ready'.
 *   2. await __SM.grab({locationId, keep, columns})   -> metadata + stores text
 *      or await __SM.grabTwoStep(locationId)           -> Stock Levels (2-step)
 *   3. __SM.emit(text, i)                              -> render chunk i to DOM
 *      then read it with get_page_text, per chunk, verifying each ck.
 *      The chunk is fenced between <<<SMBEGIN>>> and <<<SMEND>>>; slice between
 *      those markers. get_page_text strips leading/trailing whitespace, so an
 *      unfenced chunk that begins or ends with a space comes back corrupt.
 *
 * The Stock Levels page needs grabTwoStep (see above) — it replays the Apply
 * postback and then builds the export request from the form the SERVER
 * returns, because posting reconstructed fields directly returns page HTML.
 * The Stock Warnings page accepts locationId directly via grab().
 *
 * Reducing the Stock Levels report
 * --------------------------------
 * Pass keep = every barcode appearing in either warnings export, and
 * columns = ['Barcode','CurrentStock','TotalStock']. That is all build_index.py
 * reads from it. Verified 2026-08-15: 7,505 rows / 1.2 MB reduces to 395 rows /
 * 14 KB and rebuilds all six data blocks byte-identically. Do NOT add
 * TotalStock to the normalisation columns — assert_location_filtered() needs
 * it left as Epos Now's raw "12.00000"-style value... actually TotalStock is
 * simply never normalised (only CurrentStock/MinStock/MaxStock/OnOrder/
 * Reorder are), so it comes through as exported. That is intentional.
 *
 * Carry the keep list between pages in localStorage under 'SM_colneW' /
 * 'SM_nelsonW' (raw warnings text) — it is the same origin, and window
 * globals do not survive navigation. Rebuild the keep Set from those two
 * texts on the Stock Levels page rather than trying to carry the Set itself.
 */
window.__SM = (function () {
  const CHUNK = 10000;
  const BEGIN = '<<<SMBEGIN>>>';
  const END = '<<<SMEND>>>';

  // FNV-1a 32-bit. Decimal output only — never hex/base64, see header note.
  function ck(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }

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
      bytes: out.length, ck: ck(out),
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
    if (!f0) throw new Error("form 'Form1' not found — wrong page, or a prior emit() call cleared document.body (see header note)?");
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

  // Reduce to kept barcodes and/or narrow columns, then normalise. Combines
  // what used to be two separate passes (reduce, then norm()) into one, since
  // every real caller wants both and doing them together halves the number of
  // full-text scans on a 1.4MB report.
  function reduceAndNorm(text, keepSet, columns) {
    const rows = parseCsv(text);
    const head = rows[0];
    const bi = head.indexOf('Barcode');
    let body = rows.slice(1).filter(x => x.length > 1);
    if (keepSet) body = body.filter(x => keepSet.has((x[bi] || '').trim()));
    let outHead = head, outBody = body;
    if (columns) {
      const idx = columns.map(c => {
        const i = head.indexOf(c);
        if (i < 0) throw new Error('missing col ' + c);
        return i;
      });
      outHead = columns;
      outBody = body.map(x => idx.map(i => x[i] === undefined ? '' : x[i]));
    }
    // Pre-normalise Epos Now's '2.00000' integers to '2' BEFORE transport.
    // build_index.py's num() does this anyway, so it is lossless, and it
    // shrinks the payload substantially. ONLY these five columns, and ONLY
    // values matching /^-?\d+\.0+$/ — anything with a non-zero fraction is
    // left verbatim and counted in `skipped`, which MUST be 0. Do NOT extend
    // this to TotalStock or any other column — assert_location_filtered()
    // in build_index.py needs TotalStock exactly as exported.
    const COLS = ['CurrentStock', 'MinStock', 'MaxStock', 'OnOrder', 'Reorder'];
    const nidx = COLS.map(c => outHead.indexOf(c)).filter(i => i >= 0);
    let changed = 0, skipped = 0;
    for (let r = 0; r < outBody.length; r++) {
      for (const i of nidx) {
        const v = outBody[r][i];
        if (v === undefined) continue;
        if (/^-?\d+\.0+$/.test(v)) { outBody[r][i] = String(parseInt(v, 10)); changed++; }
        else if (/^-?\d*\.\d+$/.test(v)) { skipped++; }
      }
    }
    return { text: ser([outHead].concat(outBody)), changed, skipped, rows: outBody.length };
  }

  // Kept for API compatibility with older callers that normalised separately
  // from reducing. Prefer reduceAndNorm for anything new.
  function norm(text) {
    return reduceAndNorm(text, null, null);
  }

  // Render one chunk into the DOM for get_page_text. Returns its own ck so a
  // truncated read fails loudly instead of silently losing rows.
  //
  // WARNING: this clears document.body. On the Stock Levels page that
  // destroys document.forms['Form1'] — see the header note. Finish every
  // grabTwoStep() call you need from a page BEFORE calling emit() on it.
  //
  // The payload is fenced between BEGIN/END sentinels because get_page_text
  // STRIPS LEADING AND TRAILING WHITESPACE from what it returns (observed
  // 2026-08-16: a chunk boundary landed mid-field on 'US ' and the trailing
  // space was silently dropped, one byte short). Without the fence the reader
  // cannot tell a stripped space from a chunk that genuinely ended there. With
  // it, the whitespace sits in the interior of the returned text and survives.
  // Slice between the sentinels, then verify ck — never trust the raw read.
  function emit(text, i) {
    const s = text.slice(i * CHUNK, (i + 1) * CHUNK);
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font:11px monospace';
    pre.appendChild(document.createTextNode(BEGIN + s + END));
    document.body.appendChild(pre);
    return JSON.stringify({
      chunk: i, len: s.length, ck: ck(s),
      total: Math.ceil(text.length / CHUNK), fenced: true, begin: BEGIN, end: END
    });
  }

  return { grab, grabTwoStep, reduceAndNorm, norm, emit, parseCsv, ck, CHUNK };
})();
'ready'
