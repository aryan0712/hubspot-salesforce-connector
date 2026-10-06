import { describe, expect, it } from 'vitest';
import {
  defaultSyncConfig,
  evaluateConditions,
  InMemorySyncConfigStore,
  isValidCronExpression,
  nextCronOccurrences,
  syncAllows,
  type SyncCondition,
} from '../src/core/syncConfig.js';

describe('sync configuration', () => {
  it('defaults every registered canonical object to bidirectional sync', () => {
    const config = defaultSyncConfig('last-write-wins', 'salesforce', ['contact', 'company', 'deal']);
    expect(syncAllows(config, 'contact', 'salesforce')).toBe(true);
    expect(syncAllows(config, 'contact', 'hubspot')).toBe(true);
    expect(config.objects.company.enabled).toBe(true);
    expect(config.objects.deal.direction).toBe('bidirectional');
  });

  it('treats an unregistered object as disallowed rather than throwing', () => {
    const config = defaultSyncConfig('last-write-wins', 'salesforce', ['contact']);
    expect(syncAllows(config, 'not_registered', 'salesforce')).toBe(false);
  });

  it('enforces object pauses and one-way directions', () => {
    const config = defaultSyncConfig('field-merge', 'hubspot', ['contact', 'company', 'deal']);
    config.objects.contact.enabled = false;
    config.objects.company.direction = 'salesforce_to_hubspot';
    config.objects.deal.direction = 'hubspot_to_salesforce';

    expect(syncAllows(config, 'contact', 'salesforce')).toBe(false);
    expect(syncAllows(config, 'company', 'salesforce')).toBe(true);
    expect(syncAllows(config, 'company', 'hubspot')).toBe(false);
    expect(syncAllows(config, 'deal', 'salesforce')).toBe(false);
    expect(syncAllows(config, 'deal', 'hubspot')).toBe(true);
  });

  it('returns isolated configuration snapshots', async () => {
    const initial = defaultSyncConfig('last-write-wins', 'salesforce', ['contact']);
    const store = new InMemorySyncConfigStore(initial);
    const snapshot = store.get();
    snapshot.objects.contact.enabled = false;
    expect(store.get().objects.contact.enabled).toBe(true);

    await store.update(snapshot);
    expect(store.get().objects.contact.enabled).toBe(false);
  });
});

describe('sync conditions', () => {
  it('matches when every AND-combined condition holds', () => {
    const conditions: SyncCondition[] = [
      { field: 'IsPersonAccount', operator: 'eq', value: false },
      { field: 'AnnualRevenue', operator: 'gt', value: 1000 },
    ];
    expect(evaluateConditions(conditions, { IsPersonAccount: false, AnnualRevenue: 5000 })).toBe(true);
    expect(evaluateConditions(conditions, { IsPersonAccount: true, AnnualRevenue: 5000 })).toBe(false);
    expect(evaluateConditions(conditions, { IsPersonAccount: false, AnnualRevenue: 100 })).toBe(false);
  });

  it('treats no conditions as an unconditional match', () => {
    expect(evaluateConditions(undefined, {})).toBe(true);
    expect(evaluateConditions([], { anything: 'value' })).toBe(true);
  });

  it('supports is_null / is_not_null against a missing or present field', () => {
    expect(evaluateConditions([{ field: 'Email', operator: 'is_null' }], {})).toBe(true);
    expect(evaluateConditions([{ field: 'Email', operator: 'is_null' }], { Email: 'a@b.com' })).toBe(false);
    expect(evaluateConditions([{ field: 'Email', operator: 'is_not_null' }], { Email: 'a@b.com' })).toBe(true);
  });
});

describe('cron scheduling', () => {
  it('accepts a standard 5-field cron expression and rejects garbage', () => {
    expect(isValidCronExpression('*/2 * * * *')).toBe(true);
    expect(isValidCronExpression('0 9 * * 1')).toBe(true);
    expect(isValidCronExpression('not a cron expression')).toBe(false);
    expect(isValidCronExpression('')).toBe(false);
  });

  it('computes the next occurrences after a given moment, in order', () => {
    // cron-parser evaluates in the server's local time zone (documented on PollingConfig.cron),
    // so assert against local getters rather than UTC ones to stay timezone-independent.
    const from = new Date('2024-01-01T00:00:00'); // a Monday, local time
    const occurrences = nextCronOccurrences('0 9 * * 1', from, 2); // every Monday at 9am
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]!.getHours()).toBe(9);
    expect(occurrences[0]!.getDay()).toBe(1); // Monday
    expect(occurrences[1]!.getTime()).toBeGreaterThan(occurrences[0]!.getTime());
  });
});
