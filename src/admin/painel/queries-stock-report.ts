import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { canonicalCatalogBrand } from './catalog-brand.js';
import { readStockReportSnapshot, type StockReportSnapshot } from './stock-report-data.js';
import type { StockReportFilter } from './stock-report-filter.js';
import { stockGroupKey,stockMovementSource,stockStatus } from './stock-report-rules.js';

export function buildStockReport(snapshot:StockReportSnapshot,filter:StockReportFilter) {
  const brand=(value:string)=>canonicalCatalogBrand(value)||'Sem marca';
  const turnover=new Map<string,number>();
  const movements=snapshot.movements.map(row=>({...row,measure:row.measure.trim().toUpperCase(),brand:brand(row.brand),
    ...stockMovementSource(row.source),key:stockGroupKey(row)}));
  for(const row of movements)if(['sale','return'].includes(row.category)){
    const key=JSON.stringify([row.key,row.brand]);turnover.set(key,(turnover.get(key)||0)-row.delta);
  }
  type Variant={brand:string;physical:number;reserved:number;available:number;incoming:number;sold:number;net_sales:number;has_stock:boolean};
  const collection=new Map<string,{key:string;measure:string;condition:string;minimum:number|null;brands:Variant[]}>();
  for(const line of snapshot.variants){
    const key=stockGroupKey(line),row=collection.get(key)??{key,measure:line.measure.trim().toUpperCase(),condition:line.condition,minimum:null,brands:[]};
    if(line.minimum!==null)row.minimum=Math.max(row.minimum??0,line.minimum);
    const name=brand(line.brand),variant=row.brands.find(item=>item.brand===name)??{brand:name,physical:0,reserved:0,available:0,incoming:0,sold:0,net_sales:0,has_stock:false};
    if(!row.brands.includes(variant))row.brands.push(variant);
    variant.physical+=line.physical;variant.reserved+=line.reserved;variant.available+=line.physical-line.reserved;
    variant.incoming+=line.incoming;variant.has_stock||=line.has_stock;collection.set(key,row);
  }
  // A brand removed from today's stock still contributes to the group's historical turnover.
  for(const event of movements){
    const group=collection.get(event.key);
    if(group&&!group.brands.some(row=>row.brand===event.brand))group.brands.push({brand:event.brand,physical:0,reserved:0,
      available:0,incoming:0,sold:0,net_sales:0,has_stock:false});
  }
  const all=[...collection.values()].map(row=>{
    for(const variant of row.brands){variant.net_sales=turnover.get(JSON.stringify([row.key,variant.brand]))||0;variant.sold=Math.max(0,variant.net_sales);}
    const total=(field:keyof Pick<Variant,'physical'|'reserved'|'available'|'incoming'|'net_sales'>)=>row.brands.reduce((sum,variant)=>sum+variant[field],0);
    const physical=total('physical'),reserved=total('reserved'),available=total('available'),incoming=total('incoming'),sold=Math.max(0,total('net_sales'));
    const suggested=row.minimum===null?null:Math.max(0,row.minimum-available-incoming);
    return {...row,brands:row.brands.sort((a,b)=>a.brand.localeCompare(b.brand,'pt-BR')),physical,reserved,available,incoming,sold,suggested,
      coverage_days:sold>0?Math.round(available/sold*Number(filter.days)*10)/10:null,
      status:stockStatus({available,incoming,sold,suggested,minimum:row.minimum})};
  });
  const matches=(row:{measure:string;condition:string})=>(!filter.condition||row.condition===filter.condition)
    &&(!filter.measure||(filter.exact==='true'?row.measure===filter.measure.toUpperCase():row.measure.includes(filter.measure.toUpperCase())));
  const situation=(row:typeof all[number])=>filter.status==='all'||(filter.status==='replenish'?(row.suggested??0)>0:
    filter.status==='no_sales'?row.sold===0&&row.available>0:filter.status==='no_minimum'?row.minimum===null:
    filter.status==='incoming'?row.incoming>0:row.status===filter.status);
  const priority=(row:typeof all[number])=>row.available===0?0:(row.suggested??0)>0?1:row.status==='incoming'?2:3;
  const groups=all.filter(row=>matches(row)&&situation(row)).sort((a,b)=>priority(a)-priority(b)||b.sold-a.sold||a.key.localeCompare(b.key));
  const keys=new Set(groups.map(row=>row.key));
  const selectedMovements=movements.filter(row=>matches(row)&&(filter.status==='all'||keys.has(row.key))
    &&(filter.source==='all'||row.category===filter.source)
    &&(filter.movement==='all'||(filter.movement==='in'?row.delta>0:filter.movement==='out'?row.delta<0:row.delta===0)))
    .map(({source,...row})=>row);
  const sum=(key:'physical'|'reserved'|'available'|'incoming'|'sold')=>groups.reduce((total,row)=>total+row[key],0);
  const replenish=groups.filter(row=>(row.suggested??0)>0);
  return {filters:filter,as_of:snapshot.as_of,from:snapshot.from,to:snapshot.to,groups,
    summary:{physical:sum('physical'),reserved:sum('reserved'),available:sum('available'),incoming:sum('incoming'),sold:sum('sold'),
      groups:groups.length,replenish:replenish.length,suggested:replenish.reduce((total,row)=>total+row.suggested!,0),
      no_minimum:groups.filter(row=>row.minimum===null).length,zero:groups.filter(row=>row.available===0).length},
    top_seller:[...groups].filter(row=>row.sold>0).sort((a,b)=>b.sold-a.sold)[0]??null,
    slow_mover:[...groups].filter(row=>row.sold===0&&row.available>0).sort((a,b)=>b.available-a.available)[0]??null,
    movement_summary:{total:selectedMovements.length,in:selectedMovements.reduce((n,row)=>n+Math.max(0,row.delta),0),
      out:selectedMovements.reduce((n,row)=>n+Math.max(0,-row.delta),0),unchanged:selectedMovements.filter(row=>row.delta===0).length},
    movements:{total:selectedMovements.length,offset:filter.offset,rows:selectedMovements.slice(filter.offset,filter.offset+25)},
    export_movements:selectedMovements};
}
export async function getStockReport(filter:StockReportFilter,environment=env.FAREJADOR_ENV,db:Pool=pool){
  return buildStockReport(await readStockReportSnapshot(db,environment,filter),filter);
}
