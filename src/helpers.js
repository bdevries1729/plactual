function toActualAmount(plaidAmount) {
  return plaidAmount ? Math.round(plaidAmount * 100) : null;
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
