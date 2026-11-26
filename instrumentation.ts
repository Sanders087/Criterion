export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.PAYMENT_RECONCILIATION_ENABLED !== 'true') return;
  const {getDatabase} = await import('./db/sqlite.mjs');
  const {reconciliationConfig,startReconciliation} = await import('./lib/payment-reconciliation.mjs');
  const {backgroundPaymentCheck} = await import('./lib/criterion/payments');
  const {diagnostic} = await import('./lib/diagnostics.mjs');
  try { startReconciliation(getDatabase,reconciliationConfig(process.env),backgroundPaymentCheck); }
  catch { diagnostic('payment.reconciliation_failed',{errorCode:'PAYMENT_UNAVAILABLE'},'error'); }
}
