import { z } from 'zod';
import { periodInput } from './period.js';
import type { DotToolName } from './consultations.js';

export const reportInput=periodInput.extend({area:z.enum(['varejo','atacado','compras','estoque','financeiro','demanda','rede','logistica']),
  pagina:z.number().int().min(1).max(10000).default(1)}).strict();
export function reportTarget(input:z.infer<typeof reportInput>):{name:DotToolName;input:object;area:string} {
  const period={periodo:input.periodo,mes:input.mes,pagina:input.pagina};
  const targets={varejo:'consultar_varejo_matriz',atacado:'consultar_atacado_matriz',compras:'consultar_compras_matriz',
    demanda:'consultar_bot_matriz',rede:'consultar_rede_matriz',logistica:'consultar_rotas_matriz'} as const;
  if(input.area==='estoque')return {name:'consultar_estoque_matriz',input:{pagina:input.pagina},area:input.area};
  if(input.area==='financeiro') {
    if(input.periodo!=='mes')throw new Error('finance_report_requires_month');
    return {name:'consultar_financeiro_matriz',input:{mes:input.mes},area:input.area};
  }
  return {name:targets[input.area],input:{...period,...(input.area==='demanda'?{visao:'demanda'}:{})},area:input.area};
}
