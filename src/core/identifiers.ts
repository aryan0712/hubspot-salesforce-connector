/** Native identifiers are inserted into SOQL or CRM URL paths, never supplied as values. */
const SALESFORCE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const HUBSPOT_IDENTIFIER = /^(?:[0-9]+-[0-9]+|[A-Za-z][A-Za-z0-9_]*)$/;

export function isNativeObjectId(system: 'salesforce' | 'hubspot', id: string): boolean {
  return id.length <= 160 && (system === 'salesforce' ? SALESFORCE_IDENTIFIER : HUBSPOT_IDENTIFIER).test(id);
}

export function isNativeFieldPath(path: string): boolean {
  return path.length <= 160 && path.split('.').every((segment) => SALESFORCE_IDENTIFIER.test(segment));
}
