import { dashboardHeader, dashboardShellCss } from './shell.js';

/**
 * The onboarding / connections page — the app's entry point. Styled to HubSpot's Canvas
 * design language: Gypsum (#F5F8FA) canvas, white cards, Thunderdome (#33475B) text,
 * Lorax-orange (#FF7A59) primary actions, Calypso (#00A4BD) accents, 3px control radius.
 * Self-contained HTML/CSS/JS (no external requests).
 */
export function connectionsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>crm-sync — connect your CRMs</title>
<style>
  :root{
    --canvas:#f5f8fa; --card:#fff; --border:#cbd6e2; --border-soft:#dfe3eb;
    --text:#33475b; --text-2:#516f90; --text-3:#7c98b6;
    --primary:#ff7a59; --primary-hover:#ff5c35; --primary-active:#e65237;
    --accent:#00a4bd; --accent-hover:#007a8c; --success:#00bda5; --warning:#f5c26b;
    --nav:#2e3f50; --sf:#00a1e0; --hs:#ff7a59;
    --sync:#00a4bd; --echo:#7c5cbf; --conflict:#e8a33d; --migrate:#00bda5; --info:#7c98b6;
  }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--canvas); color:var(--text);
    font:400 14px/1.5 "Lexend Deca",-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif; }
  a{ color:var(--accent); text-decoration:none; } a:hover{ color:var(--accent-hover); text-decoration:underline; }
  header{ background:var(--nav); color:#fff; display:flex; align-items:center; gap:12px; padding:0 24px; height:56px; }
  header .brand{ display:flex; align-items:center; gap:9px; font-weight:600; font-size:16px; }
  header .sprocket{ width:22px;height:22px;border-radius:50%;background:var(--primary);display:inline-block;
    position:relative; }
  header .sprocket::after{ content:""; position:absolute; inset:7px; border-radius:50%; background:var(--nav); }
  header .sub{ color:#aab7c7; font-size:12px; font-weight:400; margin-left:2px; }
  header .header-links{ margin-left:auto; display:flex; align-items:center; gap:18px; }
  header .demo-link{ color:#c3ccd8; font-size:13px; }
  header .demo-link:hover{ color:#fff; }
  main{ max-width:960px; margin:0 auto; padding:32px 24px 64px; }
  .step{ color:var(--text-2); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; margin:0 0 14px; }
  .grid{ display:grid; gap:20px; grid-template-columns:1fr 1fr; }
  @media (max-width:720px){ .grid{ grid-template-columns:1fr; } }
  .card{ background:var(--card); border:1px solid var(--border); border-radius:6px; padding:24px;
    box-shadow:0 1px 2px rgba(0,0,0,.03); }
  .chead{ display:flex; align-items:center; gap:12px; margin-bottom:18px; }
  .logo{ width:44px;height:44px;border-radius:6px;display:grid;place-items:center;font-weight:700;font-size:15px;color:#fff; }
  .logo.sf{ background:var(--sf); } .logo.hs{ background:var(--hs); }
  .cname{ font-weight:600; font-size:16px; } .cstate{ color:var(--text-2); font-size:13px; }
  label{ display:block; font-size:12px; font-weight:600; color:var(--text); margin:0 0 6px; }
  select{ width:100%; background:#fff; color:var(--text); border:1px solid var(--border);
    border-radius:3px; padding:10px 12px; font-size:14px; margin-bottom:16px; font-family:inherit;
    appearance:none; background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M3 4.5L6 7.5L9 4.5' stroke='%2377889b' stroke-width='1.5' fill='none' stroke-linecap='round'/></svg>");
    background-repeat:no-repeat; background-position:right 12px center; }
  select:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 2px rgba(0,164,189,.2); }
  button{ background:var(--primary); color:#fff; border:1px solid var(--primary); padding:11px 20px; border-radius:3px;
    font-weight:600; font-size:14px; cursor:pointer; width:100%; font-family:inherit; transition:background .12s,border-color .12s; }
  button:hover{ background:var(--primary-hover); border-color:var(--primary-hover); }
  button:active{ background:var(--primary-active); }
  button:disabled{ opacity:.5; cursor:not-allowed; }
  button.secondary{ background:#fff; color:var(--accent); border-color:var(--accent); }
  button.secondary:hover{ background:#f0fafc; }
  button.danger{ background:#fff; color:#d94c53; border-color:var(--border); width:auto; padding:9px 16px; }
  button.danger:hover{ background:#fff5f5; border-color:#f2545b; }
  input.inp{ width:100%; background:#fff; color:var(--text); border:1px solid var(--border); border-radius:3px;
    padding:10px 12px; font-size:14px; font-family:inherit; }
  input.inp:focus{ outline:none; border-color:var(--accent); box-shadow:0 0 0 2px rgba(0,164,189,.2); }
  .callout{ background:var(--canvas); border:1px solid var(--border-soft); border-radius:3px; padding:9px 11px;
    font-size:12px; color:var(--text-2); margin:6px 0 14px; word-break:break-all; font-family:ui-monospace,Menlo,monospace; }
  .linkbtn{ background:none; border:none; color:var(--accent); font-size:13px; cursor:pointer; padding:0; width:auto; font-family:inherit; }
  .linkbtn:hover{ text-decoration:underline; }
  details.guide{ background:var(--canvas); border:1px solid var(--border-soft); border-radius:4px; padding:0 14px; margin-bottom:16px; }
  details.guide summary{ cursor:pointer; list-style:none; padding:12px 0; font-size:13px; font-weight:600; color:var(--text);
    display:flex; align-items:center; gap:8px; }
  details.guide summary::-webkit-details-marker{ display:none; }
  details.guide summary::before{ content:"▸"; color:var(--text-3); font-size:12px; transition:transform .12s; }
  details.guide[open] summary::before{ transform:rotate(90deg); }
  ol.steps{ margin:0; padding:2px 0 14px; list-style:none; counter-reset:s; }
  ol.steps li{ position:relative; padding:0 0 11px 30px; font-size:13px; color:var(--text-2); line-height:1.5; counter-increment:s; }
  ol.steps li:last-child{ padding-bottom:0; }
  ol.steps li::before{ content:counter(s); position:absolute; left:0; top:1px; width:21px; height:21px; border-radius:50%;
    background:var(--accent); color:#fff; font-size:11px; font-weight:600; display:grid; place-items:center; }
  ol.steps b{ color:var(--text); font-weight:600; } ol.steps a{ font-weight:600; }
  ol.steps li.tip{ color:var(--text-3); font-style:italic; } ol.steps li.tip::before{ content:"!"; background:var(--warning); color:#5a4310; }
  .copyrow{ display:flex; gap:8px; align-items:stretch; margin:6px 0 14px; }
  .copyrow .callout{ flex:1; margin:0; display:flex; align-items:center; }
  .copybtn{ background:#fff; border:1px solid var(--border); color:var(--text-2); border-radius:3px; padding:0 12px;
    font-size:12px; font-weight:600; cursor:pointer; width:auto; font-family:inherit; white-space:nowrap; }
  .copybtn:hover{ background:var(--canvas); border-color:var(--accent); color:var(--accent); }
  .connected{ display:inline-flex; align-items:center; gap:7px; color:var(--success); font-weight:600; margin-bottom:10px; }
  .connected .check{ width:18px;height:18px;border-radius:50%;background:var(--success);color:#fff;display:grid;place-items:center;font-size:11px; }
  .kv{ color:var(--text-2); font-size:13px; margin-bottom:6px; }
  .kv b{ color:var(--text); font-weight:600; }
  .envbadge{ display:inline-block; font-size:11px; font-weight:600; padding:3px 9px; border-radius:3px;
    background:#e5f5f8; color:var(--accent-hover); text-transform:uppercase; letter-spacing:.3px; }
  .envbadge.sandbox{ background:#fdf3e0; color:#b3721a; }
  .notice{ background:#fdf3e0; border:1px solid #f5c26b; color:#7a5518; border-radius:3px;
    padding:11px 13px; font-size:13px; margin-bottom:16px; line-height:1.45; }
  .explain{ background:#e5f5f8; border:1px solid #b3e0e8; color:#0a5c6b; border-radius:4px;
    padding:11px 13px; font-size:12.5px; line-height:1.55; margin-bottom:16px; }
  .explain b{ color:#083f49; font-weight:600; } .explain a{ font-weight:600; }
  .notice code{ background:rgba(0,0,0,.06); padding:1px 5px; border-radius:3px; font-size:12px; }
  .banner{ margin-top:24px; padding:18px 20px; border-radius:6px; display:flex; align-items:center; gap:14px;
    border:1px solid var(--border); background:var(--card); box-shadow:0 1px 2px rgba(0,0,0,.03); }
  .banner.ready{ border-color:var(--success); background:#e6faf7; }
  .banner .ico{ width:30px;height:30px;border-radius:50%;background:var(--border-soft);flex:none; display:grid;place-items:center;color:var(--text-2); }
  .banner.ready .ico{ background:var(--success); color:#fff; }
  .banner .msg{ flex:1; } .banner .t{ font-weight:600; margin-bottom:2px; }
  .empty{ color:var(--text-3); text-align:center; padding:22px 0; }
  ${dashboardShellCss}
  main.page{max-width:960px;padding:32px 32px 64px}
  .sync-layout{display:block}
  .sync-main{min-width:0;display:flex;flex-direction:column;gap:24px}
  .sync-main>.card,.sync-main>.banner,.sync-main>#runpanel{margin:0}
  .accounts-card{padding:0;overflow:hidden}
  .accounts-card .grid{gap:1px;background:#eaeff4}
  .accounts-card .account{border:0;border-radius:0;box-shadow:none;margin:0;padding:24px}
  .chead{margin-bottom:20px}.logo{border-radius:10px}
  .logo.sf{background:#e8f1fb;color:#1e6fbf}.logo.hs{background:#fdede8;color:var(--orange)}
  .banner{border-radius:12px;box-shadow:var(--shadow);margin-top:0}
  .banner.ready{border-color:#b9e4dc;background:#eaf6f4}
  .banner .button{flex:none}
  @media(max-width:940px){main.page{padding:28px 20px 52px}}
  @media(max-width:680px){.accounts-card .grid{grid-template-columns:1fr}.page-heading{margin-bottom:20px}
    .banner{flex-wrap:wrap}.banner .button{width:100%}}
</style>
</head>
<body>
${dashboardHeader('connections')}
<main class="page">
  <div class="page-heading">
    <div><div class="eyebrow">Workspace</div><h1>Connections</h1>
      <p class="subcopy">Authorize Salesforce and HubSpot. Everything else unlocks from here.</p></div>
    <div class="status-pill"><span class="status-dot off" id="page-status-dot"></span>
      <strong id="page-status">Checking connections</strong></div>
  </div>
  <div class="sync-layout">
  <div class="sync-main">
  <section class="card accounts-card">
    <div class="card-head"><h2>Connected accounts</h2></div>
    <div class="grid">
    <div class="card account" id="card-salesforce">
      <div class="chead"><div class="logo sf">SF</div>
        <div><div class="cname">Salesforce</div><div class="cstate" id="st-salesforce">…</div></div></div>
      <div id="body-salesforce"></div>
    </div>
    <div class="card account" id="card-hubspot">
      <div class="chead"><div class="logo hs">HS</div>
        <div><div class="cname">HubSpot</div><div class="cstate" id="st-hubspot">…</div></div></div>
      <div id="body-hubspot"></div>
    </div>
    </div>
  </section>

  <div class="banner" id="banner">
    <div class="ico" id="banner-ico">○</div>
    <div class="msg"><div class="t" id="banner-title">Connect both CRMs to unlock migration and sync</div>
      <div class="cstate" id="banner-sub">Authorize Salesforce and HubSpot above to continue.</div></div>
    <a class="button" id="banner-action" href="/ops#migration" hidden>Build a migration plan</a>
  </div>
  </div>
  </div>
</main>
<script>
  const $=(id)=>document.getElementById(id);
  async function j(u,o){ const r=await fetch(u,o); return r.json(); }

  const editing = { salesforce:false, hubspot:false };
  const lastRender = { salesforce:'', hubspot:'' };
  let SETTINGS = { salesforce:{clientId:'',hasSecret:false}, hubspot:{clientId:'',hasSecret:false} };

  function stepsHtml(sys){
    if(sys==='salesforce'){
      return '<ol class="steps">'+
        '<li>Open <b>Setup</b> (gear icon, top-right) → in Quick Find type <b>App Manager</b> → open it.</li>'+
        '<li>Click <b>New External Client App</b> (top-right).</li>'+
        '<li>Set an <b>App Name</b> (e.g. crm-sync), your <b>Contact Email</b>, and Distribution State <b>Local</b>.</li>'+
        '<li>Expand <b>API (Enable OAuth Settings)</b> and check <b>Enable OAuth</b>.</li>'+
        '<li>Paste the <b>Callback URL</b> (shown below) into the app\\'s <b>Callback URL</b> field.</li>'+
        '<li>In <b>OAuth Scopes</b>, move these to <b>Selected</b>: <b>Manage user data via APIs (api)</b> and '+
          '<b>Perform requests at any time (refresh_token, offline_access)</b> — scroll to find the second one.</li>'+
        '<li>Enable the <b>Authorization Code and Credentials Flow</b>. (You can leave <b>Require PKCE</b> on — we support it.)</li>'+
        '<li>Click <b>Create</b>. Then open the app → <b>Settings → OAuth Settings</b> → <b>Consumer Key and Secret</b> → reveal and copy both.</li>'+
        '<li>Paste them below and click <b>Save credentials</b>. One app covers both Production and Sandbox.</li>'+
        '<li class="tip">If connecting later fails with an access error, open the app\\'s <b>Policies</b> and allow self-authorization / grant it via a permission set — External Client Apps are off by default.</li>'+
        '</ol>';
    }
    return '<ol class="steps">'+
      '<li>Go to <a href="https://developers.hubspot.com" target="_blank">developers.hubspot.com</a> and sign in (create a free developer account if needed).</li>'+
      '<li>Click <b>Create app</b>.</li>'+
      '<li>On the <b>App info</b> tab, give it a name (e.g. crm-sync).</li>'+
      '<li>Open the <b>Auth</b> tab.</li>'+
      '<li>Under <b>Redirect URLs</b>, add the <b>Callback URL</b> shown below.</li>'+
      '<li>Under <b>Scopes</b>, add read + write for CRM objects: <b>crm.objects.contacts</b>, <b>crm.objects.companies</b>, <b>crm.objects.deals</b> (both .read and .write each).</li>'+
      '<li>Copy the <b>Client ID</b> and <b>Client Secret</b> from the top of the Auth tab.</li>'+
      '<li>Paste them below and click <b>Save credentials</b>.</li>'+
      '</ol>';
  }
  function credForm(sys, configured){
    const cb = window.location.origin + '/auth/'+sys+'/callback';
    const set = SETTINGS[sys] || {clientId:'',hasSecret:false};
    const appName = sys==='salesforce' ? 'Salesforce External Client App' : 'HubSpot app';
    const explain = sys==='salesforce'
      ? '<div class="explain"><b>One-time setup.</b> Create a Salesforce <b>External Client App</b> '+
        '(Setup → App Manager → <b>New External Client App</b> — the replacement for Connected Apps) and paste its '+
        '<b>Consumer Key &amp; Secret</b> here. These identify the integration, not a specific org. '+
        'After saving, you\\'ll pick Production/Sandbox and connect an org.</div>'
      : '<div class="explain"><b>One-time setup.</b> These are your HubSpot <b>app</b> credentials from '+
        '<a href="https://developers.hubspot.com" target="_blank">developers.hubspot.com</a> (Client ID &amp; Secret) — '+
        'they identify the integration, not a specific portal. After saving, you\\'ll connect a portal.</div>';
    return ''+
      explain+
      '<details class="guide" '+(configured?'':'open')+'>'+
        '<summary>Step-by-step: create your '+appName+'</summary>'+
        stepsHtml(sys)+
      '</details>'+
      '<label>Redirect / Callback URL — add this to your app</label>'+
      '<div class="copyrow"><div class="callout" id="cb-'+sys+'">'+cb+'</div>'+
        '<button class="copybtn" onclick="copyCb(\\''+sys+'\\',this)">Copy</button></div>'+
      '<label>Client ID</label>'+
      '<input class="inp" id="cid-'+sys+'" value="'+esc(set.clientId||'')+'" placeholder="'+(sys==='salesforce'?'Consumer Key':'Client ID')+'" />'+
      '<label style="margin-top:12px">Client Secret</label>'+
      '<input class="inp" id="csecret-'+sys+'" type="password" placeholder="'+(set.hasSecret?'•••••• (leave blank to keep)':(sys==='salesforce'?'Consumer Secret':'Client Secret'))+'" />'+
      '<button style="margin-top:16px" onclick="saveCreds(\\''+sys+'\\')">Save credentials</button>'+
      (configured ? '<div style="margin-top:12px"><button class="linkbtn" onclick="cancelEdit(\\''+sys+'\\')">Cancel</button></div>' : '');
  }

  function renderConn(sys, s){
    const conn = s.connections[sys], configured = s.configured[sys];
    const st = $('st-'+sys), body = $('body-'+sys);
    // Only rebuild the card when its VIEW STATE changes — otherwise the 2s poll would wipe
    // whatever the user is typing into the credential inputs.
    const set = SETTINGS[sys] || {clientId:'',hasSecret:false};
    let key;
    if(conn && !editing[sys]) key = 'connected|'+(conn.accountLabel||'')+'|'+conn.environment;
    else if(configured && !editing[sys]) key = 'connect';
    else key = 'form|'+configured+'|'+editing[sys]+'|'+set.hasSecret;
    if(key === lastRender[sys]) return;
    lastRender[sys] = key;

    if(conn && !editing[sys]){
      st.textContent = 'Connected';
      body.innerHTML =
        '<div class="connected"><span class="check">✓</span> Connected</div>'+
        '<div class="kv"><b>'+esc(conn.accountLabel||'account')+'</b></div>'+
        '<div class="kv">Environment: <span class="envbadge '+(conn.environment==='sandbox'?'sandbox':'')+'">'+conn.environment+'</span></div>'+
        '<button class="danger" style="margin-top:14px" onclick="disconnect(\\''+sys+'\\')">Disconnect</button>';
      return;
    }
    if(configured && !editing[sys]){
      st.textContent = 'Not connected';
      body.innerHTML =
        '<label>Environment</label>'+
        '<select id="env-'+sys+'"><option value="production">Production</option>'+
        '<option value="sandbox">Sandbox</option></select>'+
        '<button onclick="connect(\\''+sys+'\\')">Connect '+(sys==='salesforce'?'Salesforce':'HubSpot')+'</button>'+
        '<div style="margin-top:12px"><button class="linkbtn" onclick="edit(\\''+sys+'\\')">Edit app credentials</button></div>';
      return;
    }
    st.textContent = configured ? 'Editing credentials' : 'Setup required';
    body.innerHTML = credForm(sys, configured);
  }
  function connect(sys){ window.location='/auth/'+sys+'/start?env='+$('env-'+sys).value; }
  async function disconnect(sys){ await j('/api/connections/'+sys+'/disconnect',{method:'POST'}); refresh(); }
  function edit(sys){ editing[sys]=true; refresh(); }
  function cancelEdit(sys){ editing[sys]=false; refresh(); }
  async function saveCreds(sys){
    const clientId=$('cid-'+sys).value.trim(); const clientSecret=$('csecret-'+sys).value;
    if(!clientId){ $('cid-'+sys).focus(); return; }
    const r=await j('/api/settings/'+sys,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({clientId,clientSecret})});
    if(r.error){ alert('Could not save: '+r.error); return; }
    editing[sys]=false; refresh();
  }
  function copyCb(sys, btn){
    const text = $('cb-'+sys).textContent;
    const done = () => { const o=btn.textContent; btn.textContent='Copied ✓'; setTimeout(()=>btn.textContent=o, 1400); };
    if(navigator.clipboard){ navigator.clipboard.writeText(text).then(done).catch(done); }
    else { const t=document.createElement('textarea'); t.value=text; document.body.appendChild(t); t.select();
      try{ document.execCommand('copy'); }catch(e){} t.remove(); done(); }
  }
  window.connect=connect; window.disconnect=disconnect;
  window.edit=edit; window.cancelEdit=cancelEdit; window.saveCreds=saveCreds; window.copyCb=copyCb;

  function esc(s){ return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

  async function refresh(){
    try{
      const [s, settingsData] = await Promise.all([j('/api/status'), j('/api/settings')]);
      SETTINGS = settingsData;
      renderConn('salesforce', s); renderConn('hubspot', s);
      const b=$('banner');
      if(s.ready){ b.className='banner ready'; $('banner-ico').textContent='✓';
        $('banner-title').textContent='Both CRMs connected';
        $('banner-sub').textContent='Migration and real-time sync are unlocked.';
        $('banner-action').hidden=false;
        $('page-status-dot').className='status-dot'; $('page-status').textContent='Connected'; }
      else { b.className='banner'; $('banner-ico').textContent='○';
        $('banner-action').hidden=true;
        $('page-status-dot').className='status-dot off';
        const connected=Object.values(s.connections).filter(Boolean).length;
        $('page-status').textContent=connected?'1 of 2 connected':'Setup required'; }
    }catch(e){}
  }

  // Poll only while the tab is visible — this page used to hit four endpoints every two
  // seconds in background tabs for the lifetime of the session.
  refresh();
  setInterval(()=>{ if(!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) refresh(); });
</script>
</body>
</html>`;
}
