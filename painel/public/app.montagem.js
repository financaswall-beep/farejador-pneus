// Fatia 07-14 (fiscal 300): a MONTAGEM saiu do app.js — lá fica só o ESTADO.
// Junta o ESTADO + as fábricas num objeto SÓ — o mesmo `this` pra todo mundo;
// nenhum módulo tem estado próprio. Object.getOwnPropertyDescriptors preserva
// getters VIVOS (reatividade). ⚠️ NUNCA trocar por spread ({ ...f() }): spread
// EXECUTA o getter e congela o valor — a tela para de reagir.
// A ordem do array é a ordem do arquivo original (obra 300): DOCUMENTADA E FIXA.
// Módulo novo? Além daqui: <script> no index.html + lista fixa do route-static.ts
// (404 no módulo derruba o Alpine INTEIRO — painel branco).
window.PAINEL_MONTAR = function (estado) {
  const colisoesPermitidas = new Set([
    'comprasResumo:compras->comprasRelatorios',
  ]);
  const fabricas = [
    window.PAINEL_MODULES.nav, // app.nav.js (linhas 208-262 pré-obra): título/menu/badge + seleção de unidade (abrir/voltar)
    window.PAINEL_MODULES.redeKpis, // app.rede.kpis.js (linhas 263-455 pré-obra): derivadas da Rede: metas, séries, totais, rankings, alertas
    window.PAINEL_MODULES.redeOperacao, // app.rede.operacao.js (23/07): apresentação padrão de Operação e saúde + fallback legado explícito
    window.PAINEL_MODULES.redeCanario, // flag owner-only + saúde técnica do painel moderno por unidade
    window.PAINEL_MODULES.unidadeKpis, // app.unidade.kpis.js (linhas 456-549 pré-obra): derivadas da unidade + classes de status + saúde (score)
    window.PAINEL_MODULES.vendaModal, // app.venda.modal.js (linhas 550-604 pré-obra): modal de venda manual/walk-in + período e meta da Rede
    window.PAINEL_MODULES.partnerApi, // sessão ps_ e cliente HTTP exclusivo de /parceiro/:slug/api
    window.PAINEL_MODULES.api, // app.api.js (linhas 605-704 pré-obra): credenciais + apiGet/Post/Put + salvar raio de entrega
    window.PAINEL_MODULES.municipios, // catálogo oficial + chips de cobertura
    window.PAINEL_MODULES.format, // app.format.js (linhas 705-768 pré-obra): moeda/data/tempo/iniciais + widgets do form de venda
    window.PAINEL_MODULES.varejo, // app.varejo.js (linhas 769-843 pré-obra): pedidos do varejo + resumo do varejo (0117) + períodos
    window.PAINEL_MODULES.vendasMarcas, // ranking de marcas por vendas confirmadas da Matriz
    window.PAINEL_MODULES.vendasHistorico, // histórico unificado: filtros, cards, paginação, detalhes e CSV
    window.PAINEL_MODULES.comissoes, // app.comissoes.js (linhas 844-914 pré-obra): comissões da Rede (0118): carregar/quitar/alarme/termos
    window.PAINEL_MODULES.atacado, // app.atacado.js (linhas 915-1058 pré-obra): venda de atacado: form, status, submit, ranking de recompra
    window.PAINEL_MODULES.atacadoTransfer, // ponte Matriz → parceiro e acréscimos após a saída
    window.PAINEL_MODULES.compras, // app.compras.js (linhas 1059-1232 pré-obra): compras/fornecedores + fiado (0115) + loads financeiro/despesas
    window.PAINEL_MODULES.comprasRelatorios, // histórico paginado + fornecedores + preços, sem fonte financeira paralela
    window.PAINEL_MODULES.comprasPrecos, // busca local + histórico real por compra na comparação de preços
    window.PAINEL_MODULES.comprasReposicao, // relatório sob demanda: mínimo - disponível - em trânsito
    window.PAINEL_MODULES.comprasReposicaoPdf, // PDF A4 do mesmo plano revisado na tela
    window.PAINEL_MODULES.comprasHistorico, // indicadores, gráficos e análise do custo médio
    window.PAINEL_MODULES.comprasAcoes, // Etapa 5: mutacoes com idempotencia persistente
    window.PAINEL_MODULES.logistica, // app.logistica.js (linhas 1233-1405 pré-obra): logística (0121) leitura: cards, rota, datas D+1, deep-links
    window.PAINEL_MODULES.logisticaResultado, // memória de cálculo e detalhamento do resultado por rota
    window.PAINEL_MODULES.logisticaComprovantes, // Etapa 7: revisão humana e idempotente
    window.PAINEL_MODULES.logisticaAcoes, // app.logistica.acoes.js (linhas 1406-1530 pré-obra): logística ações: remarcar/pendurar/abrir/fechar rota/comprovante IA
    window.PAINEL_MODULES.colaboradores, // app.colaboradores.js (linhas 1531-1629 pré-obra): colaboradores da matriz (0124): criar/função/senha/revogar
    window.PAINEL_MODULES.colaboradoresPayroll, // processo da folha: validações, histórico e ligação com contas a pagar
    window.PAINEL_MODULES.colaboradoresGestao, // 0133: remuneração, comissão, folha e desempenho
    window.PAINEL_MODULES.colaboradoresPermissions, // acesso ao painel, allowlist operacional e sessões
    window.PAINEL_MODULES.colaboradoresFinance, // remuneração e comissão unificadas, com gravação atômica
    window.PAINEL_MODULES.colaboradoresPerformance, // desempenho operacional comum à Matriz e ao parceiro
    window.PAINEL_MODULES.sino, // app.sino.js (2026-07-06): sino vivo — getter notificacoes derivado + lidas em localStorage
    window.PAINEL_MODULES.bot, // app.bot.js (2026-07-06): tela do Bot — campainha/visão/deep-link Chatwoot
    window.PAINEL_MODULES.botMovimento, // recorte diário/semanal único dos movimentos do Bot
    window.PAINEL_MODULES.botMapa, // app.bot.mapa.js (2026-07-06): desenho do mapa IBGE pintado por camada
    window.PAINEL_MODULES.clientes, // CRM da matriz: clientes/leads/compradores/recompra/parceiros
    window.PAINEL_MODULES.clientesKanban, // movimento, arquivamento recuperavel e paginacao por coluna
    window.PAINEL_MODULES.clientesLeadsUi, // fotos Chatwoot, canais e ficha lateral da Matriz
    window.PAINEL_MODULES.clientesIdentity, // Etapa 9: identidade/revisão/privacidade owner-only
    window.PAINEL_MODULES.marketing, // Marketing: visão inicial + Meta read-only + qualidade da atribuição
    window.PAINEL_MODULES.marketingChart, // Marketing: gráfico diário de investimento e conversas
    window.PAINEL_MODULES.marketingCampaigns, // Marketing: campanhas read-only e filtro real por canal
    window.PAINEL_MODULES.marketingCampaignDetail, // Marketing: detalhe real após clicar em uma campanha
    window.PAINEL_MODULES.marketingJourneys, // Marketing: jornada Meta → CTWA → analytics → venda
    window.PAINEL_MODULES.marketingIntegrations, // Marketing: conexões, rastreamento e auditoria read-only
    window.PAINEL_MODULES.financeiro, // app.financeiro.js (linhas 1630-1743 pré-obra): aba Financeiro — visão geral + cobranças + Recebi/Paguei
    window.PAINEL_MODULES.financeiroBaixas, // baixa auditável e extrato do livro central
    window.PAINEL_MODULES.financeiroIndicadores, // app.financeiro.indicadores.js (fatia 07-14): fluxo de caixa + análise + inadimplência
    window.PAINEL_MODULES.financeiroDespesas, // app.financeiro.despesas.js (fatia 07-14): despesas (0120/0130) — form, modalidades, extrato
    window.PAINEL_MODULES.galpaoContagem, // contagem física auditável do estoque oficial
    window.PAINEL_MODULES.galpaoAjuste, // motivo e prévia financeira do ajuste manual
    window.PAINEL_MODULES.galpaoMultibrand, // identidade medida+marca+condição, custos e reposição
    window.PAINEL_MODULES.galpaoCorrecao, // transfere condição com trilha, sem editar histórico
    window.PAINEL_MODULES.galpao, // app.galpao.js (linhas 1744-1859 pré-obra): estoque do galpão por medida: busca, custo médio, entrada
    window.PAINEL_MODULES.catalogo,
    window.PAINEL_MODULES.catalogoBootstrap,
    window.PAINEL_MODULES.catalogoCompatibilidade,
    window.PAINEL_MODULES.catalogoMarca,
    window.PAINEL_MODULES.redeApply, // app.rede.apply.js (linhas 1860-2097 pré-obra): mapeadores do payload da Rede (applyRede/applyMatrizResumo)
    window.PAINEL_MODULES.pedidosParceiros, // app.pedidos.parceiros.js (linhas 2098-2248 pré-obra): pedido manual + novo parceiro + candidaturas (Etapa 3)
    window.PAINEL_MODULES.partnerResumo, // resumo read-only da unidade, sem cálculo financeiro paralelo
    window.PAINEL_MODULES.partnerRetiradas, // baixa/cancelamento pelas rotas transacionais escopadas
    window.PAINEL_MODULES.partnerEstoque, // saldo, reservas, contagem e histórico escopados por unidade
    window.PAINEL_MODULES.partnerEstoqueActions, // ações diretas e simples exclusivas do dono da unidade
    window.PAINEL_MODULES.partnerVendas, // vendas escopadas, mesmo motor transacional do /operacao
    window.PAINEL_MODULES.partnerVendasDashboard, // indicadores e gráfico derivados das vendas escopadas
    window.PAINEL_MODULES.partnerCompras, // compras e compromissos da própria unidade
    window.PAINEL_MODULES.partnerComprasReceipt, // conferência física e ponte segura Matriz → parceiro
    window.PAINEL_MODULES.partnerLogistica, // entregas e retornos da própria unidade
    window.PAINEL_MODULES.partnerFinanceiro, // competência, caixa e títulos sem números da Matriz
    window.PAINEL_MODULES.partnerColaboradores, // equipe owner-only da unidade
    window.PAINEL_MODULES.partnerColaboradoresFinance, // remuneração, benefícios e comissões da própria unidade
    window.PAINEL_MODULES.partnerColaboradoresPermissions, // allowlist e sessões dos funcionários da unidade
    window.PAINEL_MODULES.partnerCatalogo, // catálogo técnico read-only sem custos
    window.PAINEL_MODULES.core, // app.core.js (linhas 2249-2419 pré-obra): encanamento: loadRealData/loadRedeData/init/live refresh
    window.PAINEL_MODULES.chartsRede, // app.charts.rede.js (linhas 2420-2617 pré-obra): gráficos da Rede: vendas, lucro, pneus
    window.PAINEL_MODULES.chartsSaude, // app.charts.saude.js (linhas 2618-2851 pré-obra): gráficos: origem, saúde, compras, estoque parado, margem
    window.PAINEL_MODULES.chartsUnidade, // app.charts.unidade.js (linhas 2852-3000 pré-obra): gráficos da unidade + chartOptions + renderChart genérico
  ];
  const out = estado;
  const nomePorFabrica = new Map(
    Object.entries(window.PAINEL_MODULES).map(([nome, fabrica]) => [fabrica, nome]),
  );
  const proprietarios = new Map(
    Reflect.ownKeys(Object.getOwnPropertyDescriptors(out)).map((nome) => [nome, 'estado']),
  );
  const colisoesUsadas = new Set();
  const colisoesNovas = [];

  for (const f of fabricas) {
    const nomeFabrica = nomePorFabrica.get(f);
    if (!nomeFabrica) throw new Error('painel_factory_sem_nome');
    const descritores = Object.getOwnPropertyDescriptors(f());
    for (const propriedade of Reflect.ownKeys(descritores)) {
      if (proprietarios.has(propriedade)) {
        const id = `${String(propriedade)}:${proprietarios.get(propriedade)}->${nomeFabrica}`;
        if (colisoesPermitidas.has(id)) colisoesUsadas.add(id);
        else colisoesNovas.push(id);
      }
      proprietarios.set(propriedade, nomeFabrica);
    }
    Object.defineProperties(out, descritores);
  }

  const colisoesObsoletas = [...colisoesPermitidas]
    .filter((id) => !colisoesUsadas.has(id));
  if (colisoesNovas.length || colisoesObsoletas.length) {
    const detalhes = [
      ...colisoesNovas.map((id) => `nova=${id}`),
      ...colisoesObsoletas.map((id) => `obsoleta=${id}`),
    ].join('|');
    throw new Error(`painel_colisao_nao_declarada:${detalhes}`);
  }
  return out;
};
