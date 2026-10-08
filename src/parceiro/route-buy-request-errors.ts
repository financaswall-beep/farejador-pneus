import { logger } from '../shared/logger.js';
export function buyRequestError(error: unknown): {status:number;error:string} {
  const code=error instanceof Error?error.message:'';
  if (code==='request_not_found' || code==='partner_inactive') return {status:404,error:code};
  if (['invalid_request','duplicate_offer','reason_required','due_date_required','due_date_invalid','receipt_quantity_invalid'].includes(code))
    return {status:400,error:code};
  if (['offer_changed','price_changed','stock_changed','reservation_conflict','idempotency_conflict',
    'request_state_conflict','request_items_mismatch','request_purchase_link_conflict','request_product_changed',
    'matrix_shipment_requires_arrival_adjustment','purchase_already_received'].includes(code)) return {status:409,error:code};
  if (code==='wholesale_finance_required') return {status:503,error:code};
  if ((error as {code?:string})?.code==='42P01' || (error as {code?:string})?.code==='42883')
    return {status:503,error:'wholesale_requests_migration_required'};
  logger.error({err:error},'partner wholesale request failed');
  return {status:500,error:'request_failed'};
}
