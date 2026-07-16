// Fatia 07-14 (fiscal 300): a MONTAGEM saiu do app.js — lá fica só o ESTADO.
// Junta o ESTADO + as fábricas num objeto SÓ — o mesmo `this` pra todo mundo;
// nenhum módulo tem estado próprio. Object.getOwnPropertyDescriptors preserva
// getters VIVOS (reatividade). ⚠️ NUNCA trocar por spread ({ ...f() }): spread
// EXECUTA o getter e congela o valor — a tela para de reagir.
// A ordem do array é a ordem do arquivo original (obra 300): DOCUMENTADA E FIXA.
// Módulo novo? Além daqui: <script> no index.html + lista fixa do route-static.ts
// (404 no módulo derruba o Alpine INTEIRO — painel branco).
window.PAINEL_MONTAR = function (estado) {
  const fabricas = [
    window.PAINEL_MODULES.nav, // app.nav.js (linhas 208-262 pré-obra): título/menu/badge + seleção de unidade (abrir/voltar)
    window.PAINEL_MODULES.redeKpis, // app.rede.kpis.js (linhas 263-455 pré-obra): derivadas da Rede: metas, séries, totais, rankings, alertas
    window.PAINEL_MODULES.unidadeKpis, // app.unidade.kpis.js (linhas 456-549 pré-obra): derivadas da unidade + classes de status + saúde (score)
    window.PAINEL_MODULES.vendaModal, // app.venda.modal.js (linhas 550-604 pré-obra): modal de venda manual/walk-in + período e meta da Rede
    window.PAINEL_MODULES.api, // app.api.js (linhas 605-704 pré-obra): credenciais + apiGet/Post/Put + salvar raio de entrega
    window.PAINEL_MODULES.format, // app.format.js (linhas 705-768 pré-obra): moeda/data/tempo/iniciais + widgets do form de venda
    window.PAINEL_MODULES.varejo, // app.varejo.js (linhas 769-843 pré-obra): pedidos do varejo + resumo do varejo (0117) + períodos
    window.PAINEL_MODULES.vendasHistorico, // histórico unificado: filtros, cards, paginação, detalhes e CSV
    window.PAINEL_MODULES.comissoes, // app.comissoes.js (linhas 844-914 pré-obra): comissões da Rede (0118): carregar/quitar/alarme/termos
    window.PAINEL_MODULES.atacado, // app.atacado.js (linhas 915-1058 pré-obra): venda de atacado: form, status, submit, ranking de recompra
    window.PAINEL_MODULES.compras, // app.compras.js (linhas 1059-1232 pré-obra): compras/fornecedores + fiado (0115) + loads financeiro/despesas
    window.PAINEL_MODULES.logistica, // app.logistica.js (linhas 1233-1405 pré-obra): logística (0121) leitura: cards, rota, datas D+1, deep-links
    window.PAINEL_MODULES.logisticaResultado, // memória de cálculo e detalhamento do resultado por rota
    window.PAINEL_MODULES.logisticaAcoes, // app.logistica.acoes.js (linhas 1406-1530 pré-obra): logística ações: remarcar/pendurar/abrir/fechar rota/comprovante IA
    window.PAINEL_MODULES.colaboradores, // app.colaboradores.js (linhas 1531-1629 pré-obra): colaboradores da matriz (0124): criar/função/senha/revogar
    window.PAINEL_MODULES.colaboradoresGestao, // 0133: remuneração, comissão, folha e desempenho
    window.PAINEL_MODULES.sino, // app.sino.js (2026-07-06): sino vivo — getter notificacoes derivado + lidas em localStorage
    window.PAINEL_MODULES.bot, // app.bot.js (2026-07-06): tela do Bot — campainha/visão/deep-link Chatwoot
    window.PAINEL_MODULES.botMapa, // app.bot.mapa.js (2026-07-06): desenho do mapa IBGE pintado por camada
    window.PAINEL_MODULES.clientes, // CRM da matriz: clientes/leads/compradores/recompra/parceiros
    window.PAINEL_MODULES.financeiro, // app.financeiro.js (linhas 1630-1743 pré-obra): aba Financeiro — visão geral + cobranças + Recebi/Paguei
    window.PAINEL_MODULES.financeiroIndicadores, // app.financeiro.indicadores.js (fatia 07-14): fluxo de caixa + análise + inadimplência
    window.PAINEL_MODULES.financeiroDespesas, // app.financeiro.despesas.js (fatia 07-14): despesas (0120/0130) — form, modalidades, extrato
    window.PAINEL_MODULES.galpao, // app.galpao.js (linhas 1744-1859 pré-obra): estoque do galpão por medida: busca, custo médio, entrada
    window.PAINEL_MODULES.redeApply, // app.rede.apply.js (linhas 1860-2097 pré-obra): mapeadores do payload da Rede (applyRede/applyMatrizResumo)
    window.PAINEL_MODULES.pedidosParceiros, // app.pedidos.parceiros.js (linhas 2098-2248 pré-obra): pedido manual + novo parceiro + candidaturas (Etapa 3)
    window.PAINEL_MODULES.core, // app.core.js (linhas 2249-2419 pré-obra): encanamento: loadRealData/loadRedeData/init/live refresh
    window.PAINEL_MODULES.chartsRede, // app.charts.rede.js (linhas 2420-2617 pré-obra): gráficos da Rede: vendas, lucro, pneus
    window.PAINEL_MODULES.chartsSaude, // app.charts.saude.js (linhas 2618-2851 pré-obra): gráficos: origem, saúde, compras, estoque parado, margem
    window.PAINEL_MODULES.chartsUnidade, // app.charts.unidade.js (linhas 2852-3000 pré-obra): gráficos da unidade + chartOptions + renderChart genérico
  ];
  const out = estado;
  for (const f of fabricas) {
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()));
  }
  return out;
};
