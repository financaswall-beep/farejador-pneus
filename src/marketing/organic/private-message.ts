export const LOCATION_QUESTION = 'De onde você está falando, meu amigo?';
/** Uma oferta única é montada com os valores consultados, não com preço escrito pelo modelo. */
export function composePrivateOffer(body: string, snapshot: unknown): string {
  const offers: any[]=[];
  const collect=(value:any)=>{
    if(!value || typeof value!=='object' || value.erro)return;
    if(Array.isArray(value.produtos))offers.push(...value.produtos);
    if(Array.isArray(value.consultas_estoque))value.consultas_estoque.forEach(collect);
  };
  if(Array.isArray(snapshot))for(const call of snapshot)collect(call?.result);
  const unique=[...new Map(offers.filter(o=>o && typeof o.medida==='string').map(o=>[JSON.stringify(o),o])).values()];
  if(unique.length===1) {
    const p=unique[0],label=({meia_vida:'meia-vida',novo:'novo',remold:'remold'} as Record<string,string>)[p.condicao];
    if(p.disponivel===true && typeof p.preco==='number' && p.preco>0 && p.moeda==='BRL' && label) {
      return privateMessage(`Opa! Vi sua pergunta sobre o ${p.medida} 😊 Temos ${label} por ${p.preco.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})} aqui na 2W.`);
    }
  }
  // Não publica número monetário inventado nem uma confirmação de estoque sem consulta.
  const prices=[...body.matchAll(/R\$\s*([\d.]+(?:,\d{1,2})?)/g)].map(m=>Number(m[1]!.replace(/\./g,'').replace(',','.')));
  if(prices.some(n=>!unique.some(p=>p.disponivel===true && p.moeda==='BRL' && p.preco===n)))throw Error('organic_unverified_price');
  if(!unique.some(p=>p.disponivel===true) && /\b(temos|dispon[ií]vel|em estoque)\b/i.test(body))throw Error('organic_unverified_stock');
  return privateMessage(body.replace(LOCATION_QUESTION,'').trim());
}
export function privateMessage(body: string): string {
  const clean = body.trim();
  if (!clean || clean.length > 600 || /https?:|www\.|@[\w.]|\b\d{2}\s?9?\d{4}[- ]?\d{4}\b/i.test(clean)) {
    throw Error('organic_private_body_invalid');
  }
  // Uma única pergunta de fechamento. O corpo vem da decisão com consultas comerciais.
  return `${clean}\n\n${LOCATION_QUESTION}`;
}
export function privateReplyEligible(input: {
  action:string; commercial_intent:boolean; confidence_level:string; occurred_at:Date|string;
  activated_at:Date|string|null; removed:boolean;
}, now = new Date()): boolean {
  const at = new Date(input.occurred_at).getTime(), activated = input.activated_at ? new Date(input.activated_at).getTime() : NaN;
  return input.action==='reply' && input.commercial_intent && input.confidence_level==='high' && !input.removed
    && Number.isFinite(at) && at <= now.getTime() && now.getTime()-at < 7*86400_000 && at >= activated;
}
