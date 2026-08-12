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

  it('only enables writes with explicit confirmation', () => {
    expect(
      parseMigrationArgs([
        '--from',
        'hubspot',
        '--types',
        'contact,company',
        '--limit',
        '20',
        '--confirm',
      ]),
    ).toEqual({
      from: 'hubspot',
      types: ['contact', 'company'],
      limit: 20,
      dryRun: false,
    });
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
