import { dashboardHeader, dashboardShellCss } from './shell.js';
import { csrfFetchScript } from './csrf.js';
import {
  migrationWorkspaceCss,
  migrationWorkspaceHtml,
} from './migrationWorkspace.js';

export function operationsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CRM Sync · Operations</title>
  <style>
    ${dashboardShellCss}
    ${migrationWorkspaceCss}
    .ops-metrics{grid-template-columns:repeat(6,minmax(0,1fr));margin-bottom:16px}
    .layout{display:grid;grid-template-columns:1.15fr .85fr;gap:16px}
    .view{display:none}.view.active{display:block}
    .card{overflow:hidden}
    .card.builder-header{overflow:visible}
    .card>.card-body{padding:22px 24px}
    .card h2{padding:18px 24px;border-bottom:1px solid #eaeff4}
    .card .toolbar h2{padding:0;border:0}
    .fields{display:grid;grid-template-columns:1fr 1.25fr .75fr auto;gap:12px;align-items:end}
    .fields button{min-height:40px}
    select[multiple]{min-height:74px;padding:7px}
    .notice{margin:16px 0}
    .action-row{margin:0 0 16px}
    .action-row #mig-status{font-size:13px}
    #plans:empty::after{content:"Generate a preview to review proposed changes.";display:table-cell;padding:28px;color:var(--muted)}
    #mapping-controls{padding:18px 24px;border-bottom:1px solid #eaeff4}
    #map-rows input,#map-rows select{min-width:118px}
    #map-rows .remove{padding:8px 11px}
    .jobs-head{padding:17px 24px;border-bottom:1px solid #eaeff4}
    .jobs-head select{min-width:170px}
    .audit-entry{padding:13px 0;border-bottom:1px solid #f0f3f7}
    .audit-entry:last-child{border-bottom:0}
    #usage{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    #usage .metric{box-shadow:none}
    .right{text-align:right}
    .settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .settings-grid>.card{margin:0}
    .sync-config-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .object-sync-row{display:flex;flex-direction:column;gap:10px;padding:15px 0;border-bottom:1px solid #f0f3f7}
    .object-sync-row:last-child{border-bottom:0}
    .object-sync-main{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .object-sync-main label{margin:0;display:flex;align-items:center;gap:9px;cursor:pointer}
    .object-sync-main input{width:16px;height:16px;min-height:auto;margin:0}
    .object-sync-main select{margin-left:auto}
    .object-conflict-row{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;padding-left:25px;font-size:12.5px;color:var(--text-2)}
    .object-conflict-row label{margin:0;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;font-weight:500}
    .object-conflict-row select{width:auto;min-height:32px;height:32px;padding:4px 10px;font-size:12.5px;border-radius:6px}
    .object-conflict-row.disabled{opacity:.5}
    .object-poll-row{display:flex;flex-direction:column;gap:8px;margin-left:25px;padding:10px 12px;background:#f8fafc;border:1px solid #e6ecf2;border-radius:8px;font-size:12.5px;color:var(--text-2)}
    .poll-schedule-line{display:flex;align-items:center;justify-content:space-between;gap:8px 14px;flex-wrap:wrap}
    .poll-enable-label{margin:0;display:inline-flex;align-items:center;gap:7px;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--text);cursor:pointer}
    .poll-enable-label input[type=checkbox]{width:15px;height:15px;min-height:auto;margin:0}
    .poll-cadence,.poll-interval-fields,.poll-cron-fields{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
    .object-poll-row select,.object-poll-row input[type=number],.object-poll-row input[type=text]{width:auto;min-height:32px;height:32px;padding:4px 10px;font-size:12.5px;border-radius:6px}
    .object-poll-row input[type=number]{width:64px;text-align:center;padding:4px 6px}
    .object-poll-row input[type=text]{width:220px;max-width:100%}
    .poll-action-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:8px;border-top:1px dashed #e2e8f0}
    .poll-now-btn{min-height:30px;padding:5px 12px;font-size:12px;font-weight:600;border-radius:6px;flex-shrink:0}
    .poll-status-text{font-size:12px;line-height:1.4;flex:1;min-width:160px}
    .object-poll-row .muted{color:var(--muted)}
    .object-poll-row .muted.error{color:var(--red)}
    .object-poll-row.disabled{opacity:.5}
    .object-links-row{display:flex;gap:14px;flex-wrap:wrap;padding-left:25px;padding-top:2px}
    .poll-history{padding:10px 12px 4px 25px;display:flex;flex-direction:column;gap:6px}
    .poll-history-row{display:flex;gap:14px;font-size:12px;color:var(--text-2)}
    .poll-history-row span:first-child{flex:none;width:150px;color:var(--muted)}
    .poll-history-row.error span:last-child{color:var(--red)}
    .row-actions{display:flex;gap:6px;flex-wrap:nowrap;justify-content:flex-end}
    .row-actions button{padding:7px 11px;font-size:12px;white-space:nowrap}
    .condition-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
    .condition-row select{width:auto;flex:1}.condition-row input{flex:1}
    .condition-row button{padding:8px 10px}
    td:has(.row-select),th:has(#conflicts-select-all),th:has(#jobs-select-all){text-align:center}
    .row-select,#conflicts-select-all,#jobs-select-all{width:15px;height:15px;min-height:auto;margin:0}
    .webhook-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .webhook-card{padding:16px;border:1px solid var(--border);border-radius:9px;background:#fafcfd}
    .webhook-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}
    .webhook-card p{margin:0;color:var(--muted);font-size:12px}
    .subtabs{display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid #eaeff4}
    .subtabs button{background:#fff;border-color:var(--border-strong);color:var(--text)}
    .subtabs button.active{background:var(--nav);border-color:var(--nav);color:#fff}
    .activity-panel{display:none}.activity-panel.active{display:block}
    .ai-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:12px 18px;flex-wrap:wrap}
    .ai-summary p{margin:5px 0 0;color:var(--text-2);font-size:13px}
    .ai-details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:16px}
    .ai-detail{padding:11px 12px;background:#fafcfd;border:1px solid var(--border);border-radius:6px}
    .ai-detail span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
    .ai-detail b{display:block;margin-top:3px;font-size:12px;overflow-wrap:anywhere}
    .ai-form-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:16px}
    .ai-safe{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;color:var(--muted);font-size:11px}
    .ai-safe span::before{content:"✓";color:var(--teal-dark);font-weight:700;margin-right:5px}
    .ai-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}
    .settings-message{min-height:18px;margin-top:9px;color:var(--text-2);font-size:12px}
    .settings-message.error{color:var(--red)}
    .key-created{padding:14px;border:1px solid #b9e4dc;background:#eaf6f4;border-radius:8px;margin-bottom:14px}
    .key-created code{display:block;margin-top:7px;overflow-wrap:anywhere}
    .run-link{background:none;border:0;color:var(--blue);padding:0;font-weight:600}
    .run-detail{margin-top:16px}
    @media(max-width:1050px){.ops-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}
    @media(max-width:900px){.layout,.settings-grid,.sync-config-grid{grid-template-columns:1fr}.fields{grid-template-columns:1fr 1fr!important}}
    @media(max-width:640px){.ops-metrics,.fields,.webhook-grid,.ai-details,#usage,.ai-form-row{grid-template-columns:1fr!important}.toolbar{align-items:stretch}.toolbar>*{width:100%}.card h2,.jobs-head,.subtabs{padding:14px 16px}.card>.card-body{padding:16px}.object-conflict-row,.object-links-row,.poll-history{padding-left:0}.object-poll-row{margin-left:0}}
    .readiness-list{list-style:none;margin:0;padding:0;display:grid;gap:10px}.readiness-list li{line-height:1.5}
    .status-dot.warn{background:#f5b642}.linkbtn{background:none;border:0;color:inherit;font:inherit;font-weight:700;cursor:pointer;padding:0}
    .linkbtn:focus-visible,button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #53a6ff;outline-offset:2px}
    .refresh-progress{position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--orange),var(--blue),var(--teal));background-size:200% 100%;animation:refresh-slide 1s linear infinite;z-index:9999}
    @keyframes refresh-slide{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .btn-refreshed{border-color:var(--teal)!important;color:var(--teal)!important}
    .metric-btn{text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .15s}
    .metric-btn:hover{background:#fff;border-color:var(--orange);color:var(--text);box-shadow:0 4px 12px rgba(46,63,80,.08)}
    .pill-btn{border:1px solid #e6c875;cursor:pointer;font-family:inherit;padding:4px 8px;transition:background .12s,border-color .12s}
    .pill-btn:hover{background:#ffedb3;border-color:#d4ab3b;color:#6e5108}
    .pill-btn.dead_letter{border-color:#f3c0b3}
    .pill-btn.dead_letter:hover{background:#fbdad1;border-color:#e39b88;color:var(--red)}
    .manual-review-modal[hidden]{display:none}.manual-review-modal{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(18,36,52,.56)}
    .manual-review-card{width:min(540px,100%);padding:22px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 24px 70px rgba(18,36,52,.25)}
    .manual-review-card h2{margin:0;font-size:19px}.manual-review-card p{margin:8px 0 14px;color:var(--text-2);font-size:13px;line-height:1.55}
    .manual-review-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0;padding:12px;background:#fafcfd;border:1px solid var(--border);border-radius:8px;font-size:12px}
    .manual-review-meta div span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
    .manual-review-meta div b{display:block;margin-top:2px;color:var(--text);overflow-wrap:anywhere}
    .manual-review-reason{padding:12px;background:#fff8f5;border:1px solid #f3d5cc;border-radius:8px;color:#8d4935;font-size:12px;line-height:1.5;overflow-wrap:anywhere;margin-bottom:16px}
    .manual-review-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:16px}
  </style>
</head>
<body>
  <div class="refresh-progress" id="refresh-progress" hidden></div>
  ${dashboardHeader('migration')}
  <main class="page">
    <div class="page-heading"><div><div class="eyebrow" id="workspace-name">Workspace</div><h1 id="page-title">Migration</h1>
      <p class="subcopy" id="page-subtitle">Test one real record, verify it, then run the full migration safely.</p></div>
      <div class="status-pill"><span class="status-dot off" id="readiness-dot"></span>
        <button class="linkbtn" type="button" id="readiness-label" aria-expanded="false" aria-controls="readiness-panel">Checking readiness…</button>
        <button class="secondary" data-action="refreshAll" id="header-refresh-btn">Refresh</button></div></div>
    <section class="card" id="readiness-panel" hidden aria-label="Readiness checks"><div class="card-body"><ul class="readiness-list" id="readiness-list"></ul></div></section>
    <div class="notice" id="live-error-banner" hidden style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <span id="live-error-banner-text"></span>
      <button class="secondary" id="live-error-banner-view" type="button" style="margin-left:auto">View</button>
      <button class="secondary" id="live-error-banner-dismiss" type="button">Dismiss</button>
    </div>
    <div class="notice run-banner" id="run-banner" hidden style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <span id="run-banner-text" role="status" aria-live="polite"></span>
      <span id="execution-controls" class="execution-controls" style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap"></span>
    </div>
    ${migrationWorkspaceHtml()}

    <section class="view" id="view-sync">
      <section class="metric-grid ops-metrics" id="metrics"></section>
      <div class="sync-config-grid">
        <div class="card"><h2>Sync policy</h2><div class="card-body">
          <div class="fields" style="grid-template-columns:1fr 1fr auto">
            <div><label>Conflict strategy</label><select id="sync-conflict-strategy">
              <option value="last-write-wins">Newest record wins</option>
              <option value="source-of-truth">Source of truth wins</option>
              <option value="field-merge">Merge by field</option>
            </select></div>
            <div><label>Default source of truth</label><select id="sync-source-of-truth">
              <option value="salesforce">Salesforce</option><option value="hubspot">HubSpot</option>
            </select></div>
            <button id="save-sync-settings">Save policy</button>
          </div>
          <p style="margin:12px 0 0;color:var(--muted);font-size:12px">Each object below can also run a scheduled sync ("Every…") independent of the others — useful as a backup to (or replacement for) webhooks.</p>
          <div id="sync-object-settings"></div>
          <button class="secondary" id="add-sync-object" type="button" style="margin-top:4px">+ Add object to sync</button>
          <div class="settings-message" id="sync-settings-message"></div>
        </div></div>
        <div class="card"><h2>Webhook health</h2><div class="card-body">
          <div class="webhook-grid" id="webhook-health"><div class="empty">Checking webhooks…</div></div>
          <div class="notice" style="margin-bottom:0">Signed webhook delivery, durable queueing, and echo protection are checked separately.</div>
        </div></div>
      </div>

      <div class="card" id="sync-wizard" hidden><div class="card-body">
        <div class="toolbar" style="margin-bottom:14px"><b id="sync-wizard-heading">Add an object to sync</b><button class="secondary" id="sync-wizard-cancel" type="button" style="margin-left:auto">Cancel</button></div>

        <div id="sync-wizard-step-1">
          <p class="subcopy" style="margin-top:0">Which direction should this object sync in?</p>
          <div class="identity-options">
            <label class="identity-option"><input type="radio" name="sync-wizard-direction" value="salesforce_to_hubspot" checked><span><b>Salesforce → HubSpot</b><small>Changes in Salesforce sync to HubSpot. HubSpot-side edits are ignored.</small></span></label>
            <label class="identity-option"><input type="radio" name="sync-wizard-direction" value="hubspot_to_salesforce"><span><b>HubSpot → Salesforce</b><small>Changes in HubSpot sync to Salesforce. Salesforce-side edits are ignored.</small></span></label>
            <label class="identity-option"><input type="radio" name="sync-wizard-direction" value="bidirectional"><span><b>Bidirectional</b><small>Changes on either side sync to the other.</small></span></label>
          </div>
          <div class="identity-actions"><button id="sync-wizard-step1-continue" type="button">Continue</button></div>
        </div>

        <div id="sync-wizard-step-2" hidden>
          <p class="subcopy" style="margin-top:0" id="sync-wizard-step2-hint"></p>
          <div class="fields" style="grid-template-columns:1fr 1fr">
            <div><label>Salesforce object</label><select id="sync-wizard-sf-object"><option value="">Choose an object…</option></select></div>
            <div><label>HubSpot object</label><select id="sync-wizard-hs-object"><option value="">Choose an object…</option></select></div>
          </div>
          <p class="muted" id="sync-wizard-pair-preview" style="margin:10px 0 0;font-size:13px"></p>
          <button class="run-link" id="sync-wizard-edit-objects" type="button" hidden style="margin-top:6px">Change objects…</button>
          <div id="sync-wizard-label-row" hidden style="margin-top:10px"><label>Name this sync object <span class="muted" style="font-weight:400">(this Salesforce object is already mapped elsewhere — give this pairing its own name, e.g. "Person Account")</span></label><input id="sync-wizard-label" placeholder="e.g. Person Account"></div>
          <div id="sync-wizard-conditions-panel" hidden>
            <label style="margin-top:14px;display:block">Sync condition <span class="muted" style="font-weight:400">(optional — leave empty to sync every record)</span></label>
            <div id="sync-wizard-condition-rows"></div>
            <button class="secondary" id="sync-wizard-add-condition" type="button" style="margin-top:6px">+ Add condition</button>
            <button class="run-link" id="sync-wizard-person-account-template" type="button" hidden style="margin-left:10px">Use "exclude Person Accounts" template</button>
            <details id="sync-wizard-raw-condition-details" hidden style="margin-top:10px"><summary>Advanced: raw SOQL condition</summary>
              <textarea id="sync-wizard-raw-condition" rows="2" placeholder="e.g. Type = 'Customer'" style="width:100%;margin-top:8px;min-height:60px"></textarea>
              <p class="muted" style="font-size:11px">Appended as <code>AND (…)</code> to the sync query. No semicolons, comments, or write statements.</p>
            </details>
            <div class="identity-actions" style="margin-top:10px">
              <button class="secondary" id="sync-wizard-check-syntax" type="button">Check syntax</button>
              <button class="secondary" id="sync-wizard-test" type="button">Test this setup</button>
              <span id="sync-wizard-check-result"></span>
            </div>
            <div class="test-record-preview" id="sync-wizard-test-result" hidden style="border:1px solid var(--border);border-radius:8px;margin-top:10px">
              <div class="test-record-head"><span class="pill" id="sync-wizard-test-action"></span><b id="sync-wizard-test-summary"></b></div>
              <div class="test-record-fields" id="sync-wizard-test-fields"></div>
            </div>
          </div>
          <div class="identity-actions" style="margin-top:16px"><button class="secondary" id="sync-wizard-step2-back" type="button">Back</button>
            <button id="sync-wizard-step2-continue" type="button" disabled>Continue to field mapping</button>
            <button class="secondary" id="sync-wizard-save-conditions" type="button" hidden>Save conditions</button>
            <button id="sync-wizard-save-native-objects" type="button" hidden disabled>Save object change</button></div>
          <div class="settings-message" id="sync-wizard-message"></div>
        </div>
      </div></div>

      <div class="card" style="margin-top:16px"><div class="toolbar jobs-head"><h2 style="margin:0 auto 0 0">Conflicts &amp; manual review</h2>
        <button class="secondary" id="conflicts-replay-selected" type="button" hidden>Replay selected</button>
        <button class="danger" id="conflicts-delete-selected" type="button" hidden>Delete selected</button>
        <button class="secondary" id="refresh-conflicts">Refresh queue</button></div>
        <div class="scroll"><table><thead><tr><th style="width:36px"><input type="checkbox" id="conflicts-select-all"></th><th>Status</th><th>Date &amp; time</th><th>Event</th><th>Attempts</th><th>Reason</th><th></th></tr></thead><tbody id="conflicts"></tbody></table></div>
      </div>
    </section>

    <section class="view" id="view-activity">
      <div class="card">
        <div class="subtabs"><button class="active" data-activity-tab="jobs">Sync jobs</button><button data-activity-tab="conflicts">Conflicts</button><button data-activity-tab="audit">Audit log</button></div>
        <div class="activity-panel active" id="activity-jobs">
          <div class="toolbar jobs-head"><h2 style="margin:0 auto 0 0">Durable sync journal</h2>
            <button class="secondary" id="jobs-replay-selected" type="button" hidden>Replay selected</button>
            <button class="secondary" id="jobs-resync-selected" type="button" hidden>Re-sync selected</button>
            <button class="secondary" id="jobs-resync-all-completed" type="button" hidden>Re-sync all completed</button>
            <button class="danger" id="jobs-delete-selected" type="button" hidden>Delete selected</button>
            <select id="job-filter"><option value="">All statuses</option><option>queued</option><option>retry</option><option>dead_letter</option><option>manual_review</option><option>completed</option><option>dismissed</option></select></div>
          <div class="scroll"><table><thead><tr><th style="width:36px"><input type="checkbox" id="jobs-select-all"></th><th>Status</th><th>Date &amp; time</th><th>Event</th><th>Attempts</th><th>Error</th><th></th></tr></thead><tbody id="jobs"></tbody></table></div>
        </div>
        <div class="activity-panel" id="activity-conflicts"><div class="card-body">
          <p class="muted">Each conflict was resolved automatically by the sync policy. Review it, and if the other side should have won, keep that side's recorded values instead.</p>
          <div id="conflict-review" aria-live="polite"></div></div></div>
        <div class="activity-panel" id="activity-audit"><div id="audit" class="scroll card-body"></div></div>
      </div>
    </section>

    <section class="view" id="view-settings">
      <div class="settings-grid">
        <div class="card"><h2>Migration Copilot</h2><div class="card-body" id="ai-settings"><div class="empty">Checking Copilot configuration…</div></div></div>
        <div class="card"><h2>Email alerts</h2><div class="card-body" id="notification-settings"><div class="empty">Checking alert configuration…</div></div></div>
        <div class="card"><h2>Plan &amp; monthly usage</h2><div class="card-body">
          <div id="plan-overview"><div class="empty">Loading plan…</div></div><div id="usage"></div>
        </div></div>
        <div class="card"><h2>API keys</h2><div class="card-body">
          <div id="created-api-key"></div>
          <div class="fields" style="grid-template-columns:1fr 150px auto">
            <div><label>Key name</label><input id="api-key-name" placeholder="Automation or teammate"></div>
            <div><label>Role</label><select id="api-key-role"><option>viewer</option><option>operator</option><option>admin</option></select></div>
            <button id="create-api-key">Create key</button>
          </div>
        </div><div class="scroll"><table><thead><tr><th>Name</th><th>Prefix</th><th>Role</th><th>Last used</th><th></th></tr></thead><tbody id="api-keys"></tbody></table></div></div>
        <div class="card"><h2>Team</h2><div class="scroll"><table><thead><tr><th>Member</th><th>Role</th><th>Added</th></tr></thead><tbody id="team"></tbody></table></div></div>
      </div>
    </section>
    <section class="manual-review-modal" id="manual-review-modal" role="dialog" aria-modal="true" aria-labelledby="manual-review-title" hidden>
      <div class="manual-review-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <h2 id="manual-review-title">Manual review</h2>
          <span class="pill manual_review" id="manual-review-status">manual_review</span>
        </div>
        <p id="manual-review-subtitle">This sync job was paused so an operator can review the issue before retrying or dismissing it.</p>
        <div class="manual-review-meta" id="manual-review-meta"></div>
        <div class="manual-review-reason" id="manual-review-reason"></div>
        <div class="manual-review-actions" id="manual-review-actions"></div>
      </div>
    </section>
  </main>
  <script>${csrfFetchScript}
    const $=id=>document.getElementById(id), esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    function showProgressBar(){const b=$('refresh-progress');if(b)b.hidden=false}
    function hideProgressBar(){const b=$('refresh-progress');if(b)b.hidden=true}
    async function api(url,opts){opts=opts||{};const r=await fetch(url,{...opts,headers:{'content-type':'application/json',...(opts.headers||{})}});const j=await r.json().catch(()=>({}));if(!r.ok){const e=new Error(j.detail||(r.status===403&&j.error==='insufficient_role'?'Your role cannot do this (requires '+j.required+').':j.error)||r.statusText);e.code=j.error;e.system=j.system;e.actionUrl=j.actionUrl;e.requestId=j.requestId||r.headers.get('x-request-id');throw e}return j}
    const viewMeta={
      migration:['Migrate','Build, validate, preview, and run a controlled CRM migration.'],
      'field-mapping':['Field mapping','Map, transform, and set source-of-truth rules for CRM fields.'],
      sync:['Sync','Control live synchronization, webhook health, and conflict handling.'],
      activity:['Activity','Review sync jobs and the operator audit trail in one timeline.'],
      settings:['Settings','Manage Copilot, workspace access, usage, and plan details.']
    };
    let workspaceMode='migration';
    function getStoredFieldMappingOrigin(){try{return sessionStorage.getItem('crm_sync_field_mapping_origin')||''}catch{return ''}}
    function getStoredFieldMappingObject(){try{return sessionStorage.getItem('crm_sync_field_mapping_object')||''}catch{return ''}}
    function setStoredFieldMappingOrigin(origin,objectType){
      try{
        if(origin)sessionStorage.setItem('crm_sync_field_mapping_origin',origin);
        if(objectType!==undefined)sessionStorage.setItem('crm_sync_field_mapping_object',objectType||'');
      }catch{}
    }
    function getStoredMigrationFrom(){try{const v=sessionStorage.getItem('crm_sync_migration_from')||'';return v==='hubspot'||v==='salesforce'?v:''}catch{return ''}}
    function setStoredMigrationFrom(from){try{if(from==='hubspot'||from==='salesforce')sessionStorage.setItem('crm_sync_migration_from',from)}catch{}}
    function fieldMappingHash(origin,objectType){
      const mode=origin==='sync'?'sync':'migration';
      return '#field-mapping/'+mode+(objectType?'/'+encodeURIComponent(objectType):'');
    }
    function parseHashRoute(raw){
      const clean=String(raw||'').replace(/^#/,'').trim();
      if(!clean)return {view:'migration',origin:'migration',objectType:''};
      const parts=clean.split('/').filter(Boolean);
      if(parts[0]==='field-mapping'||parts[0]==='fields'){
        const origin=parts[1]==='sync'?'sync':parts[1]==='migration'?'migration':(getStoredFieldMappingOrigin()==='sync'?'sync':'migration');
        const objectType=parts[2]?decodeURIComponent(parts[2]):(parts[1]&&parts[1]!=='sync'&&parts[1]!=='migration'?decodeURIComponent(parts[1]):getStoredFieldMappingObject());
        return {view:'field-mapping',origin,objectType};
      }
      if((parts[0]==='sync'||parts[0]==='migration')&&(parts[1]==='field-mapping'||parts[1]==='fields')){
        return {view:'field-mapping',origin:parts[0],objectType:parts[2]?decodeURIComponent(parts[2]):getStoredFieldMappingObject()};
      }
      const base=parts[0];
      if(viewMeta[base])return {view:base,origin:base==='sync'?'sync':'migration',objectType:''};
      return {view:'migration',origin:'migration',objectType:''};
    }
    function applyWorkspaceMode(){
      const sync=workspaceMode==='sync';
      const activeView=document.querySelector('.view.active')?.id;
      if(activeView==='view-field-mapping'){
        $('page-title').textContent='Field mapping';
        $('page-subtitle').textContent=sync?'Register or map fields for an object used by Sync.':'Map and transform fields for your CRM migration.';
      }
      if($('field-mapping-kicker'))$('field-mapping-kicker').textContent=sync?'Sync · Field mapping':'Guided migration · Step 3 of 6';
      if($('field-mapping-title'))$('field-mapping-title').textContent=sync?'Configure field mappings for Sync':'Map and transform fields';
      if($('back-to-sync'))$('back-to-sync').hidden=!sync;
      if($('back-to-migration'))$('back-to-migration').hidden=sync;
      document.querySelectorAll('#view-field-mapping [data-go-step="objects"],#view-field-mapping [data-go-step="values"]').forEach(btn=>btn.hidden=sync);
      if($('fields-step-eyebrow')){$('fields-step-eyebrow').hidden=sync;$('fields-step-eyebrow').textContent='Step 3 of 6'}
      if($('fields-step-title'))$('fields-step-title').textContent=sync?'Map fields for this object':'Map and transform fields';
      if($('save-next-field-object'))$('save-next-field-object').textContent=sync?'Save & back to Sync →':'Save & next object →';
    }
    $('back-to-sync').onclick=async()=>{
      try{if(migrationState.mapping?.dirty)await saveFieldMappings(false)}catch{}
      $('sync-wizard-natural-key').hidden=true;syncWizard.naturalKeyPending=false;
      history.replaceState(null,'','#sync');selectView('sync');
    };
    if($('back-to-migration'))$('back-to-migration').onclick=async()=>{
      try{if(migrationState.mapping?.dirty)await saveFieldMappings(false)}catch{}
      const returnStep=migrationState.lastPanelStep&&migrationState.lastPanelStep!=='fields'?migrationState.lastPanelStep:'objects';
      selectMigrationStep(returnStep);
    };
    function selectView(rawView,opts){
      opts=opts||{};
      const route=parseHashRoute(rawView);
      const view=route.view;
      if(view==='field-mapping'){
        workspaceMode=route.origin==='sync'?'sync':'migration';
        setStoredFieldMappingOrigin(workspaceMode,route.objectType);
        const canonicalHash=fieldMappingHash(workspaceMode,route.objectType);
        if(location.hash&&location.hash!==canonicalHash)history.replaceState(null,'',canonicalHash);
      }else{
        workspaceMode=view==='sync'?'sync':'migration';
      }
      document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id==='view-'+view));
      const navView=view==='field-mapping'?(workspaceMode==='sync'?'sync':'migration'):view;
      document.querySelectorAll('.app-nav a').forEach(x=>x.classList.toggle('active',x.getAttribute('href')==='/ops#'+navView));
      $('page-title').textContent=viewMeta[view][0];$('page-subtitle').textContent=viewMeta[view][1];
      if(view==='field-mapping')applyWorkspaceMode();
      if(opts.skipLoad)return;
      if(view==='field-mapping')loadFieldMappingWorkspace(route.objectType);
      if(view==='migration'&&(!migrationState.catalog.length||migrationState.catalogSource!==$('mig-from').value)){loadCatalog($('mig-from').value);loadSavedPlans();loadRuns()}
      if(view==='sync')loadSyncWorkspace();if(view==='activity'){loadJobs();loadAudit();loadConflicts()}if(view==='settings')loadSettingsWorkspace();
      if(view==='sync'||view==='activity')checkForNewSyncErrors();
    }
    document.querySelectorAll('.app-nav a[href^="/ops#"]').forEach(a=>a.onclick=e=>{
      e.preventDefault();
      const view=a.getAttribute('href').split('#')[1];
      workspaceMode=view==='sync'?'sync':'migration';
      if(view==='migration'&&migrationState.currentStep==='fields'){
        migrationState.currentStep=migrationState.lastPanelStep||'objects';
        document.querySelectorAll('.workspace-step').forEach(x=>{
          const active=x.dataset.step===migrationState.currentStep;
          x.classList.toggle('active',active);
          x.toggleAttribute('aria-current',active);
        });
        document.querySelectorAll('#view-migration .workspace-panel').forEach(x=>x.classList.toggle('active',x.id==='workspace-'+migrationState.currentStep));
      }
      history.replaceState(null,'','#'+view);
      selectView(view);
    });
    window.addEventListener('hashchange',()=>selectView(location.hash.slice(1)));
    const initialMigFrom=getStoredMigrationFrom();if(initialMigFrom&&$('mig-from'))$('mig-from').value=initialMigFrom;
    selectView(location.hash.slice(1),{skipLoad:true});
    function metric(label,value,cls='',filter=''){if(filter)return '<button type="button" class="metric metric-btn" data-action="filterJobsByStatus" data-arg="'+esc(filter)+'"><span>'+esc(label)+'</span><b class="'+cls+'">'+esc(value)+'</b></button>';return '<div class="metric"><span>'+esc(label)+'</span><b class="'+cls+'">'+esc(value)+'</b></div>'}
    function filterJobsByStatus(status){history.replaceState(null,'','#activity');selectView('activity');document.querySelectorAll('[data-activity-tab]').forEach(item=>item.classList.toggle('active',item.dataset.activityTab==='jobs'));document.querySelectorAll('.activity-panel').forEach(panel=>panel.classList.toggle('active',panel.id==='activity-jobs'));$('job-filter').value=status||'';loadJobs()}
    window.filterJobsByStatus=filterJobsByStatus;
    async function loadMetrics(){const [s,q]=await Promise.all([api('/api/status'),api('/api/sync/stats')]);$('metrics').innerHTML=
      metric('Ready',s.ready?'Yes':'No',s.ready?'create':'error')+metric('Queued',q.queued,'','queued')+metric('Retrying',q.retry,'retry','retry')+
      metric('Manual review',q.manualReview,'ambiguous','manual_review')+metric('Dead letter',q.deadLetter,'dead_letter','dead_letter')+metric('Synced',s.stats.synced)}
    const migrationState={plan:null,dirty:true,catalog:[],catalogSource:null,catalogError:null,targets:[],selected:new Set(),selectionInitialized:false,selectedRow:null,metadata:new Map(),mapping:null,fieldLoadToken:0,valueLoadToken:0,preflight:null,copilot:null,preview:null,canaryPreview:null,canaryVerified:false,currentStep:'scope',lastPanelStep:'scope',visited:new Set(['scope']),transformRow:null,savedPlans:[],runs:[]};
    const migrationSteps=['scope','objects','fields','values','validate','preview'];
    const transformIds=['identity','domain','lowercase','trim','number','boolean','yes-no','true-false','iso-date','epoch-millis','phone'];
    const transformMeta={
      identity:['Identity','Keep the value unchanged'],
      trim:['Trim','Remove leading and trailing spaces'],
      lowercase:['Lowercase','Trim and convert text to lowercase'],
      domain:['Extract domain','Remove protocol, path, and www'],
      number:['Parse number','Convert numeric text to a number'],
      boolean:['Parse boolean','Convert true, 1, or yes to true'],
      'yes-no':['Yes/No ↔ boolean','true ↔ "yes", false ↔ "no" (e.g. a HubSpot checkbox stored as yes/no)'],
      'true-false':['True/False ↔ boolean','true ↔ "true", false ↔ "false" (e.g. a dropdown whose options are the strings true/false)'],
      'iso-date':['ISO date','Convert a valid date to ISO-8601'],
      'epoch-millis':['Epoch date ↔ ISO','ISO-8601 ↔ Unix epoch milliseconds (e.g. a custom date property stored as a number)'],
      phone:['Normalize phone','Keep digits and a leading plus sign']
    };
    let autosaveTimer;
    function migrationBody(){return {name:$('plan-name').value.trim(),source:$('mig-from').value,types:[...migrationState.selected],limitPerType:Number($('mig-limit').value)||undefined,config:{objectSettings:Object.fromEntries([...migrationState.selected].map(type=>[type,{included:true}]))}}}
    function resetCopilot(){migrationState.copilot=null;$('ask-copilot').disabled=!migrationState.preflight;$('ask-copilot').textContent='Ask Copilot';$('copilot-panel').hidden=true;$('copilot-panel').innerHTML=''}
    function setDraftStatus(text,state=''){$('autosave-status').textContent=text;$('draft-state').className='draft-state'+(state?' '+state:'');if($('field-mapping-autosave-status'))$('field-mapping-autosave-status').textContent=text;if($('field-mapping-draft-state'))$('field-mapping-draft-state').className='draft-state'+(state?' '+state:'')}
    function systemLabel(sys){return sys==='salesforce'?'Salesforce':sys==='hubspot'?'HubSpot':sys||'Salesforce'}
    function updateFieldMappingDirectionHeaders(from,to){
      if($('source-field-th-label'))$('source-field-th-label').textContent='Source field ('+systemLabel(from)+')';
      if($('target-field-th-label'))$('target-field-th-label').textContent='Target field ('+systemLabel(to)+')';
    }
    function updateDirectionPreview(){const from=$('mig-from').value==='salesforce'?'Salesforce':'HubSpot';$('direction-source-name').textContent=from;$('direction-target-name').textContent=from==='Salesforce'?'HubSpot':'Salesforce';if(workspaceMode!=='sync'&&!migrationState.mapping){const sysFrom=$('mig-from').value==='hubspot'?'hubspot':'salesforce';updateFieldMappingDirectionHeaders(sysFrom,sysFrom==='salesforce'?'hubspot':'salesforce')}}
    function updateDeletePlanButton(){const btn=$('delete-current-plan');if(!btn)return;if(!migrationState.plan){btn.hidden=true;return}btn.hidden=false;const isExecuting=Boolean(migrationState.plan.status==='executing'||migrationState.plan.activeExecutionId);btn.disabled=isExecuting;btn.title=isExecuting?'Cannot delete an executing plan':''}
    function markPlanDirty(){migrationState.dirty=true;migrationState.preflight=null;migrationState.preview=null;migrationState.canaryPreview=null;migrationState.canaryVerified=false;resetCopilot();$('execute').disabled=true;$('execute-canary').disabled=true;$('test-record-preview').hidden=true;$('test-record-result').hidden=true;$('full-migration').hidden=true;$('summary-preflight').textContent='Not run';$('summary-preview').textContent='Required';setDraftStatus('Unsaved changes');updateMigrationSummary();updateMigrationStepper()}
    async function savePlan(refreshPlans=true){const body=migrationBody();if(!body.name||!body.types.length)throw new Error('Choose at least one supported object and name the plan');
      setDraftStatus('Saving…');
      const plan=await api(migrationState.plan?'/api/migration-plans/'+migrationState.plan.id:'/api/migration-plans',{method:migrationState.plan?'PATCH':'POST',body:JSON.stringify(body)});
      migrationState.plan=plan;migrationState.dirty=false;$('summary-plan').textContent=plan.name+' · r'+plan.revision;setDraftStatus('Autosaved · revision '+plan.revision,'saved');if(refreshPlans)await loadSavedPlans();updateMigrationSummary();updateMigrationStepper();return plan}
    async function ensurePlan(){return migrationState.plan&&!migrationState.dirty?migrationState.plan:savePlan(false)}
    function queuePlanAutosave(){clearTimeout(autosaveTimer);setDraftStatus('Waiting to autosave…');autosaveTimer=setTimeout(async()=>{try{if($('plan-name').value.trim()&&migrationState.selected.size)await savePlan(false)}catch(e){setDraftStatus(e.message,'error')}},650)}
    $('save-plan').onclick=async()=>{try{$('save-plan').disabled=true;await savePlan();$('save-plan').textContent='Saved ✓';setTimeout(()=>$('save-plan').textContent='Save now',1200)}catch(e){setDraftStatus(e.message,'error');showError(e.message,e.requestId)}finally{$('save-plan').disabled=false}};
    if($('delete-current-plan'))$('delete-current-plan').onclick=()=>{if(!migrationState.plan)return;deleteSavedPlan(migrationState.plan.id)};
    ['plan-name','mig-limit'].forEach(id=>$(id).addEventListener(id==='plan-name'?'input':'change',()=>{markPlanDirty();queuePlanAutosave()}));
    $('mig-from').onchange=async()=>{setStoredMigrationFrom($('mig-from').value);migrationState.plan=null;migrationState.mapping=null;migrationState.selected=new Set();migrationState.selectionInitialized=false;updateDirectionPreview();markPlanDirty();await loadCatalog($('mig-from').value);queuePlanAutosave()};

    document.querySelectorAll('.workspace-step').forEach(button=>button.onclick=()=>goMigrationStep(button.dataset.step,button.dataset.step!=='scope'&&migrationState.currentStep==='scope'));
    document.querySelectorAll('[data-go-step]').forEach(button=>button.onclick=()=>goMigrationStep(button.dataset.goStep,button.dataset.saveBefore==='true'));
    async function goMigrationStep(step,saveBefore=false){try{if(migrationState.currentStep==='fields'&&step!=='fields'&&migrationState.mapping?.dirty)await saveFieldMappings();if(saveBefore)await ensurePlan();if(['validate','preview'].includes(step)){const incomplete=selectedCatalogRows().filter(row=>mappingObjectState(row).key!=='complete');if(incomplete.length){await selectMigrationStep('fields');$('field-object-filter').value='review';renderFieldObjectQueue();setDraftStatus('Finish field mappings for '+incomplete.map(row=>row.source.label).join(', '),'error');return}}if(step==='preview'&&(!migrationState.preflight||!migrationState.preflight.ok)){const result=await runPlanPreflight();if(!result.ok)return}await selectMigrationStep(step)}catch(e){setDraftStatus(e.message,'error')}}
    async function selectMigrationStep(step){if(!migrationSteps.includes(step))step='scope';migrationState.currentStep=step;migrationState.visited.add(step);document.querySelectorAll('.workspace-step').forEach(x=>{x.classList.toggle('active',x.dataset.step===step);x.toggleAttribute('aria-current',x.dataset.step===step)});
      if(step==='fields'){const targetType=$('field-object').value||migrationState.mapping?.type||[...migrationState.selected][0];await openFieldMappingPage('migration',targetType);updateMigrationStepper();return}
      migrationState.lastPanelStep=step;
      document.querySelectorAll('#view-migration .workspace-panel').forEach(x=>x.classList.toggle('active',x.id==='workspace-'+step));
      if(document.querySelector('.view.active')?.id!=='view-migration'){workspaceMode='migration';history.replaceState(null,'','#migration');selectView('migration',{skipLoad:true})}
      if(step==='values')loadValuesWorkspace($('value-object').value||[...migrationState.selected][0]);if(step==='preview')loadTestRecordWorkspace().catch(e=>$('mig-status').textContent=e.message);updateMigrationStepper()}
    function updateMigrationStepper(){const selectedRows=selectedCatalogRows(),coverageTotal=selectedRows.reduce((n,row)=>n+row.totalMappedFields,0),coverageMapped=selectedRows.reduce((n,row)=>n+row.mappedFields,0),canaryPassed=migrationState.canaryVerified||Boolean(migrationState.plan?.canary?.verifiedAt&&migrationState.plan.canary.previewRevision===migrationState.plan.revision);const states={scope:$('plan-name').value.trim()?'complete':'warning',objects:migrationState.selected.size?'complete':'blocked',fields:coverageTotal&&coverageMapped===coverageTotal?'complete':migrationState.visited.has('fields')?'warning':'',values:migrationState.visited.has('values')?'complete':'',validate:migrationState.preflight?(migrationState.preflight.ok?'complete':'blocked'):'',preview:canaryPassed?'complete':migrationState.canaryPreview?'warning':''};document.querySelectorAll('.workspace-step').forEach(button=>{button.classList.remove('complete','warning','blocked');if(states[button.dataset.step])button.classList.add(states[button.dataset.step])})}
    updateDirectionPreview();
    function selectMigrateTab(tab){if(!['builder','plans','runs'].includes(tab))tab='builder';document.querySelectorAll('[data-migrate-tab]').forEach(button=>{const active=button.dataset.migrateTab===tab;button.classList.toggle('active',active);button.toggleAttribute('aria-current',active)});document.querySelectorAll('.migrate-section').forEach(section=>section.classList.toggle('active',section.id==='migrate-'+tab));if(tab==='plans')loadSavedPlans();if(tab==='runs')loadRuns()}
    document.querySelectorAll('[data-migrate-tab]').forEach(button=>button.onclick=()=>selectMigrateTab(button.dataset.migrateTab));
    document.querySelectorAll('[data-migrate-open]').forEach(button=>button.onclick=()=>selectMigrateTab(button.dataset.migrateOpen));

    let catalogLoadPromise=null,catalogLoadSource=null,catalogLoadToken=0;
    function loadCatalog(explicitSource){
      const desiredSource=explicitSource||$('mig-from').value||'salesforce';
      if(catalogLoadPromise&&catalogLoadSource===desiredSource)return catalogLoadPromise;
      catalogLoadSource=desiredSource;
      const token=++catalogLoadToken;
      const p=loadCatalogNow(desiredSource,token).finally(()=>{if(catalogLoadPromise===p){catalogLoadPromise=null;catalogLoadSource=null}});
      catalogLoadPromise=p;
      return p;
    }
    async function loadCatalogNow(source,token){source=source||$('mig-from').value||'salesforce';$('object-rows').innerHTML='<tr><td colspan="6" class="empty">Discovering CRM objects…</td></tr>';
      try{const result=await api('/api/object-catalog?from='+encodeURIComponent(source));if(token&&token!==catalogLoadToken)return;const catFrom=result.from||source;migrationState.catalogSource=catFrom;migrationState.catalog=(result.rows||[]).map(r=>({...r,_sfObj:catFrom==='salesforce'?r.source:r.target,_hsObj:catFrom==='hubspot'?r.source:r.target}));migrationState.catalogError=null;migrationState.targets=result.targets||[];
        if(!migrationState.selectionInitialized){migrationState.selected=new Set(migrationState.catalog.filter(row=>row.registered).map(row=>row.canonicalType));migrationState.selectionInitialized=true}
        renderCatalog();refreshObjectSelectors();updateMigrationSummary()}
      // Kept separate from "filter matched nothing" (renderCatalog's own empty state) so a
      // real fetch failure -- most commonly an expired CRM connection -- stays visible and
      // actionable instead of silently turning into a misleading "no objects match this view"
      // the next time renderCatalog() runs (e.g. when the filter dropdown changes).
      catch(e){if(token&&token!==catalogLoadToken)return;migrationState.catalog=[];migrationState.catalogError={message:e.message,actionUrl:e.actionUrl};renderCatalog()}}
    // Shared by the catalog checkbox and the manual target picker: registers row.source paired
    // with whatever row.target currently is (auto-matched or manually chosen) as a canonical object.
    async function registerCatalogMapping(row){const from=$('mig-from').value,to=from==='salesforce'?'hubspot':'salesforce',body={label:row.source.label};body[from+'Object']=row.source.id;if(row.target)body[to+'Object']=row.target.id;
      const registration=await api('/api/object-mappings',{method:'POST',body:JSON.stringify(body)});row.canonicalType=registration.canonicalObject;row.registered=true;migrationState.metadata.clear();return registration}
    async function confirmManualTarget(row){const select=$('manual-target'),targetId=select&&select.value;if(!targetId)return;const target=(migrationState.targets||[]).find(t=>t.id===targetId);if(!target)return;
      const button=$('manual-target-confirm');button.disabled=true;button.textContent='Mapping…';
      try{const catFrom=migrationState.catalogSource||$('mig-from').value||'salesforce';row.target=target;row.supported=true;row._sfObj=catFrom==='salesforce'?row.source:target;row._hsObj=catFrom==='hubspot'?row.source:target;await registerCatalogMapping(row);migrationState.selected.add(row.canonicalType);markPlanDirty();renderCatalog();refreshObjectSelectors();queuePlanAutosave();await selectCatalogRow(row)}
      catch(err){setDraftStatus(err.message,'error')}
      finally{const btn=$('manual-target-confirm');if(btn){btn.disabled=false;btn.textContent='Map to this object'}}}
    function renderCatalog(){if(migrationState.catalogError){const err=migrationState.catalogError;
        $('object-rows').innerHTML='<tr><td colspan="6" class="empty">'+esc(err.message)+(err.actionUrl?' &middot; <a href="'+esc(err.actionUrl)+'">Reconnect</a>':'')+'</td></tr>';return}
      const query=$('catalog-search').value.trim().toLowerCase(),filter=$('catalog-filter').value;
      const visible=migrationState.catalog.filter(row=>{const selected=row.canonicalType&&migrationState.selected.has(row.canonicalType);const text=(row.source.label+' '+row.source.id+' '+(row.target?.label||'')).toLowerCase();
        return (!query||text.includes(query))&&(filter==='all'||filter==='supported'&&row.supported||filter==='unsupported'&&!row.supported||filter==='selected'&&selected)});
      const shown=visible.slice(0,200);$('object-rows').innerHTML=shown.length?shown.map(row=>{const selected=row.canonicalType&&migrationState.selected.has(row.canonicalType);const type=row.source.custom?'Custom':'Standard';
        return '<tr class="catalog-row '+(!row.supported?'unsupported ':'')+(migrationState.selectedRow?.source.id===row.source.id?'selected':'')+'" data-object="'+esc(row.source.id)+'">'+
          '<td><input type="checkbox" '+(selected?'checked':'')+' '+(!row.supported?'disabled':'')+' aria-label="Include '+esc(row.source.label)+'"></td>'+
          '<td><span class="object-name">'+esc(row.source.label)+'</span><span class="api-name">'+esc(row.source.id)+'</span></td>'+
          '<td>'+(row.target?'<span class="object-name">'+esc(row.target.label)+'</span><span class="api-name">'+esc(row.target.id)+'</span>':'<span class="muted">No target match</span>')+'</td>'+
          '<td><span class="pill">'+type+'</span></td><td>'+esc(row.mappedFields)+' / '+esc(row.totalMappedFields||'—')+'</td>'+
          '<td><span class="readiness"><span class="mini-dot '+(!row.supported?'off':!row.registered?'warning':row.mappedFields===row.totalMappedFields?'':'warning')+'"></span>'+esc(!row.supported?'Not supported yet':!row.registered?'Not yet mapped':row.mappedFields===row.totalMappedFields?'Ready':'Needs mapping')+'</span></td></tr>'}).join('')+(visible.length>shown.length?'<tr><td colspan="6" class="empty">Showing the first '+shown.length+' of '+visible.length+' objects. Refine the search to inspect more.</td></tr>':''):'<tr><td colspan="6" class="empty">No objects match this view.</td></tr>';
      document.querySelectorAll('.catalog-row').forEach(tr=>{const row=migrationState.catalog.find(item=>item.source.id===tr.dataset.object);tr.onclick=()=>selectCatalogRow(row);const box=tr.querySelector('input');if(box)box.onclick=async e=>{e.stopPropagation();if(!row||!row.supported)return;
        if(box.checked){
          if(!row.canonicalType){
            box.disabled=true;
            try{await registerCatalogMapping(row)}
            catch(err){box.checked=false;box.disabled=false;setDraftStatus(err.message,'error');return}
          }
          migrationState.selected.add(row.canonicalType)
        }else if(row.canonicalType)migrationState.selected.delete(row.canonicalType);
        markPlanDirty();renderCatalog();refreshObjectSelectors();queuePlanAutosave()}});
    }
    $('catalog-search').oninput=renderCatalog;$('catalog-filter').onchange=renderCatalog;
    function ensureHubSpotMigratedRecordId(meta){
      if(!meta||!Array.isArray(meta.fields))return;
      const existing=meta.fields.find(f=>f.name==='migrated_record_id');
      if(!existing){
        meta.fields.unshift({
          name:'migrated_record_id',
          label:'Record Id Salesforce',
          type:'string',
          readOnly:false
        });
      }else if(!existing.label||existing.label==='migrated_record_id'){
        existing.label='Record Id Salesforce';
      }
    }
    async function getMetadata(system,objectId){
      const key=system+':'+objectId;
      if(!migrationState.metadata.has(key)){
        const meta=await api('/api/object-catalog/'+system+'/'+encodeURIComponent(objectId));
        if(system==='hubspot')ensureHubSpotMigratedRecordId(meta);
        migrationState.metadata.set(key,meta);
      }
      return migrationState.metadata.get(key);
    }
    async function selectCatalogRow(row){if(!row)return;migrationState.selectedRow=row;renderCatalog();$('object-detail').innerHTML='<div class="empty">Loading metadata…</div>';
      try{const source=await getMetadata($('mig-from').value,row.source.id);renderObjectDetail(source,row)}catch(e){$('object-detail').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
    function renderObjectDetail(meta,row){const required=meta.fields.filter(f=>f.required).length,enums=meta.fields.filter(f=>f.options?.length).length,total=row.totalMappedFields||0,mapped=row.mappedFields||0,missing=Math.max(0,total-mapped),coverage=total?Math.round(mapped/total*100):0,ready=row.registered&&missing===0;
      const fieldRows=meta.fields.map(f=>'<tr><td>'+esc(f.label)+'</td><td class="api-name">'+esc(f.name)+'</td><td>'+esc(f.type)+'</td><td>'+[f.required?'Required':'',f.readOnly?'Read only':'',f.unique?'Unique':'',f.calculated?'Calculated':''].filter(Boolean).map(x=>'<span class="pill">'+x+'</span>').join(' ')+'</td></tr>').join('');
      const manualTarget=row.supported?'':'<div class="manual-target"><b>No automatic match found</b><p>Pick which object in the destination CRM this should map to, then it becomes selectable for migration.</p><div class="manual-target-controls"><select id="manual-target"><option value="">Choose a destination object…</option>'+(migrationState.targets||[]).slice().sort((a,b)=>a.label.localeCompare(b.label)).map(t=>'<option value="'+esc(t.id)+'">'+esc(t.label)+' · '+esc(t.id)+'</option>').join('')+'</select><button id="manual-target-confirm">Map to this object</button></div></div>';
      $('object-detail').innerHTML='<div class="detail-head"><div><h2>'+esc(meta.object.label)+'</h2><div class="detail-meta"><span class="pill">'+(meta.object.custom?'Custom':'Standard')+'</span><span class="pill">'+esc(meta.object.id)+'</span><span class="pill '+(ready?'completed':row.registered?'ambiguous':'queued')+'">'+(ready?'Ready':row.registered?'Needs mapping':row.supported?'Not yet mapped':'Catalog only')+'</span></div></div><button class="secondary" id="open-object-fields" '+(!row.registered?'disabled':'')+'>Review mappings</button></div>'+
        manualTarget+
        '<div class="metadata-grid"><div class="metadata-item"><span>Mapping coverage</span><b>'+mapped+' / '+(total||'—')+'</b></div><div class="metadata-item"><span>Required fields</span><b>'+required+'</b></div><div class="metadata-item"><span>Picklists</span><b>'+enums+'</b></div></div>'+
        '<div class="readiness-panel"><div class="readiness-summary"><b>'+(ready?'Ready for preflight':row.supported?missing+' mappings need attention':'Not available for execution')+'</b><p>'+(ready?'Core field coverage is complete. Required fields and values are validated during preflight.':row.supported?'Finish these mappings in the next step before generating a preview.':'This object is visible for schema inspection but the migration engine does not execute it yet.')+'</p><div class="readiness-progress"><span style="width:'+coverage+'%"></span></div></div>'+
        '<div class="readiness-checks"><div class="readiness-check"><span class="mini-dot '+(row.supported?'':'off')+'"></span><span><b>Engine support</b>'+(row.supported?'Migration supported':'Catalog only')+'</span></div><div class="readiness-check"><span class="mini-dot '+(row.target?'':'off')+'"></span><span><b>Target binding</b>'+esc(row.target?.label||'No target match')+'</span></div><div class="readiness-check"><span class="mini-dot '+(missing?'warning':'')+'"></span><span><b>Field mappings</b>'+(missing?missing+' still need review':'Core coverage complete')+'</span></div></div></div>'+
        '<details class="schema-disclosure"><summary>View source schema ('+meta.fields.length+' fields)</summary><div class="schema-drawer-section"><h3>Source fields</h3><div class="scroll"><table><thead><tr><th>Field</th><th>API name</th><th>Type</th><th>Flags</th></tr></thead><tbody>'+fieldRows+'</tbody></table></div></div></details>';
      const open=$('open-object-fields');if(open)open.onclick=()=>{openFieldMappingPage('migration',row.canonicalType)}
      const manualConfirm=$('manual-target-confirm');if(manualConfirm)manualConfirm.onclick=()=>confirmManualTarget(row)}

    function getFieldMappingDirection(type){
      if(workspaceMode==='sync'){
        const t=type||$('field-object').value||migrationState.mapping?.type;
        const dir=(t&&syncConfigState?.objects?.[t]?.direction)||(typeof syncWizard!=='undefined'&&syncWizard.active&&syncWizard.type===t?syncWizard.direction:null)||'bidirectional';
        const from=dir==='hubspot_to_salesforce'?'hubspot':'salesforce';
        return {from,to:from==='salesforce'?'hubspot':'salesforce'};
      }
      const from=$('mig-from').value==='hubspot'?'hubspot':'salesforce';
      return {from,to:from==='salesforce'?'hubspot':'salesforce'};
    }
    function resolveRowEndpoints(row,type){
      if(!row)return {from:'salesforce',to:'hubspot',sourceObj:null,targetObj:null};
      const {from,to}=getFieldMappingDirection(type||row.canonicalType);
      const catFrom=migrationState.catalogSource||'salesforce';
      const sfObj=row._sfObj||(catFrom==='salesforce'?row.source:row.target);
      const hsObj=row._hsObj||(catFrom==='hubspot'?row.source:row.target);
      const sourceObj=from==='salesforce'?sfObj:hsObj;
      const targetObj=from==='salesforce'?hsObj:sfObj;
      return {from,to,sourceObj,targetObj};
    }
    function updateFieldMappingDirectionHeaders(from,to){
      const fromLabel=from==='hubspot'?'HubSpot':'Salesforce';
      const toLabel=to==='salesforce'?'Salesforce':'HubSpot';
      const srcTh=$('source-field-th-label');if(srcTh)srcTh.textContent='Source field ('+fromLabel+')';
      const tgtTh=$('target-field-th-label');if(tgtTh)tgtTh.textContent='Target field ('+toLabel+')';
      const srcToLbl=$('transform-source-to-label');if(srcToLbl)srcToLbl.textContent=fromLabel+' → Canonical';
      const tgtFromLbl=$('transform-target-from-label');if(tgtFromLbl)tgtFromLbl.textContent='Canonical → '+toLabel;
      const tgtToLbl=$('transform-target-to-label');if(tgtToLbl)tgtToLbl.textContent=toLabel+' → Canonical';
      const srcFromLbl=$('transform-source-from-label');if(srcFromLbl)srcFromLbl.textContent='Canonical → '+fromLabel;
    }
    function selectedCatalogRows(){return migrationState.catalog.filter(row=>row.canonicalType&&migrationState.selected.has(row.canonicalType)&&row.supported)}
    // In Sync mode the Fields step must only ever show the object(s) actually enrolled for
    // sync -- not whatever happens to be selected in a Migration draft -- so this diverges
    // from selectedCatalogRows() there instead of overloading migrationState.selected with a
    // second, unrelated meaning.
    function fieldQueueRows(){if(workspaceMode!=='sync')return selectedCatalogRows();return migrationState.catalog.filter(row=>row.canonicalType&&row.supported&&syncConfigState?.objects?.[row.canonicalType]?.enrolledForSync)}
    function mappingObjectState(row){if(!row.totalMappedFields||!row.mappedFields)return {key:'review',label:'Not started',dot:'off'};if(row.mappedFields<row.totalMappedFields)return {key:'review',label:'Needs review',dot:'warning'};return {key:'complete',label:'Complete',dot:''}}
    function renderFieldObjectQueue(){const rows=fieldQueueRows(),query=$('field-object-search').value.trim().toLowerCase(),filter=$('field-object-filter').value,current=$('field-object').value||migrationState.mapping?.type;const visible=rows.filter(row=>{const state=mappingObjectState(row),{sourceObj,targetObj}=resolveRowEndpoints(row,row.canonicalType),text=((sourceObj?.label||row.source.label)+' '+(targetObj?.label||row.target?.label||'')+' '+row.canonicalType).toLowerCase();return (!query||text.includes(query))&&(filter==='all'||state.key===filter)});$('field-object-queue').innerHTML=visible.length?visible.map(row=>{const state=mappingObjectState(row),{sourceObj,targetObj}=resolveRowEndpoints(row,row.canonicalType);return '<button class="mapping-object-item '+(row.canonicalType===current?'active':'')+'" data-field-object="'+row.canonicalType+'"><span><b>'+esc((sourceObj||row.source).label)+' → '+esc((targetObj||row.target).label)+'</b><small>'+row.mappedFields+' of '+row.totalMappedFields+' fields mapped</small></span><span class="mapping-object-status"><span class="mini-dot '+state.dot+'"></span>'+state.label+'</span></button>'}).join(''):'<div class="mapping-object-empty">No selected objects match this view.</div>';$('field-object-queue').querySelectorAll('[data-field-object]').forEach(button=>button.onclick=()=>openFieldObject(button.dataset.fieldObject));const complete=rows.filter(row=>mappingObjectState(row).key==='complete').length,needsReview=rows.length-complete;$('field-progress-count').textContent=complete+' of '+rows.length+' objects complete';$('field-progress-detail').textContent=needsReview?needsReview+' object'+(needsReview===1?'':'s')+' still need mapping review.':'Every selected object is ready for preflight.'}
    function renderValueObjectTabs(){const rows=selectedCatalogRows(),current=$('value-object').value;$('value-object-tabs').innerHTML=rows.length?rows.map((row,index)=>{const {sourceObj,targetObj}=resolveRowEndpoints(row,row.canonicalType);return '<button class="value-object-tab '+(row.canonicalType===current?'active':'')+'" type="button" role="tab" aria-selected="'+(row.canonicalType===current)+'" data-value-object="'+row.canonicalType+'"><span class="value-object-tab-index">'+(index+1)+'</span><span><b>'+esc((sourceObj||row.source).label)+'</b><small>to '+esc((targetObj||row.target).label)+'</small></span></button>'}).join(''):'<div class="mapping-object-empty">Select at least one supported object first.</div>';$('value-object-tabs').querySelectorAll('[data-value-object]').forEach(button=>button.onclick=()=>openValueObject(button.dataset.valueObject))}
    function refreshObjectSelectors(){const currentField=$('field-object').value,currentValue=$('value-object').value,rows=fieldQueueRows(),options=rows.map(row=>{const {sourceObj,targetObj}=resolveRowEndpoints(row,row.canonicalType);return '<option value="'+row.canonicalType+'">'+esc((sourceObj||row.source).label)+' → '+esc((targetObj||row.target).label)+'</option>'}).join('');$('field-object').innerHTML=options;$('value-object').innerHTML=workspaceMode==='sync'?options:selectedCatalogRows().map(row=>{const {sourceObj,targetObj}=resolveRowEndpoints(row,row.canonicalType);return '<option value="'+row.canonicalType+'">'+esc((sourceObj||row.source).label)+' → '+esc((targetObj||row.target).label)+'</option>'}).join('');if(rows.some(row=>row.canonicalType===currentField))$('field-object').value=currentField;if(rows.some(row=>row.canonicalType===currentValue))$('value-object').value=currentValue;renderValueObjectTabs();$('object-selection-count').textContent=migrationState.selected.size+' selected';updateFieldObjectPosition();renderFieldObjectQueue();updateMigrationSummary();updateMigrationStepper()}
    async function openFieldObject(type){if(!type)return;if(document.querySelector('.view.active')?.id==='view-field-mapping'){setStoredFieldMappingOrigin(workspaceMode,type);const hash=fieldMappingHash(workspaceMode,type);if(location.hash!==hash)history.replaceState(null,'',hash)}const {from}=getFieldMappingDirection(type);if(migrationState.mapping?.type===type&&migrationState.mapping?.from===from)return;try{if(migrationState.mapping?.dirty)await saveFieldMappings(false);$('field-object').value=type;await loadFieldWorkspace(type)}catch(e){setDraftStatus(e.message,'error')}}
    function openValueObject(type){if(!type||migrationState.valueContext?.type===type)return;$('value-object').value=type;renderValueObjectTabs();loadValuesWorkspace(type)}
    $('field-object').onchange=()=>openFieldObject($('field-object').value);$('field-object-search').oninput=renderFieldObjectQueue;$('field-object-filter').onchange=renderFieldObjectQueue;
    // Built ONCE per render and shared via <datalist> across every row's <input>, instead of
    // each row carrying its own full <select> option list -- with large orgs (1000+ fields)
    // repeating that list per row multiplied into hundreds of thousands of DOM nodes and froze
    // the tab. A shared datalist keeps the option data in the DOM exactly once.
    function datalistOptions(fields){return fields.map(field=>'<option value="'+esc(field.name)+'">'+esc(field.label)+' · '+esc(field.name)+'</option>').join('')}
    const LITERAL_FIELD_PREFIX='literal:';
    function isLiteralRuleNative(native){
      if(!native)return false;
      if(native.startsWith(LITERAL_FIELD_PREFIX))return true;
      const trimmed=native.trim();
      return (trimmed.length>=2&&trimmed.startsWith('"')&&trimmed.endsWith('"'))||(trimmed.length>=2&&trimmed.startsWith("'")&&trimmed.endsWith("'"));
    }
    function parseLiteralRuleNative(native){
      if(!native)return undefined;
      if(native.startsWith(LITERAL_FIELD_PREFIX))return native.slice(LITERAL_FIELD_PREFIX.length);
      const trimmed=native.trim();
      if((trimmed.length>=2&&trimmed.startsWith('"')&&trimmed.endsWith('"'))||(trimmed.length>=2&&trimmed.startsWith("'")&&trimmed.endsWith("'")))return trimmed.slice(1,-1);
      return undefined;
    }
    function isKnownSourceField(value,sourceMeta){
      if(!value||!sourceMeta?.fields)return false;
      const trimmed=value.trim();
      if(!trimmed||isLiteralRuleNative(trimmed))return false;
      const root=trimmed.split('.')[0];
      return sourceMeta.fields.some(f=>f.name===trimmed||f.name===root)||Boolean(sourceMeta.relationships?.some(r=>r.name===root||r.label===root));
    }
    function displaySourceNative(native,sourceMeta){
      if(!native)return '';
      const literal=parseLiteralRuleNative(native);
      if(literal===undefined)return native;
      return isKnownSourceField(literal,sourceMeta)?'"'+literal+'"':literal;
    }
    function encodeSourceNative(inputValue,sourceMeta){
      const raw=String(inputValue||'');
      if(!raw.trim())return '';
      const explicitLiteral=parseLiteralRuleNative(raw);
      if(explicitLiteral!==undefined)return LITERAL_FIELD_PREFIX+explicitLiteral;
      if(isKnownSourceField(raw.trim(),sourceMeta))return raw.trim();
      return LITERAL_FIELD_PREFIX+raw;
    }
    function picklistOptionLabel(system,fieldLabel,opt){
      const kind=system==='salesforce'?'Picklist (Salesforce)':'Dropdown (HubSpot)';
      return kind+' · '+fieldLabel+': '+opt.label+(opt.value!==opt.label?' · '+opt.value:'');
    }
    function buildSourcePickerGroups(state,targetFieldNative){
      if(!state?.sourceMeta?.fields)return {sysLabel:'Salesforce',toSysLabel:'HubSpot',fieldHeading:'Field list (Salesforce)',picklistHeading:'Dropdown values (HubSpot)',fields:[],picklists:[]};
      const sys=state.from==='hubspot'?'hubspot':'salesforce';
      const toSys=state.to==='salesforce'?'salesforce':'hubspot';
      const sysLabel=sys==='salesforce'?'Salesforce':'HubSpot';
      const toSysLabel=toSys==='salesforce'?'Salesforce':'HubSpot';
      const fieldHeading='Field list ('+sysLabel+')';
      let picklistHeading=(toSys==='salesforce'?'Picklist values':'Dropdown values')+' ('+toSysLabel+')';
      const fieldNames=new Set(state.sourceMeta.fields.map(f=>f.name));
      const fields=state.sourceMeta.fields.map(field=>({
        value:field.name,
        title:field.name,
        subtitle:field.label+' · '+field.name,
        search:(field.name+' '+field.label).toLowerCase(),
      }));
      const picklists=[];
      if(targetFieldNative&&state.targetMeta?.fields?.length){
        const norm=String(targetFieldNative).trim().toLowerCase();
        const targetField=state.targetMeta.fields.find(f=>f.name.toLowerCase()===norm||f.label.toLowerCase()===norm);
        if(targetField?.options?.length){
          picklistHeading=(toSys==='salesforce'?'Picklist values':'Dropdown values')+' ('+toSysLabel+')'+(targetField.label?' · '+targetField.label:'');
          const seenValues=new Set();
          for(const opt of targetField.options){
            if(!opt?.value)continue;
            const val=fieldNames.has(opt.value)?'"'+opt.value+'"':opt.value;
            const key=targetField.name+':'+val;
            if(seenValues.has(key))continue;
            seenValues.add(key);
            const subtitle=picklistOptionLabel(toSys,targetField.label,opt);
            picklists.push({
              value:val,
              title:opt.value,
              subtitle,
              search:(opt.value+' '+opt.label+' '+targetField.label+' '+targetField.name+' '+subtitle).toLowerCase(),
            });
          }
        }
      }
      return {sysLabel,toSysLabel,fieldHeading,picklistHeading,fields,picklists};
    }
    function sourceDatalistOptions(state){
      const {fieldHeading,fields}=buildSourcePickerGroups(state);
      return fields.length?'<optgroup label="'+esc(fieldHeading)+'">'+fields.map(item=>'<option value="'+esc(item.value)+'">'+esc(item.subtitle)+'</option>').join('')+'</optgroup>':'';
    }
    let activeSourceInput=null;
    function positionSourcePickerMenu(input){
      const menu=$('source-picker-menu');
      if(!menu||!input||menu.hidden)return;
      const rect=input.getBoundingClientRect();
      if(rect.bottom<0||rect.top>window.innerHeight){closeSourcePicker();return}
      const spaceBelow=window.innerHeight-rect.bottom-12;
      const maxH=Math.max(180,Math.min(340,spaceBelow>160?spaceBelow:rect.top-12));
      menu.style.width=Math.max(rect.width,320)+'px';
      menu.style.maxHeight=maxH+'px';
      menu.style.left=Math.min(rect.left,window.innerWidth-Math.max(rect.width,320)-12)+'px';
      menu.style.top=(spaceBelow>160?(rect.bottom+4):(rect.top-maxH-4))+'px';
    }
    function closeSourcePicker(){
      const menu=$('source-picker-menu');
      if(menu)menu.hidden=true;
      activeSourceInput=null;
    }
    function openSourcePicker(input,filterByQuery){
      const state=migrationState.mapping,menu=$('source-picker-menu');
      if(!state||!menu||!input)return;
      activeSourceInput=input;
      const targetNative=input.closest('tr')?.querySelector('.target-native')?.value?.trim()||'';
      const {fieldHeading,picklistHeading,fields,picklists}=buildSourcePickerGroups(state,targetNative);
      const rawQuery=input.value.trim();
      const q=filterByQuery?rawQuery.toLowerCase():'';
      const matchedFields=q?fields.filter(item=>item.search.includes(q)):fields;
      const matchedPicklists=q?picklists.filter(item=>item.search.includes(q)):picklists;
      const sections=[];
      if(rawQuery&&!fields.some(f=>f.value===rawQuery)&&!picklists.some(p=>p.value===rawQuery)){
        sections.push('<div class="source-picker-heading">Text value</div><button type="button" class="source-picker-item" data-picker-value="'+esc(rawQuery)+'"><b>'+esc(rawQuery)+'</b><span>Use as custom text value</span></button>');
      }
      if(matchedPicklists.length){
        sections.push('<div class="source-picker-heading">'+esc(picklistHeading)+'</div>'+matchedPicklists.slice(0,300).map(item=>'<button type="button" class="source-picker-item" data-picker-value="'+esc(item.value)+'"><b>'+esc(item.title)+'</b><span>'+esc(item.subtitle)+'</span></button>').join(''));
      }
      if(matchedFields.length){
        sections.push('<div class="source-picker-heading">'+esc(fieldHeading)+'</div>'+matchedFields.slice(0,250).map(item=>'<button type="button" class="source-picker-item" data-picker-value="'+esc(item.value)+'"><b>'+esc(item.title)+'</b><span>'+esc(item.subtitle)+'</span></button>').join(''));
      }
      if(!sections.length){
        menu.hidden=true;return;
      }
      menu.innerHTML=sections.join('');
      menu.hidden=false;
      positionSourcePickerMenu(input);
      menu.querySelectorAll('[data-picker-value]').forEach(btn=>{
        btn.onmousedown=e=>{
          e.preventDefault();
          input.value=btn.dataset.pickerValue;
          if(typeof input.onchange==='function')input.onchange();
          closeSourcePicker();
        };
      });
    }
    window.addEventListener('scroll',()=>{if(activeSourceInput)positionSourcePickerMenu(activeSourceInput)},true);
    window.addEventListener('resize',()=>{if(activeSourceInput)positionSourcePickerMenu(activeSourceInput)});
    function transformOptionList(value){return transformIds.map(id=>'<option value="'+id+'" '+(id===(value||'identity')?'selected':'')+'>'+esc(transformMeta[id][0])+' — '+esc(transformMeta[id][1])+'</option>').join('')}
    function transformSummary(values){const active=values.filter(value=>value&&value!=='identity');if(!active.length)return 'Identity';if(active.length===1)return transformMeta[active[0]][0];return active.length+' transforms'}
    function transformHidden(cls,value){return '<input type="hidden" class="'+cls+'" value="'+esc(value||'identity')+'">'}
    function conflictStrategyLabel(strategy){return strategy==='source-of-truth'?'Source of truth':strategy==='last-write-wins'?'Last write wins':strategy==='field-merge'?'Field merge':strategy||'Last write wins'}
    function getObjectSot(type){return (type&&syncConfigState?.objects?.[type]?.sourceOfTruth)||syncConfigState?.sourceOfTruth||'salesforce'}
    function isMandatoryField(canonical, type){
      const c=String(canonical||'').toLowerCase();
      const t=String(type||'').toLowerCase();
      if(c==='recordid'||c==='id'||c==='salesforceid')return true;
      if((t==='contact'||t==='contacts')&&c==='email')return true;
      return false;
    }
    function ensureAutoMappedFields(state){
      if(!state?.sourceMap||!state?.targetMap)return;
      const t=String(state.type||'').toLowerCase();
      const fromSf=state.from==='salesforce';
      function addField(canonical, sfNative, hsNative){
        const sNative=fromSf?sfNative:hsNative;
        const tNative=fromSf?hsNative:sfNative;
        if(!state.canonicals.includes(canonical)){
          state.canonicals.unshift(canonical);
        }
        let sRule=state.sourceMap.rules.find(r=>r.canonical===canonical);
        if(!sRule){
          sRule={canonical,native:sNative};
          state.sourceMap.rules.push(sRule);
        }else if(!sRule.native||(canonical==='recordId'&&sRule.native==='hs_object_id')){
          sRule.native=sNative;
        }
        let tRule=state.targetMap.rules.find(r=>r.canonical===canonical);
        if(!tRule){
          tRule={canonical,native:tNative};
          state.targetMap.rules.push(tRule);
        }else if(!tRule.native||(canonical==='recordId'&&tRule.native==='hs_object_id')){
          tRule.native=tNative;
        }
      }
      if(t==='company'||t==='account'||t==='contact'||t==='contacts'||t==='deal'||t==='deals'){
        addField('recordId','Id','migrated_record_id');
      }
      if(t==='company'||t==='account'){
        addField('name','Name','name');
        addField('domain','Website','domain');
      }else if(t==='contact'||t==='contacts'){
        addField('email','Email','email');
        if(!state.canonicals.includes('name')&&!state.canonicals.includes('lastName')){
          addField('name','Name','firstname');
        }
      }else if(t==='deal'||t==='deals'){
        addField('amount','Amount','amount');
        if(!state.canonicals.includes('association')&&!state.canonicals.includes('accountId')){
          addField('association','AccountId','associatedcompanyid');
        }
      }
    }
    async function loadFieldWorkspace(type){if(!type)return;const loadToken=++migrationState.fieldLoadToken;$('field-map-rows').innerHTML='<tr><td colspan="7" class="empty">Loading schemas and mappings…</td></tr>';$('field-map-notice').hidden=true;closeTransformLab();closeSourcePicker();
      if(!syncConfigState){try{syncConfigState=await api('/api/sync/settings')}catch{}}
      const row=migrationState.catalog.find(item=>item.canonicalType===type);if(!row)return;
      const {from,to,sourceObj,targetObj}=resolveRowEndpoints(row,type);if(!sourceObj||!targetObj)return;
      updateFieldMappingDirectionHeaders(from,to);
      $('field-object').value=type;$('field-current-name').textContent=sourceObj.label+' → '+targetObj.label;updateFieldObjectPosition();renderFieldObjectQueue();
      try{const [sourceMeta,targetMeta,sourceMap,targetMap,keyData,valueData]=await Promise.all([getMetadata(from,sourceObj.id),getMetadata(to,targetObj.id),api('/api/mappings/'+from+'/'+type),api('/api/mappings/'+to+'/'+type),api('/api/object-mappings/'+type).catch(()=>({naturalKeyFields:[]})),api('/api/value-mappings/'+type).catch(()=>({entries:[]}))]);
        if(loadToken!==migrationState.fieldLoadToken)return;
        if(from==='hubspot')ensureHubSpotMigratedRecordId(sourceMeta);
        if(to==='hubspot')ensureHubSpotMigratedRecordId(targetMeta);
        const sourceByCanonical=new Map(sourceMap.rules.map(rule=>[rule.canonical,rule])),targetByCanonical=new Map(targetMap.rules.map(rule=>[rule.canonical,rule]));const canonicals=[...new Set([...sourceByCanonical.keys(),...targetByCanonical.keys()])];
        migrationState.mapping={type,from,to,sourceMeta,targetMeta,sourceMap,targetMap,canonicals,removed:[],dirty:false,valueMappings:valueData?.entries||[]};
        ensureAutoMappedFields(migrationState.mapping);
        renderFieldMappings();updateFieldObjectPosition();renderFieldObjectQueue();
        renderFieldWorkspaceNaturalKey(type,keyData,sourceMeta,targetMeta,sourceByCanonical,targetByCanonical)}catch(e){if(loadToken===migrationState.fieldLoadToken)$('field-map-rows').innerHTML='<tr><td colspan="7" class="empty">'+esc(e.message)+'</td></tr>'}}
    let fieldSortCol=null,fieldSortAsc=true;
    function updateFieldSortHeaders(){
      document.querySelectorAll('.mapping-table th[data-sort]').forEach(th=>{
        const col=th.dataset.sort,icon=th.querySelector('.sort-icon');
        if(fieldSortCol===col){
          th.classList.toggle('sorted-asc',fieldSortAsc);
          th.classList.toggle('sorted-desc',!fieldSortAsc);
          th.setAttribute('aria-sort',fieldSortAsc?'ascending':'descending');
          if(icon)icon.textContent=fieldSortAsc?'▲':'▼';
        }else{
          th.classList.remove('sorted-asc','sorted-desc');
          th.setAttribute('aria-sort','none');
          if(icon)icon.textContent='↕';
        }
      });
    }
    function sortFieldMappings(col){
      if(fieldSortCol===col){fieldSortAsc=!fieldSortAsc}
      else{fieldSortCol=col;fieldSortAsc=true}
      updateFieldSortHeaders();
      const tbody=$('field-map-rows');if(!tbody)return;
      const rows=[...tbody.querySelectorAll('tr[data-canonical]')];
      if(!rows.length)return;
      rows.sort((a,b)=>{
        let valA='',valB='';
        if(col==='source'){
          valA=(a.querySelector('.source-native')?.value||'').trim().toLowerCase();
          valB=(b.querySelector('.source-native')?.value||'').trim().toLowerCase();
        }else if(col==='canonical'){
          valA=(a.querySelector('.canonical')?.value||a.dataset.canonical||'').trim().toLowerCase();
          valB=(b.querySelector('.canonical')?.value||b.dataset.canonical||'').trim().toLowerCase();
        }else if(col==='target'){
          valA=(a.querySelector('.target-native')?.value||'').trim().toLowerCase();
          valB=(b.querySelector('.target-native')?.value||'').trim().toLowerCase();
        }else if(col==='sot'){
          valA=(a.querySelector('.field-sot')?.value||'').trim().toLowerCase();
          valB=(b.querySelector('.field-sot')?.value||'').trim().toLowerCase();
        }
        if(!valA&&valB)return 1;
        if(valA&&!valB)return -1;
        if(!valA&&!valB)return 0;
        const cmp=valA.localeCompare(valB,undefined,{numeric:true,sensitivity:'base'});
        return fieldSortAsc?cmp:-cmp;
      });
      rows.forEach(tr=>tbody.appendChild(tr));
      if(migrationState.mapping?.canonicals){
        const order=new Map(rows.map((r,i)=>[r.dataset.canonical,i]));
        migrationState.mapping.canonicals.sort((x,y)=>(order.get(x)??9999)-(order.get(y)??9999));
      }
    }
    document.querySelectorAll('.mapping-table th[data-sort]').forEach(th=>{
      th.tabIndex=0;
      th.onclick=()=>sortFieldMappings(th.dataset.sort);
      th.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sortFieldMappings(th.dataset.sort)}};
    });

    function renderFieldMappings(){const state=migrationState.mapping;if(!state)return;const sourceBy=new Map(state.sourceMap.rules.map(r=>[r.canonical,r])),targetBy=new Map(state.targetMap.rules.map(r=>[r.canonical,r]));
      $('source-native-datalist').innerHTML=sourceDatalistOptions(state);$('target-native-datalist').innerHTML=datalistOptions(state.targetMeta.fields);
      const removed=new Set(state.removed),visible=state.canonicals.filter(canonical=>!removed.has(canonical));
      if(fieldSortCol){
        visible.sort((a,b)=>{
          let valA='',valB='';
          if(fieldSortCol==='source'){
            valA=displaySourceNative(sourceBy.get(a)?.native||'',state.sourceMeta).trim().toLowerCase();
            valB=displaySourceNative(sourceBy.get(b)?.native||'',state.sourceMeta).trim().toLowerCase();
          }else if(fieldSortCol==='canonical'){
            valA=a.trim().toLowerCase();
            valB=b.trim().toLowerCase();
          }else if(fieldSortCol==='target'){
            valA=(targetBy.get(a)?.native||'').trim().toLowerCase();
            valB=(targetBy.get(b)?.native||'').trim().toLowerCase();
          }else if(fieldSortCol==='sot'){
            valA=(sourceBy.get(a)?.sourceOfTruth||targetBy.get(a)?.sourceOfTruth||'salesforce').trim().toLowerCase();
            valB=(sourceBy.get(b)?.sourceOfTruth||targetBy.get(b)?.sourceOfTruth||'salesforce').trim().toLowerCase();
          }
          if(!valA&&valB)return 1;
          if(valA&&!valB)return -1;
          if(!valA&&!valB)return 0;
          const cmp=valA.localeCompare(valB,undefined,{numeric:true,sensitivity:'base'});
          return fieldSortAsc?cmp:-cmp;
        });
      }
      $('field-map-rows').innerHTML=visible.map(canonical=>{const s=sourceBy.get(canonical)||{},t=targetBy.get(canonical)||{};
        const transforms=[s.toCanonical||'identity',s.fromCanonical||'identity',t.toCanonical||'identity',t.fromCanonical||'identity'];
        const currentSot=s.sourceOfTruth||t.sourceOfTruth||'salesforce';
        const shownSource=displaySourceNative(s.native||'',state.sourceMeta);
        const mandatory=isMandatoryField(canonical,state.type);
        const sField=state.sourceMeta?.fields?.find(f=>f.name===(s.native||'').replace(/^literal:/,''));
        const tField=state.targetMeta?.fields?.find(f=>f.name===(t.native||'').replace(/^literal:/,''));
        const isPicklist=Boolean(sField?.options?.length||tField?.options?.length||/(picklist|enum)/i.test(sField?.type||'')||/(picklist|enum)/i.test(tField?.type||''));
        const valCount=(state.valueMappings||[]).filter(v=>v.canonicalField===canonical).length;
        const valuesBtn=valCount>0
          ?'<button class="mapping-values-btn has-mappings" type="button" data-values-canonical="'+esc(canonical)+'" title="'+valCount+' alternate value mappings active">'+valCount+' mapped</button>'
          :(isPicklist
            ?'<button class="mapping-values-btn is-picklist" type="button" data-values-canonical="'+esc(canonical)+'" title="Map dropdown values">Map values</button>'
            :'<button class="mapping-values-btn" type="button" data-values-canonical="'+esc(canonical)+'" title="Map values">Values</button>');
        const actionBtn=mandatory
          ?'<button class="mapping-remove" disabled title="Mandatory field (cannot be removed)" style="opacity:0.4;cursor:not-allowed">Locked</button>'
          :'<button class="mapping-remove" data-remove-canonical="'+esc(canonical)+'" aria-label="Remove '+esc(canonical)+' mapping" title="Remove this mapping">Remove</button>';
        return '<tr data-canonical="'+esc(canonical)+'"><td class="mapping-action">'+actionBtn+'</td><td><input class="target-native" list="target-native-datalist" value="'+esc(t.native||'')+'" placeholder="— Not mapped —"></td><td><input class="canonical" value="'+esc(canonical)+'" '+(mandatory?'readonly style="opacity:0.85"':'')+'></td><td>'+valuesBtn+'</td><td>'+transformHidden('source-to',transforms[0])+transformHidden('source-from',transforms[1])+transformHidden('target-to',transforms[2])+transformHidden('target-from',transforms[3])+'<button class="mapping-transform" data-transform-canonical="'+esc(canonical)+'">'+esc(transformSummary([transforms[0],transforms[3]]))+'<small>Configure</small></button></td><td><input class="source-native" autocomplete="off" value="'+esc(shownSource)+'" placeholder="Select field, picklist value, or enter text…"></td><td><select class="field-sot" data-canonical="'+esc(canonical)+'"><option value="salesforce" '+(currentSot==='salesforce'?'selected':'')+'>Salesforce</option><option value="hubspot" '+(currentSot==='hubspot'?'selected':'')+'>HubSpot</option><option value="last-write-wins" '+(currentSot==='last-write-wins'?'selected':'')+'>Last write wins</option></select></td></tr>';
      }).join('')||'<tr><td colspan="7" class="empty">No mappings remain. Save to persist this empty mapping set, or undo the removal.</td></tr>';
      refreshMappingCoverage();updateFieldSortHeaders();$('field-map-notice').hidden=!state.removed.length;$('field-map-notice-text').textContent=state.removed.length+' mapping'+(state.removed.length===1?'':'s')+' marked for removal. Save mappings to apply.';document.querySelectorAll('[data-remove-canonical]').forEach(button=>button.onclick=()=>{state.removed.push(button.dataset.removeCanonical);state.dirty=true;closeTransformLab();closeSourcePicker();renderFieldMappings()});document.querySelectorAll('[data-transform-canonical]').forEach(button=>button.onclick=()=>openTransformLab(button));document.querySelectorAll('[data-values-canonical]').forEach(button=>button.onclick=()=>openPicklistValueModal(button.dataset.valuesCanonical));document.querySelectorAll('#field-map-rows tr[data-canonical] input, #field-map-rows tr[data-canonical] select.field-sot').forEach(control=>{control.oninput=control.onchange=()=>{state.dirty=true;refreshMappingCoverage();applyMappingFilters();setDraftStatus('Mapping changes not saved');if(control.classList.contains('source-native'))openSourcePicker(control,true);if(control.classList.contains('target-native')&&activeSourceInput&&activeSourceInput.closest('tr')===control.closest('tr'))openSourcePicker(activeSourceInput,false)}});document.querySelectorAll('#field-map-rows tr[data-canonical] .source-native').forEach(srcInput=>{srcInput.onfocus=()=>openSourcePicker(srcInput,false);srcInput.onclick=()=>openSourcePicker(srcInput,false);srcInput.onblur=()=>setTimeout(()=>{if(activeSourceInput===srcInput)closeSourcePicker()},150);srcInput.onkeydown=e=>{if(e.key==='Escape')closeSourcePicker()}});applyMappingFilters()}
    function refreshMappingCoverage(){const state=migrationState.mapping;if(!state)return;const rows=[...$('field-map-rows').querySelectorAll('tr[data-canonical]')],ready=rows.filter(tr=>tr.querySelector('.source-native').value&&tr.querySelector('.target-native').value).length,total=rows.length,pct=total?Math.round(ready/total*100):0;$('coverage-number').textContent=pct+'%';$('coverage-list').innerHTML='<div><span>Mapped</span><b>'+ready+'</b></div><div><span>Needs review</span><b>'+(total-ready)+'</b></div><div><span>Removed</span><b>'+state.removed.length+'</b></div><div><span>Source fields</span><b>'+state.sourceMeta.fields.length+'</b></div><div><span>Target fields</span><b>'+state.targetMeta.fields.length+'</b></div>';$('summary-coverage').textContent=pct+'%'}
    function applyMappingFilters(){const query=$('field-search').value.trim().toLowerCase(),filter=$('field-filter').value;document.querySelectorAll('#field-map-rows tr[data-canonical]').forEach(tr=>{const source=tr.querySelector('.source-native').value||'',target=tr.querySelector('.target-native').value||'',canonical=tr.querySelector('.canonical').value,sot=tr.querySelector('.field-sot')?.value||'',text=(source+' '+target+' '+canonical+' '+sot).toLowerCase(),ready=tr.querySelector('.source-native').value&&tr.querySelector('.target-native').value,transformed=['source-to','target-from'].some(cls=>tr.querySelector('.'+cls).value!=='identity');tr.hidden=Boolean((query&&!text.includes(query))||(filter==='review'&&ready)||(filter==='transformed'&&!transformed))})}
    $('field-search').oninput=applyMappingFilters;$('field-filter').onchange=applyMappingFilters;
    function updateFieldObjectPosition(){const select=$('field-object'),count=select.options.length,index=select.selectedIndex;$('field-object-position').textContent=count&&index>=0?(index+1)+' of '+count:'No objects'}
    async function moveFieldObject(delta){const select=$('field-object'),next=select.selectedIndex+delta;if(next<0||next>=select.options.length)return;if(migrationState.mapping?.dirty)await saveFieldMappings(false);select.selectedIndex=next;if(document.querySelector('.view.active')?.id==='view-field-mapping'){setStoredFieldMappingOrigin(workspaceMode,select.value);const hash=fieldMappingHash(workspaceMode,select.value);if(location.hash!==hash)history.replaceState(null,'',hash)}await loadFieldWorkspace(select.value)}
    $('save-next-field-object').onclick=async()=>{try{if(migrationState.mapping?.dirty)await saveFieldMappings(false);if(workspaceMode==='sync'){history.replaceState(null,'','#sync');selectView('sync')}else await moveFieldObject(1)}catch(e){setDraftStatus(e.message,'error')}};
    function previewTransform(id,value,direction){if(!id||id==='identity')return value;if(id==='trim')return typeof value==='string'?value.trim():value;if(id==='lowercase')return typeof value==='string'?value.trim().toLowerCase():value;if(id==='domain'){if(typeof value!=='string'||!value)return value;try{const url=new URL(value.includes('://')?value:'http://'+value);return url.hostname.replace(/^www\\./,'').toLowerCase()}catch{return value.toLowerCase()}}if(id==='number'){if(value===null||value==='')return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:value}if(id==='boolean'){if(typeof value==='boolean'||value===null)return value;if(typeof value==='string')return ['true','1','yes'].includes(value.trim().toLowerCase());return Boolean(value)}if(id==='yes-no'){if(value===null||value==='')return null;if(direction==='fromCanonical'){if(typeof value==='boolean')return value?'yes':'no';if(typeof value==='string'){const l=value.trim().toLowerCase();if(['yes','true','1'].includes(l))return 'yes';if(['no','false','0'].includes(l))return 'no';return value}return value?'yes':'no'}if(direction==='toCanonical'){if(typeof value==='boolean')return value;if(typeof value==='string'){const l=value.trim().toLowerCase();if(['yes','true','1'].includes(l))return true;if(['no','false','0'].includes(l))return false}return Boolean(value)}if(typeof value==='boolean')return value?'yes':'no';if(typeof value==='string')return ['yes','true','1'].includes(value.trim().toLowerCase());return value}if(id==='true-false'){if(value===null||value==='')return null;if(direction==='fromCanonical'){if(typeof value==='boolean')return value?'true':'false';if(typeof value==='string'){const l=value.trim().toLowerCase();if(['true','1','yes'].includes(l))return 'true';if(['false','0','no'].includes(l))return 'false';return value}return value?'true':'false'}if(direction==='toCanonical'){if(typeof value==='boolean')return value;if(typeof value==='string'){const l=value.trim().toLowerCase();if(['true','1','yes'].includes(l))return true;if(['false','0','no'].includes(l))return false}return Boolean(value)}if(typeof value==='boolean')return value?'true':'false';if(typeof value==='string')return value.trim().toLowerCase()==='true';return value}if(id==='iso-date'){const parsed=new Date(value);return Number.isNaN(parsed.getTime())?value:parsed.toISOString()}if(id==='phone')return typeof value==='string'?value.trim().replace(/[^\\d+]/g,''):value;return value}
    function previewValue(value){return typeof value==='string'?value:JSON.stringify(value)}
    function updateTransformPreview(){
      const parseSample=(val)=>{if(val==='true')return true;if(val==='false')return false;return val};
      const sample=$('transform-sample').value;
      $('transform-forward-result').textContent=sample!==''?previewValue(previewTransform($('transform-target-from').value,previewTransform($('transform-source-to').value,parseSample(sample),'toCanonical'),'fromCanonical')):'Enter a sample value';
      const sampleReverse=$('transform-sample-reverse').value;
      $('transform-reverse-result').textContent=sampleReverse!==''?previewValue(previewTransform($('transform-source-from').value,previewTransform($('transform-target-to').value,parseSample(sampleReverse),'toCanonical'),'fromCanonical')):'Enter a sample value';
    }
    const transformSelectIds=['transform-source-to','transform-target-from','transform-target-to','transform-source-from'];
    const transformFieldPairs=[['source-to','transform-source-to'],['target-from','transform-target-from'],['target-to','transform-target-to'],['source-from','transform-source-from']];
    function openTransformLab(button){
      const row=button.closest('tr'),canonical=row.querySelector('.canonical').value,source=row.querySelector('.source-native').value||'Unmapped source',target=row.querySelector('.target-native').value||'Unmapped target';
      migrationState.transformRow=row;
      $('transform-field-name').textContent=canonical+' transform';
      $('transform-field-path').textContent=source+' → '+target;
      const sLabel=workspaceMode==='sync'?'Salesforce':($('mig-from')?.value==='hubspot'?'HubSpot':'Salesforce');
      const tLabel=workspaceMode==='sync'?'HubSpot':($('mig-from')?.value==='hubspot'?'Salesforce':'HubSpot');
      const sToLbl=$('transform-source-to-lbl');if(sToLbl)sToLbl.textContent='Normalize source value ('+sLabel+' → Canonical)';
      const tFromLbl=$('transform-target-from-lbl');if(tFromLbl)tFromLbl.textContent='Format destination value (Canonical → '+tLabel+')';
      const tToLbl=$('transform-target-to-lbl');if(tToLbl)tToLbl.textContent='Normalize target value ('+tLabel+' → Canonical)';
      const sFromLbl=$('transform-source-from-lbl');if(sFromLbl)sFromLbl.textContent='Format source value (Canonical → '+sLabel+')';
      for(const [cls,id] of transformFieldPairs){$(id).innerHTML=transformOptionList(row.querySelector('.'+cls).value)}
      $('transform-sample').value='';$('transform-sample-reverse').value='';
      $('transform-lab').hidden=false;updateTransformPreview();
    }
    function closeTransformLab(){$('transform-lab').hidden=true;migrationState.transformRow=null}
    $('close-transform-lab').onclick=closeTransformLab;$('transform-sample').oninput=updateTransformPreview;$('transform-sample-reverse').oninput=updateTransformPreview;transformSelectIds.forEach(id=>$(id).onchange=updateTransformPreview);
    $('reset-transforms').onclick=()=>{transformSelectIds.forEach(id=>$(id).value='identity');updateTransformPreview()};
    $('apply-transforms').onclick=()=>{const row=migrationState.transformRow;if(!row)return;for(const [cls,id] of transformFieldPairs)row.querySelector('.'+cls).value=$(id).value;row.querySelector('.mapping-transform').innerHTML=esc(transformSummary(transformFieldPairs.map(([,id])=>$(id).value)))+'<small>Configure</small>';migrationState.mapping.dirty=true;setDraftStatus('Mapping changes not saved');applyMappingFilters();closeTransformLab()};
    $('undo-field-removal').onclick=()=>{const state=migrationState.mapping;if(!state?.removed.length)return;state.removed.pop();renderFieldMappings()};
    $('remove-all-fields').onclick=()=>{const state=migrationState.mapping;if(!state)return;const remaining=state.canonicals.filter(c=>!state.removed.includes(c)&&!isMandatoryField(c,state.type));if(!remaining.length)return;state.removed.push(...remaining);state.dirty=true;closeTransformLab();renderFieldMappings();setDraftStatus('Mapping changes not saved')};
    $('add-field-mapping').onclick=()=>{const state=migrationState.mapping;if(!state)return;let n=state.canonicals.length+1,name='new_field_'+n;while(state.canonicals.includes(name)){n+=1;name='new_field_'+n}
      state.canonicals.push(name);state.dirty=true;$('field-search').value='';$('field-filter').value='all';renderFieldMappings();setDraftStatus('Mapping changes not saved');
      const input=document.querySelector('#field-map-rows tr[data-canonical="'+CSS.escape(name)+'"] .canonical');if(input){input.focus();input.select()}};
    function compatibleMappingAdditions(sourceMeta,targetMeta,sourceRules,targetRules){const used=new Set([...sourceRules,...targetRules].map(rule=>rule.canonical.toLowerCase())),additions=[];for(const source of sourceMeta.fields){const match=targetMeta.fields.find(target=>!target.readOnly&&(target.name.toLowerCase()===source.name.toLowerCase()||target.label.toLowerCase()===source.label.toLowerCase()));const canonical=source.name.replace(/[^a-zA-Z0-9]/g,'');if(match&&canonical&&!used.has(canonical.toLowerCase())){additions.push({canonical,source:source.name,target:match.name});used.add(canonical.toLowerCase())}}return additions}
    function autoMapCurrentObject(){const state=migrationState.mapping;if(!state)return 0;const additions=compatibleMappingAdditions(state.sourceMeta,state.targetMeta,state.sourceMap.rules,state.targetMap.rules);for(const item of additions){state.canonicals.push(item.canonical);state.sourceMap.rules.push({canonical:item.canonical,native:item.source});state.targetMap.rules.push({canonical:item.canonical,native:item.target})}if(additions.length){state.dirty=true;setDraftStatus(additions.length+' compatible mappings ready to review');renderFieldMappings()}return additions.length}
    $('auto-map').onclick=()=>autoMapCurrentObject();
    $('auto-map-all').onclick=async()=>{const rows=fieldQueueRows();if(!rows.length)return;const button=$('auto-map-all'),current=migrationState.mapping?.type;button.disabled=true;button.textContent='Finding matches…';try{const batch=await Promise.all(rows.map(async row=>{const {from,to,sourceObj,targetObj}=resolveRowEndpoints(row,row.canonicalType);const [sourceMeta,targetMeta,sourceMap,targetMap]=await Promise.all([getMetadata(from,(sourceObj||row.source).id),getMetadata(to,(targetObj||row.target).id),api('/api/mappings/'+from+'/'+row.canonicalType),api('/api/mappings/'+to+'/'+row.canonicalType)]);return {row,from,to,sourceObj:sourceObj||row.source,sourceMap,targetMap,additions:compatibleMappingAdditions(sourceMeta,targetMeta,sourceMap.rules,targetMap.rules)}})),added=batch.reduce((total,item)=>total+item.additions.length,0),summary=batch.filter(item=>item.additions.length).map(item=>item.sourceObj.label+': '+item.additions.length).join(' · ');if(!added){setDraftStatus('No new exact matches found','saved');return}const confirmed=await requestTypedConfirmation({title:'Review automatic mappings',message:'Found '+added+' exact matches across '+batch.filter(item=>item.additions.length).length+' objects. '+summary+'. Existing mappings and transforms are preserved.',token:'MAP ALL',buttonLabel:'Apply mappings'});if(!confirmed)return;button.textContent='Applying mappings…';for(const item of batch){if(!item.additions.length)continue;await Promise.all([api('/api/mappings/'+item.from+'/'+item.row.canonicalType,{method:'PUT',body:JSON.stringify({rules:[...item.sourceMap.rules,...item.additions.map(entry=>({canonical:entry.canonical,native:entry.source}))]})}),api('/api/mappings/'+item.to+'/'+item.row.canonicalType,{method:'PUT',body:JSON.stringify({rules:[...item.targetMap.rules,...item.additions.map(entry=>({canonical:entry.canonical,native:entry.target}))]})})])}migrationState.metadata.clear();markPlanDirty();queuePlanAutosave();await loadCatalog(workspaceMode==='sync'?'salesforce':$('mig-from').value);if(current)await loadFieldWorkspace(current);setDraftStatus(added+' mappings added across selected objects','saved')}catch(e){setDraftStatus(e.message,'error')}finally{button.disabled=false;button.textContent='Auto-map selected objects'}};
    function showSyncPausedWarning(message){showWarning(message,{label:'Open Sync tab →',onClick:()=>{history.replaceState(null,'','#sync');selectView('sync')}})}
    async function saveFieldMappings(reload=true){const state=migrationState.mapping;if(!state)return;const rows=[...$('field-map-rows').querySelectorAll('tr[data-canonical]')];const existingSource=new Map(state.sourceMap.rules.map(r=>[r.canonical,r])),existingTarget=new Map(state.targetMap.rules.map(r=>[r.canonical,r]));const sourceRules=[],targetRules=[];
      for(const tr of rows){const canonical=tr.querySelector('.canonical').value.trim(),rawSource=tr.querySelector('.source-native').value,sourceNative=encodeSourceNative(rawSource,state.sourceMeta),targetNative=tr.querySelector('.target-native').value.trim();if(!canonical||!sourceNative||!targetNative)continue;const sot=tr.querySelector('.field-sot')?.value||undefined;const oldS=existingSource.get(tr.dataset.canonical)||{},oldT=existingTarget.get(tr.dataset.canonical)||{};sourceRules.push({...oldS,canonical,native:sourceNative,toCanonical:tr.querySelector('.source-to').value,fromCanonical:tr.querySelector('.source-from').value,sourceOfTruth:sot});targetRules.push({...oldT,canonical,native:targetNative,toCanonical:tr.querySelector('.target-to').value,fromCanonical:tr.querySelector('.target-from').value,sourceOfTruth:sot})}
      const button=$('save-field-map');showProgressBar();try{button.disabled=true;button.textContent='Saving…';const results=await Promise.all([api('/api/mappings/'+state.from+'/'+state.type,{method:'PUT',body:JSON.stringify({rules:sourceRules})}),api('/api/mappings/'+state.to+'/'+state.type,{method:'PUT',body:JSON.stringify({rules:targetRules})})]);state.dirty=false;migrationState.metadata.clear();markPlanDirty();queuePlanAutosave();await loadCatalog(workspaceMode==='sync'?'salesforce':$('mig-from').value);if(reload)await loadFieldWorkspace(state.type);button.textContent='Saved ✓';setTimeout(()=>button.textContent='Save mappings',1200);
        if(results.some(r=>r.syncPaused))showSyncPausedWarning('Heads up: '+state.type+' was live-syncing, so saving this mapping change paused both real-time and scheduled sync for it. Review the mapping, then re-enable it from the Sync tab when ready.');
        else showNotice('Field mappings saved.');
        if(workspaceMode==='sync')await maybeOfferNaturalKeyStep();
      }catch(e){button.textContent='Save mappings';throw e}finally{button.disabled=false;hideProgressBar()}}
    $('save-field-map').onclick=()=>saveFieldMappings().catch(e=>setDraftStatus(e.message,'error'));

    async function openPicklistValueModal(canonicalField){
      const state=migrationState.mapping;
      if(!state||!canonicalField)return;
      const s=state.sourceMap.rules.find(r=>r.canonical===canonicalField)||{};
      const t=state.targetMap.rules.find(r=>r.canonical===canonicalField)||{};
      const sField=state.sourceMeta?.fields?.find(f=>f.name===(s.native||'').replace(/^literal:/,''));
      const tField=state.targetMeta?.fields?.find(f=>f.name===(t.native||'').replace(/^literal:/,''));
      const isSfSource=(state.from==='salesforce');
      const sfOptions=isSfSource?(sField?.options||[]):(tField?.options||[]);
      const hsOptions=isSfSource?(tField?.options||[]):(sField?.options||[]);
      const sfNativeName=isSfSource?(s.native||''):(t.native||'');
      const hsNativeName=isSfSource?(t.native||''):(s.native||'');

      $('picklist-modal-title').textContent='Map values: '+canonicalField;
      $('picklist-modal-subtitle').textContent='Salesforce ('+(sfNativeName||'unmapped')+') ⇄ HubSpot ('+(hsNativeName||'unmapped')+')';
      $('picklist-modal-message').className='settings-message';
      $('picklist-modal-message').textContent='';
      $('picklist-value-rows').innerHTML='<tr><td colspan="4" class="empty">Loading values…</td></tr>';
      $('picklist-value-modal').hidden=false;

      let entries=[];
      try{
        const res=await api('/api/value-mappings/'+state.type+'/'+encodeURIComponent(canonicalField));
        entries=res.entries||[];
      }catch(e){
        entries=[];
      }

      function buildOptionList(options,selectedVal){
        let hasMatch=false;
        let html='<option value="">— Select option —</option>';
        for(const opt of options){
          const isSel=(opt.value===selectedVal);
          if(isSel)hasMatch=true;
          const display=opt.label&&opt.label!==opt.value?opt.label+' ('+opt.value+')':opt.value;
          html+='<option value="'+esc(opt.value)+'"'+(isSel?' selected':'')+'>'+esc(display)+'</option>';
        }
        html+='<option value="__custom__"'+(!hasMatch&&selectedVal?' selected':'')+'>✏️ Custom value…</option>';
        return {html,hasMatch};
      }

      function renderModalRows(){
        if(!entries.length){
          $('picklist-value-rows').innerHTML='<tr><td colspan="4" class="empty">No values mapped yet. Click "Auto-match" or "+ Add mapping row".</td></tr>';
          $('picklist-modal-count').textContent='0 mapped';
          return;
        }
        $('picklist-modal-count').textContent=entries.length+' mapped';
        $('picklist-value-rows').innerHTML=entries.map((entry,idx)=>{
          const sfVal=entry.salesforceValue||'';
          const hsVal=entry.hubspotValue||'';
          const sfOpts=buildOptionList(sfOptions,sfVal);
          const hsOpts=buildOptionList(hsOptions,hsVal);
          const showSfCustom=!sfOpts.hasMatch&&sfVal!=='';
          const showHsCustom=!hsOpts.hasMatch&&hsVal!=='';

          return '<tr data-row-index="'+idx+'">'
            +'<td>'
              +'<select class="picklist-sf-select">'+sfOpts.html+'</select>'
              +'<input class="picklist-sf-custom custom-input" placeholder="Custom Salesforce value" value="'+esc(sfVal)+'" style="'+(showSfCustom?'':'display:none;')+'">'
            +'</td>'
            +'<td class="picklist-row-arrow">⇄</td>'
            +'<td>'
              +'<select class="picklist-hs-select">'+hsOpts.html+'</select>'
              +'<input class="picklist-hs-custom custom-input" placeholder="Custom HubSpot value" value="'+esc(hsVal)+'" style="'+(showHsCustom?'':'display:none;')+'">'
            +'</td>'
            +'<td style="text-align:center"><button class="mapping-remove picklist-del-row" type="button" data-del-index="'+idx+'" title="Remove this row">✕</button></td>'
          +'</tr>';
        }).join('');

        document.querySelectorAll('#picklist-value-rows tr[data-row-index]').forEach(tr=>{
          const idx=Number(tr.dataset.rowIndex);
          const sfSelect=tr.querySelector('.picklist-sf-select');
          const sfCustom=tr.querySelector('.picklist-sf-custom');
          const hsSelect=tr.querySelector('.picklist-hs-select');
          const hsCustom=tr.querySelector('.picklist-hs-custom');
          const delBtn=tr.querySelector('.picklist-del-row');

          if(sfSelect){
            sfSelect.onchange=()=>{
              if(sfSelect.value==='__custom__'){
                if(sfCustom){sfCustom.style.display='';sfCustom.focus()}
                entries[idx].salesforceValue=sfCustom?.value.trim()||'';
              }else{
                if(sfCustom){sfCustom.style.display='none';sfCustom.value=sfSelect.value}
                entries[idx].salesforceValue=sfSelect.value;
              }
            };
          }
          if(sfCustom){
            sfCustom.oninput=()=>{
              entries[idx].salesforceValue=sfCustom.value.trim();
            };
          }

          if(hsSelect){
            hsSelect.onchange=()=>{
              if(hsSelect.value==='__custom__'){
                if(hsCustom){hsCustom.style.display='';hsCustom.focus()}
                entries[idx].hubspotValue=hsCustom?.value.trim()||'';
              }else{
                if(hsCustom){hsCustom.style.display='none';hsCustom.value=hsSelect.value}
                entries[idx].hubspotValue=hsSelect.value;
              }
            };
          }
          if(hsCustom){
            hsCustom.oninput=()=>{
              entries[idx].hubspotValue=hsCustom.value.trim();
            };
          }

          if(delBtn){
            delBtn.onclick=()=>{
              entries.splice(idx,1);
              renderModalRows();
            };
          }
        });
      }

      renderModalRows();

      $('picklist-add-row').onclick=()=>{
        entries.push({salesforceValue:'',hubspotValue:'',canonicalValue:''});
        renderModalRows();
        const lastRow=document.querySelector('#picklist-value-rows tr:last-child');
        lastRow?.querySelector('select')?.focus();
      };

      $('picklist-automatch').onclick=()=>{
        let addedCount=0;
        for(const sf of sfOptions){
          const sfValLower=(sf.value||'').trim().toLowerCase();
          const sfLabelLower=(sf.label||'').trim().toLowerCase();
          const match=hsOptions.find(hs=>{
            const hsValLower=(hs.value||'').trim().toLowerCase();
            const hsLabelLower=(hs.label||'').trim().toLowerCase();
            return (sfValLower&&hsValLower===sfValLower)||(sfLabelLower&&hsLabelLower===sfLabelLower);
          });
          if(match){
            const alreadySf=entries.some(e=>(e.salesforceValue||'').trim().toLowerCase()===sfValLower);
            const alreadyHs=entries.some(e=>(e.hubspotValue||'').trim().toLowerCase()===(match.value||'').trim().toLowerCase());
            if(!alreadySf&&!alreadyHs){
              entries.push({salesforceValue:sf.value,hubspotValue:match.value,canonicalValue:sf.value});
              addedCount++;
            }
          }
        }
        renderModalRows();
        if(addedCount>0){
          $('picklist-modal-message').className='settings-message success';
          $('picklist-modal-message').textContent='Auto-matched '+addedCount+' identical option'+(addedCount===1?'':'s')+'.';
        }else{
          $('picklist-modal-message').className='settings-message';
          $('picklist-modal-message').textContent='No new identical options found between Salesforce and HubSpot.';
        }
      };

      const closeModal=()=>{
        $('picklist-value-modal').hidden=true;
      };
      $('picklist-modal-close').onclick=closeModal;
      $('picklist-modal-cancel').onclick=closeModal;

      $('picklist-modal-save').onclick=async()=>{
        const saveBtn=$('picklist-modal-save');
        saveBtn.disabled=true;
        saveBtn.textContent='Saving…';
        try{
          const validEntries=entries
            .map(e=>({
              salesforceValue:(e.salesforceValue||'').trim()||undefined,
              hubspotValue:(e.hubspotValue||'').trim()||undefined,
              canonicalValue:(e.canonicalValue||e.salesforceValue||e.hubspotValue||'').trim(),
            }))
            .filter(e=>e.salesforceValue||e.hubspotValue);

          const result=await api('/api/value-mappings/'+state.type+'/'+encodeURIComponent(canonicalField),{
            method:'PUT',
            body:JSON.stringify({entries:validEntries}),
          });

          state.valueMappings=(state.valueMappings||[]).filter(v=>v.canonicalField!==canonicalField).concat(result.entries||[]);
          renderFieldMappings();

          if(result.syncPaused){
            showSyncPausedWarning('Heads up: '+state.type+' was live-syncing, so saving this value mapping paused sync for it. Review it, then re-enable from the Sync tab when ready.');
          }else{
            showNotice('Value mappings for "'+canonicalField+'" saved.');
          }
          closeModal();
        }catch(err){
          $('picklist-modal-message').className='settings-message error';
          $('picklist-modal-message').textContent=err.message||String(err);
        }finally{
          saveBtn.disabled=false;
          saveBtn.textContent='Save value mappings';
        }
      };
    }

    function blockedNaturalKeyField(type,field){const key=field.replace(/[^a-z0-9]/gi,'').toLowerCase();if(key==='recordid'||key==='id'||key==='salesforceid'||key==='migratedrecordid'||(key.includes('external')&&key.endsWith('id')))return false;return ['type','industry','website','annualrevenue','revenue'].includes(key)||/(modified|activity|created|updated|timestamp|description|notes?|ownerid|recordtype|status|stage|pipeline|amount|employee|count|isdeleted)/.test(key)}
    function naturalKeyCandidates(type,sourceMeta,targetMeta,sourceRules,targetRules){const common=[...sourceRules.keys()].filter(field=>targetRules.has(field));return common.map(field=>{const sNative=sourceRules.get(field)?.native||'';const tNative=targetRules.get(field)?.native||'';const source=sourceMeta.fields.find(item=>item.name===sNative||item.name.toLowerCase()===sNative.toLowerCase());const target=targetMeta.fields.find(item=>item.name===tNative||item.name.toLowerCase()===tNative.toLowerCase());return {field,source,target,risky:/^(name|phone|title|companyName)$/i.test(field)}}).filter(item=>{const isRecId=/^(record_?id|salesforce_?id|migrated_?record_?id|id)$/i.test(item.field)||/^(record_?id|salesforce_?id|migrated_record_id)$/i.test(item.source?.name||'')||/^(record_?id|salesforce_?id|migrated_record_id)$/i.test(item.target?.name||'');if(isRecId)return true;return item.source&&item.target&&!item.source.calculated&&!item.target.calculated&&!blockedNaturalKeyField(type,item.field)})}
    function naturalKeyPresets(type,candidates){const available=new Set(candidates.map(item=>item.field)),external=candidates.find(item=>/external.*id|externalid/i.test(item.field))?.field,recId=candidates.find(item=>/^(record_?id|salesforce_?id|migrated_?record_?id|id)$/i.test(item.field)||/^(record_?id|salesforce_?id|migrated_record_id)$/i.test(item.source?.name||'')||/^(record_?id|salesforce_?id|migrated_record_id)$/i.test(item.target?.name||''))?.field,definitions=[];
      const t=String(type||'').toLowerCase();
      if(t==='contact'||t==='contacts'){
        if(available.has('email')&&recId){definitions.push({fields:['email',recId],label:'Email + Salesforce Record ID',description:'Unique identification using Email and Salesforce Record ID.',recommended:true})}
        if(recId&&!available.has('email')){definitions.push({fields:[recId],label:'Salesforce Record ID',description:'Unique identification using Salesforce Record ID.',recommended:true})}
        if(available.has('email')&&!recId){definitions.push({fields:['email'],label:'Email address',description:'Matches records with the same normalized email address.',recommended:true})}
      }else if(t==='account'||t==='company'||t==='deal'||t==='deals'){
        if(recId){definitions.push({fields:[recId],label:'Salesforce Record ID',description:'Unique identification using Salesforce Record ID.',recommended:true})}
      }
      if(external&&!definitions.some(d=>d.fields.includes(external)))definitions.push({fields:[external],label:'Shared external ID',description:'Best when both CRMs store the same immutable business identifier.',recommended:definitions.length===0});
      if(available.has('email')&&!definitions.some(d=>d.fields.includes('email')))definitions.push({fields:['email'],label:'Email address',description:'Matches records with the same normalized email address.',recommended:definitions.length===0});
      else if(available.has('domain')&&!definitions.some(d=>d.fields.includes('domain')))definitions.push({fields:['domain'],label:'Domain',description:'Matches records using their normalized website domain.',recommended:definitions.length===0});
      else if(available.has('website')&&!definitions.some(d=>d.fields.includes('website')))definitions.push({fields:['website'],label:'Website',description:'Matches records using their normalized website value.',recommended:definitions.length===0});
      const nameField=['name','dealname'].find(field=>available.has(field)),dateField=[...available].find(field=>/date$/i.test(field));
      if(!definitions.length&&nameField&&dateField)definitions.push({fields:[nameField,dateField],label:nameField+' + '+dateField,description:'Fallback when no shared external ID or unique field exists. Review duplicates carefully.',recommended:true,risky:true});
      return definitions}
    function renderFieldWorkspaceNaturalKey(type,keyData,sourceMeta,targetMeta,sourceRules,targetRules){
      const panel=$('field-workspace-natural-key');if(!panel)return;
      const candidates=naturalKeyCandidates(type,sourceMeta,targetMeta,sourceRules,targetRules);
      const presets=naturalKeyPresets(type,candidates);
      const current=keyData?.naturalKeyFields||[];
      const matched=presets.findIndex(item=>sameFields(item.fields,current));
      const advancedValid=current.length&&current.every(field=>candidates.some(item=>item.field===field));
      migrationState.fieldKeyContext={type,keyPresets:presets,keyCandidates:candidates,currentFields:current};
      const isPendingSync=Boolean(syncWizard.naturalKeyPending);
      const eyebrow=$('field-natural-key-eyebrow');if(eyebrow)eyebrow.textContent=isPendingSync?'Sync setup · final step: Unique record identity':'Unique record identity (matching rule)';
      const badge=$('field-natural-key-badge');
      if(badge){
        const activeLabel=matched>=0?presets[matched].label:(current.length?current.join(' + '):'Default');
        badge.innerHTML='<span class="pill" style="font-weight:600;font-size:11px;background:#eef7f6;color:var(--teal-dark)">Active rule: '+esc(activeLabel)+'</span>';
      }
      $('field-natural-key-options').innerHTML=presets.length?presets.map((preset,index)=>'<label class="identity-option"><input type="radio" name="field-natural-key-mode" value="preset-'+index+'" '+(index===(matched>=0?matched:advancedValid?-1:0)?'checked':'')+'><span><b>'+esc(preset.label)+(preset.recommended?'<em class="recommended-badge">Recommended</em>':'')+'</b><small>'+esc(preset.description)+'</small></span></label>').join(''):'<div class="empty">No shared, stable field is mapped in both CRMs yet. Map a shared ID or domain below.</div>';
      $('field-natural-key-fields').innerHTML=candidates.length?candidates.map(item=>'<label class="advanced-key-field"><input type="checkbox" data-field-natural-key-field="'+esc(item.field)+'" '+(advancedValid&&current.includes(item.field)?'checked':'')+'>'+esc(item.field)+(item.risky?' · mutable':'')+'</label>').join(''):'<div class="empty">Map a stable field in both CRMs first.</div>';
      const advancedRadio=document.querySelector('input[name="field-natural-key-mode"][value="advanced"]');if(advancedRadio)advancedRadio.checked=matched<0&&advancedValid;
      const advancedDetails=$('field-natural-key-advanced');if(advancedDetails)advancedDetails.open=(matched<0&&current.length>0)||(advancedRadio&&advancedRadio.checked);
      document.querySelectorAll('input[name="field-natural-key-mode"],[data-field-natural-key-field]').forEach(input=>{input.onchange=()=>{if(input.dataset.fieldNaturalKeyField&&advancedRadio)advancedRadio.checked=true;updateFieldNaturalKeyChoice()}});
      updateFieldNaturalKeyChoice();
    }
    function selectedFieldNaturalKeyFields(){
      const mode=document.querySelector('input[name="field-natural-key-mode"]:checked')?.value;
      if(mode?.startsWith('preset-'))return migrationState.fieldKeyContext?.keyPresets[Number(mode.slice(7))]?.fields||[];
      return [...document.querySelectorAll('[data-field-natural-key-field]:checked')].map(input=>input.dataset.fieldNaturalKeyField);
    }
    function updateFieldNaturalKeyChoice(){
      const context=migrationState.fieldKeyContext;if(!context)return;
      const fields=selectedFieldNaturalKeyFields();
      const mode=document.querySelector('input[name="field-natural-key-mode"]:checked')?.value;
      const preset=mode?.startsWith('preset-')?context.keyPresets[Number(mode.slice(7))]:undefined;
      const risky=fields.filter(field=>context.keyCandidates.find(item=>item.field===field)?.risky);
      const saveBtn=$('save-field-natural-key');if(saveBtn)saveBtn.disabled=!fields.length;
      const summary=$('field-natural-key-summary');if(summary)summary.textContent=fields.length?'Match using '+fields.join(' + '):'Choose at least one stable field.';
      const warning=$('field-natural-key-warning');
      if(warning){
        if(preset?.risky||risky.length){warning.className='identity-warning';warning.textContent='Review carefully: '+(risky.length?risky.join(', '):'this fallback')+' can change or may not be unique.'}
        else{warning.className='identity-warning safe';warning.textContent='Good identity rule: the selected field is stable, mapped in both CRMs, and searchable before creating a record.'}
      }
    }
    if($('save-field-natural-key'))$('save-field-natural-key').onclick=async()=>{
      const state=migrationState.mapping;if(!state)return;
      const type=state.type,fields=selectedFieldNaturalKeyFields(),button=$('save-field-natural-key');
      if(!fields.length){$('field-natural-key-warning').className='identity-warning';$('field-natural-key-warning').textContent='Choose at least one stable identity field.';return}
      try{
        button.disabled=true;button.textContent='Saving…';
        const result=await api('/api/object-mappings/'+type,{method:'PUT',body:JSON.stringify({naturalKeyFields:fields})});
        markPlanDirty();queuePlanAutosave();button.textContent='Saved ✓';$('field-natural-key-summary').textContent='Saved: '+fields.join(' + ');
        const badge=$('field-natural-key-badge');if(badge)badge.innerHTML='<span class="pill" style="font-weight:600;font-size:11px;background:#eef7f6;color:var(--teal-dark)">Active rule: '+esc(fields.join(' + '))+'</span>';
        setTimeout(()=>button.textContent='Save matching rule',1200);
        if(result.syncPaused){showSyncPausedWarning('Heads up: '+type+' was live-syncing, so saving this matching rule paused both real-time and scheduled sync for it. Review it, then re-enable from the Sync tab when ready.')}
        else{showNotice('Matching rule saved for '+type+'.')}
        if(syncWizard.naturalKeyPending&&syncConfigState?.objects?.[type]){
          const current=syncConfigState.objects[type];
          syncConfigState=await api('/api/sync/settings',{method:'PATCH',body:JSON.stringify({conflictStrategy:syncConfigState.conflictStrategy,sourceOfTruth:syncConfigState.sourceOfTruth,objects:{[type]:{...current,enabled:true}}})});
          syncWizard.naturalKeyPending=false;setDraftStatus(type+' is now live for sync','saved');
        }
      }catch(e){$('field-natural-key-warning').className='identity-warning';$('field-natural-key-warning').textContent=e.message;button.textContent='Save matching rule'}finally{button.disabled=false}
    };
    function sameFields(a,b){return a.length===b.length&&a.every((field,index)=>field===b[index])}
    function renderNaturalKeyOptions(type,keyData,candidates){const presets=naturalKeyPresets(type,candidates),current=keyData.naturalKeyFields,matched=presets.findIndex(item=>sameFields(item.fields,current)),advancedValid=current.length&&current.every(field=>candidates.some(item=>item.field===field));$('natural-key-options').innerHTML=presets.length?presets.map((preset,index)=>'<label class="identity-option"><input type="radio" name="natural-key-mode" value="preset-'+index+'" '+(index===(matched>=0?matched:advancedValid?-1:0)?'checked':'')+'><span><b>'+esc(preset.label)+(preset.recommended?'<em class="recommended-badge">Recommended</em>':'')+'</b><small>'+esc(preset.description)+'</small></span></label>').join(''):'<div class="empty">No recommended identity is mapped in both CRMs.</div>';$('natural-key-fields').innerHTML=candidates.length?candidates.map(item=>'<label class="advanced-key-field"><input type="checkbox" data-natural-key-field="'+esc(item.field)+'" '+(advancedValid&&current.includes(item.field)?'checked':'')+'>'+esc(item.field)+(item.risky?' · mutable':'')+'</label>').join(''):'<div class="empty">Map a stable field in both CRMs first.</div>';const advancedRadio=document.querySelector('input[name="natural-key-mode"][value="advanced"]');advancedRadio.checked=matched<0&&advancedValid;$('natural-key-advanced').open=advancedRadio.checked||matched<0&&current.length>0;migrationState.valueContext.keyPresets=presets;migrationState.valueContext.keyCandidates=candidates;migrationState.valueContext.previousKeyUnsafe=Boolean(current.length&&matched<0&&!advancedValid);document.querySelectorAll('input[name="natural-key-mode"],[data-natural-key-field]').forEach(input=>input.onchange=()=>{if(input.dataset.naturalKeyField)advancedRadio.checked=true;updateNaturalKeyChoice()});updateNaturalKeyChoice()}
    function selectedNaturalKeyFields(){const mode=document.querySelector('input[name="natural-key-mode"]:checked')?.value;if(mode?.startsWith('preset-'))return migrationState.valueContext.keyPresets[Number(mode.slice(7))]?.fields||[];return [...document.querySelectorAll('[data-natural-key-field]:checked')].map(input=>input.dataset.naturalKeyField)}
    function updateNaturalKeyChoice(){const context=migrationState.valueContext;if(!context)return;const fields=selectedNaturalKeyFields(),mode=document.querySelector('input[name="natural-key-mode"]:checked')?.value,preset=mode?.startsWith('preset-')?context.keyPresets[Number(mode.slice(7))]:undefined,risky=fields.filter(field=>context.keyCandidates.find(item=>item.field===field)?.risky);$('save-natural-key').disabled=!fields.length;$('natural-key-summary').textContent=fields.length?'Match using '+fields.join(' + '):'Choose at least one stable field.';const warning=$('natural-key-warning');if(context.previousKeyUnsafe){warning.className='identity-warning';warning.textContent='The previous rule used an unstable or unmapped field. Choose and save a safe replacement before migration.';context.previousKeyUnsafe=false}else if(preset?.risky||risky.length){warning.className='identity-warning';warning.textContent='Review carefully: '+(risky.length?risky.join(', '):'this fallback')+' can change or may not be unique. Preflight will flag missing values and duplicate matches.'}else{warning.className='identity-warning safe';warning.textContent='Good identity rule: the selected field is stable, mapped in both CRMs, and searchable before creating a record.'}}
    async function loadValuesWorkspace(type){if(!type)return;const loadToken=++migrationState.valueLoadToken,row=migrationState.catalog.find(item=>item.canonicalType===type);if(!row)return;$('value-object').value=type;renderValueObjectTabs();$('natural-key-options').innerHTML='<div class="empty">Loading matching rules…</div>';$('value-field').innerHTML='<option value="">Loading value fields…</option>';$('value-map-rows').innerHTML='<tr><td colspan="3" class="empty">Choose a value field after this object loads.</td></tr>';const {from,to,sourceObj,targetObj}=resolveRowEndpoints(row,type);if(!sourceObj||!targetObj)return;
      try{const [sourceMeta,targetMeta,sourceMap,targetMap,keyData]=await Promise.all([getMetadata(from,sourceObj.id),getMetadata(to,targetObj.id),api('/api/mappings/'+from+'/'+type),api('/api/mappings/'+to+'/'+type),api('/api/object-mappings/'+type)]),sourceRules=new Map(sourceMap.rules.map(r=>[r.canonical,r])),targetRules=new Map(targetMap.rules.map(r=>[r.canonical,r])),canonicalFields=[...new Set([...sourceRules.keys()].filter(field=>targetRules.has(field)))],candidates=naturalKeyCandidates(type,sourceMeta,targetMeta,sourceRules,targetRules),enumFields=canonicalFields.filter(c=>{const s=sourceMeta.fields.find(f=>f.name===sourceRules.get(c)?.native),t=targetMeta.fields.find(f=>f.name===targetRules.get(c)?.native);return s?.options?.length||t?.options?.length});
        if(loadToken!==migrationState.valueLoadToken)return;migrationState.valueContext={type,sourceMeta,targetMeta,sourceRules,targetRules,keyData,keyPresets:[],keyCandidates:[],previousKeyUnsafe:false};renderNaturalKeyOptions(type,keyData,candidates);$('value-field').innerHTML='<option value="">Choose a picklist field</option>'+enumFields.map(field=>'<option>'+esc(field)+'</option>').join('')}catch(e){if(loadToken!==migrationState.valueLoadToken)return;$('value-map-rows').innerHTML='<tr><td colspan="3" class="empty">'+esc(e.message)+'</td></tr>';$('natural-key-options').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
    $('save-natural-key').onclick=async()=>{const type=$('value-object').value,fields=selectedNaturalKeyFields(),button=$('save-natural-key');if(!fields.length){$('natural-key-warning').className='identity-warning';$('natural-key-warning').textContent='Choose at least one stable identity field.';return}try{button.disabled=true;button.textContent='Saving…';const result=await api('/api/object-mappings/'+type,{method:'PUT',body:JSON.stringify({naturalKeyFields:fields})});markPlanDirty();queuePlanAutosave();button.textContent='Saved ✓';$('natural-key-summary').textContent='Saved: '+fields.join(' + ');setTimeout(()=>button.textContent='Save matching rule',1200);
      if(result.syncPaused)showSyncPausedWarning('Heads up: '+type+' was live-syncing, so saving this matching rule paused both real-time and scheduled sync for it. Review it, then re-enable from the Sync tab when ready.')
    }catch(e){$('natural-key-warning').className='identity-warning';$('natural-key-warning').textContent=e.message;button.textContent='Save matching rule'}finally{button.disabled=false}};
    $('load-values').onclick=async()=>{const context=migrationState.valueContext,field=$('value-field').value;if(!context||!field)return;if(migrationState.mapping?.type===context.type){openPicklistValueModal(field)}else{await loadFieldWorkspace(context.type);openPicklistValueModal(field)}};
    $('save-values').onclick=async()=>{const type=$('value-object').value,field=$('value-field').value;if(!field)return;const entries=[...$('value-map-rows').querySelectorAll('tr')].map(tr=>({canonicalValue:tr.querySelector('.value-canonical')?.value.trim(),salesforceValue:tr.querySelector('.value-sf')?.value.trim()||undefined,hubspotValue:tr.querySelector('.value-hs')?.value.trim()||undefined})).filter(x=>x.canonicalValue);try{const result=await api('/api/value-mappings/'+type+'/'+encodeURIComponent(field),{method:'PUT',body:JSON.stringify({entries})});markPlanDirty();queuePlanAutosave();$('save-values').textContent='Saved ✓';setTimeout(()=>$('save-values').textContent='Save values',1200);
      if(result.syncPaused)showSyncPausedWarning('Heads up: '+type+' was live-syncing, so saving this value mapping paused both real-time and scheduled sync for it. Review it, then re-enable from the Sync tab when ready.')
    }catch(e){showError(e.message,e.requestId)}};

    async function runPlanPreflight(){try{const plan=await ensurePlan();migrationState.preflight=null;resetCopilot();$('summary-preflight').textContent='Running…';updateMigrationStepper();const result=await api('/api/migration-plans/'+plan.id+'/preflight',{method:'POST'});migrationState.preflight=result;renderPreflight(result);migrationState.plan=await api('/api/migration-plans/'+plan.id);updateMigrationSummary();updateMigrationStepper();return result}catch(e){$('ask-copilot').disabled=true;$('summary-preflight').textContent='Blocked';$('preflight-issues').innerHTML=e.code==='connection_refresh_required'?'<div class="preflight-blocked"><b>CRM connection needs attention</b><p>'+esc(e.message)+'</p><a class="button secondary" href="'+esc(e.actionUrl||'/')+'">Open Connections</a></div>':'<div class="empty">'+esc(e.message)+'</div>';updateMigrationStepper();throw e}}
    function renderPreflight(result){const issues=result.checks.flatMap(check=>check.issues.map(issue=>({...issue,type:check.type}))),errors=issues.filter(x=>x.severity==='error').length,warnings=issues.filter(x=>x.severity==='warning').length,fields=result.checks.reduce((sum,check)=>sum+Object.values(check.schemas).reduce((n,s)=>n+(s?.fields||0),0),0);$('preflight-summary').innerHTML='<div class="check-stat"><b>'+errors+'</b><span>Errors</span></div><div class="check-stat"><b>'+warnings+'</b><span>Warnings</span></div><div class="check-stat"><b>'+fields+'</b><span>Fields checked</span></div>';
      $('preflight-issues').innerHTML=issues.length?issues.map((issue,index)=>{const actionable=Boolean(issue.field&&migrationState.selected.has(issue.type));return '<div class="issue-row'+(actionable?' actionable':'')+'" '+(actionable?'data-issue-index="'+index+'" title="Open '+esc(issue.field)+' in field mapping"':'')+'><span class="pill '+(issue.severity==='error'?'error':issue.severity==='warning'?'ambiguous':'queued')+'">'+esc(issue.severity)+'</span><span class="issue-context"><b class="issue-object">'+esc(issue.type)+'</b>'+(issue.field?'<span class="issue-field">'+esc(issue.field)+'</span>':'')+'<span class="issue-code">'+esc(issue.code)+'</span></span><span class="issue-message">'+esc(issue.message)+'</span></div>'}).join(''):'<div class="empty">All selected objects passed schema validation.</div>';
      document.querySelectorAll('#preflight-issues [data-issue-index]').forEach(row=>row.onclick=()=>{const issue=issues[Number(row.dataset.issueIndex)];if(issue)openIssueField(issue)});
      $('summary-preflight').textContent=result.ok?'Passed':errors+' blockers';$('ask-copilot').disabled=false;$('fix-boolean-fields').disabled=!booleanEnumIssues(result).length;updateMigrationStepper()}
    // Deterministic and therefore safe to auto-fix: a boolean<->enumeration FIELD_TYPE_MISMATCH
    // always means the same fix (the yes-no transform on the enumeration side, both directions).
    // Picklist/value-review warnings are NOT included here -- those need a human to say which
    // value means what, guessing would risk silently mapping the wrong values together.
    // HubSpot's raw schema type for a native checkbox property is literally "bool", not
    // "boolean" -- /boolean/i does not match the substring "bool" (it's the shorter word,
    // not a prefix match), so it silently missed every field pairing Salesforce's boolean/
    // picklist against one of HubSpot's real "bool"-typed properties (e.g. hs_is_closed,
    // salesforcedeleted). /bool/i matches both "bool" and "boolean".
    function booleanEnumIssues(result){return result.checks.flatMap(check=>check.issues.filter(issue=>issue.code==='FIELD_TYPE_MISMATCH'&&issue.field&&/bool/i.test(issue.message)&&/(enumeration|picklist)/i.test(issue.message)).map(issue=>({type:check.type,field:issue.field})))}
    $('fix-boolean-fields').onclick=async()=>{
      if(!migrationState.preflight)return;
      const targets=booleanEnumIssues(migrationState.preflight);
      if(!targets.length)return;
      const button=$('fix-boolean-fields');button.disabled=true;button.textContent='Fixing…';$('fix-result').hidden=true;
      const from=migrationState.plan?.source||$('mig-from').value,to=from==='salesforce'?'hubspot':'salesforce';
      const fixed=[],skipped=[];
      try{
        const types=[...new Set(targets.map(t=>t.type))];
        for(const type of types){
          const [sourceSchema,targetSchema,sourceMap,targetMap]=await Promise.all([
            api('/api/schema/'+from+'/'+type),
            api('/api/schema/'+to+'/'+type),
            api('/api/mappings/'+from+'/'+type),
            api('/api/mappings/'+to+'/'+type),
          ]);
          const sourceFields=new Map(sourceSchema.fields.map(f=>[f.name,f])),targetFields=new Map(targetSchema.fields.map(f=>[f.name,f]));
          let sourceChanged=false,targetChanged=false;
          for(const target of targets){
            if(target.type!==type)continue;
            const sRule=sourceMap.rules.find(r=>r.canonical===target.field),tRule=targetMap.rules.find(r=>r.canonical===target.field);
            if(!sRule||!tRule){skipped.push(target.field+' ('+type+')');continue}
            const sField=sourceFields.get(sRule.native.split('.')[0]),tField=targetFields.get(tRule.native);
            const isBool=f=>f&&/^bool/i.test(f.type),isEnum=f=>f&&/(enum|picklist)/i.test(f.type);
            if(isBool(sField)&&isEnum(tField)){tRule.toCanonical='yes-no';tRule.fromCanonical='yes-no';targetChanged=true;fixed.push(target.field+' ('+type+')')}
            else if(isBool(tField)&&isEnum(sField)){sRule.toCanonical='yes-no';sRule.fromCanonical='yes-no';sourceChanged=true;fixed.push(target.field+' ('+type+')')}
            else skipped.push(target.field+' ('+type+')');
          }
          if(sourceChanged)await api('/api/mappings/'+from+'/'+type,{method:'PUT',body:JSON.stringify({rules:sourceMap.rules})});
          if(targetChanged)await api('/api/mappings/'+to+'/'+type,{method:'PUT',body:JSON.stringify({rules:targetMap.rules})});
        }
        migrationState.metadata.clear();
        if(migrationState.mapping&&types.includes(migrationState.mapping.type))await loadFieldWorkspace(migrationState.mapping.type);
        $('fix-result').className='fix-result'+(skipped.length?' error':'');$('fix-result').hidden=false;
        $('fix-result').innerHTML='<b>'+fixed.length+' field'+(fixed.length===1?'':'s')+' fixed'+(fixed.length?': '+esc(fixed.join(', ')):'')+'</b>'+(skipped.length?'<br>Could not auto-fix (schema mismatch): '+esc(skipped.join(', ')):'');
        setDraftStatus('Mapping changes not saved');markPlanDirty();queuePlanAutosave();
        await runPlanPreflight();
      }catch(e){
        $('fix-result').className='fix-result error';$('fix-result').hidden=false;$('fix-result').textContent=e.message;
      }finally{button.disabled=false;button.textContent='Fix boolean fields'}
    };
    async function openIssueField(issue){await openFieldMappingPage('migration',issue.type);const row=[...document.querySelectorAll('#field-map-rows tr[data-canonical]')].find(tr=>tr.dataset.canonical===issue.field);if(row){row.scrollIntoView({block:'center',behavior:'smooth'});row.classList.add('highlight-row');setTimeout(()=>row.classList.remove('highlight-row'),2200)}}
    function copilotConfidence(value){return value>=.8?'High confidence':value>=.55?'Medium confidence':'Low confidence'}
    function copilotAreaLabel(area){return {field_mappings:'Open field mappings',value_mappings:'Open value mappings',owner_mappings:'Open owner mappings',object_settings:'Open object settings'}[area]||''}
    function openCopilotArea(area,type){if(area==='field_mappings'){openFieldMappingPage('migration',type)}else if(area==='value_mappings'||area==='owner_mappings'){selectMigrationStep('values');$('value-object').value=type;loadValuesWorkspace(type)}else if(area==='object_settings')selectMigrationStep('objects')}
    function renderCopilot(result){const panel=$('copilot-panel'),readinessLabel={blocked:'Blocked',review_required:'Review required',ready:'Ready'}[result.readiness],readinessClass=result.readiness==='blocked'?'error':result.readiness==='review_required'?'ambiguous':'completed';
      const findings=result.findings.map((finding,index)=>{const areaLabel=copilotAreaLabel(finding.recommendationArea);return '<article class="copilot-finding"><div class="copilot-finding-head"><span class="pill '+(finding.severity==='error'?'error':finding.severity==='warning'?'ambiguous':'queued')+'">'+esc(finding.objectType)+'</span><b>'+esc(finding.title)+'</b><span class="copilot-confidence">'+esc(copilotConfidence(finding.confidence))+'</span></div><p>'+esc(finding.explanation)+'</p><div class="copilot-action"><b>Suggested next step:</b> '+esc(finding.recommendedAction)+'</div>'+(areaLabel?'<button class="secondary" data-copilot-index="'+index+'">'+esc(areaLabel)+'</button>':'')+'</article>'}).join('');
      panel.innerHTML='<div class="copilot-head"><div><div class="copilot-kicker">Migration Copilot · read only</div><h3>Preflight guidance</h3><p>'+esc(result.summary)+'</p></div><span class="pill '+readinessClass+'">'+esc(readinessLabel)+'</span></div><div class="copilot-privacy"><span>No record values shared</span><span>No credentials shared</span><span>No changes applied</span></div><div class="copilot-findings">'+(findings||'<div class="empty">No preflight issues need explanation.</div>')+'</div>'+(result.nextSteps.length?'<div class="copilot-next"><b>Recommended order</b><ol>'+result.nextSteps.map(step=>'<li>'+esc(step)+'</li>').join('')+'</ol></div>':'')+'<div class="copilot-note">'+esc(result.disclaimer)+' · '+esc(result.model)+'</div>';panel.hidden=false;panel.querySelectorAll('[data-copilot-index]').forEach(button=>{const finding=result.findings[Number(button.dataset.copilotIndex)];button.onclick=()=>openCopilotArea(finding.recommendationArea,finding.objectType)})}
    async function askCopilot(){if(!migrationState.preflight||!migrationState.plan)return;const button=$('ask-copilot'),panel=$('copilot-panel');button.disabled=true;button.textContent='Analyzing…';panel.hidden=false;panel.innerHTML='<div class="empty">Reviewing schema metadata and mapping context…</div>';try{const result=await api('/api/migration-plans/'+migrationState.plan.id+'/copilot/preflight',{method:'POST'});migrationState.copilot=result;renderCopilot(result)}catch(e){panel.innerHTML='<div class="preflight-blocked"><b>Copilot unavailable</b><p>'+esc(e.message)+'</p>'+(e.actionUrl?'<a class="button secondary" href="'+esc(e.actionUrl)+'">Configure Copilot</a>':'')+'</div>'}finally{button.disabled=false;button.textContent=migrationState.copilot?'Refresh Copilot':'Ask Copilot'}}
    $('run-preflight').onclick=()=>runPlanPreflight().catch(()=>{});$('side-preflight').onclick=()=>{selectMigrationStep('validate');runPlanPreflight().catch(()=>{})};
    $('ask-copilot').onclick=askCopilot;
    function testTypeLabel(type){return migrationState.catalog.find(row=>row.canonicalType===type)?.source.label||type}
    function untestedTypes(){const plan=migrationState.plan,verification=plan?.canary?.verification;if(!plan)return [...migrationState.selected];const tested=verification?.passed&&plan.canary.previewRevision===plan.revision?verification.testedTypes:[];return plan.types.filter(type=>!tested.includes(type))}
    function currentCanaryPassed(){return Boolean(migrationState.plan?.canary?.verifiedAt&&migrationState.plan.canary.previewRevision===migrationState.plan.revision&&!untestedTypes().length)}
    function newIdempotencyKey(){return (crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random())}
    function verificationSummary(verification){if(!verification)return 'The test could not be verified.';if(verification.passed){const remaining=untestedTypes();return 'Read back and matched '+verification.items.filter(item=>item.wrote).length+' written record(s).'+(remaining.length?' Also test: '+remaining.map(testTypeLabel).join(', ')+'.':'')}return 'Not verified: '+(verification.reasons||[]).join('; ')}
    function testValue(value){if(value===undefined)return 'Not set';if(value===null)return 'Empty';return typeof value==='string'?value:JSON.stringify(value)}
    function renderTestRecordPreview(plan){migrationState.canaryPreview={runId:migrationState.canaryPreview?.runId,plans:[plan]};$('test-record-preview').hidden=false;$('test-record-action').className='pill '+plan.action;$('test-record-action').textContent=plan.action;$('test-record-fields').innerHTML=plan.fieldDiff.length?plan.fieldDiff.map(diff=>'<div class="test-field"><span>'+esc(diff.field)+'</span><b>'+esc(testValue(diff.source))+(diff.target===undefined?'':' ← current '+esc(testValue(diff.target)))+'</b></div>').join(''):'<div class="test-field"><span>Result</span><b>'+esc(plan.warnings.join('; ')||'No field changes required')+'</b></div>';$('execute-canary').disabled=plan.action==='ambiguous';$('mig-status').textContent=plan.action==='ambiguous'?'Choose another record or resolve the ambiguous match.':'Review the action, then test this one record.';updateMigrationStepper()}
    function showCanaryPassed(detail){migrationState.canaryVerified=true;$('test-record-result').hidden=false;$('test-result-title').textContent='One-record test passed';$('test-result-detail').textContent=detail;$('full-migration').hidden=false;$('summary-preview').textContent='Passed';$('mig-status').textContent='Verified. Full migration is now unlocked.';updateMigrationStepper()}
    let typedConfirmationResolve,typedConfirmationToken='';
    // Case-insensitive: the input is styled text-transform:uppercase (matching the displayed
    // token), so it visually shows "TEST" no matter what case was actually typed -- comparing
    // case-sensitively made it silently impossible to pass for anyone who typed lowercase.
    function typedConfirmationMatches(){return $('typed-confirm-input').value.trim().toUpperCase()===typedConfirmationToken.toUpperCase()}
    function closeTypedConfirmation(confirmed){const resolve=typedConfirmationResolve;typedConfirmationResolve=undefined;typedConfirmationToken='';$('typed-confirmation').hidden=true;$('typed-confirm-input').value='';$('typed-confirm-error').hidden=true;if(resolve)resolve(Boolean(confirmed))}
    function requestTypedConfirmation({title,message,token,buttonLabel}){if(typedConfirmationResolve)closeTypedConfirmation(false);return new Promise(resolve=>{typedConfirmationResolve=resolve;typedConfirmationToken=token;$('typed-confirm-title').textContent=title;$('typed-confirm-message').textContent=message;$('typed-confirm-token').textContent=token;$('typed-confirm-submit').textContent=buttonLabel;$('typed-confirm-error').hidden=true;$('typed-confirmation').hidden=false;setTimeout(()=>$('typed-confirm-input').focus(),0)})}
    // Validated on submit (click or Enter) rather than gated by a live-disabled button, so it
    // doesn't depend on every keystroke's input event being handled the same way in every browser.
    function submitTypedConfirmation(){if(!typedConfirmationMatches()){$('typed-confirm-error').hidden=false;$('typed-confirm-input').focus();return}closeTypedConfirmation(true)}
    $('typed-confirm-input').oninput=()=>{$('typed-confirm-error').hidden=true};
    $('typed-confirm-input').onkeydown=event=>{if(event.key==='Escape')closeTypedConfirmation(false);if(event.key==='Enter')submitTypedConfirmation()};
    $('typed-confirm-cancel').onclick=()=>closeTypedConfirmation(false);$('typed-confirm-submit').onclick=submitTypedConfirmation;
    async function loadTestRecordWorkspace(){const plan=await ensurePlan(),types=[...migrationState.selected];$('test-record-type').innerHTML=types.map(type=>'<option value="'+type+'">'+esc(testTypeLabel(type))+'</option>').join('');if(plan.canary?.type&&types.includes(plan.canary.type))$('test-record-type').value=plan.canary.type;await loadTestRecordOptions()}
    async function loadTestRecordOptions(){const plan=await ensurePlan(),type=$('test-record-type').value,select=$('test-record-source');select.disabled=true;select.innerHTML='<option>Loading source records…</option>';$('test-record-preview').hidden=true;$('mig-status').textContent='Loading records…';const result=await api('/api/migration-plans/'+plan.id+'/test-records?type='+encodeURIComponent(type));select.innerHTML=result.entries.length?result.entries.map(record=>'<option value="'+esc(record.sourceId)+'">'+esc(record.label)+' · '+esc(record.sourceId)+'</option>').join(''):'<option value="">No source records found</option>';select.disabled=!result.entries.length;const saved=plan.canary&&plan.canary.previewRevision===plan.revision&&plan.canary.type===type&&result.entries.some(record=>record.sourceId===plan.canary.sourceId);if(saved)select.value=plan.canary.sourceId;if(!select.value){$('mig-status').textContent='No source records are available for this object.';return}if(saved){const frozen=await api('/api/migrations/'+plan.canary.previewRunId+'/items?limit=1');migrationState.canaryPreview={runId:plan.canary.previewRunId,plans:frozen.entries};if(frozen.entries[0])renderTestRecordPreview(frozen.entries[0]);if(plan.canary.verifiedAt)showCanaryPassed('Previously verified '+new Date(plan.canary.verifiedAt).toLocaleString()+'.')}else await prepareTestRecord()}
    async function prepareTestRecord(){const plan=await ensurePlan(),type=$('test-record-type').value,sourceId=$('test-record-source').value;if(!type||!sourceId)return;migrationState.canaryVerified=false;$('test-record-result').hidden=true;$('full-migration').hidden=true;$('execute-canary').disabled=true;$('summary-preview').textContent='Preparing…';$('mig-status').textContent='Checking this record against the destination…';try{const result=await api('/api/migration-plans/'+plan.id+'/test-record/preview',{method:'POST',body:JSON.stringify({type,sourceId})});migrationState.canaryPreview=result;migrationState.plan=await api('/api/migration-plans/'+plan.id);renderTestRecordPreview(result.plans[0]);$('summary-preview').textContent=result.plans[0]?.action==='ambiguous'?'Blocked':'Ready'}catch(e){$('test-record-preview').hidden=true;$('summary-preview').textContent='Blocked';$('mig-status').textContent=e.message;throw e}}
    $('test-record-type').onchange=()=>loadTestRecordOptions().catch(e=>$('mig-status').textContent=e.message);$('test-record-source').onchange=()=>prepareTestRecord().catch(e=>$('mig-status').textContent=e.message);
    $('execute-canary').onclick=async()=>{if(!migrationState.plan||!migrationState.canaryPreview)return;const confirmed=await requestTypedConfirmation({title:'Test one real record',message:'This writes exactly the reviewed record to the destination CRM, then reads it back and compares every mapped value.',token:'TEST',buttonLabel:'Test 1 record'});if(!confirmed)return;const button=$('execute-canary');button.disabled=true;button.textContent='Testing…';$('mig-status').textContent='Rechecking and writing one record…';try{const result=await api('/api/migration-plans/'+migrationState.plan.id+'/test-record/execute',{method:'POST',headers:{'idempotency-key':newIdempotencyKey()},body:JSON.stringify({confirm:true,previewRunId:migrationState.canaryPreview.runId})});migrationState.plan=await api('/api/migration-plans/'+migrationState.plan.id);if(result.verification?.passed&&currentCanaryPassed()){showCanaryPassed(verificationSummary(result.verification))}else if(result.verification?.passed){migrationState.canaryVerified=false;$('summary-preview').textContent='More tests needed';$('mig-status').textContent=verificationSummary(result.verification)}else{migrationState.canaryVerified=false;$('full-migration').hidden=true;$('summary-preview').textContent='Verification failed';$('mig-status').textContent=verificationSummary(result.verification)}await Promise.all([loadRuns(),loadMetrics(),loadSavedPlans()])}catch(e){$('summary-preview').textContent='Test failed';$('mig-status').textContent=e.message}finally{button.disabled=false;button.textContent='Test 1 record'}};
    $('execute-batch').onclick=async()=>{
      if(!migrationState.plan)return;
      const type=$('test-record-type').value,count=Number($('batch-count').value);
      if(!type){$('mig-status').textContent='Choose an object first';return}
      if(!Number.isInteger(count)||count<1){$('mig-status').textContent='Enter a valid record count';return}
      const button=$('execute-batch');button.disabled=true;$('batch-result').hidden=true;
      try{
        // Step 1: freeze a preview of exactly these records; nothing is written yet.
        button.textContent='Preparing…';$('mig-status').textContent='Previewing the first '+count+' '+testTypeLabel(type)+' record(s)…';
        const preview=await api('/api/migration-plans/'+migrationState.plan.id+'/test-batch/preview',{method:'POST',body:JSON.stringify({type,count})});
        const stats=preview.perType[type]||{read:0,actions:{}};
        const actionSummary=Object.entries(stats.actions).map(([action,n])=>n+' '+action).join(', ')||'no changes';
        if(stats.actions.ambiguous||stats.actions.error){$('batch-result').className='batch-result error';$('batch-result').hidden=false;$('batch-result').textContent='This batch cannot run: '+actionSummary+'. Resolve the flagged records first.';return}
        const confirmed=await requestTypedConfirmation({title:'Migrate the reviewed batch',message:'Reviewed '+stats.read+' '+testTypeLabel(type)+' record(s): '+actionSummary+'. Exactly these records will be written, then read back and compared.',token:'MIGRATE',buttonLabel:'Migrate batch'});
        if(!confirmed){$('mig-status').textContent='Batch not run.';return}
        // Step 2: execute exactly that frozen preview, once.
        button.textContent='Migrating…';$('mig-status').textContent='Rechecking and writing '+stats.read+' records…';
        const result=await api('/api/migration-plans/'+migrationState.plan.id+'/test-batch/execute',{method:'POST',headers:{'idempotency-key':newIdempotencyKey()},body:JSON.stringify({confirm:true,previewRunId:preview.runId})});
        migrationState.plan=await api('/api/migration-plans/'+migrationState.plan.id);
        const verification=result.verification;
        const failed=(verification?.items||[]).filter(item=>item.error||item.mismatches?.length);
        const errorList=failed.length?'<div class="batch-error-list">'+failed.map(item=>'<div class="batch-error-row"><b>'+esc(item.sourceId)+'</b><span>'+esc(item.error||('Mismatch: '+item.mismatches.map(m=>m.field).join(', ')))+'</span></div>').join('')+'</div>':'';
        $('batch-result').className='batch-result'+(verification?.passed?'':' error');
        $('batch-result').hidden=false;
        $('batch-result').innerHTML='<b>'+(verification?.passed?'Batch verified':'Batch not verified')+'</b><br>'+esc(verificationSummary(verification))+errorList;
        if(verification?.passed&&currentCanaryPassed())showCanaryPassed(verificationSummary(verification));
        else{migrationState.canaryVerified=false;$('mig-status').textContent=verificationSummary(verification)}
        await Promise.all([loadRuns(),loadMetrics(),loadSavedPlans()]);
      }catch(e){
        $('batch-result').className='batch-result error';$('batch-result').hidden=false;$('batch-result').textContent=e.message;
        $('mig-status').textContent=e.message;
      }finally{button.disabled=false;button.textContent='Migrate batch'}
    };
    async function generatePreview(){if(!currentCanaryPassed()){const remaining=untestedTypes();$('mig-status').textContent=remaining.length&&migrationState.plan?.canary?.verification?.passed?'Test a record of every selected object first (still untested: '+remaining.map(testTypeLabel).join(', ')+').':'Pass a verified test before preparing the full migration.';return}try{const plan=await ensurePlan();$('mig-status').textContent='Preparing full migration…';$('preview').disabled=true;const result=await api('/api/migration-plans/'+plan.id+'/preview',{method:'POST'});migrationState.preview=result;migrationState.plan=await api('/api/migration-plans/'+plan.id);renderPlans(result.plans);renderPreviewActions(result.plans);$('execute').disabled=result.plans.some(p=>p.action==='ambiguous')||!result.plans.length;$('mig-status').textContent=result.runId.slice(0,8)+' · '+result.plans.length+' records ready for review';$('summary-preflight').textContent='Passed';updateMigrationStepper();await loadRuns();await loadSavedPlans()}catch(e){$('mig-status').textContent=e.message;updateMigrationStepper()}finally{$('preview').disabled=false}}
    $('preview').onclick=generatePreview;$('side-preview').onclick=()=>goMigrationStep('preview');
    function renderPreviewActions(plans){const actions=['create','update','match','skip','conflict','ambiguous','review','error'];const counts=Object.fromEntries(actions.map(action=>[action,plans.filter(p=>p.action===action).length]));$('preview-actions').innerHTML=actions.map(action=>'<div class="preview-action"><b>'+counts[action]+'</b><span>'+action+'</span></div>').join('')+'<p class="preview-scope" role="note">Records only: relationships (contact–company links, deal associations) are not migrated and are not backfilled later by live sync.</p>'}
    function renderPlans(plans){$('plans').innerHTML=plans.length?plans.map(p=>'<tr><td><span class="pill '+p.action+'">'+esc(p.action)+'</span></td><td>'+esc(p.type)+'</td><td>'+esc(p.naturalKey||'—')+
      '</td><td>'+esc(p.targetId||'new')+'</td><td>'+esc(p.fieldDiff.map(d=>d.field).join(', ')||p.warnings.join('; ')||'No changes')+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">No records in this scope.</td></tr>'}
    $('execute').onclick=async()=>{if(!migrationState.plan||!migrationState.preview)return;const confirmed=await requestTypedConfirmation({title:'Run full migration',message:'This writes every reviewed record in the prepared migration to the destination CRM, exactly as previewed. It can run once.',token:'EXECUTE',buttonLabel:'Run migration'});if(!confirmed)return;const key=newIdempotencyKey();try{$('execute').disabled=true;$('mig-status').textContent='Rechecking the prepared migration…';const result=await api('/api/migration-plans/'+migrationState.plan.id+'/execute',{method:'POST',headers:{'idempotency-key':key},body:JSON.stringify({confirm:true})});await followExecution(result.execution.id)}catch(e){$('mig-status').textContent=e.code==='approval_invalidated'||e.code==='preview_drift'?e.message+' — prepare the migration again.':e.message}};

    // Durable runs (R08) keep going if this page closes; this only reports progress, at a
    // bounded rate that slows down for long runs.
    // R13 resumable runs: a running execution can be paused or cancelled; a paused one resumed.
    function renderExecutionControls(execution){const id=execution.id;const p=execution.progress||{};
      $('run-banner').hidden=false;
      $('run-banner-text').textContent='Migration run '+id.slice(0,8)+': '+execution.status+' · '+(p.succeeded||0)+' written/linked, '+(p.failed||0)+' failed, '+(p.queued||0)+' waiting'+(execution.pauseReason?' · '+execution.pauseReason:'');
      const controls=
      execution.status==='running'?[['pause','Pause'],['cancel','Cancel']]:
      execution.status==='paused'?[['resume','Resume'],['resume-retry','Resume and retry failed'],['cancel','Cancel']]:[];
      $('execution-controls').innerHTML=controls.map(([action,label])=>'<button class="'+(action==='cancel'?'danger':'secondary')+'" type="button" data-action="executionControl" data-arg="'+esc(id)+':'+action+'">'+label+'</button>').join(' ')}
    async function executionControl(arg){const [id,action]=String(arg).split(':');
      $('execution-controls').querySelectorAll('button').forEach(b=>b.disabled=true);
      await api('/api/executions/'+encodeURIComponent(id)+'/'+(action==='resume-retry'?'resume':action),{method:'POST',body:JSON.stringify(action==='resume-retry'?{retryFailed:true}:{})});
      await followExecution(id)}
    window.executionControl=executionControl;
    window.viewExecution=(id)=>followExecution(id);
    async function followExecution(id){let delay=1500;while(true){const execution=await api('/api/executions/'+id),p=execution.progress||{};renderExecutionControls(execution);$('mig-status').textContent='Run '+id.slice(0,8)+' · '+execution.status+' · '+(p.succeeded||0)+' written/linked, '+(p.skipped||0)+' skipped, '+(p.failed||0)+' failed, '+(p.queued||0)+' queued'+(execution.pauseReason?' · '+execution.pauseReason:'');if(['succeeded','partial','failed','cancelled'].includes(execution.status)){$('summary-preview').textContent=execution.status==='succeeded'?'Migration complete':'Migration '+execution.status;await Promise.all([loadRuns(),loadMetrics(),loadSavedPlans()]);return execution}if(execution.status==='paused'){$('summary-preview').textContent='Paused';return execution}await new Promise(resolve=>setTimeout(resolve,delay));delay=Math.min(10000,Math.round(delay*1.3))}}
    async function deleteSavedPlan(id){
      const plan=migrationState.savedPlans?.find(p=>p.id===id)||(migrationState.plan?.id===id?migrationState.plan:null);
      const name=plan?.name||'this migration plan';
      if(!confirm('Delete migration plan "'+name+'"? This cannot be undone.'))return;
      try{
        await api('/api/migration-plans/'+encodeURIComponent(id),{method:'DELETE'});
        showNotice('Migration plan "'+name+'" deleted.');
        if(migrationState.plan?.id===id){
          migrationState.plan=null;
          markPlanDirty();
          $('summary-plan').textContent='Unsaved draft';
          setDraftStatus('Plan deleted');
        }
        await loadSavedPlans();
      }catch(e){
        showError(e.message||'Failed to delete migration plan');
      }
    }
    window.deleteSavedPlan=deleteSavedPlan;
    async function loadSavedPlans(){const result=await api('/api/migration-plans');migrationState.savedPlans=result.entries;$('saved-plan-count').textContent=result.entries.length;$('saved-plans').innerHTML=result.entries.length?result.entries.map(plan=>'<article class="plan-item" data-plan="'+plan.id+'"><div class="plan-name"><span>'+esc(plan.name)+'</span><span class="pill '+(plan.status==='completed'?'completed':plan.status==='failed'?'error':'queued')+'">'+esc(plan.status)+'</span></div><div class="plan-meta">'+esc(plan.source==='salesforce'?'Salesforce → HubSpot':'HubSpot → Salesforce')+' · '+plan.types.length+' objects · revision '+plan.revision+'</div><div class="plan-meta">'+esc(plan.canary?.verifiedAt?'One-record test passed':plan.canary?'Test record ready':'One-record test required')+'</div><div class="plan-meta" style="display:flex;gap:8px;margin-top:6px;align-items:center;">'+(plan.activeExecutionId?'<button class="secondary" type="button" data-action="viewExecution" data-arg="'+esc(plan.activeExecutionId)+'">View run</button>':'')+'<button class="danger secondary" type="button" data-action="deleteSavedPlan" data-arg="'+esc(plan.id)+'"'+(plan.status==='executing'||plan.activeExecutionId?' disabled title="Cannot delete an executing plan"':'')+'>Delete</button></div></article>').join(''):'<div class="empty">No saved plans yet. Configure the builder and your first draft will appear here.</div>';$('saved-plans').querySelectorAll('[data-plan]').forEach(item=>item.onclick=(event)=>{if(event.target.closest('[data-action]'))return;loadPlan(item.dataset.plan)})}
    async function loadPlan(id){const plan=await api('/api/migration-plans/'+id);selectMigrateTab('builder');migrationState.plan=plan;migrationState.dirty=false;migrationState.selected=new Set(plan.types);migrationState.preview=null;migrationState.canaryPreview=null;migrationState.canaryVerified=Boolean(plan.canary?.verifiedAt&&plan.canary.previewRevision===plan.revision);migrationState.preflight=null;migrationState.mapping=null;resetCopilot();$('plan-name').value=plan.name;$('mig-from').value=plan.source;setStoredMigrationFrom(plan.source);$('mig-limit').value=plan.limitPerType||20;updateDirectionPreview();setDraftStatus('Loaded revision '+plan.revision,'saved');await loadCatalog(plan.source);$('summary-plan').textContent=plan.name+' · r'+plan.revision;$('summary-preflight').textContent=plan.status==='validated'||plan.status==='previewed'||plan.status==='completed'?'Passed':'Not run';$('summary-preview').textContent=migrationState.canaryVerified?'Passed':plan.canary?'Ready':'Required';$('full-migration').hidden=!migrationState.canaryVerified;$('test-record-result').hidden=true;
      const hasCurrentPreview=plan.previewRunId&&plan.previewRevision===plan.revision;if(hasCurrentPreview){const frozen=await api('/api/migrations/'+plan.previewRunId+'/items?limit=2000');migrationState.preview={runId:plan.previewRunId,plans:frozen.entries};renderPlans(frozen.entries);renderPreviewActions(frozen.entries);$('mig-status').textContent=plan.previewRunId.slice(0,8)+' · prepared migration loaded';$('execute').disabled=!frozen.entries.length||frozen.entries.some(item=>item.action==='ambiguous')}else{$('execute').disabled=true}updateMigrationSummary();updateMigrationStepper()}
    function updateMigrationSummary(){const rows=selectedCatalogRows(),direction=$('mig-from').value==='salesforce'?'Salesforce → HubSpot':'HubSpot → Salesforce';$('summary-direction').textContent=direction;$('summary-objects').textContent=migrationState.selected.size+' selected';const mapped=rows.reduce((n,row)=>n+row.mappedFields,0),total=rows.reduce((n,row)=>n+row.totalMappedFields,0);$('summary-coverage').textContent=total?Math.round(mapped/total*100)+'%':'—';if(!migrationState.plan)$('summary-plan').textContent='Unsaved draft';updateDeletePlanButton()}
    async function loadRuns(){const r=await api('/api/migrations');migrationState.runs=r.entries;$('run-count').textContent=r.entries.length;const latest=r.entries[0];$('latest-run-shortcut').textContent=latest?'Latest run · '+latest.status:'View run history';renderMigrationRuns()}
    function renderMigrationRuns(){const query=$('run-search').value.trim().toLowerCase(),status=$('run-status-filter').value,mode=$('run-mode-filter').value;const entries=migrationState.runs.filter(run=>(!query||(run.id+' '+run.source).toLowerCase().includes(query))&&(!status||run.status===status)&&(!mode||run.mode===mode));$('runs').innerHTML=entries.length?'<table><thead><tr><th>Run</th><th>Mode</th><th>Source</th><th>Status</th><th>Started</th></tr></thead><tbody>'+
      entries.map(x=>'<tr><td><button class="run-link" data-run-id="'+esc(x.id)+'">'+esc(x.id.slice(0,8))+'</button></td><td>'+esc(x.mode)+'</td><td>'+esc(x.source)+'</td><td><span class="pill '+esc(x.status)+'">'+esc(x.status)+'</span></td><td>'+esc(new Date(x.createdAt).toLocaleString())+'</td></tr>').join('')+'</tbody></table><div class="run-detail" id="run-detail"></div>':'<div class="empty history-empty">No migration runs match these filters.</div>';$('runs').querySelectorAll('[data-run-id]').forEach(button=>button.onclick=()=>loadRunDetail(button.dataset.runId))}
    async function loadRunDetail(id){const r=await api('/api/migrations/'+id+'/items?limit=200');$('run-detail').innerHTML='<div class="card-head"><h2>Run '+esc(id.slice(0,8))+'</h2><span class="section-note">'+r.entries.length+' reviewed records</span></div><div class="scroll"><table><thead><tr><th>Action</th><th>Object</th><th>Natural key</th><th>Target</th></tr></thead><tbody>'+r.entries.map(item=>'<tr><td><span class="pill '+esc(item.action)+'">'+esc(item.action)+'</span></td><td>'+esc(item.type)+'</td><td>'+esc(item.naturalKey||'—')+'</td><td>'+esc(item.targetId||'New record')+'</td></tr>').join('')+'</tbody></table></div>'}
    $('run-search').oninput=renderMigrationRuns;$('run-status-filter').onchange=renderMigrationRuns;$('run-mode-filter').onchange=renderMigrationRuns;
    $('refresh-runs').onclick=async()=>{
      const btn=$('refresh-runs');if(!btn||btn.disabled)return;
      const orig=btn.textContent||'Refresh';btn.disabled=true;btn.textContent='Refreshing…';showProgressBar();
      try{await loadRuns();btn.textContent='Refreshed ✓';btn.classList.add('btn-refreshed');showNotice('Migration run history refreshed.');setTimeout(()=>{btn.textContent=orig;btn.classList.remove('btn-refreshed');btn.disabled=false},1500)}
      catch(e){showError('Failed to refresh migration runs: '+(e.message||e));btn.textContent=orig;btn.disabled=false}
      finally{hideProgressBar()}};

    let syncConfigState;
    let syncObjectCatalog=[];
    async function loadSyncWorkspace(){await Promise.all([loadMetrics(),loadSyncSettings(),loadSyncConflicts()])}
    async function loadSyncSettings(){
      const [config,objectMappings]=await Promise.all([api('/api/sync/settings'),api('/api/object-mappings')]);
      syncConfigState=config;syncObjectCatalog=objectMappings.entries;
      $('sync-conflict-strategy').value=config.conflictStrategy;$('sync-source-of-truth').value=config.sourceOfTruth;
      renderSyncObjectRows(config);
      $('webhook-health').innerHTML=Object.entries(config.webhooks).map(([system,value])=>'<div class="webhook-card"><div class="webhook-card-head"><b>'+esc(system==='salesforce'?'Salesforce':'HubSpot')+'</b><span class="pill '+(value.connected&&value.signingConfigured?'completed':'ambiguous')+'">'+(value.connected&&value.signingConfigured?'Healthy':'Needs attention')+'</span></div><p>'+esc(value.connected?'Account connected':'Account disconnected')+' · '+esc(value.signingConfigured?'signature verification configured':'signing secret missing')+'</p></div>').join('')}
    $('sync-conflict-strategy').onchange=()=>{if(syncConfigState)syncConfigState.conflictStrategy=$('sync-conflict-strategy').value};
    $('sync-source-of-truth').onchange=()=>{if(syncConfigState)syncConfigState.sourceOfTruth=$('sync-source-of-truth').value};
    function minutesToUnit(min){if(min%1440===0)return{value:min/1440,unit:'days'};if(min%60===0)return{value:min/60,unit:'hours'};return{value:min,unit:'minutes'}}
    function unitToMinutes(value,unit){const n=Number(value)||0;return unit==='days'?n*1440:unit==='hours'?n*60:n}
    function pollingStatusText(status){if(!status)return 'No scheduled poll has run yet.';
      // A poll failure happens before any sync job/event exists, so it has no dead-letter row
      // anywhere else to inspect -- this is the only place the actual cause is ever shown.
      const detail=status.errors&&status.errorMessages?.length?' — '+status.errorMessages.join(' · '):'';
      return 'Last run '+new Date(status.at).toLocaleString()+' · '+status.changed+' change'+(status.changed===1?'':'s')+', '+status.deleted+' deletion'+(status.deleted===1?'':'s')+(status.errors?', '+status.errors+' error'+(status.errors===1?'':'s')+detail:'')}
    // Only objects that finished the Sync setup wizard (enrolledForSync) ever appear here --
    // a canonical object can be registered for Migration alone and never show up in Sync.
    function enrolledSyncCatalog(){return syncObjectCatalog.filter(obj=>syncConfigState?.objects?.[obj.canonicalObject]?.enrolledForSync)}
    // Sync tab loads via two independent calls that can land close together (the page's
    // initial hash-based selectView('sync') and its own unconditional refreshAll()), each
    // fully re-rendering #sync-object-settings -- a plain "hidden = !hidden" toggle on a
    // freshly re-created element would get silently reset by whichever render lands second.
    // Tracking which objects' history panels are open here, and re-applying that on every
    // render, keeps the toggle correct regardless of how many renders overlap.
    const openHistoryPanels=new Set();
    function renderSyncObjectRows(config){
      const enrolled=enrolledSyncCatalog();
      $('sync-object-settings').innerHTML=enrolled.length?enrolled.map(obj=>syncObjectRowHtml(obj,config)).join(''):'<div class="empty">No objects added to sync yet — use "+ Add object to sync" below.</div>';
      enrolled.forEach(obj=>{const type=obj.canonicalObject;
        $('poll-now-'+type).onclick=()=>pollObjectNow(type);$('map-fields-'+type).onclick=()=>goMapFields(type);$('edit-conditions-'+type).onclick=()=>openSyncWizardForEdit(type);
        document.querySelector('[data-sync-enabled="'+type+'"]').onchange=e=>setPollRowEnabled(type,e.target.checked);
        const stratSelect=document.querySelector('[data-object-strategy="'+type+'"]');
        if(stratSelect)stratSelect.onchange=e=>{
          if(!syncConfigState.objects[type])syncConfigState.objects[type]={enabled:true,direction:'bidirectional'};
          if(e.target.value)syncConfigState.objects[type].conflictStrategy=e.target.value;
          else delete syncConfigState.objects[type].conflictStrategy;
        };
        const sotSelect=document.querySelector('[data-object-sot="'+type+'"]');
        if(sotSelect)sotSelect.onchange=e=>{
          if(!syncConfigState.objects[type])syncConfigState.objects[type]={enabled:true,direction:'bidirectional'};
          if(e.target.value)syncConfigState.objects[type].sourceOfTruth=e.target.value;
          else delete syncConfigState.objects[type].sourceOfTruth;
        };
        document.querySelector('[data-poll-mode="'+type+'"]').onchange=e=>{
          const cron=e.target.value==='cron';
          document.querySelector('[data-poll-interval-fields="'+type+'"]').hidden=cron;
          document.querySelector('[data-poll-cron-fields="'+type+'"]').hidden=!cron;
          if(cron)previewCronExpression(type);
        };
        const cronInput=document.querySelector('[data-poll-cron="'+type+'"]');
        let cronDebounce;
        cronInput.oninput=()=>{clearTimeout(cronDebounce);cronDebounce=setTimeout(()=>previewCronExpression(type),400)};
        if(config.polling[type]?.cron)previewCronExpression(type);
        $('toggle-history-'+type).onclick=()=>toggleSyncHistory(type);
        $('remove-sync-'+type).onclick=()=>removeFromSync(type,obj.label);
        if(openHistoryPanels.has(type))renderSyncHistoryPanel(type);
      });
    }
    // Live "next run" feedback as the cron field is typed -- calls the exact same calculation
    // SyncPoller itself uses to decide when an object is next due, so this can never disagree
    // with what will actually happen once saved.
    async function previewCronExpression(type){
      const input=document.querySelector('[data-poll-cron="'+type+'"]'),next=document.querySelector('[data-poll-cron-next="'+type+'"]');
      const expr=input.value.trim();
      if(!expr){next.textContent='';next.className='muted';return}
      try{
        const res=await api('/api/sync/cron-preview?expr='+encodeURIComponent(expr));
        next.className='muted';next.textContent='Next: '+res.occurrences.map(iso=>new Date(iso).toLocaleString()).join(', ');
      }catch{next.className='muted error';next.textContent='Not a valid cron expression.'}
    }
    function renderSyncHistoryPanel(type){
      const panel=$('poll-history-'+type);if(!panel)return;
      panel.hidden=false;panel.innerHTML=pollHistoryHtml(syncConfigState?.pollHistory?.[type]);
    }
    function toggleSyncHistory(type){
      if(openHistoryPanels.has(type)){openHistoryPanels.delete(type);$('poll-history-'+type).hidden=true}
      else{openHistoryPanels.add(type);renderSyncHistoryPanel(type)}
    }
    // Un-enrolls the object from Sync without deleting its underlying registration/field
    // mappings -- Migration (if it also uses this object) is unaffected, and re-adding it
    // later through the wizard reuses the same canonical object instead of creating a
    // duplicate one, since the Salesforce+HubSpot pair still matches exactly.
    async function removeFromSync(type,label){
      if(!confirm('Remove '+label+' from Sync? It stops syncing (webhook and scheduled) immediately. You can add it back later from "+ Add object to sync".'))return;
      try{
        const current=syncConfigState.objects[type];
        syncConfigState=await api('/api/sync/settings',{method:'PATCH',body:JSON.stringify({
          conflictStrategy:syncConfigState.conflictStrategy,sourceOfTruth:syncConfigState.sourceOfTruth,
          objects:{[type]:{...current,enabled:false,enrolledForSync:false}},
        })});
        await loadSyncSettings();
      }catch(e){showError(e.message,e.requestId)}
    }
    // Live-updates the poll sub-row's disabled/greyed state as soon as the master checkbox is
    // toggled, without waiting for a save + full re-render -- the whole point is that checking
    // it while the master switch is off has no effect, so the controls shouldn't look usable.
    function setPollRowEnabled(type,masterEnabled){
      const row=document.querySelector('[data-poll-row="'+type+'"]');if(row){
        row.classList.toggle('disabled',!masterEnabled);
        row.querySelectorAll('input,select,button').forEach(el=>el.disabled=!masterEnabled);
        const statusEl=$('poll-status-'+type);
        if(statusEl)statusEl.textContent=masterEnabled?statusEl.dataset.pollStatusText:'Turn on "Sync enabled" above to use scheduled polling.';
      }
      const conflictRow=document.querySelector('[data-conflict-row="'+type+'"]');if(conflictRow){
        conflictRow.classList.toggle('disabled',!masterEnabled);
        conflictRow.querySelectorAll('select').forEach(el=>el.disabled=!masterEnabled);
      }
    }
    function directionLabel(direction){return direction==='salesforce_to_hubspot'?'Salesforce → HubSpot':direction==='hubspot_to_salesforce'?'HubSpot → Salesforce':'Bidirectional'}
    function capitalizeWord(word){return word?word.charAt(0).toUpperCase()+word.slice(1):word}
    // Direction is chosen up front in the Sync setup wizard (step 1) -- showing it again here
    // as a second, independently-editable control was confusing and let it drift out of sync
    // with the conditions already configured for that direction's source system. It's
    // display-only here; "Conditions" reopens the wizard (starting at direction) to change it.
    //
    // The checkbox above ("Sync enabled") is the master switch -- nothing syncs for this
    // object, by webhook OR by schedule, while it's off. "Also poll on a schedule" is a
    // sub-setting under it, not a peer: the scheduler itself checks the master switch before
    // ever running (see SyncPoller.pollObject), so checking it while the master is off was
    // previously a checkbox that visually worked but silently did nothing. It's now greyed out
    // and disabled to match, rather than offering a control with no effect.
    function syncObjectRowHtml(obj,config){
      const type=obj.canonicalObject,value=config.objects[type]||{enabled:false,direction:'bidirectional'},polling=config.polling[type]||{enabled:false,intervalMinutes:30},unit=minutesToUnit(polling.intervalMinutes),status=config.pollingStatus&&config.pollingStatus[type];
      const cronMode=Boolean(polling.cron),dis=value.enabled?'':'disabled',objStrat=value.conflictStrategy||'source-of-truth',objSot=value.sourceOfTruth||'salesforce';
      const sfLabel=capitalizeWord(obj.salesforceObject||'—'),hsLabel=capitalizeWord(obj.hubspotObject||'—');
      const pairLabel=value.direction==='hubspot_to_salesforce'?(hsLabel+' → '+sfLabel):(sfLabel+' → '+hsLabel);
      return '<div class="object-sync-row">'
        +'<div class="object-sync-main"><label><input type="checkbox" data-sync-enabled="'+esc(type)+'" '+(value.enabled?'checked':'')+' title="Master switch -- turns sync off entirely, both webhooks and scheduled polling, when unchecked"><b>'+esc(pairLabel)+'</b><span class="muted" style="font-weight:400;font-size:11px"> · Sync enabled</span></label>'
        +'<span class="pill '+(value.enabled?'completed':'queued')+'">'+(value.enabled?'Live':'Paused')+'</span>'
        +'<span class="muted" data-sync-direction-label="'+esc(type)+'">'+esc(directionLabel(value.direction))+'</span></div>'
        +'<div class="object-conflict-row'+(value.enabled?'':' disabled')+'" data-conflict-row="'+esc(type)+'">'
        +'<label>Conflict strategy: <select data-object-strategy="'+esc(type)+'" '+dis+'><option value="source-of-truth" '+(objStrat==='source-of-truth'?'selected':'')+'>Source of truth</option><option value="last-write-wins" '+(objStrat==='last-write-wins'?'selected':'')+'>Last write wins</option><option value="field-merge" '+(objStrat==='field-merge'?'selected':'')+'>Field merge</option></select></label>'
        +'<label>Source of truth: <select data-object-sot="'+esc(type)+'" '+dis+'><option value="salesforce" '+(objSot==='salesforce'?'selected':'')+'>Salesforce</option><option value="hubspot" '+(objSot==='hubspot'?'selected':'')+'>HubSpot</option></select></label></div>'
        +'<div class="object-poll-row'+(value.enabled?'':' disabled')+'" data-poll-row="'+esc(type)+'">'
        +'<div class="poll-schedule-line">'
        +'<label class="poll-enable-label"><input type="checkbox" data-poll-enabled="'+esc(type)+'" '+(polling.enabled?'checked':'')+' '+dis+'><span>Also poll on a schedule</span></label>'
        +'<div class="poll-cadence">'
        +'<select data-poll-mode="'+esc(type)+'" '+dis+'><option value="interval" '+(cronMode?'':'selected')+'>Every</option><option value="cron" '+(cronMode?'selected':'')+'>Cron schedule</option></select>'
        +'<span class="poll-interval-fields" data-poll-interval-fields="'+esc(type)+'" '+(cronMode?'hidden':'')+'>'
        +'<input type="number" min="1" step="1" value="'+unit.value+'" data-poll-value="'+esc(type)+'" '+dis+'>'
        +'<select data-poll-unit="'+esc(type)+'" '+dis+'><option value="minutes" '+(unit.unit==='minutes'?'selected':'')+'>Minutes</option><option value="hours" '+(unit.unit==='hours'?'selected':'')+'>Hours</option><option value="days" '+(unit.unit==='days'?'selected':'')+'>Days</option></select>'
        +'</span>'
        +'<span class="poll-cron-fields" data-poll-cron-fields="'+esc(type)+'" '+(cronMode?'':'hidden')+'>'
        +'<input type="text" placeholder="0 9 * * 1 (every Monday at 9am)" value="'+esc(polling.cron||'')+'" data-poll-cron="'+esc(type)+'" '+dis+'>'
        +'<span class="muted" data-poll-cron-next="'+esc(type)+'"></span>'
        +'</span>'
        +'</div></div>'
        +'<div class="poll-action-line">'
        +'<button class="secondary poll-now-btn" id="poll-now-'+esc(type)+'" type="button" '+dis+'>Sync now</button>'
        +'<span class="muted poll-status-text'+(status?.errors?' error':'')+'" id="poll-status-'+esc(type)+'" data-poll-status-text="'+esc(pollingStatusText(status))+'">'+esc(value.enabled?pollingStatusText(status):'Turn on "Sync enabled" above to use scheduled polling.')+'</span>'
        +'</div></div>'
        +'<div class="object-links-row"><button class="run-link" id="map-fields-'+esc(type)+'" type="button">Map fields</button>'
        +'<button class="run-link" id="edit-conditions-'+esc(type)+'" type="button">Direction &amp; conditions</button>'
        +'<button class="run-link" id="toggle-history-'+esc(type)+'" type="button">History</button>'
        +'<button class="run-link" style="color:var(--red)" id="remove-sync-'+esc(type)+'" type="button">Remove from sync</button></div>'
        +'<div class="poll-history" id="poll-history-'+esc(type)+'" hidden></div>'
        +'</div>';
    }
    function pollHistoryHtml(entries){
      if(!entries||!entries.length)return '<div class="empty">No runs recorded yet.</div>';
      return entries.map(entry=>{
        const detail=entry.errors&&entry.errorMessages?.length?' — '+entry.errorMessages.join(' · '):'';
        return '<div class="poll-history-row'+(entry.errors?' error':'')+'"><span>'+esc(new Date(entry.at).toLocaleString())+'</span><span>'+entry.changed+' change'+(entry.changed===1?'':'s')+', '+entry.deleted+' deletion'+(entry.deleted===1?'':'s')+(entry.errors?', '+entry.errors+' error'+(entry.errors===1?'':'s')+detail:'')+'</span></div>';
      }).join('');
    }
    function collectSyncObjects(){
      return Object.fromEntries(enrolledSyncCatalog().map(obj=>{
        const type=obj.canonicalObject;
        const strat=document.querySelector('[data-object-strategy="'+type+'"]')?.value||undefined;
        const sot=document.querySelector('[data-object-sot="'+type+'"]')?.value||undefined;
        return [type,{
          enabled:document.querySelector('[data-sync-enabled="'+type+'"]').checked,
          direction:syncConfigState.objects[type]?.direction||'bidirectional',
          ...(strat?{conflictStrategy:strat}:{conflictStrategy:''}),
          ...(sot?{sourceOfTruth:sot}:{sourceOfTruth:''}),
        }];
      }));
    }
    function collectSyncPolling(){return Object.fromEntries(enrolledSyncCatalog().map(obj=>{
      const type=obj.canonicalObject,isCron=document.querySelector('[data-poll-mode="'+type+'"]').value==='cron';
      return [type,{
        enabled:document.querySelector('[data-poll-enabled="'+type+'"]').checked,
        intervalMinutes:unitToMinutes(document.querySelector('[data-poll-value="'+type+'"]').value,document.querySelector('[data-poll-unit="'+type+'"]').value),
        cron:isCron?document.querySelector('[data-poll-cron="'+type+'"]').value.trim():null,
      }];
    }))}
    function persistSyncSettings(){return api('/api/sync/settings',{method:'PATCH',body:JSON.stringify({conflictStrategy:$('sync-conflict-strategy').value,sourceOfTruth:$('sync-source-of-truth').value,objects:collectSyncObjects(),polling:collectSyncPolling()})})}
    $('save-sync-settings').onclick=async()=>{const button=$('save-sync-settings'),message=$('sync-settings-message');button.disabled=true;button.textContent='Saving policy…';message.className='settings-message';message.textContent='Saving sync policy…';showProgressBar();try{syncConfigState=await persistSyncSettings();message.textContent='Saved. Webhooks use this immediately; scheduled sync within one interval.';await loadSyncSettings();button.textContent='Saved ✓';button.classList.add('btn-refreshed');showNotice('Sync policy saved. Webhooks use this immediately; scheduled sync within one interval.');setTimeout(()=>{button.textContent='Save policy';button.classList.remove('btn-refreshed')},1500)}catch(e){button.textContent='Save policy';message.className='settings-message error';message.textContent=e.message;showError('Failed to save sync policy: '+(e.message||e),e.requestId)}finally{button.disabled=false;hideProgressBar()}};
    async function pollObjectNow(type){
      const btn=$('poll-now-'+type),statusEl=$('poll-status-'+type),pollCheckbox=document.querySelector('[data-poll-enabled="'+type+'"]');
      btn.disabled=true;statusEl.className='muted';
      try{
        // "Sync now" also turns the scenario on, so future changes keep syncing on the
        // configured interval instead of this being a one-off run.
        if(!pollCheckbox.checked){statusEl.textContent='Starting scheduled sync…';pollCheckbox.checked=true;syncConfigState=await persistSyncSettings()}
        statusEl.textContent='Syncing now…';
        const summary=await api('/api/sync/poll-now',{method:'POST',body:JSON.stringify({type})});
        statusEl.textContent='Done: '+summary.changed+' change'+(summary.changed===1?'':'s')+', '+summary.deleted+' deletion'+(summary.deleted===1?'':'s')+' synced. Scheduled sync is now on — future changes sync automatically.';
        await Promise.all([loadMetrics(),loadSyncSettings()]);
      }catch(e){statusEl.className='muted error';statusEl.textContent=e.message}finally{btn.disabled=false}
    }
    // Ensures migrationState.catalog actually contains a row for this sync object before the
    // Fields step reads it -- unlike Migration, Sync can be reached without ever having
    // visited the Objects step this session, and the catalog is fetched per source system
    // (mig-from), so an object registered from the "other" side wouldn't be there yet.
    async function ensureCatalogForSyncObject(type){
      if(migrationState.catalog.some(row=>row.canonicalType===type))return;
      await loadCatalog('salesforce');
    }
    async function loadFieldMappingWorkspace(preferredType){
      if(workspaceMode==='sync'){
        await Promise.all([syncConfigState?Promise.resolve():loadSyncSettings(),migrationState.catalog.length?Promise.resolve():loadCatalog('salesforce')]);
        if(preferredType)await ensureCatalogForSyncObject(preferredType);
      }else{
        migrationState.currentStep='fields';migrationState.visited.add('fields');
        const from=$('mig-from').value==='hubspot'?'hubspot':'salesforce';
        if(!migrationState.catalog.length||migrationState.catalogSource!==from){
          await Promise.allSettled([loadCatalog(from),loadSavedPlans(),loadRuns()]);
        }
      }
      refreshObjectSelectors();
      const rows=fieldQueueRows();
      const targetType=(preferredType&&migrationState.catalog.some(row=>row.canonicalType===preferredType))
        ?preferredType
        :(rows[0]?.canonicalType||preferredType||$('field-object').value||[...migrationState.selected][0]||'');
      if(!targetType)return;
      $('field-object').value=targetType;
      setStoredFieldMappingOrigin(workspaceMode,targetType);
      if(document.querySelector('.view.active')?.id==='view-field-mapping'){
        const hash=fieldMappingHash(workspaceMode,targetType);
        if(location.hash!==hash)history.replaceState(null,'',hash);
      }
      await loadFieldWorkspace(targetType);
      if(workspaceMode==='migration')updateMigrationStepper();
    }
    async function openFieldMappingPage(origin,type){
      workspaceMode=origin==='sync'?'sync':'migration';
      const resolvedType=type||$('field-object').value||migrationState.mapping?.type||getStoredFieldMappingObject()||(workspaceMode==='sync'?'':[...migrationState.selected][0])||'';
      if(migrationState.mapping?.dirty&&resolvedType&&migrationState.mapping.type!==resolvedType){
        try{await saveFieldMappings(false)}catch{}
      }
      setStoredFieldMappingOrigin(workspaceMode,resolvedType);
      const hash=fieldMappingHash(workspaceMode,resolvedType);
      history.replaceState(null,'',hash);
      selectView(hash,{skipLoad:true});
      await loadFieldMappingWorkspace(resolvedType);
    }
    async function goMapFields(type){
      await openFieldMappingPage('sync',type);
    }

    // ---------------- Sync setup wizard: direction -> object pair (+ conditions) -> fields ----------------
    // Object picking always browses from Salesforce's catalog (GET /api/object-catalog?from=salesforce)
    // regardless of the chosen direction -- that one call already carries every Salesforce object
    // (each with its auto-matched HubSpot target, if any) AND the full HubSpot target list, so both
    // dropdowns populate from it. Two independent picks (rather than one auto-matched pair) are what
    // let a native object already registered one way (e.g. Salesforce Account -> HubSpot companies)
    // get registered a SECOND time under a different pairing (e.g. Account -> contacts, for Person
    // Accounts) -- the wizard no longer assumes "already has a canonical type" means "done."
    const syncWizard={active:false,editing:false,direction:null,browseSystem:null,type:null,schema:[],naturalKeyPending:false};
    const conditionOperators=[['eq','is'],['ne','is not'],['gt','>'],['lt','<'],['contains','contains'],['is_null','is empty'],['is_not_null','is not empty']];
    function resetSyncWizard(){syncWizard.active=false;syncWizard.editing=false;syncWizard.direction=null;syncWizard.browseSystem=null;syncWizard.type=null;syncWizard.schema=[];$('sync-wizard').hidden=true;document.querySelector('.sync-config-grid').hidden=false;$('sync-wizard-sf-object').disabled=false;$('sync-wizard-hs-object').disabled=false;$('sync-wizard-sf-object').onchange=sfObjectChangeForNewPairing;$('sync-wizard-hs-object').onchange=updateSyncWizardObjectState;$('sync-wizard-test-result').hidden=true;$('sync-wizard-check-result').textContent='';$('sync-wizard-pair-preview').textContent='';$('sync-wizard-edit-objects').hidden=true;$('sync-wizard-save-native-objects').hidden=true}
    function openSyncWizardNew(){
      syncWizard.active=true;syncWizard.editing=false;syncWizard.type=null;
      $('sync-wizard-heading').textContent='Add an object to sync';
      document.querySelector('.sync-config-grid').hidden=true;$('sync-wizard').hidden=false;
      $('sync-wizard-step-1').hidden=false;$('sync-wizard-step-2').hidden=true;
      document.querySelector('input[name="sync-wizard-direction"][value="salesforce_to_hubspot"]').checked=true;
      $('sync-wizard-message').textContent='';
    }
    // Editing an already-enrolled object still starts at direction (step 1, pre-selected with
    // its current value) rather than skipping straight to conditions -- direction and
    // conditions are two views of the same choice (a condition is scoped to whichever system
    // the direction makes the source), so changing one without revisiting the other would let
    // them drift apart. There's just one place direction is ever set: here.
    function openSyncWizardForEdit(type){
      const obj=syncObjectCatalog.find(o=>o.canonicalObject===type);if(!obj)return;
      const cfg=syncConfigState.objects[type]||{direction:'bidirectional'};
      syncWizard.active=true;syncWizard.editing=true;syncWizard.type=type;
      $('sync-wizard-heading').textContent='Edit sync setup: '+obj.label;
      document.querySelector('.sync-config-grid').hidden=true;$('sync-wizard').hidden=false;
      $('sync-wizard-step-1').hidden=false;$('sync-wizard-step-2').hidden=true;
      document.querySelectorAll('input[name="sync-wizard-direction"]').forEach(r=>{r.checked=r.value===(cfg.direction||'bidirectional')});
      $('sync-wizard-message').textContent='';
    }
    $('sync-wizard-cancel').onclick=resetSyncWizard;
    $('add-sync-object').onclick=openSyncWizardNew;
    $('sync-wizard-step1-continue').onclick=async()=>{
      syncWizard.direction=document.querySelector('input[name="sync-wizard-direction"]:checked').value;
      syncWizard.browseSystem=syncWizard.direction==='hubspot_to_salesforce'?'hubspot':'salesforce';
      $('sync-wizard-step-1').hidden=true;$('sync-wizard-step-2').hidden=false;
      $('sync-wizard-test-result').hidden=true;$('sync-wizard-check-result').textContent='';
      if(syncWizard.editing){
        const obj=syncObjectCatalog.find(o=>o.canonicalObject===syncWizard.type);
        $('sync-wizard-step2-hint').textContent='Editing when '+esc(obj.label)+' syncs, browsing '+(syncWizard.browseSystem==='salesforce'?'Salesforce':'HubSpot')+'\\'s schema.';
        $('sync-wizard-sf-object').innerHTML='<option>'+esc(obj.salesforceObject||'—')+'</option>';$('sync-wizard-sf-object').disabled=true;
        $('sync-wizard-hs-object').innerHTML='<option>'+esc(obj.hubspotObject||'—')+'</option>';$('sync-wizard-hs-object').disabled=true;
        $('sync-wizard-label-row').hidden=true;$('sync-wizard-pair-preview').textContent='';
        $('sync-wizard-step2-continue').hidden=true;$('sync-wizard-save-conditions').hidden=false;
        $('sync-wizard-edit-objects').hidden=false;$('sync-wizard-save-native-objects').hidden=true;$('sync-wizard-save-native-objects').disabled=true;
        await loadSyncWizardConditionsPanel(syncWizard.type,syncConfigState.objects[syncWizard.type]||{});
        return;
      }
      $('sync-wizard-step2-hint').textContent='Pick the object on each side. A match is suggested automatically, but either side can be changed -- useful when one native object needs to sync as something different (e.g. Salesforce Person Accounts as HubSpot contacts instead of companies).';
      $('sync-wizard-sf-object').disabled=false;$('sync-wizard-hs-object').disabled=false;
      $('sync-wizard-sf-object').innerHTML='<option value="">Loading objects…</option>';$('sync-wizard-hs-object').innerHTML='<option value="">Loading objects…</option>';
      $('sync-wizard-label-row').hidden=true;$('sync-wizard-conditions-panel').hidden=true;
      $('sync-wizard-step2-continue').hidden=false;$('sync-wizard-step2-continue').disabled=true;$('sync-wizard-save-conditions').hidden=true;
      $('sync-wizard-edit-objects').hidden=true;$('sync-wizard-save-native-objects').hidden=true;
      await Promise.all([loadCatalog('salesforce'),syncConfigState?Promise.resolve():loadSyncSettings()]);renderSyncWizardObjectOptions();
    };
    $('sync-wizard-step2-back').onclick=()=>{$('sync-wizard-step-2').hidden=true;$('sync-wizard-step-1').hidden=false};
    // row.supported only means "an auto-match by name already exists" (Migration's
    // auto-suggest signal) -- it's not a readiness gate. Here the user is picking BOTH sides
    // by hand, so every native object is offered, standard or custom: filtering to it
    // silently hid every custom Salesforce object (a custom object's name essentially never
    // matches a HubSpot object by name) and any standard object HubSpot has no same-named
    // counterpart for (Lead, Case, Campaign, ...). The native id is shown alongside the label
    // to tell apart two objects that happen to share a label (e.g. two objects both labeled
    // "Note").
    function isStandardTarget(source, target){
      if(!target||target.custom) return false;
      const norm = v => String(v||'').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
      return norm(target.id) === norm(source.id) || norm(target.label) === norm(source.label);
    }
    function isRowEnrolledInSync(row){
      return Boolean(row.canonicalType && syncConfigState?.objects?.[row.canonicalType]?.enrolledForSync);
    }
    function renderSyncWizardObjectOptions(){
      const bySource=new Map();
      for(const row of migrationState.catalog){
        if(!bySource.has(row.source.id)) bySource.set(row.source.id,[]);
        bySource.get(row.source.id).push(row);
      }
      const sortedSourceIds=[...bySource.keys()].sort((a,b)=>{
        const labelA=bySource.get(a)[0].source.label;
        const labelB=bySource.get(b)[0].source.label;
        return labelA.localeCompare(labelB);
      });
      const displayOptions=[];
      for(const sfId of sortedSourceIds){
        const rows=bySource.get(sfId);
        const enrolledRows=rows.filter(isRowEnrolledInSync);
        if(!enrolledRows.length){
          // If no mapping is done in Sync, show ONE option without any "already mapped" tag
          const preferredRow=rows.find(r=>r.mappedFields&&r.mappedFields>0)||rows.find(r=>!isStandardTarget(r.source,r.target))||rows[0];
          displayOptions.push({value:preferredRow.source.id,label:preferredRow.source.label,targetId:preferredRow.target?.id||'',tag:''});
        }else if(enrolledRows.length===1){
          // If exactly one mapping is enrolled in Sync, show that one
          const r=enrolledRows[0];
          displayOptions.push({value:r.source.id,label:r.source.label,targetId:r.target?.id||'',tag:' — already mapped to '+esc(r.target?.label||r.canonicalType)});
        }else{
          // If multiple mappings are enrolled in Sync, show all of them
          for(const r of enrolledRows){
            displayOptions.push({value:r.source.id,label:r.source.label,targetId:r.target?.id||'',tag:' — already mapped to '+esc(r.target?.label||r.canonicalType)});
          }
        }
      }
      $('sync-wizard-sf-object').innerHTML='<option value="">Choose an object…</option>'+displayOptions.map(opt=>'<option value="'+esc(opt.value)+'" data-target-id="'+esc(opt.targetId)+'">'+esc(opt.label)+' ('+esc(opt.value)+')'+opt.tag+'</option>').join('');
      $('sync-wizard-hs-object').innerHTML='<option value="">Choose an object…</option>'+(migrationState.targets||[]).slice().sort((a,b)=>a.label.localeCompare(b.label)).map(t=>'<option value="'+esc(t.id)+'">'+esc(t.label)+' ('+esc(t.id)+')'+'</option>').join('');
    }
    // Picking objects for a brand-new pairing and re-pointing an already-enrolled object's
    // pairing (via "Change objects…", below) need different onchange behavior -- the new-pairing
    // path may register a fresh canonical object on continue, which would be wrong for an edit
    // (it must update the SAME canonical type in place, never create a second one). The selects
    // only ever run one of these two handlers at a time, swapped in when each mode starts.
    function sfObjectChangeForNewPairing(){
      const sfSelect=$('sync-wizard-sf-object');
      const opt=sfSelect.options[sfSelect.selectedIndex];
      const targetId=opt?.dataset?.targetId;
      if(targetId){
        $('sync-wizard-hs-object').value=targetId;
      }else{
        const row=migrationState.catalog.find(r=>r.source.id===sfSelect.value);
        if(row?.target)$('sync-wizard-hs-object').value=row.target.id;
      }
      updateSyncWizardObjectState();
    }
    $('sync-wizard-sf-object').onchange=sfObjectChangeForNewPairing;
    $('sync-wizard-hs-object').onchange=updateSyncWizardObjectState;
    // The same native object can now legitimately appear as more than one catalog row (e.g.
    // Salesforce Account backing both "company" -> companies and a separately-registered
    // "account_contact" -> contacts) -- so once BOTH sides are picked, the row that actually
    // answers "is this exact pairing already registered" has to match on source AND target id
    // together, not source id alone (which would just resolve to whichever registration for
    // that native object happens to come first).
    function findExactCatalogRow(sfId,hsId){return migrationState.catalog.find(r=>r.source.id===sfId&&r.target?.id===hsId)}
    function updateSyncWizardObjectState(){
      const sfId=$('sync-wizard-sf-object').value,hsId=$('sync-wizard-hs-object').value;
      $('sync-wizard-conditions-panel').hidden=true;$('sync-wizard-step2-continue').disabled=true;$('sync-wizard-test-result').hidden=true;$('sync-wizard-check-result').textContent='';
      if(!sfId||!hsId){$('sync-wizard-label-row').hidden=true;$('sync-wizard-pair-preview').textContent='';return}
      const sfLabel=migrationState.catalog.find(r=>r.source.id===sfId)?.source.label||sfId;
      const hsLabel=(migrationState.targets||[]).find(t=>t.id===hsId)?.label||hsId;
      // Always shown, whether this exact pair is a brand-new pairing or one that's already
      // registered -- previously this only appeared for a new pairing, so picking the SAME
      // Salesforce object with a DIFFERENT (already-registered) HubSpot target looked like
      // nothing had happened, even though the picks were registered correctly underneath.
      $('sync-wizard-pair-preview').textContent='Salesforce '+sfLabel+' → HubSpot '+hsLabel;
      const exactRow=findExactCatalogRow(sfId,hsId);
      $('sync-wizard-label-row').hidden=Boolean(exactRow?.canonicalType);
      if(!exactRow?.canonicalType){
        const alreadyMappedElsewhere=migrationState.catalog.some(r=>r.source.id===sfId&&r.canonicalType&&syncConfigState?.objects?.[r.canonicalType]?.enrolledForSync);
        $('sync-wizard-label').value=alreadyMappedElsewhere?sfLabel+' ('+hsLabel+')':sfLabel;
      }
      syncWizardObjectReady();
    }
    async function syncWizardObjectReady(){
      const sfId=$('sync-wizard-sf-object').value,hsId=$('sync-wizard-hs-object').value;
      const exactRow=findExactCatalogRow(sfId,hsId);
      try{
        let type;
        if(exactRow?.canonicalType){type=exactRow.canonicalType}
        else{
          const sfLabel=migrationState.catalog.find(r=>r.source.id===sfId)?.source.label||sfId;
          const hsLabel=(migrationState.targets||[]).find(t=>t.id===hsId)?.label||hsId;
          const label=$('sync-wizard-label').value.trim()||sfLabel+' → '+hsLabel;
          const registration=await api('/api/object-mappings',{method:'POST',body:JSON.stringify({label,salesforceObject:sfId,hubspotObject:hsId})});
          type=registration.canonicalObject;migrationState.metadata.clear();
        }
        syncWizard.type=type;$('sync-wizard-step2-continue').disabled=false;
        await loadSyncWizardConditionsPanel(type,{});
      }catch(e){$('sync-wizard-message').textContent=e.message}
    }
    function conditionRowHtml(field,operator,value){
      const options=syncWizard.schema.map(f=>'<option value="'+esc(f.name)+'" '+(f.name===field?'selected':'')+'>'+esc(f.label)+' · '+esc(f.name)+'</option>').join('');
      const ops=conditionOperators.map(([id,label])=>'<option value="'+id+'" '+(id===operator?'selected':'')+'>'+esc(label)+'</option>').join('');
      const needsValue=!['is_null','is_not_null'].includes(operator);
      return '<div class="condition-row"><select class="condition-field"><option value="">Choose a field…</option>'+options+'</select><select class="condition-operator">'+ops+'</select><input class="condition-value" value="'+esc(value??'')+'" '+(needsValue?'':'hidden')+' placeholder="value"><button class="danger condition-remove" type="button">Remove</button></div>';
    }
    function addConditionRow(field,operator,value){$('sync-wizard-condition-rows').insertAdjacentHTML('beforeend',conditionRowHtml(field||'',operator||'eq',value));wireConditionRow($('sync-wizard-condition-rows').lastElementChild)}
    function wireConditionRow(row){
      row.querySelector('.condition-remove').onclick=()=>row.remove();
      row.querySelector('.condition-operator').onchange=e=>{row.querySelector('.condition-value').hidden=['is_null','is_not_null'].includes(e.target.value)};
    }
    $('sync-wizard-add-condition').onclick=()=>addConditionRow();
    $('sync-wizard-person-account-template').onclick=()=>{$('sync-wizard-condition-rows').innerHTML='';addConditionRow('IsPersonAccount','eq','false')};
    async function loadSyncWizardConditionsPanel(type,cfg){
      $('sync-wizard-conditions-panel').hidden=false;$('sync-wizard-condition-rows').innerHTML='<div class="empty">Loading schema…</div>';
      try{
        const schema=await api('/api/schema/'+syncWizard.browseSystem+'/'+type);syncWizard.schema=schema.fields;
        const rows=(cfg.conditions&&cfg.conditions[syncWizard.browseSystem])||[];
        $('sync-wizard-condition-rows').innerHTML='';
        if(rows.length)rows.forEach(r=>addConditionRow(r.field,r.operator,r.value));
        const isPersonAccountObject=syncWizard.browseSystem==='salesforce'&&syncWizard.schema.some(f=>f.name==='IsPersonAccount');
        $('sync-wizard-person-account-template').hidden=!isPersonAccountObject;
        $('sync-wizard-raw-condition-details').hidden=syncWizard.browseSystem!=='salesforce';
        $('sync-wizard-raw-condition').value=(cfg.rawCondition&&cfg.rawCondition[syncWizard.browseSystem])||'';
      }catch(e){$('sync-wizard-condition-rows').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}
    }
    function collectSyncWizardConditions(){
      return [...document.querySelectorAll('#sync-wizard-condition-rows .condition-row')].map(row=>{
        const field=row.querySelector('.condition-field').value,operator=row.querySelector('.condition-operator').value,valueInput=row.querySelector('.condition-value');
        if(!field)return null;
        const condition={field,operator};
        if(!valueInput.hidden){const raw=valueInput.value;condition.value=raw==='true'?true:raw==='false'?false:(raw!==''&&!Number.isNaN(Number(raw)))?Number(raw):raw}
        return condition;
      }).filter(Boolean);
    }
    async function persistSyncWizardConditions(type,extra){
      const conditions=collectSyncWizardConditions(),rawText=$('sync-wizard-raw-condition').value.trim();
      const body={conflictStrategy:syncConfigState.conflictStrategy,sourceOfTruth:syncConfigState.sourceOfTruth,objects:{}};
      const currentObj=syncConfigState?.objects?.[type]||{};
      body.objects[type]={enabled:false,direction:syncWizard.direction,enrolledForSync:true,
        ...(currentObj.conflictStrategy?{conflictStrategy:currentObj.conflictStrategy}:{}),
        ...(currentObj.sourceOfTruth?{sourceOfTruth:currentObj.sourceOfTruth}:{}),
        ...extra,
        conditions:conditions.length?{[syncWizard.browseSystem]:conditions}:{},
        ...(rawText&&syncWizard.browseSystem==='salesforce'?{rawCondition:{salesforce:rawText}}:{rawCondition:{}})};
      const config=await api('/api/sync/settings',{method:'PATCH',body:JSON.stringify(body)});
      syncConfigState=config;
      return config;
    }
    // Both "Check syntax" and "Test this setup" send the exact same shape the settings PATCH
    // will eventually save -- the point of both buttons is to catch a broken condition (like
    // last session's "Select Id, Name FROM Account" instead of a WHERE fragment) before it
    // ever reaches a scheduled poll, so the check has to run the real thing, not a lint.
    function syncWizardTestBody(){
      const conditions=collectSyncWizardConditions(),rawText=$('sync-wizard-raw-condition').value.trim();
      return {
        system:syncWizard.browseSystem,
        type:syncWizard.type,
        conditions:conditions.length?{[syncWizard.browseSystem]:conditions}:{},
        rawCondition:(rawText&&syncWizard.browseSystem==='salesforce')?{salesforce:rawText}:{},
      };
    }
    $('sync-wizard-check-syntax').onclick=async()=>{
      const button=$('sync-wizard-check-syntax'),result=$('sync-wizard-check-result');
      button.disabled=true;button.textContent='Checking…';result.className='muted';result.textContent='';
      try{
        const res=await api('/api/sync/test',{method:'POST',body:JSON.stringify(syncWizardTestBody())});
        if(res.ok){result.textContent='✓ Query runs. '+(res.matched?res.matched+' record'+(res.matched===1?'':'s')+' match right now.':'No records match right now.')}
        else{result.className='muted error';result.textContent='✗ '+res.message}
      }catch(e){result.className='muted error';result.textContent=e.message}
      finally{button.disabled=false;button.textContent='Check syntax'}
    };
    $('sync-wizard-test').onclick=async()=>{
      const button=$('sync-wizard-test'),result=$('sync-wizard-check-result');
      button.disabled=true;button.textContent='Testing…';$('sync-wizard-test-result').hidden=true;result.className='muted';result.textContent='';
      try{
        const res=await api('/api/sync/test',{method:'POST',body:JSON.stringify(syncWizardTestBody())});
        if(!res.ok){result.className='muted error';result.textContent='✗ '+res.message}
        else if(!res.matched){result.textContent='Query runs, but no records match right now -- nothing to preview.'}
        else if(!res.plan){result.textContent='✓ '+res.matched+' record'+(res.matched===1?'':'s')+' match.'}
        else{renderSyncWizardTestResult(res.plan,res.matched)}
      }catch(e){result.className='muted error';result.textContent=e.message}
      finally{button.disabled=false;button.textContent='Test this setup'}
    };
    function renderSyncWizardTestResult(plan,matched){
      $('sync-wizard-test-result').hidden=false;
      $('sync-wizard-test-action').className='pill '+plan.action;$('sync-wizard-test-action').textContent=plan.action;
      $('sync-wizard-test-summary').textContent=matched+' record'+(matched===1?'':'s')+' match -- showing the first.';
      $('sync-wizard-test-fields').innerHTML=plan.fieldDiff.length?plan.fieldDiff.map(diff=>'<div class="test-field"><span>'+esc(diff.field)+'</span><b>'+esc(testValue(diff.source))+(diff.target===undefined?'':' ← current '+esc(testValue(diff.target)))+'</b></div>').join(''):'<div class="test-field"><span>Result</span><b>'+esc(plan.warnings.join('; ')||'No field changes yet -- map fields below to see a full preview')+'</b></div>';
    }
    $('sync-wizard-save-conditions').onclick=async()=>{
      const button=$('sync-wizard-save-conditions');button.disabled=true;button.textContent='Saving…';
      try{const keepEnabled=syncConfigState.objects[syncWizard.type]?.enabled??false;await persistSyncWizardConditions(syncWizard.type,{enabled:keepEnabled});await loadSyncSettings();resetSyncWizard()}
      catch(e){$('sync-wizard-message').textContent=e.message}
      finally{button.disabled=false;button.textContent='Save conditions'}
    };
    // Editing an existing sync object's native objects reuses the same two selects, but must
    // update the SAME canonical type in place -- never register a second one -- so it runs its
    // own onchange handler and its own save action instead of the new-pairing flow above.
    function updateEditObjectsPreview(){
      const sfId=$('sync-wizard-sf-object').value,hsId=$('sync-wizard-hs-object').value;
      const sfLabel=migrationState.catalog.find(r=>r.source.id===sfId)?.source.label||sfId;
      const hsLabel=(migrationState.targets||[]).find(t=>t.id===hsId)?.label||hsId;
      $('sync-wizard-pair-preview').textContent=sfId&&hsId?'Salesforce '+sfLabel+' → HubSpot '+hsLabel:'';
      $('sync-wizard-save-native-objects').disabled=!(sfId&&hsId);
    }
    $('sync-wizard-edit-objects').onclick=()=>{
      const obj=syncObjectCatalog.find(o=>o.canonicalObject===syncWizard.type);if(!obj)return;
      if(!confirm('Change which objects "'+obj.label+'" syncs? Field mappings and the matching key will be reset to redo for the new objects, and sync will pause if it\\'s currently live. Conditions and direction stay as they are.'))return;
      $('sync-wizard-sf-object').disabled=false;$('sync-wizard-hs-object').disabled=false;
      renderSyncWizardObjectOptions();
      $('sync-wizard-sf-object').value=obj.salesforceObject||'';$('sync-wizard-hs-object').value=obj.hubspotObject||'';
      $('sync-wizard-sf-object').onchange=updateEditObjectsPreview;$('sync-wizard-hs-object').onchange=updateEditObjectsPreview;
      $('sync-wizard-edit-objects').hidden=true;$('sync-wizard-save-conditions').hidden=true;$('sync-wizard-conditions-panel').hidden=true;
      $('sync-wizard-save-native-objects').hidden=false;
      updateEditObjectsPreview();
    };
    $('sync-wizard-save-native-objects').onclick=async()=>{
      const button=$('sync-wizard-save-native-objects');button.disabled=true;button.textContent='Saving…';
      try{
        const salesforceObject=$('sync-wizard-sf-object').value,hubspotObject=$('sync-wizard-hs-object').value;
        const type=syncWizard.type;
        const result=await api('/api/object-mappings/'+type+'/native-objects',{method:'PUT',body:JSON.stringify({salesforceObject,hubspotObject})});
        resetSyncWizard();await loadSyncSettings();
        if(result.syncPaused)showSyncPausedWarning('Objects updated. Field mappings and the matching key were reset and sync was paused for this object -- turn it back on once fields are remapped.');
        else showNotice('Objects updated. Field mappings and the matching key were reset -- map fields for the new objects, then re-check your natural key, before relying on sync.');
        await goMapFields(type);
      }catch(e){$('sync-wizard-message').textContent=e.message}
      finally{button.disabled=false;button.textContent='Save object change'}
    };
    // enabled stays false through field mapping and the matching-rule step below -- there's
    // nothing to protect yet on a brand-new object, but nothing to sync correctly either
    // until both are done, so it only goes Live once the wizard actually finishes.
    $('sync-wizard-step2-continue').onclick=async()=>{
      const button=$('sync-wizard-step2-continue');button.disabled=true;button.textContent='Saving…';
      try{
        await persistSyncWizardConditions(syncWizard.type,{enabled:false});
        syncWizard.naturalKeyPending=true;
        const type=syncWizard.type;resetSyncWizard();
        await loadSyncSettings();
        await goMapFields(type);
      }catch(e){$('sync-wizard-message').textContent=e.message;button.disabled=false;button.textContent='Continue to field mapping'}
    };

    // A brand-new sync object has no field mappings yet at the point conditions are chosen, so
    // there's nothing to build a matching-rule candidate list from until fields are mapped and
    // saved -- this mini-step fires right after that first save instead of earlier in the wizard.
    async function maybeOfferNaturalKeyStep(){
      if(!syncWizard.naturalKeyPending)return;
      const state=migrationState.mapping;if(!state)return;
      const topPanel=$('field-workspace-natural-key');
      if(topPanel){
        topPanel.scrollIntoView({behavior:'smooth',block:'start'});
        return;
      }
      syncWizard.naturalKeyPending=false;
      const candidates=naturalKeyCandidates(state.type,state.sourceMeta,state.targetMeta,new Map(state.sourceMap.rules.map(r=>[r.canonical,r])),new Map(state.targetMap.rules.map(r=>[r.canonical,r])));
      const presets=naturalKeyPresets(state.type,candidates);
      const panel=$('sync-wizard-natural-key');if(panel)panel.hidden=false;
      $('sync-wizard-key-options').innerHTML=presets.length?presets.map((preset,index)=>'<label class="identity-option"><input type="radio" name="sync-wizard-key-mode" value="'+index+'" '+(index===0?'checked':'')+'><span><b>'+esc(preset.label)+(preset.recommended?'<em class="recommended-badge">Recommended</em>':'')+'</b><small>'+esc(preset.description)+'</small></span></label>').join(''):'<div class="empty">No shared, stable field is mapped yet. Map one, or choose fields below.</div>';
      $('sync-wizard-key-fields').innerHTML=candidates.map(item=>'<label class="advanced-key-field"><input type="checkbox" data-sync-wizard-key-field="'+esc(item.field)+'">'+esc(item.field)+(item.risky?' · mutable':'')+'</label>').join('');
      const chosenFields=()=>{const mode=document.querySelector('input[name="sync-wizard-key-mode"]:checked');if(mode)return presets[Number(mode.value)].fields;return [...document.querySelectorAll('[data-sync-wizard-key-field]:checked')].map(el=>el.dataset.syncWizardKeyField)};
      document.querySelectorAll('input[name="sync-wizard-key-mode"],[data-sync-wizard-key-field]').forEach(el=>el.onchange=()=>{$('sync-wizard-key-summary').textContent=chosenFields().length?'Match using '+chosenFields().join(' + '):'Choose at least one field.'});
      $('sync-wizard-key-summary').textContent=presets.length?'Match using '+presets[0].fields.join(' + '):'Choose at least one field.';
      $('sync-wizard-key-skip').onclick=()=>{panel.hidden=true};
      $('sync-wizard-key-save').onclick=async()=>{
        const fields=chosenFields();if(!fields.length){$('sync-wizard-key-warning').className='identity-warning';$('sync-wizard-key-warning').textContent='Choose at least one field.';return}
        const button=$('sync-wizard-key-save');button.disabled=true;button.textContent='Saving…';
        try{
          await api('/api/object-mappings/'+state.type,{method:'PUT',body:JSON.stringify({naturalKeyFields:fields})});
          const current=syncConfigState.objects[state.type];
          syncConfigState=await api('/api/sync/settings',{method:'PATCH',body:JSON.stringify({conflictStrategy:syncConfigState.conflictStrategy,sourceOfTruth:syncConfigState.sourceOfTruth,objects:{[state.type]:{...current,enabled:true}}})});
          panel.hidden=true;setDraftStatus(state.type+' is now live for sync','saved');
        }
        catch(e){$('sync-wizard-key-warning').className='identity-warning';$('sync-wizard-key-warning').textContent=e.message}
        finally{button.disabled=false;button.textContent='Save matching rule & finish'}
      };
    }
    const cachedSyncJobs=new Map();
    function rememberJobs(entries){for(const j of entries||[])cachedSyncJobs.set(j.id,j)}
    function formatJobDateTime(j){
      const raw=j&&(j.completedAt||j.updatedAt||j.createdAt||(j.event&&j.event.occurredAt));
      if(!raw)return '—';
      const d=new Date(raw);
      return Number.isNaN(d.getTime())?String(raw):d.toLocaleString();
    }
    function jobStatusBadge(j){
      const needsAttention=j.status==='dead_letter'||j.status==='manual_review'||j.status==='retry';
      if(needsAttention){
        return '<button type="button" class="pill '+esc(j.status)+' pill-btn" data-action="reviewJob" data-arg="'+esc(j.id)+'" title="Click to review this job">'+esc(j.status)+'</button>';
      }
      return '<span class="pill '+esc(j.status)+'">'+esc(j.status)+'</span>';
    }
    function jobRowCells(j,selectable){const needsAttention=j.status==='dead_letter'||j.status==='manual_review'||j.status==='retry';
      const isCompleted=j.status==='completed';
      const canSelect=selectable&&(needsAttention||isCompleted);
      const select='<td>'+(canSelect?'<input type="checkbox" class="row-select" data-status="'+esc(j.status)+'" value="'+esc(j.id)+'">':'')+'</td>';
      const reviewBtn=needsAttention?'<button class="secondary" type="button" data-action="reviewJob" data-arg="'+esc(j.id)+'">Review</button>':'';
      const primary=j.status==='manual_review'&&j.event.changeType==='deleted'?'<button class="danger" data-action="approveDelete" data-arg="'+esc(j.id)+'">Approve delete</button>'
        :needsAttention?'<button data-action="replay" data-arg="'+esc(j.id)+'">Replay</button>'
        :isCompleted?'<button class="secondary" type="button" data-action="resyncJob" data-arg="'+esc(j.id)+'">Re-sync</button>':'';
      const dismiss=needsAttention?'<button class="danger" data-action="dismissJob" data-arg="'+esc(j.id)+'" title="Give up on this permanently -- it will not be retried">Delete</button>':'';
      const actions=(reviewBtn||primary||dismiss)?'<div class="row-actions">'+reviewBtn+primary+dismiss+'</div>':'';
      return {select,actions}}
    function extractErrorFieldHint(msg){
      const s=String(msg||'');
      if(!s)return '';
      const m1=s.match(/\\bFields?\\s+"([^"]+)"/i);if(m1)return m1[1];
      const m2=s.match(/Invalid names:\\s*\\[([^\\]]+)\\]/i);if(m2)return m2[1].trim();
      const m3=s.match(/Can't set "([^"]+)"/i);if(m3)return m3[1];
      const m4=s.match(/missing required value for ([^.]+?)\\s+in\\s+/i);if(m4)return m4[1].trim();
      const m5=s.match(/No such column '([^']+)'/i);if(m5)return m5[1];
      const m6=s.match(/Required fields are missing:\\s*\\[([^\\]]+)\\]/i);if(m6)return m6[1].trim();
      const m7=s.match(/fields in request:\\s*([^)]+)/i);if(m7)return m7[1].trim();
      const m8=s.match(/while syncing relationship:\\s*([^)]+)/i);if(m8)return 'Relationship ('+m8[1].trim()+')';
      return '';
    }
    function formatJobErrorCell(msg,fallback){
      const text=msg||fallback||'—';
      const field=extractErrorFieldHint(msg);
      if(!field)return esc(text);
      return '<div style="margin-bottom:4px"><span class="pill ambiguous">Field: '+esc(field)+'</span></div>'+esc(text);
    }
    async function loadSyncConflicts(){const r=await api('/api/sync/jobs?limit=200');rememberJobs(r.entries);const entries=r.entries.filter(job=>job.status==='manual_review'||job.status==='dead_letter');
      $('conflicts').innerHTML=entries.length?entries.map(j=>{const c=jobRowCells(j,true);return '<tr>'+c.select+'<td>'+jobStatusBadge(j)+'</td><td class="muted" style="white-space:nowrap">'+esc(formatJobDateTime(j))+'</td><td>'+esc(j.event.system+' '+j.event.type+' '+j.event.changeType)+'<br><span class="muted">'+esc(j.event.sourceId)+'</span></td><td>'+j.attempts+'</td><td>'+formatJobErrorCell(j.lastError,'Operator review required')+'</td><td>'+c.actions+'</td></tr>'}).join(''):'<tr><td colspan="7" class="empty">No conflicts or manual reviews waiting.</td></tr>';
      resetBulkBar('conflicts')}
    $('refresh-conflicts').onclick=async()=>{
      const btn=$('refresh-conflicts');if(!btn||btn.disabled)return;
      const orig=btn.textContent||'Refresh queue';btn.disabled=true;btn.textContent='Refreshing…';showProgressBar();
      try{await loadSyncConflicts();btn.textContent='Refreshed ✓';btn.classList.add('btn-refreshed');showNotice('Conflicts queue refreshed.');setTimeout(()=>{btn.textContent=orig;btn.classList.remove('btn-refreshed');btn.disabled=false},1500)}
      catch(e){showError('Failed to refresh conflicts: '+(e.message||e));btn.textContent=orig;btn.disabled=false}
      finally{hideProgressBar()}};

    async function loadJobs(){const f=$('job-filter').value;const r=await api('/api/sync/jobs?limit=200'+(f?'&status='+encodeURIComponent(f):''));rememberJobs(r.entries);
      $('jobs').innerHTML=r.entries.length?r.entries.map(j=>{const c=jobRowCells(j,true);return '<tr>'+c.select+'<td>'+jobStatusBadge(j)+'</td><td class="muted" style="white-space:nowrap">'+esc(formatJobDateTime(j))+'</td><td>'+esc(j.event.system+' '+j.event.type+' '+j.event.changeType)+'<br><span class="muted">'+esc(j.event.sourceId)+'</span></td><td>'+j.attempts+'</td><td>'+formatJobErrorCell(j.lastError,'—')+'</td><td>'+c.actions+'</td></tr>'}).join(''):'<tr><td colspan="7" class="empty">No jobs</td></tr>';
      const completedCount=r.entries.filter(j=>j.status==='completed').length;if($('jobs-resync-all-completed')){$('jobs-resync-all-completed').hidden=completedCount===0;$('jobs-resync-all-completed').textContent='Re-sync all completed ('+completedCount+')'}resetBulkBar('jobs')}
    function closeReviewModal(){const m=$('manual-review-modal');if(m)m.hidden=true}
    function reviewJob(id){
      const j=cachedSyncJobs.get(id);
      const modal=$('manual-review-modal');
      if(!j||!modal)return;
      const sysLabel=j.event.system==='salesforce'?'Salesforce':'HubSpot';
      const targetLabel=j.event.system==='salesforce'?'HubSpot':'Salesforce';
      const fieldHint=extractErrorFieldHint(j.lastError);
      $('manual-review-status').textContent=j.status;
      $('manual-review-status').className='pill '+j.status;
      $('manual-review-meta').innerHTML=
        '<div><span>Source → Target</span><b>'+esc(sysLabel+' → '+targetLabel)+'</b></div>'+
        '<div><span>Object &amp; event</span><b>'+esc(j.event.type+' · '+j.event.changeType)+'</b></div>'+
        '<div><span>Source record ID</span><b><code>'+esc(j.event.sourceId)+'</code></b></div>'+
        '<div><span>Date &amp; time</span><b>'+esc(formatJobDateTime(j))+'</b></div>'+
        '<div><span>Affected field(s)</span><b>'+esc(fieldHint||'Not specified by CRM')+'</b></div>'+
        '<div><span>Attempts / Job ID</span><b>'+esc(j.attempts+' · '+j.id.slice(0,8))+'</b></div>';
      $('manual-review-reason').textContent=j.lastError||'Operator review required before proceeding.';
      const isDelete=j.status==='manual_review'&&j.event.changeType==='deleted';
      $('manual-review-actions').innerHTML=
        '<button class="secondary" type="button" data-action="closeReviewModal">Close</button>'+
        '<button class="secondary" type="button" data-action="reviewMapFields" data-arg="'+esc(j.event.type)+'">Edit field mappings</button>'+
        (isDelete?'<button class="danger" type="button" data-action="approveDeleteFromModal" data-arg="'+esc(j.id)+'">Approve delete</button>':'')+
        '<button type="button" data-action="replayFromModal" data-arg="'+esc(j.id)+'">Replay sync job</button>'+
        '<button class="danger" type="button" data-action="dismissFromModal" data-arg="'+esc(j.id)+'">Delete job</button>';
      modal.hidden=false;
    }
    async function replay(id,el){
      if(el){el.disabled=true;el.textContent='Replaying…'}
      showProgressBar();
      try{
        await api('/api/sync/jobs/'+id+'/replay',{method:'POST'});
        showNotice('Sync job queued for replay.');
        await Promise.all([loadJobs(),loadMetrics(),loadSyncConflicts()]);
        setTimeout(()=>{Promise.allSettled([loadJobs(),loadMetrics(),loadSyncConflicts()])},1200);
        setTimeout(()=>{Promise.allSettled([loadJobs(),loadMetrics(),loadSyncConflicts()])},3000);
      }finally{
        hideProgressBar();
        if(el&&el.isConnected){el.disabled=false;el.textContent='Replay'}
      }
    }
    async function approveDelete(id,el){
      if(!confirm('Delete/archive the linked record in the other CRM?'))return;
      if(el){el.disabled=true;el.textContent='Approving…'}
      showProgressBar();
      try{
        await api('/api/sync/jobs/'+id+'/approve-delete',{method:'POST'});
        showNotice('Deletion approved and propagated.');
        await Promise.all([loadJobs(),loadMetrics(),loadSyncConflicts()]);
      }finally{
        hideProgressBar();
        if(el&&el.isConnected){el.disabled=false;el.textContent='Approve delete'}
      }
    }
    async function dismissJob(id,el){
      if(!confirm('Give up on this permanently? It will not be retried, and stays visible in Activity for the record.'))return;
      if(el){el.disabled=true;el.textContent='Deleting…'}
      showProgressBar();
      try{
        await api('/api/sync/jobs/'+id+'/dismiss',{method:'POST'});
        showNotice('Sync job dismissed.');
        await Promise.all([loadJobs(),loadMetrics(),loadSyncConflicts()]);
      }finally{
        hideProgressBar();
        if(el&&el.isConnected){el.disabled=false;el.textContent='Delete'}
      }
    }
    
    async function resyncJob(id,el){
      if(el){el.disabled=true;el.textContent='Re-syncing…'}
      showProgressBar();
      try{
        await api('/api/sync/jobs/'+encodeURIComponent(id)+'/resync',{method:'POST'});
        showNotice('Sync job queued for re-sync.');
        await Promise.all([loadJobs(),loadMetrics(),loadSyncConflicts()]);
        setTimeout(()=>{Promise.allSettled([loadJobs(),loadMetrics(),loadSyncConflicts()])},1200);
        setTimeout(()=>{Promise.allSettled([loadJobs(),loadMetrics(),loadSyncConflicts()])},3000);
      }catch(e){
        showError('Failed to re-sync: '+(e.message||e));
      }finally{
        hideProgressBar();
        if(el&&el.isConnected){el.disabled=false;el.textContent='Re-sync'}
      }
    }
    window.resyncJob=resyncJob;
    window.replay=replay;window.approveDelete=approveDelete;window.dismissJob=dismissJob;
    window.reviewJob=reviewJob;window.closeReviewModal=closeReviewModal;
    window.reviewMapFields=type=>{closeReviewModal();goMapFields(type)};
    window.replayFromModal=async(id,el)=>{await replay(id,el);closeReviewModal()};
    window.approveDeleteFromModal=async(id,el)=>{await approveDelete(id,el);closeReviewModal()};
    window.dismissFromModal=async(id,el)=>{await dismissJob(id,el);closeReviewModal()};
    $('job-filter').onchange=loadJobs;

    // Bulk selection for both the Conflicts card and the Activity tab's Sync jobs table --
    // one row checkbox per selectable row, a header "select all", and Replay/Delete selected
    // buttons that only appear once something is checked.
    const bulkTables={conflicts:{selectAll:'conflicts-select-all',replayBtn:'conflicts-replay-selected',deleteBtn:'conflicts-delete-selected'},jobs:{selectAll:'jobs-select-all',replayBtn:'jobs-replay-selected',resyncBtn:'jobs-resync-selected',deleteBtn:'jobs-delete-selected'}};
    function selectedJobIds(tbodyId){return [...document.querySelectorAll('#'+tbodyId+' .row-select:checked')].map(el=>el.value)}
    function resetBulkBar(tbodyId){$(bulkTables[tbodyId].selectAll).checked=false;updateBulkBar(tbodyId)}
    function updateBulkBar(tbodyId){
      const cfg=bulkTables[tbodyId];
      const checkedBoxes=[...document.querySelectorAll('#'+tbodyId+' .row-select:checked')];
      const n=checkedBoxes.length;
      const total=document.querySelectorAll('#'+tbodyId+' .row-select').length;
      const completedChecked=checkedBoxes.filter(el=>el.dataset.status==='completed').length;
      const attentionChecked=n-completedChecked;
      if(cfg.resyncBtn){
        $(cfg.resyncBtn).hidden=completedChecked===0;
        $(cfg.resyncBtn).textContent='Re-sync selected ('+completedChecked+')';
      }
      $(cfg.replayBtn).hidden=attentionChecked===0;
      $(cfg.replayBtn).textContent='Replay selected ('+attentionChecked+')';
      $(cfg.deleteBtn).hidden=attentionChecked===0;
      $(cfg.deleteBtn).textContent='Delete selected ('+attentionChecked+')';
      $(cfg.selectAll).checked=total>0&&n===total;
      $(cfg.selectAll).indeterminate=n>0&&n<total;
    }
    async function bulkRefresh(){await Promise.all([loadJobs(),loadMetrics(),loadSyncConflicts()])}
    Object.entries(bulkTables).forEach(([tbodyId,cfg])=>{

      if(cfg.resyncBtn){
        $(cfg.resyncBtn).onclick=async()=>{
          const ids=[...document.querySelectorAll('#'+tbodyId+' .row-select:checked')].filter(el=>el.dataset.status==='completed').map(el=>el.value);
          if(!ids.length)return;
          const btn=$(cfg.resyncBtn);btn.disabled=true;btn.textContent='Re-syncing…';
          showProgressBar();
          try{
            await Promise.allSettled(ids.map(id=>api('/api/sync/jobs/'+encodeURIComponent(id)+'/resync',{method:'POST'})));
            showNotice(ids.length+' sync job'+(ids.length===1?'':'s')+' queued for re-sync.');
            await bulkRefresh();
            setTimeout(()=>{bulkRefresh()},1200);
            setTimeout(()=>{bulkRefresh()},3000);
          }finally{
            hideProgressBar();
            if(btn&&btn.isConnected)btn.disabled=false;
          }
        };
      }
      document.getElementById(tbodyId).addEventListener('change',e=>{if(e.target.classList.contains('row-select'))updateBulkBar(tbodyId)});
      $(cfg.selectAll).onchange=()=>{document.querySelectorAll('#'+tbodyId+' .row-select').forEach(el=>el.checked=$(cfg.selectAll).checked);updateBulkBar(tbodyId)};
      $(cfg.replayBtn).onclick=async()=>{
        const ids=selectedJobIds(tbodyId);
        if(!ids.length)return;
        await Promise.allSettled(ids.map(id=>api('/api/sync/jobs/'+id+'/replay',{method:'POST'})));
        await bulkRefresh();
        setTimeout(()=>{bulkRefresh()},1200);
        setTimeout(()=>{bulkRefresh()},3000);
      };
      $(cfg.deleteBtn).onclick=async()=>{const ids=selectedJobIds(tbodyId);if(!ids.length)return;if(!confirm('Give up on '+ids.length+' job'+(ids.length===1?'':'s')+' permanently? '+(ids.length===1?'It':'They')+' will not be retried.'))return;await Promise.allSettled(ids.map(id=>api('/api/sync/jobs/'+id+'/dismiss',{method:'POST'})));await bulkRefresh()};
    });
    
    if($('jobs-resync-all-completed')){$('jobs-resync-all-completed').onclick=async()=>{
      const completedJobs=[...cachedSyncJobs.values()].filter(j=>j.status==='completed');
      if(!completedJobs.length)return;
      if(!confirm('Re-sync all '+completedJobs.length+' completed record'+(completedJobs.length===1?'':'s')+' now?'))return;
      const btn=$('jobs-resync-all-completed');btn.disabled=true;btn.textContent='Re-syncing all…';
      showProgressBar();
      try{
        await Promise.allSettled(completedJobs.map(j=>api('/api/sync/jobs/'+encodeURIComponent(j.id)+'/resync',{method:'POST'})));
        showNotice(completedJobs.length+' sync job'+(completedJobs.length===1?'':'s')+' queued for re-sync.');
        await bulkRefresh();
        setTimeout(()=>{bulkRefresh()},1200);
        setTimeout(()=>{bulkRefresh()},3000);
      }finally{
        hideProgressBar();
        if(btn&&btn.isConnected){btn.disabled=false;btn.textContent='Re-sync all completed ('+completedJobs.length+')'}
      }
    }};
    document.querySelectorAll('[data-activity-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-activity-tab]').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.activity-panel').forEach(panel=>panel.classList.toggle('active',panel.id==='activity-'+button.dataset.activityTab))});
    async function loadAudit(){let a;try{a=await api('/api/audit?limit=100')}catch(e){if(e.code==='insufficient_role'){$('audit').innerHTML='<div class="empty">The audit log is visible to admins.</div>';return}throw e}$('audit').innerHTML=a.entries.length?a.entries.map(x=>'<div class="audit-entry"><b>'+esc(x.action)+'</b><br><span class="muted">'+esc(x.detail.message||x.resourceType)+' · '+esc(new Date(x.createdAt).toLocaleString())+'</span></div>').join(''):'<div class="empty">No audit entries</div>'}

    // Live error surfacing: the Sync/Activity tabs otherwise only refresh on click, so a new
    // dead-letter or manual-review job could sit unnoticed until someone happens to hit
    // Refresh (or the 5-minute email digest fires, if configured at all). A cheap poll of just
    // the stats endpoint -- not the full jobs/conflicts tables -- catches a new failure within
    // one tick and surfaces it immediately as a banner, without a new push/SSE subsystem.
    let lastKnownSyncStats=null;
    let lastErrorBannerFilter='dead_letter';
    async function checkForNewSyncErrors(){
      const activeView=document.querySelector('.view.active')?.id;
      if(activeView!=='view-sync'&&activeView!=='view-activity')return;
      let stats;
      try{stats=await api('/api/sync/stats')}catch{return}
      if(lastKnownSyncStats){
        const newDead=Math.max(0,stats.deadLetter-lastKnownSyncStats.deadLetter);
        const newManual=Math.max(0,stats.manualReview-lastKnownSyncStats.manualReview);
        if(newDead||newManual){
          const parts=[];
          if(newDead)parts.push(newDead+' new dead-letter error'+(newDead===1?'':'s'));
          if(newManual)parts.push(newManual+' new manual review'+(newManual===1?'':'s'));
          lastErrorBannerFilter=newManual&&!newDead?'manual_review':newDead&&!newManual?'dead_letter':'';
          $('live-error-banner-text').textContent=parts.join(' and ')+' just now.';
          $('live-error-banner').hidden=false;
        }
      }
      lastKnownSyncStats=stats;
    }
    $('live-error-banner-dismiss').onclick=()=>{$('live-error-banner').hidden=true};
    $('live-error-banner-view').onclick=()=>{$('live-error-banner').hidden=true;filterJobsByStatus(lastErrorBannerFilter)};
    checkForNewSyncErrors();
    setInterval(()=>{if(!document.hidden)checkForNewSyncErrors()},10000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkForNewSyncErrors()});

    let aiEditing=false;
    function aiForm(configured){return '<div class="ai-form-row"><input id="openai-key" type="password" autocomplete="new-password" spellcheck="false" placeholder="'+(configured?'Paste a replacement key':'Paste your OpenAI project API key')+'"><button id="save-ai-key">'+(configured?'Replace key':'Save key')+'</button></div><div class="settings-message" id="ai-message"></div>'}
    function renderAi(data){const configured=Boolean(data.configured),source=data.source==='workspace'?'Workspace secret':data.source==='environment'?'Server environment':'Not configured';$('ai-settings').innerHTML='<div class="ai-summary"><div><b>AI guidance for migration preflight</b><p>Explains blockers without accessing record values or applying changes.</p></div><span class="pill '+(configured?'completed':'ambiguous')+'">'+(configured?'Configured':'Setup required')+'</span></div>'+(configured?'<div class="ai-details"><div class="ai-detail"><span>Credential source</span><b>'+esc(source)+'</b></div><div class="ai-detail"><span>Fingerprint</span><b>'+esc(data.fingerprint||'Unavailable')+'</b></div><div class="ai-detail"><span>Model</span><b>'+esc(data.model)+'</b></div></div>':'')+(!configured||aiEditing?aiForm(configured):'<div class="ai-actions"><button id="edit-ai-key">Replace key</button>'+(data.source==='workspace'?'<button class="danger" id="remove-ai-key">Remove saved key</button>':'')+'</div>')+'<div class="ai-safe"><span>Validated before saving</span><span>Encrypted at rest</span><span>Never shown again</span></div>';if($('save-ai-key'))$('save-ai-key').onclick=saveAiKey;if($('edit-ai-key'))$('edit-ai-key').onclick=()=>{aiEditing=true;renderAi(data)};if($('remove-ai-key'))$('remove-ai-key').onclick=removeAiKey}
    async function saveAiKey(){const input=$('openai-key'),button=$('save-ai-key'),message=$('ai-message'),apiKey=input.value.trim();if(!apiKey){message.className='settings-message error';message.textContent='Paste a complete API key.';return}button.disabled=true;button.textContent='Validating…';try{const result=await api('/api/ai/settings',{method:'POST',body:JSON.stringify({apiKey})});aiEditing=false;renderAi(result)}catch(e){message.className='settings-message error';message.textContent=e.message;button.disabled=false;button.textContent='Save key'}}
    async function removeAiKey(){if(!confirm('Remove the workspace OpenAI API key?'))return;const result=await api('/api/ai/settings',{method:'DELETE'});aiEditing=false;renderAi(result)}
    function notificationsForm(status){return '<div class="fields" style="grid-template-columns:1fr auto">'
      +'<div><label>Alert email</label><input id="alert-email" type="email" placeholder="ops@yourcompany.com" value="'+esc(status.alertEmail||'')+'"></div>'
      +'<div><label>&nbsp;</label><label style="display:flex;align-items:center;gap:8px;height:38px"><input type="checkbox" id="alerts-enabled" '+(status.enabled?'checked':'')+'> Enabled</label></div></div>'
      +'<div class="fields" style="grid-template-columns:1fr 110px"><div><label>SMTP host</label><input id="smtp-host" placeholder="smtp.yourprovider.com" value="'+esc(status.smtpHost||'')+'"></div>'
      +'<div><label>Port</label><input id="smtp-port" type="number" value="'+esc(status.smtpPort||587)+'"></div></div>'
      +'<div class="fields" style="grid-template-columns:1fr 1fr"><div><label>SMTP user</label><input id="smtp-user" value="'+esc(status.smtpUser||'')+'"></div>'
      +'<div><label>From address</label><input id="smtp-from" type="email" placeholder="alerts@yourcompany.com" value="'+esc(status.smtpFrom||'')+'"></div></div>'
      +'<div class="fields" style="grid-template-columns:1fr auto"><div><label>SMTP password</label><input id="smtp-password" type="password" autocomplete="new-password" placeholder="'+(status.smtpConfigured?'Leave blank to keep the saved password':'Not set')+'"></div>'
      +'<div><label>&nbsp;</label><button id="save-notifications">Save</button></div></div>'
      +'<div class="settings-message" id="notifications-message"></div>'}
    function renderNotifications(status){$('notification-settings').innerHTML='<div class="ai-summary"><div><b>Sync failure alerts</b><p>Sends a digest email when sync jobs are dead-lettered or need manual review, instead of one email per failure.</p></div><span class="pill '+(status.smtpConfigured?'completed':'ambiguous')+'">'+(status.smtpConfigured?'SMTP configured':'SMTP not set up')+'</span></div>'
      +notificationsForm(status)
      +(status.smtpConfigured?'':'<div class="notice" style="margin-top:12px;margin-bottom:0">Without SMTP configured, alerts still trigger and show up in the Activity feed, but no email actually goes out yet.</div>');
      $('save-notifications').onclick=saveNotifications}
    async function saveNotifications(){const button=$('save-notifications'),message=$('notifications-message'),body={enabled:$('alerts-enabled').checked,alertEmail:$('alert-email').value.trim(),smtpHost:$('smtp-host').value.trim(),smtpPort:Number($('smtp-port').value)||undefined,smtpUser:$('smtp-user').value.trim(),smtpFrom:$('smtp-from').value.trim()};const password=$('smtp-password').value;if(password)body.smtpPassword=password;
      button.disabled=true;message.className='settings-message';message.textContent='Saving…';
      try{const status=await api('/api/notifications/settings',{method:'PUT',body:JSON.stringify(body)});message.textContent='Saved.';renderNotifications(status)}catch(e){message.className='settings-message error';message.textContent=e.message}finally{button.disabled=false}}
    async function loadSettingsWorkspace(){const [ai,notifications,usage,overview,keys]=await Promise.all([api('/api/ai/settings'),api('/api/notifications/settings'),api('/api/usage'),api('/api/workspace-overview'),api('/api/admin/api-keys')]);renderAi(ai);renderNotifications(notifications);$('plan-overview').innerHTML='<div class="ai-summary"><div><b>'+esc(overview.plan)+' plan</b><p>'+esc(overview.status)+(overview.currentPeriodEnd?' · renews '+esc(new Date(overview.currentPeriodEnd).toLocaleDateString()):'')+'</p></div><span class="pill completed">'+esc(overview.status)+'</span></div>';$('usage').innerHTML=Object.entries(usage.usage).map(([key,value])=>metric(key.replaceAll('_',' '),value)).join('')||'<div class="empty">No usage yet this month.</div>';$('team').innerHTML=overview.team.length?overview.team.map(member=>'<tr><td>'+esc(member.email)+'</td><td><span class="pill">'+esc(member.role)+'</span></td><td>'+esc(new Date(member.createdAt).toLocaleDateString())+'</td></tr>').join(''):'<tr><td colspan="3" class="empty">No named team members. Access is currently managed with API keys.</td></tr>';renderApiKeys(keys.entries)}
    function renderApiKeys(entries){$('api-keys').innerHTML=entries.length?entries.map(key=>'<tr><td>'+esc(key.name)+(key.revokedAt?' <span class="pill error">Revoked</span>':'')+'</td><td><code>'+esc(key.prefix)+'…</code></td><td>'+esc(key.role)+'</td><td>'+esc(key.lastUsedAt?new Date(key.lastUsedAt).toLocaleString():'Never')+'</td><td>'+(key.revokedAt?'':'<button class="danger" data-revoke-key="'+esc(key.id)+'">Revoke</button>')+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">No API keys.</td></tr>';$('api-keys').querySelectorAll('[data-revoke-key]').forEach(button=>button.onclick=()=>revokeApiKey(button.dataset.revokeKey))}
    async function revokeApiKey(id){if(!confirm('Revoke this API key? Existing clients using it will lose access.'))return;await api('/api/admin/api-keys/'+id,{method:'DELETE'});renderApiKeys((await api('/api/admin/api-keys')).entries)}
    $('create-api-key').onclick=async()=>{const name=$('api-key-name').value.trim();if(!name)return;$('create-api-key').disabled=true;try{const result=await api('/api/admin/api-keys',{method:'POST',body:JSON.stringify({name,role:$('api-key-role').value})});$('created-api-key').innerHTML='<div class="key-created"><b>Copy this key now — it will not be shown again.</b><code>'+esc(result.key)+'</code></div>';$('api-key-name').value='';renderApiKeys((await api('/api/admin/api-keys')).entries)}catch(e){$('created-api-key').innerHTML='<div class="notice">'+esc(e.message)+'</div>'}finally{$('create-api-key').disabled=false}};

    // R13: real readiness and workspace identity (nothing hardcoded).
    const READINESS_LABEL={ok:'Ready',warning:'Needs attention',blocked:'Not ready'};
    async function loadReadiness(){try{const r=await api('/api/readiness');
      $('readiness-dot').className='status-dot'+(r.status==='ok'?'':r.status==='warning'?' warn':' off');
      const issues=r.checks.filter(c=>c.status!=='ok');
      $('readiness-label').textContent=READINESS_LABEL[r.status]+(issues.length?' ('+issues.length+')':'');
      $('readiness-list').innerHTML=r.checks.map(c=>'<li class="readiness-'+c.status+'"><b>'+esc(c.label)+'</b> <span class="pill '+(c.status==='ok'?'completed':c.status==='warning'?'ambiguous':'error')+'">'+esc(c.status)+'</span><br><span class="muted">'+esc(c.detail)+'</span></li>').join('');
    }catch(e){$('readiness-dot').className='status-dot off';$('readiness-label').textContent='Readiness unavailable'}}
    async function loadIdentity(){try{const o=await api('/api/workspace-overview');$('workspace-name').textContent='Workspace · '+(o.name||o.slug||'unnamed')}catch(e){}}
    $('readiness-label').addEventListener('click',()=>{const panel=$('readiness-panel');panel.hidden=!panel.hidden;$('readiness-label').setAttribute('aria-expanded',String(!panel.hidden))});
    loadIdentity();
    // Bounded polling: only while the tab is visible, and never more often than every 30s.
    setInterval(()=>{if(!document.hidden)loadReadiness()},30000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadReadiness()});
    // R10/R13 conflict review: inspect the automatic decision, deliberately keep the other side.
    const SYSTEM_LABEL={salesforce:'Salesforce',hubspot:'HubSpot'};
    async function loadConflictReview(){const c=await api('/api/conflicts?limit=100');
      $('conflict-review').innerHTML=c.entries.length?'<table><thead><tr><th>Record</th><th>Decision</th><th>Changed fields</th><th>Status</th><th></th></tr></thead><tbody>'+c.entries.map(x=>{
        const fields=Object.keys({...x.source.fields,...x.target.fields}).filter(k=>JSON.stringify(x.source.fields[k])!==JSON.stringify(x.target.fields[k]));
        const winner=x.decision&&x.decision.winner;const source=x.source.meta.source;const other=source==='salesforce'?'hubspot':'salesforce';
        const diff=fields.slice(0,6).map(k=>'<div><b>'+esc(k)+'</b>: '+esc(SYSTEM_LABEL[source])+' '+esc(x.source.fields[k]??'—')+' · '+esc(SYSTEM_LABEL[other])+' '+esc(x.target.fields[k]??'—')+'</div>').join('')||'<span class="muted">No field differences recorded</span>';const targetWinner=winner||source||'salesforce';
        const actions=['salesforce','hubspot'].map(sys=>'<button class="secondary" data-action="resolveConflict" data-arg="'+esc(x.id)+':'+sys+'"'+(winner===sys&&x.resolutionSource==='manual'?' disabled':'')+'>Keep '+SYSTEM_LABEL[sys]+'</button>').join(' ')+' <button class="secondary" data-action="resyncConflict" data-arg="'+esc(x.id)+':'+esc(targetWinner)+'">Re-sync</button>';
        const conflictDate=x.resolvedAt||x.createdAt;
        return '<tr data-conflict="'+esc(x.id)+'"><td>'+esc(x.type)+'<br><span class="muted">'+esc(new Date(conflictDate).toLocaleString())+'</span></td><td>'+esc(x.strategy)+(winner?' → '+esc(SYSTEM_LABEL[winner]||winner):'')+'</td><td>'+diff+'</td><td><span class="pill '+(x.resolutionSource==='manual'?'completed':'ambiguous')+'">'+(x.resolutionSource==='manual'?'resolved by operator':'automatic')+'</span></td><td>'+actions+'</td></tr>'}).join('')+'</tbody></table>':'<div class="empty">No conflicts recorded</div>'}
    async function resolveConflict(arg){const [id,winner]=String(arg).split(':');
      const r=await api('/api/conflicts/'+encodeURIComponent(id)+'/resolve',{method:'POST',body:JSON.stringify({winner})});
      showNotice('Kept '+SYSTEM_LABEL[winner]+' values for this '+r.type+'.');await loadConflictReview()}
    window.resolveConflict=resolveConflict;
    async function resyncConflict(arg,el){
      const [id,winner]=String(arg).split(':');
      if(el){el.disabled=true;el.textContent='Re-syncing…'}
      showProgressBar();
      try{
        const r=await api('/api/conflicts/'+encodeURIComponent(id)+'/resolve',{method:'POST',body:JSON.stringify({winner:winner||'salesforce'})});
        showNotice('Re-synced '+r.type+' values.');
        await Promise.all([loadConflictReview(),loadJobs(),loadMetrics()]);
      }catch(e){
        showError('Failed to re-sync conflict: '+(e.message||e));
      }finally{
        hideProgressBar();
        if(el&&el.isConnected){el.disabled=false;el.textContent='Re-sync'}
      }
    }
    window.resyncConflict=resyncConflict;
    async function loadConflicts(){await Promise.all([loadSyncConflicts(),loadConflictReview()])}

    let isRefreshingAll=false;
    async function refreshAll(arg, el){
      if(isRefreshingAll)return;
      const btn=el||$('header-refresh-btn')||document.querySelector('[data-action="refreshAll"]');
      const isManual=Boolean(el||arg);
      const origText=btn?(btn.textContent||'Refresh'):'Refresh';
      const route=parseHashRoute(location.hash.slice(1));
      const view=route.view;
      if(isManual&&btn){btn.disabled=true;btn.textContent='Refreshing…';showProgressBar()}
      isRefreshingAll=true;
      try{
        if(view==='sync'){
          await Promise.allSettled([loadSyncWorkspace(),loadReadiness(),checkForNewSyncErrors()]);
          if(isManual)showNotice('Sync status, metrics, and webhook health refreshed.');
        }else if(view==='activity'){
          await Promise.allSettled([loadJobs(),loadAudit(),loadConflictReview(),loadReadiness(),checkForNewSyncErrors()]);
          if(isManual)showNotice('Sync jobs, conflicts, and audit trail refreshed.');
        }else if(view==='settings'){
          await Promise.allSettled([loadSettingsWorkspace(),loadReadiness()]);
          if(isManual)showNotice('Settings and workspace overview refreshed.');
        }else if(view==='field-mapping'){
          workspaceMode=route.origin==='sync'?'sync':'migration';
          applyWorkspaceMode();
          const targetType=route.objectType||migrationState.mapping?.type||$('field-object').value;
          if(workspaceMode==='sync'){
            await Promise.allSettled([loadSyncSettings(),loadCatalog('salesforce'),loadReadiness()]);
          }else{
            const migTasks=[loadRuns(),loadCatalog(),loadSavedPlans(),loadReadiness()];
            if(migrationState.plan?.id){
              migTasks.push(api('/api/migration-plans/'+migrationState.plan.id).then(plan=>{migrationState.plan=plan;updateMigrationSummary();updateMigrationStepper()}).catch(()=>{}));
            }
            await Promise.allSettled(migTasks);
          }
          await loadFieldMappingWorkspace(targetType);
          if(isManual)showNotice(workspaceMode==='sync'?'Sync field mapping refreshed.':'Migration field mapping refreshed.');
        }else{
          const tasks=[loadRuns(),loadCatalog(),loadSavedPlans(),loadReadiness()];
          if(migrationState.plan?.id){
            tasks.push(api('/api/migration-plans/'+migrationState.plan.id).then(plan=>{migrationState.plan=plan;updateMigrationSummary();updateMigrationStepper()}).catch(()=>{}))
          }
          if(migrationState.currentStep==='values'&&migrationState.valueContext?.type){
            tasks.push(loadValuesWorkspace(migrationState.valueContext.type).catch(()=>{}))
          }
          await Promise.allSettled(tasks);
          if(isManual)showNotice('Migration workspace refreshed.');
        }
        if(isManual&&btn){
          btn.textContent='Refreshed ✓';btn.classList.add('btn-refreshed');
          setTimeout(()=>{btn.textContent=origText;btn.classList.remove('btn-refreshed');btn.disabled=false},1500);
        }
      }catch(err){
        if(isManual){
          showError('Refresh encountered an issue: '+(err.message||err));
          if(btn){btn.textContent=origText;btn.disabled=false}
        }
      }finally{
        isRefreshingAll=false;
        if(isManual)hideProgressBar();
      }
    }
    window.refreshAll=refreshAll;
    const headerRefreshBtn=$('header-refresh-btn');
    if(headerRefreshBtn){headerRefreshBtn.addEventListener('click',e=>{e.preventDefault();refreshAll(null,headerRefreshBtn)})}
    refreshAll();
  </script>
</body></html>`;
}
