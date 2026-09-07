import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';

const originalChallenge = process.env['OPENAI_APPS_CHALLENGE'];

afterEach(() => {
  if (originalChallenge === undefined) delete process.env['OPENAI_APPS_CHALLENGE'];
  else process.env['OPENAI_APPS_CHALLENGE'] = originalChallenge;
});

describe('OpenAI domain verification', () => {
  it('returns 404 until a challenge token is configured', async () => {
    delete process.env['OPENAI_APPS_CHALLENGE'];
    const app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/openai-apps-challenge',
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('returns only the configured challenge token', async () => {
    process.env['OPENAI_APPS_CHALLENGE'] = 'openai-verification-token';
    const app = await buildApp({ logger: false });

    const response = await app.inject({
      method: 'GET',
      url: '/.well-known/openai-apps-challenge',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toBe('openai-verification-token');
    await app.close();
  });
});
