import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toActualAmount,
  toDateString,
  firstOfMonth,
  addDays,
  plaidToActualTransaction,
} from '../src/helpers.js';

describe('toActualAmount', () => {
  it('converts dollars to integer cents', () => {
    assert.equal(toActualAmount(12.34), 1234);
    assert.equal(toActualAmount(-5.5), -550);
  });

  it('keeps a genuine zero as zero', () => {
    assert.equal(toActualAmount(0), 0);
  });

  it('maps only null and undefined to null', () => {
    assert.equal(toActualAmount(null), null);
    assert.equal(toActualAmount(undefined), null);
  });
});

describe('toDateString', () => {
  it('formats a UTC-anchored date as YYYY-MM-DD', () => {
    assert.equal(toDateString(new Date(Date.UTC(2026, 0, 5))), '2026-01-05');
  });

  it("round-trips Plaid's date strings unchanged", () => {
    assert.equal(toDateString(new Date('2026-08-07')), '2026-08-07');
  });
});

describe('firstOfMonth', () => {
  it('lands on day 01 of the current local month', () => {
    const now = new Date();
    const expectedMonth = String(now.getMonth() + 1).padStart(2, '0');
    assert.equal(toDateString(firstOfMonth()), `${now.getFullYear()}-${expectedMonth}-01`);
  });

  it('is anchored to UTC midnight so formatting cannot drift a day', () => {
    assert.equal(firstOfMonth().getUTCHours(), 0);
    assert.equal(firstOfMonth().getUTCDate(), 1);
  });
});

describe('addDays', () => {
  it('moves forwards and backwards', () => {
    assert.equal(toDateString(addDays(new Date('2026-08-07'), 7)), '2026-08-14');
    assert.equal(toDateString(addDays(new Date('2026-08-07'), -7)), '2026-07-31');
  });

  it('rolls over year boundaries', () => {
    assert.equal(toDateString(addDays(new Date('2026-12-28'), 7)), '2027-01-04');
  });

  it('does not mutate its input', () => {
    const original = new Date('2026-08-07');
    addDays(original, 30);
    assert.equal(toDateString(original), '2026-08-07');
  });
});

describe('plaidToActualTransaction', () => {
  const base = {
    date: '2026-08-07',
    amount: 12.34,
    transaction_id: 'tx_1',
    name: 'STARBUCKS STORE 123',
    merchant_name: 'Starbucks',
    pending: false,
  };

  it('flips the sign, since Plaid reports spending as positive', () => {
    assert.equal(plaidToActualTransaction('acct', base).amount, -1234);
    assert.equal(plaidToActualTransaction('acct', { ...base, amount: -50 }).amount, 5000);
  });

  it('prefers the merchant name and keeps the raw name as notes', () => {
    const tx = plaidToActualTransaction('acct', base);
    assert.equal(tx.payee_name, 'Starbucks');
    assert.equal(tx.imported_payee, 'Starbucks');
    assert.equal(tx.notes, 'STARBUCKS STORE 123');
  });

  it('omits notes when there is nothing extra to say', () => {
    const same = plaidToActualTransaction('acct', { ...base, name: 'Starbucks' });
    assert.equal(same.notes, undefined);

    const noMerchant = plaidToActualTransaction('acct', { ...base, merchant_name: null });
    assert.equal(noMerchant.payee_name, 'STARBUCKS STORE 123');
    assert.equal(noMerchant.notes, undefined);
  });

  it('falls back to Unknown when Plaid names nothing', () => {
    const tx = plaidToActualTransaction('acct', { ...base, name: null, merchant_name: null });
    assert.equal(tx.payee_name, 'Unknown');
    assert.equal(tx.imported_payee, 'Unknown');
  });

  it('clears only settled transactions', () => {
    assert.equal(plaidToActualTransaction('acct', base).cleared, true);
    assert.equal(plaidToActualTransaction('acct', { ...base, pending: true }).cleared, false);
    assert.equal(plaidToActualTransaction('acct', { ...base, pending: undefined }).cleared, false);
  });

  it('carries the account and the Plaid id used for deduplication', () => {
    const tx = plaidToActualTransaction('acct-1', base);
    assert.equal(tx.account, 'acct-1');
    assert.equal(tx.imported_id, 'tx_1');
    assert.equal(tx.date, '2026-08-07');
  });
});
