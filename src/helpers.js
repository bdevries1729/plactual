// Actual stores amounts as integer cents. A genuine 0 stays 0; only a missing
// amount becomes null.
function toActualAmount(plaidAmount) {
  return plaidAmount == null ? null : Math.round(plaidAmount * 100);
}

// Both Plaid and Actual speak YYYY-MM-DD. Every Date passed here is anchored to
// UTC midnight, so toISOString can't drift a day for anyone east of Greenwich.
function toDateString(date) {
  return date.toISOString().split('T')[0];
}

// The 1st of the *local* current month, at UTC midnight.
function firstOfMonth() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
}

function plaidToActualTransaction(actualAccountId, tx) {
  const payee = tx.merchant_name || tx.name || 'Unknown';
  // Plaid reports spending as positive, Actual as negative. Negating straight
  // through would turn null into -0, which serializes as a real 0 and books a
  // $0.00 transaction; sync.js drops null-amount rows instead.
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

export { toActualAmount, toDateString, firstOfMonth, plaidToActualTransaction };
