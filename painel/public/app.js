/**
 * Farejador-Painel — App state e lógica de UI
 *
 * Usa fetch() quando servido em /admin/painel.
 * Os arrays mock permanecem como fallback para abrir o HTML direto.
 */

function painelApp() {
  return {
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
    apiToken: localStorage.getItem('farejador_admin_token') || '',
    operatorLabel: localStorage.getItem('farejador_operator_label') || 'Wallace',
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
    stockForm: { measure: '', quantity_on_hand: '', unit_cost: '', notes: '' },
    stockSaving: false,
    stockMsg: null,
    atacadoResumo: null, // Fase 3: faturamento, custo, lucro do atacado
    // FINANCEIRO do atacado (0115, flag WHOLESALE_FINANCE): fiado a receber/a pagar.
    // null = flag off (a UI inteira do financeiro se esconde sozinha).
    atacadoFinance: null,
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
    // ─── MENUS ──────────────────────────────────────
    liveMenu: [
      { id: 'resumo',   label: 'Resumo',  icon: 'layout-dashboard' },
      { id: 'vendas',   label: 'Vendas',  icon: 'shopping-bag' },
      { id: 'compras',  label: 'Compras', icon: 'shopping-cart' },
      { id: 'rede',     label: 'Rede',    icon: 'network' },
    ],

    futureMenu: [
      { id: 'financeiro',   label: 'Financeiro',    icon: 'wallet' },
      { id: 'estoque',      label: 'Estoque',       icon: 'package' },
      { id: 'logistica',    label: 'Logística',     icon: 'truck' },
      { id: 'colaboradores',label: 'Colaboradores', icon: 'users' },
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
    notificacoes: [],
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
    currentPageTitle() {
      const all = [...this.liveMenu, ...this.futureMenu];
      return all.find(i => i.id === this.currentPage)?.label || '';
    },

    notifBadgeCount() {
      return this.notificacoes.filter(n => !n.read).length;
    },

    selectedParceiro() {
      return this.parceirosRede[this.selectedParceiroIndex] || this.parceirosRede[0] || null;
    },

    selectParceiro(index) {
      this.selectedParceiroIndex = index;
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderParceiroChart();
      });
    },

    openParceiroDetalhe(index) {
      this.selectedParceiroIndex = index;
      this.unidadeTab = 'visao';
      this.currentPage = 'unidade';
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderParceiroChart();
      });
    },

    setUnidadeTab(tab) {
      this.unidadeTab = tab;
      this.$nextTick(() => {
        lucide.createIcons();
        if (tab === 'visao') this.renderParceiroChart();
      });
    },

    voltarParaRede() {
      this.currentPage = 'rede';
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderRedeChart();
        this.renderRedeLucroChart();
        this.renderRedeComprasChart();
        this.renderEstoqueParadoChart();
        this.renderMargemChart();
        this.renderVendaHojeChart();
        this.renderPneusRedeChart();
        this.renderRedeOrigemChart();
        this.renderRedeSaudeChart();
      });
    },

    redeTotalVendasValor() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.vendasValor || 0), 0);
    },

    redePeriodLabel() {
      return this.redePeriods.find((period) => period.id === this.redePeriod)?.label || 'Mês atual';
    },

    redeSeriesLabels() {
      const len = Math.max(this.redeSalesSeries().length, this.redeOrderSeries().length, 1);
      if (len === 1) return ['Hoje'];
      return Array.from({ length: len }, (_, index) => {
        const remaining = len - index - 1;
        if (remaining === 0) return 'Hoje';
        if (remaining === 1) return 'Ontem';
        return `D-${remaining}`;
      });
    },

    redeGoalDaily() {
      const len = Math.max(this.redeSalesSeries().length, 1);
      return Number(this.redeSalesGoal || 0) / len;
    },

    redeGoalProgress() {
      const goal = Number(this.redeSalesGoal || 0);
      if (goal <= 0) return 0;
      return Math.min(100, Math.round((this.redeTotalVendasValor() / goal) * 100));
    },

    redeGoalRemaining() {
      return Math.max(0, Number(this.redeSalesGoal || 0) - this.redeTotalVendasValor());
    },

    redeTotalVendas() {
      return this.formatCurrency(this.redeTotalVendasValor());
    },

    redeSalesSeries() {
      const series = [0, 0, 0, 0, 0, 0, 0];
      for (const parceiro of this.parceirosRede) {
        const values = Array.isArray(parceiro.serieVendas) ? parceiro.serieVendas : [];
        for (let i = 0; i < 7; i += 1) {
          series[i] += Number(values[i] || 0);
        }
      }
      return series;
    },

    redeOrderSeries() {
      const series = [0, 0, 0, 0, 0, 0, 0];
      for (const parceiro of this.parceirosRede) {
        const values = Array.isArray(parceiro.seriePedidos) ? parceiro.seriePedidos : [];
        for (let i = 0; i < 7; i += 1) {
          series[i] += Number(values[i] || 0);
        }
      }
      return series;
    },

    redeTotalPedidos() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.pedidos || 0), 0);
    },

    redeTicketMedio() {
      const pedidos = this.redeTotalPedidos();
      return pedidos > 0 ? this.redeTotalVendasValor() / pedidos : 0;
    },

    redeTotal2w() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.vendas2w || 0), 0);
    },

    redeTotalPorta() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.vendasPorta || 0), 0);
    },

    redeTotalComissao() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.comissaoDevida || 0), 0);
    },

    redeTotalMensalidade() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.mensalidadeDevida || 0), 0);
    },

    redeTotalDevido() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + Number(parceiro.devidoMatriz || 0), 0);
    },

    redeConversao2w() {
      const total = this.redeTotalVendasValor();
      return total > 0 ? Math.round((this.redeTotal2w() / total) * 100) : 0;
    },

    redeEstoqueQuantidade() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + (parceiro.estoqueItens || []).reduce((itemSum, item) => itemSum + Number(item.qtd || 0), 0), 0);
    },

    redeEstoqueValor() {
      return this.parceirosRede.reduce((sum, parceiro) => sum + (parceiro.estoqueItens || []).reduce((itemSum, item) => {
        return itemSum + (Number(item.qtd || 0) * Number(item.custoValor || 0));
      }, 0), 0);
    },

    rankingLucro() {
      return [...this.parceirosRede].sort((a, b) => Number(b.lucroEstimado || 0) - Number(a.lucroEstimado || 0)).slice(0, 4);
    },

    rankingSaude() {
      return [...this.parceirosRede].sort((a, b) => this.saudeScore(b) - this.saudeScore(a)).slice(0, 5);
    },

    rankingDependencia2w() {
      return [...this.parceirosRede]
        .filter((parceiro) => Number(parceiro.vendasValor || 0) > 0)
        .sort((a, b) => Number(b.percentual2w || 0) - Number(a.percentual2w || 0))
        .slice(0, 5);
    },

    rankingTicket() {
      return [...this.parceirosRede]
        .filter((parceiro) => Number(parceiro.pedidos || 0) > 0)
        .sort((a, b) => Number(b.ticketValor || 0) - Number(a.ticketValor || 0))
        .slice(0, 5);
    },

    parceiroVendaHojeValor(parceiro) {
      const values = Array.isArray(parceiro?.serieVendas) ? parceiro.serieVendas : [];
      return Number(values.length > 0 ? values[values.length - 1] : 0);
    },

    unidadesSemVendaHoje() {
      return this.parceirosRede.filter((parceiro) => this.parceiroVendaHojeValor(parceiro) <= 0);
    },

    unidadesSemAtualizacao() {
      return this.parceirosRede.filter((parceiro) => parceiro.diasSemAtualizar === null || Number(parceiro.diasSemAtualizar) >= 4);
    },

    redeAlertasOperacionais() {
      const alerts = [];
      for (const parceiro of this.parceirosRede) {
        if (Number(parceiro.estoqueBaixo || 0) > 0) {
          alerts.push({ tipo: 'Estoque crítico', texto: `${parceiro.nome}: ${parceiro.estoqueBaixo} item(ns) baixo/zerado`, tom: 'text-amber-700 bg-amber-50' });
        }
        if (this.parceiroVendaHojeValor(parceiro) <= 0) {
          alerts.push({ tipo: 'Sem venda hoje', texto: `${parceiro.nome} ainda não registrou venda hoje`, tom: 'text-rose-700 bg-rose-50' });
        }
        if (parceiro.diasSemAtualizar === null || Number(parceiro.diasSemAtualizar) >= 4) {
          alerts.push({ tipo: 'Sem atualização', texto: `${parceiro.nome}: ${parceiro.ultimaAtualizacao || 'sem registro recente'}`, tom: 'text-blue-700 bg-blue-50' });
        }
        if (Number(parceiro.lucroEstimado || 0) < 0) {
          alerts.push({ tipo: 'Resultado negativo', texto: `${parceiro.nome}: ${this.formatCurrency(parceiro.lucroEstimado)} no mês`, tom: 'text-rose-700 bg-rose-50' });
        }
        if (Number(parceiro.percentual2w || 0) >= 70) {
          alerts.push({ tipo: 'Alta dependência 2W', texto: `${parceiro.nome}: ${parceiro.percentual2w}% das vendas vêm da 2W`, tom: 'text-purple-700 bg-purple-50' });
        }
      }
      return alerts.slice(0, 8);
    },

    filteredParceirosRede() {
      if (this.redeFilter === 'alerta') return this.parceirosRede.filter((parceiro) => parceiro.alerta !== 'ok');
      if (this.redeFilter === 'sem_venda') return this.unidadesSemVendaHoje();
      if (this.redeFilter === 'sem_atualizacao') return this.unidadesSemAtualizacao();
      if (this.redeFilter === 'dependencia_2w') return this.parceirosRede.filter((parceiro) => Number(parceiro.percentual2w || 0) >= 50);
      if (this.redeFilter === 'risco') return this.parceirosRede.filter((parceiro) => this.saudeScore(parceiro) < 60);
      return this.parceirosRede;
    },

    unidadeMaiorEstoqueParado() {
      return [...this.parceirosRede].sort((a, b) => (b.estoqueItens || []).length - (a.estoqueItens || []).length)[0] || null;
    },

    unidadeMelhorMargem() {
      return [...this.parceirosRede]
        .filter((parceiro) => parceiro.margem && parceiro.margem !== '-')
        .sort((a, b) => Number(String(b.margem).replace('%', '')) - Number(String(a.margem).replace('%', '')))[0] || null;
    },

    pneusMaisVendidosRede() {
      const counts = new Map();
      for (const parceiro of this.parceirosRede) {
        for (const item of parceiro.topPneus || []) {
          const pneu = typeof item === 'string' ? item : item.pneu;
          const quantidade = typeof item === 'string' ? 1 : Number(item.quantidade || item.unidades || 0);
          if (!pneu || pneu.includes('aguardando') || pneu.includes('sem vendas')) continue;
          counts.set(pneu, (counts.get(pneu) || 0) + Math.max(quantidade, 1));
        }
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([pneu, quantidade]) => ({ pneu, quantidade }));
    },

    parceiroTotalCustos(parceiro = this.selectedParceiro()) {
      if (!parceiro) return 0;
      return Number(parceiro.comprasPneus || 0) + Number(parceiro.folha || 0) + Number(parceiro.despesasExtras || 0);
    },

    parceiroLucroClass(parceiro = this.selectedParceiro()) {
      return Number(parceiro?.lucroEstimado || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700';
    },

    estoqueStatusClass(status) {
      if (status === 'ok') return 'bg-emerald-50 text-emerald-700';
      if (status === 'baixo') return 'bg-amber-50 text-amber-700';
      if (status === 'zerado') return 'bg-rose-50 text-rose-700';
      return 'bg-gray-100 text-gray-700';
    },

    lancamentoClass(tipo) {
      if (tipo === 'Venda') return 'bg-emerald-50 text-emerald-700';
      if (typeof tipo === 'string' && tipo.startsWith('Pedido')) return 'bg-indigo-50 text-indigo-700';
      if (tipo === 'Compra pneus') return 'bg-blue-50 text-blue-700';
      if (tipo === 'Pagamento funcionário') return 'bg-purple-50 text-purple-700';
      if (tipo === 'Despesa extra') return 'bg-amber-50 text-amber-700';
      return 'bg-gray-100 text-gray-700';
    },

    lancamentoValorClass(lancamento) {
      if (lancamento && lancamento.pendente) return 'text-gray-400';
      return Number((lancamento && lancamento.valor) || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700';
    },

    saudeChecks(parceiro = this.selectedParceiro()) {
      if (!parceiro) return [];
      const estoqueItens = parceiro.estoqueItens || [];
      const margemValor = parceiro.margemValor ?? (Number(String(parceiro.margem || '0').replace('%', '')) || 0);
      return [
        { label: 'Resultado positivo', ok: Number(parceiro.lucroEstimado || 0) >= 0, peso: 20 },
        { label: 'Vendeu hoje', ok: this.parceiroVendaHojeValor(parceiro) > 0, peso: 15 },
        { label: 'Estoque atualizado', ok: Number(parceiro.diasSemAtualizar ?? 99) <= 3, peso: 15 },
        { label: 'Estoque saudável', ok: estoqueItens.length > 0 && !estoqueItens.some((item) => ['zerado', 'baixo'].includes(item.status)), peso: 15 },
        { label: 'Margem boa', ok: margemValor >= 20, peso: 15 },
        { label: 'Custos registrados', ok: Number(parceiro.comprasPneus || 0) > 0 || Number(parceiro.despesasExtras || 0) > 0 || Number(parceiro.folha || 0) > 0, peso: 10 },
        { label: 'Parceria 2W ativa', ok: Number(parceiro.vendas2w || 0) > 0, peso: 10 },
      ];
    },

    saudeScore(parceiro = this.selectedParceiro()) {
      const checks = this.saudeChecks(parceiro);
      if (checks.length === 0) return 0;
      const total = checks.reduce((sum, check) => sum + Number(check.peso || 0), 0);
      const earned = checks.reduce((sum, check) => sum + (check.ok ? Number(check.peso || 0) : 0), 0);
      return total > 0 ? Math.round((earned / total) * 100) : 0;
    },

    saudeScoreClass(parceiro = this.selectedParceiro()) {
      const score = this.saudeScore(parceiro);
      if (score >= 80) return 'text-emerald-700 bg-emerald-50';
      if (score >= 60) return 'text-amber-700 bg-amber-50';
      return 'text-rose-700 bg-rose-50';
    },

    saudeScoreLabel(parceiro = this.selectedParceiro()) {
      const score = this.saudeScore(parceiro);
      if (score >= 80) return 'forte';
      if (score >= 60) return 'atenção';
      return 'risco';
    },

    // ─── AÇÕES ──────────────────────────────────────
    openSaleModal(conv) {
      this.modalConv = conv;
      const firstProduct = this.produtos[0] || null;
      const hasDraft = Boolean(conv?.draft_id);
      this.saleForm = {
        product_id: firstProduct?.product_id || '',
        quantity: 1,
        unit_price: Number(firstProduct?.price_amount || 0),
        payment_method: conv?.draft_payment_method || 'Pix',
        fulfillment_mode: conv?.draft_fulfillment_mode || 'delivery',
        delivery_address: conv?.draft_delivery_address || '',
        notes: '',
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        source_tag: hasDraft ? 'chatwoot_com_bot' : 'chatwoot_sem_bot',
        customer_name: '',
        customer_phone: '',
      };
      this.orderError = null;
      this.saleModalOpen = true;
    },

    openWalkinModal() {
      this.modalConv = null;
      const firstProduct = this.produtos[0] || null;
      this.saleForm = {
        product_id: firstProduct?.product_id || '',
        quantity: 1,
        unit_price: Number(firstProduct?.price_amount || 0),
        payment_method: 'Dinheiro',
        fulfillment_mode: 'pickup',
        delivery_address: '',
        notes: '',
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        source_tag: 'walkin_balcao',
        customer_name: '',
        customer_phone: '',
      };
      this.orderError = null;
      this.saleModalOpen = true;
    },

    // ─── LIFECYCLE ──────────────────────────────────
    async setRedePeriod(period) {
      if (this.redePeriod === period) return;
      this.redePeriod = period;
      localStorage.setItem('farejador_rede_period', period);
      await this.loadRedeData();
    },

    updateRedeSalesGoal() {
      const value = Math.max(0, Number(this.redeSalesGoal || 0));
      this.redeSalesGoal = value;
      localStorage.setItem('farejador_rede_sales_goal', String(value));
      this.$nextTick(() => this.renderRedeChart());
    },
    ensureCredentials() {
      if (!this.apiToken && ['localhost', '127.0.0.1'].includes(location.hostname)) {
        this.apiToken = 'dev-admin-token-local';
        localStorage.setItem('farejador_admin_token', this.apiToken);
      }

      if (!this.operatorLabel) {
        this.operatorLabel = prompt('Nome do operador') || 'Wallace';
        localStorage.setItem('farejador_operator_label', this.operatorLabel);
      }

      if (!this.apiToken && location.pathname.startsWith('/admin/painel')) {
        const token = prompt('ADMIN_AUTH_TOKEN para carregar dados reais');
        if (token) {
          this.apiToken = token;
          localStorage.setItem('farejador_admin_token', token);
        }
      }
    },

    apiHeaders() {
      return {
        Authorization: `Bearer ${this.apiToken}`,
        'X-Operator-Label': this.operatorLabel,
        'Content-Type': 'application/json',
      };
    },

    async apiGet(path) {
      if (!this.apiToken) throw new Error('missing_admin_token');
      const response = await fetch(path, { headers: this.apiHeaders() });
      if (response.status === 401 && ['localhost', '127.0.0.1'].includes(location.hostname)) {
        this.apiToken = 'dev-admin-token-local';
        localStorage.setItem('farejador_admin_token', this.apiToken);
        const retry = await fetch(path, { headers: this.apiHeaders() });
        if (!retry.ok) throw new Error(`api_${retry.status}`);
        return retry.json();
      }
      if (!response.ok) throw new Error(`api_${response.status}`);
      return response.json();
    },

    async apiPost(path, body) {
      if (!this.apiToken) throw new Error('missing_admin_token');
      const response = await fetch(path, {
        method: 'POST',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const e = new Error(payload.error || `api_${response.status}`);
        e.payload = payload; e.status = response.status; // detalhe do erro (ex.: oversell)
        throw e;
      }
      return response.json();
    },

    async apiPut(path, body) {
      if (!this.apiToken) throw new Error('missing_admin_token');
      const response = await fetch(path, {
        method: 'PUT',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `api_${response.status}`);
      }
      return response.json();
    },

    // Matriz define o raio de entrega do parceiro selecionado (proximidade-primeiro Fase 2).
    async salvarRaioEntrega() {
      const p = this.selectedParceiro();
      if (!p) return;
      if (!p.fazEntrega) { alert('Este parceiro está como só retirada — peça pra ele ligar a entrega no painel antes de definir o raio.'); return; }
      let km = p.deliveryRadiusKm;
      if (km === '' || km === undefined) km = null;
      if (km !== null) {
        km = Number(km);
        if (!Number.isFinite(km) || km <= 0) { alert('Informe um raio válido (km maior que zero).'); return; }
        if (km > 9999.99) { alert('Raio muito grande.'); return; }
      }
      this.savingRaio = true;
      try {
        await this.apiPut(`/admin/api/partners/${encodeURIComponent(p.id)}/delivery-radius`, { delivery_radius_km: km });
        p.deliveryRadiusKm = km;
        this.raioSalvoMsg = km === null ? 'Raio limpo.' : 'Raio salvo.';
        setTimeout(() => { this.raioSalvoMsg = ''; }, 2500);
      } catch (err) {
        const msg = String(err && err.message || err);
        alert(msg === 'partner_pickup_only'
          ? 'Esse parceiro está como só retirada — não dá pra definir raio.'
          : 'Não consegui salvar o raio: ' + msg);
      } finally {
        this.savingRaio = false;
      }
    },

    formatCurrency(value) {
      return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    },

    formatDateTime(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    },

    timeAgo(value) {
      if (!value) return '-';
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}min`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}d`;
    },

    truncateText(value, max = 110) {
      const text = String(value || '').trim();
      if (text.length <= max) return text;
      return `${text.slice(0, max - 1)}...`;
    },

    initials(name) {
      return (name || '?').trim().slice(0, 1).toUpperCase();
    },

    displaySlot(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (typeof value === 'object' && 'value' in value) return this.displaySlot(value.value);
      return JSON.stringify(value);
    },

    itemSummary(items) {
      if (!Array.isArray(items) || items.length === 0) return 'Sem itens';
      return items.map((item) => {
        const name = item.product_name || item.product_code || item.product_id || 'Produto';
        return `${item.quantity || 1}x ${name}`;
      }).join(' + ');
    },

    selectedProduct() {
      return this.produtos.find((product) => product.product_id === this.saleForm.product_id) || null;
    },

    saleTotal() {
      return this.formatCurrency(Number(this.saleForm.quantity || 0) * Number(this.saleForm.unit_price || 0));
    },

    onProductChanged() {
      const product = this.selectedProduct();
      this.saleForm.unit_price = Number(product?.price_amount || 0);
    },

    applyPedidos(rows) {
      const deliveryLabels = { pending: 'Em separação', dispatched: 'Saiu pra entrega', delivered: 'Entregue', failed: 'Entrega falhou' };
      this.pedidos = (rows || []).map((row) => {
        // Pedido de parceiro tem o ciclo de vida real no partner_orders; o espelho fica 'open'.
        const isPartner = !!row.is_partner;
        const cancelled = row.status === 'cancelled' || row.partner_status === 'cancelled';
        let status, statusClass, dotClass;
        if (cancelled) {
          status = 'Cancelado'; statusClass = 'bg-rose-50 text-rose-700'; dotClass = 'bg-rose-500';
        } else if (isPartner) {
          status = deliveryLabels[row.delivery_status] || row.partner_status || 'Pedido';
          const done = row.delivery_status === 'delivered';
          statusClass = done ? 'bg-emerald-50 text-emerald-700' : 'bg-indigo-50 text-indigo-700';
          dotClass = done ? 'bg-emerald-500' : 'bg-indigo-500';
        } else {
          status = ({ open: 'Aberto', confirmed: 'Confirmado', pending: 'Pendente' })[row.status] || row.status || 'Aberto';
          statusClass = 'bg-emerald-50 text-emerald-700'; dotClass = 'bg-emerald-500';
        }
        const pagto = isPartner
          ? (row.payment_status === 'pago' ? 'Pago' : 'A receber')
          : (row.payment_method || '-');
        return {
          data: this.formatDateTime(row.created_at),
          cliente: row.contact_name || 'Cliente',
          itens: this.itemSummary(row.items),
          pagto,
          operador: row.registered_by || '-',
          total: this.formatCurrency(row.total_amount),
          totalAmount: Number(row.total_amount || 0),
          unitSlug: row.unit_slug || null,
          isPartner,
          status,
          statusClass,
          dotClass,
        };
      });
    },

    // Aba Vendas — Varejo = o que a MATRIZ (unit 'main') vende direto pro cliente final.
    // Reusa this.pedidos (já carregado de /dashboard/pedidos) filtrando a unidade própria.
    // Pedido roteado pro parceiro NÃO é venda da matriz — fica na aba Rede.
    vendasVarejo() {
      return this.pedidos.filter((p) => p.unitSlug === 'main');
    },
    vendasVarejoAtivas() {
      return this.vendasVarejo().filter((p) => p.status !== 'Cancelado');
    },
    vendasVarejoTotal() {
      return this.vendasVarejoAtivas().reduce((sum, p) => sum + Number(p.totalAmount || 0), 0);
    },

    // ── ATACADO (Fase 1) — venda pro borracheiro + ranking de recompra ──
    atacadoBuyerKey(b) {
      return b.customer_id ? `c:${b.customer_id}` : `p:${b.partner_id}`;
    },
    async loadAtacado() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      this.atacadoLoading = true;
      try {
        const [buyers, ranking, measures, stock, resumo, suppliers, supRanking, purchases, breakdown, finance, vendas] = await Promise.all([
          this.apiGet('/admin/api/wholesale/buyers'),
          this.apiGet('/admin/api/wholesale/ranking'),
          this.apiGet('/admin/api/wholesale/measures'),
          this.apiGet('/admin/api/wholesale/stock'),
          this.apiGet('/admin/api/wholesale/resumo'),
          this.apiGet('/admin/api/wholesale/suppliers'),
          this.apiGet('/admin/api/wholesale/suppliers/ranking'),
          this.apiGet('/admin/api/wholesale/purchases'),
          this.apiGet('/admin/api/wholesale/suppliers/breakdown'),
          this.apiGet('/admin/api/wholesale/finance'),
          this.apiGet('/admin/api/wholesale/sales'),
        ]);
        this.atacadoBuyers = buyers.rows || [];
        this.atacadoRanking = ranking.rows || [];
        this.atacadoMeasures = measures.rows || [];
        this.atacadoStock = stock.rows || [];
        this.atacadoResumo = resumo || null;
        this.fornecedores = suppliers.rows || [];
        this.fornecedorRanking = supRanking.rows || [];
        this.compras = purchases.rows || [];
        this.fornecedorBreakdown = breakdown.rows || [];
        // flag off → enabled:false → null (a UI do financeiro some inteira)
        this.atacadoFinance = finance && finance.enabled ? finance : null;
        this.atacadoVendas = vendas.rows || [];
      } catch (err) {
        this.atacadoBuyers = [];
        this.atacadoRanking = [];
        this.atacadoMeasures = [];
        this.atacadoStock = [];
        this.atacadoResumo = null;
        this.fornecedores = [];
        this.fornecedorRanking = [];
        this.compras = [];
        this.fornecedorBreakdown = [];
        this.atacadoFinance = null;
        this.atacadoVendas = [];
        console.warn('atacado load falhou:', err.message);
      } finally {
        this.atacadoLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    atacadoAddItem() {
      this.atacadoForm.items.push({ measure: '', brand: '', quantity: 1, unit_price: '' });
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    atacadoRemoveItem(i) {
      if (this.atacadoForm.items.length > 1) this.atacadoForm.items.splice(i, 1);
    },
    atacadoFormTotal() {
      return this.atacadoForm.items.reduce(
        (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0,
      );
    },
    atacadoLastPurchase(b) {
      if (!b.last_purchase_at) return '—';
      const d = new Date(b.last_purchase_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    atacadoStatus(b) {
      if (!Number(b.orders_count)) return { label: 'nunca comprou', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-400' };
      if (b.days_since_last != null && Number(b.days_since_last) > this.atacadoStaleDays)
        return { label: `sumiu (${b.days_since_last}d)`, cls: 'bg-rose-50 text-rose-600', dot: 'bg-rose-400' };
      return { label: 'ativo', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' };
    },
    async atacadoSubmit() {
      const f = this.atacadoForm;
      const body = { items: [], notes: f.notes ? f.notes.trim() : null };
      if (f.buyerKey === 'new') {
        if (!f.newName.trim()) { this.atacadoMsg = { ok: false, text: 'Diga o nome do novo cliente.' }; return; }
        body.new_customer = { name: f.newName.trim(), phone: f.newPhone.trim() || null };
      } else if (f.buyerKey.startsWith('c:')) {
        body.customer_id = f.buyerKey.slice(2);
      } else if (f.buyerKey.startsWith('p:')) {
        body.partner_id = f.buyerKey.slice(2);
      } else {
        this.atacadoMsg = { ok: false, text: 'Escolha o borracheiro.' }; return;
      }
      const items = f.items
        .filter((it) => it.measure && it.measure.trim() && Number(it.quantity) > 0)
        .map((it) => ({
          measure: it.measure.trim(),
          brand: it.brand && it.brand.trim() ? it.brand.trim() : null,
          quantity: Number(it.quantity),
          unit_price: Number(it.unit_price) || 0,
        }));
      if (items.length === 0) { this.atacadoMsg = { ok: false, text: 'Adicione ao menos um pneu (medida e quantidade).' }; return; }
      body.items = items;
      // FINANCEIRO (0115): fiado só quando o financeiro está ligado (flag). Vencimento opcional.
      if (this.atacadoFinance && f.payment_status === 'pending') {
        body.payment_status = 'pending';
        if (f.due_date) body.due_date = f.due_date;
      }

      this.atacadoSaving = true;
      this.atacadoMsg = null;
      try {
        let result;
        try {
          result = await this.apiPost('/admin/api/wholesale/sales', body);
        } catch (err) {
          // Trava de oversell (409): avisa o que faltou e, se o caixa confirmar, reenvia.
          if (err.payload && err.payload.error === 'oversell') {
            const lista = (err.payload.items || [])
              .map((x) => `${x.measure} (tem ${x.available}, pediu ${x.requested})`).join('; ');
            if (!window.confirm(`Estoque insuficiente — ${lista}.\n\nVender assim mesmo? O galpão vai a zero nessas medidas.`)) {
              this.atacadoMsg = { ok: false, text: 'Venda cancelada — sem estoque suficiente.' };
              return;
            }
            result = await this.apiPost('/admin/api/wholesale/sales', { ...body, allow_oversell: true });
          } else {
            throw err;
          }
        }
        const fiadoTxt = body.payment_status === 'pending' ? ' (FIADO — foi pro a receber)' : '';
        this.atacadoMsg = { ok: true, text: `Venda registrada pra ${result.buyer_name} — ${this.formatCurrency(Number(result.total_amount))}${fiadoTxt}.` };
        this.atacadoForm = { buyerKey: '', newName: '', newPhone: '', notes: '', payment_status: 'paid', due_date: '', items: [{ measure: '', brand: '', quantity: 1, unit_price: '' }] };
        await this.loadAtacado();
      } catch (err) {
        this.atacadoMsg = { ok: false, text: this.atacadoErrText(err.message) };
      } finally {
        this.atacadoSaving = false;
      }
    },
    atacadoErrText(code) {
      const map = {
        buyer_required: 'Escolha ou cadastre o comprador.',
        items_required: 'Adicione ao menos um pneu.',
        partner_not_found: 'Parceiro não encontrado.',
        buyer_not_found: 'Cliente não encontrado.',
      };
      return map[code] || `Não consegui registrar (${code}).`;
    },

    // ── ATACADO — FORNECEDORES (0114): compra/entrada com origem ──
    compraAddItem() {
      this.compraForm.items.push({ measure: '', brand: '', quantity: 1, unit_cost: '' });
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    compraRemoveItem(i) {
      if (this.compraForm.items.length > 1) this.compraForm.items.splice(i, 1);
    },
    compraFormTotal() {
      return this.compraForm.items.reduce(
        (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_cost) || 0), 0,
      );
    },
    fornecedorLastPurchase(s) {
      if (!s.last_purchase_at) return '—';
      const d = new Date(s.last_purchase_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    fornecedorStatus(s) {
      if (!Number(s.purchases_count)) return { label: 'sem compra', cls: 'bg-amber-50 text-amber-700' };
      if (s.days_since_last != null && Number(s.days_since_last) > this.atacadoStaleDays)
        return { label: `parado (${s.days_since_last}d)`, cls: 'bg-rose-50 text-rose-600' };
      return { label: 'ativo', cls: 'bg-emerald-50 text-emerald-700' };
    },
    // ── INSIGHTS de fornecedor (0114) — lê só das compras já registradas ──
    // #4 Dependência: % das compras (R$) que vem do MAIOR fornecedor. >60% acende alerta.
    fornecedorDependencia() {
      const tot = this.fornecedorRanking.reduce((s, f) => s + Number(f.total_spent || 0), 0);
      if (tot <= 0) return null;
      let topRow = null;
      for (const f of this.fornecedorRanking) {
        if (!topRow || Number(f.total_spent || 0) > Number(topRow.total_spent || 0)) topRow = f;
      }
      return { pct: Math.round((Number(topRow.total_spent || 0) / tot) * 100), name: topRow.name };
    },
    // #1 + #2: agrupa o breakdown por MEDIDA; dentro de cada uma já vem do mais barato
    // pro mais caro (o banco ordena), então o 1º fornecedor é o "mais barato".
    breakdownByMeasure() {
      const groups = [];
      const byKey = {};
      for (const row of this.fornecedorBreakdown) {
        let g = byKey[row.measure];
        if (!g) { g = { measure: row.measure, suppliers: [], qty: 0 }; byKey[row.measure] = g; groups.push(g); }
        g.suppliers.push({ ...row, cheapest: g.suppliers.length === 0 });
        g.qty += Number(row.qty_total || 0);
      }
      return groups.sort((a, b) => b.qty - a.qty); // a medida que mais compro primeiro
    },
    fornecedorBreakdownDate(row) {
      if (!row.last_purchased_at) return '—';
      const d = new Date(row.last_purchased_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    async compraSubmit() {
      const f = this.compraForm;
      const body = { items: [], notes: f.notes ? f.notes.trim() : null };
      if (f.supplierKey === 'new') {
        if (!f.newName.trim()) { this.compraMsg = { ok: false, text: 'Diga o nome do novo fornecedor.' }; return; }
        body.new_supplier = { name: f.newName.trim(), phone: f.newPhone.trim() || null };
      } else if (f.supplierKey) {
        body.supplier_id = f.supplierKey;
      } else {
        this.compraMsg = { ok: false, text: 'Escolha o fornecedor.' }; return;
      }
      const items = f.items
        .filter((it) => it.measure && it.measure.trim() && Number(it.quantity) > 0)
        .map((it) => ({
          measure: it.measure.trim(),
          brand: it.brand && it.brand.trim() ? it.brand.trim() : null,
          quantity: Number(it.quantity),
          unit_cost: Number(it.unit_cost) || 0,
        }));
      if (items.length === 0) { this.compraMsg = { ok: false, text: 'Adicione ao menos um pneu (medida e quantidade).' }; return; }
      body.items = items;
      // FINANCEIRO (0115): compra fiada só com o financeiro ligado (flag).
      if (this.atacadoFinance && f.payment_status === 'pending') {
        body.payment_status = 'pending';
        if (f.due_date) body.due_date = f.due_date;
      }

      this.compraSaving = true;
      this.compraMsg = null;
      try {
        const result = await this.apiPost('/admin/api/wholesale/purchases', body);
        const fiadoTxt = body.payment_status === 'pending' ? ' (A PRAZO — foi pro a pagar)' : '';
        this.compraMsg = { ok: true, text: `Compra registrada de ${result.supplier_name} — ${this.formatCurrency(Number(result.total_amount))}${fiadoTxt}. O galpão já recebeu.` };
        this.compraForm = { supplierKey: '', newName: '', newPhone: '', notes: '', payment_status: 'paid', due_date: '', items: [{ measure: '', brand: '', quantity: 1, unit_cost: '' }] };
        await this.loadAtacado();
      } catch (err) {
        this.compraMsg = { ok: false, text: this.compraErrText(err.message) };
      } finally {
        this.compraSaving = false;
      }
    },
    compraErrText(code) {
      const map = {
        supplier_required: 'Escolha ou cadastre o fornecedor.',
        supplier_not_found: 'Fornecedor não encontrado.',
        items_required: 'Adicione ao menos um pneu.',
        measure_not_in_catalog: 'Essa medida não está no catálogo — confira o número.',
      };
      return map[code] || `Não consegui registrar (${code}).`;
    },

    // ── ATACADO — CANCELAR VENDA (0116): registro errado sai sem apagar ──
    vendaData(v) {
      if (!v.sold_at) return '—';
      const d = new Date(v.sold_at);
      return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    async atacadoCancelSale(v) {
      const pago = v.payment_status === 'paid';
      const aviso = pago
        ? '\n\n⚠️ Essa venda consta como PAGA — se o dinheiro já entrou, o acerto com o borracheiro é por fora.'
        : '\n\nEla sai do ranking, do resumo e do a receber; o estoque volta pro galpão.';
      if (!window.confirm(`Cancelar a venda de ${v.buyer_name} (${this.formatCurrency(Number(v.total_amount))})?${aviso}`)) return;
      const reason = window.prompt('Motivo (opcional):') || null;
      try {
        await this.apiPost('/admin/api/wholesale/sales/cancel', { order_id: v.id, reason });
        await this.loadAtacado();
      } catch (err) {
        const msg = err.message === 'sale_already_cancelled' ? 'Essa venda já estava cancelada.' : `Não consegui cancelar (${err.message}).`;
        window.alert(msg);
      }
    },

    // ── ATACADO — FINANCEIRO (0115): fiado a receber/a pagar + quitar ──
    financeDate(d) {
      if (!d) return 'sem data';
      const dt = new Date(d + (String(d).length === 10 ? 'T12:00:00' : ''));
      return isNaN(dt.getTime()) ? 'sem data' : dt.toLocaleDateString('pt-BR');
    },
    async financeSettle(kind, row) {
      const rotulo = kind === 'sale' ? `receber de ${row.counterparty}` : `pagar pra ${row.counterparty}`;
      if (!window.confirm(`Quitar ${this.formatCurrency(Number(row.total_amount))} (${rotulo})?`)) return;
      try {
        await this.apiPost('/admin/api/wholesale/finance/settle', { kind, id: row.id });
        await this.loadAtacado();
      } catch (err) {
        window.alert(`Não consegui quitar (${err.message}). Recarrega a página e tenta de novo.`);
      }
    },

    // ── ATACADO (Fase 2) — estoque do galpão por medida ──
    measureOnHand(measure) {
      // Quanto tem de uma medida (pro form de venda mostrar "em estoque"). null = não cadastrada.
      const m = (measure || '').trim();
      if (!m) return null;
      const row = this.atacadoMeasures.find((x) => x.measure === m);
      return row && row.quantity_on_hand != null ? Number(row.quantity_on_hand) : null;
    },
    // Custo unitário cadastrado da medida (null = sem estoque/custo). Fase 3.
    measureCost(measure) {
      const m = (measure || '').trim();
      if (!m) return null;
      const row = this.atacadoMeasures.find((x) => x.measure === m);
      return row && row.unit_cost != null ? Number(row.unit_cost) : null;
    },
    // Lucro estimado de um item da venda = (preço − custo) × qtd. null se a medida não tem custo.
    itemProfit(it) {
      const cost = this.measureCost(it.measure);
      if (cost == null) return null;
      return (Number(it.unit_price || 0) - cost) * (Number(it.quantity) || 0);
    },
    // Autocomplete da medida: casa por TEXTO e por DÍGITOS (ignora / - e espaço — ex.:
    // "90 90 18" acha "90/90-18"). Campo vazio na VENDA mostra o que TEM no galpão (atalho
    // pra escolher clicando); no cadastro do galpão (key='estoque') não abre nada vazio.
    measureFind(query, key) {
      const raw = (query || '').trim().toLowerCase();
      const digits = (s) => (s || '').replace(/\D/g, ''); // só números: casa qualquer separador
      const qd = digits(raw);
      let hits;
      if (!raw) {
        hits = key === 'estoque' ? [] : this.atacadoMeasures.filter((m) => Number(m.quantity_on_hand) > 0).slice(0, 12);
      } else {
        hits = this.atacadoMeasures.filter((m) => {
          const mm = m.measure.toLowerCase();
          return mm.includes(raw) || (qd !== '' && digits(mm).includes(qd));
        }).slice(0, 12);
      }
      this.measureBox = { key, hits };
    },
    measurePick(value, obj) {
      obj.measure = value;
      this.measureBox = { key: null, hits: [] };
    },
    measureBlur() {
      // delay pra o clique numa sugestão (mousedown) acontecer antes de fechar
      setTimeout(() => { this.measureBox = { key: null, hits: [] }; }, 150);
    },
    // Texto amigável dos erros do cadastro do galpão (Fase 4: medida fora do catálogo).
    stockErrText(code, acao) {
      const map = {
        measure_not_in_catalog: 'Essa medida não está no catálogo. Confira (ex.: 90/90-18) ou peça pra adicionar ao catálogo.',
        measure_required: 'Diga a medida (ex.: 90/90-18).',
        quantity_invalid: 'Quantidade inválida.',
        cost_invalid: 'Custo inválido.',
      };
      return map[code] || `Não consegui ${acao === 'entrada' ? 'registrar a entrada' : 'salvar'} (${code}).`;
    },
    async stockSubmit() {
      const measure = (this.stockForm.measure || '').trim();
      const qty = Number(this.stockForm.quantity_on_hand);
      const cost = Number(this.stockForm.unit_cost) || 0;
      if (!measure) { this.stockMsg = { ok: false, text: 'Diga a medida (ex.: 90/90-18).' }; return; }
      if (!Number.isInteger(qty) || qty < 0) { this.stockMsg = { ok: false, text: 'Quantidade inválida.' }; return; }
      if (cost < 0) { this.stockMsg = { ok: false, text: 'Custo inválido.' }; return; }
      this.stockSaving = true;
      this.stockMsg = null;
      try {
        await this.apiPost('/admin/api/wholesale/stock', {
          measure,
          quantity_on_hand: qty,
          unit_cost: cost,
          notes: this.stockForm.notes ? this.stockForm.notes.trim() : null,
        });
        this.stockMsg = { ok: true, text: `${measure}: ${qty} un · custo R$ ${cost.toFixed(2)}.` };
        this.stockForm = { measure: '', quantity_on_hand: '', unit_cost: '', notes: '' };
        await this.loadAtacado();
      } catch (err) {
        this.stockMsg = { ok: false, text: this.stockErrText(err.message) };
      } finally {
        this.stockSaving = false;
      }
    },
    stockEdit(row) {
      this.stockForm = { measure: row.measure, quantity_on_hand: row.quantity_on_hand, unit_cost: row.unit_cost ?? '', notes: row.notes || '' };
      this.stockMsg = null;
    },
    // ENTRADA de compra: soma a qtd e recalcula o custo médio ponderado (a conta que "bate").
    async stockEntry() {
      const measure = (this.stockForm.measure || '').trim();
      const qty = Number(this.stockForm.quantity_on_hand);
      const cost = Number(this.stockForm.unit_cost) || 0;
      if (!measure) { this.stockMsg = { ok: false, text: 'Diga a medida (ex.: 90/90-18).' }; return; }
      if (!Number.isInteger(qty) || qty <= 0) { this.stockMsg = { ok: false, text: 'Quantos pneus entraram?' }; return; }
      if (cost < 0) { this.stockMsg = { ok: false, text: 'Custo inválido.' }; return; }
      this.stockSaving = true;
      this.stockMsg = null;
      try {
        const row = await this.apiPost('/admin/api/wholesale/stock/entry', { measure, quantity_in: qty, unit_cost: cost });
        this.stockMsg = { ok: true, text: `Entrada de ${qty} × ${measure} a R$ ${cost.toFixed(2)} → estoque ${row.quantity_on_hand} un · custo médio R$ ${Number(row.unit_cost).toFixed(2)}.` };
        this.stockForm = { measure: '', quantity_on_hand: '', unit_cost: '', notes: '' };
        await this.loadAtacado();
      } catch (err) {
        this.stockMsg = { ok: false, text: this.stockErrText(err.message, 'entrada') };
      } finally {
        this.stockSaving = false;
      }
    },
    async stockRemove(measure) {
      if (!window.confirm(`Remover ${measure} do estoque do galpão?`)) return;
      try {
        await this.apiPost('/admin/api/wholesale/stock/remove', { measure });
        await this.loadAtacado();
      } catch (err) {
        this.stockMsg = { ok: false, text: `Não consegui remover (${err.message}).` };
      }
    },

    applyProdutos(rows) {
      this.produtos = rows || [];
    },

    // Resumo do dono: bot/tráfego (analytics, read-only) + leads a recuperar.
    applyMatrizResumo(data) {
      const m = (data && data.metrics) || {};
      this.kpis = [
        { label: 'Conversas', value: String(m.conversas || 0), delta: `${m.fecharam || 0} fecharam`, deltaClass: 'bg-blue-50 text-blue-700', icon: 'message-circle', iconBg: 'bg-blue-100', iconColor: 'text-blue-700' },
        { label: 'Conversão', value: `${Number(m.taxa_conversao || 0)}%`, delta: `${m.abandonaram || 0} largaram`, deltaClass: 'bg-emerald-50 text-emerald-700', icon: 'trending-up', iconBg: 'bg-emerald-100', iconColor: 'text-emerald-700' },
        { label: 'Faturamento via bot', value: this.formatCurrency(m.faturamento), delta: `ticket ${this.formatCurrency(m.ticket_medio)}`, deltaClass: 'bg-purple-50 text-purple-700', icon: 'wallet', iconBg: 'bg-purple-100', iconColor: 'text-purple-700' },
        { label: 'Custo do bot', value: this.formatCurrency(m.custo_bot), delta: 'IA no período', deltaClass: 'bg-amber-50 text-amber-700', icon: 'bot', iconBg: 'bg-amber-100', iconColor: 'text-amber-700' },
      ];
      this.leadsRecuperar = ((data && data.leads) || []).map((l) => ({
        nome: l.cliente_nome || 'Sem nome',
        telefone: l.cliente_telefone || '-',
        moto: l.moto || '-',
        bairro: l.bairro || '-',
        preco: l.ultimo_preco_cotado || null,
        motivo: l.provavel_motivo || l.etapa_atingida || 'sem motivo',
        horas: l.horas != null ? Math.round(Number(l.horas)) : null,
        reclamouPreco: !!l.reclamou_preco,
        concorrente: !!l.mencionou_concorrente,
      }));
      this.resumoSeries = ((data && data.series) || []).map((s) => ({
        dia: s.dia,
        conversas: Number(s.conversas || 0),
        faturamento: Number(s.faturamento || 0),
      }));
    },

    partnerStatusLabel(status) {
      if (status === 'active') return 'Ativo';
      if (status === 'suspended') return 'Suspenso';
      return 'Credenciamento';
    },

    partnerCommercialModel(row) {
      const model = row.commercial_model === 'monthly'
        ? 'mensalidade'
        : row.commercial_model === 'hybrid'
          ? 'mensalidade + comissao'
          : 'comissao por venda';
      return `Credenciado · ${model}`;
    },

    mapPartnerStockStatus(status) {
      if (status === 'in_stock') return 'ok';
      if (status === 'low_stock') return 'baixo';
      if (status === 'out_of_stock') return 'zerado';
      if (status === 'not_tracked') return 'não controlado';
      return 'validar preço';
    },

    mapPartnerEventType(type) {
      if (type === 'Pagamento funcionario') return 'Pagamento funcionário';
      return type || 'Lançamento';
    },

    funilPct(num, den) {
      const n = Number(num || 0);
      const d = Number(den || 0);
      return d > 0 ? Math.round((n / d) * 100) + '%' : '–';
    },

    applyRede(rows) {
      if (!Array.isArray(rows)) return;
      // API vazia = rede sem parceiros reais → lista vazia (NÃO volta pro mock).
      if (rows.length === 0) { this.parceirosRede = []; return; }

      this.parceirosRede = rows.map((row) => {
        const vendasValor = Number(row.sales_month || 0);
        const pedidos = Number(row.orders_month || 0);
        const comprasPneus = Number(row.purchases_month || 0);
        const folha = Number(row.employee_total || 0);
        const despesasExtras = Number(row.other_expenses_total || 0);
        const lucroEstimado = Number(row.estimated_result_month || 0);
        const ticket = pedidos > 0 ? vendasValor / pedidos : 0;
        const estoqueRows = Array.isArray(row.stock_rows) ? row.stock_rows : [];
        const events = Array.isArray(row.recent_events) ? row.recent_events : [];
        const topItems = Array.isArray(row.top_items) ? row.top_items : [];
        const serieVendas = Array.isArray(row.sales_series) && row.sales_series.length > 0
          ? row.sales_series.map((value) => Number(value || 0))
          : [0, 0, 0, 0, 0, 0, Number(row.sales_today || 0)];
        const seriePedidos = Array.isArray(row.order_series) && row.order_series.length > 0
          ? row.order_series.map((value) => Number(value || 0))
          : [0, 0, 0, 0, 0, 0, Number(row.orders_today || 0)];
        const margem = vendasValor > 0 ? Math.round((lucroEstimado / vendasValor) * 100) : null;
        const lastActivityTimes = [
          ...estoqueRows.map((item) => item.updated_at),
          ...events.map((event) => event.event_at),
        ]
          .filter(Boolean)
          .map((value) => new Date(value).getTime())
          .filter((value) => Number.isFinite(value));
        const lastActivityAt = lastActivityTimes.length > 0
          ? new Date(Math.max(...lastActivityTimes)).toISOString()
          : null;
        const diasSemAtualizar = lastActivityAt
          ? Math.max(0, Math.floor((Date.now() - new Date(lastActivityAt).getTime()) / 86400000))
          : null;
        const vendas2w = Number(row.sales_2w || 0);
        const vendasPorta = Number(row.sales_porta || 0);
        const pedidos2w = Number(row.orders_2w || 0);
        const pedidosPorta = Number(row.orders_porta || 0);
        const percentual2w = vendasValor > 0 ? Math.round((vendas2w / vendasValor) * 100) : 0;

        // ─── Cobrança matriz↔parceiro ──────────────────────────────
        // Base da comissão = vendas de origem 2W (o que a matriz trouxe).
        // Mensalidade é valor fixo do mês. O modelo comercial decide o que incide.
        const modeloComercialRaw = row.commercial_model || 'commission';
        const comissaoPercent = row.commission_percent === null || row.commission_percent === undefined
          ? null
          : Number(row.commission_percent);
        const mensalidadeValor = row.monthly_fee === null || row.monthly_fee === undefined
          ? null
          : Number(row.monthly_fee);
        const cobraComissao = modeloComercialRaw === 'commission' || modeloComercialRaw === 'hybrid';
        const cobraMensalidade = modeloComercialRaw === 'monthly' || modeloComercialRaw === 'hybrid';
        const comissaoDevida = cobraComissao && comissaoPercent ? vendas2w * (comissaoPercent / 100) : 0;
        const mensalidadeDevida = cobraMensalidade && mensalidadeValor ? mensalidadeValor : 0;
        const devidoMatriz = comissaoDevida + mensalidadeDevida;

        return {
          id: row.partner_unit_id,
          unitId: row.unit_id,
          slug: row.slug,
          nome: row.display_name || row.partner_name || 'Unidade',
          documento: row.document_number || '-',
          responsavel: row.responsible_name || '-',
          whatsapp: row.whatsapp_phone || '-',
          endereco: row.address || '-',
          modeloComercial: this.partnerCommercialModel(row),
          comissao: row.commission_percent ? `${Number(row.commission_percent)}%` : (row.monthly_fee ? this.formatCurrency(row.monthly_fee) : '-'),
          cidade: row.address || '-',
          status: this.partnerStatusLabel(row.unit_status || row.partner_status),
          vendas: this.formatCurrency(vendasValor),
          vendasValor,
          pedidos,
          ticketValor: ticket,
          ticket: this.formatCurrency(ticket),
          estoque: `${Number(row.stock_items || 0)} itens`,
          estoqueBaixo: Number(row.low_stock_items || 0),
          margem: margem === null ? '-' : `${margem}%`,
          margemValor: margem,
          comprasPneus,
          folha,
          despesasExtras,
          lucroEstimado,
          vendas2w,
          vendasPorta,
          pedidos2w,
          pedidosPorta,
          percentual2w,
          funilTentou: Number((row.funil && row.funil.tentou) || 0),
          funilPediu: Number((row.funil && row.funil.pediu) || 0),
          funilEfetivou: Number((row.funil && row.funil.efetivou) || 0),
          commercialModel: modeloComercialRaw,
          serviceMode: row.service_mode || 'both',
          fazEntrega: (row.service_mode || 'both') === 'delivery' || (row.service_mode || 'both') === 'both',
          deliveryRadiusKm: (row.delivery_radius_km === null || row.delivery_radius_km === undefined)
            ? null : Number(row.delivery_radius_km),
          comissaoPercent,
          mensalidadeValor,
          comissaoDevida,
          mensalidadeDevida,
          devidoMatriz,
          alerta: Number(row.low_stock_items || 0) > 0
            ? `${row.low_stock_items} baixos`
            : Number(row.orders_today || 0) <= 0
              ? 'sem venda hoje'
              : 'ok',
          serieVendas,
          seriePedidos,
          topPneus: topItems.length > 0
            ? topItems.map((item) => ({ pneu: item.label, quantidade: Number(item.quantity || 0) }))
            : [{ pneu: 'sem vendas ainda', quantidade: 0 }],
          estoqueItens: estoqueRows.map((item) => {
            const custo = item.average_cost === null || item.average_cost === undefined ? null : Number(item.average_cost);
            const venda = item.sale_price === null || item.sale_price === undefined ? null : Number(item.sale_price);
            const margemItem = custo !== null && venda !== null && venda > 0
              ? `${Math.round(((venda - custo) / venda) * 100)}%`
              : '-';
            return {
              pneu: item.item_name,
              qtd: item.is_tracked ? item.quantity_on_hand : null,
              minimo: item.minimum_quantity,
              ultimaCompra: item.updated_at ? this.formatDateTime(item.updated_at) : '-',
              fornecedor: item.supplier_name || '-',
              custoMedio: custo === null ? '-' : this.formatCurrency(custo),
              custoValor: custo,
              custo: custo === null ? '-' : this.formatCurrency(custo),
              vendaValor: venda,
              venda: venda === null ? '-' : this.formatCurrency(venda),
              margem: margemItem,
              status: this.mapPartnerStockStatus(item.stock_status),
            };
          }),
          equipe: row.responsible_name ? [row.responsible_name] : [],
          lastActivityAt,
          diasSemAtualizar,
          ultimaAtualizacao: lastActivityAt ? this.formatDateTime(lastActivityAt) : 'sem registro',
          lancamentos: events.map((event) => {
            const tipo = this.mapPartnerEventType(event.type);
            return {
              tipo,
              pendente: typeof tipo === 'string' && tipo.startsWith('Pedido'),
              data: event.event_at ? this.formatDateTime(event.event_at) : '-',
              descricao: event.description || '-',
              valor: Number(event.amount || 0),
            };
          }),
          custosRecentes: [
            { label: 'Compra pneus', value: this.formatCurrency(comprasPneus) },
            { label: 'Folha / funcionários', value: this.formatCurrency(folha) },
            { label: 'Despesas extras', value: this.formatCurrency(despesasExtras) },
          ],
        };
      });

      this.redeKpis = [
        { label: 'Parceiros ativos', value: String(this.parceirosRede.filter((p) => p.status === 'Ativo').length), detail: `${this.parceirosRede.length} cadastrados`, icon: 'building-2', tone: 'bg-blue-50 text-blue-700' },
        { label: 'Vendas da rede', value: this.redeTotalVendas(), detail: this.redePeriodLabel(), icon: 'trending-up', tone: 'bg-emerald-50 text-emerald-700' },
        { label: 'Ticket médio', value: this.formatCurrency(this.redeTicketMedio()), detail: `${this.redeTotalPedidos()} pedidos`, icon: 'receipt', tone: 'bg-sky-50 text-sky-700' },
        { label: 'Conversão 2W', value: `${this.redeConversao2w()}%`, detail: `${this.formatCurrency(this.redeTotal2w())} da rede`, icon: 'handshake', tone: 'bg-purple-50 text-purple-700' },
        { label: 'Estoque total', value: String(this.redeEstoqueQuantidade()), detail: `${this.formatCurrency(this.redeEstoqueValor())} em custo`, icon: 'package', tone: 'bg-amber-50 text-amber-700' },
        { label: 'Alertas operacionais', value: String(this.redeAlertasOperacionais().length), detail: 'risco, estoque ou atualização', icon: 'alert-triangle', tone: 'bg-rose-50 text-rose-700' },
      ];

      if (this.selectedParceiroIndex >= this.parceirosRede.length) {
        this.selectedParceiroIndex = 0;
      }
    },

    async submitManualOrder() {
      if (this.orderSubmitting) return;
      if (!this.saleForm.product_id) {
        this.orderError = 'Escolha um produto do catalogo.';
        return;
      }
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim()) {
        this.orderError = 'Informe o endereco de entrega ou troque para retirada.';
        return;
      }

      const items = [{
        product_id: this.saleForm.product_id,
        quantity: Number(this.saleForm.quantity || 1),
        unit_price: Number(this.saleForm.unit_price || 0),
      }];
      const deliveryAddress = this.saleForm.fulfillment_mode === 'delivery'
        ? this.saleForm.delivery_address
        : null;

      this.orderSubmitting = true;
      this.orderError = null;

      try {
        if (this.modalConv) {
          await this.apiPost('/admin/api/orders/register-manual', {
            conversation_id: this.modalConv.id,
            draft_id: this.modalConv.draft_id || null,
            items,
            payment_method: this.saleForm.payment_method || null,
            fulfillment_mode: this.saleForm.fulfillment_mode,
            delivery_address: deliveryAddress,
            idempotency_key: this.saleForm.idempotency_key,
            source_tag: this.saleForm.source_tag || null,
          });
        } else {
          await this.apiPost('/admin/api/orders/register-walkin', {
            customer_name: this.saleForm.customer_name?.trim() || null,
            customer_phone: this.saleForm.customer_phone?.trim() || null,
            items,
            payment_method: this.saleForm.payment_method || null,
            fulfillment_mode: this.saleForm.fulfillment_mode,
            delivery_address: deliveryAddress,
            idempotency_key: this.saleForm.idempotency_key,
            source_tag: this.saleForm.source_tag || 'walkin_balcao',
          });
        }

        this.saleModalOpen = false;
        await this.loadRealData();
      } catch (err) {
        this.orderError = err instanceof Error ? err.message : String(err);
      } finally {
        this.orderSubmitting = false;
      }
    },

    openPartnerModal() {
      this.partnerError = null;
      this.partnerResult = null;
      this.partnerForm = { trade_name: '', responsible_name: '', whatsapp_phone: '', email: '', address: '', commission_percent: '', municipios: '', slug: '' };
      this.partnerModalOpen = true;
    },

    async submitNewPartner() {
      if (this.partnerSubmitting) return;
      if (!this.partnerForm.trade_name.trim()) { this.partnerError = 'Informe o nome do parceiro.'; return; }
      const municipios = this.partnerForm.municipios.split(',').map((s) => s.trim()).filter(Boolean);
      if (municipios.length === 0) { this.partnerError = 'Informe ao menos uma cidade de cobertura.'; return; }
      this.partnerSubmitting = true;
      this.partnerError = null;
      try {
        const result = await this.apiPost('/admin/api/partners', {
          trade_name: this.partnerForm.trade_name.trim(),
          responsible_name: this.partnerForm.responsible_name.trim() || null,
          whatsapp_phone: this.partnerForm.whatsapp_phone.trim() || null,
          email: this.partnerForm.email.trim() || null,
          address: this.partnerForm.address.trim() || null,
          commission_percent: this.partnerForm.commission_percent === '' ? null : Number(this.partnerForm.commission_percent),
          municipios,
          slug: this.partnerForm.slug.trim() || null,
        });
        this.partnerResult = result; // { slug, token, ... } — token (login) mostrado UMA vez
        await this.loadRealData();
      } catch (err) {
        this.partnerError = err instanceof Error ? err.message : String(err);
      } finally {
        this.partnerSubmitting = false;
      }
    },

    // ── Etapa 3: candidaturas de parceiro ──
    async loadApplications() {
      if (!this.apiToken) return;
      this.applicationsLoading = true;
      try {
        const payload = await this.apiGet('/admin/api/partner-applications?status=pending');
        this.applications = Array.isArray(payload) ? payload : (payload.rows || []);
      } catch (err) {
        this.applications = [];
      } finally {
        this.applicationsLoading = false;
      }
    },

    async openApplications() {
      this.approvingApp = null;
      this.approveResult = null;
      this.approveError = null;
      this.applicationsModalOpen = true;
      await this.loadApplications();
    },

    startApprove(app) {
      this.approvingApp = app;
      this.approveResult = null;
      this.approveError = null;
      this.approveForm = { municipios: app.municipios || '', commission_percent: '', slug: '' };
    },

    async confirmApprove() {
      if (this.approveSubmitting || !this.approvingApp) return;
      const municipios = (this.approveForm.municipios || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (municipios.length === 0) { this.approveError = 'Informe ao menos uma cidade de cobertura.'; return; }
      this.approveSubmitting = true;
      this.approveError = null;
      try {
        const result = await this.apiPost(`/admin/api/partner-applications/${this.approvingApp.id}/approve`, {
          municipios,
          commission_percent: this.approveForm.commission_percent === '' ? null : Number(this.approveForm.commission_percent),
          slug: this.approveForm.slug.trim() || null,
        });
        this.approveResult = result; // { slug, token, ... } — login mostrado UMA vez
        await this.loadApplications();
      } catch (err) {
        this.approveError = err instanceof Error ? err.message : String(err);
      } finally {
        this.approveSubmitting = false;
      }
    },

    async rejectApplication(app) {
      try {
        await this.apiPost(`/admin/api/partner-applications/${app.id}/reject`, {});
        await this.loadApplications();
      } catch (err) {
        // silencioso — recusar é best-effort
      }
    },

    async loadRealData() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      this.loadApplications(); // Etapa 3: badge de candidaturas (não bloqueia o resto)

      // Promise.allSettled: cada bloco é independente — um endpoint que falhe
      // não derruba os outros pro mock. Resumo = bot/tráfego (matriz-resumo,
      // analytics read-only) + cobrança (rede). Rede = operação dos parceiros.
      const [pedidos, produtos, rede, resumo] = await Promise.allSettled([
        this.apiGet('/admin/api/dashboard/pedidos?limit=50'),
        this.apiGet('/admin/api/dashboard/produtos?limit=100'),
        this.apiGet(`/admin/api/dashboard/rede?period=${encodeURIComponent(this.redePeriod)}`),
        this.apiGet('/admin/api/dashboard/matriz-resumo?period=7d'),
      ]);

      const val = (settled) => (settled.status === 'fulfilled' ? settled.value : null);
      const settledList = [pedidos, produtos, rede, resumo];
      const ok = settledList.map(val).filter(Boolean);

      this.serverEnvironment = ok.map((r) => r.environment).find(Boolean) || this.serverEnvironment;
      this.chatwootBaseUrl = ok.map((r) => r.chatwoot_base_url).find(Boolean) || this.chatwootBaseUrl;
      this.chatwootAccountId = ok.map((r) => r.chatwoot_account_id).find(Boolean) || this.chatwootAccountId;
      const workerFlag = ok.map((r) => r.agent_v2_worker_enabled).find((v) => v !== undefined && v !== null);
      if (workerFlag !== undefined) this.agentV2WorkerEnabled = workerFlag;

      if (val(pedidos)) this.applyPedidos(pedidos.value.rows);
      if (val(produtos)) this.applyProdutos(produtos.value.rows);
      if (val(rede)) this.applyRede(rede.value.rows);
      if (val(resumo)) this.applyMatrizResumo(resumo.value);

      // "real" se qualquer bloco respondeu; só cai pro mock se TUDO falhou.
      if (ok.length > 0) {
        this.apiStatus = 'real';
        this.apiError = null;
      } else {
        this.apiStatus = 'mock';
        const firstErr = settledList.find((s) => s.status === 'rejected');
        this.apiError = firstErr && firstErr.reason
          ? (firstErr.reason instanceof Error ? firstErr.reason.message : String(firstErr.reason))
          : 'todos os endpoints falharam';
        console.warn('Painel usando dados mockados:', this.apiError);
      }
    },

    async loadRedeData() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;

      try {
        const rede = await this.apiGet(`/admin/api/dashboard/rede?period=${encodeURIComponent(this.redePeriod)}`);
        this.serverEnvironment = rede.environment || this.serverEnvironment;
        this.chatwootBaseUrl = rede.chatwoot_base_url || this.chatwootBaseUrl;
        this.chatwootAccountId = rede.chatwoot_account_id || this.chatwootAccountId;
        this.applyRede(rede.rows);
        this.apiStatus = 'real';
        this.apiError = null;
        this.$nextTick(() => {
          lucide.createIcons();
          this.renderRedeChart();
          this.renderRedeLucroChart();
          this.renderRedeComprasChart();
          this.renderEstoqueParadoChart();
          this.renderMargemChart();
          this.renderVendaHojeChart();
          this.renderPneusRedeChart();
          this.renderRedeOrigemChart();
          this.renderRedeSaudeChart();
        });
      } catch (err) {
        this.apiStatus = 'mock';
        this.apiError = err instanceof Error ? err.message : String(err);
      }
    },

    init() {
      void this.loadRealData();
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderChart();
        this.renderRedeChart();
        this.renderRedeLucroChart();
        this.renderRedeComprasChart();
        this.renderEstoqueParadoChart();
        this.renderMargemChart();
        this.renderVendaHojeChart();
        this.renderPneusRedeChart();
        this.renderRedeOrigemChart();
        this.renderRedeSaudeChart();
        this.renderParceiroChart();
      });

      this.$watch('currentPage', (page) => {
        this.$nextTick(() => {
          lucide.createIcons();
          this.renderCurrentPageCharts();
        });
        // Compras é tela própria: carrega fornecedor/compra/ranking ao entrar.
        if (page === 'compras') void this.loadAtacado();
      });

      this.startLiveRefresh();
    },

    renderCurrentPageCharts() {
      if (this.currentPage === 'resumo') this.renderChart();
      if (this.currentPage === 'rede') {
        this.renderRedeChart();
        this.renderRedeLucroChart();
        this.renderRedeComprasChart();
        this.renderEstoqueParadoChart();
        this.renderMargemChart();
        this.renderVendaHojeChart();
        this.renderPneusRedeChart();
        this.renderRedeOrigemChart();
        this.renderRedeSaudeChart();
        this.renderParceiroChart();
      }
      if (this.currentPage === 'unidade') this.renderParceiroChart();
    },

    // Atualização near real-time: a cada 15s rebusca os dados das telas vivas
    // (rede + resumo + pedidos) e re-renderiza, sem F5. Silencioso em erro
    // (mantém o último dado bom). Pausa quando a aba do navegador está oculta.
    startLiveRefresh() {
      if (this.liveRefreshId) return;
      this.liveRefreshId = setInterval(() => { void this.liveRefresh(); }, 15000);
    },

    async liveRefresh() {
      if (this.liveRefreshing || document.hidden) return;
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      if (!['resumo', 'rede', 'unidade', 'vendas'].includes(this.currentPage)) return;

      this.liveRefreshing = true;
      try {
        const [rede, resumo, pedidos] = await Promise.allSettled([
          this.apiGet(`/admin/api/dashboard/rede?period=${encodeURIComponent(this.redePeriod)}`),
          this.apiGet('/admin/api/dashboard/matriz-resumo?period=7d'),
          this.apiGet('/admin/api/dashboard/pedidos?limit=50'),
        ]);
        if (rede.status === 'fulfilled') this.applyRede(rede.value.rows);
        if (resumo.status === 'fulfilled') this.applyMatrizResumo(resumo.value);
        if (pedidos.status === 'fulfilled') this.applyPedidos(pedidos.value.rows);
        if ([rede, resumo, pedidos].some((r) => r.status === 'fulfilled')) {
          this.apiStatus = 'real';
          this.apiError = null;
          this.$nextTick(() => { lucide.createIcons(); this.renderCurrentPageCharts(); });
        }
      } catch (err) {
        /* silencioso: mantém o último dado bom na tela */
      } finally {
        this.liveRefreshing = false;
      }
    },

    // ─── GRÁFICO ────────────────────────────────────
    renderRedeChart() {
      const ctx = document.getElementById('chartRedeVendas');
      if (!ctx) return;
      if (window._redeChart) window._redeChart.destroy();

      window._redeChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: this.redeSeriesLabels(),
          datasets: [
            {
              label: 'Vendas reais da rede',
              data: this.redeSalesSeries(),
              yAxisID: 'y',
              borderColor: '#111827',
              backgroundColor: 'rgba(17,24,39,0.06)',
              tension: 0.35,
              fill: true,
              pointRadius: 4,
              pointBackgroundColor: '#ffffff',
              pointBorderColor: '#111827',
              pointBorderWidth: 2,
            },
            {
              label: 'Meta diária',
              data: this.redeSalesSeries().map(() => this.redeGoalDaily()),
              yAxisID: 'y',
              borderColor: '#9ca3af',
              borderDash: [6, 5],
              borderWidth: 2,
              pointRadius: 0,
              fill: false,
            },
            {
              label: 'Pedidos reais',
              data: this.redeOrderSeries(),
              yAxisID: 'y1',
              borderColor: '#f97316',
              backgroundColor: 'rgba(249,115,22,0.08)',
              tension: 0.35,
              fill: false,
              pointRadius: 3,
              pointBackgroundColor: '#ffffff',
              pointBorderColor: '#f97316',
              pointBorderWidth: 2,
            },
          ],
        },
        options: {
          ...this.chartOptions('R$ '),
          scales: {
            y: {
              beginAtZero: true,
              position: 'left',
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                callback: (value) => 'R$ ' + Number(value).toLocaleString('pt-BR'),
              },
              border: { display: false },
            },
            y1: {
              beginAtZero: true,
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: {
                precision: 0,
                color: '#f97316',
                font: { size: 11 },
              },
              border: { display: false },
            },
            x: {
              grid: { display: false },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderRedeLucroChart() {
      const ctx = document.getElementById('chartRedeLucro');
      if (!ctx) return;
      if (window._redeLucroChart) window._redeLucroChart.destroy();

      const parceiros = [...this.parceirosRede]
        .sort((a, b) => Number(b.lucroEstimado || 0) - Number(a.lucroEstimado || 0));

      window._redeLucroChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((parceiro) => parceiro.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((parceiro) => Number(parceiro.lucroEstimado || 0)),
            backgroundColor: parceiros.map((parceiro) => Number(parceiro.lucroEstimado || 0) >= 0 ? '#10b981' : '#f43f5e'),
            borderRadius: 6,
            barThickness: 16,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: function(ctx) {
                  return Number(ctx.parsed.x || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                callback: function(value) { return 'R$ ' + Number(value).toLocaleString('pt-BR'); }
              },
              border: { display: false }
            },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 11 } },
              border: { display: false }
            }
          }
        },
      });
    },

    renderPneusRedeChart() {
      const ctx = document.getElementById('chartPneusRede');
      if (!ctx) return;
      if (window._pneusRedeChart) window._pneusRedeChart.destroy();

      const itens = this.pneusMaisVendidosRede();
      const maxValor = Math.max(...itens.map((i) => i.quantidade), 1);
      const totalVendidos = itens.reduce((sum, item) => sum + Number(item.quantidade || 0), 0);

      window._pneusRedeChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: itens.map((i) => i.pneu),
          datasets: [{
            data: itens.map((i) => i.quantidade),
            backgroundColor: itens.map((i, idx) => idx === 0 ? '#059669' : '#a7f3d0'),
            borderRadius: 6,
            barThickness: 18,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => {
                  const pct = totalVendidos > 0 ? Math.round((ctx.parsed.x / totalVendidos) * 100) : 0;
                  return `${ctx.parsed.x} pneus vendidos (${pct}% do top)`;
                },
              },
            },
          },
          scales: {
            x: {
              max: maxValor,
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                stepSize: 1,
                precision: 0,
              },
              border: { display: false },
            },
            y: {
              grid: { display: false },
              ticks: {
                color: '#374151',
                font: { size: 12, weight: '500' },
              },
              border: { display: false },
            },
          },
        },
      });
    },

    renderRedeOrigemChart() {
      const ctx = document.getElementById('chartRedeOrigem');
      if (!ctx) return;
      if (window._redeOrigemChart) window._redeOrigemChart.destroy();

      const total2w = this.redeTotal2w();
      const totalPorta = this.redeTotalPorta();

      window._redeOrigemChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['2W', 'Porta'],
          datasets: [{
            data: [total2w, totalPorta],
            backgroundColor: ['#7c3aed', '#10b981'],
            borderWidth: 0,
            hoverOffset: 4,
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: {
            legend: {
              position: 'bottom',
              labels: { boxWidth: 10, usePointStyle: true, color: '#6b7280', font: { size: 11 } },
            },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => `${ctx.label}: ${Number(ctx.parsed || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
              },
            },
          },
        },
      });
    },

    renderRedeSaudeChart() {
      const ctx = document.getElementById('chartRedeSaude');
      if (!ctx) return;
      if (window._redeSaudeChart) window._redeSaudeChart.destroy();

      const parceiros = this.rankingSaude();

      window._redeSaudeChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => this.saudeScore(p)),
            backgroundColor: parceiros.map((p) => {
              const score = this.saudeScore(p);
              if (score >= 80) return '#10b981';
              if (score >= 60) return '#f59e0b';
              return '#f43f5e';
            }),
            borderRadius: 6,
            barThickness: 16,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: { label: (ctx) => `${ctx.parsed.x} pontos` },
            },
          },
          scales: {
            x: {
              min: 0,
              max: 100,
              grid: { color: '#f3f4f6' },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false },
            },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 11 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderRedeComprasChart() {
      const ctx = document.getElementById('chartRedeCompras');
      if (!ctx) return;
      if (window._redeComprasChart) window._redeComprasChart.destroy();

      const parceiros = [...this.parceirosRede]
        .sort((a, b) => Number(b.comprasPneus || 0) - Number(a.comprasPneus || 0));

      window._redeComprasChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => Number(p.comprasPneus || 0)),
            backgroundColor: parceiros.map((p, i) => i === 0 ? '#f97316' : '#fed7aa'),
            borderRadius: 6,
            barThickness: 16,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => Number(ctx.parsed.x || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
              },
            },
          },
          scales: {
            x: {
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                callback: (value) => 'R$ ' + Number(value).toLocaleString('pt-BR'),
              },
              border: { display: false },
            },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 11 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderEstoqueParadoChart() {
      const ctx = document.getElementById('chartEstoqueParado');
      if (!ctx) return;
      if (window._estoqueParadoChart) window._estoqueParadoChart.destroy();

      const parceiros = [...this.parceirosRede]
        .sort((a, b) => (b.estoqueItens || []).length - (a.estoqueItens || []).length);
      const maxCount = (parceiros[0]?.estoqueItens || []).length;

      window._estoqueParadoChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => (p.estoqueItens || []).length),
            backgroundColor: parceiros.map((p, i) => i === 0 ? '#f97316' : '#e5e7eb'),
            borderRadius: 4,
            barThickness: 8,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 8,
              callbacks: {
                label: (ctx) => `${ctx.parsed.x} itens cadastrados`,
              },
            },
          },
          scales: {
            x: { display: false, max: Math.max(maxCount, 1) },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 10 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderMargemChart() {
      const ctx = document.getElementById('chartMargem');
      if (!ctx) return;
      if (window._margemChart) window._margemChart.destroy();

      const parceiros = [...this.parceirosRede]
        .filter((p) => p.margem && p.margem !== '-')
        .map((p) => ({ nome: p.nome, valor: Number(String(p.margem).replace('%', '')) || 0 }))
        .sort((a, b) => b.valor - a.valor);

      window._margemChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((p) => p.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((p) => p.valor),
            backgroundColor: parceiros.map((p, i) => i === 0 ? '#10b981' : '#e5e7eb'),
            borderRadius: 4,
            barThickness: 8,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 8,
              callbacks: {
                label: (ctx) => `${ctx.parsed.x}% de margem`,
              },
            },
          },
          scales: {
            x: { display: false, suggestedMax: 50 },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 10 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderVendaHojeChart() {
      const ctx = document.getElementById('chartVendaHoje');
      if (!ctx) return;
      if (window._vendaHojeChart) window._vendaHojeChart.destroy();

      const total = this.parceirosRede.length;
      const semVenda = this.unidadesSemVendaHoje().length;
      const comVenda = total - semVenda;

      window._vendaHojeChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Venderam hoje', 'Sem venda hoje'],
          datasets: [{
            data: [comVenda, semVenda],
            backgroundColor: ['#10b981', '#f43f5e'],
            borderWidth: 0,
            hoverOffset: 4,
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 8,
              callbacks: {
                label: (ctx) => `${ctx.label}: ${ctx.parsed} unidades`,
              },
            },
          },
        },
      });
    },

    renderParceiroChart() {
      const ctx = document.getElementById('chartParceiroVendas');
      const parceiro = this.selectedParceiro();
      if (!ctx || !parceiro) return;
      if (window._parceiroChart) window._parceiroChart.destroy();

      window._parceiroChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Hoje'],
          datasets: [{
            label: parceiro.nome,
            data: parceiro.serieVendas,
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,0.07)',
            tension: 0.35,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#2563eb',
            pointBorderWidth: 2,
          }],
        },
        options: this.chartOptions('R$ '),
      });
    },

    chartOptions(prefix = '') {
      return {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111827',
            padding: 10,
            titleFont: { size: 11 },
            bodyFont: { size: 12, weight: '600' },
            callbacks: {
              label: function(ctx) { return prefix + Number(ctx.parsed.y || 0).toLocaleString('pt-BR'); }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#9ca3af', font: { size: 11 } },
            border: { display: false }
          },
          y: {
            grid: { color: '#f3f4f6' },
            ticks: { color: '#9ca3af', font: { size: 11 } },
            border: { display: false }
          }
        }
      };
    },

    renderChart() {
      const ctx = document.getElementById('chartPerformance');
      if (!ctx) return;
      if (window._perfChart) window._perfChart.destroy();

      const fmtDia = (d) => {
        const dt = new Date(d);
        return Number.isFinite(dt.getTime()) ? dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : String(d);
      };
      window._perfChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: this.resumoSeries.map((s) => fmtDia(s.dia)),
          datasets: [{
            data: this.resumoSeries.map((s) => s.faturamento),
            borderColor: '#111827',
            backgroundColor: 'rgba(17,24,39,0.05)',
            tension: 0.35,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#111827',
            pointBorderWidth: 2,
            pointHoverRadius: 6
          }]
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              titleFont: { size: 11 },
              bodyFont: { size: 12, weight: '600' },
              callbacks: {
                label: (item) => this.formatCurrency(item.parsed.y)
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false }
            },
            y: {
              grid: { color: '#f3f4f6' },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false }
            }
          }
        }
      });
    }
  }
}
