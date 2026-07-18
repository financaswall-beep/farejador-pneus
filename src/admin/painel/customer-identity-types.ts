export type CustomerSourceType =
  | 'chatwoot_contact'
  | 'walkin_customer'
  | 'partner_customer'
  | 'wholesale_customer'
  | 'network_partner'
  | 'matriz_collaborator';

export type CustomerEntityType =
  | 'person' | 'organization' | 'fleet' | 'tire_shop'
  | 'partner' | 'collaborator' | 'unknown';

export interface CustomerSourceRecord {
  source_type: CustomerSourceType;
  source_id: string;
  environment: 'prod' | 'test';
  owner_scope: 'matrix' | 'partner_unit';
  partner_unit_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  document_number: string | null;
  entity_type: CustomerEntityType;
  is_vip: boolean;
  updated_at: string;
}

export interface CustomerIdentitySource extends CustomerSourceRecord {
  link_id: string;
  identity_id: string;
}

export interface CustomerIdentityMetrics {
  purchases: number;
  total_spent: number;
  avg_ticket: number;
  gross_profit: number | null;
  pending_cost_items: number;
  first_purchase_at: string | null;
  last_purchase_at: string | null;
}

export interface CustomerIdentityRow {
  id: string;
  entity_type: CustomerEntityType;
  classification: string | null;
  is_vip: boolean;
  name: string;
  phone: string | null;
  email: string | null;
  document_number: string | null;
  scope: 'matrix' | 'partner_unit' | 'mixed';
  sources: CustomerIdentitySource[];
  conflicts: Array<'name' | 'phone' | 'email' | 'document_number'>;
  metrics: CustomerIdentityMetrics;
  created_at: string;
}

export interface CursorPage<T> {
  rows: T[];
  next_cursor: string | null;
}
