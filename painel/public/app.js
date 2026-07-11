/**
 * Farejador-Painel (MATRIZ) — compositor da obra 300 (2026-07-05).
 *
 * O painelApp() de 3.002 linhas foi fatiado em 21 módulos-fábrica
 * (window.PAINEL_MODULES.*, arquivos app.*.js ≤300 linhas — fiscal checar-tamanho).
 * Este arquivo guarda só o ESTADO + a montagem. Molde: obra do parceiro
 * (PLANO_REFATORACAO_PAINEL_300_2026-06-10.md), prova: prova-paridade-matriz.
 */

// ─── MONTAGEM ───────────────────────────────────────────────────────
// Junta o ESTADO + as fábricas num objeto SÓ — o mesmo `this` pra todo
// mundo; nenhum módulo tem estado próprio. Object.getOwnPropertyDescriptors
// preserva getters VIVOS (reatividade). ⚠️ NUNCA trocar por spread
// ({ ...f() }): spread EXECUTA o getter e congela o valor — a tela para de
// reagir. A ordem do array é a ordem do arquivo original: DOCUMENTADA E FIXA.
function montarPainelApp(estado, fabricas) {
  const out = estado;
  for (const f of fabricas) {
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()));
  }
  return out;
}

function painelApp() {
  // Migração de segurança: o token antigo não pode continuar persistido entre sessões.
  localStorage.removeItem('farejador_admin_token');
  sessionStorage.removeItem('farejador_admin_token');
  const estado = {
    // ─── ESTADO ─────────────────────────────────────
    currentPage: 'resumo',
    currentTime: 'semana',
    saleModalOpen: false,
    modalConv: null,
    saleForm: {
      product_id: '',
      quantity: 1,
      unit_price: 0,
      payment_method: 'Pix',
      fulfillment_mode: 'delivery',
      delivery_address: '',
      notes: '',
      idempotency_key: '',
      source_tag: 'chatwoot_sem_bot',
      customer_name: '',
      customer_phone: '',
    },
    orderSubmitting: false,
    orderError: null,
    partnerModalOpen: false,
    partnerSubmitting: false,
    partnerError: null,
    partnerResult: null,
    partnerForm: {
      trade_name: '',
      responsible_name: '',
      whatsapp_phone: '',
      email: '',
      address: '',
      commission_percent: '',
      municipios: '',
      slug: '',
    },
    // Etapa 3: fila de candidaturas
    applicationsModalOpen: false,
    applications: [],
    applicationsLoading: false,
    approvingApp: null,
    approveForm: { municipios: '', commission_percent: '', slug: '' },
    approveSubmitting: false,
    approveError: null,
    approveResult: null,
    adminAuthenticated: false,
    adminUser: null,
    operatorLabel: 'Operador',
    apiStatus: 'mock',
    apiError: null,
    serverEnvironment: null,
    chatwootBaseUrl: null,
    chatwootAccountId: null,
    agentV2WorkerEnabled: null,
    liveRefreshing: false,
    liveRefreshId: null,
    selectedParceiroIndex: 0,
    unidadeTab: 'visao',
    vendasTab: 'varejo',
    comprasTab: 'comprar', // sub-abas da tela Compras: 'comprar' | 'fornecedores'
    // ── ATACADO (Fase 1): venda de atacado da Matriz + ranking de recompra ──
    atacadoBuyers: [],
    atacadoRanking: [],
    atacadoLoading: false,
    atacadoSaving: false,
    atacadoMsg: null,
    atacadoStaleDays: 30,
    atacadoForm: { buyerKey: '', newName: '', newPhone: '', notes: '', payment_status: 'paid', due_date: '', items: [{ measure: '', brand: '', quantity: 1, unit_price: '' }] },
    // ── ATACADO (Fase 2): estoque do galpão por medida ──
    atacadoStock: [],
    atacadoMeasures: [],
    stockForm: { measure: '', quantity_on_hand: '', unit_cost: '', min_quantity: '', notes: '' },
    stockSaving: false,
    stockMsg: null,
    // ── ESTOQUE (0128): busca, baixa manual com motivo e o FILME da movimentação ──
    stockBusca: '',
    stockBaixaForm: { measure: null, quantity: '', tipo: 'quebra', texto: '' },
    stockBaixaSaving: false,
    galpaoFilme: { rows: [], measure: null, loading: false },
    atacadoResumo: null, // Fase 3: faturamento, custo, lucro do atacado
    atacadoPeriodo: 'tudo', // recorte do card do atacado: 'tudo' | 'mes' (0117)
    // ── VAREJO da matriz (0117 — fatia 2): resumo com custo CONGELADO na venda ──
    varejoResumo: null, // null = ainda não carregou (cards caem no cálculo da lista)
    varejoPeriodo: 'tudo',
    // ── REDE — comissões como lançamento (0118, flag NETWORK_COMMISSION_LEDGER) ──
    comissoes: null, // null ou enabled:false = flag desligada (o bloco some sozinho)
    comissaoSettling: null, // partner_id em quitação (trava o botão Recebi)
    termsForm: { model: 'commission', percent: '', fee: '' }, // editor do modelo comercial
    termsSaving: false,
    termsMsg: null,
    // Alarme de cobrança (decisão do dono 07-02): loja acumulou ≥ X em aberto → pisca
    // "COBRAR". X salvo nesta máquina (mesmo padrão da meta da Rede). 0 = sem alarme.
    comissaoAlerta: Number(localStorage.getItem('farejador_comissao_alerta') || 0),
    comissaoExtratoAberto: false, // extrato (lançamentos 1 a 1) escondido por padrão
    // FINANCEIRO do atacado (0115, flag WHOLESALE_FINANCE): fiado a receber/a pagar.
    // null = flag off (a UI inteira do financeiro se esconde sozinha).
    atacadoFinance: null,
    // DESPESAS da matriz (0120, flag MATRIZ_EXPENSES): a perna de SAÍDA que faltava
    // (aluguel/funcionário/combustível/frete/manutenção). null = flag off (bloco some).
    matrizDespesas: null,
    despesasLoaded: false,
    financeiroVisao: null,
    despesaSaving: false,
    despesaMsg: null,
    despesaForm: { category: 'outros', description: '', amount: '', payment_status: 'paid', due_date: '' },
    // Recorte da lista (0130): mês (competência SP — preenchido no 1º load) × modalidade.
    despesaFiltro: { mes: '', categoria: '' },
    // Bootstrap das modalidades — o payload do GET (lista VIVA da 0130, com as do dono) sobrescreve.
    despesaCategorias: [
      { id: 'aluguel', label: 'Aluguel/galpão' },
      { id: 'funcionario', label: 'Funcionário' },
      { id: 'combustivel', label: 'Combustível' },
      { id: 'frete', label: 'Frete pago' },
      { id: 'manutencao', label: 'Manutenção' },
      { id: 'outros', label: 'Outros' },
    ],
    // ── LOGÍSTICA da matriz (0121, flag MATRIZ_LOGISTICS): entregas + rota do dia ──
    logistica: null, // payload do GET (null/enabled:false = dormente → aviso na tela)
    logisticaLoaded: false,
    logisticaSaving: false,
    logisticaMsg: null,
    rotaForm: { courier_name: '', km_start: '', selecionadas: {} },
    fecharForm: { km_end: '', fuel_spent: '', notes: '' },
    logisticaCouriers: {}, // rascunho de entregador por pedido (entrega avulsa)
    logisticaPays: {},     // forma de pagamento por pedido (só no Entregue)
    uploadingReceipt: false,
    receiptUrls: {}, // miniaturas autenticadas (fetch com token → blob URL; <img> puro leva 401)
    // CANCELAR venda (0116): últimas vendas (vivas e canceladas) — de onde se cancela.
    atacadoVendas: [],
    measureBox: { key: null, hits: [] }, // autocomplete de medida: qual campo abriu + sugestões
    // ── ATACADO — FORNECEDORES (0114): de quem o dono compra (entrada do galpão) ──
    fornecedores: [],
    fornecedorRanking: [],
    fornecedorBreakdown: [], // fornecedor × medida (quem vende mais barato / especialidade)
    compras: [],
    compraSaving: false,
    compraMsg: null,
    compraForm: { supplierKey: '', newName: '', newPhone: '', notes: '', payment_status: 'paid', due_date: '', items: [{ measure: '', brand: '', quantity: 1, unit_cost: '' }] },
    redePeriod: localStorage.getItem('farejador_rede_period') || 'month',
    redeSalesGoal: Number(localStorage.getItem('farejador_rede_sales_goal') || 5000),
    redePeriods: [
      { id: 'today', label: 'Hoje' },
      { id: '7d', label: '7 dias' },
      { id: '30d', label: '30 dias' },
      { id: 'month', label: 'Mês atual' },
    ],
    redeFilter: 'todos',
    redeFilters: [
      { id: 'todos', label: 'Todos' },
      { id: 'alerta', label: 'Com alerta' },
      { id: 'sem_venda', label: 'Sem venda hoje' },
      { id: 'sem_atualizacao', label: 'Sem atualização' },
      { id: 'dependencia_2w', label: 'Dependentes 2W' },
      { id: 'risco', label: 'Score baixo' },
    ],
    // ── COLABORADORES da matriz (0124 — fatia 1): staff próprio, vendedor/entregador ──
    colaboradores: [],
    colabLoaded: false,
    colabSaving: false,
    colabMsg: null,
    colabShowForm: false,
    colabForm: { display_name: '', username: '', password: '', job: 'vendedor', panel_role: null },

    // ─── MENUS ──────────────────────────────────────
    liveMenu: [
      { id: 'resumo',     label: 'Resumo',     icon: 'layout-dashboard' },
      { id: 'bot',        label: 'Bot',        icon: 'bot', badge: null },
      { id: 'vendas',     label: 'Vendas',     icon: 'shopping-bag' },
      { id: 'compras',    label: 'Compras',    icon: 'shopping-cart' },
      { id: 'estoque',    label: 'Estoque',    icon: 'package' },
      { id: 'logistica',  label: 'Logística',  icon: 'truck' },
      { id: 'financeiro', label: 'Financeiro', icon: 'wallet' },
      { id: 'rede',       label: 'Rede',       icon: 'network' },
      { id: 'colaboradores', label: 'Colaboradores', icon: 'users' },
    ],

    futureMenu: [
      { id: 'catalogo',     label: 'Catálogo',      icon: 'tag' },
      { id: 'relatorios',   label: 'Relatórios',    icon: 'bar-chart-3' },
    ],

    // ─── FILTROS DE TEMPO ───────────────────────────
    timeFilters: [
      { id: 'hoje',    label: 'Hoje' },
      { id: 'semana',  label: 'Última semana' },
      { id: 'mes',     label: 'Último mês' },
      { id: 'ano',     label: 'Último ano' },
    ],

    // Resumo (cockpit do dono) = bot/tráfego (applyMatrizResumo) + cobrança (applyRede).
    // SINO (2026-07-06): payload do servidor + assinaturas lidas (localStorage).
    // `notificacoes` virou GETTER derivado no módulo app.sino.js — não é mais estado.
    sino: null,
    sinoLidas: JSON.parse(localStorage.getItem('farejador_sino_lidas') || '[]'),
    // TELA DO BOT (2026-07-06): campainha (cliente esperando) + visão (cards/mapa/radar).
    botCampainha: null,
    botVisao: null,
    botLoading: false,
    botPeriodo: '30d',
    botCamada: 'chamou',
    botMapaSel: null,
    kpis: [],
    leadsRecuperar: [],
    resumoSeries: [],
    pedidos: [],

    produtos: [],

    redeKpis: [],

    parceirosRede: [],

    // Raio de entrega (proximidade-primeiro Fase 2): estado do editor na matriz.
    savingRaio: false,
    raioSalvoMsg: '',

    // 2026-06-01: alertas fake removidos — os alertas reais saem de redeAlertasOperacionais (computa de parceirosRede).
    alertasRede: [],

    // ─── COMPUTED ───────────────────────────────────
  };

  return montarPainelApp(estado, [
    window.PAINEL_MODULES.nav, // app.nav.js (linhas 208-262 pré-obra): título/menu/badge + seleção de unidade (abrir/voltar)
    window.PAINEL_MODULES.redeKpis, // app.rede.kpis.js (linhas 263-455 pré-obra): derivadas da Rede: metas, séries, totais, rankings, alertas
    window.PAINEL_MODULES.unidadeKpis, // app.unidade.kpis.js (linhas 456-549 pré-obra): derivadas da unidade + classes de status + saúde (score)
    window.PAINEL_MODULES.vendaModal, // app.venda.modal.js (linhas 550-604 pré-obra): modal de venda manual/walk-in + período e meta da Rede
    window.PAINEL_MODULES.api, // app.api.js (linhas 605-704 pré-obra): credenciais + apiGet/Post/Put + salvar raio de entrega
    window.PAINEL_MODULES.format, // app.format.js (linhas 705-768 pré-obra): moeda/data/tempo/iniciais + widgets do form de venda
    window.PAINEL_MODULES.varejo, // app.varejo.js (linhas 769-843 pré-obra): pedidos do varejo + resumo do varejo (0117) + períodos
    window.PAINEL_MODULES.comissoes, // app.comissoes.js (linhas 844-914 pré-obra): comissões da Rede (0118): carregar/quitar/alarme/termos
    window.PAINEL_MODULES.atacado, // app.atacado.js (linhas 915-1058 pré-obra): venda de atacado: form, status, submit, ranking de recompra
    window.PAINEL_MODULES.compras, // app.compras.js (linhas 1059-1232 pré-obra): compras/fornecedores + fiado (0115) + loads financeiro/despesas
    window.PAINEL_MODULES.logistica, // app.logistica.js (linhas 1233-1405 pré-obra): logística (0121) leitura: cards, rota, datas D+1, deep-links
    window.PAINEL_MODULES.logisticaAcoes, // app.logistica.acoes.js (linhas 1406-1530 pré-obra): logística ações: remarcar/pendurar/abrir/fechar rota/comprovante IA
    window.PAINEL_MODULES.colaboradores, // app.colaboradores.js (linhas 1531-1629 pré-obra): colaboradores da matriz (0124): criar/função/senha/revogar
    window.PAINEL_MODULES.sino, // app.sino.js (2026-07-06): sino vivo — getter notificacoes derivado + lidas em localStorage
    window.PAINEL_MODULES.bot, // app.bot.js (2026-07-06): tela do Bot — campainha/visão/deep-link Chatwoot
    window.PAINEL_MODULES.botMapa, // app.bot.mapa.js (2026-07-06): desenho do mapa IBGE pintado por camada
    window.PAINEL_MODULES.financeiro, // app.financeiro.js (linhas 1630-1743 pré-obra): aba Financeiro (visão 3 pernas) + despesas (0120)
    window.PAINEL_MODULES.galpao, // app.galpao.js (linhas 1744-1859 pré-obra): estoque do galpão por medida: busca, custo médio, entrada
    window.PAINEL_MODULES.redeApply, // app.rede.apply.js (linhas 1860-2097 pré-obra): mapeadores do payload da Rede (applyRede/applyMatrizResumo)
    window.PAINEL_MODULES.pedidosParceiros, // app.pedidos.parceiros.js (linhas 2098-2248 pré-obra): pedido manual + novo parceiro + candidaturas (Etapa 3)
    window.PAINEL_MODULES.core, // app.core.js (linhas 2249-2419 pré-obra): encanamento: loadRealData/loadRedeData/init/live refresh
    window.PAINEL_MODULES.chartsRede, // app.charts.rede.js (linhas 2420-2617 pré-obra): gráficos da Rede: vendas, lucro, pneus
    window.PAINEL_MODULES.chartsSaude, // app.charts.saude.js (linhas 2618-2851 pré-obra): gráficos: origem, saúde, compras, estoque parado, margem
    window.PAINEL_MODULES.chartsUnidade, // app.charts.unidade.js (linhas 2852-3000 pré-obra): gráficos da unidade + chartOptions + renderChart genérico
  ]);
}
