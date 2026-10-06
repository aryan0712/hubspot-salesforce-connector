import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CanonicalType, SystemId } from './types.js';
import { validateFieldRules, type FieldRule } from './mapping.js';
import { applyDefaultObjectsTo, type ConfigContext } from './configContext.js';

type MappingDocument = Partial<
  Record<SystemId, Partial<Record<CanonicalType, FieldRule[]>>>
>;

export interface MappingStore {
  init(): Promise<void>;
  get(system: SystemId, type: CanonicalType): Promise<FieldRule[]> | FieldRule[];
  set(system: SystemId, type: CanonicalType, rules: FieldRule[]): Promise<void>;
}

/**
 * File-backed mapping overrides for credential-free runs (the demo). The defaults live in
 * core/defaultObjects.ts; this file stores only overrides, so a newly added default field
 * is not hidden by an empty file. Reads and writes go to the app's own ConfigContext.
 */
export class FileMappingStore implements MappingStore {
  private overrides: MappingDocument = {};

  constructor(
    private readonly config: ConfigContext,
    private readonly file = path.resolve('data/mappings.json'),
  ) {}

  async init(): Promise<void> {
    applyDefaultObjectsTo(this.config);
    try {
      this.overrides = JSON.parse(await fs.readFile(this.file, 'utf8')) as MappingDocument;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    for (const [system, byType] of Object.entries(this.overrides) as [SystemId, Partial<Record<CanonicalType, FieldRule[]>>][]) {
      for (const [type, rules] of Object.entries(byType) as [CanonicalType, FieldRule[]][]) {
        if (rules) this.config.configureFieldRules(system, type, rules);
      }
    }
  }

  get(system: SystemId, type: CanonicalType): FieldRule[] {
    return this.config.fieldRules(system, type);
  }

  async set(system: SystemId, type: CanonicalType, rules: FieldRule[]): Promise<void> {
    validateFieldRules(rules);
    const next: MappingDocument = structuredClone(this.overrides);
    next[system] ??= {};
    next[system]![type] = rules.map((rule) => ({ ...rule }));
    await this.persist(next);
    this.overrides = next;
    // Publish only after the override is durable, so a failed write never goes live.
    this.config.configureFieldRules(system, type, rules);
  }

  private async persist(document: MappingDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(document, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
}
