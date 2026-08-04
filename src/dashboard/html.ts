import { dashboardHeader, dashboardShellCss } from './shell.js';

/**
 * The demo dashboard — a single self-contained HTML page (inline CSS + JS, no external
 * requests), styled to HubSpot's Canvas design language. Polls /api/demo/status and
 * /api/demo/activity and drives the real engine against in-memory mock CRMs.
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>crm-sync — demo</title>
<style>
  :root{
    --canvas:#f5f8fa; --card:#fff; --border:#cbd6e2; --border-soft:#dfe3eb;
    --text:#33475b; --text-2:#516f90; --text-3:#7c98b6;
    --primary:#ff7a59; --primary-hover:#ff5c35; --primary-active:#e65237;
    --accent:#00a4bd; --accent-hover:#007a8c; --success:#00bda5;
    --nav:#2e3f50; --sf:#00a1e0; --hs:#ff7a59;
  }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--canvas); color:var(--text);
    font:400 14px/1.5 "Lexend Deca",-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif; }
  a{ color:var(--accent); text-decoration:none; } a:hover{ text-decoration:underline; }
  header{ background:var(--nav); color:#fff; display:flex; align-items:center; gap:12px; padding:0 24px; height:56px; }
  header .brand{ display:flex; align-items:center; gap:9px; font-weight:600; font-size:16px; }
  header .sprocket{ width:22px;height:22px;border-radius:50%;background:var(--primary);display:inline-block;position:relative; }
  header .sprocket::after{ content:""; position:absolute; inset:7px; border-radius:50%; background:var(--nav); }
  header .sub{ color:#aab7c7; font-size:12px; font-weight:400; }
  header .right{ margin-left:auto; display:flex; align-items:center; gap:16px; }
  header .right a{ color:#c3ccd8; font-size:13px; } header .right a:hover{ color:#fff; }
  .badge{ padding:4px 10px; border-radius:3px; font-size:11px; font-weight:600; letter-spacing:.3px; }
  .badge.demo{ background:#fdf3e0; color:#b3721a; } .badge.live{ background:#e0f7f2; color:#00806f; }
  main{ max-width:1040px; margin:0 auto; padding:32px 24px 64px; }
  .step{ color:var(--text-2); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; margin:0 0 14px; }
  .grid{ display:grid; gap:20px; } .cols-2{ grid-template-columns:1fr 1fr; } .cols-4{ grid-template-columns:repeat(4,1fr); }
  @media (max-width:760px){ .cols-2,.cols-4{ grid-template-columns:1fr 1fr; } }
  .card{ background:var(--card); border:1px solid var(--border); border-radius:6px; padding:20px; box-shadow:0 1px 2px rgba(0,0,0,.03); }
  .conn{ display:flex; align-items:center; gap:12px; }
  .logo{ width:42px;height:42px;border-radius:6px;display:grid;place-items:center;font-weight:700;font-size:14px;color:#fff; }
  .logo.sf{ background:var(--sf); } .logo.hs{ background:var(--hs); }
  .conn .name{ font-weight:600; } .conn .count{ color:var(--text-2); font-size:13px; }
  .dot{ width:10px;height:10px;border-radius:50%; margin-left:auto; }
  .dot.on{ background:var(--success); box-shadow:0 0 0 3px rgba(0,189,165,.18); } .dot.off{ background:var(--text-3); }
  .stat .n{ font-size:26px; font-weight:700; } .stat .l{ color:var(--text-2); font-size:12px; margin-top:2px; }
  .controls{ display:flex; gap:12px; flex-wrap:wrap; }
  button{ background:var(--primary); color:#fff; border:1px solid var(--primary); padding:10px 18px; border-radius:3px;
    font-weight:600; font-size:14px; cursor:pointer; font-family:inherit; transition:background .12s,border-color .12s; }
  button:hover{ background:var(--primary-hover); border-color:var(--primary-hover); }
  button.secondary{ background:#fff; color:var(--accent); border-color:var(--accent); }
  button.secondary:hover{ background:#f0fafc; }
  button:disabled{ opacity:.5; cursor:not-allowed; }
  .hint{ color:var(--text-2); font-size:13px; margin-top:12px; }
  .feed{ max-height:340px; overflow:auto; }
  .row{ display:flex; gap:12px; align-items:baseline; padding:10px 0; border-bottom:1px solid var(--border-soft); }
  .row:last-child{ border-bottom:0; }
  .tag{ font-size:11px; font-weight:600; text-transform:capitalize; padding:2px 8px; border-radius:3px; white-space:nowrap; }
  .tag.sync{ background:#e5f5f8; color:var(--accent-hover); }
  .tag.echo-suppressed{ background:#efeaf9; color:#7c5cbf; }
  .tag.conflict{ background:#fdf3e0; color:#a9721a; }
  .tag.migrate{ background:#e0f7f2; color:#00806f; }
  .tag.info{ background:#eaf0f6; color:var(--text-2); }
  .row .msg{ flex:1; } .row .t{ color:var(--text-3); font-size:12px; white-space:nowrap; }
  .empty{ color:var(--text-3); padding:22px 0; text-align:center; }
  ${dashboardShellCss}
  main.page{max-width:1120px}
  .demo-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
  .demo-main{display:flex;flex-direction:column;gap:20px;min-width:0}
  .demo-main>.card{margin:0}
  .connections-card{padding:0;overflow:hidden}
  .connections-card .grid{gap:1px;background:#eaeff4}
  .connection-tile{background:#fff;padding:22px 24px}
  .logo{border-radius:10px}.logo.sf{background:#e8f1fb;color:#1e6fbf}.logo.hs{background:#fdede8;color:var(--orange)}
  .demo-side{display:flex;flex-direction:column;gap:16px;position:sticky;top:24px}
  .demo-side .card{margin:0;padding:20px 22px}
  .demo-side .metric-grid{display:flex;flex-direction:column;gap:0}
  .demo-side .stat{border:0;border-radius:0;box-shadow:none;padding:13px 0;border-bottom:1px solid #f0f3f7;
    display:flex;justify-content:space-between;align-items:baseline}
  .demo-side .stat:last-child{border-bottom:0;padding-bottom:0}
  .demo-side .stat:first-child{padding-top:0}
  .demo-side .stat .n{order:2;font-size:24px;font-weight:600}.demo-side .stat .l{order:1;font-size:13px}
  .section-title{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:16px}
  .controls-card{padding:22px 24px}.controls{gap:9px}.controls button{flex:1;min-width:170px}
  .feed-card{padding:0;overflow:hidden}.feed-head{padding:17px 24px;border-bottom:1px solid #eaeff4}
  .feed{padding:0 24px;max-height:390px}.row{padding:13px 0}
  .badge.demo{background:#fff6e0;color:#8c6a12}.badge.live{background:#eaf6f4;color:var(--teal-dark)}
  @media(max-width:900px){.demo-layout{grid-template-columns:1fr}.demo-side{position:static}.demo-side .metric-grid{
    display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.demo-side .stat{border:1px solid var(--border);
    border-radius:10px;padding:15px;display:block}.demo-side .stat .n{margin-bottom:4px}}
  @media(max-width:680px){.connections-card .grid,.demo-side .metric-grid{grid-template-columns:1fr}.controls button{width:100%}}
</style>
</head>
<body>
${dashboardHeader('demo')}
<main class="page">
  <div class="page-heading">
    <div><div class="eyebrow">In-memory workspace</div><h1>Interactive sync demo</h1>
      <p class="subcopy">Run the production reconciliation engine without touching live CRM data.</p></div>
    <div class="status-pill"><span class="status-dot"></span><strong>Safe playground</strong><span id="mode" class="badge demo">DEMO</span></div>
  </div>
  <div class="demo-layout">
  <div class="demo-main">
  <section class="card connections-card">
    <div class="card-head"><h2>Demo accounts</h2><span class="section-note">In-memory connectors</span></div>
    <div class="grid cols-2">
    <div class="connection-tile"><div class="conn"><div class="logo sf">SF</div>
      <div><div class="name">Salesforce</div><div class="count" id="sf-count">—</div></div>
      <span class="dot off" id="sf-dot"></span></div></div>
    <div class="connection-tile"><div class="conn"><div class="logo hs">HS</div>
      <div><div class="name">HubSpot</div><div class="count" id="hs-count">—</div></div>
      <span class="dot off" id="hs-dot"></span></div></div>
    </div>
  </section>

  <section class="card controls-card">
    <div class="section-title">Demo controls</div>
    <div class="controls">
      <button id="b-seed">1 · Seed Salesforce contacts</button>
      <button id="b-migrate" class="secondary">2 · Migrate → HubSpot</button>
      <button id="b-edit" class="secondary">3 · Simulate HubSpot edit → sync</button>
    </div>
    <div class="hint">Runs the real engine against in-memory CRMs. Watch the metrics and activity feed react.</div>
  </section>

  <section class="card feed-card">
    <div class="feed-head"><h2>Activity</h2></div>
    <div class="feed" id="feed"><div class="empty">No activity yet.</div></div>
  </section>
  </div>
  <aside class="demo-side">
    <section class="card"><div class="section-title">This session</div>
      <div class="metric-grid">
        <div class="stat"><div class="n" id="s-migrated">0</div><div class="l">Records migrated</div></div>
        <div class="stat"><div class="n" id="s-synced">0</div><div class="l">Sync writes</div></div>
        <div class="stat"><div class="n" id="s-echo">0</div><div class="l">Echoes suppressed</div></div>
        <div class="stat"><div class="n" id="s-conflict">0</div><div class="l">Conflicts resolved</div></div>
      </div>
    </section>
    <section class="card">
      <div class="section-title">How it works</div>
      <p class="subcopy">Seed sample contacts, migrate them through the canonical model, then simulate a HubSpot edit and watch the shared sync core reconcile it.</p>
    </section>
  </aside>
  </div>
</main>
<script>
  const $=(id)=>document.getElementById(id);
  async function j(u,o){ const r=await fetch(u,o); return r.json(); }
  async function refresh(){
    try{
      const s=await j('/api/demo/status');
      $('mode').textContent=s.mode.toUpperCase(); $('mode').className='badge '+(s.mode==='demo'?'demo':'live');
      setConn('sf', s.connectors.salesforce); setConn('hs', s.connectors.hubspot);
      $('s-migrated').textContent=s.stats.migrated; $('s-synced').textContent=s.stats.synced;
      $('s-echo').textContent=s.stats.echoesSuppressed; $('s-conflict').textContent=s.stats.conflicts;
      renderFeed((await j('/api/demo/activity')).entries);
    }catch(e){}
  }
  function setConn(k,c){ $(k+'-dot').className='dot '+(c.connected?'on':'off');
    $(k+'-count').textContent=c.connected?((c.count==null?'connected':c.count+' records')):'not connected'; }
  function renderFeed(entries){ const feed=$('feed');
    if(!entries.length){ feed.innerHTML='<div class="empty">No activity yet.</div>'; return; }
    feed.innerHTML=entries.map(e=>{ const t=new Date(e.at).toLocaleTimeString();
      return '<div class="row"><span class="tag '+e.kind+'">'+e.kind.replace('-',' ')+
        '</span><span class="msg">'+esc(e.message)+'</span><span class="t">'+t+'</span></div>'; }).join(''); }
  function esc(s){ return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  async function act(url,btn){ btn.disabled=true; try{ await j(url,{method:'POST'}); await refresh(); } finally{ btn.disabled=false; } }
  $('b-seed').onclick=(e)=>act('/api/demo/seed', e.target);
  $('b-migrate').onclick=(e)=>act('/api/demo/migrate', e.target);
  $('b-edit').onclick=(e)=>act('/api/demo/edit', e.target);
  refresh(); setInterval(refresh, 1500);
</script>
</body>
</html>`;
}
