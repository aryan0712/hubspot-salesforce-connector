ALTER TABLE field_mappings DROP CONSTRAINT IF EXISTS field_mappings_source_of_truth_check;
ALTER TABLE field_mappings ADD CONSTRAINT field_mappings_source_of_truth_check
  CHECK (source_of_truth IN ('salesforce', 'hubspot', 'last-write-wins'));

