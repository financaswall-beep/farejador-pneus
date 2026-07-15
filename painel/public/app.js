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
    vendasHistoricoPorPagina: 20,
    vendasBusca: '',
    vendaHistoricoSelecionada: null,
    varejoBusca: '',
    varejoStatusFiltro: 'todos',
    vendaVarejoSelecionada: null,
    vendaMenuOpen: false,
    comprasTab: 'visao', // sub-abas: visao | nova | historico | fornecedores | precos
    // ── ATACADO (Fase 1): venda de atacado da Matriz + ranking de recompra ──
    atacadoBuyers: [],
    atacadoRanking: [],
    atacadoLoading: false,
    atacadoSaving: false,
    atacadoMsg: null,
    vendaAtacadoSelecionada: null,
    atacadoStaleDays: 30,
    atacadoForm: { buyerKey: '', newName: '', newPhone: '', notes: '', payment_status: 'paid', due_date: '', items: [{ measure: '', brand: '', quantity: 1, unit_price: '' }] },
    // ── ATACADO (Fase 2): estoque do galpão por medida ──
    atacadoStock: [],
    atacadoMeasures: [],
    stockForm: { measure: '', quantity_on_hand: '', unit_cost: '', min_quantity: '', notes: '' },
    stockSaving: false,
    stockMsg: null,
    // ── ESTOQUE (0128): busca, baixa manual com motivo e o FILME da movimentação ──
    stockTab: 'visao',
    stockFiltro: 'todos',
    stockOperacao: null,
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
    finTab: 'visao', // redesign 07-12 (desenho do dono): sub-abas visao|cobrancas|pagar|despesas|indicadores
    finIndicadorTab: 'fluxo', // Indicadores: fluxo|analise|inadimplencia (sem misturar assuntos no mesmo card)
    finFluxoDias: 30, // horizonte da agenda real: 7|30|90 dias
    finQuitando: false, // trava anti-duplo-clique dos botões Recebi/Paguei (07-13); some o erro à toa
    despesaSaving: false,
    despesaMsg: null,
    despesaForm: { category: 'outros', description: '', amount: '', payment_status: 'paid', due_date: '' },
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
    logisticaTab: 'visao',
    logisticaRotaSelecionadaId: null, // detalhe financeiro aberto dentro da subaba Rotas
    logisticaPeriodo: 'hoje',
    logisticaFiltro: 'todas',
    logisticaBusca: '',
    rotaForm: { courier_name: '', km_start: '', selecionadas: {} },
    fecharForm: { km_end: '', notes: '' },
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
    colabForm: { display_name: '', username: '', password: '', job: '', panel_role: null },
    // redesign 07-12 (desenho do dono com GPT): busca + filtro ativos/revogados + olhinho da senha
    colabBusca: '',
    colabView: 'ativos',
    colabSenhaVisivel: false,

    // ─── MENUS ──────────────────────────────────────
    liveMenu: [
      { id: 'resumo',     label: 'Resumo',     icon: 'layout-dashboard' },
      { id: 'bot',        label: 'Bot',        icon: 'bot', badge: null },
      { id: 'vendas',     label: 'Vendas',     icon: 'shopping-bag' },
      { id: 'clientes',   label: 'Clientes',   icon: 'users' },
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
    botTab: 'visao',
    botConversaBusca: '',
    botConversaFiltro: 'todos',
    botPeriodo: '30d',
    botCamada: 'chamou',
    botMapaSel: null,
    // CLIENTES: leitura unificada das fontes já existentes; nenhuma ficha paralela.
    clientes: [],
    clientesParceiros: [],
    clientesLoading: false,
    clientesError: null,
    clientesTab: 'todos',
    clientesBusca: '',
    clientesTipo: 'todos',
    clientesOrigem: 'todos',
    clientesStatus: 'todos',
    clientesClasse: 'todos',
    clientesPeriodo: '90',
    clientesPagina: 1,
    clientesPorPagina: 8,
    clienteSelecionadoId: null,
    clienteParceiroSelecionadoId: null,
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

  // Montagem (lista de fábricas + compositor) mora em app.montagem.js — fatia 07-14.
  return window.PAINEL_MONTAR(estado);
}
