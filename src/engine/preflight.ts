import crypto from 'node:crypto';
import type { CRMConnector } from '../core/connector.js';
import type { ConfigContext } from '../core/configContext.js';
import { isWeakNaturalKey } from '../core/idMap.js';
import { isBuiltInObjectPair } from '../core/defaultObjects.js';
import type { FieldRule } from '../core/mapping.js';
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
    private readonly config: ConfigContext,
    private readonly snapshots?: SchemaSnapshotStore,
    private readonly allowCustomObjects = false,
  ) {}

  async run(from: SystemId, type: CanonicalType, scope: { sourceIds?: string[] } = {}): Promise<PreflightReport> {
    const to: SystemId = from === 'salesforce' ? 'hubspot' : 'salesforce';
    const registration = this.config.getObject(type);
    const custom = !isBuiltInObjectPair(registration);
    if (custom && (!registration?.salesforceObject || !registration.hubspotObject)) {
      return {
        ok: false, from, to, type, checkedAt: new Date().toISOString(), schemas: {},
        issues: [{ severity: 'error', code: 'OBJECT_PAIR_INCOMPLETE',
          message: `${type} must be explicitly paired with a Salesforce and HubSpot object` }],
      };
    }
    const [sourceFields, targetFields] = await Promise.all([
      this.connectors[from].describe(type),
      this.connectors[to].describe(type),
    ]);
    const sourceMap = this.config.fieldRules(from, type);
    const targetMap = this.config.fieldRules(to, type);
    const sourceByName = new Map(sourceFields.map((field) => [field.name, field]));
    const targetByName = new Map(targetFields.map((field) => [field.name, field]));
    const issues: PreflightIssue[] = [];

    if (custom) {
      if (!this.allowCustomObjects) {
        issues.push({ severity: 'error', code: 'CUSTOM_OBJECT_EXECUTION_DISABLED',
          message: 'Custom-object execution is disabled until the object pair and release gate are approved' });
      }
      for (const system of [from, to]) {
        const nativeId = this.config.nativeObjectName(system, type);
        const descriptor = nativeId
          ? (await this.connectors[system].listObjects()).find((object) => object.id === nativeId)
          : undefined;
        if (!descriptor) {
          issues.push({ severity: 'error', code: 'OBJECT_NOT_DISCOVERED', system,
            message: `${system} object for ${type} is not available in the connected account` });
        } else if (!descriptor.queryable ||
            (system === to && (!descriptor.createable || !descriptor.updateable))) {
          issues.push({ severity: 'error', code: 'OBJECT_CAPABILITY_MISSING', system,
            message: system === from
              ? `${system} object ${nativeId} cannot be read`
              : `${system} object ${nativeId} cannot be read, created and updated` });
        }
      }
    }

    if (!sourceMap.length) {
      issues.push({
        severity: 'error', code: 'SOURCE_MAPPING_EMPTY', system: from,
        message: `${type} has no ${from} source field mappings`,
      });
    }
    if (!targetMap.length) {
      issues.push({
        severity: 'error', code: 'TARGET_MAPPING_EMPTY', system: to,
        message: `${type} has no ${to} destination field mappings`,
      });
    }
    const sourceCanonicalFields = new Set(sourceMap.map((rule) => rule.canonical));
    if (!targetMap.some((rule) =>
      sourceCanonicalFields.has(rule.canonical) && !rule.readOnly && !rule.native.includes('.'))) {
      issues.push({
        severity: 'error', code: 'NO_WRITABLE_SHARED_FIELDS', system: to,
        message: `${type} has no shared mapped field writable in ${to}`,
      });
    }

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
      if (custom && (rule.native.includes('.') || !supportedScalarType(sourceByName.get(rule.native)?.type) ||
          sourceByName.get(rule.native)?.calculated)) {
        issues.push({ severity: 'error', code: 'UNSUPPORTED_SOURCE_FIELD', system: from, field: rule.native,
          message: `${from} field ${rule.native} is not a supported scalar field` });
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
      if (custom && !rule.readOnly && target &&
          (target.createable === false || target.updateable === false || target.calculated)) {
        issues.push({ severity: 'error', code: 'TARGET_FIELD_NOT_WRITABLE', system: to, field: rule.native,
          message: `${to} field ${rule.native} cannot be created and updated` });
      }
      if (custom && !rule.readOnly && target && !supportedScalarType(target.type)) {
        issues.push({ severity: 'error', code: 'UNSUPPORTED_TARGET_FIELD', system: to, field: rule.native,
          message: `${to} field ${rule.native} is not a supported scalar field` });
      }
      const sourceRule = sourceMap.find((item) => item.canonical === rule.canonical);
      const source = sourceRule
        ? sourceByName.get(sourceRule.native) ?? sourceByName.get(sourceRule.native.split('.')[0]!)
        : undefined;
      // A transform configured on only one side (or one direction) still gets flagged, just
      // downgraded to a warning -- only a genuinely bidirectional transform (both toCanonical
      // and fromCanonical set) clears the issue entirely, since sync flows both ways and a
      // one-way fix still breaks a change coming back from the other system. The fix normally
      // lives on whichever system's native type is the awkward one (e.g. HubSpot's yes/no
      // enumeration), which can be EITHER "source" or "target" depending on which direction
      // this particular plan runs -- so both rules need checking, not just the current target's.
      const isBidirectional = (r?: FieldRule): boolean =>
        Boolean(r?.toCanonical && r.toCanonical !== 'identity' && r?.fromCanonical && r.fromCanonical !== 'identity');
      const bidirectionalTransform = isBidirectional(rule) || isBidirectional(sourceRule);
      const datePrecisionChanged = custom && source && target &&
        ['date', 'datetime', 'dateTime'].includes(source.type) &&
        ['date', 'datetime', 'dateTime'].includes(target.type) &&
        source.type.toLowerCase() !== target.type.toLowerCase();
      if (source && target && (!compatible(source.type, target.type) || datePrecisionChanged) && !bidirectionalTransform) {
        issues.push({
          severity: custom ? 'error' : rule.toCanonical || rule.fromCanonical ? 'warning' : 'error',
          code: 'FIELD_TYPE_MISMATCH',
          field: rule.canonical,
          message: `${rule.canonical}: ${source.type} → ${target.type} requires a transform`,
        });
      }
      if (source?.options?.length && target?.options?.length) {
        if (custom) {
          const accepted = new Set(target.options.map((option) => option.value));
          const mappings = this.config.valueMappings(type, rule.canonical);
          const missing = source.options.some((option) => {
            const canonical = mappings.find((mapping) => mapping[`${from}Value`] === option.value)?.canonicalValue ?? option.value;
            const targetValue = mappings.find((mapping) => mapping.canonicalValue === canonical)?.[`${to}Value`] ?? canonical;
            return !accepted.has(targetValue);
          });
          if (missing) issues.push({ severity: 'error', code: 'ENUM_VALUE_UNMAPPED', field: rule.canonical,
            message: `${rule.canonical} has source values that the destination cannot represent` });
        } else {
          issues.push({
            severity: 'warning',
            code: 'ENUM_VALUES_REQUIRE_REVIEW',
            field: rule.canonical,
            message: `Review ${rule.canonical} picklist/pipeline values before execution`,
          });
        }
      } else if (custom && (source?.type === 'enumeration' || source?.type === 'picklist' ||
          target?.type === 'enumeration' || target?.type === 'picklist')) {
        issues.push({ severity: 'error', code: 'ENUM_OPTIONS_UNAVAILABLE', field: rule.canonical,
          message: `${rule.canonical} enumeration options are unavailable for review` });
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

    await this.profileNaturalKeys(from, to, type, issues, scope.sourceIds);

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
    sourceIds?: string[],
  ): Promise<void> {
    const fields = this.config.naturalKeyFields(type);
    const custom = !isBuiltInObjectPair(this.config.getObject(type));
    if (!fields.length) {
      issues.push({
        severity: custom ? 'error' : 'warning',
        code: 'NATURAL_KEY_MISSING',
        message: custom
          ? `${type} requires an explicit shared natural key before migration`
          : `${type} has no matching rule, so existing destination records cannot be recognised and every record will be created`,
      });
    } else if (isWeakNaturalKey(fields)) {
      issues.push({
        severity: 'warning',
        code: 'WEAK_NATURAL_KEY',
        field: fields.join(' + '),
        message: `${fields.join(' + ')} can change or repeat; prefer a shared external id or email/domain to match ${type} records`,
      });
    }
    const mappedBoth = this.config.fieldRules(from, type).map((rule) => rule.canonical)
      .filter((field) => this.config.fieldRules(to, type).some((rule) => rule.canonical === field));
    if (custom && fields.some((field) => !mappedBoth.includes(field))) {
      issues.push({ severity: 'error', code: 'NATURAL_KEY_NOT_SHARED', field: fields.join(' + '),
        message: 'Every custom-object key field must be mapped in both CRMs' });
    }
    if (custom && fields.some((field) => this.config.fieldRules(to, type)
      .find((rule) => rule.canonical === field)?.readOnly)) {
      issues.push({ severity: 'error', code: 'NATURAL_KEY_TARGET_READ_ONLY', field: fields.join(' + '),
        message: 'Custom-object key fields must be writable in the destination' });
    }
    const externalId = mappedBoth.find((field) => /external.*id/i.test(field));
    if (externalId && !fields.includes(externalId)) {
      issues.push({
        severity: 'info',
        code: 'EXTERNAL_ID_AVAILABLE',
        field: externalId,
        message: `${externalId} is mapped in both CRMs; using it as the matching rule is the most reliable identity`,
      });
    }
    if (!fields.length) return;
    try {
      const [sourceRecords, targetPage] = await Promise.all([
        sourceIds
          ? Promise.all(sourceIds.map((sourceId) => this.connectors[from].read(type, sourceId)))
          : this.connectors[from].list(type).then((page) => page.records),
        this.connectors[to].list(type),
      ]);
      const source = keyProfile(this.config, sourceRecords.filter((record): record is CanonicalRecord => record !== null));
      const target = keyProfile(this.config, targetPage.records);
      if (source.missing) {
        issues.push({
          severity: custom ? 'error' : 'warning',
          code: 'NATURAL_KEY_MISSING_VALUES',
          system: from,
          field: fields.join(' + '),
          message: `${source.missing} sampled ${type} record${source.missing === 1 ? '' : 's'} cannot be matched because ${fields.join(' + ')} is empty`,
        });
      }
      if (source.duplicateKeys.size) {
        issues.push({
          severity: custom ? 'error' : 'warning',
          code: 'SOURCE_NATURAL_KEY_DUPLICATES',
          system: from,
          field: fields.join(' + '),
          message: `${source.duplicateKeys.size} duplicate ${fields.join(' + ')} value${source.duplicateKeys.size === 1 ? '' : 's'} found in the sampled source records`,
        });
      }
      const sourceKeys = new Set(source.counts.keys());
      const relevantTargetDuplicates = [...target.duplicateKeys].filter((key) => sourceKeys.has(key)).length;
      if (relevantTargetDuplicates) {
        issues.push({
          severity: 'error',
          code: 'TARGET_NATURAL_KEY_DUPLICATES',
          system: to,
          field: fields.join(' + '),
          message: `${relevantTargetDuplicates} duplicate ${fields.join(' + ')} value${relevantTargetDuplicates === 1 ? '' : 's'} match the sampled source scope in destination records`,
        });
      }
    } catch {
      issues.push({
        severity: custom ? 'error' : 'warning',
        code: 'NATURAL_KEY_PROFILE_UNAVAILABLE',
        field: fields.join(' + '),
        message: `Could not sample records to validate ${fields.join(' + ')} coverage and uniqueness`,
      });
    }
  }
}

function supportedScalarType(value: string | undefined): boolean {
  if (!value) return false;
  return new Set([
    'string', 'textarea', 'phone', 'email', 'url', 'id', 'int', 'integer', 'long',
    'double', 'number', 'currency', 'percent', 'bool', 'boolean', 'date', 'datetime',
    'dateTime', 'enumeration', 'picklist',
  ]).has(value);
}

function keyProfile(config: ConfigContext, records: CanonicalRecord[]): {
  missing: number;
  counts: Map<string, number>;
  duplicateKeys: Set<string>;
} {
  const counts = new Map<string, number>();
  let missing = 0;
  for (const record of records) {
    const query = config.naturalKeyQuery(record);
    if (!query) {
      missing += 1;
      continue;
    }
    counts.set(query.key, (counts.get(query.key) ?? 0) + 1);
  }
  return { missing, counts, duplicateKeys: new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key)) };
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
