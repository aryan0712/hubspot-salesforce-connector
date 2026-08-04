import { describe, expect, it } from 'vitest';
import { allowedApiOrigins } from '../src/security/originPolicy.js';

describe('allowedApiOrigins', () => {
  it('accepts loopback aliases with the configured protocol and port', () => {
    const origins = allowedApiOrigins('http://localhost:3000/');

    expect(origins).toEqual(
      new Set([
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://[::1]:3000',
      ]),
    );
  });

  it('also expands a numeric loopback public URL', () => {
    const origins = allowedApiOrigins('http://127.0.0.1:8080');

    expect(origins.has('http://localhost:8080')).toBe(true);
    expect(origins.has('http://[::1]:8080')).toBe(true);
  });

  it('keeps non-loopback deployments restricted to the exact origin', () => {
    const origins = allowedApiOrigins('https://sync.example.com/app');

    expect(origins).toEqual(new Set(['https://sync.example.com']));
    expect(origins.has('https://127.0.0.1')).toBe(false);
    expect(origins.has('https://evil.example')).toBe(false);
  });
});
