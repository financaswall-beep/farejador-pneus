export interface ShortageStore {id:string;name:string;available:boolean;kind?:string}
export interface ShortageTrace {
  id:string;conversation_id:string;search_key:string;occurred_at:string;measure:string;
  municipality:string|null;filters:Record<string,string>;stores:ShortageStore[];
}
export interface ShortageProduct {
  id:string;measure:string;brand:string|null;condition:string|null;position:string|null;
  matrix_price:number|null;matrix_currency:string|null;partner_price:number|null;partner_currency:string|null;
}
export interface ShortageStock {store_id:string;measure:string;available:number;unknown:boolean}
export interface ShortageSnapshot {
  as_of:string;tracking_since:string|null;legacy_records:number;traces:ShortageTrace[];
  products:ShortageProduct[];stock:ShortageStock[];cities:{id:string;city:string|null}[];
}
