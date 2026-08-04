function toActualAmount(plaidAmount) {
  // Only null/undefined map to null; a genuine 0 must stay 0 (not become null,
  // which would poison downstream arithmetic with NaN).
  return plaidAmount == null ? null : Math.round(plaidAmount * 100);
}

function plaidToActualTransaction(actualAccountId, tx) {
  return {
    account: actualAccountId,
    date: tx.date,
    amount: -toActualAmount(tx.amount),
    payee_name: tx.merchant_name || tx.name || 'Unknown', // only available in create request
    imported_payee: tx.merchant_name || tx.name || 'Unknown',
    notes: tx.merchant_name && tx.name && tx.name !== tx.merchant_name ? tx.name : undefined,
    imported_id: tx.transaction_id,
    cleared: tx.pending === false,
  };
}

export { toActualAmount, plaidToActualTransaction };
