import crypto from 'node:crypto';
import type { CRMConnector } from '../core/connector.js';
import { naturalKeyFields, naturalKeyQuery } from '../core/idMap.js';
import { fieldRules } from '../core/mapping.js';
import type { CanonicalRecord, CanonicalType, SchemaField, SystemId } from '../core/types.js';

export type PreflightSeverity = 'error' | 'warning' | 'info';

export interface PreflightIssue {
  severity: PreflightSeverity;
  code: string;
  system?: SystemId;
  field?: string;
  message: string;
}

export interface PreflightReport {
  ok: boolean;
  from: SystemId;
  to: SystemId;
  type: CanonicalType;
  checkedAt: string;
  issues: PreflightIssue[];
  schemas: Partial<Record<SystemId, { hash: string; fields: number }>>;
}

export interface SchemaSnapshotStore {
  save(system: SystemId, type: CanonicalType, hash: string, fields: SchemaField[]): Promise<void>;
}

export class PreflightService {
  constructor(
    private readonly connectors: Record<SystemId, CRMConnector>,
    private readonly snapshots?: SchemaSnapshotStore,
  ) {}

  async run(from: SystemId, type: CanonicalType): Promise<PreflightReport> {
    const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';
    const [sourceFields, targetFields] = await Promise.all([
      this.connectors[from].describe(type),
      this.connectors[to].describe(type),
    ]);
    const sourceMap = fieldRules(from, type);
    const targetMap = fieldRules(to, type);
    const sourceByName = new Map(sourceFields.map((field) => [field.name, field]));
    const targetByName = new Map(targetFields.map((field) => [field.name, field]));
    const issues: PreflightIssue[] = [];

    for (const rule of sourceMap) {
      const root = rule.native.split('.')[0]!;
      if (!sourceByName.has(rule.native) && !sourceByName.has(root)) {
        issues.push({
          severity: rule.native.includes('.') ? 'warning' : 'error',
          code: rule.native.includes('.')
            ? 'RELATIONSHIP_FIELD_UNVERIFIED'
            : 'SOURCE_FIELD_MISSING',
          system: from,
          field: rule.native,
          message: rule.native.includes('.')
            ? `${from} relationship projection ${rule.native} requires query-time validation`
            : `${from} field ${rule.native} no longer exists`,
        });
      }
    }
    for (const rule of targetMap) {
      const target = targetByName.get(rule.native);
      if (!target && !rule.readOnly && !rule.native.includes('.')) {
        issues.push({
          severity: 'error',
          code: 'TARGET_FIELD_MISSING',
          system: to,
          field: rule.native,
          message: `${to} writable field ${rule.native} does not exist`,
        });
      }
      if (target?.readOnly && !rule.readOnly) {
        issues.push({
          severity: 'error',
          code: 'TARGET_FIELD_READ_ONLY',
          system: to,
          field: rule.native,
          message: `${to} field ${rule.native} is read-only`,
        });
      }
      const sourceRule = sourceMap.find((item) => item.canonical === rule.canonical);
      const source = sourceRule
        ? sourceByName.get(sourceRule.native) ?? sourceByName.get(sourceRule.native.split('.')[0]!)
        : undefined;
      if (source && target && !compatible(source.type, target.type)) {
        issues.push({
          severity: rule.toCanonical || rule.fromCanonical ? 'warning' : 'error',
          code: 'FIELD_TYPE_MISMATCH',
          field: rule.canonical,
          message: `${source.type} → ${target.type} requires a transform`,
        });
      }
      if (source?.options?.length && target?.options?.length) {
        issues.push({
          severity: 'warning',
          code: 'ENUM_VALUES_REQUIRE_REVIEW',
          field: rule.canonical,
          message: `Review ${rule.canonical} picklist/pipeline values before execution`,
        });
      }
    }

    const mappedTargets = new Set(targetMap.map((rule) => rule.native));
    for (const target of targetFields) {
      if (target.required && !target.readOnly && !mappedTargets.has(target.name)) {
        issues.push({
          severity: 'error',
          code: 'REQUIRED_TARGET_UNMAPPED',
          system: to,
          field: target.name,
          message: `Required ${to} field ${target.name} has no mapping`,
        });
      }
    }

    await this.profileNaturalKeys(from, to, type, issues);

    const sourceHash = schemaHash(sourceFields);
    const targetHash = schemaHash(targetFields);
    await Promise.all([
      this.snapshots?.save(from, type, sourceHash, sourceFields),
      this.snapshots?.save(to, type, targetHash, targetFields),
    ]);
    return {
      ok: !issues.some((issue) => issue.severity === 'error'),
      from,
      to,
      type,
      checkedAt: new Date().toISOString(),
      issues,
      schemas: {
        [from]: { hash: sourceHash, fields: sourceFields.length },
        [to]: { hash: targetHash, fields: targetFields.length },
      },
    };
  }

  private async profileNaturalKeys(
    from: SystemId,
    to: SystemId,
    type: CanonicalType,
    issues: PreflightIssue[],
  ): Promise<void> {
    const fields = naturalKeyFields(type);
    try {
      const [sourcePage, targetPage] = await Promise.all([
        this.connectors[from].list(type),
        this.connectors[to].list(type),
      ]);
      const source = keyProfile(sourcePage.records);
      const target = keyProfile(targetPage.records);
      if (source.missing) {
        issues.push({
          severity: 'warning',
          code: 'NATURAL_KEY_MISSING_VALUES',
          system: from,
          field: fields.join(' + '),
          message: `${source.missing} sampled ${type} record${source.missing === 1 ? '' : 's'} cannot be matched because ${fields.join(' + ')} is empty`,
        });
      }
      if (source.duplicates) {
        issues.push({
          severity: 'warning',
          code: 'SOURCE_NATURAL_KEY_DUPLICATES',
          system: from,
          field: fields.join(' + '),
          message: `${source.duplicates} duplicate ${fields.join(' + ')} value${source.duplicates === 1 ? '' : 's'} found in the sampled source records`,
        });
      }
      if (target.duplicates) {
        issues.push({
          severity: 'error',
          code: 'TARGET_NATURAL_KEY_DUPLICATES',
          system: to,
          field: fields.join(' + '),
          message: `${target.duplicates} duplicate ${fields.join(' + ')} value${target.duplicates === 1 ? '' : 's'} found in the sampled destination records`,
        });
      }
    } catch {
      issues.push({
        severity: 'warning',
        code: 'NATURAL_KEY_PROFILE_UNAVAILABLE',
        field: fields.join(' + '),
        message: `Could not sample records to validate ${fields.join(' + ')} coverage and uniqueness`,
      });
    }
  }
}

function keyProfile(records: CanonicalRecord[]): { missing: number; duplicates: number } {
  const counts = new Map<string, number>();
  let missing = 0;
  for (const record of records) {
    const query = naturalKeyQuery(record);
    if (!query) {
      missing += 1;
      continue;
    }
    counts.set(query.key, (counts.get(query.key) ?? 0) + 1);
  }
  return {
    missing,
    duplicates: [...counts.values()].filter((count) => count > 1).length,
  };
}

function compatible(a: string, b: string): boolean {
  const group = (value: string): string => {
    if (['int', 'integer', 'long', 'double', 'number', 'currency'].includes(value)) return 'number';
    if (['date', 'datetime', 'dateTime'].includes(value)) return 'date';
    if (['bool', 'boolean'].includes(value)) return 'boolean';
    if (['enumeration', 'picklist', 'multipicklist'].includes(value)) return 'enum';
    return 'string';
  };
  return group(a) === group(b);
}

function schemaHash(fields: SchemaField[]): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([...fields].sort((a, b) => a.name.localeCompare(b.name))))
    .digest('hex');
}
