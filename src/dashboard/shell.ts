export type DashboardSection =
  | 'connections'
  | 'migration'
  | 'sync'
  | 'activity'
  | 'settings'
  | 'demo';

export const dashboardShellCss = `
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
  .app-header{height:60px;background:var(--nav);color:#fff}
  .header-inner{height:100%;max-width:1240px;margin:0 auto;padding:0 32px;display:flex;align-items:center;gap:28px}
  .brand{display:flex;align-items:center;gap:10px;color:#fff;font-size:16px;font-weight:600;white-space:nowrap}
  .brand:hover{color:#fff;text-decoration:none}
  .brand-mark{width:26px;height:26px;border-radius:8px;background:var(--orange);display:grid;place-items:center}
  .brand-mark::after{content:"";width:9px;height:9px;border-radius:50%;background:#fff}
  .app-nav{display:flex;align-items:center;gap:4px;flex:1;min-width:0;overflow-x:auto}
  .app-nav a{color:#b6c2ce;font-size:13px;font-weight:500;padding:8px 13px;border-radius:6px;white-space:nowrap}
  .app-nav a:hover{color:#fff;background:rgba(255,255,255,.1);text-decoration:none}
  .app-nav a.active{color:#fff;background:rgba(255,255,255,.14)}
  .header-actions{display:flex;align-items:center;gap:14px;white-space:nowrap}
  .header-actions .quiet{color:#b6c2ce;font-size:13px}
  .header-actions .quiet:hover{color:#fff;text-decoration:none}
  .header-actions .demo-cta{display:inline-flex;background:var(--orange);color:#fff;font-size:13px;font-weight:500;
    padding:9px 15px;border-radius:6px}
  .header-actions .demo-cta:hover{background:var(--orange-hover);color:#fff;text-decoration:none}
  .page{max-width:1240px;margin:0 auto;padding:32px 32px 64px}
  .page-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:24px}
  .eyebrow{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
  h1{margin:0;color:var(--text);font-size:28px;line-height:1.2;font-weight:600;letter-spacing:-.02em}
  h2{margin:0;color:var(--text);font-size:16px;font-weight:600}
  .subcopy{margin:7px 0 0;color:var(--muted);font-size:13px}
  .status-pill{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid var(--border);
    border-radius:999px;padding:8px 15px;font-size:13px;white-space:nowrap}
  .status-dot{width:8px;height:8px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 4px rgba(0,163,141,.16)}
  .status-dot.off{background:var(--muted);box-shadow:0 0 0 4px rgba(124,152,182,.15)}
  .card,.metric{background:#fff;border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}
  .card{margin-bottom:16px}
  .card-head{padding:18px 24px;border-bottom:1px solid #eaeff4;display:flex;align-items:center;gap:14px}
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
  .scroll{overflow:auto;max-height:500px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{padding:11px 14px;background:#fafcfd;border-bottom:1px solid #eaeff4;color:var(--muted);
    text-align:left;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
  td{padding:12px 14px;border-bottom:1px solid #f0f3f7;color:var(--text-2);vertical-align:middle}
  tbody tr:hover{background:#fafcfd}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-thumb{background:#cbd6e2;border-radius:8px;border:3px solid #fff}
  @media(max-width:940px){
    .header-inner{padding:0 20px}.header-actions .quiet{display:none}.page{padding:28px 20px 52px}
    .metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  }
  @media(max-width:680px){
    .app-header{height:auto}.header-inner{min-height:60px;flex-wrap:wrap;padding-top:10px;padding-bottom:10px;gap:10px}
    .app-nav{order:3;flex-basis:100%}.header-actions{margin-left:auto}.header-actions .demo-cta{display:none}
    .page-heading{align-items:flex-start;flex-direction:column}.status-pill{white-space:normal}
    .metric-grid{grid-template-columns:1fr}
  }
`;

export function dashboardHeader(active: DashboardSection): string {
  const item = (section: DashboardSection, href: string, label: string) =>
    '<a class="' + (active === section ? 'active' : '') + '" href="' + href + '">' + label + '</a>';

  return `<header class="app-header">
  <div class="header-inner">
    <a class="brand" href="/"><span class="brand-mark"></span><span>crm-sync</span></a>
    <nav class="app-nav" aria-label="Primary navigation">
      ${item('connections', '/', 'Connections')}
      ${item('migration', '/ops#migration', 'Migrate')}
      ${item('sync', '/ops#sync', 'Sync')}
      ${item('activity', '/ops#activity', 'Activity')}
      ${item('settings', '/ops#settings', 'Settings')}
    </nav>
    <div class="header-actions">
      <a class="quiet" href="/auth/api-key">Sign in</a>
      <a class="demo-cta" href="/demo">Open interactive demo</a>
    </div>
  </div>
</header>`;
}
