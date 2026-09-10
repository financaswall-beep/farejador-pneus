export const stockGroupKey=(row:{measure:string;condition:string})=>JSON.stringify([row.measure.trim().toUpperCase(),row.condition]);
const sources:Record<string,{label:string;category:string}>= {
  compra:{label:'Recebimento de compra',category:'purchase'},cancelamento_compra:{label:'Cancelamento de compra',category:'purchase'},
  venda_atacado:{label:'Venda de atacado',category:'sale'},varejo:{label:'Venda de varejo',category:'sale'},
  cancelamento_venda:{label:'Devolução de atacado',category:'return'},cancelamento_varejo:{label:'Devolução de varejo',category:'return'},
  definir:{label:'Conferência / ajuste',category:'adjustment'},entrada:{label:'Entrada manual',category:'adjustment'},
  baixa_manual:{label:'Baixa manual',category:'adjustment'},remocao:{label:'Remoção do cadastro',category:'adjustment'},
  correcao_marca:{label:'Correção de marca',category:'adjustment'},correcao_condicao:{label:'Correção de condição',category:'adjustment'},
};
export const stockMovementSource=(source:string)=>sources[source]??{label:'Outro movimento',category:'other'};
export function stockStatus(row:{available:number;incoming:number;suggested:number|null;minimum:number|null;sold:number}) {
  if(row.available===0)return 'zero';
  if(row.suggested!==null&&row.suggested>0)return 'replenish';
  if(row.minimum!==null&&row.available<row.minimum&&row.incoming>0)return 'incoming';
  if(row.minimum===null)return 'no_minimum';
  if(row.sold===0)return 'no_sales';
  return 'healthy';
}
export const stockStatusLabels:Record<string,string>={zero:'Sem disponível',replenish:'Repor',incoming:'Aguardando chegada',
  no_minimum:'Sem mínimo',no_sales:'Sem saída no período',healthy:'Adequado'};
