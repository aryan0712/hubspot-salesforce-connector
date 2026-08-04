import { describe, expect, it, vi } from 'vitest';
import { MigrationCopilot, validateOpenAIKey } from '../src/ai/migrationCopilot.js';
import { PublicError } from '../src/core/publicError.js';
import type { MigrationCopilotContext } from '../src/ai/migrationCopilot.js';

const context: MigrationCopilotContext = {
  source: 'salesforce',
  target: 'hubspot',
  revision: 3,
  checks: [
    {
      ok: false,
      from: 'salesforce',
      to: 'hubspot',
      type: 'contact',
      checkedAt: '2026-07-29T00:00:00.000Z',
      issues: [
        {
          severity: 'error',
          code: 'FIELD_TYPE_MISMATCH',
          field: 'ownerId',
          message: 'reference → enumeration requires a transform',
        },
      ],
      schemas: {
        salesforce: { hash: 'must-not-leave-the-server', fields: 800 },
        hubspot: { hash: 'also-private', fields: 272 },
      },
    },
  ],
  mappings: [
    {
      system: 'salesforce',
      type: 'contact',
      rules: [{ canonical: 'ownerId', native: 'OwnerId' }],
    },
    {
      system: 'hubspot',
      type: 'contact',
      rules: [{ canonical: 'ownerId', native: 'hubspot_owner_id' }],
    },
  ],
};

function responsePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'completed',
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              readiness: 'ready',
              summary: 'Owner identifiers differ between the CRMs.',
              findings: [
                {
                  issueCode: 'FIELD_TYPE_MISMATCH',
                  objectType: 'contact',
                  field: 'ownerId',
                  severity: 'error',
                  title: 'Map owners before migration',
                  explanation: 'CRM owner identifiers are system-specific.',
                  recommendedAction: 'Create an explicit owner mapping and rerun preflight.',
                  recommendationKind: 'map_owners',
                  recommendationArea: 'owner_mappings',
                  confidence: 0.93,
                  requiresApproval: false,
                },
              ],
              nextSteps: ['Review owner mappings', 'Rerun preflight'],
              disclaimer: 'Model-supplied disclaimer',
            }),
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('MigrationCopilot', () => {
  it('sends metadata-only context and enforces read-only structured output', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Response(JSON.stringify(responsePayload()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const copilot = new MigrationCopilot({
      apiKey: 'test-api-key',
      model: 'gpt-test',
      fetchImpl,
    });

    const result = await copilot.analyzePreflight(context, 'privacy-safe-actor-hash');

    expect(result.readiness).toBe('blocked');
    expect(result.findings[0]?.requiresApproval).toBe(true);
    expect(result.privacy).toEqual({
      recordValuesShared: false,
      credentialsShared: false,
      canMutate: false,
    });
    expect(result.disclaimer).toContain('AI guidance only');

    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as Record<string, any>;
    expect(body.store).toBe(false);
    expect(body.safety_identifier).toBe('privacy-safe-actor-hash');
    expect(body.model).toBe('gpt-test');
    expect(body.text.format.type).toBe('json_schema');
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(String(request.body)).not.toContain('must-not-leave-the-server');
    expect(String(request.body)).not.toContain('also-private');
    expect(String(request.body)).not.toContain('test-api-key');
  });

  it('fails closed when the API key is missing', async () => {
    const copilot = new MigrationCopilot();

    await expect(copilot.analyzePreflight(context)).rejects.toMatchObject<Partial<PublicError>>({
      code: 'copilot_not_configured',
      status: 503,
    });
  });

  it('can hot-reload a replacement key without a server restart', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responsePayload()), { status: 200 }));
    const copilot = new MigrationCopilot({ fetchImpl });
    expect(copilot.configured).toBe(false);

    copilot.configure({ apiKey: 'replacement-key', model: 'gpt-replacement' });
    expect(copilot.configured).toBe(true);
    expect(copilot.model).toBe('gpt-replacement');
    await expect(copilot.analyzePreflight(context)).resolves.toMatchObject({
      model: 'gpt-replacement',
      readiness: 'blocked',
    });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      authorization: 'Bearer replacement-key',
    });
  });

  it('validates a key with OpenAI without sending application data', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await validateOpenAIKey('new-key', 'gpt-test', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models/gpt-test',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer new-key' },
      }),
    );
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).body).toBeUndefined();
  });

  it('does not accept a provider-rejected key', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));

    await expect(
      validateOpenAIKey('bad-key', 'gpt-test', { fetchImpl }),
    ).rejects.toMatchObject<Partial<PublicError>>({
      code: 'copilot_key_invalid',
      status: 422,
    });
  });

  it('surfaces rate limits without leaking provider response details', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'sensitive provider detail' } }), {
        status: 429,
      }));
    const copilot = new MigrationCopilot({ apiKey: 'test-api-key', fetchImpl });

    await expect(copilot.analyzePreflight(context)).rejects.toMatchObject<Partial<PublicError>>({
      code: 'copilot_rate_limited',
      status: 429,
      message: expect.not.stringContaining('sensitive provider detail'),
    });
  });

  it('rejects model output that does not match the application schema', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(responsePayload({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: '{"readiness":"blocked"}' }],
        }],
      })), { status: 200 }));
    const copilot = new MigrationCopilot({ apiKey: 'test-api-key', fetchImpl });

    await expect(copilot.analyzePreflight(context)).rejects.toMatchObject<Partial<PublicError>>({
      code: 'copilot_invalid_response',
      status: 503,
    });
  });
});
