export type PartnerCommercialModel = 'commission' | 'monthly' | 'hybrid';

export function assertPartnerCommercialTerms(input: {
  commercial_model: PartnerCommercialModel;
  commission_percent: number | null;
  monthly_fee: number | null;
}): void {
  const { commercial_model: model, commission_percent: percent, monthly_fee: fee } = input;
  if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
    throw new Error('invalid_percent');
  }
  if (fee !== null && (!Number.isFinite(fee) || fee < 0)) {
    throw new Error('invalid_fee');
  }
  if ((model === 'commission' || model === 'hybrid') && percent === null) {
    throw new Error('commission_percent_required');
  }
  if (model === 'monthly' && percent !== null) {
    throw new Error('commission_percent_not_applicable');
  }
  if ((model === 'monthly' || model === 'hybrid') && fee === null) {
    throw new Error('monthly_fee_required');
  }
  if (model === 'commission' && fee !== null) {
    throw new Error('monthly_fee_not_applicable');
  }
}
