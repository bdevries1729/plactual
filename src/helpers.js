function toActualAmount(plaidAmount) {
  return plaidAmount ? Math.round(plaidAmount * 100) : null;
}

function plaidToActualType(plaidType, plaidSubtype) {
  if (plaidType === 'depository') {
    if (['savings', 'cd', 'money market', 'hsa'].includes(plaidSubtype)) {
      return 'savings';
    }
    return 'checking';
  }
  if (plaidType === 'credit') {
    return 'credit';
  }
  if (plaidType === 'loan') {
    if (['mortgage', 'home equity'].includes(plaidSubtype)) {
      return 'mortgage';
    }
    if (plaidSubtype === 'line of credit') {
      return 'credit';
    }
    return 'debt';
  }
  if (plaidType === 'investment' || plaidType === 'brokerage') {
    return 'investment';
  }
  return 'other';
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

export { toActualAmount, plaidToActualTransaction, plaidToActualType };
