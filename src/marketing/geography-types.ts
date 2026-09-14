export interface GeoOffer { ad_id: string; measure: string; brand: string; condition: string; }
export interface GeoBinding {
  id: string; campaign_id: string; allocation: 'dedicated'|'shared'; municipality: string|null;
  valid_from: string; valid_until: string; coverage: 'unknown'|'pickup'|'confirmed';
  offers: GeoOffer[]; reason: string;
}
export interface GeoInsight {
  campaign_id: string; campaign_name: string; day: string; spend: number; currency: string;
  conversations: number; collected_at: string;
}
export interface GeoReferral {
  id: string; conversation_id: string; campaign_id: string; ad_id: string; municipality: string|null;
  captured_at: string; day: string; mature: boolean;
}
export interface GeoSale {
  id: string; referral_id: string; conversation_id: string; campaign_id: string; ad_id: string;
  municipality: string|null; day: string; captured_at: string; realized_at: string;
  revenue: number; margin: number|null;
}
export interface GeoStock { measure: string; brand: string; condition: string; available: number; }
export interface GeoMeta {
  campaign_id: string; status: string|null; daily_budget: number|null;
  budget_entity_id: string|null; budget_level: 'campaign'|'adset'|null; learning: string|null;
}
export interface GeoDiagnostic { campaign_id: string; frequency: number|null; link_ctr: number|null; }
export interface GeoSnapshot { campaign_id: string; observed_at: string; payload: GeoMeta; }
export type GeoDecision = 'increase'|'maintain'|'review'|'pause_offer'|'wait';
export interface GeoTotals {
  sales: number|null; revenue: number|null; gross_margin: number|null; spend: number|null;
  margin: number|null; cpa: number|null; conversations: number; converted: number|null;
  conversion: number|null; mature_conversations: number; mature_converted: number|null;
}
export interface GeoAvailability {
  state: 'available'|'partial'|'unavailable'|'unknown'; coverage: string;
  offers: Array<GeoOffer & { available: number|null }>;
}
export interface GeoCampaign {
  id: string; name: string; region: string; scope: string; binding: GeoBinding|null;
  totals: GeoTotals; previous: GeoTotals; availability: GeoAvailability;
  decision: GeoDecision; reasons: string[]; meta: GeoMeta|null;
  diagnostics: { current: GeoDiagnostic|null; previous: GeoDiagnostic|null };
  budget_change: { observed_at: string; before: GeoTotals; after: GeoTotals; days: number }|null;
  meta_url: string;
}
export const geoKey = (s: string) => s.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export const round = (n: number) => Math.round(n*100)/100;
export const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date(iso));
export const shiftDay = (s: string, n: number) => new Date(Date.parse(s+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
