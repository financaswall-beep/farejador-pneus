export type DemandMetric='conversations'|'orders'|'deliveries'|'shortages';
export interface DemandEvent {conversation_id:string;municipality:string|null;day:string;kind:'activity'|'measure'|'order'|'delivery'|'shortage';measure:string|null}
export interface DemandSnapshot {as_of:string;current:DemandEvent[];previous:DemandEvent[];stock:{measure:string;quantity:number}[]}
export interface DemandCounts {conversations:number;orders:number;deliveries:number;shortages:number;conversion:number|null}
export interface DemandCity extends DemandCounts {key:string;name:string;previous:DemandCounts|null}
export interface DemandMeasure {key:string;measure:string;consultations:number;stock:number|null}
export const DEMAND_UNKNOWN='__unknown__';
