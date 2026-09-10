import type { GeoPoint } from '../shared/geo/haversine.js';
export interface RoutingDiagnostic {
  unitId:string; name:string; location:GeoPoint|null; distanceKm:number|null;
  radiusKm:number|null; reason:string; selected?:boolean;
}
