export type OperationDomain = 'finance' | 'publisher' | 'stock' | 'catalog' | 'pickup' | 'retail' | 'route';
export type ConfirmationMode = 'legacy' | 'conversa' | 'painel';
export interface OperationPermission {
  operation_confirmation?: ConfirmationMode;
  monitor_owner_approval: boolean;
  finance_operations_enabled: boolean;
  publisher_enabled: boolean;
  stock_operations_enabled?: boolean;
  catalog_operations_enabled?: boolean;
  pickup_operations_enabled?: boolean;
  retail_operations_enabled?: boolean;
  route_operations_enabled?: boolean;
}
export function operationAllowed(permission: OperationPermission, domain: OperationDomain): boolean {
  if (domain === 'publisher') return permission.publisher_enabled;
  return permission[`${domain}_operations_enabled`] === true;
}
const financeCategoryWrites = new Set(['criar_categoria_despesa_matriz', 'reclassificar_despesa_matriz']);
export function operationReviewMode(permission: OperationPermission, domain: OperationDomain, tool?: string): 'conversa' | 'painel' | null {
  if (permission.operation_confirmation === 'conversa' || permission.operation_confirmation === 'painel')
    return permission.operation_confirmation;
  const mustReviewCategory = domain === 'finance' && tool !== undefined && financeCategoryWrites.has(tool);
  if (mustReviewCategory || permission.monitor_owner_approval
      || domain === 'stock' || domain === 'catalog' || domain === 'pickup' || domain === 'retail' || domain === 'route') {
    return 'painel';
  }
  return null;
}
