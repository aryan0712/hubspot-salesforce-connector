import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CanonicalType, SystemId } from './types.js';
import {
  configureFieldRules,
  fieldRules,
  type FieldRule,
} from './mapping.js';
import { applyDefaultObjects } from './defaultObjects.js';

type MappingDocument = Partial<
  Record<SystemId, Partial<Record<CanonicalType, FieldRule[]>>>
>;

export interface MappingStore {
  init(): Promise<void>;
  get(system: SystemId, type: CanonicalType): Promise<FieldRule[]> | FieldRule[];
  set(system: SystemId, type: CanonicalType, rules: FieldRule[]): Promise<void>;
}

/**
 * Serializable mapping configuration. The defaults remain in mapping.ts; this file stores
 * only customer overrides, so a newly added default field is not hidden by an empty file.
 */
export class FileMappingStore {
  private overrides: MappingDocument = {};

  constructor(private readonly file = path.resolve('data/mappings.json')) {}

  async init(): Promise<void> {
    // The defaults live in core/defaultObjects.ts; this file stores only overrides, so a
    // newly added default field is not hidden by an empty overrides file.
    await applyDefaultObjects();
    try {
      this.overrides = JSON.parse(await fs.readFile(this.file, 'utf8')) as MappingDocument;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const [system, byType] of Object.entries(this.overrides) as [SystemId, Partial<Record<CanonicalType, FieldRule[]>>][]) {
      for (const [type, rules] of Object.entries(byType) as [CanonicalType, FieldRule[]][]) {
        if (rules) configureFieldRules(system, type, rules);
      }
    }
  }

  get(system: SystemId, type: CanonicalType): FieldRule[] {
    return fieldRules(system, type);
  }

  async set(system: SystemId, type: CanonicalType, rules: FieldRule[]): Promise<void> {
    configureFieldRules(system, type, rules);
    this.overrides[system] ??= {};
    this.overrides[system]![type] = rules.map((rule) => ({ ...rule }));
    await this.persist();
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.overrides, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
}
