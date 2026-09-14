import type { GeoData } from '../admin/painel/geography-data.js';
import type { GeoAvailability, GeoBinding, GeoCampaign, GeoDecision, GeoTotals } from './geography-types.js';
import { geoKey,round } from './geography-types.js';

export function bindingAt(data:GeoData,id:string,day:string):GeoBinding|null {
  return data.bindings.find(b=>b.campaign_id===id && b.valid_from<=day && b.valid_until>=day)??null;
}
export function geographyTotals(data:GeoData,ids:string[],region:string,since:string,until:string,enabled:boolean):GeoTotals {
  const inside=(d:string)=>d>=since&&d<=until;
  const match=(s:string|null)=>geoKey(s||'Sem município')===geoKey(region);
  const allRefs=data.refs.filter(r=>ids.includes(r.campaign_id)&&inside(r.day));
  const refs=allRefs.filter(r=>match(r.municipality));
  const allSales=data.sales.filter(s=>ids.includes(s.campaign_id)&&inside(s.day));
  const sales=allSales.filter(s=>match(s.municipality));
  const insights=data.insights.filter(r=>ids.includes(r.campaign_id)&&inside(r.day));
  // Um orçamento dedicado só é associado à região durante a validade declarada.
  // Origem ausente/divergente impede apresentar o custo de toda a campanha como custo desta cidade.
  const complete=insights.length>0 && insights.every(i=>{
    const b=bindingAt(data,i.campaign_id,i.day);
    return i.currency==='BRL' && b?.allocation==='dedicated' && match(b.municipality);
  }) && allRefs.every(r=>match(r.municipality)) && allSales.every(s=>match(s.municipality));
  const spend=complete?round(insights.reduce((n,r)=>n+Number(r.spend),0)):null;
  const tracked=new Set(refs.map(r=>r.conversation_id));
  const refIds=new Set(refs.map(r=>r.id));
  const converted=new Set(data.sales.filter(s=>refIds.has(s.referral_id)).map(s=>s.conversation_id));
  const matureRefs=refs.filter(r=>r.mature);const matureIds=new Set(matureRefs.map(r=>r.id));
  const matureConversations=new Set(matureRefs.map(r=>r.conversation_id));
  const matureConverted=new Set(data.sales.filter(s=>matureIds.has(s.referral_id)).map(s=>s.conversation_id));
  const known=enabled&&(tracked.size>0||sales.length>0);
  const gross=known && sales.every(s=>s.margin!=null)?round(sales.reduce((n,s)=>n+Number(s.margin),0)):null;
  return {spend,sales:known?sales.length:null,revenue:known?round(sales.reduce((n,s)=>n+Number(s.revenue),0)):null,
    gross_margin:gross,margin:gross!=null&&spend!=null?round(gross-spend):null,
    cpa:known&&sales.length>0&&spend!=null?round(spend/sales.length):null,
    conversations:tracked.size,converted:enabled?converted.size:null,
    conversion:enabled&&tracked.size>0?round(converted.size/tracked.size*100):null,
    mature_conversations:matureConversations.size,mature_converted:enabled?matureConverted.size:null};
}
export function geographyAvailability(data:GeoData,binding:GeoBinding|null):GeoAvailability {
  const offers=(binding?.offers??[]).map(o=>({...o,available:data.stock.filter(s=>geoKey(s.measure)===geoKey(o.measure)
    && geoKey(s.brand)===geoKey(o.brand) && s.condition===o.condition).reduce((n,s)=>n+Number(s.available),0)}));
  const d=data.delivery;
  const coverage=!d?'Configuração de atendimento pendente':binding?.coverage==='pickup'?
    d.pickup_enabled?'Retirada habilitada':'Retirada pausada':binding?.coverage==='confirmed'?
    d.delivery_enabled?'Área da oferta confirmada':'Entregas pausadas':'Confirmar cobertura da oferta';
  const covered=!!d && ((binding?.coverage==='pickup'&&d.pickup_enabled)||(binding?.coverage==='confirmed'&&d.delivery_enabled));
  const available=offers.filter(o=>Number(o.available)>0).length;
  return {offers,coverage,state:!offers.length?'unknown':available===0?'unavailable':available<offers.length?'partial':covered?'available':'unknown'};
}
/** Regras transparentes de triagem. Não alteram anúncios e não prometem causalidade. */
export function decideGeography(c:Pick<GeoCampaign,'totals'|'previous'|'availability'|'meta'|'diagnostics'>,target:number,fresh:boolean):{decision:GeoDecision;reasons:string[]} {
  const t=c.totals,p=c.previous;
  if(!fresh)return {decision:'wait',reasons:['Atualize os dados antes de decidir sobre a verba.']};
  if(c.availability.state==='unavailable')return {decision:'pause_offer',reasons:['As ofertas vinculadas estão sem saldo disponível. Revisar somente os anúncios afetados.']};
  if(t.spend==null)return {decision:'wait',reasons:['Verba regional não identificada, vínculo fora da validade ou origem dos clientes divergente.']};
  if(t.sales==null||t.margin==null)return {decision:'wait',reasons:['Atribuição ou custo dos pneus incompleto.']};
  if(t.mature_conversations<10 || t.sales<5)return {decision:'wait',reasons:['Base inicial: aguardar mais conversas com a janela de atribuição de 7 dias encerrada.']};
  if(c.meta?.learning!== 'SUCCESS')return {decision:'wait',reasons:[c.meta?.learning?'Conjunto em aprendizado ou com aprendizado limitado.':'Fase de aprendizado ainda indisponível.']};
  if(c.meta.status!=='ACTIVE')return {decision:'wait',reasons:['Campanha sem entrega ativa confirmada na Meta.']};
  if(t.margin<0 && p.margin!=null && p.margin<0 && (p.sales??0)>=5)return {decision:'review',reasons:['Margem negativa nos dois períodos. Revisar a oferta e considerar redução ou pausa após verificar as vendas em aberto.']};
  if(t.margin<=0 || (t.cpa??Infinity)>target)return {decision:'review',reasons:['Margem ou custo por venda fora da meta; investigar antes de ampliar.']};
  const d=c.diagnostics;
  const fatigue=d.current?.frequency!=null&&d.previous?.frequency!=null&&d.current?.link_ctr!=null&&d.previous?.link_ctr!=null
    && d.current.frequency>d.previous.frequency*1.2 && d.current.link_ctr<d.previous.link_ctr*0.8;
  if(fatigue)return {decision:'review',reasons:['Frequência aumentou e a taxa de cliques no link caiu. Testar outro criativo antes de ampliar.']};
  if(c.availability.state!=='available')return {decision:'wait',reasons:['Confirme os produtos anunciados, o saldo e a cobertura antes de aumentar.']};
  if(d.current?.frequency==null||d.previous?.frequency==null||d.current?.link_ctr==null||d.previous?.link_ctr==null)
    return {decision:'wait',reasons:['Frequência e taxa de cliques ainda incompletas para comparar os períodos.']};
  if(t.sales>=10&&t.cpa!=null&&t.cpa<=target*0.8&&p.cpa!=null&&t.cpa<=p.cpa*1.1&&(p.margin??-1)>0)
    return {decision:'increase',reasons:['Margem positiva, custo abaixo da meta e estabilidade entre períodos. Estoque e atendimento da oferta verificados.']};
  return {decision:'maintain',reasons:['Resultado dentro da meta. Acompanhar a evolução antes de ampliar.']};
}
