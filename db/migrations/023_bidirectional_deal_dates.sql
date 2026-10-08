-- Keep the built-in deal close-date mapping type-safe in both directions for
-- existing tenants. Only update rows that still use the built-in native fields.
UPDATE field_mappings
SET to_canonical_transform = 'date-only',
    from_canonical_transform = 'date-only'
WHERE system = 'salesforce'
  AND object_type = 'deal'
  AND canonical_field = 'closeDate'
  AND native_field = 'CloseDate';

UPDATE field_mappings
SET to_canonical_transform = 'date-only',
    from_canonical_transform = 'epoch-millis'
WHERE system = 'hubspot'
  AND object_type = 'deal'
  AND canonical_field = 'closeDate'
  AND native_field = 'closedate';
