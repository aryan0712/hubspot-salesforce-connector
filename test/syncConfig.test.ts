import { describe, expect, it } from 'vitest';
import {
  defaultSyncConfig,
  InMemorySyncConfigStore,
  syncAllows,
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
