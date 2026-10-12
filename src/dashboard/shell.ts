export type DashboardSection =
  | 'connections'
  | 'migration'
  | 'sync'
  | 'activity'
  | 'settings'
  | 'demo';

export const dashboardShellCss = `
[hidden]{display:none!important}
  :root{
    --canvas:#f5f8fa;--card:#fff;--border:#dfe3eb;--border-strong:#cbd6e2;
    --text:#2e3f50;--text-2:#516f90;--muted:#7c98b6;--nav:#2e3f50;
    --orange:#ee5c34;--orange-hover:#ff7a56;--orange-dark:#c9451f;
    --teal:#00a38d;--teal-dark:#00806f;--blue:#1e6fbf;--purple:#5a46a8;
    --amber:#e8a33d;--red:#c9451f;--shadow:0 1px 2px rgba(46,63,80,.06);
  }
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  html{background:var(--canvas)}
  body{margin:0;background:var(--canvas);color:var(--text);
    font:400 14px/1.5 "Lexend Deca","Helvetica Neue",Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:var(--orange);text-decoration:none}
  a:hover{color:var(--orange-dark);text-decoration:underline}
  .app-header{height:60px;background:var(--nav);color:#fff;display:flex;align-items:center;padding:0;position:sticky;top:0;z-index:100;box-shadow:0 1px 3px rgba(0,0,0,.12)}
  .header-inner{width:100%;height:60px;max-width:1240px;margin:0 auto;padding:0 32px;display:flex;align-items:center;justify-content:space-between;gap:24px;position:relative;flex-wrap:nowrap}
  .nav-menu-toggle{display:none;flex-direction:column;justify-content:center;align-items:center;gap:4px;width:36px;height:36px;padding:0;border:1px solid rgba(255,255,255,.22);border-radius:7px;background:rgba(255,255,255,.08);color:#fff;cursor:pointer;flex-shrink:0;transition:background .12s,border-color .12s}
  .nav-menu-toggle:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.36)}
  .nav-menu-bar{display:block;width:16px;height:2px;background:#fff;border-radius:2px;transition:transform .16s ease,opacity .16s ease}
  .app-header.nav-open .nav-menu-toggle{background:rgba(255,255,255,.18);border-color:var(--orange)}
  .app-header.nav-open .nav-menu-bar:nth-child(1){transform:translateY(6px) rotate(45deg)}
  .app-header.nav-open .nav-menu-bar:nth-child(2){opacity:0}
  .app-header.nav-open .nav-menu-bar:nth-child(3){transform:translateY(-6px) rotate(-45deg)}
  .brand{display:inline-flex;align-items:center;gap:10px;color:#fff;font-size:16px;font-weight:600;white-space:nowrap;flex-shrink:0}
  .brand:hover{color:#fff;text-decoration:none}
  .brand-mark{width:26px;height:26px;border-radius:8px;background:var(--orange);display:grid;place-items:center;flex-shrink:0}
  .brand-mark::after{content:"";width:9px;height:9px;border-radius:50%;background:#fff}
  .app-nav{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none}
  .app-nav::-webkit-scrollbar{display:none}
  .app-nav a{color:#b6c2ce;font-size:13px;font-weight:500;padding:8px 13px;border-radius:6px;white-space:nowrap;flex-shrink:0;transition:background .12s,color .12s}
  .app-nav a:hover{color:#fff;background:rgba(255,255,255,.1);text-decoration:none}
  .app-nav a.active{color:#fff;background:rgba(255,255,255,.14)}
  .header-actions{display:flex;align-items:center;gap:12px;white-space:nowrap;flex-shrink:0;margin-left:auto}
  .header-actions .quiet{color:#b6c2ce;font-size:13px}
  .header-actions .quiet:hover{color:#fff;text-decoration:none}
  .signout{margin:0}.signout-btn{background:none;border:0;padding:6px 6px;color:#b6c2ce;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
  .signout-btn:hover{color:#fff}
  .header-actions .demo-cta{display:inline-flex;align-items:center;background:var(--orange);color:#fff;font-size:13px;font-weight:500;
    padding:8px 14px;border-radius:6px;white-space:nowrap}
  .header-actions .demo-cta:hover{background:var(--orange-hover);color:#fff;text-decoration:none}
  .page{max-width:1240px;margin:0 auto;padding:32px 32px 64px}
  .page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px 20px;margin-bottom:24px;flex-wrap:wrap}
  .page-heading>div:first-child{min-width:0;flex:1 1 280px}
  .eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  h1{margin:0;color:var(--text);font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.02em}
  h2{margin:0;color:var(--text);font-size:16px;font-weight:600}
  .subcopy{margin:7px 0 0;color:var(--muted);font-size:13px}
  .status-pill{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap;max-width:100%;background:#fff;border:1px solid var(--border);
    border-radius:999px;padding:7px 14px;font-size:13px;white-space:nowrap}
  .status-pill button.secondary{padding:6px 12px;font-size:12px;border-radius:999px}
  .status-dot{width:8px;height:8px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 4px rgba(0,163,141,.16);flex-shrink:0}
  .status-dot.off{background:var(--muted);box-shadow:0 0 0 4px rgba(124,152,182,.15)}
  .card,.metric{background:#fff;border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
  .card{margin-bottom:16px}
  .card-head{padding:18px 24px;border-bottom:1px solid #eaeff4;display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap}
  .card-body{padding:22px 24px}
  .section-note{margin-left:auto;color:var(--muted);font-size:13px}
  button,.button{border:1px solid var(--orange);border-radius:6px;background:var(--orange);color:#fff;
    font-family:inherit;font-size:13px;font-weight:600;line-height:1.2;padding:10px 15px;cursor:pointer;transition:background .12s,border-color .12s}
  button:hover,.button:hover{background:var(--orange-hover);border-color:var(--orange-hover);color:#fff;text-decoration:none}
  button:disabled{opacity:.48;cursor:not-allowed}
  button.secondary,.button.secondary{background:#fff;border-color:var(--border-strong);color:var(--text)}
  button.secondary:hover,.button.secondary:hover{background:var(--canvas);border-color:var(--muted);color:var(--text)}
  button.danger,.button.danger{background:#fff;border-color:var(--border-strong);color:var(--red)}
  button.danger:hover,.button.danger:hover{background:#fdf1ee;border-color:#f3d5cc;color:var(--red)}
  label{display:block;margin:0 0 6px;color:var(--text);font-size:12px;font-weight:600}
  input,select{width:100%;min-height:40px;border:1px solid var(--border-strong);border-radius:6px;background:#fff;color:var(--text);
    padding:9px 11px;font-family:inherit;font-size:13px;font-weight:400;line-height:1.3}
  input:focus,select:focus{outline:none;border-color:var(--orange);box-shadow:0 0 0 2px rgba(238,92,52,.15)}
  .metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
  .metric{padding:18px 20px}
  .metric b{display:block;color:var(--text);font-size:27px;line-height:1.1;font-weight:600;letter-spacing:-.02em}
  .metric span{display:block;margin-top:5px;color:var(--muted);font-size:12px}
  .metric .create{color:var(--teal-dark)}.metric .retry,.metric .ambiguous{color:#8c6a12}
  .metric .dead_letter,.metric .error{color:var(--red)}
  .badge,.pill,.tag{display:inline-flex;align-items:center;border-radius:5px;padding:4px 8px;
    font-size:11px;font-weight:600;letter-spacing:.02em;white-space:nowrap}
  .pill{background:#f0f3f7;color:var(--text-2)}
  .pill.create,.pill.completed,.tag.migrate{background:#eaf6f4;color:var(--teal-dark)}
  .pill.update,.tag.sync{background:#e8f1fb;color:var(--blue)}
  .pill.retry,.pill.ambiguous,.pill.manual_review,.tag.conflict{background:#fff6e0;color:#8c6a12}
  .pill.dead_letter,.pill.error{background:#fdede8;color:var(--red)}
  .pill.queued,.tag.info{background:#f0f3f7;color:var(--text-2)}
  .pill.dismissed{background:#f0f3f7;color:var(--muted)}
  .tag.echo-suppressed{background:#f0edfb;color:var(--purple)}
  .empty{padding:28px;text-align:center;color:var(--muted)}
  .muted{color:var(--muted)}
  .toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
  .toolbar>*{width:auto}
  .notice{padding:12px 14px;border:1px solid #f3d5cc;background:#fff8f5;border-radius:8px;color:#8d4935;font-size:13px}
  .scroll{overflow:auto;max-height:500px;scrollbar-color:#849bb3 #edf2f7;scrollbar-width:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{padding:11px 14px;background:#fafcfd;border-bottom:1px solid #eaeff4;color:var(--muted);
    text-align:left;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  td{padding:12px 14px;border-bottom:1px solid #f0f3f7;color:var(--text-2);vertical-align:middle}
  tbody tr:hover{background:#fafcfd}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  ::-webkit-scrollbar{width:12px;height:12px}
  ::-webkit-scrollbar-track{background:#edf2f7;border-radius:6px}
  ::-webkit-scrollbar-thumb{background:#849bb3;border-radius:6px;border:2px solid #edf2f7}
  ::-webkit-scrollbar-thumb:hover{background:#5c758e}
  *{scrollbar-color:#849bb3 #edf2f7}
  @media(max-width:940px){
    .header-inner{padding:0 20px;gap:16px}.header-actions .quiet{display:none}.page{padding:28px 20px 52px}
    .metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  }
  @media(max-width:860px){
    .header-inner{padding:0 20px;gap:10px;flex-wrap:nowrap}
    .nav-menu-toggle{display:inline-flex}
    .brand{cursor:pointer;padding:6px 8px;margin-left:-4px;border-radius:6px;transition:background .12s}
    .brand:hover{background:rgba(255,255,255,.08)}
    .brand::after{content:"▾";font-size:11px;color:#b6c2ce;margin-left:-2px;transition:transform .16s ease,color .12s}
    .app-header.nav-open .brand{background:rgba(255,255,255,.12)}
    .app-header.nav-open .brand::after{transform:rotate(180deg);color:#fff}
    .app-nav{display:none;position:absolute;top:calc(100% - 4px);left:16px;min-width:210px;background:#243342;border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:8px;flex-direction:column;align-items:stretch;gap:3px;box-shadow:0 14px 32px rgba(0,0,0,.38);z-index:160;overflow:visible}
    .app-header.nav-open .app-nav{display:flex}
    .app-nav a{display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 14px;font-size:13.5px;border-radius:6px}
    .app-nav a.active::after{content:"●";font-size:8px;color:var(--orange)}
    .header-actions{margin-left:auto;gap:10px}
  }
  @media(max-width:680px){
    .header-inner{padding:0 16px}
    .header-actions .demo-cta{padding:6px 11px;font-size:12px}
    .page{padding:22px 16px 48px}
    .page-heading{align-items:stretch;flex-direction:column;gap:12px;margin-bottom:20px}
    .page-heading>div:first-child{flex:none}
    h1{font-size:24px}
    .status-pill{width:100%;justify-content:flex-start;border-radius:10px;white-space:normal;padding:9px 13px}
    .status-pill button.secondary,.status-pill .badge{margin-left:auto}
    .card-head,.card-body{padding:16px}
    .metric-grid{grid-template-columns:1fr}
  }
  @media(max-width:480px){
    .app-nav{left:12px;right:12px;min-width:0}
    .header-actions{gap:8px}
    .header-actions .demo-cta{padding:5px 9px;font-size:11.5px}
    .signout-btn{font-size:12px}
  }
`;

export function dashboardHeader(active: DashboardSection): string {
  const item = (section: DashboardSection, href: string, label: string) =>
    '<a class="' + (active === section ? 'active' : '') + '" href="' + href + '">' + label + '</a>';

  return `<header class="app-header">
  <div class="header-inner">
    <button type="button" class="nav-menu-toggle" id="nav-menu-toggle" aria-label="Toggle navigation menu" aria-expanded="false" aria-controls="app-nav"><span class="nav-menu-bar"></span><span class="nav-menu-bar"></span><span class="nav-menu-bar"></span></button>
    <a class="brand" href="/"><span class="brand-mark"></span><span>crm-sync</span></a>
    <nav class="app-nav" id="app-nav" aria-label="Primary navigation">
      ${item('connections', '/', 'Connections')}
      ${item('migration', '/ops#migration', 'Migrate')}
      ${item('sync', '/ops#sync', 'Sync')}
      ${item('activity', '/ops#activity', 'Activity')}
      ${item('settings', '/ops#settings', 'Settings')}
    </nav>
    <div class="header-actions">
      <form method="post" action="/auth/logout" class="signout"><button class="signout-btn" type="submit">Sign out</button></form>
      <a class="demo-cta" href="/demo">Open interactive demo</a>
    </div>
  </div>
</header>`;
}
