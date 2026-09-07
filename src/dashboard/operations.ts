import { dashboardHeader, dashboardShellCss } from './shell.js';
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
    .object-sync-row{display:flex;flex-direction:column;gap:8px;padding:13px 0;border-bottom:1px solid #f0f3f7}
    .object-sync-row:last-child{border-bottom:0}
    .object-sync-main{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .object-sync-main label{margin:0;display:flex;align-items:center;gap:9px}
    .object-sync-main input{width:16px;height:16px;min-height:auto}
    .object-sync-main select{margin-left:auto}
    .object-poll-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-left:25px;font-size:12px;color:var(--text-2)}
    .object-poll-row label{margin:0;display:flex;align-items:center;gap:6px;white-space:nowrap}
    .object-poll-row input[type=checkbox]{width:14px;height:14px;min-height:auto}
    .object-poll-row input[type=number]{width:60px}
    .object-poll-row select{width:auto}
    .object-poll-row .muted{color:var(--muted)}
    .object-poll-row .muted.error{color:var(--red)}
    .webhook-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .webhook-card{padding:16px;border:1px solid var(--border);border-radius:9px;background:#fafcfd}
    .webhook-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
    .webhook-card p{margin:0;color:var(--muted);font-size:12px}
    .subtabs{display:flex;gap:8px;padding:14px 20px;border-bottom:1px solid #eaeff4}
    .subtabs button{background:#fff;border-color:var(--border-strong);color:var(--text)}
    .subtabs button.active{background:var(--nav);border-color:var(--nav);color:#fff}
    .activity-panel{display:none}.activity-panel.active{display:block}
    .ai-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
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
    @media(max-width:900px){.layout,.settings-grid,.sync-config-grid{grid-template-columns:1fr}.fields{grid-template-columns:1fr 1fr}}
    @media(max-width:640px){.ops-metrics,.fields{grid-template-columns:1fr}.toolbar{align-items:stretch}.toolbar>*{width:100%}}
  </style>
</head>
<body>
  ${dashboardHeader('migration')}
  <main class="page">
    <div class="page-heading"><div><div class="eyebrow">Workspace · untangleit</div><h1 id="page-title">Migration</h1>
      <p class="subcopy" id="page-subtitle">Test one real record, verify it, then run the full migration safely.</p></div>
      <div class="status-pill"><span class="status-dot"></span><strong>Control plane ready</strong>
        <button class="secondary" onclick="refreshAll()">Refresh</button></div></div>
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
      <div class="card" style="margin-top:16px"><div class="toolbar jobs-head"><h2 style="margin:0 auto 0 0">Conflicts &amp; manual review</h2>
        <button class="secondary" id="refresh-conflicts">Refresh queue</button></div>
        <div class="scroll"><table><thead><tr><th>Status</th><th>Event</th><th>Attempts</th><th>Reason</th><th></th></tr></thead><tbody id="conflicts"></tbody></table></div>
      </div>
    </section>

    <section class="view" id="view-activity">
      <div class="card">
        <div class="subtabs"><button class="active" data-activity-tab="jobs">Sync jobs</button><button data-activity-tab="audit">Audit log</button></div>
        <div class="activity-panel active" id="activity-jobs">
          <div class="toolbar jobs-head"><h2 style="margin:0 auto 0 0">Durable sync journal</h2>
            <select id="job-filter"><option value="">All statuses</option><option>queued</option><option>retry</option><option>dead_letter</option><option>manual_review</option><option>completed</option></select></div>
          <div class="scroll"><table><thead><tr><th>Status</th><th>Event</th><th>Attempts</th><th>Error</th><th></th></tr></thead><tbody id="jobs"></tbody></table></div>
        </div>
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
  </main>
  <script>
    const $=id=>document.getElementById(id), esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    async function api(url,opts){const r=await fetch(url,{headers:{'content-type':'application/json',...(opts&&opts.headers)},...opts});const j=await r.json();if(!r.ok){const e=new Error(j.detail||j.error||r.statusText);e.code=j.error;e.system=j.system;e.actionUrl=j.actionUrl;throw e}return j}
    const viewMeta={
      migration:['Migrate','Build, validate, preview, and run a controlled CRM migration.'],
      sync:['Sync','Control live synchronization, webhook health, and conflict handling.'],
      activity:['Activity','Review sync jobs and the operator audit trail in one timeline.'],
      settings:['Settings','Manage Copilot, workspace access, usage, and plan details.']
    };
    function selectView(view){
      if(!viewMeta[view])view='migration';
      document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id==='view-'+view));
      document.querySelectorAll('.app-nav a').forEach(x=>x.classList.toggle('active',x.getAttribute('href')==='/ops#'+view));
      $('page-title').textContent=viewMeta[view][0];$('page-subtitle').textContent=viewMeta[view][1];
      if(view==='sync')loadSyncWorkspace();if(view==='activity'){loadJobs();loadAudit()}if(view==='settings')loadSettingsWorkspace();
    }
    document.querySelectorAll('.app-nav a[href^="/ops#"]').forEach(a=>a.onclick=e=>{e.preventDefault();const view=a.getAttribute('href').split('#')[1];history.replaceState(null,'','#'+view);selectView(view)});
    window.addEventListener('hashchange',()=>selectView(location.hash.slice(1)));
    selectView(location.hash.slice(1));
    function metric(label,value,cls=''){return '<div class="metric"><span>'+esc(label)+'</span><b class="'+cls+'">'+esc(value)+'</b></div>'}
    async function loadMetrics(){const [s,q]=await Promise.all([api('/api/status'),api('/api/sync/stats')]);$('metrics').innerHTML=
      metric('Ready',s.ready?'Yes':'No',s.ready?'create':'error')+metric('Queued',q.queued)+metric('Retrying',q.retry,'retry')+
      metric('Manual review',q.manualReview,'ambiguous')+metric('Dead letter',q.deadLetter,'dead_letter')+metric('Synced',s.stats.synced)}
    const migrationState={plan:null,dirty:true,catalog:[],targets:[],selected:new Set(),selectionInitialized:false,selectedRow:null,metadata:new Map(),mapping:null,fieldLoadToken:0,valueLoadToken:0,preflight:null,copilot:null,preview:null,canaryPreview:null,canaryVerified:false,currentStep:'scope',visited:new Set(['scope']),transformRow:null,savedPlans:[],runs:[]};
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
    function setDraftStatus(text,state=''){$('autosave-status').textContent=text;$('draft-state').className='draft-state'+(state?' '+state:'')}
    function updateDirectionPreview(){const from=$('mig-from').value==='salesforce'?'Salesforce':'HubSpot';$('direction-source-name').textContent=from;$('direction-target-name').textContent=from==='Salesforce'?'HubSpot':'Salesforce'}
    function markPlanDirty(){migrationState.dirty=true;migrationState.preflight=null;migrationState.preview=null;migrationState.canaryPreview=null;migrationState.canaryVerified=false;resetCopilot();$('execute').disabled=true;$('execute-canary').disabled=true;$('test-record-preview').hidden=true;$('test-record-result').hidden=true;$('full-migration').hidden=true;$('summary-preflight').textContent='Not run';$('summary-preview').textContent='Required';setDraftStatus('Unsaved changes');updateMigrationSummary();updateMigrationStepper()}
    async function savePlan(refreshPlans=true){const body=migrationBody();if(!body.name||!body.types.length)throw new Error('Choose at least one supported object and name the plan');
      setDraftStatus('Saving…');
      const plan=await api(migrationState.plan?'/api/migration-plans/'+migrationState.plan.id:'/api/migration-plans',{method:migrationState.plan?'PATCH':'POST',body:JSON.stringify(body)});
      migrationState.plan=plan;migrationState.dirty=false;$('summary-plan').textContent=plan.name+' · r'+plan.revision;setDraftStatus('Autosaved · revision '+plan.revision,'saved');if(refreshPlans)await loadSavedPlans();updateMigrationSummary();updateMigrationStepper();return plan}
    async function ensurePlan(){return migrationState.plan&&!migrationState.dirty?migrationState.plan:savePlan(false)}
    function queuePlanAutosave(){clearTimeout(autosaveTimer);setDraftStatus('Waiting to autosave…');autosaveTimer=setTimeout(async()=>{try{if($('plan-name').value.trim()&&migrationState.selected.size)await savePlan(false)}catch(e){setDraftStatus(e.message,'error')}},650)}
    $('save-plan').onclick=async()=>{try{$('save-plan').disabled=true;await savePlan();$('save-plan').textContent='Saved ✓';setTimeout(()=>$('save-plan').textContent='Save now',1200)}catch(e){setDraftStatus(e.message,'error');alert(e.message)}finally{$('save-plan').disabled=false}};
    ['plan-name','mig-limit'].forEach(id=>$(id).addEventListener(id==='plan-name'?'input':'change',()=>{markPlanDirty();queuePlanAutosave()}));
    $('mig-from').onchange=async()=>{migrationState.plan=null;migrationState.selected=new Set();migrationState.selectionInitialized=false;updateDirectionPreview();markPlanDirty();await loadCatalog();queuePlanAutosave()};

    document.querySelectorAll('.workspace-step').forEach(button=>button.onclick=()=>goMigrationStep(button.dataset.step,button.dataset.step!=='scope'&&migrationState.currentStep==='scope'));
    document.querySelectorAll('[data-go-step]').forEach(button=>button.onclick=()=>goMigrationStep(button.dataset.goStep,button.dataset.saveBefore==='true'));
    async function goMigrationStep(step,saveBefore=false){try{if(migrationState.currentStep==='fields'&&step!=='fields'&&migrationState.mapping?.dirty)await saveFieldMappings();if(saveBefore)await ensurePlan();if(['validate','preview'].includes(step)){const incomplete=selectedCatalogRows().filter(row=>mappingObjectState(row).key!=='complete');if(incomplete.length){selectMigrationStep('fields');$('field-object-filter').value='review';renderFieldObjectQueue();setDraftStatus('Finish field mappings for '+incomplete.map(row=>row.source.label).join(', '),'error');return}}if(step==='preview'&&(!migrationState.preflight||!migrationState.preflight.ok)){const result=await runPlanPreflight();if(!result.ok)return}selectMigrationStep(step)}catch(e){setDraftStatus(e.message,'error')}}
    function selectMigrationStep(step){if(!migrationSteps.includes(step))step='scope';migrationState.currentStep=step;migrationState.visited.add(step);document.querySelectorAll('.workspace-step').forEach(x=>{x.classList.toggle('active',x.dataset.step===step);x.toggleAttribute('aria-current',x.dataset.step===step)});document.querySelectorAll('.workspace-panel').forEach(x=>x.classList.toggle('active',x.id==='workspace-'+step));
      if(step==='fields')loadFieldWorkspace($('field-object').value||[...migrationState.selected][0]);if(step==='values')loadValuesWorkspace($('value-object').value||[...migrationState.selected][0]);if(step==='preview')loadTestRecordWorkspace().catch(e=>$('mig-status').textContent=e.message);updateMigrationStepper()}
    function updateMigrationStepper(){const selectedRows=selectedCatalogRows(),coverageTotal=selectedRows.reduce((n,row)=>n+row.totalMappedFields,0),coverageMapped=selectedRows.reduce((n,row)=>n+row.mappedFields,0),canaryPassed=migrationState.canaryVerified||Boolean(migrationState.plan?.canary?.verifiedAt&&migrationState.plan.canary.previewRevision===migrationState.plan.revision);const states={scope:$('plan-name').value.trim()?'complete':'warning',objects:migrationState.selected.size?'complete':'blocked',fields:coverageTotal&&coverageMapped===coverageTotal?'complete':migrationState.visited.has('fields')?'warning':'',values:migrationState.visited.has('values')?'complete':'',validate:migrationState.preflight?(migrationState.preflight.ok?'complete':'blocked'):'',preview:canaryPassed?'complete':migrationState.canaryPreview?'warning':''};document.querySelectorAll('.workspace-step').forEach(button=>{button.classList.remove('complete','warning','blocked');if(states[button.dataset.step])button.classList.add(states[button.dataset.step])})}
    updateDirectionPreview();
    function selectMigrateTab(tab){if(!['builder','plans','runs'].includes(tab))tab='builder';document.querySelectorAll('[data-migrate-tab]').forEach(button=>{const active=button.dataset.migrateTab===tab;button.classList.toggle('active',active);button.toggleAttribute('aria-current',active)});document.querySelectorAll('.migrate-section').forEach(section=>section.classList.toggle('active',section.id==='migrate-'+tab));if(tab==='plans')loadSavedPlans();if(tab==='runs')loadRuns()}
    document.querySelectorAll('[data-migrate-tab]').forEach(button=>button.onclick=()=>selectMigrateTab(button.dataset.migrateTab));
    document.querySelectorAll('[data-migrate-open]').forEach(button=>button.onclick=()=>selectMigrateTab(button.dataset.migrateOpen));

    async function loadCatalog(){const source=$('mig-from').value;$('object-rows').innerHTML='<tr><td colspan="6" class="empty">Discovering CRM objects…</td></tr>';
      try{const result=await api('/api/object-catalog?from='+encodeURIComponent(source));migrationState.catalog=result.rows;migrationState.targets=result.targets||[];
        if(!migrationState.selectionInitialized){migrationState.selected=new Set(result.rows.filter(row=>row.registered).map(row=>row.canonicalType));migrationState.selectionInitialized=true}
        renderCatalog();refreshObjectSelectors();updateMigrationSummary()}
      catch(e){$('object-rows').innerHTML='<tr><td colspan="6" class="empty">'+esc(e.message)+'</td></tr>'}}
    // Shared by the catalog checkbox and the manual target picker: registers row.source paired
    // with whatever row.target currently is (auto-matched or manually chosen) as a canonical object.
    async function registerCatalogMapping(row){const from=$('mig-from').value,to=from==='salesforce'?'hubspot':'salesforce',body={label:row.source.label};body[from+'Object']=row.source.id;if(row.target)body[to+'Object']=row.target.id;
      const registration=await api('/api/object-mappings',{method:'POST',body:JSON.stringify(body)});row.canonicalType=registration.canonicalObject;row.registered=true;migrationState.metadata.clear();return registration}
    async function confirmManualTarget(row){const select=$('manual-target'),targetId=select&&select.value;if(!targetId)return;const target=(migrationState.targets||[]).find(t=>t.id===targetId);if(!target)return;
      const button=$('manual-target-confirm');button.disabled=true;button.textContent='Mapping…';
      try{row.target=target;row.supported=true;await registerCatalogMapping(row);migrationState.selected.add(row.canonicalType);markPlanDirty();renderCatalog();refreshObjectSelectors();queuePlanAutosave();await selectCatalogRow(row)}
      catch(err){setDraftStatus(err.message,'error')}
      finally{const btn=$('manual-target-confirm');if(btn){btn.disabled=false;btn.textContent='Map to this object'}}}
    function renderCatalog(){const query=$('catalog-search').value.trim().toLowerCase(),filter=$('catalog-filter').value;
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
    async function getMetadata(system,objectId){const key=system+':'+objectId;if(!migrationState.metadata.has(key))migrationState.metadata.set(key,await api('/api/object-catalog/'+system+'/'+encodeURIComponent(objectId)));return migrationState.metadata.get(key)}
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
      const open=$('open-object-fields');if(open)open.onclick=()=>{selectMigrationStep('fields');$('field-object').value=row.canonicalType;loadFieldWorkspace(row.canonicalType)}
      const manualConfirm=$('manual-target-confirm');if(manualConfirm)manualConfirm.onclick=()=>confirmManualTarget(row)}

    function selectedCatalogRows(){return migrationState.catalog.filter(row=>row.canonicalType&&migrationState.selected.has(row.canonicalType)&&row.supported)}
    function mappingObjectState(row){if(!row.totalMappedFields||!row.mappedFields)return {key:'review',label:'Not started',dot:'off'};if(row.mappedFields<row.totalMappedFields)return {key:'review',label:'Needs review',dot:'warning'};return {key:'complete',label:'Complete',dot:''}}
    function renderFieldObjectQueue(){const rows=selectedCatalogRows(),query=$('field-object-search').value.trim().toLowerCase(),filter=$('field-object-filter').value,current=$('field-object').value||migrationState.mapping?.type;const visible=rows.filter(row=>{const state=mappingObjectState(row),text=(row.source.label+' '+row.target.label+' '+row.canonicalType).toLowerCase();return (!query||text.includes(query))&&(filter==='all'||state.key===filter)});$('field-object-queue').innerHTML=visible.length?visible.map(row=>{const state=mappingObjectState(row);return '<button class="mapping-object-item '+(row.canonicalType===current?'active':'')+'" data-field-object="'+row.canonicalType+'"><span><b>'+esc(row.source.label)+' → '+esc(row.target.label)+'</b><small>'+row.mappedFields+' of '+row.totalMappedFields+' fields mapped</small></span><span class="mapping-object-status"><span class="mini-dot '+state.dot+'"></span>'+state.label+'</span></button>'}).join(''):'<div class="mapping-object-empty">No selected objects match this view.</div>';$('field-object-queue').querySelectorAll('[data-field-object]').forEach(button=>button.onclick=()=>openFieldObject(button.dataset.fieldObject));const complete=rows.filter(row=>mappingObjectState(row).key==='complete').length,needsReview=rows.length-complete;$('field-progress-count').textContent=complete+' of '+rows.length+' objects complete';$('field-progress-detail').textContent=needsReview?needsReview+' object'+(needsReview===1?'':'s')+' still need mapping review.':'Every selected object is ready for preflight.'}
    function renderValueObjectTabs(){const rows=selectedCatalogRows(),current=$('value-object').value;$('value-object-tabs').innerHTML=rows.length?rows.map((row,index)=>'<button class="value-object-tab '+(row.canonicalType===current?'active':'')+'" type="button" role="tab" aria-selected="'+(row.canonicalType===current)+'" data-value-object="'+row.canonicalType+'"><span class="value-object-tab-index">'+(index+1)+'</span><span><b>'+esc(row.source.label)+'</b><small>to '+esc(row.target.label)+'</small></span></button>').join(''):'<div class="mapping-object-empty">Select at least one supported object first.</div>';$('value-object-tabs').querySelectorAll('[data-value-object]').forEach(button=>button.onclick=()=>openValueObject(button.dataset.valueObject))}
    function refreshObjectSelectors(){const currentField=$('field-object').value,currentValue=$('value-object').value,rows=selectedCatalogRows(),options=rows.map(row=>'<option value="'+row.canonicalType+'">'+esc(row.source.label)+' → '+esc(row.target.label)+'</option>').join('');$('field-object').innerHTML=options;$('value-object').innerHTML=options;if(rows.some(row=>row.canonicalType===currentField))$('field-object').value=currentField;if(rows.some(row=>row.canonicalType===currentValue))$('value-object').value=currentValue;renderValueObjectTabs();$('object-selection-count').textContent=migrationState.selected.size+' selected';updateFieldObjectPosition();renderFieldObjectQueue();updateMigrationSummary();updateMigrationStepper()}
    async function openFieldObject(type){if(!type||migrationState.mapping?.type===type)return;try{if(migrationState.mapping?.dirty)await saveFieldMappings(false);$('field-object').value=type;await loadFieldWorkspace(type)}catch(e){setDraftStatus(e.message,'error')}}
    function openValueObject(type){if(!type||migrationState.valueContext?.type===type)return;$('value-object').value=type;renderValueObjectTabs();loadValuesWorkspace(type)}
    $('field-object').onchange=()=>openFieldObject($('field-object').value);$('field-object-search').oninput=renderFieldObjectQueue;$('field-object-filter').onchange=renderFieldObjectQueue;
    // Built ONCE per render and shared via <datalist> across every row's <input>, instead of
    // each row carrying its own full <select> option list -- with large orgs (1000+ fields)
    // repeating that list per row multiplied into hundreds of thousands of DOM nodes and froze
    // the tab. A shared datalist keeps the option data in the DOM exactly once.
    function datalistOptions(fields){return fields.map(field=>'<option value="'+esc(field.name)+'">'+esc(field.label)+' · '+esc(field.name)+'</option>').join('')}
    function transformOptionList(value){return transformIds.map(id=>'<option value="'+id+'" '+(id===(value||'identity')?'selected':'')+'>'+esc(transformMeta[id][0])+' — '+esc(transformMeta[id][1])+'</option>').join('')}
    function transformSummary(values){const active=values.filter(value=>value&&value!=='identity');if(!active.length)return 'Identity';if(active.length===1)return transformMeta[active[0]][0];return active.length+' transforms'}
    function transformHidden(cls,value){return '<input type="hidden" class="'+cls+'" value="'+esc(value||'identity')+'">'}
    async function loadFieldWorkspace(type){if(!type)return;const loadToken=++migrationState.fieldLoadToken;$('field-map-rows').innerHTML='<tr><td colspan="5" class="empty">Loading schemas and mappings…</td></tr>';$('field-map-notice').hidden=true;closeTransformLab();const row=migrationState.catalog.find(item=>item.canonicalType===type);if(!row)return;$('field-object').value=type;$('field-current-name').textContent=row.source.label+' → '+row.target.label;updateFieldObjectPosition();renderFieldObjectQueue();
      try{const from=$('mig-from').value,to=from==='salesforce'?'hubspot':'salesforce';const [sourceMeta,targetMeta,sourceMap,targetMap]=await Promise.all([getMetadata(from,row.source.id),getMetadata(to,row.target.id),api('/api/mappings/'+from+'/'+type),api('/api/mappings/'+to+'/'+type)]);
        if(loadToken!==migrationState.fieldLoadToken)return;
        const sourceByCanonical=new Map(sourceMap.rules.map(rule=>[rule.canonical,rule])),targetByCanonical=new Map(targetMap.rules.map(rule=>[rule.canonical,rule]));const canonicals=[...new Set([...sourceByCanonical.keys(),...targetByCanonical.keys()])];
        migrationState.mapping={type,from,to,sourceMeta,targetMeta,sourceMap,targetMap,canonicals,removed:[],dirty:false};
        renderFieldMappings();updateFieldObjectPosition();renderFieldObjectQueue()}catch(e){if(loadToken===migrationState.fieldLoadToken)$('field-map-rows').innerHTML='<tr><td colspan="5" class="empty">'+esc(e.message)+'</td></tr>'}}
    function renderFieldMappings(){const state=migrationState.mapping;if(!state)return;const sourceBy=new Map(state.sourceMap.rules.map(r=>[r.canonical,r])),targetBy=new Map(state.targetMap.rules.map(r=>[r.canonical,r]));
      $('source-native-datalist').innerHTML=datalistOptions(state.sourceMeta.fields);$('target-native-datalist').innerHTML=datalistOptions(state.targetMeta.fields);
      const removed=new Set(state.removed),visible=state.canonicals.filter(canonical=>!removed.has(canonical));$('field-map-rows').innerHTML=visible.map(canonical=>{const s=sourceBy.get(canonical)||{},t=targetBy.get(canonical)||{};
        const transforms=[s.toCanonical||'identity',s.fromCanonical||'identity',t.toCanonical||'identity',t.fromCanonical||'identity'];
        return '<tr data-canonical="'+esc(canonical)+'"><td class="mapping-action"><button class="mapping-remove" data-remove-canonical="'+esc(canonical)+'" aria-label="Remove '+esc(canonical)+' mapping" title="Remove this mapping">Remove</button></td><td><input class="source-native" list="source-native-datalist" value="'+esc(s.native||'')+'" placeholder="— Not mapped —"></td><td><input class="canonical" value="'+esc(canonical)+'"></td><td>'+transformHidden('source-to',transforms[0])+transformHidden('source-from',transforms[1])+transformHidden('target-to',transforms[2])+transformHidden('target-from',transforms[3])+'<button class="mapping-transform" data-transform-canonical="'+esc(canonical)+'">'+esc(transformSummary([transforms[0],transforms[3]]))+'<small>Configure</small></button></td><td><input class="target-native" list="target-native-datalist" value="'+esc(t.native||'')+'" placeholder="— Not mapped —"></td></tr>'}).join('')||'<tr><td colspan="5" class="empty">No mappings remain. Save to persist this empty mapping set, or undo the removal.</td></tr>';
      refreshMappingCoverage();$('field-map-notice').hidden=!state.removed.length;$('field-map-notice-text').textContent=state.removed.length+' mapping'+(state.removed.length===1?'':'s')+' marked for removal. Save mappings to apply.';document.querySelectorAll('[data-remove-canonical]').forEach(button=>button.onclick=()=>{state.removed.push(button.dataset.removeCanonical);state.dirty=true;closeTransformLab();renderFieldMappings()});document.querySelectorAll('[data-transform-canonical]').forEach(button=>button.onclick=()=>openTransformLab(button));document.querySelectorAll('#field-map-rows tr[data-canonical] input').forEach(control=>{control.oninput=control.onchange=()=>{state.dirty=true;refreshMappingCoverage();applyMappingFilters();setDraftStatus('Mapping changes not saved')}});applyMappingFilters()}
    function refreshMappingCoverage(){const state=migrationState.mapping;if(!state)return;const rows=[...$('field-map-rows').querySelectorAll('tr[data-canonical]')],ready=rows.filter(tr=>tr.querySelector('.source-native').value&&tr.querySelector('.target-native').value).length,total=rows.length,pct=total?Math.round(ready/total*100):0;$('coverage-number').textContent=pct+'%';$('coverage-list').innerHTML='<div><span>Mapped</span><b>'+ready+'</b></div><div><span>Needs review</span><b>'+(total-ready)+'</b></div><div><span>Removed</span><b>'+state.removed.length+'</b></div><div><span>Source fields</span><b>'+state.sourceMeta.fields.length+'</b></div><div><span>Target fields</span><b>'+state.targetMeta.fields.length+'</b></div>';$('summary-coverage').textContent=pct+'%'}
    function applyMappingFilters(){const query=$('field-search').value.trim().toLowerCase(),filter=$('field-filter').value;document.querySelectorAll('#field-map-rows tr[data-canonical]').forEach(tr=>{const source=tr.querySelector('.source-native').value||'',target=tr.querySelector('.target-native').value||'',canonical=tr.querySelector('.canonical').value,text=(source+' '+target+' '+canonical).toLowerCase(),ready=tr.querySelector('.source-native').value&&tr.querySelector('.target-native').value,transformed=['source-to','target-from'].some(cls=>tr.querySelector('.'+cls).value!=='identity');tr.hidden=Boolean((query&&!text.includes(query))||(filter==='review'&&ready)||(filter==='transformed'&&!transformed))})}
    $('field-search').oninput=applyMappingFilters;$('field-filter').onchange=applyMappingFilters;
    function updateFieldObjectPosition(){const select=$('field-object'),count=select.options.length,index=select.selectedIndex;$('field-object-position').textContent=count&&index>=0?(index+1)+' of '+count:'No objects'}
    async function moveFieldObject(delta){const select=$('field-object'),next=select.selectedIndex+delta;if(next<0||next>=select.options.length)return;if(migrationState.mapping?.dirty)await saveFieldMappings(false);select.selectedIndex=next;await loadFieldWorkspace(select.value)}
    $('save-next-field-object').onclick=async()=>{try{if(migrationState.mapping?.dirty)await saveFieldMappings(false);await moveFieldObject(1)}catch(e){setDraftStatus(e.message,'error')}};
    function previewTransform(id,value){if(!id||id==='identity')return value;if(id==='trim')return typeof value==='string'?value.trim():value;if(id==='lowercase')return typeof value==='string'?value.trim().toLowerCase():value;if(id==='domain'){if(typeof value!=='string'||!value)return value;try{const url=new URL(value.includes('://')?value:'http://'+value);return url.hostname.replace(/^www\\./,'').toLowerCase()}catch{return value.toLowerCase()}}if(id==='number'){if(value===null||value==='')return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:value}if(id==='boolean'){if(typeof value==='boolean'||value===null)return value;if(typeof value==='string')return ['true','1','yes'].includes(value.toLowerCase());return Boolean(value)}if(id==='yes-no'){if(typeof value==='boolean')return value?'yes':'no';if(typeof value==='string')return ['yes','true','1'].includes(value.toLowerCase());return value}if(id==='iso-date'){const parsed=new Date(value);return Number.isNaN(parsed.getTime())?value:parsed.toISOString()}if(id==='phone')return typeof value==='string'?value.trim().replace(/[^\\d+]/g,''):value;return value}
    function previewValue(value){return typeof value==='string'?value:JSON.stringify(value)}
    function updateTransformPreview(){
      const sample=$('transform-sample').value;
      $('transform-forward-result').textContent=sample?previewValue(previewTransform($('transform-target-from').value,previewTransform($('transform-source-to').value,sample))):'Enter a sample value';
      const sampleReverse=$('transform-sample-reverse').value;
      $('transform-reverse-result').textContent=sampleReverse?previewValue(previewTransform($('transform-source-from').value,previewTransform($('transform-target-to').value,sampleReverse))):'Enter a sample value';
    }
    const transformSelectIds=['transform-source-to','transform-target-from','transform-target-to','transform-source-from'];
    const transformFieldPairs=[['source-to','transform-source-to'],['target-from','transform-target-from'],['target-to','transform-target-to'],['source-from','transform-source-from']];
    function openTransformLab(button){const row=button.closest('tr'),canonical=row.querySelector('.canonical').value,source=row.querySelector('.source-native').value||'Unmapped source',target=row.querySelector('.target-native').value||'Unmapped target';migrationState.transformRow=row;$('transform-field-name').textContent=canonical+' transform';$('transform-field-path').textContent=source+' → '+target;for(const [cls,id] of transformFieldPairs){$(id).innerHTML=transformOptionList(row.querySelector('.'+cls).value)}$('transform-sample').value='';$('transform-sample-reverse').value='';$('transform-lab').hidden=false;updateTransformPreview()}
    function closeTransformLab(){$('transform-lab').hidden=true;migrationState.transformRow=null}
    $('close-transform-lab').onclick=closeTransformLab;$('transform-sample').oninput=updateTransformPreview;$('transform-sample-reverse').oninput=updateTransformPreview;transformSelectIds.forEach(id=>$(id).onchange=updateTransformPreview);
    $('reset-transforms').onclick=()=>{transformSelectIds.forEach(id=>$(id).value='identity');updateTransformPreview()};
    $('apply-transforms').onclick=()=>{const row=migrationState.transformRow;if(!row)return;for(const [cls,id] of transformFieldPairs)row.querySelector('.'+cls).value=$(id).value;row.querySelector('.mapping-transform').innerHTML=esc(transformSummary(transformFieldPairs.map(([,id])=>$(id).value)))+'<small>Configure</small>';migrationState.mapping.dirty=true;setDraftStatus('Mapping changes not saved');applyMappingFilters();closeTransformLab()};
    $('undo-field-removal').onclick=()=>{const state=migrationState.mapping;if(!state?.removed.length)return;state.removed.pop();renderFieldMappings()};
    $('remove-all-fields').onclick=()=>{const state=migrationState.mapping;if(!state)return;const remaining=state.canonicals.filter(c=>!state.removed.includes(c));if(!remaining.length)return;state.removed.push(...remaining);state.dirty=true;closeTransformLab();renderFieldMappings();setDraftStatus('Mapping changes not saved')};
    $('add-field-mapping').onclick=()=>{const state=migrationState.mapping;if(!state)return;let n=state.canonicals.length+1,name='new_field_'+n;while(state.canonicals.includes(name)){n+=1;name='new_field_'+n}
      state.canonicals.push(name);state.dirty=true;$('field-search').value='';$('field-filter').value='all';renderFieldMappings();setDraftStatus('Mapping changes not saved');
      const input=document.querySelector('#field-map-rows tr[data-canonical="'+CSS.escape(name)+'"] .canonical');if(input){input.focus();input.select()}};
    function compatibleMappingAdditions(sourceMeta,targetMeta,sourceRules,targetRules){const used=new Set([...sourceRules,...targetRules].map(rule=>rule.canonical.toLowerCase())),additions=[];for(const source of sourceMeta.fields){const match=targetMeta.fields.find(target=>!target.readOnly&&(target.name.toLowerCase()===source.name.toLowerCase()||target.label.toLowerCase()===source.label.toLowerCase()));const canonical=source.name.replace(/[^a-zA-Z0-9]/g,'');if(match&&canonical&&!used.has(canonical.toLowerCase())){additions.push({canonical,source:source.name,target:match.name});used.add(canonical.toLowerCase())}}return additions}
    function autoMapCurrentObject(){const state=migrationState.mapping;if(!state)return 0;const additions=compatibleMappingAdditions(state.sourceMeta,state.targetMeta,state.sourceMap.rules,state.targetMap.rules);for(const item of additions){state.canonicals.push(item.canonical);state.sourceMap.rules.push({canonical:item.canonical,native:item.source});state.targetMap.rules.push({canonical:item.canonical,native:item.target})}if(additions.length){state.dirty=true;setDraftStatus(additions.length+' compatible mappings ready to review');renderFieldMappings()}return additions.length}
    $('auto-map').onclick=()=>autoMapCurrentObject();
    $('auto-map-all').onclick=async()=>{const rows=selectedCatalogRows();if(!rows.length)return;const button=$('auto-map-all'),from=$('mig-from').value,to=from==='salesforce'?'hubspot':'salesforce',current=migrationState.mapping?.type;button.disabled=true;button.textContent='Finding matches…';try{const batch=await Promise.all(rows.map(async row=>{const [sourceMeta,targetMeta,sourceMap,targetMap]=await Promise.all([getMetadata(from,row.source.id),getMetadata(to,row.target.id),api('/api/mappings/'+from+'/'+row.canonicalType),api('/api/mappings/'+to+'/'+row.canonicalType)]);return {row,sourceMap,targetMap,additions:compatibleMappingAdditions(sourceMeta,targetMeta,sourceMap.rules,targetMap.rules)}})),added=batch.reduce((total,item)=>total+item.additions.length,0),summary=batch.filter(item=>item.additions.length).map(item=>item.row.source.label+': '+item.additions.length).join(' · ');if(!added){setDraftStatus('No new exact matches found','saved');return}const confirmed=await requestTypedConfirmation({title:'Review automatic mappings',message:'Found '+added+' exact matches across '+batch.filter(item=>item.additions.length).length+' objects. '+summary+'. Existing mappings and transforms are preserved.',token:'MAP ALL',buttonLabel:'Apply mappings'});if(!confirmed)return;button.textContent='Applying mappings…';for(const item of batch){if(!item.additions.length)continue;await Promise.all([api('/api/mappings/'+from+'/'+item.row.canonicalType,{method:'PUT',body:JSON.stringify({rules:[...item.sourceMap.rules,...item.additions.map(entry=>({canonical:entry.canonical,native:entry.source}))]})}),api('/api/mappings/'+to+'/'+item.row.canonicalType,{method:'PUT',body:JSON.stringify({rules:[...item.targetMap.rules,...item.additions.map(entry=>({canonical:entry.canonical,native:entry.target}))]})})])}migrationState.metadata.clear();markPlanDirty();queuePlanAutosave();await loadCatalog();if(current)await loadFieldWorkspace(current);setDraftStatus(added+' mappings added across selected objects','saved')}catch(e){setDraftStatus(e.message,'error')}finally{button.disabled=false;button.textContent='Auto-map selected objects'}};
    async function saveFieldMappings(reload=true){const state=migrationState.mapping;if(!state)return;const rows=[...$('field-map-rows').querySelectorAll('tr[data-canonical]')];const existingSource=new Map(state.sourceMap.rules.map(r=>[r.canonical,r])),existingTarget=new Map(state.targetMap.rules.map(r=>[r.canonical,r]));const sourceRules=[],targetRules=[];
      for(const tr of rows){const canonical=tr.querySelector('.canonical').value.trim(),sourceNative=tr.querySelector('.source-native').value,targetNative=tr.querySelector('.target-native').value;if(!canonical||!sourceNative||!targetNative)continue;const oldS=existingSource.get(tr.dataset.canonical)||{},oldT=existingTarget.get(tr.dataset.canonical)||{};sourceRules.push({...oldS,canonical,native:sourceNative,toCanonical:tr.querySelector('.source-to').value,fromCanonical:tr.querySelector('.source-from').value});targetRules.push({...oldT,canonical,native:targetNative,toCanonical:tr.querySelector('.target-to').value,fromCanonical:tr.querySelector('.target-from').value})}
      const button=$('save-field-map');try{button.disabled=true;button.textContent='Saving…';const results=await Promise.all([api('/api/mappings/'+state.from+'/'+state.type,{method:'PUT',body:JSON.stringify({rules:sourceRules})}),api('/api/mappings/'+state.to+'/'+state.type,{method:'PUT',body:JSON.stringify({rules:targetRules})})]);state.dirty=false;migrationState.metadata.clear();markPlanDirty();queuePlanAutosave();await loadCatalog();if(reload)await loadFieldWorkspace(state.type);button.textContent='Saved ✓';setTimeout(()=>button.textContent='Save mappings',1200);
        if(results.some(r=>r.syncPaused))alert('Heads up: '+state.type+' was live-syncing, so saving this mapping change paused both real-time and scheduled sync for it. Review the mapping, then re-enable it from the Sync tab when ready.')
      }catch(e){button.textContent='Save mappings';throw e}finally{button.disabled=false}}
    $('save-field-map').onclick=()=>saveFieldMappings().catch(e=>setDraftStatus(e.message,'error'));

    function blockedNaturalKeyField(type,field){const key=field.replace(/[^a-z0-9]/gi,'').toLowerCase();if(key.includes('external')&&key.endsWith('id'))return false;return key==='id'||['type','industry','website','annualrevenue','revenue'].includes(key)||/(modified|activity|created|updated|timestamp|description|notes?|ownerid|recordtype|status|stage|pipeline|amount|employee|count|isdeleted)/.test(key)}
    function naturalKeyCandidates(type,sourceMeta,targetMeta,sourceRules,targetRules){const common=[...sourceRules.keys()].filter(field=>targetRules.has(field));return common.map(field=>{const source=sourceMeta.fields.find(item=>item.name===sourceRules.get(field)?.native),target=targetMeta.fields.find(item=>item.name===targetRules.get(field)?.native);return {field,source,target,risky:/^(name|phone|title|companyName)$/i.test(field)}}).filter(item=>item.source&&item.target&&!item.source.calculated&&!item.target.calculated&&!blockedNaturalKeyField(type,item.field))}
    function naturalKeyPresets(type,candidates){const available=new Set(candidates.map(item=>item.field)),external=candidates.find(item=>/external.*id|externalid/i.test(item.field))?.field,definitions=[];if(external)definitions.push({fields:[external],label:'Shared external ID',description:'Best when both CRMs store the same immutable business identifier.',recommended:true});
      if(available.has('email'))definitions.push({fields:['email'],label:'Email address',description:'Matches records with the same normalized email address.',recommended:!external});
      else if(available.has('domain'))definitions.push({fields:['domain'],label:'Domain',description:'Matches records using their normalized website domain.',recommended:!external});
      else if(available.has('website'))definitions.push({fields:['website'],label:'Website',description:'Matches records using their normalized website value.',recommended:!external});
      const nameField=['name','dealname'].find(field=>available.has(field)),dateField=[...available].find(field=>/date$/i.test(field));
      if(!definitions.length&&nameField&&dateField)definitions.push({fields:[nameField,dateField],label:nameField+' + '+dateField,description:'Fallback when no shared external ID or unique field exists. Review duplicates carefully.',recommended:!external,risky:true});
      return definitions}
    function sameFields(a,b){return a.length===b.length&&a.every((field,index)=>field===b[index])}
    function renderNaturalKeyOptions(type,keyData,candidates){const presets=naturalKeyPresets(type,candidates),current=keyData.naturalKeyFields,matched=presets.findIndex(item=>sameFields(item.fields,current)),advancedValid=current.length&&current.every(field=>candidates.some(item=>item.field===field));$('natural-key-options').innerHTML=presets.length?presets.map((preset,index)=>'<label class="identity-option"><input type="radio" name="natural-key-mode" value="preset-'+index+'" '+(index===(matched>=0?matched:advancedValid?-1:0)?'checked':'')+'><span><b>'+esc(preset.label)+(preset.recommended?'<em class="recommended-badge">Recommended</em>':'')+'</b><small>'+esc(preset.description)+'</small></span></label>').join(''):'<div class="empty">No recommended identity is mapped in both CRMs.</div>';$('natural-key-fields').innerHTML=candidates.length?candidates.map(item=>'<label class="advanced-key-field"><input type="checkbox" data-natural-key-field="'+esc(item.field)+'" '+(advancedValid&&current.includes(item.field)?'checked':'')+'>'+esc(item.field)+(item.risky?' · mutable':'')+'</label>').join(''):'<div class="empty">Map a stable field in both CRMs first.</div>';const advancedRadio=document.querySelector('input[name="natural-key-mode"][value="advanced"]');advancedRadio.checked=matched<0&&advancedValid;$('natural-key-advanced').open=advancedRadio.checked||matched<0&&current.length>0;migrationState.valueContext.keyPresets=presets;migrationState.valueContext.keyCandidates=candidates;migrationState.valueContext.previousKeyUnsafe=Boolean(current.length&&matched<0&&!advancedValid);document.querySelectorAll('input[name="natural-key-mode"],[data-natural-key-field]').forEach(input=>input.onchange=()=>{if(input.dataset.naturalKeyField)advancedRadio.checked=true;updateNaturalKeyChoice()});updateNaturalKeyChoice()}
    function selectedNaturalKeyFields(){const mode=document.querySelector('input[name="natural-key-mode"]:checked')?.value;if(mode?.startsWith('preset-'))return migrationState.valueContext.keyPresets[Number(mode.slice(7))]?.fields||[];return [...document.querySelectorAll('[data-natural-key-field]:checked')].map(input=>input.dataset.naturalKeyField)}
    function updateNaturalKeyChoice(){const context=migrationState.valueContext;if(!context)return;const fields=selectedNaturalKeyFields(),mode=document.querySelector('input[name="natural-key-mode"]:checked')?.value,preset=mode?.startsWith('preset-')?context.keyPresets[Number(mode.slice(7))]:undefined,risky=fields.filter(field=>context.keyCandidates.find(item=>item.field===field)?.risky);$('save-natural-key').disabled=!fields.length;$('natural-key-summary').textContent=fields.length?'Match using '+fields.join(' + '):'Choose at least one stable field.';const warning=$('natural-key-warning');if(context.previousKeyUnsafe){warning.className='identity-warning';warning.textContent='The previous rule used an unstable or unmapped field. Choose and save a safe replacement before migration.';context.previousKeyUnsafe=false}else if(preset?.risky||risky.length){warning.className='identity-warning';warning.textContent='Review carefully: '+(risky.length?risky.join(', '):'this fallback')+' can change or may not be unique. Preflight will flag missing values and duplicate matches.'}else{warning.className='identity-warning safe';warning.textContent='Good identity rule: the selected field is stable, mapped in both CRMs, and searchable before creating a record.'}}
    async function loadValuesWorkspace(type){if(!type)return;const loadToken=++migrationState.valueLoadToken,row=migrationState.catalog.find(item=>item.canonicalType===type);if(!row)return;$('value-object').value=type;renderValueObjectTabs();$('natural-key-options').innerHTML='<div class="empty">Loading matching rules…</div>';$('value-field').innerHTML='<option value="">Loading value fields…</option>';$('value-map-rows').innerHTML='<tr><td colspan="3" class="empty">Choose a value field after this object loads.</td></tr>';const from=$('mig-from').value,to=from==='salesforce'?'hubspot':'salesforce';
      try{const [sourceMeta,targetMeta,sourceMap,targetMap,keyData]=await Promise.all([getMetadata(from,row.source.id),getMetadata(to,row.target.id),api('/api/mappings/'+from+'/'+type),api('/api/mappings/'+to+'/'+type),api('/api/object-mappings/'+type)]),sourceRules=new Map(sourceMap.rules.map(r=>[r.canonical,r])),targetRules=new Map(targetMap.rules.map(r=>[r.canonical,r])),canonicalFields=[...new Set([...sourceRules.keys()].filter(field=>targetRules.has(field)))],candidates=naturalKeyCandidates(type,sourceMeta,targetMeta,sourceRules,targetRules),enumFields=canonicalFields.filter(c=>{const s=sourceMeta.fields.find(f=>f.name===sourceRules.get(c)?.native),t=targetMeta.fields.find(f=>f.name===targetRules.get(c)?.native);return s?.options?.length||t?.options?.length});
        if(loadToken!==migrationState.valueLoadToken)return;migrationState.valueContext={type,sourceMeta,targetMeta,sourceRules,targetRules,keyData,keyPresets:[],keyCandidates:[],previousKeyUnsafe:false};renderNaturalKeyOptions(type,keyData,candidates);$('value-field').innerHTML='<option value="">Choose a picklist field</option>'+enumFields.map(field=>'<option>'+esc(field)+'</option>').join('')}catch(e){if(loadToken!==migrationState.valueLoadToken)return;$('value-map-rows').innerHTML='<tr><td colspan="3" class="empty">'+esc(e.message)+'</td></tr>';$('natural-key-options').innerHTML='<div class="empty">'+esc(e.message)+'</div>'}}
    $('save-natural-key').onclick=async()=>{const type=$('value-object').value,fields=selectedNaturalKeyFields(),button=$('save-natural-key');if(!fields.length){$('natural-key-warning').className='identity-warning';$('natural-key-warning').textContent='Choose at least one stable identity field.';return}try{button.disabled=true;button.textContent='Saving…';const result=await api('/api/object-mappings/'+type,{method:'PUT',body:JSON.stringify({naturalKeyFields:fields})});markPlanDirty();queuePlanAutosave();button.textContent='Saved ✓';$('natural-key-summary').textContent='Saved: '+fields.join(' + ');setTimeout(()=>button.textContent='Save matching rule',1200);
      if(result.syncPaused)alert('Heads up: '+type+' was live-syncing, so saving this matching rule paused both real-time and scheduled sync for it. Review it, then re-enable from the Sync tab when ready.')
    }catch(e){$('natural-key-warning').className='identity-warning';$('natural-key-warning').textContent=e.message;button.textContent='Save matching rule'}finally{button.disabled=false}};
    $('load-values').onclick=async()=>{const context=migrationState.valueContext,field=$('value-field').value;if(!context||!field)return;const current=await api('/api/value-mappings/'+context.type+'/'+encodeURIComponent(field));const sfMeta=$('mig-from').value==='salesforce'?context.sourceMeta:context.targetMeta,hsMeta=$('mig-from').value==='hubspot'?context.sourceMeta:context.targetMeta;const sfRule=($('mig-from').value==='salesforce'?context.sourceRules:context.targetRules).get(field),hsRule=($('mig-from').value==='hubspot'?context.sourceRules:context.targetRules).get(field);const sfOptions=sfMeta.fields.find(f=>f.name===sfRule?.native)?.options||[],hsOptions=hsMeta.fields.find(f=>f.name===hsRule?.native)?.options||[];const values=new Map(current.entries.map(e=>[e.canonicalValue,e]));[...sfOptions,...hsOptions].forEach(o=>{if(!values.has(o.value))values.set(o.value,{canonicalValue:o.value,salesforceValue:sfOptions.find(x=>x.value===o.value)?.value,hubspotValue:hsOptions.find(x=>x.value===o.value)?.value})});$('value-map-rows').innerHTML=[...values.values()].map(e=>'<tr><td><input class="value-canonical" value="'+esc(e.canonicalValue)+'"></td><td><input class="value-sf" value="'+esc(e.salesforceValue||'')+'"></td><td><input class="value-hs" value="'+esc(e.hubspotValue||'')+'"></td></tr>').join('')||'<tr><td colspan="3" class="empty">No values discovered.</td></tr>'};
    $('save-values').onclick=async()=>{const type=$('value-object').value,field=$('value-field').value;if(!field)return;const entries=[...$('value-map-rows').querySelectorAll('tr')].map(tr=>({canonicalValue:tr.querySelector('.value-canonical')?.value.trim(),salesforceValue:tr.querySelector('.value-sf')?.value.trim()||undefined,hubspotValue:tr.querySelector('.value-hs')?.value.trim()||undefined})).filter(x=>x.canonicalValue);try{const result=await api('/api/value-mappings/'+type+'/'+encodeURIComponent(field),{method:'PUT',body:JSON.stringify({entries})});markPlanDirty();queuePlanAutosave();$('save-values').textContent='Saved ✓';setTimeout(()=>$('save-values').textContent='Save values',1200);
      if(result.syncPaused)alert('Heads up: '+type+' was live-syncing, so saving this value mapping paused both real-time and scheduled sync for it. Review it, then re-enable from the Sync tab when ready.')
    }catch(e){alert(e.message)}};

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
    async function openIssueField(issue){selectMigrationStep('fields');$('field-object').value=issue.type;await loadFieldWorkspace(issue.type);const row=[...document.querySelectorAll('#field-map-rows tr[data-canonical]')].find(tr=>tr.dataset.canonical===issue.field);if(row){row.scrollIntoView({block:'center',behavior:'smooth'});row.classList.add('highlight-row');setTimeout(()=>row.classList.remove('highlight-row'),2200)}}
    function copilotConfidence(value){return value>=.8?'High confidence':value>=.55?'Medium confidence':'Low confidence'}
    function copilotAreaLabel(area){return {field_mappings:'Open field mappings',value_mappings:'Open value mappings',owner_mappings:'Open owner mappings',object_settings:'Open object settings'}[area]||''}
    function openCopilotArea(area,type){if(area==='field_mappings'){selectMigrationStep('fields');$('field-object').value=type;loadFieldWorkspace(type)}else if(area==='value_mappings'||area==='owner_mappings'){selectMigrationStep('values');$('value-object').value=type;loadValuesWorkspace(type)}else if(area==='object_settings')selectMigrationStep('objects')}
    function renderCopilot(result){const panel=$('copilot-panel'),readinessLabel={blocked:'Blocked',review_required:'Review required',ready:'Ready'}[result.readiness],readinessClass=result.readiness==='blocked'?'error':result.readiness==='review_required'?'ambiguous':'completed';
      const findings=result.findings.map((finding,index)=>{const areaLabel=copilotAreaLabel(finding.recommendationArea);return '<article class="copilot-finding"><div class="copilot-finding-head"><span class="pill '+(finding.severity==='error'?'error':finding.severity==='warning'?'ambiguous':'queued')+'">'+esc(finding.objectType)+'</span><b>'+esc(finding.title)+'</b><span class="copilot-confidence">'+esc(copilotConfidence(finding.confidence))+'</span></div><p>'+esc(finding.explanation)+'</p><div class="copilot-action"><b>Suggested next step:</b> '+esc(finding.recommendedAction)+'</div>'+(areaLabel?'<button class="secondary" data-copilot-index="'+index+'">'+esc(areaLabel)+'</button>':'')+'</article>'}).join('');
      panel.innerHTML='<div class="copilot-head"><div><div class="copilot-kicker">Migration Copilot · read only</div><h3>Preflight guidance</h3><p>'+esc(result.summary)+'</p></div><span class="pill '+readinessClass+'">'+esc(readinessLabel)+'</span></div><div class="copilot-privacy"><span>No record values shared</span><span>No credentials shared</span><span>No changes applied</span></div><div class="copilot-findings">'+(findings||'<div class="empty">No preflight issues need explanation.</div>')+'</div>'+(result.nextSteps.length?'<div class="copilot-next"><b>Recommended order</b><ol>'+result.nextSteps.map(step=>'<li>'+esc(step)+'</li>').join('')+'</ol></div>':'')+'<div class="copilot-note">'+esc(result.disclaimer)+' · '+esc(result.model)+'</div>';panel.hidden=false;panel.querySelectorAll('[data-copilot-index]').forEach(button=>{const finding=result.findings[Number(button.dataset.copilotIndex)];button.onclick=()=>openCopilotArea(finding.recommendationArea,finding.objectType)})}
    async function askCopilot(){if(!migrationState.preflight||!migrationState.plan)return;const button=$('ask-copilot'),panel=$('copilot-panel');button.disabled=true;button.textContent='Analyzing…';panel.hidden=false;panel.innerHTML='<div class="empty">Reviewing schema metadata and mapping context…</div>';try{const result=await api('/api/migration-plans/'+migrationState.plan.id+'/copilot/preflight',{method:'POST'});migrationState.copilot=result;renderCopilot(result)}catch(e){panel.innerHTML='<div class="preflight-blocked"><b>Copilot unavailable</b><p>'+esc(e.message)+'</p>'+(e.actionUrl?'<a class="button secondary" href="'+esc(e.actionUrl)+'">Configure Copilot</a>':'')+'</div>'}finally{button.disabled=false;button.textContent=migrationState.copilot?'Refresh Copilot':'Ask Copilot'}}
    $('run-preflight').onclick=()=>runPlanPreflight().catch(()=>{});$('side-preflight').onclick=()=>{selectMigrationStep('validate');runPlanPreflight().catch(()=>{})};
    $('ask-copilot').onclick=askCopilot;
    function testTypeLabel(type){return migrationState.catalog.find(row=>row.canonicalType===type)?.source.label||type}
    function currentCanaryPassed(){return migrationState.canaryVerified||Boolean(migrationState.plan?.canary?.verifiedAt&&migrationState.plan.canary.previewRevision===migrationState.plan.revision)}
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
    $('execute-canary').onclick=async()=>{if(!migrationState.plan||!migrationState.canaryPreview)return;const confirmed=await requestTypedConfirmation({title:'Test one real record',message:'This writes exactly one record to the destination CRM, then reads it back to verify the result.',token:'TEST',buttonLabel:'Test 1 record'});if(!confirmed)return;const button=$('execute-canary');button.disabled=true;button.textContent='Testing…';$('mig-status').textContent='Rechecking and writing one record…';try{const result=await api('/api/migration-plans/'+migrationState.plan.id+'/test-record/execute',{method:'POST',body:JSON.stringify({confirm:true,previewRunId:migrationState.canaryPreview.runId})});migrationState.plan=await api('/api/migration-plans/'+migrationState.plan.id);if(result.verification?.verified){showCanaryPassed('Verified in '+(result.verification.target==='salesforce'?'Salesforce':'HubSpot')+' as '+result.verification.targetId+'.');await Promise.all([loadRuns(),loadMetrics(),loadSavedPlans()])}else{$('summary-preview').textContent='Verification failed';$('mig-status').textContent='The write completed but the destination record could not be verified.'}}catch(e){$('summary-preview').textContent='Test failed';$('mig-status').textContent=e.message}finally{button.disabled=false;button.textContent='Test 1 record'}};
    $('execute-batch').onclick=async()=>{
      if(!migrationState.plan)return;
      const type=$('test-record-type').value,count=Number($('batch-count').value);
      if(!type){$('mig-status').textContent='Choose an object first';return}
      if(!Number.isInteger(count)||count<1){$('mig-status').textContent='Enter a valid record count';return}
      const confirmed=await requestTypedConfirmation({title:'Migrate a batch of records',message:'This writes up to '+count+' '+testTypeLabel(type)+' record(s) to the destination CRM immediately.',token:'MIGRATE',buttonLabel:'Migrate batch'});
      if(!confirmed)return;
      const button=$('execute-batch');button.disabled=true;button.textContent='Migrating…';$('batch-result').hidden=true;
      $('mig-status').textContent='Rechecking and writing up to '+count+' records…';
      try{
        const result=await api('/api/migration-plans/'+migrationState.plan.id+'/test-batch/execute',{method:'POST',body:JSON.stringify({type,count,confirm:true})});
        migrationState.plan=await api('/api/migration-plans/'+migrationState.plan.id);
        const stats=result.perType[type]||{read:0,reconciled:0,errors:0,actions:{}};
        const actionSummary=Object.entries(stats.actions).map(([action,n])=>n+' '+action).join(', ')||'no changes';
        const failedRecords=(result.plans||[]).filter(p=>p.action==='error');
        const errorList=failedRecords.length?'<div class="batch-error-list">'+failedRecords.map(p=>'<div class="batch-error-row"><b>'+esc(p.sourceId)+'</b><span>'+esc(p.warnings[p.warnings.length-1]||'Unknown error')+'</span></div>').join('')+'</div>':'';
        $('batch-result').className='batch-result'+(stats.errors?' error':'');
        $('batch-result').hidden=false;
        $('batch-result').innerHTML='<b>'+stats.reconciled+' of '+stats.read+' records migrated</b><br>'+esc(actionSummary)+(stats.errors?' · '+stats.errors+' error'+(stats.errors===1?'':'s'):'')+errorList;
        showCanaryPassed(stats.reconciled+' of '+stats.read+' '+testTypeLabel(type)+' record(s) migrated ('+actionSummary+').');
        $('test-result-title').textContent=stats.reconciled+' of '+stats.read+' records migrated';
        await Promise.all([loadRuns(),loadMetrics(),loadSavedPlans()]);
      }catch(e){
        $('batch-result').className='batch-result error';$('batch-result').hidden=false;$('batch-result').textContent=e.message;
        $('mig-status').textContent=e.message;
      }finally{button.disabled=false;button.textContent='Migrate batch'}
    };
    async function generatePreview(){if(!currentCanaryPassed()){$('mig-status').textContent='Pass the one-record test before preparing the full migration.';return}try{const plan=await ensurePlan();$('mig-status').textContent='Preparing full migration…';$('preview').disabled=true;const result=await api('/api/migration-plans/'+plan.id+'/preview',{method:'POST'});migrationState.preview=result;migrationState.plan=await api('/api/migration-plans/'+plan.id);renderPlans(result.plans);renderPreviewActions(result.plans);$('execute').disabled=result.plans.some(p=>p.action==='ambiguous')||!result.plans.length;$('mig-status').textContent=result.runId.slice(0,8)+' · '+result.plans.length+' records ready for review';$('summary-preflight').textContent='Passed';updateMigrationStepper();await loadRuns();await loadSavedPlans()}catch(e){$('mig-status').textContent=e.message;updateMigrationStepper()}finally{$('preview').disabled=false}}
    $('preview').onclick=generatePreview;$('side-preview').onclick=()=>goMigrationStep('preview');
    function renderPreviewActions(plans){const actions=['create','update','match','skip','conflict','ambiguous','error'];const counts=Object.fromEntries(actions.map(action=>[action,plans.filter(p=>p.action===action).length]));$('preview-actions').innerHTML=actions.map(action=>'<div class="preview-action"><b>'+counts[action]+'</b><span>'+action+'</span></div>').join('')}
    function renderPlans(plans){$('plans').innerHTML=plans.length?plans.map(p=>'<tr><td><span class="pill '+p.action+'">'+esc(p.action)+'</span></td><td>'+esc(p.type)+'</td><td>'+esc(p.naturalKey||'—')+
      '</td><td>'+esc(p.targetId||'new')+'</td><td>'+esc(p.fieldDiff.map(d=>d.field).join(', ')||p.warnings.join('; ')||'No changes')+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">No records in this scope.</td></tr>'}
    $('execute').onclick=async()=>{if(!migrationState.plan||!migrationState.preview)return;const confirmed=await requestTypedConfirmation({title:'Run full migration',message:'This writes every reviewed record in the prepared migration to the destination CRM.',token:'EXECUTE',buttonLabel:'Run migration'});if(!confirmed)return;try{$('execute').disabled=true;$('mig-status').textContent='Rechecking the prepared migration…';const result=await api('/api/migration-plans/'+migrationState.plan.id+'/execute',{method:'POST',body:JSON.stringify({confirm:true})});$('mig-status').textContent='Completed '+result.runId.slice(0,8);$('summary-preview').textContent='Migration complete';await Promise.all([loadRuns(),loadMetrics(),loadSavedPlans()])}catch(e){$('mig-status').textContent=e.message}};

    async function loadSavedPlans(){const result=await api('/api/migration-plans');migrationState.savedPlans=result.entries;$('saved-plan-count').textContent=result.entries.length;$('saved-plans').innerHTML=result.entries.length?result.entries.map(plan=>'<article class="plan-item" data-plan="'+plan.id+'"><div class="plan-name"><span>'+esc(plan.name)+'</span><span class="pill '+(plan.status==='completed'?'completed':plan.status==='failed'?'error':'queued')+'">'+esc(plan.status)+'</span></div><div class="plan-meta">'+esc(plan.source==='salesforce'?'Salesforce → HubSpot':'HubSpot → Salesforce')+' · '+plan.types.length+' objects · revision '+plan.revision+'</div><div class="plan-meta">'+esc(plan.canary?.verifiedAt?'One-record test passed':plan.canary?'Test record ready':'One-record test required')+'</div></article>').join(''):'<div class="empty">No saved plans yet. Configure the builder and your first draft will appear here.</div>';$('saved-plans').querySelectorAll('[data-plan]').forEach(item=>item.onclick=()=>loadPlan(item.dataset.plan))}
    async function loadPlan(id){const plan=await api('/api/migration-plans/'+id);selectMigrateTab('builder');migrationState.plan=plan;migrationState.dirty=false;migrationState.selected=new Set(plan.types);migrationState.preview=null;migrationState.canaryPreview=null;migrationState.canaryVerified=Boolean(plan.canary?.verifiedAt&&plan.canary.previewRevision===plan.revision);migrationState.preflight=null;resetCopilot();$('plan-name').value=plan.name;$('mig-from').value=plan.source;$('mig-limit').value=plan.limitPerType||20;updateDirectionPreview();setDraftStatus('Loaded revision '+plan.revision,'saved');await loadCatalog();$('summary-plan').textContent=plan.name+' · r'+plan.revision;$('summary-preflight').textContent=plan.status==='validated'||plan.status==='previewed'||plan.status==='completed'?'Passed':'Not run';$('summary-preview').textContent=migrationState.canaryVerified?'Passed':plan.canary?'Ready':'Required';$('full-migration').hidden=!migrationState.canaryVerified;$('test-record-result').hidden=true;
      const hasCurrentPreview=plan.previewRunId&&plan.previewRevision===plan.revision;if(hasCurrentPreview){const frozen=await api('/api/migrations/'+plan.previewRunId+'/items?limit=2000');migrationState.preview={runId:plan.previewRunId,plans:frozen.entries};renderPlans(frozen.entries);renderPreviewActions(frozen.entries);$('mig-status').textContent=plan.previewRunId.slice(0,8)+' · prepared migration loaded';$('execute').disabled=!frozen.entries.length||frozen.entries.some(item=>item.action==='ambiguous')}else{$('execute').disabled=true}updateMigrationSummary();updateMigrationStepper()}
    function updateMigrationSummary(){const rows=selectedCatalogRows(),direction=$('mig-from').value==='salesforce'?'Salesforce → HubSpot':'HubSpot → Salesforce';$('summary-direction').textContent=direction;$('summary-objects').textContent=migrationState.selected.size+' selected';const mapped=rows.reduce((n,row)=>n+row.mappedFields,0),total=rows.reduce((n,row)=>n+row.totalMappedFields,0);$('summary-coverage').textContent=total?Math.round(mapped/total*100)+'%':'—';if(!migrationState.plan)$('summary-plan').textContent='Unsaved draft'}
    async function loadRuns(){const r=await api('/api/migrations');migrationState.runs=r.entries;$('run-count').textContent=r.entries.length;const latest=r.entries[0];$('latest-run-shortcut').textContent=latest?'Latest run · '+latest.status:'View run history';renderMigrationRuns()}
    function renderMigrationRuns(){const query=$('run-search').value.trim().toLowerCase(),status=$('run-status-filter').value,mode=$('run-mode-filter').value;const entries=migrationState.runs.filter(run=>(!query||(run.id+' '+run.source).toLowerCase().includes(query))&&(!status||run.status===status)&&(!mode||run.mode===mode));$('runs').innerHTML=entries.length?'<table><thead><tr><th>Run</th><th>Mode</th><th>Source</th><th>Status</th><th>Started</th></tr></thead><tbody>'+
      entries.map(x=>'<tr><td><button class="run-link" data-run-id="'+esc(x.id)+'">'+esc(x.id.slice(0,8))+'</button></td><td>'+esc(x.mode)+'</td><td>'+esc(x.source)+'</td><td><span class="pill '+esc(x.status)+'">'+esc(x.status)+'</span></td><td>'+esc(new Date(x.createdAt).toLocaleString())+'</td></tr>').join('')+'</tbody></table><div class="run-detail" id="run-detail"></div>':'<div class="empty history-empty">No migration runs match these filters.</div>';$('runs').querySelectorAll('[data-run-id]').forEach(button=>button.onclick=()=>loadRunDetail(button.dataset.runId))}
    async function loadRunDetail(id){const r=await api('/api/migrations/'+id+'/items?limit=200');$('run-detail').innerHTML='<div class="card-head"><h2>Run '+esc(id.slice(0,8))+'</h2><span class="section-note">'+r.entries.length+' reviewed records</span></div><div class="scroll"><table><thead><tr><th>Action</th><th>Object</th><th>Natural key</th><th>Target</th></tr></thead><tbody>'+r.entries.map(item=>'<tr><td><span class="pill '+esc(item.action)+'">'+esc(item.action)+'</span></td><td>'+esc(item.type)+'</td><td>'+esc(item.naturalKey||'—')+'</td><td>'+esc(item.targetId||'New record')+'</td></tr>').join('')+'</tbody></table></div>'}
    $('run-search').oninput=renderMigrationRuns;$('run-status-filter').onchange=renderMigrationRuns;$('run-mode-filter').onchange=renderMigrationRuns;$('refresh-runs').onclick=loadRuns;

    let syncConfigState;
    let syncObjectCatalog=[];
    async function loadSyncWorkspace(){await Promise.all([loadMetrics(),loadSyncSettings(),loadConflicts()])}
    async function loadSyncSettings(){
      const [config,objectMappings]=await Promise.all([api('/api/sync/settings'),api('/api/object-mappings')]);
      syncConfigState=config;syncObjectCatalog=objectMappings.entries;
      $('sync-conflict-strategy').value=config.conflictStrategy;$('sync-source-of-truth').value=config.sourceOfTruth;
      renderSyncObjectRows(config);
      $('webhook-health').innerHTML=Object.entries(config.webhooks).map(([system,value])=>'<div class="webhook-card"><div class="webhook-card-head"><b>'+esc(system==='salesforce'?'Salesforce':'HubSpot')+'</b><span class="pill '+(value.connected&&value.signingConfigured?'completed':'ambiguous')+'">'+(value.connected&&value.signingConfigured?'Healthy':'Needs attention')+'</span></div><p>'+esc(value.connected?'Account connected':'Account disconnected')+' · '+esc(value.signingConfigured?'signature verification configured':'signing secret missing')+'</p></div>').join('')}
    function minutesToUnit(min){if(min%1440===0)return{value:min/1440,unit:'days'};if(min%60===0)return{value:min/60,unit:'hours'};return{value:min,unit:'minutes'}}
    function unitToMinutes(value,unit){const n=Number(value)||0;return unit==='days'?n*1440:unit==='hours'?n*60:n}
    function pollingStatusText(status){if(!status)return 'No scheduled poll has run yet.';
      return 'Last run '+new Date(status.at).toLocaleString()+' · '+status.changed+' change'+(status.changed===1?'':'s')+', '+status.deleted+' deletion'+(status.deleted===1?'':'s')+(status.errors?', '+status.errors+' error'+(status.errors===1?'':'s'):'')}
    function renderSyncObjectRows(config){
      $('sync-object-settings').innerHTML=syncObjectCatalog.length?syncObjectCatalog.map(obj=>syncObjectRowHtml(obj,config)).join(''):'<div class="empty">No objects registered yet — add one below.</div>';
      syncObjectCatalog.forEach(obj=>{const type=obj.canonicalObject;$('poll-now-'+type).onclick=()=>pollObjectNow(type);$('map-fields-'+type).onclick=()=>goMapFields(type)});
    }
    function syncObjectRowHtml(obj,config){
      const type=obj.canonicalObject,value=config.objects[type]||{enabled:false,direction:'bidirectional'},polling=config.polling[type]||{enabled:false,intervalMinutes:30},unit=minutesToUnit(polling.intervalMinutes),status=config.pollingStatus&&config.pollingStatus[type];
      return '<div class="object-sync-row">'
        +'<div class="object-sync-main"><label><input type="checkbox" data-sync-enabled="'+esc(type)+'" '+(value.enabled?'checked':'')+'><b>'+esc(obj.label)+'</b></label>'
        +'<span class="pill '+(value.enabled?'completed':'queued')+'">'+(value.enabled?'Live':'Paused')+'</span>'
        +'<select data-sync-direction="'+esc(type)+'"><option value="bidirectional" '+(value.direction==='bidirectional'?'selected':'')+'>Bidirectional</option><option value="salesforce_to_hubspot" '+(value.direction==='salesforce_to_hubspot'?'selected':'')+'>Salesforce → HubSpot</option><option value="hubspot_to_salesforce" '+(value.direction==='hubspot_to_salesforce'?'selected':'')+'>HubSpot → Salesforce</option></select></div>'
        +'<div class="object-poll-row"><label><input type="checkbox" data-poll-enabled="'+esc(type)+'" '+(polling.enabled?'checked':'')+'> Scheduled sync</label>'
        +'<span>every</span><input type="number" min="1" step="1" value="'+unit.value+'" data-poll-value="'+esc(type)+'">'
        +'<select data-poll-unit="'+esc(type)+'"><option value="minutes" '+(unit.unit==='minutes'?'selected':'')+'>Minutes</option><option value="hours" '+(unit.unit==='hours'?'selected':'')+'>Hours</option><option value="days" '+(unit.unit==='days'?'selected':'')+'>Days</option></select>'
        +'<button class="secondary" id="poll-now-'+esc(type)+'" type="button">Sync now</button>'
        +'<button class="run-link" id="map-fields-'+esc(type)+'" type="button">Map fields</button>'
        +'<span class="muted" id="poll-status-'+esc(type)+'">'+esc(pollingStatusText(status))+'</span></div>'
        +'</div>';
    }
    function collectSyncObjects(){return Object.fromEntries(syncObjectCatalog.map(obj=>{const type=obj.canonicalObject;return [type,{enabled:document.querySelector('[data-sync-enabled="'+type+'"]').checked,direction:document.querySelector('[data-sync-direction="'+type+'"]').value}]}))}
    function collectSyncPolling(){return Object.fromEntries(syncObjectCatalog.map(obj=>{const type=obj.canonicalObject;return [type,{enabled:document.querySelector('[data-poll-enabled="'+type+'"]').checked,intervalMinutes:unitToMinutes(document.querySelector('[data-poll-value="'+type+'"]').value,document.querySelector('[data-poll-unit="'+type+'"]').value)}]}))}
    function persistSyncSettings(){return api('/api/sync/settings',{method:'PATCH',body:JSON.stringify({conflictStrategy:$('sync-conflict-strategy').value,sourceOfTruth:$('sync-source-of-truth').value,objects:collectSyncObjects(),polling:collectSyncPolling()})})}
    $('save-sync-settings').onclick=async()=>{const button=$('save-sync-settings'),message=$('sync-settings-message');button.disabled=true;message.className='settings-message';message.textContent='Saving sync policy…';try{syncConfigState=await persistSyncSettings();message.textContent='Saved. Webhooks use this immediately; scheduled sync within one interval.';await loadSyncSettings()}catch(e){message.className='settings-message error';message.textContent=e.message}finally{button.disabled=false}};
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
    function goMapFields(type){history.replaceState(null,'','#migration');selectView('migration');selectMigrationStep('fields');openFieldObject(type)}
    $('add-sync-object').onclick=()=>{history.replaceState(null,'','#migration');selectView('migration');selectMigrationStep('objects')};
    async function loadConflicts(){const r=await api('/api/sync/jobs?limit=200');const entries=r.entries.filter(job=>job.status==='manual_review'||job.status==='dead_letter');$('conflicts').innerHTML=entries.length?entries.map(j=>'<tr><td><span class="pill '+j.status+'">'+esc(j.status)+'</span></td><td>'+esc(j.event.system+' '+j.event.type+' '+j.event.changeType)+'</td><td>'+j.attempts+'</td><td>'+esc(j.lastError||'Operator review required')+'</td><td>'+(j.status==='manual_review'&&j.event.changeType==='deleted'?'<button class="danger" onclick="approveDelete(\\''+j.id+'\\')">Approve delete</button>':'<button onclick="replay(\\''+j.id+'\\')">Replay</button>')+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">No conflicts or manual reviews waiting.</td></tr>'}
    $('refresh-conflicts').onclick=loadConflicts;

    async function loadJobs(){const f=$('job-filter').value;const r=await api('/api/sync/jobs?limit=200'+(f?'&status='+encodeURIComponent(f):''));$('jobs').innerHTML=r.entries.length?r.entries.map(j=>'<tr><td><span class="pill '+j.status+'">'+esc(j.status)+'</span></td><td>'+esc(j.event.system+' '+j.event.type+' '+j.event.changeType)+'<br><span class="muted">'+esc(j.event.sourceId)+'</span></td><td>'+j.attempts+'</td><td>'+esc(j.lastError||'—')+'</td><td>'+(j.status==='manual_review'&&j.event.changeType==='deleted'?'<button class="danger" onclick="approveDelete(\\''+j.id+'\\')">Approve delete</button>':j.status==='dead_letter'||j.status==='manual_review'?'<button onclick="replay(\\''+j.id+'\\')">Replay</button>':'')+'</td></tr>').join(''):'<tr><td colspan="5" class="empty">No jobs</td></tr>'}
    async function replay(id){await api('/api/sync/jobs/'+id+'/replay',{method:'POST'});await Promise.all([loadJobs(),loadMetrics(),loadConflicts()])}async function approveDelete(id){if(!confirm('Delete/archive the linked record in the other CRM?'))return;await api('/api/sync/jobs/'+id+'/approve-delete',{method:'POST'});await Promise.all([loadJobs(),loadMetrics(),loadConflicts()])}window.replay=replay;window.approveDelete=approveDelete;$('job-filter').onchange=loadJobs;
    document.querySelectorAll('[data-activity-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-activity-tab]').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.activity-panel').forEach(panel=>panel.classList.toggle('active',panel.id==='activity-'+button.dataset.activityTab))});
    async function loadAudit(){const a=await api('/api/audit?limit=100');$('audit').innerHTML=a.entries.length?a.entries.map(x=>'<div class="audit-entry"><b>'+esc(x.action)+'</b><br><span class="muted">'+esc(x.detail.message||x.resourceType)+' · '+esc(new Date(x.createdAt).toLocaleString())+'</span></div>').join(''):'<div class="empty">No audit entries</div>'}

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

    async function refreshAll(){await Promise.allSettled([loadRuns(),loadCatalog(),loadSavedPlans()]);const view=location.hash.slice(1)||'migration';if(view==='sync')await loadSyncWorkspace();if(view==='activity')await Promise.all([loadJobs(),loadAudit()]);if(view==='settings')await loadSettingsWorkspace()}window.refreshAll=refreshAll;refreshAll();
  </script>
</body></html>`;
}
