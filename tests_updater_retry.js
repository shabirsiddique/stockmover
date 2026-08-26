// Simulate: app at OLD stamp, server says NEW, but the first reload lands on a
// stale edge copy (still OLD). How many chances does the app get to recover?
function mkStore(){ const m={}; return {getItem:k=>k in m?m[k]:null, setItem:(k,v)=>{m[k]=String(v)}}; }

function runOld(reloadsThatLandStale, checks){
  const ss=mkStore(); let cur='OLD'; const served='NEW'; let reloads=0;
  for(let i=0;i<checks;i++){
    if(cur===served) break;
    const tried=ss.getItem('sm_reload_target');
    if(tried===served) continue;              // latched: gives up forever
    ss.setItem('sm_reload_target',served);
    reloads++;
    if(reloads>reloadsThatLandStale) cur=served;   // edge finally fresh
  }
  return {landed:cur===served, reloads};
}

function runNew(reloadsThatLandStale, checks, MAX=3){
  const ss=mkStore(); let cur='OLD'; const served='NEW'; let reloads=0;
  for(let i=0;i<checks;i++){
    if(cur===served) break;
    let rec=null;
    try{ rec=JSON.parse(ss.getItem('sm_reload_attempts')||'null'); }catch(e){ rec=null; }
    if(!rec||rec.stamp!==served) rec={stamp:served,n:0};
    if(rec.n>=MAX) continue;                  // bounded, not permanent-on-first
    rec.n++;
    ss.setItem('sm_reload_attempts',JSON.stringify(rec));
    reloads++;
    if(reloads>reloadsThatLandStale) cur=served;
  }
  return {landed:cur===served, reloads};
}

console.log('--- stale edge: first reload lands stale, then edge goes fresh ---');
console.log('OLD logic:', JSON.stringify(runOld(1,10)));
console.log('NEW logic:', JSON.stringify(runNew(1,10)));
console.log('--- happy path: edge fresh immediately (must not loop) ---');
console.log('OLD logic:', JSON.stringify(runOld(0,10)));
console.log('NEW logic:', JSON.stringify(runNew(0,10)));
console.log('--- pathological: edge NEVER goes fresh (must bound, not loop) ---');
console.log('OLD logic:', JSON.stringify(runOld(999,10)));
console.log('NEW logic:', JSON.stringify(runNew(999,10)));
