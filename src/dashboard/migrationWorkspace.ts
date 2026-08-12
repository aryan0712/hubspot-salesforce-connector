export const migrationWorkspaceCss = `
  .migration-workspace{display:flex;flex-direction:column;gap:16px}
  .migrate-tabs{display:flex;align-items:center;gap:6px;padding:6px;background:#e9eff4;border-radius:10px;width:max-content;max-width:100%;overflow-x:auto}
  .migrate-tab{background:transparent;border-color:transparent;color:var(--text-2);padding:9px 14px;white-space:nowrap}
  .migrate-tab:hover{background:rgba(255,255,255,.72);border-color:transparent;color:var(--text)}
  .migrate-tab.active{background:#fff;border-color:#fff;color:var(--text);box-shadow:0 1px 3px rgba(46,63,80,.13)}
  .migrate-tab-count{display:inline-flex;justify-content:center;min-width:20px;margin-left:6px;padding:1px 6px;border-radius:999px;background:#e5ebf0;color:var(--text-2);font-size:10px}
  .migrate-section{display:none}.migrate-section.active{display:flex;flex-direction:column;gap:16px}
  .builder-header{display:flex;align-items:center;gap:20px;padding:18px 20px}
  .builder-heading{min-width:0;margin-right:auto}
  .builder-kicker{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--orange)}
  .builder-heading h2{padding:0;border:0;margin:3px 0 4px;font-size:20px}
  .draft-state{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}
  .draft-state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--amber)}
  .draft-state.saved::before{background:var(--teal)}.draft-state.error::before{background:var(--red)}
  .builder-summary{position:relative}
  .builder-summary>summary{list-style:none;cursor:pointer;border:1px solid var(--border-strong);border-radius:8px;
    padding:9px 12px;color:var(--text-2);font-size:13px;font-weight:600;background:#fff}
  .builder-summary>summary::-webkit-details-marker{display:none}
  .builder-summary[open]>summary{background:#fafcfd}
  .builder-header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .builder-header-actions button{padding:9px 12px}
  .builder-summary-panel{position:absolute;right:0;top:46px;z-index:20;width:min(620px,calc(100vw - 48px));
    padding:18px;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:0 14px 40px rgba(31,45,61,.16)}
  .summary-title{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px}
  .summary-rows{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
  .summary-row{padding:10px 12px;background:#fafcfd;border:1px solid var(--border);border-radius:8px;color:var(--text-2);font-size:11px}
  .summary-row span,.summary-row b{display:block}.summary-row b{margin-top:4px;color:var(--text);font-size:13px}
  .summary-actions{display:flex;gap:8px;margin-top:12px}.summary-actions button{padding:8px 10px}
  .saved-plan-section{margin-top:16px;padding-top:14px;border-top:1px solid var(--border)}
  .plan-list{max-height:210px;overflow:auto}.plan-item{padding:10px 0;border-bottom:1px solid #f0f3f7;cursor:pointer}
  .plan-item:last-child{border-bottom:0}.plan-item:hover .plan-name{color:var(--orange)}
  .plan-name{display:flex;justify-content:space-between;gap:8px;color:var(--text);font-weight:600;font-size:13px}
  .plan-meta{color:var(--muted);font-size:11px;margin-top:3px}
  .library-head{padding:22px 24px;display:flex;align-items:flex-start;gap:16px;border-bottom:1px solid #eaeff4}
  .library-head>div{margin-right:auto}.library-head h2{padding:0;border:0;font-size:20px}
  .library-head p{margin:5px 0 0;color:var(--muted);font-size:13px}
  .plan-library{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:20px 24px}
  .plan-library .plan-item{padding:16px;border:1px solid var(--border);border-radius:9px;background:#fafcfd}
  .plan-library .plan-item:hover{border-color:var(--orange);background:#fff}
  .history-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) 180px 160px auto;gap:10px;padding:16px 20px;border-bottom:1px solid #eaeff4}
  .history-toolbar button{width:auto}.history-empty{padding:36px}

  .builder-shell{display:grid;grid-template-columns:228px minmax(0,1fr);gap:16px;align-items:start}
  .workspace-steps{position:sticky;top:18px;display:flex;flex-direction:column;padding:8px;background:#f0f3f7;border-radius:11px}
  .workspace-step{display:grid;grid-template-columns:30px minmax(0,1fr) 16px;gap:10px;align-items:center;width:100%;
    border:0;background:transparent;color:var(--text-2);padding:11px 10px;text-align:left}
  .workspace-step:hover{background:rgba(255,255,255,.72);color:var(--text)}
  .workspace-step.active{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(46,63,80,.13)}
  .step-number{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#dde4eb;color:var(--text-2);font-weight:700;font-size:12px}
  .workspace-step.active .step-number{background:var(--orange);color:#fff}
  .workspace-step.complete .step-number{background:var(--teal);color:#fff}
  .step-copy{min-width:0}.step-copy b,.step-copy small{display:block}.step-copy b{font-size:13px}
  .step-copy small{margin-top:2px;color:var(--muted);font-size:10px;font-weight:400;white-space:normal}
  .step-indicator{width:8px;height:8px;border-radius:50%;background:#c9d2dc}
  .workspace-step.complete .step-indicator{background:var(--teal)}
  .workspace-step.warning .step-indicator{background:var(--amber)}
  .workspace-step.blocked .step-indicator{background:var(--red)}
  .builder-stage{min-width:0}.workspace-panel{display:none}.workspace-panel.active{display:block}
  .step-card{overflow:hidden}
  .step-intro{padding:22px 24px 18px;border-bottom:1px solid #eaeff4}
  .step-intro-row{display:flex;align-items:flex-start;gap:16px}.step-intro-row>div{margin-right:auto}
  .step-eyebrow{color:var(--orange);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .step-intro h2{padding:0;border:0;margin:4px 0 5px;font-size:21px}
  .step-intro p{margin:0;color:var(--text-2);font-size:13px;line-height:1.5;max-width:720px}
  .step-footer{position:sticky;bottom:0;z-index:8;display:flex;align-items:center;gap:10px;padding:14px 20px;
    border-top:1px solid var(--border);background:rgba(255,255,255,.96);backdrop-filter:blur(8px)}
  .step-footer-note{margin-right:auto;color:var(--muted);font-size:12px}
  .step-footer button{min-width:92px}.step-footer .next-step{min-width:154px}

  .plan-bar{padding:22px 24px;display:grid;grid-template-columns:minmax(210px,1.4fr) minmax(190px,1fr) 130px;gap:16px;align-items:end}
  .scope-options{grid-column:1/-1;display:grid;grid-template-columns:1fr;gap:12px}
  .scope-option{display:flex;align-items:center;gap:11px;padding:14px;border:1px solid var(--border);border-radius:9px;background:#fafcfd}
  .scope-option input{width:17px;min-height:auto;height:17px;accent-color:var(--orange)}
  .scope-option span{display:block}.scope-option b{display:block;font-size:13px}.scope-option small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
  .direction-preview{grid-column:1/-1;display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;padding:16px;
    border:1px solid #dbe4ec;border-radius:10px;background:#f8fbfd}
  .direction-system{padding:12px 14px;background:#fff;border:1px solid var(--border);border-radius:8px}
  .direction-system span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.07em}
  .direction-system b{display:block;margin-top:3px;font-size:14px}.direction-arrow{color:var(--orange);font-size:20px;font-weight:700}

  .panel-toolbar{padding:14px 20px;border-bottom:1px solid #eaeff4;display:flex;gap:9px;align-items:center;flex-wrap:wrap}
  .panel-toolbar h2{padding:0;border:0;margin-right:auto}.panel-toolbar input[type=search]{width:min(250px,100%)}
  .catalog-table td:first-child,.catalog-table th:first-child{width:46px;text-align:center}
  .catalog-table input[type=checkbox]{width:16px;min-height:auto;height:16px;accent-color:var(--orange)}
  .catalog-row{cursor:pointer}.catalog-row.selected{background:#fff8f5}
  .catalog-row.unsupported{opacity:.66}.catalog-row.unsupported:hover{opacity:.85}
  .object-name{display:block;color:var(--text);font-weight:600}.api-name{display:block;color:var(--muted);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
  .readiness{display:flex;align-items:center;gap:7px}.mini-dot{width:7px;height:7px;border-radius:50%;background:var(--teal)}
  .mini-dot.warning{background:var(--amber)}.mini-dot.off{background:var(--muted)}
  .object-detail{border-top:1px solid #eaeff4;background:#fafcfd;padding:18px 20px}
  .detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
  .detail-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:7px}
  .metadata-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
  .metadata-item{background:#fff;border:1px solid var(--border);border-radius:8px;padding:12px}
  .metadata-item span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .metadata-item b{display:block;margin-top:4px;color:var(--text);font-size:14px}
  .readiness-panel{display:grid;grid-template-columns:minmax(210px,.7fr) minmax(0,1.3fr);gap:12px;margin-top:12px}
  .readiness-summary,.readiness-checks{background:#fff;border:1px solid var(--border);border-radius:9px;padding:14px}
  .readiness-summary b{display:block;font-size:15px}.readiness-summary p{margin:5px 0 0;color:var(--muted);font-size:12px}
  .readiness-progress{height:7px;border-radius:999px;background:#e5ebf0;overflow:hidden;margin-top:13px}
  .readiness-progress span{display:block;height:100%;background:var(--teal)}
  .readiness-checks{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .readiness-check{display:flex;align-items:flex-start;gap:8px;color:var(--text-2);font-size:12px}
  .readiness-check .mini-dot{margin-top:5px;flex:none}.readiness-check b{display:block;color:var(--text);font-size:12px}
  .schema-disclosure{margin-top:12px;border:1px solid var(--border);border-radius:9px;background:#fff;overflow:hidden}
  .schema-disclosure summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;color:var(--text-2);font-size:12px;font-weight:600}
  .schema-disclosure summary::-webkit-details-marker{display:none}.schema-disclosure summary::after{content:"View";color:var(--blue)}
  .schema-disclosure[open] summary{border-bottom:1px solid var(--border)}.schema-disclosure[open] summary::after{content:"Hide"}
  .schema-drawer-section{padding:14px}.schema-drawer-section+.schema-drawer-section{border-top:1px solid var(--border)}
  .schema-drawer-section h3{margin:0 0 10px;font-size:13px}

  .field-progress{min-width:180px;padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:#fafcfd}
  .field-progress b,.field-progress span{display:block}.field-progress b{font-size:13px}.field-progress span{margin-top:3px;color:var(--muted);font-size:11px}
  .field-workspace-shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:560px}
  .mapping-object-sidebar{border-right:1px solid var(--border);background:#f7f9fb;min-width:0}
  .mapping-queue-tools{padding:12px;border-bottom:1px solid var(--border)}
  .mapping-queue-tools input,.mapping-queue-tools select{width:100%;min-height:36px}.mapping-queue-tools select{margin-top:8px}
  .mapping-object-queue{display:flex;flex-direction:column;padding:7px}
  .mapping-object-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;padding:11px 10px;border:0;border-radius:8px;background:transparent;color:var(--text-2);text-align:left}
  .mapping-object-item:hover{background:#fff}.mapping-object-item.active{background:#fff;color:var(--text);box-shadow:0 1px 3px rgba(46,63,80,.13)}
  .mapping-object-item b,.mapping-object-item small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mapping-object-item b{font-size:12px}.mapping-object-item small{margin-top:3px;color:var(--muted);font-size:10px}
  .mapping-object-status{display:flex;align-items:center;gap:6px;font-size:10px;white-space:nowrap}
  .mapping-object-status .mini-dot{flex:none}.mapping-object-empty{padding:18px 10px;color:var(--muted);font-size:11px;text-align:center}
  .field-workspace-main{min-width:0}.field-current-head{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--border)}
  .field-current-head>div{margin-right:auto}.field-current-head span,.field-current-head b{display:block}.field-current-head span{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}.field-current-head b{margin-top:2px;font-size:14px}
  #field-object{display:none}.object-position{color:var(--muted);font-size:11px;white-space:nowrap}
  .mapping-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid #eaeff4;background:#fafcfd}
  .mapping-tools input{width:min(270px,100%)}.mapping-tools .mapping-spacer{margin-left:auto}
  .field-layout{min-width:0}
  .coverage-card{display:grid;grid-template-columns:minmax(180px,.45fr) minmax(0,1.55fr);gap:20px;
    align-items:center;padding:14px 20px;border-bottom:1px solid #eaeff4;background:#fafcfd}
  .coverage-overview{display:flex;flex-direction:column;gap:4px}
  .coverage-card .summary-title{margin:0}
  .coverage-number{font-size:30px;font-weight:600;letter-spacing:-.03em}
  .coverage-list{display:grid;grid-template-columns:repeat(5,minmax(74px,1fr));gap:0;color:var(--text-2);font-size:12px}
  .coverage-list div{display:flex;flex-direction:column;gap:3px;padding:2px 14px;border-left:1px solid var(--border)}
  .coverage-list b{color:var(--text);font-size:18px;line-height:1.2}
  .mapping-table input,.mapping-table select{min-width:124px}
  .mapping-table tr[hidden]{display:none}.mapping-table .mapping-action{width:82px;min-width:82px;position:sticky;left:0;background:#fff;z-index:1}
  .mapping-table th.mapping-action{background:#fafcfd;z-index:2}
  .mapping-remove{padding:7px 9px;background:#fff;border-color:#e5bcb3;color:var(--red)}
  .mapping-remove:hover{background:#fdf1ee;border-color:var(--red);color:var(--red)}
  .mapping-transform{min-width:116px;padding:8px 10px;background:#fff;border-color:#b9cad9;color:var(--text-2);text-align:left}
  .mapping-transform:hover{background:#f5f9fc;border-color:var(--blue);color:var(--blue)}
  .mapping-transform small{display:block;color:var(--muted);font-size:9px;margin-top:2px}
  .mapping-change-notice{display:flex;align-items:center;gap:10px;padding:10px 20px;background:#fff8f5;
    border-bottom:1px solid #f3d5cc;color:#8d4935;font-size:12px}
  .mapping-change-notice[hidden]{display:none}.mapping-change-notice button{margin-left:auto;padding:7px 10px}
  .transform-lab{border-bottom:1px solid #cbd9e5;background:#f5f9fc}
  .transform-lab[hidden]{display:none}
  .transform-lab-head{display:flex;align-items:flex-start;gap:14px;padding:17px 20px;border-bottom:1px solid #dce7ef}
  .transform-lab-head>div{margin-right:auto}.transform-lab-head h3{margin:2px 0 4px;font-size:16px}
  .transform-lab-head p{margin:0;color:var(--text-2);font-size:12px}.transform-lab-head button{padding:7px 10px}
  .transform-paths{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;padding:16px 20px}
  .transform-path{padding:14px;background:#fff;border:1px solid var(--border);border-radius:9px}
  .transform-path-title{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:12px;font-weight:700}
  .transform-path-title span{color:var(--orange)}
  .transform-controls{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:end}
  .transform-controls label{margin:0}.transform-controls .path-arrow{padding-bottom:12px;color:var(--muted)}
  .transform-preview{display:grid;grid-template-columns:minmax(180px,.8fr) minmax(0,1.2fr);gap:12px;padding:0 20px 16px}
  .transform-preview-card{padding:13px 14px;border:1px solid #d7e4ee;border-radius:9px;background:#fff}
  .transform-preview-card span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em}
  .transform-preview-card code{display:block;margin-top:5px;color:var(--text);font-size:12px;overflow-wrap:anywhere}
  .transform-lab-actions{display:flex;align-items:center;gap:10px;padding:13px 20px;border-top:1px solid #dce7ef}
  .transform-lab-actions .muted{margin-right:auto}

  .natural-key-grid{display:grid;grid-template-columns:1fr;gap:16px}
  .value-object-nav{display:flex;align-items:stretch;gap:8px;padding:12px 20px;border-bottom:1px solid #eaeff4;background:#fafcfd;overflow-x:auto}
  .value-object-tab{display:flex;flex:0 0 auto;align-items:center;gap:10px;min-width:180px;padding:11px 13px;border:1px solid var(--border);border-radius:9px;background:#fff;color:var(--text-2);text-align:left}
  .value-object-tab:hover{border-color:#b9cad9;background:#f7fafc}.value-object-tab.active{border-color:var(--orange);background:#fff8f5;color:var(--text);box-shadow:inset 0 -2px 0 var(--orange)}
  .value-object-tab-index{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:50%;background:#eef2f6;color:var(--muted);font-size:10px;font-weight:700}
  .value-object-tab.active .value-object-tab-index{background:var(--orange);color:#fff}
  .value-object-tab b,.value-object-tab small{display:block;white-space:nowrap}.value-object-tab b{font-size:12px}.value-object-tab small{margin-top:2px;color:var(--muted);font-size:10px}
  #value-object{display:none}
  .subcard{border:1px solid var(--border);border-radius:10px;padding:18px;background:#fafcfd}
  .subcard h3{margin:0 0 6px;font-size:14px}.subcard p{margin:0 0 14px;color:var(--muted);font-size:13px}
  .identity-card{background:#fff}.identity-options{display:grid;gap:9px}
  .identity-option{display:flex;align-items:flex-start;gap:10px;padding:13px;border:1px solid var(--border);border-radius:9px;background:#fafcfd;cursor:pointer}
  .identity-option:has(input:checked){border-color:#ef8b72;background:#fff8f5}.identity-option input{width:16px;height:16px;min-height:auto;margin-top:2px;accent-color:var(--orange)}
  .identity-option span{display:block;min-width:0}.identity-option b{display:flex;align-items:center;gap:7px;font-size:13px}.identity-option small{display:block;margin-top:4px;color:var(--muted);font-size:11px;line-height:1.45}
  .recommended-badge{padding:2px 6px;border-radius:999px;background:#e8f7f4;color:var(--teal-dark);font-size:9px;font-weight:700;text-transform:uppercase}
  .advanced-key{margin-top:10px;border:1px solid var(--border);border-radius:9px;background:#fafcfd}
  .advanced-key summary{cursor:pointer;padding:12px 13px;color:var(--text-2);font-size:12px;font-weight:700}
  .advanced-key-body{padding:0 13px 13px}.advanced-key-body>p{margin:0 0 10px;font-size:11px}
  .advanced-key-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
  .advanced-key-field{display:flex;align-items:center;gap:7px;padding:8px 9px;border:1px solid var(--border);border-radius:7px;background:#fff;font-size:11px}
  .advanced-key-field input{width:14px;height:14px;min-height:auto;accent-color:var(--orange)}
  .identity-warning{margin-top:11px;padding:10px 12px;border-left:3px solid var(--amber);border-radius:5px;background:#fff8e7;color:#76581a;font-size:11px;line-height:1.45}
  .identity-warning.safe{border-color:var(--teal);background:#eef9f7;color:#24645b}.identity-actions{display:flex;align-items:center;gap:10px;margin-top:13px}.identity-actions span{margin-right:auto;color:var(--muted);font-size:11px}
  .preflight-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:18px 20px}
  .check-stat{border:1px solid var(--border);border-radius:9px;padding:14px;background:#fafcfd}
  .check-stat b{display:block;font-size:24px}.check-stat span{color:var(--muted);font-size:12px}
  .issue-list{border-top:1px solid #eaeff4}
  .issue-row{display:grid;grid-template-columns:90px minmax(180px,220px) minmax(0,1fr);gap:18px;align-items:start;padding:15px 20px;border-bottom:1px solid #f0f3f7}
  .issue-row:last-child{border-bottom:0}.issue-row>.pill{width:100%;justify-content:center;margin-top:1px}
  .issue-row.actionable{cursor:pointer}.issue-row.actionable:hover{background:#fafcfd}
  .issue-context,.issue-message{min-width:0}.issue-object{display:block;color:var(--text);font-size:13px;line-height:1.35;text-transform:capitalize}
  .issue-field{display:inline-block;margin-top:4px;padding:2px 7px;border-radius:5px;background:#fff2ec;color:var(--orange-dark);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
  #field-map-rows tr.highlight-row{background:#fff2ec;transition:background 2s ease}
  .issue-code{display:block;margin-top:4px;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere;word-break:break-word}
  .issue-message{color:var(--text);font-size:13px;line-height:1.5;overflow-wrap:anywhere}
  .preflight-blocked{margin:18px 20px;padding:18px;border:1px solid #f3d5cc;border-radius:9px;background:#fff8f5}
  .preflight-blocked b{display:block;color:var(--red);font-size:14px}.preflight-blocked p{margin:6px 0 14px;color:var(--text-2);font-size:13px}
  .preflight-blocked .button{display:inline-flex}
  .copilot-panel{margin:0 20px 18px;border:1px solid #d8e3ef;border-radius:10px;background:#f8fbff;overflow:hidden}
  .copilot-panel[hidden]{display:none}
  .copilot-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:17px 18px;border-bottom:1px solid #e4edf5}
  .copilot-kicker{color:var(--blue);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .copilot-head h3{margin:3px 0 5px;font-size:16px}.copilot-head p{margin:0;color:var(--text-2);font-size:13px;line-height:1.5}
  .copilot-privacy{display:flex;gap:14px;flex-wrap:wrap;padding:10px 18px;background:#fff;color:var(--muted);font-size:11px}
  .copilot-privacy span::before{content:"✓";color:var(--teal-dark);font-weight:700;margin-right:5px}
  .copilot-findings{display:flex;flex-direction:column}.copilot-finding{padding:16px 18px;border-top:1px solid #e4edf5}
  .copilot-finding:first-child{border-top:0}.copilot-finding-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:7px}
  .copilot-finding-head b{margin-right:auto}.copilot-confidence{color:var(--muted);font-size:11px}
  .copilot-finding p{margin:0;color:var(--text-2);font-size:13px;line-height:1.55}
  .copilot-action{margin-top:10px;padding:10px 12px;background:#fff;border-left:3px solid var(--blue);border-radius:5px;color:var(--text);font-size:12px}
  .copilot-finding button{margin-top:10px;padding:7px 10px}.copilot-next{padding:16px 18px;border-top:1px solid #e4edf5;background:#fff}
  .copilot-next b{display:block;font-size:12px;margin-bottom:6px}.copilot-next ol{margin:0;padding-left:18px;color:var(--text-2);font-size:12px}
  .copilot-note{padding:10px 18px;color:var(--muted);font-size:11px;border-top:1px solid #e4edf5}
  .preview-actions{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;padding:16px 20px;border-bottom:1px solid #eaeff4}
  .preview-action{padding:12px;border:1px solid var(--border);border-radius:9px;background:#fafcfd}
  .preview-action b{display:block;font-size:21px}.preview-action span{font-size:11px;color:var(--muted);text-transform:capitalize}
  .execution-safety{display:flex;align-items:flex-start;gap:10px;padding:14px 20px;background:var(--nav);color:#fff}
  .execution-safety p{margin:0;color:#c5d0da;font-size:12px;line-height:1.5}.execution-safety b{white-space:nowrap}
  .test-record-controls{display:grid;grid-template-columns:minmax(160px,.55fr) minmax(260px,1.45fr);gap:12px;padding:18px 20px;border-bottom:1px solid #eaeff4;background:#fafcfd}
  .test-record-preview{padding:18px 20px;border-bottom:1px solid #eaeff4}
  .test-record-preview[hidden],.test-record-result[hidden],.full-migration[hidden]{display:none}
  .test-record-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}.test-record-head b{margin-right:auto}
  .test-record-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  .test-field{padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:#fafcfd;min-width:0}
  .test-field span,.test-field b{display:block}.test-field span{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  .test-field b{margin-top:4px;font-size:12px;overflow-wrap:anywhere}
  .test-record-result{display:flex;align-items:flex-start;gap:12px;padding:16px 20px;background:#eef9f7;border-bottom:1px solid #ccebe6}
  .test-record-result .result-icon{display:grid;place-items:center;width:28px;height:28px;flex:none;border-radius:50%;background:var(--teal);color:#fff;font-weight:700}
  .test-record-result b,.test-record-result span{display:block}.test-record-result span{margin-top:3px;color:var(--text-2);font-size:12px}
  .full-migration{border-top:8px solid var(--canvas)}.full-migration-head{display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-bottom:1px solid #eaeff4}
  .full-migration-head>div{margin-right:auto}.full-migration-head h3{margin:0;font-size:16px}.full-migration-head p{margin:4px 0 0;color:var(--muted);font-size:12px}
  .typed-confirmation[hidden]{display:none}.typed-confirmation{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(18,36,52,.56)}
  .typed-confirmation-card{width:min(440px,100%);padding:22px;border:1px solid var(--border);border-radius:12px;background:#fff;box-shadow:0 24px 70px rgba(18,36,52,.25)}
  .typed-confirmation-card h2{margin:0;font-size:19px}.typed-confirmation-card p{margin:8px 0 18px;color:var(--text-2);font-size:13px;line-height:1.55}
  .typed-confirmation-card label{display:block;color:var(--text);font-size:12px;font-weight:700}.typed-confirmation-card label code{color:var(--red)}
  .typed-confirmation-card input{width:100%;margin-top:7px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
  .typed-confirmation-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
  @media(max-width:1050px){
    .builder-shell{grid-template-columns:1fr}.workspace-steps{position:static;flex-direction:row;overflow-x:auto}
    .workspace-step{min-width:155px}.coverage-card{grid-template-columns:minmax(210px,.55fr) minmax(0,1.45fr)}
    .field-workspace-shell{grid-template-columns:190px minmax(0,1fr)}
  }
  @media(max-width:760px){
    .builder-header{align-items:flex-start;flex-wrap:wrap}.builder-header-actions{width:100%}.builder-summary{margin-left:auto}
    .summary-rows{grid-template-columns:repeat(2,minmax(0,1fr))}
    .plan-bar{grid-template-columns:1fr}.scope-options,.direction-preview,.natural-key-grid,.transform-paths,.transform-preview,.readiness-panel{grid-template-columns:1fr}
    .direction-preview{display:flex;align-items:stretch}.direction-system{flex:1}.direction-arrow{align-self:center}
    .coverage-card{grid-template-columns:1fr;gap:14px}.coverage-list{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 0}
    .coverage-list div:nth-child(3n+1){border-left:0;padding-left:0}
    .metadata-grid,.readiness-checks,.test-record-fields{grid-template-columns:repeat(2,1fr)}.preview-actions{grid-template-columns:repeat(3,1fr)}
    .test-record-controls{grid-template-columns:1fr}.field-workspace-shell{grid-template-columns:1fr}.mapping-object-sidebar{border-right:0;border-bottom:1px solid var(--border)}
    .mapping-object-queue{display:grid;grid-template-columns:repeat(3,minmax(140px,1fr));overflow-x:auto}.mapping-queue-tools{display:grid;grid-template-columns:1fr 160px;gap:8px}.mapping-queue-tools select{margin-top:0}
    .plan-library{grid-template-columns:1fr}.history-toolbar{grid-template-columns:1fr 1fr}.history-toolbar input{grid-column:1/-1}
    .issue-row{grid-template-columns:80px minmax(0,1fr);gap:12px}.issue-message{grid-column:1/-1;padding-top:2px}
    .step-footer{flex-wrap:wrap}.step-footer-note{width:100%}
  }
  @media(max-width:520px){
    .summary-rows,.scope-options,.readiness-checks{grid-template-columns:1fr}.summary-actions{flex-direction:column}
    .coverage-list{grid-template-columns:repeat(2,minmax(0,1fr))}
    .coverage-list div:nth-child(3n+1){border-left:1px solid var(--border);padding-left:14px}
    .coverage-list div:nth-child(odd){border-left:0;padding-left:0}
    .mapping-tools>*{width:100%}.advanced-key-fields{grid-template-columns:1fr}.mapping-object-queue{grid-template-columns:1fr 1fr}
    .history-toolbar{grid-template-columns:1fr}.history-toolbar input{grid-column:auto}
  }
`;

function step(
  key: string,
  number: number,
  title: string,
  description: string,
  active = false,
): string {
  return `<button class="workspace-step${active ? ' active' : ''}" data-step="${key}">
    <span class="step-number">${number}</span>
    <span class="step-copy"><b>${title}</b><small>${description}</small></span>
    <span class="step-indicator" aria-hidden="true"></span>
  </button>`;
}

function footer(
  note: string,
  previous?: { step: string; label: string },
  next?: { step: string; label: string; save?: boolean },
): string {
  return `<div class="step-footer"><span class="step-footer-note">${note}</span>
    ${previous ? `<button class="secondary" data-go-step="${previous.step}">← ${previous.label}</button>` : '<button class="secondary" disabled>← Back</button>'}
    ${next ? `<button class="next-step" data-go-step="${next.step}"${next.save ? ' data-save-before="true"' : ''}>${next.label} →</button>` : ''}
  </div>`;
}

export function migrationWorkspaceHtml(): string {
  return `
    <section class="view active" id="view-migration">
      <div class="migration-workspace">
        <nav class="migrate-tabs" aria-label="Migration sections">
          <button class="migrate-tab active" data-migrate-tab="builder" aria-current="page">Builder</button>
          <button class="migrate-tab" data-migrate-tab="plans">Saved plans <span class="migrate-tab-count" id="saved-plan-count">0</span></button>
          <button class="migrate-tab" data-migrate-tab="runs">Run history <span class="migrate-tab-count" id="run-count">0</span></button>
        </nav>

        <div class="migrate-section active" id="migrate-builder">
        <header class="card builder-header">
          <div class="builder-heading">
            <div class="builder-kicker">Guided migration</div>
            <h2>Salesforce ⇄ HubSpot migration builder</h2>
            <div class="draft-state" id="draft-state"><span id="autosave-status">New draft · changes save automatically</span></div>
          </div>
          <div class="builder-header-actions">
            <button class="secondary" data-migrate-open="plans">Open plans</button>
            <button class="secondary" id="latest-run-shortcut" data-migrate-open="runs">View run history</button>
          </div>
          <details class="builder-summary">
            <summary>Plan summary</summary>
            <div class="builder-summary-panel">
              <div class="summary-title">Current draft</div>
              <div class="summary-rows">
                <div class="summary-row"><span>Plan</span><b id="summary-plan">Unsaved draft</b></div>
                <div class="summary-row"><span>Direction</span><b id="summary-direction">Salesforce → HubSpot</b></div>
                <div class="summary-row"><span>Objects</span><b id="summary-objects">3 selected</b></div>
                <div class="summary-row"><span>Field coverage</span><b id="summary-coverage">—</b></div>
                <div class="summary-row"><span>Preflight</span><b id="summary-preflight">Not run</b></div>
                <div class="summary-row"><span>Test record</span><b id="summary-preview">Required</b></div>
              </div>
              <div class="summary-actions"><button id="side-preflight" class="secondary">Run preflight</button><button id="side-preview">Test one record</button></div>
            </div>
          </details>
        </header>

        <div class="builder-shell">
          <nav class="workspace-steps" aria-label="Migration workflow">
            ${step('scope', 1, 'Direction', 'Name and migration scope', true)}
            ${step('objects', 2, 'Objects', 'Choose what moves')}
            ${step('fields', 3, 'Fields', 'Map and transform')}
            ${step('values', 4, 'Values', 'Keys and picklists')}
            ${step('validate', 5, 'Resolve issues', 'Preflight and Copilot')}
            ${step('preview', 6, 'Test & run', 'Verify one real record')}
          </nav>

          <div class="builder-stage">
            <section class="workspace-panel active" id="workspace-scope">
              <div class="card step-card">
                <div class="step-intro"><div class="step-eyebrow">Step 1 of 6</div><h2>Set the direction and scope</h2><p>Name this migration, choose which CRM is the source, and set the maximum size of the eventual full migration.</p></div>
                <div class="plan-bar">
                  <div><label>Migration plan</label><input id="plan-name" value="Salesforce to HubSpot migration"></div>
                  <div><label>Direction</label><select id="mig-from"><option value="salesforce">Salesforce → HubSpot</option><option value="hubspot">HubSpot → Salesforce</option></select></div>
                  <div><label>Migration limit / object</label><input id="mig-limit" type="number" min="1" max="100000" value="20"></div>
                  <div class="direction-preview"><div class="direction-system"><span>Read from</span><b id="direction-source-name">Salesforce</b></div><div class="direction-arrow">→</div><div class="direction-system"><span>Write to</span><b id="direction-target-name">HubSpot</b></div></div>
                  <div class="scope-options">
                    <div class="scope-option"><span><b>Test one record first</b><small>A verified one-record migration is required before the full migration is prepared.</small></span></div>
                  </div>
                </div>
                <div class="step-footer"><span class="step-footer-note">Draft configuration is autosaved.</span><button id="save-plan" class="secondary">Save now</button><button class="secondary" disabled>← Back</button><button class="next-step" data-go-step="objects" data-save-before="true">Choose objects →</button></div>
              </div>
            </section>

            <section class="workspace-panel" id="workspace-objects">
              <div class="card step-card">
                <div class="step-intro"><div class="step-intro-row"><div><div class="step-eyebrow">Step 2 of 6</div><h2>Choose the objects to migrate</h2><p>Select supported source objects, then inspect their fields before continuing.</p></div><span class="pill" id="object-selection-count">3 selected</span></div></div>
                <div class="panel-toolbar">
                  <input id="catalog-search" type="search" placeholder="Search objects or API names">
                  <select id="catalog-filter"><option value="supported" selected>Supported</option><option value="selected">Selected</option><option value="all">All objects</option><option value="unsupported">Not supported yet</option></select>
                </div>
                <div class="scroll"><table class="catalog-table"><thead><tr><th>Use</th><th>Source object</th><th>Target binding</th><th>Type</th><th>Fields</th><th>Readiness</th></tr></thead><tbody id="object-rows"><tr><td colspan="6" class="empty">Discovering CRM objects…</td></tr></tbody></table></div>
                <div class="object-detail" id="object-detail"><div class="empty">Select an object to inspect its metadata.</div></div>
                ${footer('Only selected objects are included in validation and preview.', { step: 'scope', label: 'Direction' }, { step: 'fields', label: 'Map fields', save: true })}
              </div>
            </section>

            <section class="workspace-panel" id="workspace-fields">
              <div class="card step-card">
                <div class="step-intro"><div class="step-intro-row"><div><div class="step-eyebrow">Step 3 of 6</div><h2>Map and transform fields</h2><p>Work through every selected object. Your object queue shows what is complete, what needs review, and what has not been started.</p></div><div class="field-progress"><b id="field-progress-count">0 of 0 objects complete</b><span id="field-progress-detail">Choose an object to begin.</span></div></div></div>
                <div class="field-workspace-shell">
                  <aside class="mapping-object-sidebar" aria-label="Selected objects">
                    <div class="mapping-queue-tools"><input id="field-object-search" type="search" placeholder="Find an object"><select id="field-object-filter"><option value="all">All selected</option><option value="review">Needs mapping</option><option value="complete">Complete</option></select></div>
                    <div class="mapping-object-queue" id="field-object-queue"></div>
                  </aside>
                  <div class="field-workspace-main">
                    <div class="field-current-head"><div><span>Current object</span><b id="field-current-name">Choose an object</b></div><span id="field-object-position" class="object-position"></span><select id="field-object" aria-hidden="true"></select></div>
                    <div class="mapping-tools">
                      <input id="field-search" type="search" placeholder="Search source, canonical, or target">
                      <select id="field-filter"><option value="all">All mappings</option><option value="review">Needs review</option><option value="transformed">Has transforms</option></select>
                      <span class="mapping-spacer"></span>
                      <button id="auto-map-all" class="secondary">Auto-map selected objects</button>
                      <button id="auto-map" class="secondary">Auto-map this object</button>
                      <button id="save-field-map">Save mappings</button>
                    </div>
                    <div class="mapping-change-notice" id="field-map-notice" hidden><span id="field-map-notice-text"></span><button id="undo-field-removal" class="secondary">Undo last removal</button></div>
                    <aside class="coverage-card" aria-label="Mapping coverage">
                      <div class="coverage-overview"><div class="summary-title">Core mapping coverage</div><div class="coverage-number" id="coverage-number">—</div></div>
                      <div class="coverage-list" id="coverage-list"></div>
                    </aside>
                    <section class="transform-lab" id="transform-lab" aria-live="polite" hidden>
                      <div class="transform-lab-head"><div><div class="step-eyebrow">Transform lab</div><h3 id="transform-field-name">Field transform</h3><p id="transform-field-path">Configure normalization for this migration.</p></div><button id="close-transform-lab" class="secondary" aria-label="Close transform lab">Close</button></div>
                      <div class="transform-paths">
                        <div class="transform-path"><div class="transform-path-title"><span>Migration path</span> Source → Canonical → Target</div><div class="transform-controls"><label>Normalize source value<select id="transform-source-to"></select></label><span class="path-arrow">→</span><label>Format destination value<select id="transform-target-from"></select></label></div></div>
                      </div>
                      <div class="transform-preview">
                        <label>Test with a sample value<input id="transform-sample" placeholder="e.g. https://www.Example.com/path"></label>
                        <div class="transform-preview-card"><span>Migration result</span><code id="transform-forward-result">Enter a sample value</code></div>
                      </div>
                      <div class="transform-lab-actions"><span class="muted" id="transform-help">Transforms run before migration validation and value mapping.</span><button id="reset-transforms" class="secondary">Use identity</button><button id="apply-transforms">Apply transforms</button></div>
                    </section>
                    <div class="field-layout"><div class="scroll"><table class="mapping-table"><thead><tr><th class="mapping-action">Action</th><th>Source field</th><th>Canonical field</th><th>Transform</th><th>Target field</th></tr></thead><tbody id="field-map-rows"><tr><td colspan="5" class="empty">Choose an object to load its mappings.</td></tr></tbody></table></div></div>
                  </div>
                </div>
                <div class="step-footer"><span class="step-footer-note">Changes are saved when you switch objects.</span><button class="secondary" data-go-step="objects">← Objects</button><button id="save-next-field-object" class="secondary">Save & next object →</button><button class="next-step" data-go-step="values">Values & keys →</button></div>
              </div>
            </section>

            <section class="workspace-panel" id="workspace-values">
              <div class="card step-card">
                <div class="step-intro"><div class="step-intro-row"><div><div class="step-eyebrow">Step 4 of 6</div><h2>Match identities and values</h2><p>Choose stable natural keys and translate picklist or pipeline values.</p></div></div></div>
                <nav class="value-object-nav" id="value-object-tabs" role="tablist" aria-label="Selected migration objects"></nav>
                <select id="value-object" aria-hidden="true" tabindex="-1"></select>
                <div class="card-body natural-key-grid">
                  <section class="subcard identity-card"><h3>How should existing records be matched?</h3><p>Choose a stable identity shared by both CRMs. A match updates the existing record; no match creates a new one.</p><div class="identity-options" id="natural-key-options"></div><details class="advanced-key" id="natural-key-advanced"><summary>Advanced: build a composite key</summary><div class="advanced-key-body"><p>Only fields mapped in both CRMs are available. Avoid values that can change over time.</p><label class="identity-option"><input type="radio" name="natural-key-mode" value="advanced"><span><b>Custom composite key</b><small>Require every selected field to match the same destination record.</small></span></label><div class="advanced-key-fields" id="natural-key-fields"></div></div></details><div class="identity-warning" id="natural-key-warning"></div><div class="identity-actions"><span id="natural-key-summary"></span><button id="save-natural-key">Save matching rule</button></div></section>
                  <section class="subcard" style="grid-column:1/-1"><h3>Picklist and pipeline values</h3><p id="value-map-help">Select an enum field to review source and target values.</p><div class="toolbar"><select id="value-field"></select><button id="load-values" class="secondary">Load values</button><button id="save-values">Save values</button></div><div class="scroll"><table><thead><tr><th>Canonical value</th><th>Salesforce value</th><th>HubSpot value</th></tr></thead><tbody id="value-map-rows"><tr><td colspan="3" class="empty">No value field selected.</td></tr></tbody></table></div></section>
                </div>
                ${footer('Picklist warnings can be reviewed in the next step.', { step: 'fields', label: 'Fields' }, { step: 'validate', label: 'Resolve issues', save: true })}
              </div>
            </section>

            <section class="workspace-panel" id="workspace-validate">
              <div class="card step-card">
                <div class="step-intro"><div class="step-intro-row"><div><div class="step-eyebrow">Step 5 of 6</div><h2>Resolve migration blockers</h2><p>Preflight checks live CRM schemas, mapping compatibility, and values. Copilot explains results but never changes mappings automatically.</p></div><button id="ask-copilot" class="secondary" disabled>Ask Copilot</button><button id="run-preflight">Run preflight</button></div></div>
                <div class="preflight-summary" id="preflight-summary"><div class="check-stat"><b>—</b><span>Errors</span></div><div class="check-stat"><b>—</b><span>Warnings</span></div><div class="check-stat"><b>—</b><span>Fields checked</span></div></div>
                <section class="copilot-panel" id="copilot-panel" aria-live="polite" hidden></section>
                <div class="issue-list" id="preflight-issues"><div class="empty">Run preflight after reviewing object and field mappings.</div></div>
                ${footer('A passing preflight is required before testing a real record.', { step: 'values', label: 'Values' }, { step: 'preview', label: 'Test one record' })}
              </div>
            </section>

            <section class="workspace-panel" id="workspace-preview">
              <div class="card step-card">
                <div class="step-intro"><div class="step-intro-row"><div><div class="step-eyebrow">Step 6 of 6</div><h2>Test one real record</h2><p>Choose a representative source record, review exactly what will happen, then run and verify that single destination write.</p></div><span id="mig-status" class="muted"></span></div></div>
                <div class="execution-safety"><b>One-record safety</b><p>The plan, schemas, mappings, and selected source record are rechecked immediately before the write.</p></div>
                <div class="test-record-controls">
                  <label>Object<select id="test-record-type"></select></label>
                  <label>Source record<select id="test-record-source" disabled><option>Choose an object first</option></select></label>
                </div>
                <section class="test-record-preview" id="test-record-preview" hidden>
                  <div class="test-record-head"><b>Proposed destination action</b><span class="pill" id="test-record-action">—</span><button id="execute-canary" class="danger" disabled>Test 1 record</button></div>
                  <div class="test-record-fields" id="test-record-fields"></div>
                </section>
                <div class="test-record-result" id="test-record-result" hidden><span class="result-icon">✓</span><div><b id="test-result-title">Test passed</b><span id="test-result-detail"></span></div></div>
                <section class="full-migration" id="full-migration" hidden>
                  <div class="full-migration-head"><div><h3>Full migration</h3><p>Now that the test passed, prepare and review the complete set of proposed actions.</p></div><button id="preview">Prepare full migration</button></div>
                  <div class="preview-actions" id="preview-actions"></div>
                  <div class="scroll"><table><thead><tr><th>Action</th><th>Object</th><th>Natural key</th><th>Target</th><th>Changes / warnings</th></tr></thead><tbody id="plans"><tr><td colspan="5" class="empty">Prepare the full migration after the one-record test passes.</td></tr></tbody></table></div>
                  <div class="step-footer"><span class="step-footer-note">The full migration always requires typed confirmation.</span><button id="execute" class="danger" disabled>Run full migration</button></div>
                </section>
                <div class="step-footer"><span class="step-footer-note">Testing writes exactly one CRM record after typed confirmation.</span><button class="secondary" data-go-step="validate">← Resolve issues</button></div>
              </div>
            </section>
          </div>
        </div>
        </div>

        <section class="migrate-section" id="migrate-plans">
          <div class="card">
            <div class="library-head"><div><h2>Saved migration plans</h2><p>Resume drafts, continue a one-record test, or reopen a prepared full migration.</p></div><button class="secondary" data-migrate-open="builder">Return to builder</button></div>
            <div class="plan-library" id="saved-plans"><div class="empty">No saved plans yet.</div></div>
          </div>
        </section>

        <section class="migrate-section" id="migrate-runs">
          <div class="card">
            <div class="library-head"><div><h2>Migration run history</h2><p>Filter previews and executions, then open any run to inspect its reviewed records.</p></div><button class="secondary" data-migrate-open="builder">Return to builder</button></div>
            <div class="history-toolbar">
              <input id="run-search" type="search" placeholder="Search run ID or source">
              <select id="run-status-filter"><option value="">All statuses</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option></select>
              <select id="run-mode-filter"><option value="">All modes</option><option value="preview">Preview</option><option value="execute">Execute</option></select>
              <button class="secondary" id="refresh-runs">Refresh</button>
            </div>
            <div id="runs" class="scroll"></div>
          </div>
        </section>
        <section class="typed-confirmation" id="typed-confirmation" role="dialog" aria-modal="true" aria-labelledby="typed-confirm-title" hidden>
          <div class="typed-confirmation-card">
            <h2 id="typed-confirm-title">Confirm CRM write</h2>
            <p id="typed-confirm-message"></p>
            <label>Type <code id="typed-confirm-token"></code> to continue
              <input id="typed-confirm-input" type="text" autocomplete="off" spellcheck="false">
            </label>
            <div class="typed-confirmation-actions">
              <button class="secondary" id="typed-confirm-cancel">Cancel</button>
              <button class="danger" id="typed-confirm-submit" disabled>Confirm</button>
            </div>
          </div>
        </section>
      </div>
    </section>`;
}
