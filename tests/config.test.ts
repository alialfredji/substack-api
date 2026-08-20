import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { normalizeCookie, publicationBaseUrl, resolveConfig } from '../src/client/config.js';

const ENV_KEYS = [
  'SUBSTACK_COOKIE',
  'SUBSTACK_BASE_URL',
  'SUBSTACK_CONCURRENCY',
  'SUBSTACK_MIN_DELAY_MS',
  'SUBSTACK_TIMEOUT_MS',
  'SUBSTACK_RETRIES',
  'SUBSTACK_RETRY_BASE_DELAY_MS',
  'SUBSTACK_RETRY_MAX_DELAY_MS',
  'SUBSTACK_VALIDATE',
  'SUBSTACK_DEBUG',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('normalizeCookie', () => {
  it('treats a bare sid value as the substack.sid cookie', () => {
    // This is the common case: people paste the value straight out of DevTools.
    expect(normalizeCookie('s%3AabC123')).toBe('substack.sid=s%3AabC123');
  });

  it('passes a full cookie header through untouched', () => {
    const header = 'substack.sid=s%3Aab; substack.lli=1';
    expect(normalizeCookie(header)).toBe(header);
  });

  it('returns null for absent or blank input', () => {
    expect(normalizeCookie(undefined)).toBeNull();
    expect(normalizeCookie(null)).toBeNull();
    expect(normalizeCookie('   ')).toBeNull();
  });

  it('trims surrounding whitespace from a pasted value', () => {
    expect(normalizeCookie('  s%3Aabc \n')).toBe('substack.sid=s%3Aabc');
  });
});

describe('resolveConfig', () => {
  it('defaults to no cookie, so the read surface is anonymous unless asked otherwise', () => {
    expect(resolveConfig().cookie).toBeNull();
  });

  it('applies documented defaults', () => {
    const config = resolveConfig();
    expect(config.baseUrl).toBe('https://substack.com');
    expect(config.concurrency).toBe(1);
    expect(config.minDelayMs).toBe(250);
    expect(config.timeoutMs).toBe(15_000);
    expect(config.retries).toBe(4);
    expect(config.retryBaseDelayMs).toBe(1_000);
    expect(config.retryMaxDelayMs).toBe(60_000);
    expect(config.validate).toBe('lenient');
    expect(config.debug).toBe(false);
  });

  it('reads configuration from the environment', () => {
    process.env['SUBSTACK_COOKIE'] = 'envsid';
    process.env['SUBSTACK_CONCURRENCY'] = '9';
    process.env['SUBSTACK_RETRY_BASE_DELAY_MS'] = '1200';
    process.env['SUBSTACK_RETRY_MAX_DELAY_MS'] = '45000';
    process.env['SUBSTACK_VALIDATE'] = 'strict';
    process.env['SUBSTACK_DEBUG'] = '1';

    const config = resolveConfig();
    expect(config.cookie).toBe('substack.sid=envsid');
    expect(config.concurrency).toBe(9);
    expect(config.retryBaseDelayMs).toBe(1_200);
    expect(config.retryMaxDelayMs).toBe(45_000);
    expect(config.validate).toBe('strict');
    expect(config.debug).toBe(true);
  });

  it('lets explicit options win over the environment', () => {
    process.env['SUBSTACK_COOKIE'] = 'envsid';
    process.env['SUBSTACK_CONCURRENCY'] = '9';

    const config = resolveConfig({ cookie: 'explicit', concurrency: 2 });
    expect(config.cookie).toBe('substack.sid=explicit');
    expect(config.concurrency).toBe(2);
  });

  it('ignores an unparseable validate mode rather than throwing', () => {
    process.env['SUBSTACK_VALIDATE'] = 'nonsense';
    expect(resolveConfig().validate).toBe('lenient');
  });

  it('falls back to the default when a numeric env var is garbage', () => {
    process.env['SUBSTACK_TIMEOUT_MS'] = 'abc';
    expect(resolveConfig().timeoutMs).toBe(15_000);
  });

  it('never allows concurrency below 1, which would deadlock the gate', () => {
    expect(resolveConfig({ concurrency: 0 }).concurrency).toBe(1);
  });

  it('strips trailing slashes from the base URL so path joins stay clean', () => {
    expect(resolveConfig({ baseUrl: 'https://substack.com/' }).baseUrl).toBe('https://substack.com');
  });
});

describe('publicationBaseUrl', () => {
  it('builds a subdomain URL', () => {
    expect(publicationBaseUrl('aieworks')).toBe('https://aieworks.substack.com');
  });

  it('rejects anything that is not a bare subdomain', () => {
    // Guards against a caller passing a full URL or an injection attempt.
    expect(() => publicationBaseUrl('evil.com/path')).toThrow(/Invalid publication subdomain/);
    expect(() => publicationBaseUrl('https://x.substack.com')).toThrow(/Invalid publication subdomain/);
  });
});
