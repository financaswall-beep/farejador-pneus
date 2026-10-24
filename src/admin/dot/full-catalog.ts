import { z } from 'zod';
import { commerceSources } from './full-sources-commerce.js';
import { networkSources } from './full-sources-network.js';
import { financeSources } from './full-sources-finance.js';
import { coreSources } from './full-sources-core.js';
import { analyticsSources } from './full-sources-analytics.js';
import { agentSources } from './full-sources-agent.js';
import { marketingSources } from './full-sources-marketing.js';
import { opsSources } from './full-sources-ops.js';

export const fullSources=[...commerceSources,...networkSources,...financeSources,...coreSources,
  ...analyticsSources,...agentSources,...marketingSources,...opsSources];
// This view calculates campaign totals from owned ads; raw provider aggregates may mix businesses.
fullSources.find(s=>s.key==='marketing.meta_insights_daily')!.table='marketing.meta_insights_daily_scoped';
export const fullSourceMap=new Map(fullSources.map(s=>[s.key,s]));
export const fullAreas=[...new Set(fullSources.map(s=>s.area))].sort();
export const catalogInput=z.object({fonte:z.string().max(100).optional(),area:z.string().max(40).optional(),
  busca:z.string().trim().max(80).default(''),pagina:z.number().int().min(1).max(1000000).default(1)}).strict();
const titles:Record<string,string>={customers:'Clientes da Matriz',contacts:'Contatos do atendimento',conversations:'Conversas',
  messages:'Mensagens e notas internas',message_attachments:'Anexos de conversas',orders:'Pedidos, entregas e retiradas',
  order_items:'Itens dos pedidos',partner_customers:'Clientes dos parceiros',partner_orders:'Vendas dos parceiros',
  partner_messages:'Mensagens dos parceiros',wholesale_suppliers:'Fornecedores',wholesale_customers:'Compradores do atacado',
  matriz_collaborators:'Colaboradores da Matriz',matriz_payroll_items:'Folha individual da Matriz',
  partner_payroll_items:'Folha individual dos parceiros',matriz_delivery_trips:'Rotas de entrega',
  matriz_trip_receipts:'Notas fiscais das rotas',matriz_expense_receipts:'Comprovantes de despesas',
  matriz_ledger_transactions:'Lançamentos do livro financeiro',publisher_posts:'Publicações e legendas',
  publisher_media:'Fotos e vídeos de marketing',meta_comments:'Comentários das redes sociais',
  partner_access_tokens:'Cadastros de colaboradores dos parceiros (sem credenciais)',partner_people:'Usuários (sem credenciais)'};
export function listFullSources(raw:unknown) {
  const input=catalogInput.parse(raw);
  if(input.fonte) {
    const source=fullSourceMap.get(input.fonte);if(!source)throw Error('unknown_source');
    return {fonte:source.key,area:source.area,descricao:titles[source.key.split('.')[1]!]??source.key,
      campos:source.fields,campos_filtraveis:source.scalar,campos_de_data:source.dates,
      escopo:source.scope?'Conta Chatwoot configurada no ambiente atual':'Todas as unidades do ambiente atual, acesso do proprietário',
      uso:'consultar_registros_matriz: escolha fonte, campos e filtros. IDs relacionam registros; ex.: order_id, customer_id, collaborator_id, trip_id.',
      anexos:'Use consultar_anexo_matriz para comprovantes, fotos de pneus, evidências de estoque, mensagens e mídia de marketing.'};
  }
  if(input.area&&!fullAreas.includes(input.area))throw Error('unknown_area');
  const search=input.busca.toLocaleLowerCase('pt-BR');
  const rows=fullSources.map(s=>({fonte:s.key,area:s.area,descricao:titles[s.key.split('.')[1]!]??s.key,quantidade_campos:s.fields.length}))
    .filter(s=>(!input.area||s.area===input.area)&&(!search||JSON.stringify(s).toLocaleLowerCase('pt-BR').includes(search)));
  const offset=(input.pagina-1)*25;
  return {areas:fullAreas,total:rows.length,pagina:input.pagina,proxima_pagina:rows.length>offset+25?input.pagina+1:null,
    fontes:rows.slice(offset,offset+25),instrucoes:'Informe fonte nesta consulta para conhecer campos e filtros. Listas paginadas; percorra proxima_pagina até null.',
    limites:'Somente dados de negócio. Credenciais, sessões, payloads técnicos e dados apagados por privacidade não são disponibilizados.'};
}
