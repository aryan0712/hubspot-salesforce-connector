import { logger } from '../logger.js';
import { canonicalObjectsFor } from '../core/objectRegistry.js';
import { evaluateConditions, type SyncConfig } from '../core/syncConfig.js';
import type { CRMConnector } from '../core/connector.js';
import type { CanonicalType, SystemId } from '../core/types.js';

/**
 * Decides which canonical object a native record belongs to when more than one canonical
 * object is registered against the same native object (e.g. Salesforce Account backing both
 * "company" and a separately-registered "person_account" routed to HubSpot contacts).
 *
 * The common case (one candidate) is free -- no lookup, no config read. Disambiguation only
 * runs for the rare shared-object case, and only evaluates each candidate's *structured*
 * conditions (an advanced raw SOQL condition can't be evaluated in-process against a single
 * record's fields -- a candidate that relies solely on one to distinguish itself from its
 * siblings can't be resolved here and is skipped with a warning).
 */
export async function resolveCanonicalType(
  system: SystemId,
  nativeObjectId: string,
  sourceId: string,
  connector: CRMConnector,
  syncConfig: SyncConfig,
): Promise<CanonicalType | undefined> {
  const candidates = canonicalObjectsFor(system, nativeObjectId);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0]!.canonicalObject;

  const conditionsByType = new Map(
    candidates.map((c) => [c.canonicalObject, syncConfig.objects[c.canonicalObject]?.conditions?.[system]]),
  );
  const fields = [...new Set(candidates.flatMap((c) => (conditionsByType.get(c.canonicalObject) ?? []).map((cond) => cond.field)))];

  if (fields.length === 0) {
    logger.warn(
      { system, nativeObjectId, candidates: candidates.map((c) => c.canonicalObject) },
      'multiple canonical objects share this native object but none has a structured condition to disambiguate -- dropping event',
    );
    return undefined;
  }

  const raw = await connector.readNativeFields(nativeObjectId, sourceId, fields);
  if (!raw) return undefined;

  for (const candidate of candidates) {
    if (evaluateConditions(conditionsByType.get(candidate.canonicalObject), raw)) {
      return candidate.canonicalObject;
    }
  }

  logger.warn(
    { system, nativeObjectId, sourceId, candidates: candidates.map((c) => c.canonicalObject) },
    'record matched none of the conditions distinguishing these shared-native-object canonical objects -- dropping event',
  );
  return undefined;
}
