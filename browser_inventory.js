/*
 * browser_inventory.js — Stock Mover's data source since 23 Oct 2026.
 *
 * Paste into a javascript_tool call on a tab at
 *   https://products.eposnowhq.com/stockmanagement
 * (Epos Now Products -> Stock Management; needs the user's Epos Now sign-in on
 * login.eposnowhq.com — never sign in for them).
 *
 * WHY THIS REPLACED THE STOCK WARNINGS REPORT
 * -------------------------------------------
 * 1. Purchase orders. Epos Now's Stock Warnings report deducts stock ON ORDER
 *    before deciding an item is short, so anything with an open purchase order
 *    silently drops off. On 23 Oct 2026 every black FM 1/4 Zip Top size except
 *    26/28 vanished that way (Colne 0 in stock, min 2, 2-5 "on order" from a stale
 *    PO). The user asked for purchase orders to be ignored on every item.
 * 2. Overstock. The reports only carry min/max for lines already below minimum,
 *    so they can never say what Colne holds ABOVE its max. The inventory API
 *    carries CurrentStock, OnOrder, MinimumStock and MaximumStock for every
 *    product at every location.
 *
 * Endpoint: GET https://api.eposnowhq.com/api/v4/inventory/stocks
 *             ?page=N&limit=500&locationId=<32350 Colne | 27417 Nelson>
 *   Authorization: Bearer <access_token from GET /tokens on products.eposnowhq.com>
 *   -> { Data: [ {ProductId, ProductName, CategoryName, BrandName, SupplierName,
 *                 Barcode, CurrentStock, OnOrder, MinimumStock, MaximumStock,
 *                 StockWarning, ...} ], Metadata: {TotalPages, TotalRecords} }
 * The token stays in the page (window.__TK). NEVER print, log or return it.
 *
 * RULES (validated 23 Oct 2026 against the Stock Warnings report: Nelson 140/140
 * identical; Colne 268 vs 269, the one extra being a genuine short line the
 * report itself missed)
 *   below min  : CurrentStock < MinimumStock  (includes negatives at min 0, as
 *                Epos Now does). OnOrder is IGNORED.
 *                Reorder = max(MaximumStock, MinimumStock) - CurrentStock.
 *   overstock  : MaximumStock > 0 and CurrentStock > MaximumStock (Colne).
 *                Reorder (excess) = CurrentStock - MaximumStock.
 *   Join the two locations by ProductId, not barcode: Colne has 19 duplicated
 *   barcodes (Gola shoe ranges); ProductId is unique.
 *
 * Usage (each line its own javascript_tool call; results are stashed on window
 * because javascript_tool returns {} for async values):
 *   1. paste this file                       -> 'ready'
 *   2. __SMI.fetchAll()  then read __IR      -> {"32350":~9061,"27417":~7406}
 *   3. __SMI.build()                         -> lengths + FNV checks of each output
 *   4. __SMI.diffAgainst(window.__MH2)       -> line-diff vs previous colneW/nelsonW
 *      (__MH2 = {colneW:[fnv per line], nelsonW:[...]}, injected from the container)
 *   5. __SMI.emit(i) + get_page_text, i = 0..chunks-1 (14,000 chars, fenced)
 * Outputs (window.__OUT): colneW, nelsonW (warnings-shaped CSV), nelMap, colMap
 * (JSON barcode->CurrentStock of the OTHER shop), over (OVERSTOCK_CSV shape).
 */
window.__SMI = (function () {
  const ck = s => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
  const esc = v => { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const ser = rows => rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
  const n = x => Math.round(+x || 0);
  const COLNE = '32350', NELSON = '27417';

  function fetchAll() {
    window.__INV = {}; window.__IR = 'pending';
    (async () => {
      try {
        const tj = await (await fetch('/tokens', { credentials: 'include' })).json();
        window.__TK = tj;                       // keep in page; never return it
        const tok = tj.access_token;
        if (!tok) throw new Error('no access_token from /tokens - signed in to Products?');
        const out = {};
        for (const loc of [COLNE, NELSON]) {
          let page = 1, tp = 1, all = [];
          do {
            const r = await fetch(`https://api.eposnowhq.com/api/v4/inventory/stocks?page=${page}&limit=500&locationId=${loc}`,
              { headers: { Authorization: 'Bearer ' + tok } });
            if (r.status !== 200) throw new Error('inventory status ' + r.status + ' page ' + page + ' loc ' + loc);
            const j = await r.json();
            all = all.concat(j.Data); tp = j.Metadata.TotalPages; page++;
          } while (page <= tp);
          window.__INV[loc] = all; out[loc] = all.length;
        }
        window.__IR = JSON.stringify(out);
      } catch (e) { window.__IR = 'ERR ' + e.message; }
    })();
    return 'started';
  }

  function build() {
    const C = window.__INV[COLNE], N = window.__INV[NELSON];
    const byId = A => { const m = new Map(); for (const p of A) m.set(p.ProductId, p); return m; };
    const Cid = byId(C), Nid = byId(N);
    const low = p => n(p.CurrentStock) < n(p.MinimumStock);
    const H = ['Name', 'Barcode', 'Category', 'Brand', 'Supplier', 'CurrentStock', 'MinStock', 'MaxStock', 'OnOrder', 'Reorder'];
    const row = p => [p.ProductName.trim(), (p.Barcode || '').trim(), p.CategoryName || '', p.BrandName || '', p.SupplierName || '',
      n(p.CurrentStock), n(p.MinimumStock), n(p.MaximumStock), n(p.OnOrder),
      Math.max(n(p.MaximumStock), n(p.MinimumStock)) - n(p.CurrentStock)];
    const mapOther = (A, other) => { const m = {}; for (const p of A.filter(low)) { const o = other.get(p.ProductId); if (o) m[(p.Barcode || '').trim()] = n(o.CurrentStock); } return m; };
    const OH = ['Name', 'Barcode', 'Category', 'Brand', 'Supplier', 'CurrentStock', 'SourceStock', 'SourceMax', 'DestMin', 'DestMax', 'Reorder'];
    // over(A, otherById): A's lines above their max, with the other shop's
    // stock and (where it has a max) its min/max as the "required" figure.
    const over = (A, Oid) => A.filter(p => n(p.MaximumStock) > 0 && n(p.CurrentStock) > n(p.MaximumStock)).map(p => {
      const o = Oid.get(p.ProductId);
      const hasRange = o && n(o.MaximumStock) > 0;
      return [p.ProductName.trim(), (p.Barcode || '').trim(), p.CategoryName || '', p.BrandName || '', p.SupplierName || '',
        o ? n(o.CurrentStock) : '', n(p.CurrentStock), n(p.MaximumStock),
        hasRange ? n(o.MinimumStock) : '', hasRange ? n(o.MaximumStock) : '',
        n(p.CurrentStock) - n(p.MaximumStock)];
    });
    const ov = over(C, Nid), ovRev = over(N, Cid);
    window.__OUT = {
      colneW: ser([H].concat(C.filter(low).map(row))),
      nelsonW: ser([H].concat(N.filter(low).map(row))),
      nelMap: JSON.stringify(mapOther(C, Nid)),
      colMap: JSON.stringify(mapOther(N, Cid)),
      over: ser([OH].concat(ov)),
      overRev: ser([OH].concat(ovRev)),   // Nelson above max -> send to Colne (23 Oct 2026)
    };
    return JSON.stringify(Object.fromEntries(Object.entries(window.__OUT).map(([k, v]) => [k, [v.length, ck(v)]])));
  }

  function diff(t, H) {
    const L = t.split('\n'), m = new Map();
    H.forEach((h, i) => { if (!m.has(h)) m.set(h, []); m.get(h).push(i); });
    const used = new Set(), tok = [], nw = [];
    for (const l of L) { const c = (m.get(ck(l)) || []).find(i => !used.has(i)); if (c !== undefined) { used.add(c); tok.push(c); } else { tok.push('N' + nw.length); nw.push(l); } }
    const out = []; let i = 0;
    while (i < tok.length) {
      if (typeof tok[i] === 'number') { let j = i; while (j + 1 < tok.length && typeof tok[j + 1] === 'number' && tok[j + 1] === tok[j] + 1) j++; out.push(j > i ? tok[i] + '-' + tok[j] : String(tok[i])); i = j + 1; }
      else { out.push(tok[i]); i++; }
    }
    return { runs: out.join(','), lines: nw };
  }

  function diffAgainst(MH) {
    const O = window.__OUT;
    const P = { colneW: MH ? diff(O.colneW, MH.colneW) : O.colneW, nelsonW: MH ? diff(O.nelsonW, MH.nelsonW) : O.nelsonW,
      nelMap: O.nelMap, colMap: O.colMap,
      over: (MH && MH.over) ? diff(O.over, MH.over) : O.over, overRev: O.overRev };
    window.__ALL = JSON.stringify(P);
    return 'total ' + window.__ALL.length + ' ck ' + ck(window.__ALL) + ' chunks ' + Math.ceil(window.__ALL.length / 14000);
  }

  // Clears the page body (fine on the Products SPA tab; reload it afterwards).
  function emit(i) {
    const s = window.__ALL.slice(i * 14000, (i + 1) * 14000);
    document.body.innerHTML = '';
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all';
    pre.textContent = '<<<SMBEGIN>>>' + s + '<<<SMEND>>>';
    document.body.appendChild(pre);
    return i + ':' + s.length + ':' + ck(s);
  }

  return { fetchAll, build, diffAgainst, emit, ck };
})();
'ready'
