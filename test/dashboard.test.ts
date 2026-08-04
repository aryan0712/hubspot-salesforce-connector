import { describe, expect, it } from 'vitest';
import { operationsHtml } from '../src/dashboard/operations.js';
import { connectionsHtml } from '../src/dashboard/connections.js';
import { dashboardHeader } from '../src/dashboard/shell.js';

describe('operations dashboard', () => {
  it('renders the complete migration workspace', () => {
    const html = operationsHtml();
    for (const id of [
      'workspace-scope',
      'workspace-objects',
      'workspace-fields',
      'workspace-values',
      'workspace-validate',
      'workspace-preview',
      'saved-plans',
      'execute',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('renders a guided six-step builder with Back and Next navigation', () => {
    const html = operationsHtml();
    for (const step of ['scope', 'objects', 'fields', 'values', 'validate', 'preview']) {
      expect(html).toContain(`data-step="${step}"`);
    }
    expect(html).toContain('data-go-step="objects"');
    expect(html).toContain('data-go-step="fields"');
    expect(html).toContain('data-go-step="values"');
    expect(html).toContain('data-go-step="validate"');
    expect(html).toContain('data-go-step="preview"');
    expect(html).toContain('changes save automatically');
    expect(html).toContain('queuePlanAutosave');
    expect(html).toContain('A passing preflight is required');
  });

  it('ships syntactically valid inline JavaScript', () => {
    const html = operationsHtml();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('reloads prepared items when a saved full migration is opened', () => {
    const html = operationsHtml();
    expect(html).toContain("'/api/migrations/'+plan.previewRunId+'/items?limit=2000'");
    expect(html).toContain('prepared migration loaded');
  });

  it('requires a verified one-record test before the full migration', () => {
    const html = operationsHtml();
    for (const id of [
      'test-record-type',
      'test-record-source',
      'test-record-preview',
      'execute-canary',
      'test-record-result',
      'full-migration',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Test one real record');
    expect(html).toContain("'/test-records?type='");
    expect(html).toContain("'/test-record/preview'");
    expect(html).toContain("'/test-record/execute'");
    expect(html).toContain('id="typed-confirmation"');
    expect(html).toContain("token:'TEST'");
    expect(html).toContain("token:'EXECUTE'");
    expect(html).toContain('requestTypedConfirmation');
    expect(html).not.toContain("prompt('");
    expect(html).toContain('Pass the one-record test before preparing the full migration.');
    expect(html).not.toContain('Generate dry run');
    expect(html).not.toContain('Preview every proposed write');
  });

  it('keeps large object catalogs bounded by default', () => {
    const html = operationsHtml();
    expect(html).toContain('<option value="supported" selected>Supported</option>');
    expect(html).toContain('visible.slice(0,200)');
    expect(html).toContain('Refine the search to inspect more.');
  });

  it('keeps full schemas collapsed on the object-selection step', () => {
    const html = operationsHtml();
    expect(html).toContain('class="readiness-panel"');
    expect(html).toContain('class="readiness-checks"');
    expect(html).toContain('class="schema-disclosure"');
    expect(html).toContain("View source schema ('+meta.fields.length+' fields)");
    expect(html).toContain('Review mappings');
    expect(html).not.toContain('class="detail-tabs"');
    expect(html).not.toContain("show('fields')");
  });

  it('supports pending field-mapping removal and undo before save', () => {
    const html = operationsHtml();
    expect(html).toContain('class="mapping-action">Action');
    expect(html).toContain('data-remove-canonical=');
    expect(html).toContain('id="field-map-notice"');
    expect(html).toContain('id="undo-field-removal"');
    expect(html).toContain('marked for removal. Save mappings to apply.');
    expect(html).toContain("querySelectorAll('tr[data-canonical]')");
    expect(html).toContain('<span>Removed</span>');
  });

  it('keeps mapping coverage in a compact strip above the full-width table', () => {
    const html = operationsHtml();
    expect(html).toContain('class="coverage-card" aria-label="Mapping coverage"');
    expect(html).toContain('class="coverage-overview"');
    expect(html).toContain('Core mapping coverage');
    expect(html).toContain('.coverage-list{display:grid;grid-template-columns:repeat(5');
    expect(html).not.toContain('coverage-track');
    expect(html).not.toContain('coverage-bar');
    expect(html).not.toContain('aside class="card coverage-card"');
  });

  it('provides a multi-object field-mapping queue with progress and save-next navigation', () => {
    const html = operationsHtml();
    for (const id of [
      'field-object-queue',
      'field-object-search',
      'field-object-filter',
      'field-progress-count',
      'field-progress-detail',
      'field-current-name',
      'save-next-field-object',
      'auto-map-all',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('mappingObjectState');
    expect(html).toContain('renderFieldObjectQueue');
    expect(html).toContain('Changes are saved when you switch objects.');
    expect(html).toContain("token:'MAP ALL'");
    expect(html).toContain('Review automatic mappings');
    expect(html).toContain("['validate','preview'].includes(step)");
    expect(html).not.toContain('id="previous-field-object"');
    expect(html).not.toContain('id="next-field-object"');
  });

  it('offers safe identity presets and keeps composite natural keys advanced', () => {
    const html = operationsHtml();
    expect(html).toContain('How should existing records be matched?');
    expect(html).toContain('id="natural-key-options"');
    expect(html).toContain('id="natural-key-advanced"');
    expect(html).toContain('Advanced: build a composite key');
    expect(html).toContain('id="natural-key-warning"');
    expect(html).toContain('Company domain');
    expect(html).toContain('Email address');
    expect(html).toContain('Shared external ID');
    expect(html).toContain('blockedNaturalKeyField');
    expect(html).not.toContain('<select id="natural-key-fields" multiple>');
  });

  it('uses visible object tabs instead of a dropdown on the values step', () => {
    const html = operationsHtml();
    expect(html).toContain('id="value-object-tabs"');
    expect(html).toContain('class="value-object-tab');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('renderValueObjectTabs');
    expect(html).toContain('openValueObject');
    expect(html).toContain('<select id="value-object" aria-hidden="true" tabindex="-1"></select>');
    expect(html).toContain('valueLoadToken');
    expect(html).not.toContain('<div class="step-intro-row"><div><div class="step-eyebrow">Step 4 of 6</div><h2>Match identities and values</h2><p>Choose stable natural keys and translate picklist or pipeline values.</p></div><select id="value-object">');
  });

  it('keeps sync conflict choices out of the migration mapping table', () => {
    const html = operationsHtml();
    expect(html).not.toContain('If both change</th>');
    expect(html).not.toContain('Newest value wins');
    expect(html).not.toContain('Salesforce value wins');
    expect(html).not.toContain('HubSpot value wins');
    expect(html).not.toContain('class="owner"');
    expect(html).not.toContain('mapping-row-status');
  });

  it('keeps relationship configuration out of the migration journey', () => {
    const html = operationsHtml();
    expect(html).not.toContain('id="include-associations"');
    expect(html).not.toContain('id="relationship-list"');
    expect(html).not.toContain('Open relationships');
    expect(html).not.toContain('includeRelationships');
    expect(html).not.toContain('includeAssociations:');
    expect(html).not.toContain('<span>Relationships</span>');
    expect(html).not.toContain('<b>Associations</b>');
  });

  it('exposes migration-only field transforms with a live preview', () => {
    const html = operationsHtml();
    for (const id of [
      'transform-lab',
      'transform-source-to',
      'transform-target-from',
      'transform-sample',
      'transform-forward-result',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('Migration path');
    expect(html).toContain('Migration result');
    expect(html).not.toContain('Reverse sync');
    expect(html).not.toContain('id="transform-target-to"');
    expect(html).not.toContain('id="transform-source-from"');
    expect(html).not.toContain('transform-reverse-result');
    for (const transform of [
      'identity',
      'domain',
      'lowercase',
      'trim',
      'number',
      'boolean',
      'iso-date',
      'phone',
    ]) {
      expect(html).toContain(`'${transform}'`);
    }
    expect(html).toContain("toCanonical:tr.querySelector('.source-to').value");
    expect(html).toContain("fromCanonical:tr.querySelector('.source-from').value");
    expect(html).toContain("toCanonical:tr.querySelector('.target-to').value");
    expect(html).toContain("fromCanonical:tr.querySelector('.target-from').value");
  });

  it('separates the builder, saved plans, and run history', () => {
    const html = operationsHtml();
    expect(html).toContain('data-migrate-tab="builder"');
    expect(html).toContain('data-migrate-tab="plans"');
    expect(html).toContain('data-migrate-tab="runs"');
    expect(html).toContain('id="migrate-builder"');
    expect(html).toContain('id="migrate-plans"');
    expect(html).toContain('id="migrate-runs"');
    expect(html).not.toContain('class="card recent-runs"');
    expect(html).not.toContain('History is kept outside the setup journey.');
  });

  it('provides searchable run history with drill-in', () => {
    const html = operationsHtml();
    expect(html).toContain('id="run-search"');
    expect(html).toContain('id="run-status-filter"');
    expect(html).toContain('id="run-mode-filter"');
    expect(html).toContain('data-run-id=');
    expect(html).toContain("'/items?limit=200'");
    expect(html).toContain('renderMigrationRuns');
  });

  it('renders preflight issue details in separate responsive columns', () => {
    const html = operationsHtml();
    expect(html).toContain('class="issue-context"');
    expect(html).toContain('class="issue-object"');
    expect(html).toContain('class="issue-code"');
    expect(html).toContain('class="issue-message"');
    expect(html).toContain('overflow-wrap:anywhere');
  });

  it('shows an actionable connection recovery state during preflight', () => {
    const html = operationsHtml();
    expect(html).toContain("e.code==='connection_refresh_required'");
    expect(html).toContain('CRM connection needs attention');
    expect(html).toContain('Open Connections');
  });

  it('provides a read-only preflight copilot without an apply path', () => {
    const html = operationsHtml();
    expect(html).toContain('id="ask-copilot"');
    expect(html).toContain('id="copilot-panel"');
    expect(html).toContain('No record values shared');
    expect(html).toContain('No credentials shared');
    expect(html).toContain('No changes applied');
    expect(html).toContain("'/copilot/preflight'");
    expect(html).not.toContain('Apply Copilot');
  });

  it('provides write-only in-app Copilot credential management', () => {
    const html = operationsHtml();
    expect(html).toContain('id="ai-settings"');
    expect(html).toContain('id="openai-key"');
    expect(html).toContain("api('/api/ai/settings'");
    expect(html).toContain('Encrypted at rest');
    expect(html).toContain('Never shown again');
    expect(html).not.toContain('data.apiKey');
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('uses the five-area product navigation without duplicate destinations', () => {
    const html = dashboardHeader('connections');
    expect(html).toContain('href="/">Connections');
    expect(html).toContain('href="/ops#migration">Migrate');
    expect(html).toContain('href="/ops#sync">Sync');
    expect(html).toContain('href="/ops#activity">Activity');
    expect(html).toContain('href="/ops#settings">Settings');
    expect(html).not.toContain('Field mappings');
    expect(html).not.toContain('Sync jobs');
    expect(html).not.toContain('Audit &amp; usage');
  });

  it('keeps Connections focused on CRM authorization', () => {
    const html = connectionsHtml();
    expect(html).toContain('<h1>Connections</h1>');
    expect(html).toContain('id="card-salesforce"');
    expect(html).toContain('id="card-hubspot"');
    expect(html).not.toContain('id="runpanel"');
    expect(html).not.toContain('class="card side-card mapping-card"');
    expect(html).not.toContain('id="ai-settings"');
    expect(html).not.toContain('id="feed"');
  });

  it('gives live sync a dedicated operational home', () => {
    const html = operationsHtml();
    expect(html).toContain('id="view-sync"');
    expect(html).toContain('id="sync-conflict-strategy"');
    expect(html).toContain('id="sync-source-of-truth"');
    expect(html).toContain('id="sync-object-settings"');
    expect(html).toContain('id="webhook-health"');
    expect(html).toContain('id="conflicts"');
    expect(html).toContain("api('/api/sync/settings'");
  });

  it('combines sync jobs and audit entries under Activity', () => {
    const html = operationsHtml();
    expect(html).toContain('id="view-activity"');
    expect(html).toContain('data-activity-tab="jobs"');
    expect(html).toContain('data-activity-tab="audit"');
    expect(html).toContain('id="jobs"');
    expect(html).toContain('id="audit"');
    expect(html).not.toContain('id="view-jobs"');
    expect(html).not.toContain('id="view-audit"');
  });

  it('groups Copilot, access, team, usage, and plan under Settings', () => {
    const html = operationsHtml();
    expect(html).toContain('id="view-settings"');
    expect(html).toContain('id="ai-settings"');
    expect(html).toContain('id="api-keys"');
    expect(html).toContain('id="team"');
    expect(html).toContain('id="usage"');
    expect(html).toContain('id="plan-overview"');
  });
});
