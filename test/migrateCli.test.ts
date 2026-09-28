import { describe, expect, it } from 'vitest';
import { parseMigrationArgs } from '../src/cli/migrateArgs.js';

describe('migration CLI safety', () => {
  it('previews by default, deferring object selection to the caller when --types is omitted', () => {
    expect(parseMigrationArgs([])).toMatchObject({
      from: 'salesforce',
      types: undefined,
      dryRun: true,
    });
  });

  it('only enables writes when confirming a specific reviewed preview', () => {
    expect(
      parseMigrationArgs(['--confirm', '--preview', 'preview-run-1', '--idempotency-key', 'k1']),
    ).toEqual({
      from: 'salesforce',
      types: undefined,
      limit: undefined,
      dryRun: false,
      previewRunId: 'preview-run-1',
      idempotencyKey: 'k1',
    });
  });

  it('never previews and writes in one unreviewed step', () => {
    expect(() =>
      parseMigrationArgs(['--from', 'hubspot', '--types', 'contact', '--limit', '20', '--confirm']),
    ).toThrow('--confirm requires --preview');
    expect(() => parseMigrationArgs(['--preview', 'preview-run-1'])).toThrow('--confirm');
    expect(() => parseMigrationArgs(['--confirm', '--preview'])).toThrow('--preview requires');
  });

  it('rejects conflicting or invalid arguments', () => {
    expect(() => parseMigrationArgs(['--confirm', '--dry-run'])).toThrow(
      'cannot be used together',
    );
    expect(() => parseMigrationArgs(['--from', 'other'])).toThrow('--from');
    expect(() => parseMigrationArgs(['--types', ''])).toThrow('--types');
    expect(() => parseMigrationArgs(['--limit', '0'])).toThrow('--limit');
  });

  it('accepts any object list for --types; validity is checked against the registry at runtime', () => {
    expect(parseMigrationArgs(['--types', 'contact,custom_object'])).toMatchObject({
      types: ['contact', 'custom_object'],
    });
  });
});
