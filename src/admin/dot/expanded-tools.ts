import type { Pool } from 'pg';
import { z } from 'zod';
import { pageInput, readContext, type DotReadContext } from './read-model.js';
import { readDotRetail, readDotWholesale } from './sales-read.js';
import { readDotMovements, readDotLots, readDotCatalog } from './inventory-read.js';
import { readDotPurchases } from './purchases-read.js';
import { readDotTrips, readDotPickups, readDotExpenses } from './logistics-read.js';
import { readDotNetwork, readDotApplications } from './network-read.js';
import { readDotCustomers } from './customers-read.js';
import { readDotBot } from './bot-read.js';
import { readDotTeam } from './team-read.js';
import { readDotMarketing } from './marketing-read.js';
import { readDotHealth, readDotNotifications } from './health-read.js';

function tool<T extends z.AnyZodObject>(description:string,schema:T,
  read:(ctx:DotReadContext,input:z.infer<T>)=>Promise<Record<string,unknown>>) {
  return {description,schema,run:async(db:Pool,raw:unknown)=>{
    const input=schema.parse(raw),base=pageInput.parse({periodo:input.periodo,mes:input.mes,pagina:input.pagina,
      referencia:input.referencia,medida:input.medida});
    const ctx=readContext(db,base);
    return {period:ctx.period,...await read(ctx,input)};
  }};
}
const simple=(description:string,read:(ctx:DotReadContext)=>Promise<Record<string,unknown>>)=>tool(description,pageInput,read);
const views=<const T extends [string,...string[]]>(values:T)=>pageInput.extend({visao:z.enum(values).default(values[0])}).strict();
export const expandedTools={
  consultar_varejo_matriz:simple('Histórico dos pedidos de varejo da Matriz e seus itens, descontos, valores e situação. Até 50 pedidos/página.',readDotRetail),
  consultar_atacado_matriz:tool('Vendas do atacado, compradores por código e medidas vendidas. Custos pendentes e trânsito não são lucro realizado.',
    views(['vendas','compradores','medidas','inativos']),(ctx,input)=>readDotWholesale(ctx,input.visao)),
  consultar_movimentos_estoque_matriz:simple('Entradas, saídas, perdas e contagens do estoque físico da Matriz, com custos e quantidades.',readDotMovements),
  consultar_lotes_matriz:tool('Lotes de pneus: posição atual, origem, movimentos/separações e vendas. Referência é o código UUID do lote.',
    views(['lotes','movimentos','vendas']),(ctx,input)=>readDotLots(ctx,input.visao)),
  consultar_catalogo_matriz:tool('Produtos, preços de varejo/atacado, custos, aplicações verificadas e histórico de preços da Matriz.',
    views(['produtos','compatibilidade','historico_precos']),(ctx,input)=>readDotCatalog(ctx,input.visao)),
  consultar_compras_matriz:tool('Compras, recebimentos, parcelas, pedidos de compra, fornecedores por código e comparação de custos.',
    views(['compras','pedidos','fornecedores','precos']),(ctx,input)=>readDotPurchases(ctx,input.visao)),
  consultar_despesas_matriz:tool('Despesas operacionais, categorias e metadados de comprovantes. Sem fotos, descrições pessoais ou pagamentos individuais da equipe.',
    views(['despesas','comprovantes','categorias']),(ctx,input)=>readDotExpenses(ctx,input.visao)),
  consultar_rotas_matriz:simple('Rotas da Matriz: situação, paradas, quilômetros, combustível informado e despesas aprovadas. Entregador por código.',readDotTrips),
  consultar_retiradas_matriz:simple('Reservas abertas e retiradas do período: aguardando, cliente chegou, instalação ou retirada concluída.',readDotPickups),
  consultar_rede_matriz:tool('Relacionamento comercial da Matriz com a Rede: lojas, termos, comissões, mensalidades e pedidos originados pela Rede. Sem financeiro privado das lojas.',
    views(['lojas','comissoes','mensalidades','funil']),(ctx,input)=>readDotNetwork(ctx,input.visao)),
  consultar_candidaturas_matriz:simple('Solicitações de novas lojas por código, situação e datas da análise, sem contatos ou documentos pessoais.',readDotApplications),
  consultar_clientes_matriz:tool('Compras realizadas na Matriz por cliente anônimo; etapas e oportunidades do atendimento da Rede. Sem cadastros pessoais nem conversas.',
    views(['compras','etapas','oportunidades']),(ctx,input)=>readDotCustomers(ctx,input.visao)),
  consultar_bot_matriz:tool('Conversão diária, demanda por medida, faltas e fila de espera agregada da Rede. Sem mensagens ou dados pessoais.',
    views(['conversao','demanda','faltas','espera']),(ctx,input)=>readDotBot(ctx,input.visao)),
  consultar_marketing_matriz:tool('Métricas persistidas das campanhas próprias Meta/Google, anúncios, atribuição, regiões e situação das publicações. Fonte sem dados não é zero.',
    views(['campanhas','anuncios','google','publicacoes','regioes','atribuicao']),(ctx,input)=>readDotMarketing(ctx,input.visao)),
  consultar_equipe_matriz:simple('Desempenho da equipe por código e resumo mensal de folha/comissões. Sem identidade, salário individual ou dados de pagamento.',readDotTeam),
  consultar_notificacoes_matriz:simple('Pendências atuais do painel, entregas com problema, comprovantes, estoque, bot e contas. Não envia notificações.',readDotNotifications),
  consultar_saude_matriz:simple('Estado registrado da ingestão, filas do bot, sincronização e conferência financeira. Sem logs, payloads ou segredos.',readDotHealth),
};
export type ExpandedToolName=keyof typeof expandedTools;
