import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.js';

describe('redact', () => {
  it('masks the Plaid token exchange response', () => {
    const response = {
      access_token: 'access-sandbox-abc123',
      item_id: 'item-1',
      request_id: 'req-1',
    };
    assert.deepEqual(redact(response), {
      access_token: '***',
      item_id: 'item-1',
      request_id: 'req-1',
    });
  });

  it('masks secrets nested in objects and arrays', () => {
    const body = {
      mappings: [{ account_name: 'Checking', access_token: 'access-sandbox-abc' }],
      nested: { deeper: { password: 'hunter2' } },
    };
    const result = redact(body);
    assert.equal(result.mappings[0].access_token, '***');
    assert.equal(result.mappings[0].account_name, 'Checking');
    assert.equal(result.nested.deeper.password, '***');
  });

  it('covers every credential the app handles', () => {
    const all = {
      access_token: 'a',
      public_token: 'b',
      link_token: 'c',
      // Only legacy Plaid integrations receive one; masked anyway.
      user_token: 'd',
      client_id: 'e',
      secret: 'f',
      password: 'g',
    };
    assert.deepEqual(Object.values(redact(all)), Array(7).fill('***'));
  });

  it('leaves everything else untouched', () => {
    const input = { count: 0, ok: false, missing: null, when: '2026-08-07', list: [1, 'two'] };
    assert.deepEqual(redact(input), input);
  });

  it('passes primitives through, so it is safe on any loggable value', () => {
    assert.equal(redact('plain'), 'plain');
    assert.equal(redact(7), 7);
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
  });

  it('copies rather than mutating what it was given', () => {
    const original = { access_token: 'access-sandbox-abc' };
    redact(original);
    assert.equal(original.access_token, 'access-sandbox-abc');
  });
});
