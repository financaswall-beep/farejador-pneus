export type OperationDomain = 'finance' | 'publisher' | 'stock' | 'catalog';
export type ConfirmationMode = 'legacy' | 'conversa' | 'painel';
export interface OperationPermission {
  operation_confirmation?: ConfirmationMode;
  monitor_owner_approval: boolean;
  finance_operations_enabled: boolean;
  publisher_enabled: boolean;
  stock_operations_enabled?: boolean;
  catalog_operations_enabled?: boolean;
}
export function operationAllowed(permission: OperationPermission, domain: OperationDomain): boolean {
  if (domain === 'publisher') return permission.publisher_enabled;
  return permission[`${domain}_operations_enabled`] === true;
}
// Rascunhos, anexos preparatórios e tarefas internas mantêm sua autonomia.
export function operationReviewMode(permission: OperationPermission, domain: OperationDomain): 'conversa' | 'painel' | null {
  if (permission.operation_confirmation === 'conversa' || permission.operation_confirmation === 'painel')
    return permission.operation_confirmation;
  return permission.monitor_owner_approval || domain === 'stock' || domain === 'catalog' ? 'painel' : null;
}
