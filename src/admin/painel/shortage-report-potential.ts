import { tireSizeKey } from '../../shared/tire-size.js';
import { canonicalTireCondition } from '../../shared/tire-condition.js';
import type { ShortageProduct,ShortageTrace } from './shortage-report-types.js';
const brand=(s:string|null|undefined)=>(s||'').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const position=(s:string|undefined)=>({dianteiro:'front',traseiro:'rear',ambos:'both'})[s as 'dianteiro']||s;
export function shortageReference(t:Pick<ShortageTrace,'measure'|'filters'>,store:string,products:ShortageProduct[]){
  const f=t.filters||{},wanted=canonicalTireCondition(f.condicao_pneu),pos=position(f.posicao_pneu),matrix=store==='matriz';
  const candidates=products.filter(p=>tireSizeKey(p.measure)===tireSizeKey(t.measure)
    &&(!f.marca||brand(p.brand).includes(brand(f.marca)))
    &&(!f.condicao_pneu||(wanted!==null&&canonicalTireCondition(p.condition)===wanted))
    &&(!pos||p.position===pos||p.position==='both'))
    .map(p=>({product:p,price:matrix?p.matrix_price:p.partner_price,currency:matrix?p.matrix_currency:p.partner_currency}))
    .filter((p):p is typeof p&{price:number}=>p.currency==='BRL'&&p.price!==null&&Number.isFinite(p.price)&&p.price>0)
    .sort((a,b)=>a.price-b.price||a.product.id.localeCompare(b.product.id));
  const r=candidates[0];return r?{amount:Math.round(r.price*100)/100,brand:r.product.brand,condition:r.product.condition,position:r.product.position}:null;
}
export function shortageOpportunities(traces:ShortageTrace[],store:string,products:ShortageProduct[]){
  const groups=new Map<string,ShortageTrace[]>();
  const index=new Map<string,ShortageProduct[]>(),references=new Map<string,ReturnType<typeof shortageReference>>();
  for(const p of products){const key=tireSizeKey(p.measure),rows=index.get(key)||[];rows.push(p);index.set(key,rows);}
  const reference=(t:ShortageTrace)=>{const key=tireSizeKey(t.measure)+'|'+JSON.stringify([t.filters.marca,t.filters.condicao_pneu,t.filters.posicao_pneu]);
    if(!references.has(key))references.set(key,shortageReference(t,store,index.get(tireSizeKey(t.measure))||[]));return references.get(key)!;};
  for(const t of traces){const key=t.conversation_id+'|'+tireSizeKey(t.measure),rows=groups.get(key)||[];rows.push(t);groups.set(key,rows);}
  return[...groups.values()].map(group=>{
    const first=group[0]!,refs=group.map(reference).filter(r=>r!==null).sort((a,b)=>a.amount-b.amount);
    return{id:first.id,measure:first.measure,occurred_at:first.occurred_at,municipality:first.municipality,searches:group.length,reference:refs[0]||null};
  });
}
export function shortagePotential(rows:ReturnType<typeof shortageOpportunities>){
  const priced=rows.filter(r=>r.reference),amount=priced.length?priced.reduce((n,r)=>n+Math.round(r.reference!.amount*100),0)/100:null;
  return{amount,opportunities:rows.length,priced:priced.length,unpriced:rows.length-priced.length,
    repeated:rows.reduce((n,r)=>n+r.searches-1,0),min:priced.length?Math.min(...priced.map(r=>r.reference!.amount)):null,
    max:priced.length?Math.max(...priced.map(r=>r.reference!.amount)):null};
}
