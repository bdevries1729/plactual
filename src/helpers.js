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
  return {
    account: actualAccountId,
    date: tx.date,
    amount: -toActualAmount(tx.amount),
    payee_name: payee, // accepted on create only, not on update
    imported_payee: payee,
    notes: tx.merchant_name && tx.name && tx.name !== tx.merchant_name ? tx.name : undefined,
    imported_id: tx.transaction_id,
    cleared: tx.pending === false,
  };
}

export { toActualAmount, toDateString, firstOfMonth, addDays, plaidToActualTransaction };
