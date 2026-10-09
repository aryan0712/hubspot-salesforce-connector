import { logger } from '../logger.js';
import type { ConfigContext } from '../core/configContext.js';
import { evaluateConditions, type SyncConfig } from '../core/syncConfig.js';
import type { CRMConnector } from '../core/connector.js';
import type { CanonicalType, SystemId } from '../core/types.js';

/**
 * Decides which canonical object a native record belongs to when more than one canonical
 * object is registered against the same native object (e.g. Salesforce Account backing both
 * "company" and a separately-registered "person_account" routed to HubSpot contacts).
 *
 * An unfiltered single candidate is free. Structured conditions are evaluated even for a
 * single candidate so a webhook cannot bypass the same scope used by polling. Raw SOQL
 * conditions cannot be evaluated against one record; those webhooks are left unresolved.
 */
export async function resolveCanonicalType(
  system: SystemId,
  nativeObjectId: string,
  sourceId: string,
  connector: CRMConnector,
  syncConfig: SyncConfig,
  config: ConfigContext,
): Promise<CanonicalType | undefined> {
  const candidates = config.canonicalObjectsFor(system, nativeObjectId)
    .filter((candidate) => syncConfig.objects[candidate.canonicalObject]?.enrolledForSync);
  if (candidates.length === 0) return undefined;
  const routes = candidates.map((candidate) => ({
    type: candidate.canonicalObject,
    conditions: syncConfig.objects[candidate.canonicalObject]?.conditions?.[system] ?? [],
    raw: syncConfig.objects[candidate.canonicalObject]?.rawCondition?.[system],
  }));
  if (routes.length === 1 && !routes[0]!.conditions.length && !routes[0]!.raw) return routes[0]!.type;
  if (routes.some((route) => route.raw || (routes.length > 1 && !route.conditions.length))) {
    logger.warn(
      { system, nativeObjectId, candidates: routes.map((route) => route.type) },
      'native object routing needs evaluable structured conditions -- leaving event unresolved',
    );
    return undefined;
  }
  const fields = [...new Set(routes.flatMap((route) => route.conditions.map((condition) => condition.field)))];
  const raw = await connector.readNativeFields(nativeObjectId, sourceId, fields);
  if (!raw) return undefined;
  const matches = routes.filter((route) => evaluateConditions(route.conditions, raw));
  if (matches.length === 1) return matches[0]!.type;
  logger.warn({ system, nativeObjectId, sourceId, matches: matches.map((route) => route.type) },
    'native record matched zero or multiple sync routes -- leaving event unresolved');
  return undefined;
}
