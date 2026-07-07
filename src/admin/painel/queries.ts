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
export * from './queries-parceiros.js'; // criar parceiro + candidaturas (aprovar/rejeitar)
export * from './queries-atacado-vendas.js'; // venda de atacado: compradores, ranking, registerWholesaleSale
export * from './queries-galpao.js'; // estoque do galpão por medida + resumos do atacado e do varejo
export * from './queries-galpao-movimentos.js'; // filme do galpão (0128): rótulo, baixa manual c/ motivo, leitura
export * from './queries-fornecedores.js'; // fornecedores + compras do galpão (registerWholesalePurchase)
export * from './queries-fornecedores-cancel.js'; // cancelar compra (0127) + arquivar fornecedor
export * from './queries-fiado-despesas.js'; // fiado do atacado (0115) + despesas da matriz (0120)
export * from './queries-atacado-cancelar.js'; // últimas vendas do atacado + cancelar venda (0116)
export * from './queries-comissoes.js'; // comissões como lançamento (0118): varredura, livro, quitar, termos
export * from './queries-financeiro-visao.js'; // visão consolidada do Financeiro da matriz (só leitura)
export * from './queries-logistica.js'; // logística (0121) leitura: entregas, rotas, status, falha
export * from './queries-logistica-rotas.js'; // logística ações: abrir/pendurar/remarcar/recolocar/fechar rota
export * from './queries-logistica-comprovantes.js'; // comprovantes da rota + leitura por IA (0121/0122)
export * from './queries-colaboradores.js'; // colaboradores da matriz (0124): CRUD + senha + revogar
export * from './queries-notificacoes.js'; // sino do painel: entregas falhadas + vencidos + galpão pra repor
export * from './queries-bot.js'; // tela do Bot: campainha (cliente esperando agora)
export * from './queries-bot-visao.js'; // tela do Bot fatia 2: visão (cards/funil/mapa/boca/radar)
