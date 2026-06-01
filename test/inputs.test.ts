import { describe, expect, it } from 'vitest';
import { InputsSchema, parseBool, parseSecretsJson } from '../src/inputs.js';

describe('parseSecretsJson', () => {
  it('returns empty object for empty input or {}', () => {
    expect(parseSecretsJson('')).toEqual({});
    expect(parseSecretsJson('   ')).toEqual({});
    expect(parseSecretsJson('{}')).toEqual({});
  });

  it('parses a valid string->string map', () => {
    expect(parseSecretsJson('{"A":"1","B":"two"}')).toEqual({ A: '1', B: 'two' });
  });

  it('throws on malformed JSON', () => {
    expect(() => parseSecretsJson('{not json}')).toThrow(/secrets must be a JSON object/);
  });

  it('throws when values are not strings', () => {
    expect(() => parseSecretsJson('{"A":1}')).toThrow(/string/);
    expect(() => parseSecretsJson('{"A":true}')).toThrow(/string/);
    expect(() => parseSecretsJson('["not", "an", "object"]')).toThrow();
  });
});

describe('parseBool', () => {
  it('treats empty / true / 1 as true', () => {
    expect(parseBool('', 'x')).toBe(true);
    expect(parseBool('true', 'x')).toBe(true);
    expect(parseBool('TRUE', 'x')).toBe(true);
    expect(parseBool('1', 'x')).toBe(true);
  });

  it('treats false / 0 as false', () => {
    expect(parseBool('false', 'x')).toBe(false);
    expect(parseBool('FALSE', 'x')).toBe(false);
    expect(parseBool('0', 'x')).toBe(false);
  });

  it('throws on anything else', () => {
    expect(() => parseBool('yes', 'redeploy')).toThrow(/redeploy must be 'true' or 'false'/);
    expect(() => parseBool('maybe', 'redeploy')).toThrow();
  });
});

describe('InputsSchema', () => {
  const valid = {
    apiKey: 'prim_test',
    apiBaseUrl: 'https://api.primitive.dev/v1',
    name: 'zork',
    codePath: 'dist/handler.js',
    secrets: {},
    redeployOnSecretChange: true,
    ignore: [],
  };

  it('parses a minimum-valid input', () => {
    expect(() => InputsSchema.parse(valid)).not.toThrow();
  });

  it('strips trailing slashes from apiBaseUrl', () => {
    const parsed = InputsSchema.parse({ ...valid, apiBaseUrl: 'https://api.primitive.dev/v1///' });
    expect(parsed.apiBaseUrl).toBe('https://api.primitive.dev/v1');
  });

  it('rejects an empty api-key', () => {
    expect(() => InputsSchema.parse({ ...valid, apiKey: '' })).toThrow(/api-key/);
  });

  it('rejects malformed names', () => {
    expect(() => InputsSchema.parse({ ...valid, name: 'BadName' })).toThrow(/name/);
    expect(() => InputsSchema.parse({ ...valid, name: 'has space' })).toThrow(/name/);
    expect(() => InputsSchema.parse({ ...valid, name: '' })).toThrow(/name/);
    expect(() =>
      InputsSchema.parse({ ...valid, name: 'a'.repeat(65) }),
    ).toThrow(/name/);
  });

  it('rejects an invalid api-base-url', () => {
    expect(() => InputsSchema.parse({ ...valid, apiBaseUrl: 'not-a-url' })).toThrow();
  });

  it('rejects an expected-org-id that is not a uuid', () => {
    expect(() =>
      InputsSchema.parse({ ...valid, expectedOrgId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('accepts a valid expected-org-id', () => {
    const parsed = InputsSchema.parse({
      ...valid,
      expectedOrgId: '5ed84344-6a3a-498d-9656-075401c9634d',
    });
    expect(parsed.expectedOrgId).toBe('5ed84344-6a3a-498d-9656-075401c9634d');
  });

  it('rejects when neither code-path nor files-path is set', () => {
    const { codePath, ...withoutCode } = valid;
    void codePath;
    expect(() => InputsSchema.parse(withoutCode)).toThrow(
      /exactly one of code-path or files-path/,
    );
  });

  it('rejects when both code-path and files-path are set', () => {
    expect(() =>
      InputsSchema.parse({ ...valid, filesPath: 'src/' }),
    ).toThrow(/exactly one of code-path or files-path/);
  });

  it('accepts files-path alone', () => {
    const { codePath, ...withoutCode } = valid;
    void codePath;
    const parsed = InputsSchema.parse({ ...withoutCode, filesPath: 'src/' });
    expect(parsed.filesPath).toBe('src/');
    expect(parsed.codePath).toBeUndefined();
  });

  it('rejects source-map-path without code-path', () => {
    const { codePath, ...withoutCode } = valid;
    void codePath;
    expect(() =>
      InputsSchema.parse({
        ...withoutCode,
        filesPath: 'src/',
        sourceMapPath: 'dist/handler.js.map',
      }),
    ).toThrow(/source-map-path is only valid with code-path/);
  });
});
