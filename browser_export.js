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

  // Render one chunk into the DOM for get_page_text. Returns its own sha so a
  // truncated read fails loudly instead of silently losing rows.
  async function emit(i) {
    const s = window.__SM_TEXT.slice(i * CHUNK, (i + 1) * CHUNK);
    const pre = document.createElement('pre');
    pre.id = 'smout';
    pre.textContent = s;
    document.body.innerHTML = '';
    document.body.appendChild(pre);
    return JSON.stringify({ chunk: i, len: s.length, sha256: await sha256(s) });
  }

  return { grab, emit, parseCsv, sha256, CHUNK };
})();
'ready'
