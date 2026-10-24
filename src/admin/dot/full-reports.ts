import { z } from 'zod';
import type { Pool } from 'pg';
import { readFullReport,fullReportSchemas } from './full-report-readers.js';
const reports=['vendas','compras','estoque','financeiro','logistica','parceiros','demanda','faltas'] as const;
export const fullReportInput=z.object({relatorio:z.enum(reports),filtros:z.record(z.union([z.string().max(200),z.number().finite()])).default({}),
  secao:z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/).max(100).optional(),
  pagina:z.number().int().min(1).max(1000000).default(1),formato:z.enum(['json','csv']).default('json'),
  descrever:z.boolean().default(false)}).strict();
function describe(schema:z.ZodTypeAny):unknown {
  if(schema instanceof z.ZodDefault)return {padrao:schema._def.defaultValue(),tipo:describe(schema._def.innerType)};
  if(schema instanceof z.ZodOptional)return {opcional:true,tipo:describe(schema._def.innerType)};
  if(schema instanceof z.ZodEffects)return describe(schema.innerType());
  if(schema instanceof z.ZodObject)return Object.fromEntries(Object.entries(schema.shape).map(([k,v])=>[k,describe(v as z.ZodTypeAny)]));
  if(schema instanceof z.ZodEnum)return schema.options;
  if(schema instanceof z.ZodUnion)return schema.options.map(describe);
  return schema._def.typeName;
}
function sections(value:unknown,path='',out:{secao:string;total:number}[]=[]) {
  if(Array.isArray(value)){out.push({secao:path,total:value.length});return out;}
  if(value&&typeof value==='object')for(const [key,child] of Object.entries(value))sections(child,path?path+'.'+key:key,out);
  return out;
}
function page(value:unknown,index:number):unknown {
  if(Array.isArray(value))return {total:value.length,pagina:index,proxima_pagina:value.length>index*50?index+1:null,
    registros:value.slice((index-1)*50,index*50)};
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,page(v,index)]));
  return value;
}
const cell=(value:unknown)=>{let text=typeof value==='object'?JSON.stringify(value):String(value??'');
  if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
export async function runFullReport(db:Pool,raw:unknown) {
  const input=fullReportInput.parse(raw);
  if(input.descrever)return {relatorio:input.relatorio,filtros:describe(fullReportSchemas[input.relatorio]),
    instrucoes:'Informe filtros do painel; datas from/to usam YYYY-MM-DD. Consulte em JSON para descobrir seções. CSV exporta uma seção por página.'};
  const report=await readFullReport(db,input.relatorio,input.filtros),lists=sections(report);
  let selected:unknown=report;
  if(input.secao)for(const key of input.secao.split('.')) {
    if(!selected||typeof selected!=='object'||!Object.hasOwn(selected,key))throw Error('unknown_report_section');
    selected=(selected as Record<string,unknown>)[key];
  }
  const payload=page(selected,input.pagina);
  if(Buffer.byteLength(JSON.stringify(payload))>2*1024*1024)throw Error('report_too_large_select_section');
  if(input.formato==='csv') {
    if(!input.secao||!Array.isArray(selected))throw Error('csv_requires_list_section');
    const rows=selected.slice((input.pagina-1)*50,input.pagina*50),headers=[...new Set(rows.flatMap(r=>Object.keys(r)))];
    return {relatorio:input.relatorio,secao:input.secao,formato:'csv',total:selected.length,pagina:input.pagina,
      proxima_pagina:selected.length>input.pagina*50?input.pagina+1:null,
      conteudo:[headers,...rows.map(r=>headers.map(k=>r[k]))].map(r=>r.map(cell).join(';')).join('\r\n')};
  }
  return {relatorio:input.relatorio,secoes:lists,resultado:payload,
    aviso:'Mesmas regras de cálculo do painel, acesso do proprietário. Todas as listas são paginadas; não some páginas incompletas. Para uma lista completa use a seção export_* quando disponível.'};
}
