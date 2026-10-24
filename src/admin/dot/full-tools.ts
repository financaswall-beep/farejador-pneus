import { z } from 'zod';
import { catalogInput,listFullSources } from './full-catalog.js';
import { recordsInput,readFullRecords } from './full-records.js';
import { fullReportInput,runFullReport } from './full-reports.js';
import { attachmentInput,readFullAttachment } from './full-attachments.js';
import { withDotReadOnly } from './read-only.js';
import { getMatrizLedgerStatement } from '../painel/matriz-ledger-statement.js';
import { readDotFinance } from './finance-read.js';
import { dotPeriod } from './period.js';
import { creativeInput,readFullCreative } from './full-creative.js';

export const statementInput=z.object({mes:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  base:z.enum(['competencia','caixa']).default('caixa'),pagina:z.number().int().min(1).max(1000000).default(1)}).strict();
export const fullSchemas={consultar_criativo_matriz:creativeInput,listar_fontes_matriz:catalogInput,consultar_registros_matriz:recordsInput,
  consultar_relatorio_painel:fullReportInput,consultar_anexo_matriz:attachmentInput,consultar_extrato_matriz:statementInput};
export type FullToolName=keyof typeof fullSchemas;
const page={type:'integer',minimum:1,maximum:1000000,default:1};
const field={type:'string',pattern:'^[a-z_][a-z0-9_]*$',maxLength:80};
export const fullDefinitions:[FullToolName,string,Record<string,object>,string[]][]=[
  ['consultar_criativo_matriz','Consulta texto, título e endereço seguro da imagem de um anúncio Meta próprio, conferido no cadastro da Matriz. Somente GET no provedor; não publica nem altera campanhas.',
    {anuncio_id:{type:'string',pattern:'^\\d{1,40}$'}},['anuncio_id']],
  ['listar_fontes_matriz','Catálogo de todas as consultas detalhadas autorizadas pelo proprietário, inclusive dados pessoais, salários e operação dos parceiros. Sem fonte lista áreas; com fonte informa campos e filtros. Comece aqui para localizar dados.',
    {fonte:{type:'string'},area:{type:'string'},busca:{type:'string'},pagina:page},[]],
  ['consultar_registros_matriz','Consulta os registros completos de uma fonte do catálogo, inclusive históricos, nomes, contatos, documentos, conversas, folha e financeiro dos parceiros. Escolha campos e filtre IDs/nomes/datas. Sem datas inclui todo histórico. Paginação obrigatória até proxima_pagina=null; somente leitura.',
    {fonte:{type:'string'},campos:{type:'array',items:field,minItems:1,maxItems:80},
      filtros:{type:'array',maxItems:12,items:{type:'object',properties:{campo:field,operador:{type:'string',enum:['igual','contem','nulo','nao_nulo']},
        valor:{type:['string','number','boolean']}},required:['campo'],additionalProperties:false}},
      campo_data:field,de:{type:'string',format:'date'},ate:{type:'string',format:'date'},ordenar_por:field,
      ordem:{type:'string',enum:['asc','desc']},pagina:page,limite:{type:'integer',minimum:1,maximum:50,default:25}},['fonte']],
  ['consultar_relatorio_painel','Relatórios completos do painel com custos, nomes e filtros originais. Use descrever=true para descobrir filtros; depois JSON para descobrir seções. Exportação CSV paginada por seção, sem criar arquivos públicos.',
    {relatorio:{type:'string',enum:['vendas','compras','estoque','financeiro','logistica','parceiros','demanda','faltas']},
      filtros:{type:'object',additionalProperties:{type:['string','number']}},secao:{type:'string'},pagina:page,
      formato:{type:'string',enum:['json','csv']},descrever:{type:'boolean'}},['relatorio']],
  ['consultar_anexo_matriz','Lê a imagem ou arquivo cadastrado, pelo ID da nota, evidência, anexo de mensagem ou mídia de marketing; foto_pneu usa ID da solicitação e indice da foto. Retorna conteúdo autenticado, sem criar links públicos. Vídeos de marketing retornam miniatura.',
    {tipo:{type:'string',enum:['nota_rota','nota_despesa','foto_pneu','evidencia_estoque','mensagem','marketing']},id:{type:'string',format:'uuid'},
      indice:{type:'integer',minimum:1,maximum:50},variante:{type:'string',enum:['original','miniatura']}},['tipo','id']],
  ['consultar_extrato_matriz','Extrato financeiro completo por lançamento, com descrição, origem, responsável, parcelas, estornos e saldos. Base caixa ou competência. Valores em reais e conciliação verificada.',
    {mes:{type:'string',pattern:'^\\d{4}-(0[1-9]|1[0-2])$'},base:{type:'string',enum:['competencia','caixa']},pagina:page},[]],
];
export async function runFullTool(name:FullToolName,raw:unknown):Promise<Record<string,unknown>> {
  if(name==='consultar_criativo_matriz')return readFullCreative(raw);
  if(name==='listar_fontes_matriz')return listFullSources(raw);
  if(name==='consultar_anexo_matriz')return readFullAttachment(raw);
  return withDotReadOnly(async db=>{
    if(name==='consultar_registros_matriz')return readFullRecords(db,raw);
    if(name==='consultar_relatorio_painel')return runFullReport(db,raw);
    const input=statementInput.parse(raw),month=dotPeriod({periodo:'mes',mes:input.mes}).month;
    const finance=await readDotFinance(db,month);
    if(!finance.available)return finance;
    const statement=await getMatrizLedgerStatement({period:month,basis:input.base,limit:50,offset:(input.pagina-1)*50},db);
    return {...statement,available:true,pagina:input.pagina,proxima_pagina:statement.total>input.pagina*50?input.pagina+1:null,
      conciliacao:finance.reconciliation,monetary_unit:'BRL'};
  });
}
