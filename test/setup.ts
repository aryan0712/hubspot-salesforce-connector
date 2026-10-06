/**
 * No global configuration is applied here on purpose: each test builds its own
 * ConfigContext (createDefaultConfigContext) the same way each app instance does, so a
 * test that mutates mappings cannot leak into another -- the isolation R01 requires.
 */
export {};
