import type { OperationSalesScope } from '../../operation/my-sales-types.js';
import type { CaixaAuth } from './queries.js';

/** A abrangência vem da sessão validada. O cliente só pode restringi-la. */
export function caixaSalesScope(
  auth: Pick<CaixaAuth, 'panelRole'>,
  requested?: OperationSalesScope,
): OperationSalesScope {
  if (requested === 'own') return 'own';
  return auth.panelRole === 'owner' || auth.panelRole === 'admin' ? 'matrix' : 'own';
}
