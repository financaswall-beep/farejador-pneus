/**
 * Farejador-Painel (MATRIZ) — obra 300 (2026-07-05).
 *
 * O painelApp() de 3.002 linhas foi fatiado em módulos-fábrica
 * (window.PAINEL_MODULES.*, arquivos app.*.js ≤300 linhas — fiscal checar-tamanho).
 * Este arquivo guarda só o ESTADO; a MONTAGEM (lista de fábricas + compositor
 * getOwnPropertyDescriptors, NUNCA spread) mora em app.montagem.js (fatia 07-14).
 * Molde: obra do parceiro (PLANO_REFATORACAO_PAINEL_300_2026-06-10.md),
 * prova: prova-paridade-matriz.
 */

function painelApp() {
  // Migração de segurança: o token antigo não pode continuar persistido entre sessões.
  localStorage.removeItem('farejador_admin_token');
  sessionStorage.removeItem('farejador_admin_token');
  const estado = {
    currentPage: 'resumo',
    currentTime: 'semana',
    saleModalOpen: false,
    modalConv: null,
    saleForm: {
      product_id: '', quantity: 1, unit_price: 0, payment_method: 'Pix', payment_due_on: '',
      fulfillment_mode: 'delivery', delivery_address: '', notes: '', idempotency_key: '',
      source_tag: 'chatwoot_sem_bot', customer_name: '', customer_phone: '',
    },
    orderSubmitting: false,
    orderError: null,
    partnerModalOpen: false,
    partnerSubmitting: false,
    partnerError: null,
    partnerResult: null,
    partnerForm: {
      trade_name: '', responsible_name: '', whatsapp_phone: '', email: '',
      address: '', commission_percent: '', municipios: [], slug: '',
    },
    // Etapa 3: fila de candidaturas
    applicationsModalOpen: false,
    applications: [],
    applicationsLoading: false, applicationsError: null,
    approvingApp: null,
    approveForm: { municipios: [], commission_percent: '', slug: '' },
    approveSubmitting: false,
    approveError: null,
    approveResult: null,
    adminAuthenticated: false,
    adminUser: null,
    panelScope: 'matrix',
    panelWorkplace: null,
    panelModules: [],
    panelPartnerSlug: '',
    panelPartnerToken: '',
    menuBadges: {},
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
    unidadeTab: 'visao', unidadeStockBusca: '', unidadeStockFiltro: 'todos', unidadeLancamentoFiltro: 'todos',
    vendasTab: 'visao', // sub-abas: visao | varejo | atacado | historico | recompra
    vendasPeriodo: '30d', // recorte comercial compartilhado: today | 7d | 30d
    vendasHistoricoCanal: 'todos',
    vendasHistoricoStatus: 'todos',
    vendasHistoricoPagamento: 'todos',
    vendasHistoricoOrdem: 'desc',
    vendasHistoricoPeriodoMenu: false,
    vendasHistoricoMaisFiltros: false,
    vendasHistoricoSomenteCancelaveis: false,
    vendasHistoricoSomenteComRecibo: false,
    vendasHistoricoPagina: 1,
    vendasHistoricoPedidos: [], vendasHistoricoAtacado: [], vendasDataError: null,
    vendasHistoricoPorPagina: 20,
    vendasBusca: '',
    vendaHistoricoSelecionada: null,
    varejoBusca: '',
    varejoStatusFiltro: 'todos',
    vendaVarejoSelecionada: null,
    vendaMenuOpen: false,
    comprasTab: 'visao', // sub-abas: visao | nova | historico | fornecedores | precos
    comprasLoading: { overview: false, history: false, suppliers: false, prices: false }, comprasErrors: { overview: null, history: null, suppliers: null, prices: null }, comprasOverview: { rows: [], summary: null, pagination: null }, comprasHistory: { rows: [], summary: null, pagination: null }, comprasHistoryAnalytics: { summary: null, timeline: [] }, comprasHistoryFilters: { period: '30d', status: 'all', payment: 'all', supplierId: '', search: '', page: 1, pageSize: 10 }, comprasHistoryHoverIndex: null, comprasCostDialogOpen: false, comprasCost: { analytics: { summary: null, timeline: [] }, filters: { period: '90d', supplierId: '' }, loading: false, error: null }, comprasSuppliers: [], comprasSupplierSearch: '', comprasSupplierSelectedId: null, comprasPriceRows: [], comprasPriceFilters: { period: '90d', supplierId: '', search: '' }, comprasPriceSelectedMeasure: null, comprasPriceMode: 'comparison', comprasPriceQuantity: 10, comprasReplenishment: { rows: [], generatedAt: null, loading: false, error: null, noMinimum: 0 }, compraDetalhe: null, compraPendingSubmission: null, compraActionSaving: false, compraReceiptItems: [], compraOrderOptions: [], compraOrderSelection: '', compraOrderLoading: false, compraDialog: { open: false, kind: null, purchase: null, supplier: null, reason: '', error: '' }, fornecedorForm: { name: '', phone: '', document: '', notes: '' },
    // ── ATACADO (Fase 1): venda de atacado da Matriz + ranking de recompra ──
    atacadoBuyers: [],
    atacadoRanking: [],
    atacadoLoading: false,
    atacadoSaving: false,
    atacadoMsg: null,
    vendaAtacadoSelecionada: null,
    atacadoStaleDays: 30,
    atacadoForm: {
      buyerKey: '', newName: '', newPhone: '', notes: '', sold_at: '',
      payment_status: 'paid', payment_date: '', due_date: '', idempotency_key: '', parent_order_id: '', receiving_unit_id: '',
      items: [{ measure: '', brand: '', tire_condition: '', quantity: 1, unit_price: '' }],
    },
    // ── ATACADO (Fase 2): estoque do galpão por medida ──
    atacadoStock: [],
    atacadoMeasures: [],
    stockForm: { measure: '', brand: '', tire_condition: '', quantity_on_hand: '', unit_cost: '', min_quantity: '', notes: '', entry_nature: 'inventory_found', entry_reason: '', idempotency_key: '', original_quantity_on_hand: null, original_unit_cost: null },
    stockConditionCorrection: { open: false, measure: '', brand: '', from_condition: '', to_condition: '', quantity: '', available: 0, reason: '', idempotency_key: '', saving: false },
    stockSaving: false,
    stockMsg: null,
    // ── ESTOQUE (0128): busca, baixa manual com motivo e o FILME da movimentação ──
    stockTab: 'visao',
    stockFiltro: 'todos',
    stockOperacao: null,
    stockBusca: '',
    stockBaixaForm: { measure: null, brand: null, tire_condition: null, quantity: '', tipo: 'breakage', texto: '', idempotency_key: '' },
    stockBaixaSaving: false,
    galpaoFilme: { rows: [], measure: null, brand: null, tire_condition: null, loading: false },
    stockReconciliation: { rows: [], summary: null, loading: false, error: null },
    stockCount: { reason: '', saving: false, message: null },
    atacadoResumo: null, // Fase 3: faturamento, custo, lucro do atacado
    atacadoPeriodo: 'tudo', // recorte do card do atacado: 'tudo' | 'mes' (0117)
    // ── VAREJO da matriz (0117 — fatia 2): resumo com custo CONGELADO na venda ──
    varejoResumo: null, // null = ainda não carregou (cards caem no cálculo da lista)
    varejoPeriodo: 'tudo',
    // ── REDE — comissões como lançamento (0118, flag NETWORK_COMMISSION_LEDGER) ──
    comissoes: null, comissoesUnavailable: false, // null/enabled:false = flag desligada; unavailable = falha
    comissaoSettling: null, // partner_id em quitação (trava o botão Recebi)
    comissaoRefunding: null, // reversal_id em devolução (0146)
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
    financeiroVisao: null, financeiroLoadError: null,
    finTab: 'visao', // sub-abas visao|cobrancas|pagar|despesas|extrato|indicadores
    finIndicadorTab: 'fluxo', // Indicadores: fluxo|analise|inadimplencia (sem misturar assuntos no mesmo card)
    finFluxoDias: 30, // horizonte da agenda real: 7|30|90 dias
    finQuitando: false, // a chave de cada mutacao vive no gerenciador global da API
    finExtrato: null,
    finExtratoLoading: false,
    finExtratoFiltro: { mes: '', base: 'competencia' },
    finBaixaModal: {
      open: false, item: null, direction: 'receivable', amount: '',
      payment_date: '', payment_method: 'pix', cash_account: 'Caixa principal',
      note: '', error: null,
    },
    despesaSaving: false, despesaMsg: null,
    despesaRemoveDialog: { open: false, row: null, reason: '', error: null, saving: false },
    despesaForm: { category: 'outros', description: '', amount: '', payment_status: 'paid',
      occurred_at: '', document_date: '', competence_month: '', payment_date: '',
      due_date: '', idempotency_key: '' },
    // Recorte da lista (0130): mês (competência SP — preenchido no 1º load) × modalidade.
    despesaFiltro: { mes: '', categoria: '' },
    // Sub-aba Contas a pagar (07-13): filtro da fila vindo do card Atenção rápida
    // ('' = tudo | 'vencida' | 'hoje' | 'sete'). Front-only, não vai pro servidor.
    pagarFiltro: '',
    // Sub-aba Cobranças: filtro da fila a receber (fiado + comissão da rede).
    // ('' = tudo | 'vencida' | 'hoje' | 'sete' | 'semfone' | 'comissao').
    cobrancaFiltro: '',
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
    logisticaDialog: { open: false, kind: null, delivery: null, reason: '' },
    logisticaTab: 'visao',
    logisticaRotaSelecionadaId: null, logisticaRotaAbertaId: null, // detalhe e rota operacional escolhida
    logisticaPeriodo: 'hoje',
    logisticaFiltro: 'todas',
    logisticaBusca: '',
    rotaForm: { courier_collaborator_id: '', km_start: '', selecionadas: {} },
    fecharForm: { km_end: '', notes: '' },
    logisticaCouriers: {}, // rascunho de entregador por pedido (entrega avulsa)
    logisticaPays: {},     // forma de pagamento por pedido (só no Entregue)
    uploadingReceipt: false,
    receiptUrls: {}, // miniaturas autenticadas (fetch com token → blob URL; <img> puro leva 401)
    // CANCELAR venda (0116): últimas vendas (vivas e canceladas) — de onde se cancela.
    atacadoVendas: [], atacadoCargo: [], atacadoArrival: { open: false, order: null, items: [], cargo: [], saving: false, error: null },
    measureBox: { key: null, hits: [] }, // autocomplete de medida: qual campo abriu + sugestões
    // ── ATACADO — FORNECEDORES (0114): de quem o dono compra (entrada do galpão) ──
    fornecedores: [],
    fornecedorRanking: [],
    fornecedorBreakdown: [], // fornecedor × medida × marca
    compras: [],
    compraSaving: false,
    compraMsg: null,
    compraForm: {
      supplierKey: '', newName: '', newPhone: '', newDocument: '', notes: '',
      supplier_reference: '', purchased_at: '', payment_status: 'paid',
      payment_method: 'Pix', payment_date: '', due_date: '',
      freight_amount: '', discount_amount: '', installments: [{ due_date: '', amount: '' }],
      receipt_status: 'received', idempotency_key: '',
      items: [{ measure: '', brand: '', tire_condition: '', quantity: 1, unit_cost: '' }],
    },
    compraOrderOptions: [], compraOrderSelection: '', compraOrderLoading: false,
    redePeriod: localStorage.getItem('farejador_rede_period') || 'month', redeFunnelUnassigned: 0,
    redeSalesGoal: Number(localStorage.getItem('farejador_rede_sales_goal') || 5000),
    redePeriods: [{ id: 'today', label: 'Hoje' }, { id: '7d', label: '7 dias' },
      { id: '30d', label: '30 dias' }, { id: 'month', label: 'Mês atual' }],
    redeFilter: 'todos', redeSection: 'visao', redeBusca: '',
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
    colabAdjustments: [],
    colabLoaded: false, colabLoading: false, colabLoadError: null,
    colabSaving: false, colabMsg: null,
    colabDialog: { open: false, kind: null, collaborator: null, password: '', showPassword: false, error: null }, colabShowForm: false,
    colabForm: { display_name: '', username: '', password: '', job_title: '', work_area: 'other', panel_role: null },
    colabBusca: '',
    colabView: 'ativos',
    colabSenhaVisivel: false, colabTab: 'equipe', colabMes: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date()), colabCurrentMonth: new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'America/Sao_Paulo' }).format(new Date()), colabSummary: {}, colabCargoFiltro: '', colabAcessoFiltro: '', colabSelectedId: null, colabDrawer: null,
    colabRemForm: { employment_type: 'clt', base_salary: '', salary_frequency: 'monthly', payment_day: 5, payment_method: 'pix', payment_note: '', starts_on: '', benefits: [] }, colabComForm: { kind: 'percent', basis: 'margin', value: '', starts_on: '', active: true, settlement_frequency: 'monthly', itemized: false, item_rules: { tire: { kind: 'none', value: 0 }, service: { kind: 'none', value: 0 }, other: { kind: 'none', value: 0 } } }, colabPermForm: { vendas: false, entregas: false, financeiro: false }, colabPermAvailable: [], colabPermLocked: false, colabPermLoading: false, colabAjusteForm: { kind: 'addition', description: '', amount: '' }, colabPerfilForm: { job_title: '', work_area: 'other' },
    // MARKETING: primeira tela read-only; Meta sobe dormente e segredo nunca chega ao front.
    marketingTab: 'visao', marketingPeriod: '30d', marketingVisao: null, marketingCampaignChannel: 'all', marketingCampaigns: null, marketingJourneys: null,
    marketingLoading: false, marketingError: null, marketingRequestSeq: 0, marketingCampaignsLoading: false, marketingCampaignsError: null, marketingCampaignRequestSeq: 0, marketingCampaignSearch: '', marketingCampaignDecision: 'all', marketingCampaignPage: 1, marketingCampaignDetailId: null, marketingCampaignDetail: null, marketingCampaignDetailLoading: false, marketingCampaignDetailError: null, marketingCampaignDetailRequestSeq: 0, marketingJourneysLoading: false, marketingJourneysError: null, marketingJourneysRequestSeq: 0, marketingIntegrations: null, marketingIntegrationsLoading: false, marketingIntegrationsError: null, marketingIntegrationsRequestSeq: 0, marketingIntegrationsMessage: '', marketingIntegrationActionLoading: '', marketingUtmForm: { base_url: '', source: 'meta', medium: 'paid_social', campaign: '', content: '' }, marketingUtmMessage: '',
    // ─── MENUS ──────────────────────────────────────
    // `liveMenu` é um getter derivado dos módulos autorizados (app.nav.js).
    // Os badges vivem fora do catálogo para o getter continuar imutável.
    futureMenu: [
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
    botTab: 'visao',
    botConversaBusca: '',
    botConversaFiltro: 'todos',
    botPeriodo: '30d',
    botCamada: 'chamou',
    botMapaSel: null,
    // CLIENTES: leitura unificada das fontes já existentes; nenhuma ficha paralela.
    clientes: [], clientesParceiros: [],
    clientesLoading: false, clientesError: null, clientesLiveStatus: 'parado',
    clientesTab: 'todos',
    clientesBusca: '', clientesTipo: 'todos',
    clientesOrigem: 'todos',
    clientesStatus: 'todos',
    clientesClasse: 'todos',
    clientesPeriodo: '90',
    clientesPagina: 1,
    clientesPorPagina: 8,
    clienteSelecionadoId: null,
    clienteParceiroSelecionadoId: null,
    customerIdentityEnabled: false, customerPrivacyEnabled: false, customerIdentityRows: [],
    customerIdentityCursor: null, customerIdentitySelectedId: null, customerIdentityCandidates: [],
    customerIdentityCandidate: null, customerIdentityCandidateSides: [], customerIdentitySplitLinks: [],
    customerIdentityLoading: false, customerIdentityError: null, customerIdentityNotice: '', customerPrivacyPreview: null,
    kpis: [], leadsRecuperar: [], resumoSeries: [],
    pedidos: [], produtos: [],
    catalogoRows: [], catalogoBrands: ['Pirelli', 'Metzeler', 'Michelin', 'Bridgestone', 'CEAT', 'Dunlop', 'IRA', 'IRC', 'Levorin', 'Rinaldi', 'Maggion', 'Technic', 'Vipal', 'Mitas', 'Kenda'], catalogoSummary: { products: 0, stock_only: 0, brands: 0, without_price: 0, with_stock: 0 },
    catalogoLoading: false, catalogoError: null, catalogoBusca: '', catalogoMarca: 'todas', catalogoFiltro: 'todos', catalogoPagina: 1, catalogoPorPagina: 7, catalogoSelecionado: null, catalogoHistory: [], catalogoPriceForm: { price: '', reason: '', marginPreset: null }, catalogoSaving: false, catalogoMessage: null, catalogoCadastro: { open: false, mode: 'stock', row: null, form: { measure: '', brand: '', tire_condition: 'meia_vida', product_code: '', product_name: '', price_amount: '' }, saving: false, message: null }, catalogoCompatibilidade: { open: false, row: null, rows: [], summary: { models: 0, fitments: 0 }, loading: false, error: null, search: '', searchRows: [], searching: false, selectedVehicle: null, form: { position: 'both', is_oem: false, source: 'manual', reason: '' }, saving: false, message: null, discoveries: [], discoveriesLoading: false, discoveryForm: { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 } }, catalogoMarcaCorrecao: { open: false, row: null, from_brand: '', to_brand: '', reason: '', confirmed: false, idempotency_key: '', saving: false, message: null, result: null, result_row: null },
    redeKpis: [],
    parceirosRede: [],
    // Raio de entrega (proximidade-primeiro Fase 2): estado do editor na matriz.
    savingRaio: false,
    raioSalvoMsg: '',
    // 2026-06-01: alertas fake removidos — os alertas reais saem de redeAlertasOperacionais (computa de parceirosRede).
    alertasRede: [],

  };

  // Montagem (lista de fábricas + compositor) mora em app.montagem.js — fatia 07-14.
  return window.PAINEL_MONTAR(estado);
}
