export function isReceivableCustomerScopeError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  return candidate?.message === 'customer_not_found'
    || (candidate?.code === '23514'
      && candidate.message?.includes('partner_receivable_customer_scope_mismatch') === true);
}
