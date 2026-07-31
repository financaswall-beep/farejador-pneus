/**
 * Canonical TypeScript types for the `commerce.*` schema (Fase 3).
 *
 * Source: 0013_commerce_layer.sql
 * Rules:
 * - 1:1 mirror of DB columns — no business logic.
 * - NUMERIC columns are `string` as returned by the pg driver.
 * - Soft-deleted rows have deleted_at != null; repositories filter them at query time.
 */

import type { Environment } from './chatwoot.js';
import type { TireCondition } from '../tire-condition.js';
// ------------------------------------------------------------------
// commerce.products
// ------------------------------------------------------------------

export type ProductType = 'tire' | 'tube' | 'valve' | 'oil' | 'accessory' | 'service';

export interface Product {
  id: string;
  environment: Environment;
  product_code: string;
  product_name: string;
  product_type: ProductType;
  tire_condition: TireCondition | null;
  brand: string | null;
  short_description: string | null;
  /** NEVER expose to customer. Say Validator must block. */
  internal_notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

// ------------------------------------------------------------------
// commerce.tire_specs
// ------------------------------------------------------------------

export type TireConstruction = 'radial' | 'bias';
export type TireIntendedUse = 'street' | 'offroad' | 'mixed' | 'track';
export type TirePosition = 'front' | 'rear' | 'both';

export interface TireSpec {
  id: string;
  environment: Environment;
  product_id: string;
  /** Nominal size string, e.g. "140/70-17". */
  tire_size: string;
  width_mm: number | null;
  aspect_ratio: number | null;
  rim_diameter: number | null;
  load_index: string | null;
  speed_rating: string | null;
  construction: TireConstruction | null;
  tread_pattern: string | null;
  intended_use: TireIntendedUse | null;
  position: TirePosition | null;
  created_at: Date;
  updated_at: Date;
}

// ------------------------------------------------------------------
// commerce.vehicle_models
// ------------------------------------------------------------------

export type VehicleType = 'motorcycle' | 'car' | 'truck';

export interface VehicleModel {
  id: string;
  environment: Environment;
  vehicle_type: VehicleType;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
  segment: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

// ------------------------------------------------------------------
// commerce.vehicle_fitments
// ------------------------------------------------------------------

export type FitmentSource = 'manufacturer' | 'manual' | 'discovery_promoted';

export interface VehicleFitment {
  id: string;
  environment: Environment;
  vehicle_model_id: string;
  tire_spec_id: string;
  position: TirePosition;
  is_oem: boolean;
  source: FitmentSource;
  confidence_level: string | null; // NUMERIC
  created_at: Date;
  updated_at: Date;
}

// ------------------------------------------------------------------
// commerce.product_media
// ------------------------------------------------------------------

export type MediaType = 'image' | 'video';

export interface ProductMedia {
  id: string;
  environment: Environment;
  product_id: string;
  media_type: MediaType;
  url: string;
  alt_text: string | null;
  sort_order: number;
  created_at: Date;
}

// ------------------------------------------------------------------
// commerce.stock_levels
// ------------------------------------------------------------------

export interface StockLevel {
  id: string;
  environment: Environment;
  product_id: string;
  warehouse_code: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  updated_at: Date;
}

// ------------------------------------------------------------------
// commerce.product_prices
// ------------------------------------------------------------------

export type PriceType = 'retail' | 'promo' | 'cost';

export interface ProductPrice {
  id: string;
  environment: Environment;
  product_id: string;
  price_type: PriceType;
  amount: string; // NUMERIC
  currency: string;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
}

// ------------------------------------------------------------------
// commerce.geo_resolutions
// ------------------------------------------------------------------

export type GeoConfidence = 'high' | 'medium' | 'low';

export interface GeoResolution {
  id: string;
  environment: Environment;
  raw_input: string;
  neighborhood: string | null;
  city: string | null;
  state_code: string | null;
  country_code: string;
  latitude: string | null;  // NUMERIC
  longitude: string | null; // NUMERIC
  confidence: GeoConfidence;
  resolver_source: string | null;
  created_at: Date;
}

// ------------------------------------------------------------------
// commerce.delivery_zones
// ------------------------------------------------------------------

export interface DeliveryZone {
  id: string;
  environment: Environment;
  zone_name: string;
  neighborhoods: string[];
  cities: string[];
  delivery_fee: string; // NUMERIC
  min_order_amount: string | null; // NUMERIC
  estimated_hours_min: number | null;
  estimated_hours_max: number | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

// ------------------------------------------------------------------
// commerce.store_policies
// ------------------------------------------------------------------

export interface StorePolicy {
  id: string;
  environment: Environment;
  policy_key: string;
  policy_value: string;
  updated_at: Date;
}

// ------------------------------------------------------------------
// commerce.orders (confirmed — "verdade comercial")
// ------------------------------------------------------------------

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'in_preparation'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export type OrderFulfillmentMode = 'delivery' | 'pickup';

export interface Order {
  id: string;
  environment: Environment;
  contact_id: string;
  conversation_id: string | null;
  order_number: string;
  status: OrderStatus;
  fulfillment_mode: OrderFulfillmentMode;
  delivery_address: string | null;
  geo_resolution_id: string | null;
  payment_method: string | null;
  subtotal: string; // NUMERIC
  delivery_fee: string; // NUMERIC
  discount: string;   // NUMERIC
  total_amount: string; // NUMERIC
  notes: string | null;
  closed_by: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ------------------------------------------------------------------
// commerce.order_items
// ------------------------------------------------------------------

export interface OrderItem {
  id: string;
  environment: Environment;
  order_id: string;
  product_id: string;
  tire_condition: TireCondition | null;
  quantity: number;
  unit_price: string; // NUMERIC
  line_total: string; // NUMERIC
  created_at: Date;
}

// ------------------------------------------------------------------
// Views
// ------------------------------------------------------------------

/** View: commerce.current_prices */
export interface CurrentPrice {
  product_id: string;
  environment: Environment;
  price_type: PriceType;
  amount: string;
  currency: string;
  valid_from: Date;
  valid_until: Date | null;
}

export interface ProductFull {
  id: string;
  environment: Environment;
  product_code: string;
  product_name: string;
  product_type: ProductType;
  tire_condition: TireCondition | null;
  brand: string | null;
  short_description: string | null;
  tire_size: string | null;
  width_mm: number | null;
  aspect_ratio: number | null;
  rim_diameter: number | null;
  position: TirePosition | null;
  quantity_on_hand: number | null;
  quantity_reserved: number | null;
  retail_price: string | null;
}

export interface LowStockAlert {
  product_id: string;
  environment: Environment;
  product_code: string;
  product_name: string;
  brand: string | null;
  quantity_on_hand: number;
  quantity_reserved: number;
  available: number;
}
