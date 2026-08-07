// Actual stores amounts as integer cents. A genuine 0 must stay 0 — mapping it
// to null would poison downstream arithmetic with NaN.
function toActualAmount(plaidAmount) {
  return plaidAmount == null ? null : Math.round(plaidAmount * 100);
}

// Both Plaid and Actual speak YYYY-MM-DD. Every Date flowing through here is
// anchored to UTC midnight (see firstOfMonth/addDays, and `new Date('2026-08-07')`
// which JS parses as UTC), so formatting via toISOString stays on the intended
// calendar day instead of drifting by one for anyone east of Greenwich.
function toDateString(date) {
  return date.toISOString().split('T')[0];
}

// The 1st of the *local* current month, at UTC midnight.
function firstOfMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function plaidToActualTransaction(actualAccountId, tx) {
  const payee = tx.merchant_name || tx.name || 'Unknown';
  // Plaid reports spending as positive, Actual as negative. Negating straight
  // through would turn toActualAmount's null into -0, which serializes to a
  // real 0 and books a $0.00 transaction; callers drop null-amount rows instead
  // (see sync.js), so the null is kept intact for them to see. A genuine 0 is
  // pinned to +0 for the same reason in reverse — nothing downstream should
  // have to reason about signed zero.
  const cents = toActualAmount(tx.amount);
  const amount = cents == null ? null : cents === 0 ? 0 : -cents;
  return {
    account: actualAccountId,
    date: tx.date,
    amount,
    payee_name: payee, // accepted on create only, not on update
    imported_payee: payee,
    notes: tx.merchant_name && tx.name && tx.name !== tx.merchant_name ? tx.name : undefined,
    imported_id: tx.transaction_id,
    cleared: tx.pending === false,
  };
}

export { toActualAmount, toDateString, firstOfMonth, addDays, plaidToActualTransaction };
