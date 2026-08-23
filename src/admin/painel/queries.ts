export * from './queries-stock-reconciliation.js';
export * from './queries-stock-physical-count.js';
export * from './queries-stock-condition-transfer.js';
export * from './queries-stock-brand-correction.js';
export * from './queries-rede-custos.js';
export * from './queries-marketing.js';
export * from './queries-marketing-campaigns.js';
export * from './queries-marketing-campaign-detail.js';
export * from './queries-marketing-integrations.js';
export * from './queries-marketing-journeys.js';
export * from './queries-catalogo.js';
export * from './queries-vendas-marcas.js';

/**
 * Banco da MATRIZ — PORTA DE ENTRADA (obra 300, 2026-07-05).
 *
 * O arquivo de 3.276 linhas foi fatiado em 16 módulos por ASSUNTO
 * (queries-*.ts, todos ≤300 — fiscal checar-tamanho). Este barrel re-exporta
 * TUDO: quem importa './queries.js' / '../painel/queries.js' não muda uma linha.
 * Função nova entra no MÓDULO do assunto (ou módulo novo), nunca aqui.
 */
export * from './queries-pedidos.js'; // tipos de pedido + getPainelPedidos/Produtos + período/fuso do painel
export * from './queries-rede.js'; // getPainelRede — o agregado por parceiro da página Rede
export * from './queries-rede-resumo.js'; // funil da Rede + resumo da matriz (getMatrizResumo)
export * from './queries-pedidos-acoes.js'; // registrar pedido manual/walk-in + cancelar + raio de entrega
export * from './queries-pickups.js'; // fila e etapas de retirada da Matriz
export * from './queries-parceiros.js'; // criação transacional de parceiro
export * from './queries-parceiros-rede.js'; // 0165: chave "recebe pedidos da Rede" (só sistema)
export * from './queries-candidaturas.js'; // candidatura atômica/idempotente (Etapa 6)
export * from './queries-atacado-buyers.js'; // compradores e ranking do atacado
export * from './queries-atacado-vendas.js'; // registro transacional da venda de atacado
export * from './queries-partner-transfer-arrival.js'; // acerto por pneu e carga em transito
export * from './queries-partner-cargo.js'; // carga recusada e retorno fisico
export * from './queries-galpao.js'; // estoque do galpão por medida + resumos do atacado e do varejo
export * from './queries-galpao-movimentos.js'; // filme do galpão (0128): rótulo, baixa manual c/ motivo, leitura
export * from './queries-galpao-removal.js'; // remoção auditada da variante + conciliação financeira
export * from './queries-galpao-filme.js';
export * from './queries-galpao-medidas.js';
export * from './queries-fornecedores.js'; // fornecedores + compras do galpão (registerWholesalePurchase)
export * from './queries-fornecedores-cancel.js'; // cancelar compra (0127) + arquivar fornecedor
export * from './queries-fiado-despesas.js'; // fiado do atacado (0115) + despesas da matriz (0120)
export * from './queries-despesas-categorias.js'; // modalidades de despesa cadastráveis pelo dono (0130)
export * from './queries-atacado-cancelar.js'; // últimas vendas do atacado + cancelar venda (0116)
export * from './queries-comissoes.js'; // comissões como lançamento (0118): varredura, livro, quitar, termos
export * from './queries-comissoes-acoes.js'; // Etapa 6: liquidação/termos atômicos e idempotentes
export * from './queries-comissoes-estornos.js'; // 0146: devolução de comissão recebida e estornada
export * from './queries-mensalidades.js'; // 0151: mensalidade por competência, geração e baixa
export * from './queries-financeiro-visao.js'; // visão consolidada do Financeiro da matriz (só leitura)
export * from './queries-financeiro-verdade.js'; // Etapa 4: competência × caixa × posição + conciliação
export * from './queries-financeiro-read-switch.js'; // Etapa 7: chave de leitura + rollback
export * from './queries-compras-relatorios.js'; // Compras: relatórios conciliados, paginação e preço histórico
export * from './queries-logistica.js'; // logística (0121) leitura: entregas, rotas, status, falha
export * from './queries-logistica-rotas.js'; // logística ações: abrir/pendurar/remarcar/recolocar/fechar rota
export * from './queries-logistica-comprovantes.js'; // comprovantes da rota + leitura por IA (0121/0122)
export * from './queries-logistica-comprovantes-review.js'; // Etapa 7: tentativas + decisão humana
export * from './queries-logistica-comprovantes-decision.js'; // Etapa 7: aprovação/rejeição atômica
export * from './queries-logistica-comprovantes-repair.js'; // 0145: protege e repara despesa terminal vinculada
export * from './queries-colaboradores.js'; // colaboradores da matriz (0124): cadastro (list/criar/função)
export * from './queries-colaboradores-acesso.js'; // ciclo de acesso (0132): papel do painel, revogar/reativar, senha
export * from './queries-colaboradores-gestao.js'; // visão integrada: equipe/remuneração/comissão/desempenho
export * from './queries-colaboradores-folha.js'; // ajustes, fechamento e pagamento conciliado com Financeiro
export * from './queries-notificacoes.js'; // sino do painel: entregas falhadas + vencidos + galpão pra repor
export * from './queries-bot.js'; // tela do Bot: campainha (cliente esperando agora)
export * from './queries-bot-resilience.js'; // Etapa 8: outbox/DLQ sem payload sensivel
export * from './queries-clientes.js'; // CRM da matriz: clientes/leads/compradores/recompra/parceiros
export * from './queries-bot-visao.js'; // tela do Bot fatia 2: visão (cards/funil/mapa/boca/radar)
export * from './queries-bot-movimento.js'; // visão diária/semanal do movimento do Bot
