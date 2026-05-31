/**
 * Portal Parceiro â€” Farejador
 * Stack alinhada ao painel admin: Tailwind + Alpine + Lucide + Chart.js (CDN).
 *
 * O backend (src/parceiro/*) NÃƒO foi tocado nesta reescrita.
 * Toda lÃ³gica imperativa anterior (832 linhas de DOM manipulation) virou
 * estado reativo Alpine.
 *
 * Assinatura: Claude (Opus 4.7), 2026-05-19.
 */

function parceiroApp() {
  const slug = location.pathname.split('/').filter(Boolean)[1] || '';
  const tokenKey = `farejador_partner_token_${slug}`;

  return {
    // â”€â”€â”€ ESTADO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    slug,
    tokenKey,
    apiToken: localStorage.getItem(tokenKey) || '',
    tokenInput: localStorage.getItem(tokenKey) || '',
    authed: false,
    loading: false,
    saving: false,
    nowTick: Date.now(),
    nowTimer: null,
    savingAction: '',
    loginError: '',
    statusMessage: '',
    statusKind: 'neutral',  // 'success' | 'error' | 'neutral' — define cor do toast
    statusTimer: null,
    lastUpdatedAt: null,
    currentSection: 'resumo',
    theme: localStorage.getItem(`farejador_theme_${slug}`) || 'dark',  // 'dark' (padrão) | 'light' — tema do portal, salvo neste aparelho
    currentTab: 'sale',
    financePurchaseMode: 'tires',
    stockSearch: '',
    stockOriginFilter: 'all',
    stockStatusFilter: 'all',
    stockBrandFilter: 'all',
    stockPositionFilter: 'all',
    stockPage: 1,
    stockPageSize: 10,
    stockSelected: null,
    stockModalOpen: false,
    // Mini-modais de movimentação de saldo (botões distintos do card de detalhe).
    stockOpItem: null,        // item alvo da entrada/ajuste
    stockEntryOpen: false,    // "Dar entrada": soma unidades ao saldo
    stockEntryQty: null,
    stockAdjustOpen: false,   // "Ajustar saldo": define saldo absoluto
    stockAdjustQty: null,
    posSearch: '',
    posBrandFilter: 'all',
    posRimFilter: 'all',
    posSort: 'relevance',
    posCart: [],
    // Wizard mobile do PDV: no celular a venda vira 2 etapas pra evitar rolagem infinita.
    // 'select' = produtos + carrinho; 'checkout' = resumo/pagamento/finalizar.
    // No desktop isMobile fica falso e os x-show mostram tudo junto (sem etapas).
    posMobileStep: 'select',
    // Mesma ideia na aba Pedidos (celular): 'list' = KPIs+lista; 'form' = novo pedido.
    orderMobileStep: 'list',
    isMobile: false,

    // â”€â”€â”€ BATE-PAPO (F7) â”€ Fatia 1.4: dados reais via API (fan-out Chatwoot->banco).
    //     Leitura + polling 5s. Responder pelo portal e Fatia 2 (ainda nao envia).
    chatFilter: 'all',
    chatActiveId: null,
    chatDraft: '',
    chatConversations: [],
    chatLoading: false,
    chatTimer: null,
    chatES: null,
    chatFastTimer: null,
    // Entrega: filtro (em aberto x entregues) e rascunho do entregador por pedido.
    deliveryShowDone: false,
    deliveryDrafts: {},
    // Como o cliente pagou na entrega (COD), por pedido. Default Pix; vira o
    // metodo da conta a receber ao finalizar, pra o caixa registrar a forma.
    deliveryPayDrafts: {},
    posDiscountAmount: 0,
    posFreightAmount: 0,
    posReceivedAmount: null,
    posNotes: '',
    posSaleIdempotencyKey: null,
    posCustomerQuery: '',
    posCustomerResults: [],
    posCustomerSearchTimer: null,
    posCustomerFormOpen: false,
    deliveryAddressMissing: false,
    posSelectedCustomerAddress: '',
    posKeydownHandler: null,

    resumo: null,
    vendas: [],
    estoque: [],
    compras: [],
    despesas: [],
    produtos: [],
    payables: [],
    receivables: [],
    fluxoCaixa: null,
    clientes: [],
    customerListSearch: '',

    saleForm: { customer_id: null, customer_name: '', customer_phone: '', source_tag: 'porta', partner_stock_id: '', quantity: 1, unit_price: 0, payment_method: 'Pix', payment_status: 'received', receivable_due_date: '', receivable_installments: 1, fulfillment_mode: 'pickup', delivery_address: '' },

    // Aba Pedidos (entrega/COD) — estado próprio, separado do checkout do balcão.
    orderFilter: 'open',
    orderForm: { customer_id: null, customer_name: '', customer_phone: '', delivery_address: '' },
    orderItemForm: { partner_stock_id: '', quantity: 1, unit_price: 0 },
    orderCart: [],
    orderAddressMissing: false,
    orderCustomerResults: [], // resultados da busca de cliente no form de pedido

    // Ordem da rota de entrega (aba Entrega). Salva neste aparelho, por unidade.
    routeOrder: [],
    stockForm: { stock_id: null, item_type: 'pneu', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', supplier_name: '', quantity_on_hand: null, minimum_quantity: null, average_cost: null, sale_price: null, tire_condition: 'Novo', shelf_location: '', tire_position: '', is_tracked: true },
    purchaseForm: { supplier_name: '', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', quantity: 1, unit_cost: 0, sale_price: null, payment_status: 'paid_now', payable_due_date: '' },
    expenseForm: { category: 'employee_payment', description: '', amount: 0 },
    payableForm: { counterparty_name: '', description: '', category: 'supplier', amount: 0, due_date: '', status: 'open', paid_at: '', payment_method: 'Pix', notes: null },
    receivableForm: { customer_id: null, customer_name: '', description: '', source_tag: 'porta', amount: 0, due_date: '', status: 'open', received_at: '', payment_method: 'Pix', notes: null },
    receivableCustomerQuery: '',
    receivableCustomerResults: [],
    receivableCustomerSearchTimer: null,
    customerForm: { name: '', phone: '', address_street: '', address_number: '', address_neighborhood: '', address_city: '' },
    editingCustomerId: null,

    // VIP é automático: cliente vira VIP ao atingir este número de compras.
    vipMinPurchases: 3,
    editingPayableId: null,
    editingReceivableId: null,

    menu: [
      { id: 'resumo',     label: 'Resumo',        icon: 'layout-dashboard' },
      { id: 'vendas',     label: 'Frente de caixa', icon: 'shopping-cart' },
      { id: 'clientes',   label: 'Clientes',      icon: 'user' },
      { id: 'estoque',    label: 'Estoque',        icon: 'package' },
      { id: 'financeiro', label: 'Financeiro',     icon: 'wallet' },
    ],

    tabs: [
      { id: 'sale',     label: 'Venda' },
      { id: 'stock',    label: 'Estoque' },
      { id: 'purchase', label: 'Compra' },
      { id: 'expense',  label: 'Despesa' },
    ],

    // â”€â”€â”€ INIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    toggleTheme() {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      try { localStorage.setItem(`farejador_theme_${this.slug}`, this.theme); }
      catch (e) { /* localStorage indisponível: tema só nesta sessão */ }
      this.$nextTick(() => {
        lucide.createIcons();      // garante o ícone (sol/lua) renderizado após a troca
        this.renderAllCharts();    // canvas não reage a CSS: repinta os gráficos com a cor do tema novo
      });
    },

    init() {
      this.$nextTick(() => lucide.createIcons());
      if (this.apiToken) {
        this.authed = true;
        this.$nextTick(() => this.loadData());
      }

      // Ordem da rota de entrega — salva neste aparelho (por unidade).
      try { this.routeOrder = JSON.parse(localStorage.getItem(`farejador_route_order_${this.slug}`) || '[]'); }
      catch (e) { this.routeOrder = []; }

      // Relogio do footer: re-renderiza a cada 30s.
      this.nowTimer = setInterval(() => { this.nowTick = Date.now(); }, 30000);

      // isMobile reativo: o Alpine decide as etapas do PDV; o CSS sozinho nao sabe (e o Alpine que controla o x-show).
      const mqMobile = window.matchMedia('(max-width: 768px)');
      this.isMobile = mqMobile.matches;
      mqMobile.addEventListener('change', (event) => {
        this.isMobile = event.matches;
        if (!event.matches) { this.posMobileStep = 'select'; this.orderMobileStep = 'list'; } // ao voltar pro desktop, zera as etapas
      });

      this.posKeydownHandler = (event) => {
        if (!this.authed || this.currentSection !== 'vendas') return;
        if (event.key === 'F2') {
          event.preventDefault();
          if (!this.saving) void this.posFinalizeSale();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.posClearCart();
          this.flash('Venda cancelada.');
        }
      };
      window.addEventListener('keydown', this.posKeydownHandler);

      // re-render charts on resize (debounced)
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (this.authed) this.renderAllCharts(); }, 160);
      });
    },

    get nowClockLabel() {
      // referencia nowTick pra forcar reatividade do Alpine
      this.nowTick;
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date());
    },

    get nowDateLabel() {
      this.nowTick;
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      }).format(new Date());
    },

    // â”€â”€â”€ AUTH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async login() {
      const token = this.tokenInput.trim();
      if (!token) { this.loginError = 'Informe o token do parceiro.'; return; }
      this.apiToken = token;
      localStorage.setItem(this.tokenKey, token);
      this.loading = true;
      this.loginError = '';
      try {
        await this.loadData();
        this.authed = true;
      } catch (err) {
        this.loginError = this.errMessage(err);
        this.apiToken = '';
        localStorage.removeItem(this.tokenKey);
        this.authed = false;
      } finally {
        this.loading = false;
      }
    },

    logout() {
      this.apiToken = '';
      this.tokenInput = '';
      localStorage.removeItem(this.tokenKey);
      this.authed = false;
      this.resumo = null;
      this.vendas = [];
      this.estoque = [];
      this.compras = [];
      this.despesas = [];
      this.produtos = [];
      this.payables = [];
      this.receivables = [];
    },

    // â”€â”€â”€ API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    apiHeaders(hasBody = true) {
      const h = { Authorization: `Bearer ${this.apiToken}` };
      if (hasBody) h['Content-Type'] = 'application/json';
      return h;
    },

    async api(path, options = {}) {
      const hasBody = options.body !== undefined;
      const response = await fetch(`/parceiro/${this.slug}/api/${path}`, {
        ...options,
        headers: { ...this.apiHeaders(hasBody), ...(options.headers || {}) },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const err = new Error(payload.error || `api_${response.status}`);
        err.status = response.status;
        err.payload = payload;
        throw err;
      }
      return response.json();
    },

    async loadData() {
      if (!this.apiToken) return;
      this.loading = true;
      try {
        const [resumo, vendas, estoque, compras, despesas, produtos, payables, receivables, fluxo] = await Promise.all([
          this.api('resumo'),
          this.api('vendas'),
          this.api('estoque'),
          this.api('compras'),
          this.api('despesas'),
          this.api('produtos'),
          this.api('contas-a-pagar'),
          this.api('contas-a-receber'),
          this.api('fluxo-caixa'),
        ]);
        this.resumo = (resumo.rows && resumo.rows[0]) || null;
        this.vendas = vendas.rows || [];
        this.estoque = estoque.rows || [];
        this.compras = compras.rows || [];
        this.despesas = despesas.rows || [];
        this.produtos = produtos.rows || [];
        this.payables = payables.rows || [];
        this.receivables = receivables.rows || [];
        this.fluxoCaixa = (fluxo.rows && fluxo.rows[0]) || null;
        try {
          const clientes = await this.api('clientes');
          this.clientes = clientes.rows || [];
        } catch (err) {
          console.warn('clientes_unavailable', err);
          this.clientes = [];
        }
        this.lastUpdatedAt = new Date();
        this.$nextTick(() => {
          lucide.createIcons();
          this.renderAllCharts();
        });
      } finally {
        this.loading = false;
      }
    },

    // â”€â”€â”€ DERIVADAS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    get avgTicket() {
      const orders = this.num(this.resumo?.orders_month);
      const sales = this.num(this.resumo?.sales_month);
      return orders > 0 ? sales / orders : 0;
    },

    get filteredCustomers() {
      const query = String(this.customerListSearch || '').trim().toLowerCase();
      const digits = query.replace(/\D/g, '');
      const list = Array.isArray(this.clientes) ? this.clientes : [];
      if (!query) return list;
      return list.filter((customer) => {
        const name = String(customer?.name || '').toLowerCase();
        const phone = String(customer?.phone || '').replace(/\D/g, '');
        const address = this.customerAddressLine(customer).toLowerCase();
        return name.includes(query)
          || (!!digits && phone.includes(digits))
          || address.includes(query);
      });
    },

    get customersWithPhoneCount() {
      return (this.clientes || []).filter((customer) => String(customer?.phone || '').trim()).length;
    },

    get customersWithAddressCount() {
      return (this.clientes || []).filter((customer) => this.customerAddressLine(customer) !== '-').length;
    },

    get identifiedSalesCount() {
      return (this.vendas || []).filter((sale) => sale.customer_id || sale.customer_name || sale.customer_phone || sale.customer_cpf).length;
    },

    // Total de custos do mes (regime de competencia).
    // Conforme docs/GUIA_INDICADORES_FINANCEIRO_PARCEIRO_2026-05-24.md:
    //   Total de custos = Compras do mes + Despesas do mes
    // NAO inclui payables em aberto sem janela mensal — esses ja entram em
    // expenses_month quando o evento de competencia ocorre.
    get totalCusts() {
      return this.num(this.resumo?.purchases_month) + this.num(this.resumo?.expenses_month);
    },

    get estimatedMargin() {
      const sales = this.num(this.resumo?.sales_month);
      if (sales <= 0) return 0;
      return (this.num(this.resumo?.estimated_result_month) / sales) * 100;
    },

    get stockValue() {
      return this.estoque.reduce((sum, item) => {
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        const value = this.num(item.sale_price || item.average_cost);
        return sum + (qty * value);
      }, 0);
    },

    get stockCostValue() {
      return this.estoque.reduce((sum, item) => {
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        return sum + (qty * this.num(item.average_cost));
      }, 0);
    },

    get stockTotalUnits() {
      return this.estoque.reduce((sum, item) => {
        return sum + (item.is_tracked ? this.num(item.quantity_on_hand) : 0);
      }, 0);
    },

    get stockLowItems() {
      return this.estoque.filter((item) => ['low_stock', 'out_of_stock'].includes(item.stock_status));
    },

    get stockOriginSplit() {
      const split = [
        { label: '2W', key: '2w', count: 0, value: 0, color: '#047857' },
        { label: 'Porta', key: 'porta', count: 0, value: 0, color: '#94a3b8' },
      ];
      for (const item of this.estoque) {
        const origin = this.stockOriginKey(item);
        const bucket = split.find((entry) => entry.key === origin) || split[1];
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        bucket.count += qty;
        bucket.value += qty * this.num(item.average_cost || item.sale_price);
      }
      const total = split.reduce((sum, item) => sum + item.count, 0) || 1;
      return split.map((item) => ({ ...item, percent: Math.round((item.count / total) * 100) }));
    },

    get filteredStock() {
      const search = this.stockSearch.trim().toLowerCase();
      return this.estoque.filter((item) => {
        const origin = this.stockOriginKey(item);
        const haystack = [item.item_name, item.tire_size, item.brand, item.supplier_name]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (search && !haystack.includes(search)) return false;
        if (this.stockOriginFilter !== 'all' && origin !== this.stockOriginFilter) return false;
        if (this.stockStatusFilter !== 'all' && item.stock_status !== this.stockStatusFilter) return false;
        return true;
      });
    },

    get stockMovementSeries() {
      const weeks = [];
      const now = new Date();
      for (let i = 3; i >= 0; i -= 1) {
        const end = new Date(now);
        end.setDate(now.getDate() - (i * 7));
        const start = new Date(end);
        start.setDate(end.getDate() - 6);
        weeks.push({
          start,
          end,
          label: `${start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} - ${end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}`,
          entradas: 0,
          saidas: 0,
        });
      }
      const addToWeek = (dateValue, key, amount) => {
        if (!dateValue) return;
        const date = new Date(dateValue);
        if (Number.isNaN(date.getTime())) return;
        const week = weeks.find((item) => date >= item.start && date <= item.end);
        if (week) week[key] += amount;
      };
      for (const purchase of this.compras) {
        if (purchase.status === 'cancelled') continue;
        const items = Array.isArray(purchase.items) ? purchase.items : [];
        const qty = items.reduce((sum, item) => sum + this.num(item.quantity), 0);
        addToWeek(purchase.purchased_at || purchase.created_at, 'entradas', qty);
      }
      if (!this.compras.length) {
        for (const item of this.estoque) {
          const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
          addToWeek(item.created_at, 'entradas', qty);
        }
      }
      for (const sale of this.activeSales) {
        // 0076: só saída física (pickup + delivery entregue); reserva não é saída.
        if (!this.isPhysicalExitSale(sale)) continue;
        const items = Array.isArray(sale.items) ? sale.items : [];
        const qty = items.reduce((sum, item) => sum + this.num(item.quantity), 0) || 1;
        addToWeek(sale.created_at, 'saidas', qty);
      }
      return weeks;
    },

    get purchasedUnitsMonth() {
      return this.compras.reduce((sum, purchase) => {
        if (purchase.status === 'cancelled') return sum;
        // Só compras do mês corrente (antes somava todas de sempre).
        if (!this.isCurrentMonth(purchase.purchased_at || purchase.created_at)) return sum;
        const items = Array.isArray(purchase.items) ? purchase.items : [];
        return sum + items.reduce((itemSum, item) => itemSum + this.num(item.quantity), 0);
      }, 0);
    },

    get stockCreatedUnitsMonth() {
      const now = new Date();
      const month = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
      }).format(now);
      return this.estoque.reduce((sum, item) => {
        if (!item.is_tracked || !item.created_at) return sum;
        const createdMonth = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Sao_Paulo',
          year: 'numeric',
          month: '2-digit',
        }).format(new Date(item.created_at));
        if (createdMonth !== month) return sum;
        return sum + this.num(item.quantity_on_hand);
      }, 0);
    },

    get inventoryEntriesMonth() {
      // Enquanto nao existe ledger de movimentacao, evita contar duas vezes
      // compra que tambem criou item novo no estoque.
      return Math.max(this.purchasedUnitsMonth, this.stockCreatedUnitsMonth);
    },

    // 0076: saída FÍSICA realizada = pickup/balcão (baixa na hora) ou delivery
    // que chegou em 'delivered'. Delivery pending/dispatched só RESERVOU — o pneu
    // ainda não saiu; failed/cancelled também não são saída. Não conta como saída do mês.
    isPhysicalExitSale(sale) {
      if (!sale || sale.status === 'cancelled') return false;
      if (sale.fulfillment_mode === 'delivery') return sale.delivery_status === 'delivered';
      return true;
    },

    get soldUnitsMonth() {
      // Só saídas físicas (pickup + delivery entregue) do mês corrente.
      return this.salesUnitsFor(
        this.activeSales.filter((s) => this.isPhysicalExitSale(s) && this.isCurrentMonth(s.created_at)),
      );
    },

    // ── Indicadores extras da tela de estoque (refit mockup) ──────────────
    get stockCategoriesCount() {
      // "Categorias" = marcas distintas com itens rastreados no estoque.
      const brands = new Set();
      for (const item of this.estoque) {
        if (item.brand) brands.add(String(item.brand).trim().toLowerCase());
      }
      return brands.size;
    },

    get stockTopSizes() {
      // Top medidas por quantidade em estoque (pra barra "Medidas com maior estoque").
      const bySize = new Map();
      for (const item of this.estoque) {
        const size = item.tire_size;
        if (!size) continue;
        const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
        bySize.set(size, (bySize.get(size) || 0) + qty);
      }
      const rows = [...bySize.entries()]
        .map(([label, qty]) => ({ label, qty }))
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 5);
      const max = rows.reduce((m, r) => Math.max(m, r.qty), 0) || 1;
      return rows.map((r) => ({ ...r, pct: Math.round((r.qty / max) * 100) }));
    },

    get stockTurnover() {
      // Giro aproximado: saídas do mês / estoque médio atual. Sem ledger, usa
      // o saldo atual como proxy do estoque médio.
      const base = this.stockTotalUnits || 0;
      if (!base) return 0;
      return this.soldUnitsMonth / base;
    },

    get stockBrandOptions() {
      const set = new Set();
      for (const i of this.estoque) { if (i.brand) set.add(String(i.brand).trim()); }
      return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    },

    get stockFilteredRows() {
      // Aplica os filtros de chip (marca/posição) por cima do filteredStock,
      // que já cuida de busca + status + origem.
      return this.filteredStock.filter((item) => {
        if (this.stockBrandFilter !== 'all' && String(item.brand || '').trim() !== this.stockBrandFilter) return false;
        if (this.stockPositionFilter !== 'all' && this.stockPositionLabel(item) !== this.stockPositionFilter) return false;
        return true;
      });
    },

    get stockTotalPages() {
      return Math.max(1, Math.ceil(this.stockFilteredRows.length / this.stockPageSize));
    },

    get stockPagedRows() {
      const page = Math.min(this.stockPage, this.stockTotalPages);
      const start = (page - 1) * this.stockPageSize;
      return this.stockFilteredRows.slice(start, start + this.stockPageSize);
    },

    get stockDetail() {
      // Item mostrado no painel de detalhes: o selecionado, ou o 1º da lista.
      if (this.stockSelected) {
        const found = this.estoque.find((i) => i.id === this.stockSelected);
        if (found) return found;
      }
      return this.stockFilteredRows[0] || null;
    },

    get stockModelsCount() {
      const set = new Set();
      for (const i of this.estoque) { const n = String(i.item_name || '').trim().toLowerCase(); if (n) set.add(n); }
      return set.size;
    },

    get stockLowPercent() {
      const total = this.estoque.length || 1;
      return Math.round((this.stockLowItems.length / total) * 100);
    },

    get financeOriginSplit() {
      const partnerUnits = this.salesUnitsFor(this.partnerSales);
      const doorUnits = this.salesUnitsFor(this.doorSales);
      const totalUnits = partnerUnits + doorUnits;
      const safeTotal = totalUnits || 1;
      return [
        { label: '2W', value: this.partnerSalesTotal, count: partnerUnits, percent: Math.round((partnerUnits / safeTotal) * 100), color: '#047857' },
        { label: 'Porta', value: this.doorSalesTotal, count: doorUnits, percent: Math.round((doorUnits / safeTotal) * 100), color: '#9ca3af' },
      ];
    },

    // True se a data cai no mês corrente (fuso de São Paulo). Usado pelos KPIs "do mês".
    isCurrentMonth(dateValue) {
      if (!dateValue) return false;
      const d = new Date(dateValue);
      if (Number.isNaN(d.getTime())) return false;
      const fmt = (date) => new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
      }).format(date);
      return fmt(d) === fmt(new Date());
    },

    salesUnitsFor(sales) {
      return sales.reduce((sum, sale) => {
        const items = Array.isArray(sale.items) ? sale.items : [];
        const itemQty = items.reduce((itemSum, item) => itemSum + this.num(item.quantity), 0);
        return sum + (itemQty || 1);
      }, 0);
    },

    get financeUnitsSeries30d() {
      const days = [];
      const now = new Date();
      for (let i = 29; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push({
          key: this.dateKeySaoPaulo(d),
          label: d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short' }).replace('.', ''),
          value: 0,
        });
      }
      for (const sale of this.activeSales) {
        const key = this.dateKeySaoPaulo(sale.created_at);
        const day = days.find((d) => d.key === key);
        if (!day) continue;
        const items = Array.isArray(sale.items) ? sale.items : [];
        const qty = items.reduce((sum, item) => sum + this.num(item.quantity), 0);
        day.value += qty || 1;
      }
      return days;
    },

    get financeRevenueSeries30d() {
      const days = [];
      const now = new Date();
      for (let i = 29; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push({
          key: this.dateKeySaoPaulo(d),
          label: d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short' }).replace('.', ''),
          value: 0,
        });
      }
      for (const sale of this.activeSales) {
        const key = this.dateKeySaoPaulo(sale.created_at);
        const day = days.find((d) => d.key === key);
        if (day) day.value += this.num(sale.total_amount);
      }
      return days;
    },

    get payablesDetail() {
      return this.payables
        .filter((payable) => payable.status === 'open')
        .map((payable) => ({
          id: `payable-${payable.id}`,
          source_id: payable.id,
          raw: payable,
          type: 'Conta a pagar',
          title: payable.counterparty_name || payable.description,
          subtitle: this.payableCategoryLabel(payable.category),
          date: payable.due_date,
          amount: this.num(payable.amount),
        }))
        .filter((item) => item.amount > 0)
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    },

    get receivablesDetail() {
      return this.receivables
        .filter((receivable) => receivable.status === 'open')
        .map((receivable) => ({
          id: `receivable-${receivable.id}`,
          source_id: receivable.id,
          raw: receivable,
          type: this.sourceLabel(receivable.source_tag),
          title: receivable.customer_name || receivable.description,
          subtitle: receivable.description,
          date: receivable.due_date,
          amount: this.num(receivable.amount),
        }))
        .filter((item) => item.amount > 0)
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    },

    get payablesOpenTotal() {
      return this.payables
        .filter((payable) => payable.status === 'open')
        .reduce((sum, payable) => sum + this.num(payable.amount), 0);
    },

    // Despesas + contas do mes (regime de competencia).
    // Conforme docs/GUIA_INDICADORES_FINANCEIRO_PARCEIRO_2026-05-24.md: o
    // donut "Composicao dos custos" divide compras x despesas do MES, nao
    // payables em aberto cumulativos.
    get costExpensesCommitted() {
      return this.num(this.resumo?.expenses_month);
    },

    get receivablesOpenTotal() {
      return this.receivables
        .filter((receivable) => receivable.status === 'open')
        .reduce((sum, receivable) => sum + this.num(receivable.amount), 0);
    },

    get payablesPaidMonthTotal() {
      return this.payables
        .filter((payable) => payable.status === 'paid' && this.isCurrentMonth(payable.paid_at || payable.created_at))
        .reduce((sum, payable) => sum + this.num(payable.amount), 0);
    },

    get receivablesReceivedMonthTotal() {
      return this.receivables
        .filter((receivable) => receivable.status === 'received' && this.isCurrentMonth(receivable.received_at || receivable.created_at))
        .reduce((sum, receivable) => sum + this.num(receivable.amount), 0);
    },

    get salesTodayCount() {
      const today = this.dateKeySaoPaulo(new Date());
      return this.vendas.filter((sale) => this.dateKeySaoPaulo(sale.created_at) === today && sale.status !== 'cancelled').length;
    },

    get activeSales() {
      return this.vendas.filter((sale) => sale.status !== 'cancelled');
    },

    get partnerSales() {
      return this.activeSales.filter((sale) => this.normalizeSource(sale.source_tag || sale.source) === '2w');
    },

    get doorSales() {
      return this.activeSales.filter((sale) => this.normalizeSource(sale.source_tag || sale.source) === 'porta');
    },

    get partnerSalesTotal() {
      return this.partnerSales.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    get doorSalesTotal() {
      return this.doorSales.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    get partnerSalesShareLabel() {
      const total = this.activeSales.length;
      if (!total) return 'sem vendas ainda';
      return `${Math.round((this.partnerSales.length / total) * 100)}% das vendas`;
    },

    // ─── ENTREGA ──────────────────────────────────────────────
    // Toda venda marcada como entrega (deriva das vendas ja carregadas).
    get deliveriesAll() {
      return this.activeSales.filter((sale) => sale.fulfillment_mode === 'delivery');
    },

    // Em aberto = pendente + saiu; "entregues" quando o filtro pede.
    get deliveries() {
      return this.deliveriesAll.filter((d) => this.deliveryShowDone
        ? d.delivery_status === 'delivered'
        : d.delivery_status !== 'delivered');
    },

    get deliveryOpenCount() {
      return this.deliveriesAll.filter((d) => d.delivery_status !== 'delivered').length;
    },

    // Agrupa por bairro/regiao extraido do endereco ("rua, num - bairro - cidade").
    get deliveriesByZone() {
      const groups = {};
      for (const d of this.deliveries) {
        const label = this.deliveryZone(d);
        (groups[label] = groups[label] || []).push(d);
      }
      return Object.keys(groups)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'))
        .map((label) => ({ label, items: groups[label] }));
    },

    // Nomes de entregadores usados recentemente (sugestao no campo de texto livre).
    get recentCouriers() {
      const seen = [];
      for (const d of this.deliveriesAll) {
        const name = String(d.delivery_courier || '').trim();
        if (name && !seen.includes(name)) seen.push(name);
      }
      return seen.slice(0, 8);
    },

    deliveryZone(sale) {
      const addr = String(sale?.delivery_address || '').trim();
      if (!addr) return 'Sem endereço';
      const parts = addr.split(' - ').map((s) => s.trim()).filter(Boolean);
      return parts.length >= 2 ? parts[parts.length - 2] : 'Outras entregas';
    },

    // Lista da aba Entrega. Em aberto = ordem da rota (ajustável pelo entregador, salva no aparelho);
    // novos pedidos entram no fim. Finalizadas = mais recentes primeiro.
    get routeList() {
      const base = this.deliveries;
      if (this.deliveryShowDone) {
        return [...base].sort((a, b) => new Date(b.delivered_at || 0) - new Date(a.delivered_at || 0));
      }
      const order = this.routeOrder || [];
      const rank = (id) => { const i = order.indexOf(id); return i === -1 ? 1e9 : i; };
      return [...base].sort((a, b) => {
        const r = rank(a.order_id) - rank(b.order_id);
        if (r !== 0) return r;
        return new Date(a.created_at || 0) - new Date(b.created_at || 0);
      });
    },

    moveRoute(sale, dir) {
      const ids = this.routeList.map((d) => d.order_id);
      const i = ids.indexOf(sale.order_id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      this.routeOrder = ids;
      this.persistRouteOrder();
    },

    persistRouteOrder() {
      try { localStorage.setItem(`farejador_route_order_${this.slug}`, JSON.stringify(this.routeOrder)); }
      catch (e) { /* localStorage indisponível: ordem só nesta sessão */ }
    },

    deliveryStatusLabel(status) {
      if (status === 'dispatched') return 'Saiu pra entrega';
      if (status === 'delivered') return 'Finalizada';
      if (status === 'failed') return 'Não entregue';
      return 'Em separação';
    },

    deliveryItemsLabel(sale) {
      const items = Array.isArray(sale?.items) ? sale.items : [];
      if (!items.length) return 'Sem itens';
      return items
        .map((item) => `${this.num(item.quantity)}× ${item.tire_size || item.item_name || 'item'}`)
        .join(' · ');
    },

    // ─── Aba Pedidos (entrega/COD): lista, ficha e criação ───
    get deliveryOrders() {
      // Inclui cancelados — entrega falhada vira cancelada e precisa aparecer no filtro "Não entregues".
      return this.vendas.filter((o) => o.fulfillment_mode === 'delivery');
    },
    get ordersOpenList() {
      return this.deliveryOrders.filter((o) => o.status !== 'cancelled'
        && (o.delivery_status === 'pending' || o.delivery_status === 'dispatched'));
    },
    get filteredOrders() {
      if (this.orderFilter === 'open') return this.ordersOpenList;
      // Finalizados = entregue de verdade (cancelado nao conta como finalizado).
      if (this.orderFilter === 'delivered') return this.deliveryOrders.filter((o) => o.delivery_status === 'delivered' && o.status !== 'cancelled');
      // Nao entregues = falha de entrega OU pedido cancelado.
      if (this.orderFilter === 'failed') return this.deliveryOrders.filter((o) => o.delivery_status === 'failed' || o.status === 'cancelled');
      return this.deliveryOrders;
    },
    get ordersOpenCount() { return this.ordersOpenList.length; },
    get ordersOpenAmount() { return this.ordersOpenList.reduce((s, o) => s + this.num(o.total_amount), 0); },
    get ordersDeliveredCount() { return this.deliveryOrders.filter((o) => o.delivery_status === 'delivered' && o.status !== 'cancelled').length; },
    get ordersFailedCount() { return this.deliveryOrders.filter((o) => o.delivery_status === 'failed' || o.status === 'cancelled').length; },
    get orderCartTotal() { return this.orderCart.reduce((s, it) => s + this.num(it.unit_price) * this.num(it.quantity), 0); },

    onOrderItemChange() {
      const item = this.produtos.find((p) => p.stock_id === this.orderItemForm.partner_stock_id);
      if (item && item.sale_price !== null && item.sale_price !== undefined) {
        this.orderItemForm.unit_price = Number(item.sale_price);
      }
    },
    addOrderItem() {
      const id = this.orderItemForm.partner_stock_id;
      if (!id) { this.flash('Escolha um item do estoque.'); return; }
      const prod = this.produtos.find((p) => p.stock_id === id);
      if (!prod) { this.flash('Item não encontrado no estoque.'); return; }
      const qty = Math.max(1, this.num(this.orderItemForm.quantity) || 1);
      const available = this.stockAvailable(prod);
      const existing = this.orderCart.find((it) => it.partner_stock_id === id);
      if ((existing ? existing.quantity : 0) + qty > available) {
        this.flash('Quantidade maior que o estoque disponível.');
        return;
      }
      const price = this.num(this.orderItemForm.unit_price) || this.num(prod.sale_price) || 0;
      if (existing) { existing.quantity += qty; existing.unit_price = price; }
      else this.orderCart.push({ partner_stock_id: id, item_name: prod.item_name, tire_size: prod.tire_size, quantity: qty, unit_price: price });
      this.orderItemForm = { partner_stock_id: '', quantity: 1, unit_price: 0 };
    },
    removeOrderItem(idx) { this.orderCart.splice(idx, 1); },
    resetOrderForm() {
      this.orderForm = { customer_id: null, customer_name: '', customer_phone: '', delivery_address: '' };
      this.orderItemForm = { partner_stock_id: '', quantity: 1, unit_price: 0 };
      this.orderCart = [];
      this.orderAddressMissing = false;
      this.orderCustomerResults = [];
    },

    // Busca cliente cadastrado (nome ou telefone) enquanto digita no campo Cliente.
    // Mesmo endpoint do PDV. Digitar mexe no nome e zera o vinculo ate escolher.
    onOrderCustomerSearch() {
      this.orderForm.customer_id = null;
      clearTimeout(this.orderCustomerTimer);
      const q = String(this.orderForm.customer_name || '').trim();
      if (q.length < 2) { this.orderCustomerResults = []; return; }
      this.orderCustomerTimer = setTimeout(async () => {
        try {
          const result = await this.api(`clientes/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
          this.orderCustomerResults = result.rows || [];
        } catch {
          this.orderCustomerResults = [];
        }
      }, 250);
    },
    // Escolhe um cliente da busca: preenche nome, telefone (so digitos) e, se tiver
    // endereco cadastrado e o campo estiver vazio, ja sugere o endereco de entrega.
    selectOrderCustomer(customer) {
      if (!customer) return;
      this.orderForm.customer_id = customer.id;
      this.orderForm.customer_name = customer.name || '';
      let ph = String(customer.phone || '').replace(/\D/g, '');
      if ((ph.length === 12 || ph.length === 13) && ph.startsWith('55')) ph = ph.slice(2);
      this.orderForm.customer_phone = ph;
      const addr = this.customerAddressLine(customer);
      if (addr && addr !== '-' && !this.orderForm.delivery_address.trim()) {
        this.orderForm.delivery_address = addr;
        this.orderAddressMissing = false;
      }
      this.orderCustomerResults = [];
    },
    async submitOrder() {
      if (!this.orderCart.length) { this.flash('Adicione pelo menos um item ao pedido.'); return; }
      if (!this.orderForm.delivery_address.trim()) {
        this.orderAddressMissing = true;
        this.flash('Informe o endereço de entrega.');
        return;
      }
      this.saving = true; this.savingAction = 'order';
      try {
        const body = {
          customer_id: this.orderForm.customer_id || null,
          customer_name: this.orderForm.customer_name.trim() || null,
          customer_phone: this.toE164Phone(this.orderForm.customer_phone),
          items: this.orderCart.map((it) => ({
            partner_stock_id: it.partner_stock_id,
            quantity: this.num(it.quantity) || 1,
            unit_price: this.num(it.unit_price) || 0,
          })),
          payment_method: 'A receber',
          payment_status: 'receivable',
          receivable_due_date: null,
          fulfillment_mode: 'delivery',
          delivery_address: this.orderForm.delivery_address.trim(),
          source_tag: '2w',
          idempotency_key: 'order-' + (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(16).slice(2))),
        };
        await this.api('vendas', { method: 'POST', body: JSON.stringify(body) });
        this.resetOrderForm();
        this.orderFilter = 'open';
        this.orderMobileStep = 'list'; // no celular, volta pra lista pra ver o pedido criado
        await this.loadData();
        this.flash('Pedido gerado — estoque reservado. Entra no caixa quando o entregador finalizar.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    confirmDeliveryFailed(sale) {
      if (!sale || !sale.order_id) return;
      const who = sale.customer_name || 'este pedido';
      if (!confirm(`Marcar a entrega de ${who} como NÃO entregue?\n\nO estoque volta pro disponível e nada entra no caixa.`)) return;
      this.setDeliveryStatus(sale, 'failed');
    },

    async setDeliveryStatus(sale, status) {
      if (!sale || !sale.order_id) return;
      const courier = (this.deliveryDrafts[sale.order_id] ?? sale.delivery_courier ?? '').trim();
      const action = `delivery-${sale.order_id}`;
      // So manda forma de pagamento ao finalizar — ai a conta a receber entra
      // no caixa registrada como Pix/Dinheiro/Cartao em vez de "A receber".
      const payment_method = status === 'delivered'
        ? (this.deliveryPayDrafts[sale.order_id] || 'Pix')
        : null;
      this.saving = true; this.savingAction = action;
      try {
        await this.api(`entregas/${sale.order_id}`, {
          method: 'POST',
          body: JSON.stringify({ delivery_status: status, delivery_courier: courier || null, payment_method }),
        });
        await this.loadData();
        const flashes = {
          delivered: 'Entrega finalizada — venda registrada e dinheiro no caixa.',
          dispatched: 'Saiu pra entrega.',
          failed: 'Marcado como não entregue — estoque devolvido, nada no caixa.',
          pending: 'Entrega reaberta.',
        };
        this.flash(flashes[status] || 'Entrega atualizada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    get stockBreakdown() {
      return this.estoque.reduce((acc, item) => {
        const status = item.stock_status || (item.is_tracked ? 'unknown' : 'not_tracked');
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, { in_stock: 0, low_stock: 0, out_of_stock: 0, unknown: 0, not_tracked: 0 });
    },

    get healthChecks() {
      const stock = this.stockBreakdown;
      const recentStockUpdate = this.estoque.some((item) => {
        if (!item.updated_at) return false;
        return Date.now() - new Date(item.updated_at).getTime() < 7 * 24 * 60 * 60 * 1000;
      });
      return [
        { label: 'Venda registrada hoje',         ok: this.salesTodayCount > 0 },
        { label: 'Resultado mensal positivo',     ok: this.num(this.resumo?.estimated_result_month) > 0 },
        { label: 'Estoque cadastrado',            ok: this.num(this.resumo?.stock_items) > 0 },
        { label: 'Sem item zerado',               ok: stock.out_of_stock === 0 },
        { label: 'Estoque atualizado na semana',  ok: recentStockUpdate },
      ];
    },

    get healthScore() {
      const items = this.healthChecks;
      const ok = items.filter((i) => i.ok).length;
      return Math.round((ok / items.length) * 100);
    },

    get financialScore() {
      const sales = this.num(this.resumo?.sales_month);
      const result = this.num(this.resumo?.estimated_result_month);
      const margin = this.estimatedMargin;
      const breakEven = this.totalCusts;
      const cashNet = this.num(this.resumo?.cash_net_month);
      const futureNet = this.num(this.resumo?.net_future_position);
      const overdueIn = this.num(this.fluxoCaixa?.overdue_in);
      const overdueOut = this.num(this.fluxoCaixa?.overdue_out);
      const stockItems = this.num(this.resumo?.stock_items);
      const lowStockItems = this.num(this.resumo?.low_stock_items);
      let score = 500;

      if (result > 0) score += 120;
      if (result < 0) score -= 120;

      if (margin >= 25) score += 140;
      else if (margin >= 15) score += 100;
      else if (margin > 0) score += 50;
      else if (sales > 0) score -= 80;

      if (cashNet >= 0) score += 90;
      else score -= 120;

      if (futureNet >= 0) score += 80;
      else score -= 90;

      if (overdueOut <= 0) score += 80;
      else score -= 150;

      if (overdueIn <= 0) score += 40;
      else score -= 60;

      if (sales > 0) score += 70;
      else score -= 40;

      if (this.avgTicket > 0) score += 45;
      else score -= 20;

      if (sales > 0 && breakEven > 0 && sales >= breakEven) score += 70;
      if (sales > 0 && breakEven > 0 && sales < breakEven) score -= 70;

      if (stockItems > 0) score += 55;
      else score -= 50;

      if (lowStockItems <= 0) score += 30;
      else score -= Math.min(90, lowStockItems * 30);

      return Math.max(0, Math.min(1000, Math.round(score)));
    },

    get financialScoreAngle() {
      return 180 + ((this.financialScore / 1000) * 180);
    },

    get financialScoreLevel() {
      const score = this.financialScore;
      if (score >= 800) return { label: 'Ótimo', color: 'text-emerald-700', tone: 'bg-emerald-50 border-emerald-100' };
      if (score >= 650) return { label: 'Bom', color: 'text-lime-700', tone: 'bg-lime-50 border-lime-100' };
      if (score >= 500) return { label: 'Regular', color: 'text-amber-700', tone: 'bg-amber-50 border-amber-100' };
      return { label: 'Ruim', color: 'text-rose-700', tone: 'bg-rose-50 border-rose-100' };
    },

    // Cor do arco do gauge: verde (bom) -> amarelo (mais ou menos) -> vermelho (ruim).
    get financialScoreColor() {
      const score = this.financialScore;
      // No tema claro, as faixas vão pra tons mais escuros — verde/amarelo claros somem no fundo branco.
      const light = this.theme === 'light';
      if (score >= 800) return light ? '#059669' : '#10b981'; // verde forte
      if (score >= 650) return light ? '#4d7c0f' : '#84cc16'; // verde
      if (score >= 500) return light ? '#b45309' : '#facc15'; // amarelo/âmbar
      return light ? '#dc2626' : '#ef4444';                   // vermelho
    },

    get financialScoreChecks() {
      const sales = this.num(this.resumo?.sales_month);
      const result = this.num(this.resumo?.estimated_result_month);
      const breakEven = this.totalCusts;
      const overdueOut = this.num(this.fluxoCaixa?.overdue_out);
      const overdueIn = this.num(this.fluxoCaixa?.overdue_in);
      const futureNet = this.num(this.resumo?.net_future_position);
      const stockItems = this.num(this.resumo?.stock_items);
      const lowStockItems = this.num(this.resumo?.low_stock_items);

      return [
        {
          label: 'Resultado',
          ok: result >= 0,
          value: this.money(result),
          hint: result >= 0 ? 'Venda cobre compras e despesas.' : 'Revise preço, custo ou despesas.',
        },
        {
          label: 'Margem',
          ok: this.estimatedMargin >= 15 || sales <= 0,
          value: `${this.estimatedMargin.toFixed(1).replace('.', ',')}%`,
          hint: sales <= 0 ? 'Sem vendas no mês.' : (this.estimatedMargin >= 15 ? 'Margem saudável.' : 'Margem baixa para o mês.'),
        },
        {
          label: 'Equilíbrio',
          ok: sales >= breakEven || breakEven <= 0,
          value: this.money(breakEven),
          hint: breakEven <= 0 ? 'Sem custos lançados.' : (sales >= breakEven ? 'Passou do ponto de equilíbrio.' : `Faltam ${this.money(Math.max(0, breakEven - sales))} em vendas.`),
        },
        {
          label: 'Vencidos',
          ok: overdueOut <= 0 && overdueIn <= 0,
          value: `${this.money(overdueIn)} / ${this.money(overdueOut)}`,
          hint: overdueOut > 0 ? 'Tem conta vencida a pagar.' : (overdueIn > 0 ? 'Tem cliente vencido para cobrar.' : 'Sem vencidos.'),
        },
        {
          label: 'Futuro',
          ok: futureNet >= 0,
          value: this.money(futureNet),
          hint: futureNet >= 0 ? 'A receber cobre o que está em aberto.' : 'Há mais a pagar que a receber.',
        },
        {
          label: 'Estoque',
          ok: stockItems > 0 && lowStockItems <= 0,
          value: `${stockItems} itens`,
          hint: stockItems <= 0 ? 'Cadastre pneus para vender.' : (lowStockItems > 0 ? 'Tem item abaixo do mínimo.' : 'Estoque sem alerta.'),
        },
      ];
    },

    get financialScoreTips() {
      const tips = [];
      const sales = this.num(this.resumo?.sales_month);
      const breakEven = this.totalCusts;
      const overdueOut = this.num(this.fluxoCaixa?.overdue_out);
      const overdueIn = this.num(this.fluxoCaixa?.overdue_in);
      const futureNet = this.num(this.resumo?.net_future_position);
      const lowStockItems = this.num(this.resumo?.low_stock_items);

      if (overdueOut > 0) tips.push(`Pague ou renegocie ${this.money(overdueOut)} vencidos.`);
      if (overdueIn > 0) tips.push(`Cobre ${this.money(overdueIn)} de clientes vencidos.`);
      if (sales <= 0) tips.push('Registre as vendas do dia para o score sair do modo inicial.');
      if (breakEven > 0 && sales < breakEven) tips.push(`Venda mais ${this.money(breakEven - sales)} para bater o equilíbrio.`);
      if (this.estimatedMargin > 0 && this.estimatedMargin < 15) tips.push('Aumente preço ou reduza custo: margem abaixo de 15%.');
      if (futureNet < 0) tips.push('Evite nova compra a prazo até o futuro ficar positivo.');
      if (lowStockItems > 0) tips.push(`Reponha ${lowStockItems} item(ns) abaixo do mínimo.`);
      if (!tips.length) tips.push('Continue registrando vendas, compras e recebimentos no mesmo dia.');
      return tips.slice(0, 3);
    },

    get salesSeries7d() {
      const days = [];
      const now = new Date();
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push({
          key: this.dateKeySaoPaulo(d),
          label: d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }),
          value: 0,
        });
      }
      for (const sale of this.vendas) {
        if (sale.status === 'cancelled') continue;
        const key = this.dateKeySaoPaulo(sale.created_at);
        const day = days.find((d) => d.key === key);
        if (day) day.value += this.num(sale.total_amount);
      }
      return days;
    },

    get trendBadgeLabel() {
      const total = this.salesSeries7d.reduce((s, d) => s + d.value, 0);
      return total > 0 ? `${this.money(total)} em 7d` : 'sem dados';
    },

    get lastUpdatedLabel() {
      if (!this.lastUpdatedAt) return 'Aguardando atualização';
      return `Atualizado ${this.lastUpdatedAt.toLocaleString('pt-BR')}`;
    },

    // Compara em America/Sao_Paulo para alinhar com a view SQL
    // (network.partner_unit_summary usa date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')).
    // Sem isso, nas primeiras horas do dia 1 o navegador (em outro fuso)
    // pode considerar o registro como "mes anterior" e desalinhar dos cards.
    isCurrentMonth(value) {
      if (!value) return false;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return false;
      const fmt = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
      });
      return fmt.format(date) === fmt.format(new Date());
    },

    get saleTotalLabel() {
      return this.money(this.num(this.saleForm.quantity) * this.num(this.saleForm.unit_price));
    },

    get posProducts() {
      const search = this.posSearch.trim().toLowerCase();
      return this.produtos.filter((item) => {
        const haystack = [
          item.item_name,
          item.tire_size,
          item.brand,
          item.supplier_name,
        ].filter(Boolean).join(' ').toLowerCase();
        return !search || haystack.includes(search);
      });
    },

    get posBrandOptions() {
      return [...new Set(this.produtos.map((item) => item.brand).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
    },

    get posRimOptions() {
      return [...new Set(this.produtos.map((item) => {
        if (item.tire_rim_diameter) return String(item.tire_rim_diameter);
        return String(this.parseTireSize(item.tire_size).rim || '');
      }).filter(Boolean))]
        .sort((a, b) => Number(a) - Number(b));
    },

    posProductSalesCount(stockId) {
      if (!stockId) return 0;
      return this.activeSales.reduce((sum, sale) => {
        const items = Array.isArray(sale.items) ? sale.items : [];
        return sum + items.reduce((itemSum, item) => {
          if (item.partner_stock_id !== stockId) return itemSum;
          return itemSum + (this.num(item.quantity) || 1);
        }, 0);
      }, 0);
    },

    get posDisplayProducts() {
      const filtered = this.posProducts.filter((item) => {
        const brandOk = this.posBrandFilter === 'all' || item.brand === this.posBrandFilter;
        const rim = item.tire_rim_diameter || this.parseTireSize(item.tire_size).rim;
        const rimOk = this.posRimFilter === 'all' || String(rim || '') === String(this.posRimFilter);
        return brandOk && rimOk;
      });
      return [...filtered].sort((a, b) => {
        if (this.posSort === 'price_asc') return this.num(a.sale_price) - this.num(b.sale_price);
        if (this.posSort === 'price_desc') return this.num(b.sale_price) - this.num(a.sale_price);
        if (this.posSort === 'best_sellers') return this.posProductSalesCount(b.stock_id) - this.posProductSalesCount(a.stock_id);
        return 0;
      });
    },

    get posCartSubtotal() {
      return this.posCart.reduce((sum, item) => sum + (this.num(item.quantity) * this.num(item.unit_price)), 0);
    },

    get posCartTotal() {
      return Math.max(0, this.posCartSubtotal - this.num(this.posDiscountAmount) + this.num(this.posFreightAmount));
    },

    get posCartUnits() {
      return this.posCart.reduce((sum, item) => sum + this.num(item.quantity), 0);
    },

    get posChangeAmount() {
      if (this.saleForm.payment_status === 'receivable') return 0;
      return Math.max(0, this.num(this.posReceivedAmount) - this.posCartTotal);
    },

    get posCashTodayTotal() {
      // Caixa do dia = o que efetivamente entrou (exclui "A receber").
      return this.salesToday.reduce((sum, sale) => {
        if (sale.payment_method === 'A receber') return sum;
        return sum + this.num(sale.total_amount);
      }, 0);
    },

    get salesTodayTotal() {
      // Vendas hoje = faturado total do dia (inclui "A receber"); diferente do caixa.
      return this.salesToday.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    get salesToday() {
      const today = this.dateKeySaoPaulo(new Date());
      return this.activeSales.filter((sale) => this.dateKeySaoPaulo(sale.created_at) === today);
    },

    get posFirstSaleTodayLabel() {
      if (!this.salesToday.length) return 'sem venda hoje ainda';
      const first = [...this.salesToday].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0];
      return `aberto as ${new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(first.created_at))}`;
    },

    get posSalesTodayHourly() {
      const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${String(hour).padStart(2, '0')}h`, value: 0 }));
      for (const sale of this.salesToday) {
        const hour = Number(new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          hour12: false,
        }).format(new Date(sale.created_at)));
        if (Number.isFinite(hour) && buckets[hour]) buckets[hour].value += this.num(sale.total_amount);
      }
      return buckets;
    },

    get posLastSale() {
      return this.activeSales[0] || null;
    },

    get purchaseTotalLabel() {
      return this.money(this.num(this.purchaseForm.quantity) * this.num(this.purchaseForm.unit_cost));
    },

    get financeCostSplit() {
      return [
        { label: 'Compras', value: this.num(this.resumo?.purchases_month), color: '#7f8f83' },
        { label: 'Despesas/contas', value: this.costExpensesCommitted, color: '#dc3f4d' },
      ];
    },

    get currentSectionMeta() {
      const meta = {
        resumo: {
          title: 'Resumo',
          subtitle: 'Vis\u00e3o geral da opera\u00e7\u00e3o local',
        },
        vendas: {
          title: 'Frente de caixa',
          subtitle: 'Venda rápida, baixa de estoque e financeiro automático',
        },
        clientes: {
          title: 'Clientes',
          subtitle: 'Cadastro simples vinculado às vendas do parceiro',
        },
        estoque: {
          title: 'Estoque',
          subtitle: 'Cadastrar pneus e controlar saldo local',
        },
        financeiro: {
          title: 'Financeiro',
          subtitle: 'Compras, despesas e resultado simples',
        },
        batepapo: {
          title: 'Bate-papo',
          subtitle: 'Atendimento unificado WhatsApp, Instagram e Facebook',
        },
      };
      return meta[this.currentSection] || meta.resumo;
    },

    // â”€â”€â”€ BATE-PAPO (F7) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    get chatActive() {
      return this.chatConversations.find((c) => c.id === this.chatActiveId) || null;
    },
    get chatUnreadTotal() {
      return this.chatConversations.reduce((sum, c) => sum + (c.unread || 0), 0);
    },
    get chatFilteredConversations() {
      const f = this.chatFilter;
      return this.chatConversations.filter((c) => {
        if (f === 'all') return true;
        if (f === 'unread') return (c.unread || 0) > 0;
        return c.channel === f;
      });
    },

    // â”€â”€ Mapeamento banco -> formato que a tela consome â”€â”€
    chatChannelLabel(channel) {
      return { whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook' }[channel] || 'Outro';
    },
    chatInitials(name) {
      const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return '?';
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    },
    chatTimeLabel(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(d);
    },
    mapChatConversation(row, keepMessages) {
      const name = row.customer_name || row.customer_identifier || 'Cliente';
      return {
        id: row.id,
        name,
        initials: this.chatInitials(name),
        channel: row.channel || 'other',
        channelLabel: this.chatChannelLabel(row.channel),
        avatar: row.customer_avatar_url || null,
        phone: row.customer_identifier || '',
        time: this.chatTimeLabel(row.last_message_at || row.created_at),
        unread: Number(row.unread_count || 0),
        last: row.last_message || '',
        // Slots captados pelo bot (ainda nao estruturados): so localizacao/intent existem.
        measure: null, position: null, bike: null,
        city: row.customer_location || null,
        suggested: null,
        messages: keepMessages || [],
        _loaded: !!keepMessages,
      };
    },
    chatMapMessage(row) {
      return {
        id: row.id,
        from: row.direction === 'inbound' ? 'them' : 'me',
        text: row.content || '',
        time: this.chatTimeLabel(row.created_at),
      };
    },

    async loadChat() {
      if (!this.apiToken) return;
      try {
        const data = await this.api('chat/conversations');
        const prev = new Map(this.chatConversations.map((c) => [c.id, c]));
        this.chatConversations = (data.rows || []).map((row) => {
          const old = prev.get(row.id);
          const mapped = this.mapChatConversation(row, old ? old.messages : null);
          mapped._loaded = old ? old._loaded : false;
          // Conversa aberta = lida. Se chegou msg nova (servidor ainda conta),
          // avisa o servidor pra zerar de vez (senao o badge volta no proximo poll).
          if (row.id === this.chatActiveId) {
            if (mapped.unread > 0) void this.markChatRead(row.id);
            mapped.unread = 0;
          }
          return mapped;
        });
        // Mantem o fio aberto atualizado (mensagens novas aparecem no polling).
        if (this.chatActiveId && this.chatConversations.some((c) => c.id === this.chatActiveId)) {
          await this.loadChatMessages(this.chatActiveId);
        }
      } catch (err) {
        console.warn('chat_load_failed', err);
      }
    },

    async loadChatMessages(id) {
      try {
        const data = await this.api(`chat/conversations/${id}/messages`);
        const conv = this.chatConversations.find((c) => c.id === id);
        if (!conv) return;
        const wasAtEnd = this._chatNearBottom();
        conv.messages = (data.rows || []).map((row) => this.chatMapMessage(row));
        conv._loaded = true;
        if (wasAtEnd) this.$nextTick(() => this.scrollChatToEnd());
      } catch (err) {
        console.warn('chat_messages_failed', err);
      }
    },

    startChatPolling() {
      this.stopChatPolling();
      void this.loadChat();
      // Fatia 3: tempo real via SSE (push). Em cada evento recarrega a lista.
      this.startChatSse();
      // Rede de seguranca: poll lento sempre ligado, pega evento perdido (ex.:
      // SSE caiu e voltou entre dois eventos).
      this.chatTimer = setInterval(() => { void this.loadChat(); }, 30000);
    },
    startChatSse() {
      if (!window.EventSource || !this.token) { this.startChatFallbackPoll(); return; }
      try {
        const url = `/parceiro/${this.slug}/api/chat/stream?token=${encodeURIComponent(this.token)}`;
        const es = new EventSource(url);
        es.addEventListener('message', () => { void this.loadChat(); });
        es.onopen = () => { this.stopChatFallbackPoll(); }; // SSE de pe: nao precisa do poll rapido.
        es.onerror = () => {
          // EventSource reconecta sozinho em quedas transitorias (readyState
          // CONNECTING). So caimos no poll rapido se fechou de vez (ex.: token
          // invalido -> CLOSED).
          if (es.readyState === EventSource.CLOSED) { this.startChatFallbackPoll(); }
        };
        this.chatES = es;
      } catch (err) {
        console.warn('chat_sse_failed', err);
        this.startChatFallbackPoll();
      }
    },
    startChatFallbackPoll() {
      if (this.chatFastTimer) return;
      this.chatFastTimer = setInterval(() => { void this.loadChat(); }, 5000);
    },
    stopChatFallbackPoll() {
      if (this.chatFastTimer) { clearInterval(this.chatFastTimer); this.chatFastTimer = null; }
    },
    stopChatPolling() {
      if (this.chatTimer) { clearInterval(this.chatTimer); this.chatTimer = null; }
      this.stopChatFallbackPoll();
      if (this.chatES) { this.chatES.close(); this.chatES = null; }
    },

    selectChat(id) {
      this.chatActiveId = id;
      const c = this.chatConversations.find((x) => x.id === id);
      if (c) c.unread = 0;
      void this.markChatRead(id); // zera no servidor (senao o badge volta no poll)
      void this.loadChatMessages(id);
      this.$nextTick(() => { lucide.createIcons(); this.scrollChatToEnd(); });
    },
    async markChatRead(id) {
      try {
        await this.api(`chat/conversations/${id}/read`, { method: 'POST' });
      } catch (err) {
        console.warn('chat_mark_read_failed', err);
      }
    },
    async sendChat() {
      // Fatia 2: grava otimista na tela, manda pro backend (que grava no banco
      // e dispara o Chatwoot). O polling/eco traz a versao persistida depois.
      const text = (this.chatDraft || '').trim();
      const conv = this.chatActive;
      if (!text || !conv || this.chatSending) return;

      const clientToken = 'pc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const optimistic = {
        id: clientToken,
        from: 'me',
        text,
        time: this.chatTimeLabel(new Date().toISOString()),
        pending: true,
      };
      conv.messages = conv.messages || [];
      conv.messages.push(optimistic);
      this.chatDraft = '';
      this.chatSending = true;
      this.$nextTick(() => this.scrollChatToEnd());

      try {
        await this.api(`chat/conversations/${conv.id}/send`, {
          method: 'POST',
          body: JSON.stringify({ content: text, client_token: clientToken }),
        });
        optimistic.pending = false;
        // Recarrega o fio: a msg ja esta persistida no banco (substitui a otimista).
        await this.loadChatMessages(conv.id);
      } catch (err) {
        // Rollback: tira a bolha otimista e devolve o texto pro input.
        conv.messages = conv.messages.filter((m) => m.id !== clientToken);
        this.chatDraft = text;
        this.flash('Nao consegui enviar a mensagem. Tente de novo.');
        console.warn('chat_send_failed', err);
      } finally {
        this.chatSending = false;
      }
    },
    _chatNearBottom() {
      const box = document.getElementById('pos-chat-messages');
      if (!box) return true;
      return (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
    },
    scrollChatToEnd() {
      const box = document.getElementById('pos-chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    },

    // â”€â”€â”€ NAVEGAÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    goToSection(id) {
      if (id === 'pedidos') { this.resetOrderForm(); this.orderMobileStep = 'list'; }
      // Chat: liga o polling so quando a aba esta aberta; desliga ao sair (economiza requests).
      if (id === 'batepapo') this.startChatPolling();
      else this.stopChatPolling();
      this.currentSection = id;
      if (id === 'vendas') this.currentTab = 'sale';
      if (id === 'estoque') this.currentTab = 'stock';
      if (id === 'financeiro') this.currentTab = 'purchase';
      this.$nextTick(() => {
        const main = document.getElementById('partner-main');
        if (main) main.scrollTo({ top: 0, behavior: 'auto' });
        lucide.createIcons();
        requestAnimationFrame(() => this.renderAllCharts());
        if (id === 'batepapo') this.scrollChatToEnd();
      });
    },

    // â”€â”€â”€ FORMS: SALE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Auto-preenche o preÃ§o unitÃ¡rio com o sale_price do estoque local do parceiro.
    onSaleProductChange() {
      const item = this.produtos.find((p) => p.stock_id === this.saleForm.partner_stock_id);
      if (item && item.sale_price !== null && item.sale_price !== undefined) {
        this.saleForm.unit_price = Number(item.sale_price);
      }
    },

    // RÃ³tulo de cada item do dropdown da venda.
    formatPartnerStockOption(item) {
      const parts = [item.item_name];
      if (item.tire_size) parts.push(item.tire_size);
      if (item.brand) parts.push(item.brand);
      const qtyLabel = this.stockAvailabilityLabel(item);
      parts.push(qtyLabel);
      return parts.join(' - ');
    },

    posProductTitle(item) {
      return [item.tire_size, item.item_name].filter(Boolean).join(' - ') || 'Produto';
    },

    posProductSubtitle(item) {
      return [item.brand, item.supplier_name].filter(Boolean).join(' - ') || 'Sem marca';
    },

    posStockLabel(item) {
      if (!item.is_tracked) return 'sem controle';
      return this.stockAvailabilityLabel(item);
    },

    itemTypeLabel(type) {
      if (type === 'insumo') return 'Insumo';
      if (type === 'servico') return 'Serviço';
      return 'Pneu';
    },

    // Linha principal do card/lista: pneu mostra a medida; insumo/serviço mostram o nome.
    itemPrimaryLabel(item) {
      if ((item.item_type || 'pneu') === 'pneu') return item.tire_size || item.item_name || 'Pneu';
      return item.item_name || this.itemTypeLabel(item.item_type);
    },

    posAddProduct(item) {
      if (!item || !item.stock_id) return;
      const current = this.posCart.find((cartItem) => cartItem.partner_stock_id === item.stock_id);
      const available = this.stockAvailable(item);
      const nextQty = current ? current.quantity + 1 : 1;
      if (nextQty > available) {
        this.flash('Quantidade maior que o estoque disponível.');
        return;
      }
      if (current) {
        current.quantity = nextQty;
        return;
      }
      this.posCart.push({
        partner_stock_id: item.stock_id,
        item_name: item.item_name || 'Produto',
        tire_size: item.tire_size || '',
        brand: item.brand || '',
        quantity: 1,
        unit_price: this.num(item.sale_price),
        available,
      });
    },

    posIncrementItem(cartItem) {
      if (!cartItem) return;
      if (cartItem.quantity + 1 > cartItem.available) {
        this.flash('Quantidade maior que o estoque disponível.');
        return;
      }
      cartItem.quantity += 1;
    },

    posDecrementItem(cartItem) {
      if (!cartItem) return;
      if (cartItem.quantity <= 1) {
        this.posRemoveItem(cartItem.partner_stock_id);
        return;
      }
      cartItem.quantity -= 1;
    },

    posRemoveItem(stockId) {
      this.posCart = this.posCart.filter((item) => item.partner_stock_id !== stockId);
    },

    posClearCart() {
      this.posCart = [];
      this.posDiscountAmount = 0;
      this.posFreightAmount = 0;
      this.posReceivedAmount = null;
      this.posNotes = '';
      this.posSaleIdempotencyKey = null;
      this.posMobileStep = 'select'; // carrinho vazio volta pra etapa de selecao no celular
    },

    // Avanca pra etapa de finalizar (so faz efeito no celular; no desktop tudo ja aparece junto).
    posGoCheckout() {
      if (!this.posCart.length) {
        this.flash('Adicione pelo menos um produto ao carrinho.');
        return;
      }
      this.posMobileStep = 'checkout';
      this.$nextTick(() => document.querySelector('.pos-main')?.scrollTo({ top: 0, behavior: 'smooth' }));
    },

    ensurePosSaleIdempotencyKey() {
      if (!this.posSaleIdempotencyKey) {
        this.posSaleIdempotencyKey = this.uuid();
      }
      return this.posSaleIdempotencyKey;
    },

    posSelectPayment(method, status = 'received') {
      this.saleForm.payment_method = method;
      this.saleForm.payment_status = status;
      if (status === 'receivable' && !this.saleForm.receivable_due_date) {
        this.saleForm.receivable_due_date = new Date().toISOString().slice(0, 10);
      }
    },

    onCustomerSearchInput() {
      this.saleForm.customer_name = this.posCustomerQuery.trim();
      this.saleForm.customer_id = null;
      this.posSelectedCustomerAddress = '';
      clearTimeout(this.posCustomerSearchTimer);
      const q = this.posCustomerQuery.trim();
      if (q.length < 2) {
        this.posCustomerResults = [];
        return;
      }
      this.posCustomerSearchTimer = setTimeout(async () => {
        try {
          const result = await this.api(`clientes/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
          this.posCustomerResults = result.rows || [];
        } catch {
          this.posCustomerResults = [];
        }
      }, 250);
    },

    selectPartnerCustomer(customer) {
      if (!customer) return;
      this.saleForm.customer_id = customer.id;
      this.saleForm.customer_name = customer.name || '';
      this.saleForm.customer_phone = customer.phone || '';
      const addressLine = this.customerAddressLine(customer);
      this.posSelectedCustomerAddress = addressLine !== '-' ? addressLine : '';
      // Entrega para cliente com endereco cadastrado: preenche sozinho.
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim() && this.posSelectedCustomerAddress) {
        this.saleForm.delivery_address = this.posSelectedCustomerAddress;
        this.deliveryAddressMissing = false;
      }
      this.posCustomerQuery = customer.name || '';
      this.posCustomerResults = [];
      this.posCustomerFormOpen = false;
    },

    // Abre o cadastro inline no PDV ja pre-preenchido com o texto buscado.
    openPosCustomerForm() {
      const q = this.posCustomerQuery.trim();
      const looksLikePhone = /\d{3,}/.test(q.replace(/\D/g, ''));
      this.clearCustomerForm();
      if (looksLikePhone) {
        this.customerForm.phone = q;
      } else {
        this.customerForm.name = q;
      }
      this.posCustomerResults = [];
      this.posCustomerFormOpen = true;
    },

    closePosCustomerForm() {
      this.posCustomerFormOpen = false;
      this.clearCustomerForm();
    },

    async createPosCustomer() {
      if (!this.customerForm.name.trim()) {
        this.flash('Informe o nome do cliente.');
        return;
      }
      this.saving = true;
      this.savingAction = 'customer';
      try {
        const streetWithNumber = [this.customerForm.address_street, this.customerForm.address_number]
          .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
        const addressParts = [
          streetWithNumber,
          this.customerForm.address_neighborhood,
          this.customerForm.address_city,
        ].map((item) => String(item || '').trim()).filter(Boolean);
        const payload = {
          name: this.customerForm.name.trim(),
          phone: this.toE164Phone(this.customerForm.phone),
          address: addressParts.join(' - ') || null,
          address_street: this.customerForm.address_street?.trim() || null,
          address_number: this.customerForm.address_number?.trim() || null,
          address_neighborhood: this.customerForm.address_neighborhood?.trim() || null,
          address_city: this.customerForm.address_city?.trim() || null,
          idempotency_key: this.uuid(),
        };
        const result = await this.api('clientes', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        const customer = {
          id: result.customer_id,
          name: payload.name,
          phone: payload.phone,
          address: payload.address,
          address_street: payload.address_street,
          address_number: payload.address_number,
          address_neighborhood: payload.address_neighborhood,
          address_city: payload.address_city,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        if (this.currentSection === 'clientes') {
          this.clientes = [customer, ...this.clientes.filter((item) => item.id !== customer.id)];
        } else {
          this.selectPartnerCustomer(customer);
        }
        this.clearCustomerForm();
        this.flash('Cliente cadastrado.');
        if (this.currentSection === 'clientes') {
          await this.loadData();
        }
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    clearCustomerForm() {
      this.customerForm = { name: '', phone: '', address_street: '', address_number: '', address_neighborhood: '', address_city: '' };
      this.editingCustomerId = null;
    },

    // Clique na linha da tabela: carrega o cliente no formulário para edição.
    editCustomer(customer) {
      if (!customer?.id) return;
      this.editingCustomerId = customer.id;
      this.customerForm = {
        name: customer.name || '',
        phone: customer.phone || '',
        address_street: customer.address_street || '',
        address_number: customer.address_number || '',
        address_neighborhood: customer.address_neighborhood || '',
        address_city: customer.address_city || '',
      };
      this.$nextTick(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    },

    // Botão do formulário de clientes: decide entre criar e atualizar.
    saveCustomer() {
      return this.editingCustomerId ? this.updateCustomer() : this.createPosCustomer();
    },

    customerPayloadFromForm() {
      const streetWithNumber = [this.customerForm.address_street, this.customerForm.address_number]
        .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
      const addressParts = [
        streetWithNumber,
        this.customerForm.address_neighborhood,
        this.customerForm.address_city,
      ].map((item) => String(item || '').trim()).filter(Boolean);
      return {
        name: this.customerForm.name.trim(),
        phone: this.toE164Phone(this.customerForm.phone),
        address: addressParts.join(' - ') || null,
        address_street: this.customerForm.address_street?.trim() || null,
        address_number: this.customerForm.address_number?.trim() || null,
        address_neighborhood: this.customerForm.address_neighborhood?.trim() || null,
        address_city: this.customerForm.address_city?.trim() || null,
      };
    },

    async updateCustomer() {
      if (!this.editingCustomerId) return;
      if (!this.customerForm.name.trim()) {
        this.flash('Informe o nome do cliente.');
        return;
      }
      this.saving = true;
      this.savingAction = 'customer';
      try {
        const payload = this.customerPayloadFromForm();
        await this.api('clientes/' + this.editingCustomerId, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        this.clearCustomerForm();
        this.flash('Cliente atualizado.');
        await this.loadData();
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deleteCustomer() {
      if (!this.editingCustomerId) return;
      const name = this.customerForm.name.trim() || 'este cliente';
      if (!window.confirm('Excluir ' + name + '? As vendas já registradas serão mantidas.')) return;
      const id = this.editingCustomerId;
      this.saving = true;
      this.savingAction = 'customer';
      try {
        await this.api('clientes/' + id, { method: 'DELETE' });
        this.clientes = this.clientes.filter((item) => item.id !== id);
        this.clearCustomerForm();
        this.flash('Cliente excluído.');
        await this.loadData();
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    // VIP automático: cliente é VIP quando atinge vipMinPurchases compras.
    customerIsVip(customer) {
      return this.customerSales(customer).length >= this.vipMinPurchases;
    },

    onFulfillmentChange() {
      if (this.saleForm.fulfillment_mode !== 'delivery') {
        this.deliveryAddressMissing = false;
        return;
      }
      // Cliente com endereco cadastrado: ja preenche a entrega.
      if (!this.saleForm.delivery_address.trim() && this.posSelectedCustomerAddress) {
        this.saleForm.delivery_address = this.posSelectedCustomerAddress;
        this.deliveryAddressMissing = false;
        return;
      }
      this.$nextTick(() => this.$refs.deliveryAddress?.focus());
    },

    async posFinalizeSale() {
      if (!this.posCart.length) {
        this.flash('Adicione pelo menos um produto ao carrinho.');
        return;
      }
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim()) {
        this.deliveryAddressMissing = true;
        this.$nextTick(() => this.$refs.deliveryAddress?.focus());
        this.flash('Informe o endereço de entrega ou mude para retirada.');
        return;
      }
      this.deliveryAddressMissing = false;
      if (this.saleForm.payment_status === 'receivable' && !this.saleForm.receivable_due_date) {
        this.flash('Informe a data para receber esta venda.');
        return;
      }
      const receivedAmount = this.saleForm.payment_status === 'receivable'
        ? null
        : this.num(this.posReceivedAmount ?? this.posCartTotal);
      if (this.saleForm.payment_status !== 'receivable' && receivedAmount < this.posCartTotal) {
        this.flash('Valor recebido menor que o total da venda.');
        return;
      }
      this.saving = true;
      this.savingAction = 'sale';
      try {
        const stableIdempotencyKey = this.ensurePosSaleIdempotencyKey();
        const body = {
          customer_id: this.saleForm.customer_id || null,
          customer_name: this.saleForm.customer_name.trim() || null,
          customer_phone: this.toE164Phone(this.saleForm.customer_phone),
          items: this.posCart.map((item) => ({
            partner_stock_id: item.partner_stock_id,
            quantity: this.num(item.quantity) || 1,
            unit_price: this.num(item.unit_price) || 0,
          })),
          payment_method: this.saleForm.payment_status === 'receivable' ? 'A receber' : this.saleForm.payment_method,
          payment_status: this.saleForm.payment_status || 'received',
          receivable_due_date: this.saleForm.payment_status === 'receivable'
            ? this.saleForm.receivable_due_date || null
            : null,
          receivable_installments: this.saleForm.payment_status === 'receivable'
            ? Math.max(1, Math.min(36, Number(this.saleForm.receivable_installments) || 1))
            : null,
          fulfillment_mode: this.saleForm.fulfillment_mode,
          delivery_address: this.saleForm.fulfillment_mode === 'delivery'
            ? this.saleForm.delivery_address.trim()
            : null,
          notes: this.posNotes.trim() || null,
          received_amount: receivedAmount,
          discount_amount: this.num(this.posDiscountAmount) || 0,
          freight_amount: this.num(this.posFreightAmount) || 0,
          source_tag: this.saleForm.source_tag || 'porta',
          idempotency_key: stableIdempotencyKey,
        };
        await this.api('vendas', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const paymentMethod = this.saleForm.payment_method;
        const paymentStatus = this.saleForm.payment_status || 'received';
        const fulfillmentMode = this.saleForm.fulfillment_mode;
        const sourceTag = this.saleForm.source_tag || 'porta';
        this.posClearCart();
        this.saleForm = {
          customer_id: null,
          customer_name: '',
          customer_phone: '',
          partner_stock_id: '',
          source_tag: sourceTag,
          quantity: 1,
          unit_price: 0,
          payment_method: paymentMethod,
          payment_status: paymentStatus,
          receivable_due_date: '',
          receivable_installments: 1,
          fulfillment_mode: fulfillmentMode,
          delivery_address: '',
        };
        this.posCustomerQuery = '';
        this.posCustomerResults = [];
        this.posSelectedCustomerAddress = '';
        this.deliveryAddressMissing = false;
        this.posSaleIdempotencyKey = null;
        await this.loadData();
        this.flash('Venda finalizada - estoque e financeiro atualizados.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async saveSale() {
      if (!this.saleForm.partner_stock_id) {
        this.flash('Selecione um item do estoque.');
        return;
      }
      if (this.saleForm.fulfillment_mode === 'delivery' && !this.saleForm.delivery_address.trim()) {
        this.flash('Informe o endereço de entrega ou mude para retirada.');
        return;
      }
      if (this.saleForm.payment_status === 'receivable' && !this.saleForm.receivable_due_date) {
        this.flash('Informe a data para receber esta venda.');
        return;
      }
      this.saving = true;
      this.savingAction = 'sale';
      try {
        const body = {
          customer_id: this.saleForm.customer_id || null,
          customer_name: this.saleForm.customer_name.trim() || null,
          // Telefone vai pro banco em E.164 (+5521...). Estado local guarda sÃ³ dÃ­gitos.
          customer_phone: this.toE164Phone(this.saleForm.customer_phone),
          items: [{
            // Aponta direto pro estoque local do parceiro â€” sem catÃ¡logo da matriz.
            partner_stock_id: this.saleForm.partner_stock_id,
            quantity: this.num(this.saleForm.quantity) || 1,
            unit_price: this.num(this.saleForm.unit_price) || 0,
          }],
          payment_method: this.saleForm.payment_status === 'receivable' ? 'A receber' : this.saleForm.payment_method,
          payment_status: this.saleForm.payment_status || 'received',
          receivable_due_date: this.saleForm.payment_status === 'receivable'
            ? this.saleForm.receivable_due_date || null
            : null,
          receivable_installments: this.saleForm.payment_status === 'receivable'
            ? Math.max(1, Math.min(36, Number(this.saleForm.receivable_installments) || 1))
            : null,
          fulfillment_mode: this.saleForm.fulfillment_mode,
          delivery_address: this.saleForm.fulfillment_mode === 'delivery'
            ? this.saleForm.delivery_address.trim()
            : null,
          source_tag: this.saleForm.source_tag || 'porta',
          idempotency_key: this.uuid(),
        };
        console.log('[venda] enviando:', body);  // Pra diagnÃ³stico â€” abrir DevTools console
        await this.api('vendas', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        // Preserva preferÃªncias do operador (modalidade + pagamento) entre vendas
        this.saleForm = {
          customer_id: null, customer_name: '', customer_phone: '', partner_stock_id: '',
          source_tag: this.saleForm.source_tag || 'porta',
          quantity: 1, unit_price: 0,
          payment_method: this.saleForm.payment_method,
          payment_status: this.saleForm.payment_status || 'received',
          receivable_due_date: '',
          receivable_installments: 1,
          fulfillment_mode: this.saleForm.fulfillment_mode,
          delivery_address: '',
        };
        await this.loadData();
        this.flash('Venda registrada - estoque baixado automaticamente.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async cancelSale(orderId) {
      if (!confirm('Cancelar esta venda? Sai do resumo, fica no histórico.')) return;
      this.saving = true;
      this.savingAction = 'sale-delete';
      try {
        await this.api(`vendas/${orderId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Venda cancelada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    // â”€â”€â”€ FORMS: STOCK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    editStock(item) {
      // Prefere colunas dimensionais do banco (migration 0038); cai pro parse da string sÃ³ pra
      // registros legados que ainda nÃ£o foram tocados depois da migration.
      const parsed = this.parseTireSize(item.tire_size);
      this.stockForm = {
        stock_id: item.id,
        item_type: item.item_type || 'pneu',
        item_name: item.item_name || '',
        tire_width: item.tire_width_mm ?? parsed.width,
        tire_aspect: item.tire_aspect_ratio ?? parsed.aspect,
        tire_rim: item.tire_rim_diameter ?? parsed.rim,
        brand: item.brand || '',
        supplier_name: item.supplier_name || '',
        quantity_on_hand: item.quantity_on_hand ?? null,
        minimum_quantity: item.minimum_quantity ?? null,
        average_cost: item.average_cost ?? null,
        sale_price: item.sale_price ?? null,
        tire_condition: item.tire_condition || 'Novo',
        shelf_location: item.shelf_location || '',
        // Posição em coluna própria (migration 0075); fallback à heurística p/ legado.
        tire_position: item.tire_position || this.stockPositionValue(item.supplier_name) || this.stockPositionValue(item.item_name) || '',
        is_tracked: Boolean(item.is_tracked),
      };
      this.currentTab = 'stock';
      this.goToSection('estoque');
    },

    clearStockForm() {
      this.stockForm = { stock_id: null, item_type: 'pneu', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', supplier_name: '', quantity_on_hand: null, minimum_quantity: null, average_cost: null, sale_price: null, tire_condition: 'Novo', shelf_location: '', tire_position: '', is_tracked: true };
    },

    async saveStock() {
      if (!this.stockForm.item_name.trim()) { this.flash('Nome do item é obrigatório.'); return; }

      const itemType = this.stockForm.item_type || 'pneu';
      const isService = itemType === 'servico';
      // Serviço não controla estoque; pneu/insumo controlam. O tipo dirige is_tracked.
      const isTracked = !isService;

      // Medida só faz sentido pra pneu. Insumo/serviço ignoram os campos de medida.
      let tireSize = null;
      if (itemType === 'pneu') {
        // Validação da medida: ou está toda preenchida, ou totalmente vazia.
        const tireParts = [this.stockForm.tire_width, this.stockForm.tire_aspect, this.stockForm.tire_rim];
        const filledCount = tireParts.filter((v) => v !== null && v !== '' && Number(v) > 0).length;
        if (filledCount > 0 && filledCount < 3) {
          this.flash('Preencha largura, perfil e aro completos, ou deixe os três vazios.');
          return;
        }
        tireSize = filledCount === 3 ? this.composeTireSize(this.stockForm.tire_width, this.stockForm.tire_aspect, this.stockForm.tire_rim) : null;
      }

      this.saving = true;
      this.savingAction = 'stock';
      try {
        await this.api('estoque', {
          method: 'POST',
          body: JSON.stringify({
            stock_id: this.stockForm.stock_id || null,
            item_type: itemType,
            item_name: this.stockForm.item_name.trim(),
            tire_size: tireSize,
            // Dimensões separadas (migration 0038) — banco indexa pra busca rápida
            tire_width_mm: tireSize ? this.num(this.stockForm.tire_width) : null,
            tire_aspect_ratio: tireSize ? this.num(this.stockForm.tire_aspect) : null,
            tire_rim_diameter: tireSize ? this.num(this.stockForm.tire_rim) : null,
            brand: isService ? null : (this.stockForm.brand?.trim() || null),
            // supplier_name volta a ser só fornecedor/origem — passa direto, sem posição (migration 0075).
            supplier_name: this.stockForm.supplier_name?.trim() || null,
            // Posição do pneu em coluna própria.
            tire_position: itemType === 'pneu' ? (this.stockPositionValue(this.stockForm.tire_position) || null) : null,
            quantity_on_hand: isTracked ? this.num(this.stockForm.quantity_on_hand) : null,
            minimum_quantity: isTracked && this.stockForm.minimum_quantity !== null && this.stockForm.minimum_quantity !== '' ? this.num(this.stockForm.minimum_quantity) : null,
            average_cost: this.stockForm.average_cost !== null && this.stockForm.average_cost !== '' ? this.num(this.stockForm.average_cost) : null,
            sale_price: this.stockForm.sale_price !== null && this.stockForm.sale_price !== '' ? this.num(this.stockForm.sale_price) : null,
            tire_condition: itemType === 'pneu' ? (this.stockForm.tire_condition?.trim() || null) : null,
            shelf_location: isService ? null : (this.stockForm.shelf_location?.trim() || null),
            is_tracked: isTracked,
          }),
        });
        this.clearStockForm();
        this.stockModalOpen = false;
        await this.loadData();
        this.flash('Estoque salvo.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deleteStock(stockId) {
      if (!confirm('Inativar este item? Sai da lista da unidade.')) return;
      this.saving = true;
      this.savingAction = 'stock-delete';
      try {
        await this.api(`estoque/${stockId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Item inativado.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    // â”€â”€â”€ FORMS: PURCHASE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async savePurchase() {
      if (!this.purchaseForm.item_name.trim()) { this.flash('Informe o pneu comprado.'); return; }
      const tireParts = [this.purchaseForm.tire_width, this.purchaseForm.tire_aspect, this.purchaseForm.tire_rim];
      const filledCount = tireParts.filter((v) => v !== null && v !== '' && Number(v) > 0).length;
      if (filledCount > 0 && filledCount < 3) {
        this.flash('Preencha largura, perfil e aro completos, ou deixe os tres vazios.');
        return;
      }
      const tireSize = filledCount === 3 ? this.composeTireSize(this.purchaseForm.tire_width, this.purchaseForm.tire_aspect, this.purchaseForm.tire_rim) : null;
      if (this.purchaseForm.payment_status === 'payable' && !this.purchaseForm.payable_due_date) {
        this.flash('Informe a data de vencimento da compra a prazo.');
        return;
      }
      this.saving = true;
      this.savingAction = 'purchase';
      try {
        await this.api('compras', {
          method: 'POST',
          body: JSON.stringify({
            supplier_name: this.purchaseForm.supplier_name.trim() || null,
            payment_status: this.purchaseForm.payment_status || 'paid_now',
            payable_due_date: this.purchaseForm.payment_status === 'payable' ? (this.purchaseForm.payable_due_date || null) : null,
            idempotency_key: this.uuid(),
            items: [{
              item_name: this.purchaseForm.item_name.trim(),
              tire_size: tireSize,
              tire_width_mm: tireSize ? this.num(this.purchaseForm.tire_width) : null,
              tire_aspect_ratio: tireSize ? this.num(this.purchaseForm.tire_aspect) : null,
              tire_rim_diameter: tireSize ? this.num(this.purchaseForm.tire_rim) : null,
              brand: this.purchaseForm.brand.trim() || null,
              quantity: this.num(this.purchaseForm.quantity) || 1,
              unit_cost: this.num(this.purchaseForm.unit_cost) || 0,
              sale_price: this.purchaseForm.sale_price !== null && this.purchaseForm.sale_price !== '' ? this.num(this.purchaseForm.sale_price) : null,
            }],
          }),
        });
        const wasPayable = this.purchaseForm.payment_status === 'payable';
        this.purchaseForm = { supplier_name: '', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', quantity: 1, unit_cost: 0, sale_price: null, payment_status: 'paid_now', payable_due_date: '' };
        await this.loadData();
        this.flash(wasPayable
          ? 'Compra registrada (a prazo) — conta a pagar criada.'
          : 'Compra registrada e estoque atualizado.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deletePurchase(purchaseId) {
      if (!confirm('Cancelar esta compra? Sai do custo do mês, fica registrada.')) return;
      this.saving = true;
      this.savingAction = 'purchase-delete';
      try {
        await this.api(`compras/${purchaseId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Compra cancelada.');
      } catch (err) {
        // Fix pos-Codex: tratamentos especificos para 409
        if (err.status === 409 && err.payload) {
          if (err.payload.error === 'cannot_delete_paid_purchase') {
            this.flash(err.payload.message || 'Esta compra ja foi paga e nao pode ser apagada.');
            return;
          }
          if (err.payload.error === 'stock_reversal_incomplete') {
            const items = (err.payload.failed_items || [])
              .map((it) => `- ${it.item_name} (qtd ${it.quantity})`)
              .join('\n');
            this.flash(`${err.payload.message}\n\nItens sem estorno:\n${items}`);
            return;
          }
        }
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async saveMaterialPayable() {
      if (!this.expenseForm.description.trim()) { this.flash('Descreva o material comprado.'); return; }
      if (this.num(this.expenseForm.amount) <= 0) { this.flash('Informe o valor do material.'); return; }
      this.saving = true;
      this.savingAction = 'payable';
      const idem = this.uuid();
      const payload = {
        counterparty_name: 'Compra de material',
        description: this.expenseForm.description.trim(),
        category: 'maintenance',
        amount: this.num(this.expenseForm.amount),
        due_date: null,
        status: 'paid',
        paid_at: new Date().toISOString(),
        payment_method: 'Pix',
        idempotency_key: idem,
      };
      const attempt = async (force) => this.api('contas-a-pagar', {
        method: 'POST',
        body: JSON.stringify({ ...payload, force_duplicate: force }),
      });
      try {
        try {
          await attempt(false);
        } catch (err) {
          // Fix pos-Codex: status='paid' agora roda dedupe via helper interno.
          // 409 duplicate_expense → pergunta e retenta com force.
          if (err.status === 409 && err.payload && err.payload.error === 'duplicate_expense') {
            const dups = (err.payload.duplicates || [])
              .map((d) => `- ${d.expense_date}: ${d.description} (R$ ${d.amount})`)
              .join('\n');
            const ok = confirm(`Ja existem despesas parecidas nos ultimos 7 dias:\n\n${dups}\n\nLancar mesmo assim?`);
            if (!ok) {
              this.flash('Cancelado. Confira despesas antes de lancar.');
              return;
            }
            await attempt(true);
          } else {
            throw err;
          }
        }
        this.expenseForm = { category: 'maintenance', description: '', amount: 0 };
        await this.loadData();
        this.flash('Material lançado em contas a pagar.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    // â”€â”€â”€ FORMS: EXPENSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async saveExpense() {
      if (!this.expenseForm.description.trim()) { this.flash('Descreva a despesa.'); return; }
      this.saving = true;
      this.savingAction = 'expense';
      try {
        await this.api('despesas', {
          method: 'POST',
          body: JSON.stringify({
            category: this.expenseForm.category,
            description: this.expenseForm.description.trim(),
            amount: this.num(this.expenseForm.amount),
            idempotency_key: this.uuid(),
          }),
        });
        this.expenseForm = { category: this.expenseForm.category, description: '', amount: 0 };
        await this.loadData();
        this.flash('Despesa registrada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async deleteExpense(expenseId) {
      if (!confirm('Excluir esta despesa do resumo?')) return;
      this.saving = true;
      this.savingAction = 'expense-delete';
      try {
        await this.api(`despesas/${expenseId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Despesa excluída.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async savePayable() {
      if (!this.payableForm.description.trim()) { this.flash('Descreva a conta a pagar.'); return; }
      if (this.num(this.payableForm.amount) <= 0) { this.flash('Informe o valor da conta a pagar.'); return; }
      if (this.payableForm.status === 'open' && !this.payableForm.due_date) { this.flash('Informe o vencimento da conta em aberto.'); return; }
      this.saving = true;
      this.savingAction = 'payable';
      try {
        const payload = {
          counterparty_name: this.payableForm.counterparty_name.trim() || null,
          description: this.payableForm.description.trim(),
          category: this.payableForm.category || 'other',
          amount: this.num(this.payableForm.amount),
          due_date: this.payableForm.status === 'open' ? this.payableForm.due_date || null : null,
          notes: this.payableForm.notes ?? null,
        };

        if (this.editingPayableId) {
          await this.api(`contas-a-pagar/${this.editingPayableId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
          this.resetPayableForm();
          await this.loadData();
          this.flash('Conta a pagar atualizada.');
          return;
        }

        const wasPaid = this.payableForm.status === 'paid';
        const paidAt = this.payableForm.status === 'paid'
          ? (this.payableForm.paid_at ? new Date(`${this.payableForm.paid_at}T12:00:00`).toISOString() : new Date().toISOString())
          : null;
        await this.api('contas-a-pagar', {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            status: this.payableForm.status || 'open',
            paid_at: paidAt,
            payment_method: this.payableForm.status === 'paid' ? this.payableForm.payment_method || 'Pix' : null,
            idempotency_key: this.uuid(),
          }),
        });
        this.resetPayableForm();
        await this.loadData();
        this.flash(wasPaid
          ? 'Pagamento registrado no custo do mês.'
          : 'Conta a pagar cadastrada em aberto.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async saveReceivable() {
      if (!this.receivableForm.description.trim()) { this.flash('Descreva a conta a receber.'); return; }
      if (this.num(this.receivableForm.amount) <= 0) { this.flash('Informe o valor da conta a receber.'); return; }
      if (this.receivableForm.status === 'open' && !this.receivableForm.due_date) { this.flash('Informe o vencimento da conta em aberto.'); return; }
      this.saving = true;
      this.savingAction = 'receivable';
      try {
        const payload = {
          customer_id: this.receivableForm.customer_id || null,
          customer_name: this.receivableForm.customer_name.trim() || null,
          description: this.receivableForm.description.trim(),
          source_tag: this.receivableForm.source_tag || 'porta',
          amount: this.num(this.receivableForm.amount),
          due_date: this.receivableForm.status === 'open' ? this.receivableForm.due_date || null : null,
          notes: this.receivableForm.notes ?? null,
        };

        if (this.editingReceivableId) {
          await this.api(`contas-a-receber/${this.editingReceivableId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
          this.resetReceivableForm();
          await this.loadData();
          this.flash('Conta a receber atualizada.');
          return;
        }

        const wasReceived = this.receivableForm.status === 'received';
        const receivedAt = this.receivableForm.status === 'received'
          ? (this.receivableForm.received_at ? new Date(`${this.receivableForm.received_at}T12:00:00`).toISOString() : new Date().toISOString())
          : null;
        await this.api('contas-a-receber', {
          method: 'POST',
          body: JSON.stringify({
            ...payload,
            status: this.receivableForm.status || 'open',
            received_at: receivedAt,
            payment_method: this.receivableForm.status === 'received' ? this.receivableForm.payment_method || 'Pix' : null,
            idempotency_key: this.uuid(),
          }),
        });
        this.resetReceivableForm();
        await this.loadData();
        this.flash(wasReceived
          ? 'Recebimento registrado.'
          : 'Conta a receber cadastrada em aberto.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    resetPayableForm() {
      this.editingPayableId = null;
      this.payableForm = { counterparty_name: '', description: '', category: 'supplier', amount: 0, due_date: '', status: 'open', paid_at: '', payment_method: 'Pix', notes: null };
    },

    editPayable(payable) {
      if (!payable || payable.status !== 'open') {
        this.flash('Apenas contas em aberto podem ser editadas.');
        return;
      }
      this.editingPayableId = payable.id;
      this.payableForm = {
        counterparty_name: payable.counterparty_name || '',
        description: payable.description || '',
        category: payable.category || 'other',
        amount: this.num(payable.amount),
        due_date: payable.due_date ? String(payable.due_date).slice(0, 10) : '',
        status: 'open',
        paid_at: '',
        payment_method: payable.payment_method || 'Pix',
        notes: payable.notes ?? null,
      };
      document.querySelector('.pos-form-card.payable')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.flash('Editando conta a pagar em aberto.');
    },

    resetReceivableForm() {
      this.editingReceivableId = null;
      this.receivableForm = { customer_id: null, customer_name: '', description: '', source_tag: 'porta', amount: 0, due_date: '', status: 'open', received_at: '', payment_method: 'Pix', notes: null };
      this.receivableCustomerQuery = '';
      this.receivableCustomerResults = [];
    },

    editReceivable(receivable) {
      if (!receivable || receivable.status !== 'open') {
        this.flash('Apenas contas em aberto podem ser editadas.');
        return;
      }
      this.editingReceivableId = receivable.id;
      this.receivableForm = {
        customer_id: receivable.customer_id || null,
        customer_name: receivable.customer_name || '',
        description: receivable.description || '',
        source_tag: receivable.source_tag || 'porta',
        amount: this.num(receivable.amount),
        due_date: receivable.due_date ? String(receivable.due_date).slice(0, 10) : '',
        status: 'open',
        received_at: '',
        payment_method: receivable.payment_method || 'Pix',
        notes: receivable.notes ?? null,
      };
      this.receivableCustomerQuery = receivable.customer_name || '';
      this.receivableCustomerResults = [];
      document.querySelector('.pos-form-card.receivable')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.flash('Editando conta a receber em aberto.');
    },

    // Busca de cliente cadastrado para vincular na conta a receber.
    searchReceivableCustomers() {
      this.receivableForm.customer_id = null;
      this.receivableForm.customer_name = this.receivableCustomerQuery;
      clearTimeout(this.receivableCustomerSearchTimer);
      const q = this.receivableCustomerQuery.trim();
      if (q.length < 2) {
        this.receivableCustomerResults = [];
        return;
      }
      this.receivableCustomerSearchTimer = setTimeout(async () => {
        try {
          const result = await this.api(`clientes/buscar?q=${encodeURIComponent(q)}`, { method: 'GET' });
          this.receivableCustomerResults = result.rows || [];
        } catch {
          this.receivableCustomerResults = [];
        }
      }, 250);
    },

    selectReceivableCustomer(customer) {
      if (!customer) return;
      this.receivableForm.customer_id = customer.id;
      this.receivableForm.customer_name = customer.name || '';
      this.receivableCustomerQuery = customer.name || '';
      this.receivableCustomerResults = [];
    },

    clearReceivableCustomerLink() {
      this.receivableForm.customer_id = null;
      this.receivableForm.customer_name = '';
      this.receivableCustomerQuery = '';
      this.receivableCustomerResults = [];
    },

    async settlePayable(payableId) {
      if (!confirm('Marcar esta conta como paga agora?')) return;
      this.saving = true;
      this.savingAction = `payable-pay-${payableId}`;
      const paidAt = new Date().toISOString();
      const attempt = async (force) => this.api(`contas-a-pagar/${payableId}/pagar`, {
        method: 'POST',
        body: JSON.stringify({ paid_at: paidAt, payment_method: 'Pix', force_duplicate: force }),
      });
      try {
        try {
          await attempt(false);
        } catch (err) {
          if (err.status === 409 && err.payload && err.payload.error === 'duplicate_expense') {
            const dups = (err.payload.duplicates || [])
              .map((d) => `- ${d.expense_date}: ${d.description} (R$ ${d.amount})`)
              .join('\n');
            const ok = confirm(
              `Ja existem despesas parecidas nos ultimos 7 dias:\n\n${dups}\n\nPagar mesmo assim? (vai criar uma despesa nova alem das ja existentes)`,
            );
            if (!ok) {
              this.flash('Pagamento cancelado. Confira despesas antes de marcar como paga.');
              return;
            }
            await attempt(true);
          } else {
            throw err;
          }
        }
        await this.loadData();
        this.flash('Conta marcada como paga.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async cancelPayable(payableId) {
      if (!confirm('Cancelar esta conta a pagar?')) return;
      this.saving = true;
      this.savingAction = `payable-cancel-${payableId}`;
      try {
        await this.api(`contas-a-pagar/${payableId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Conta a pagar cancelada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async settleInstallment(receivableId, installmentId) {
      if (!confirm('Marcar esta parcela como recebida?')) return;
      this.saving = true;
      this.savingAction = `installment-receive-${installmentId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}/parcelas/${installmentId}/receber`, {
          method: 'POST',
          body: JSON.stringify({ received_at: new Date().toISOString(), payment_method: 'Pix' }),
        });
        await this.loadData();
        this.flash('Parcela recebida.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async settleReceivable(receivableId) {
      if (!confirm('Marcar esta conta como recebida agora?')) return;
      this.saving = true;
      this.savingAction = `receivable-receive-${receivableId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}/receber`, {
          method: 'POST',
          body: JSON.stringify({
            received_at: new Date().toISOString(),
            payment_method: 'Pix',
          }),
        });
        await this.loadData();
        this.flash('Conta marcada como recebida.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    async cancelReceivable(receivableId) {
      if (!confirm('Cancelar esta conta a receber?')) return;
      this.saving = true;
      this.savingAction = `receivable-cancel-${receivableId}`;
      try {
        await this.api(`contas-a-receber/${receivableId}`, { method: 'DELETE' });
        await this.loadData();
        this.flash('Conta a receber cancelada.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false;
        this.savingAction = '';
      }
    },

    // â”€â”€â”€ CHARTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    renderAllCharts() {
      this.renderPosSparkline();
      this.renderSalesTrendChart();
      this.renderResultChart();
      this.renderStockChart();
      this.renderStockMovementChart();
      this.renderFinanceBarChart();
      this.renderFinanceSplitChart();
      this.renderFinanceOriginChart();
      this.renderFinanceUnitsChart();
      this.renderFinanceRevenuePosChart();
      this.renderFinanceCostsPosChart();
    },

    renderPosSparkline() {
      const ctx = document.getElementById('chartPosSpark');
      if (!ctx) return;
      if (window._posSparkChart) window._posSparkChart.destroy();

      const series = this.posSalesTodayHourly;
      window._posSparkChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            data: series.map((d) => d.value),
            borderColor: this.theme === 'light' ? '#1e40af' : '#facc15',
            backgroundColor: this.theme === 'light' ? 'rgba(30,64,175,.12)' : 'rgba(250,204,21,.12)',
            borderWidth: 2,
            tension: .35,
            pointRadius: 0,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    },

    renderSalesTrendChart() {
      const ctx = document.getElementById('chartSalesTrend');
      if (!ctx) return;
      if (window._salesTrendChart) window._salesTrendChart.destroy();

      const series = this.salesSeries7d;
      const total = series.reduce((s, d) => s + d.value, 0);
      if (!total) {
        window._salesTrendChart = new Chart(ctx, {
          type: 'bar',
          data: { labels: series.map((d) => d.label), datasets: [{ data: series.map(() => 0), backgroundColor: '#e5e7eb', borderRadius: 6 }] },
          options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { size: 11 } } }, y: { display: false } } },
        });
        return;
      }

      window._salesTrendChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            data: series.map((d) => d.value),
            backgroundColor: '#10b981',
            borderRadius: 6,
            barThickness: 18,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: { label: (ctx) => this.money(ctx.parsed.y) },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 11 } }, border: { display: false } },
            y: { grid: { color: '#f3f4f6' }, ticks: { color: '#9ca3af', font: { size: 11 }, callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },

    renderResultChart() {
      const ctx = document.getElementById('chartResult');
      if (!ctx) return;
      if (window._resultChart) window._resultChart.destroy();

      const r = this.resumo || {};
      const result = this.num(r.estimated_result_month);
      const data = [this.num(r.sales_month), this.num(r.purchases_month), this.num(r.expenses_month), result];

      window._resultChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Vendas', 'Compras', 'Despesas', 'Saldo'],
          datasets: [{
            data,
            backgroundColor: ['#3b82f6', '#f59e0b', '#ef4444', result >= 0 ? '#10b981' : '#e11d48'],
            borderRadius: 6,
            barThickness: 28,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: { label: (ctx) => this.money(ctx.parsed.y) },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 11 } }, border: { display: false } },
            y: { grid: { color: '#f3f4f6' }, ticks: { color: '#9ca3af', font: { size: 11 }, callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },

    renderStockChart() {
      const ctx = document.getElementById('chartStock');
      if (!ctx) return;
      if (window._stockChart) window._stockChart.destroy();

      const s = this.stockBreakdown;
      const data = [s.in_stock, s.low_stock, s.out_of_stock, s.not_tracked, s.unknown];
      const total = data.reduce((sum, v) => sum + v, 0);

      window._stockChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Ok', 'Baixo', 'Zerado', 'Não controlado', 'Desconhecido'],
          datasets: [{
            data,
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444', '#94a3b8', '#cbd5e1'],
            borderWidth: 0,
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: { position: 'right', labels: { color: '#374151', font: { size: 11 }, boxWidth: 10, padding: 10 } },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => total > 0 ? `${ctx.label}: ${ctx.parsed} (${Math.round(ctx.parsed / total * 100)}%)` : `${ctx.label}: 0`,
              },
            },
          },
        },
      });
    },

    renderStockMovementChart() {
      const ctx = document.getElementById('chartStockMovement');
      if (!ctx) return;
      if (window._stockMovementChart) window._stockMovementChart.destroy();
      const series = this.stockMovementSeries;
      window._stockMovementChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: series.map((item) => item.label),
          datasets: [
            { label: 'Entradas', data: series.map((item) => item.entradas), backgroundColor: '#047857', borderRadius: 4 },
            { label: 'Saídas', data: series.map((item) => item.saidas), backgroundColor: '#94a3b8', borderRadius: 4 },
          ],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', align: 'end', labels: { boxWidth: 10, color: '#475569', font: { size: 11 } } },
            tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} un.` } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 } }, border: { display: false } },
            y: { beginAtZero: true, grid: { color: '#e5e7eb' }, ticks: { precision: 0, color: '#64748b' }, border: { display: false } },
          },
        },
      });
    },

    renderFinanceBarChart() {
      const ctx = document.getElementById('chartFinanceBar');
      if (!ctx) return;
      if (window._financeBarChart) window._financeBarChart.destroy();

      const r = this.resumo || {};
      const result = this.num(r.estimated_result_month);
      window._financeBarChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Vendas', 'Compras', 'Despesas', 'Resultado'],
          datasets: [{
            data: [this.num(r.sales_month), this.num(r.purchases_month), this.num(r.expenses_month), result],
            backgroundColor: ['#047857', '#6b7280', '#dc3f4d', result >= 0 ? '#047857' : '#be123c'],
            borderRadius: 5,
            barThickness: 46,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: { label: (ctx) => this.money(ctx.parsed.y) },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#475569', font: { size: 11 } }, border: { display: false } },
            y: { grid: { color: '#e5e7eb' }, ticks: { color: '#475569', callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },

    renderFinanceSplitChart() {
      const ctx = document.getElementById('chartFinanceSplit');
      if (!ctx) return;
      if (window._financeSplitChart) window._financeSplitChart.destroy();

      const split = this.financeCostSplit;
      const totalCostsLabel = this.money(this.totalCusts);
      window._financeSplitChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: split.map((item) => item.label),
          datasets: [{
            data: split.map((item) => item.value),
            backgroundColor: split.map((item) => item.color),
            borderColor: '#ffffff',
            borderWidth: 4,
            hoverBorderColor: '#ffffff',
            radius: '98%',
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '54%',
          layout: { padding: 0 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${this.money(ctx.parsed)}` } },
          },
        },
        plugins: [{
          id: 'financeCostCenterLabel',
          afterDraw(chart) {
            const { ctx: canvasCtx, chartArea } = chart;
            if (!chartArea) return;
            const arc = chart.getDatasetMeta(0).data[0];
            const x = arc?.x ?? (chartArea.left + chartArea.right) / 2;
            const y = arc?.y ?? (chartArea.top + chartArea.bottom) / 2;
            canvasCtx.save();
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            canvasCtx.fillStyle = '#111827';
            canvasCtx.font = '600 20px Inter, system-ui, sans-serif';
            canvasCtx.fillText(totalCostsLabel, x, y - 8);
            canvasCtx.fillStyle = '#64748b';
            canvasCtx.font = '400 12px Inter, system-ui, sans-serif';
            canvasCtx.fillText('Total de custos', x, y + 16);
            canvasCtx.restore();
          },
        }],
      });
    },

    renderFinanceOriginChart() {
      const ctx = document.getElementById('chartFinanceOrigin');
      if (!ctx) return;
      if (window._financeOriginChart) window._financeOriginChart.destroy();

      const split = this.financeOriginSplit;
      const totalUnits = split.reduce((sum, item) => sum + this.num(item.count), 0);
      window._financeOriginChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: split.map((item) => item.label),
          datasets: [{
            data: split.map((item) => item.count),
            backgroundColor: split.map((item) => item.color),
            borderColor: '#ffffff',
            borderWidth: 4,
            hoverBorderColor: '#ffffff',
            radius: '98%',
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '54%',
          layout: { padding: 0 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed} pneus` } },
          },
        },
        plugins: [{
          id: 'financeOriginCenterLabel',
          afterDraw(chart) {
            const { ctx: canvasCtx, chartArea } = chart;
            if (!chartArea) return;
            const arc = chart.getDatasetMeta(0).data[0];
            const x = arc?.x ?? (chartArea.left + chartArea.right) / 2;
            const y = arc?.y ?? (chartArea.top + chartArea.bottom) / 2;
            canvasCtx.save();
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            canvasCtx.fillStyle = '#111827';
            canvasCtx.font = '600 22px Inter, system-ui, sans-serif';
            canvasCtx.fillText(String(totalUnits), x, y - 8);
            canvasCtx.fillStyle = '#64748b';
            canvasCtx.font = '400 12px Inter, system-ui, sans-serif';
            canvasCtx.fillText('Pneus', x, y + 16);
            canvasCtx.restore();
          },
        }],
      });
    },

    renderFinanceUnitsChart() {
      const ctx = document.getElementById('chartFinanceUnits');
      if (!ctx) return;
      if (window._financeUnitsChart) window._financeUnitsChart.destroy();

      const series = this.financeRevenueSeries30d;
      window._financeUnitsChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            data: series.map((d) => d.value),
            borderColor: '#047857',
            backgroundColor: 'rgba(4, 120, 87, 0.12)',
            fill: true,
            tension: 0.35,
            pointRadius: 2.5,
            pointHoverRadius: 4,
            pointBackgroundColor: '#047857',
            borderWidth: 2,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => this.money(ctx.parsed.y) } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#475569', maxTicksLimit: 8, font: { size: 11 } }, border: { display: false } },
            y: { beginAtZero: true, grid: { color: '#e5e7eb' }, ticks: { color: '#475569', callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },

    renderFinanceRevenuePosChart() {
      const ctx = document.getElementById('chartFinanceRevenuePos');
      if (!ctx) return;
      if (window._financeRevenuePosChart) window._financeRevenuePosChart.destroy();

      const series = this.financeRevenueSeries30d;
      const light = this.theme === 'light';
      window._financeRevenuePosChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            label: 'Vendas',
            data: series.map((d) => d.value),
            borderColor: light ? '#1e40af' : '#ffd000',
            backgroundColor: light ? 'rgba(30, 64, 175, 0.10)' : 'rgba(255, 208, 0, 0.14)',
            fill: true,
            tension: 0.36,
            pointRadius: 2.4,
            pointHoverRadius: 4,
            pointBackgroundColor: light ? '#1e40af' : '#ffd000',
            borderWidth: 2,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: light ? '#0f172a' : '#05080b',
              borderColor: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.12)',
              borderWidth: 1,
              padding: 10,
              callbacks: { label: (item) => this.money(item.parsed.y) },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: light ? '#64748b' : '#8b949e', maxTicksLimit: 7, font: { size: 11 } }, border: { color: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.1)' } },
            y: {
              beginAtZero: true,
              grid: { color: light ? 'rgba(15,23,42,.08)' : 'rgba(255,255,255,.07)' },
              ticks: { color: light ? '#64748b' : '#8b949e', callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') },
              border: { display: false },
            },
          },
        },
      });
    },

    renderFinanceCostsPosChart() {
      const ctx = document.getElementById('chartFinanceCostsPos');
      if (!ctx) return;
      if (window._financeCostsPosChart) window._financeCostsPosChart.destroy();

      const split = this.financeCostSplit;
      const totalCostsLabel = this.money(this.totalCusts);
      const light = this.theme === 'light';
      window._financeCostsPosChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: split.map((item) => item.label),
          datasets: [{
            data: split.map((item) => item.value),
            backgroundColor: split.map((item) => item.color === '#dc3f4d' ? '#c94b57' : item.color),
            borderColor: light ? '#ffffff' : '#11161b',
            borderWidth: 5,
            hoverBorderColor: light ? '#ffffff' : '#11161b',
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '68%',
          layout: { padding: { bottom: 8 } },
          plugins: {
            legend: { position: 'bottom', labels: { color: light ? '#475569' : '#d1d5db', boxWidth: 10, padding: 14, font: { size: 11 } } },
            tooltip: {
              backgroundColor: light ? '#0f172a' : '#05080b',
              borderColor: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.12)',
              borderWidth: 1,
              padding: 10,
              callbacks: { label: (item) => `${item.label}: ${this.money(item.parsed)}` },
            },
          },
        },
        plugins: [{
          id: 'financeCostsPosCenterLabel',
          afterDraw(chart) {
            const { ctx: canvasCtx, chartArea } = chart;
            if (!chartArea) return;
            const meta = chart.getDatasetMeta(0);
            const arc = meta.data && meta.data[0];
            // Centro do donut: usar coordenadas do próprio arco quando disponíveis
            // (Chart.js já considera o espaço reservado pra legenda). Fallback pro
            // centro do chartArea.
            const cx = (arc && typeof arc.x === 'number')
              ? arc.x
              : (chartArea.left + chartArea.right) / 2;
            const cy = (arc && typeof arc.y === 'number')
              ? arc.y
              : (chartArea.top + chartArea.bottom) / 2;
            canvasCtx.save();
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            // Offsets simétricos em torno de cy para o bloco (valor + rótulo)
            // ficar visualmente centralizado no buraco do donut.
            canvasCtx.fillStyle = light ? '#0f172a' : '#f8fafc';
            canvasCtx.font = '700 15px Inter, system-ui, sans-serif';
            canvasCtx.fillText(totalCostsLabel, cx, cy - 9);
            canvasCtx.fillStyle = light ? '#64748b' : '#9ca3af';
            canvasCtx.font = '400 10px Inter, system-ui, sans-serif';
            canvasCtx.fillText('Custos', cx, cy + 9);
            canvasCtx.restore();
          },
        }],
      });
    },

    // â”€â”€â”€ MÃSCARAS / FORMATAÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Telefone: estado guarda apenas dÃ­gitos (max 11). Display Ã© (DD) 9XXXX-XXXX.
    // No submit, vai normalizado pra E.164 (+55DDXXXXXXXXX) via toE164Phone().
    onPhoneInput(value) {
      return String(value || '').replace(/\D/g, '').slice(0, 11);
    },

    formatPhoneDisplay(rawDigits) {
      let d = String(rawDigits || '').replace(/\D/g, '');
      if ((d.length === 12 || d.length === 13) && d.startsWith('55')) {
        d = d.slice(2);
      }
      if (d.length === 0) return '';
      if (d.length <= 2) return `(${d}`;
      if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
      if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
      return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`;
    },

    toE164Phone(rawDigits) {
      const d = String(rawDigits || '').replace(/\D/g, '');
      if (!d) return null;
      if (d.length === 10 || d.length === 11) return `+55${d}`;
      // jÃ¡ com 12+ dÃ­gitos: assume que veio com DDI
      return `+${d}`;
    },

    cpfDigits(value) {
      return String(value || '').replace(/\D/g, '').slice(0, 11);
    },

    // Moeda BRL: estado guarda Number em reais (ex: 1234.50).
    // Input recebe dÃ­gitos puros, trata como centavos.
    onCurrencyInput(value) {
      const digits = String(value || '').replace(/\D/g, '');
      if (!digits) return 0;
      return Math.round(Number(digits)) / 100;
    },

    formatBRLDisplay(value) {
      const n = this.num(value);
      if (n === 0) return '';
      return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    // Medida de pneu: trÃªs campos numÃ©ricos (largura/perfil-aro) compostos em string canÃ´nica.
    // Banco recebe sempre o formato "WIDTH/ASPECT-RIM" (ex: "90/90-18"), nunca input livre.
    composeTireSize(width, aspect, rim) {
      const w = Number(width || 0);
      const a = Number(aspect || 0);
      const r = Number(rim || 0);
      if (!w || !a || !r) return null;
      return `${w}/${a}-${r}`;
    },

    parseTireSize(value) {
      // Reverte "90/90-18" â†’ { width: 90, aspect: 90, rim: 18 }
      // Aceita tambÃ©m variantes radiais "150/60R17" ou "150/60ZR17" (R extraÃ­do pra rim).
      const empty = { width: null, aspect: null, rim: null };
      if (!value) return empty;
      const match = String(value).toUpperCase().match(/^(\d{2,3})\/(\d{2,3})[-ZR]*(\d{1,2})$/);
      if (!match) return empty;
      return {
        width: Number(match[1]),
        aspect: Number(match[2]),
        rim: Number(match[3]),
      };
    },

    tireSizePreview() {
      // Mostra o formato canÃ´nico em tempo real ao lado do label.
      return this.composeTireSize(
        this.stockForm.tire_width,
        this.stockForm.tire_aspect,
        this.stockForm.tire_rim,
      );
    },

    // â”€â”€â”€ HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    num(v) { return Number(v || 0); },

    isSaving(action) {
      return this.saving && this.savingAction === action;
    },

    money(v) {
      return this.num(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    },

    uuid() {
      return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    },

    dateKeySaoPaulo(value) {
      if (!value) return '';
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value));
    },

    formatDate(value) {
      if (!value) return '-';
      return new Date(value).toLocaleDateString('pt-BR');
    },

    formatDateTime(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString('pt-BR');
    },

    categoryLabel(category) {
      const map = {
        employee_payment: 'Funcionário',
        rent: 'Aluguel',
        utilities: 'Contas',
        maintenance: 'Manutenção',
        delivery: 'Entrega',
        tax: 'Taxa/imposto',
        supplier_payment: 'Fornecedor',
        other: 'Outra',
      };
      return map[category] || category || 'Despesa';
    },

    payableCategoryLabel(category) {
      const map = {
        supplier: 'Fornecedor',
        employee: 'Funcionário',
        rent: 'Aluguel',
        utilities: 'Contas',
        tax: 'Taxa/imposto',
        maintenance: 'Manutenção',
        other: 'Outra',
      };
      return map[category] || category || 'Conta';
    },

    normalizeSource(source) {
      const value = String(source || '').trim().toLowerCase();
      if (value === '2w') return '2w';
      if (value === 'walkin_balcao' || value === 'walkin_telefone' || value === 'porta') return 'porta';
      return value || 'porta';
    },

    sourceLabel(source) {
      const map = {
        '2w': '2W',
        porta: 'Porta',
        walkin_balcao: 'Porta',
        walkin_telefone: 'Telefone',
        outro: 'Outro',
      };
      return map[source] || map[this.normalizeSource(source)] || 'Porta';
    },

    sourceClass(source) {
      const normalized = this.normalizeSource(source);
      if (normalized === '2w') return 'bg-emerald-50 text-emerald-700';
      if (normalized === 'porta') return 'bg-gray-100 text-gray-700';
      return 'bg-blue-50 text-blue-700';
    },

    stockStatusClass(status) {
      const map = {
        in_stock: 'bg-emerald-50 text-emerald-700',
        low_stock: 'bg-amber-50 text-amber-700',
        reserved: 'bg-indigo-50 text-indigo-700',
        out_of_stock: 'bg-rose-50 text-rose-700',
        not_tracked: 'bg-gray-100 text-gray-600',
        unknown: 'bg-gray-100 text-gray-500',
      };
      return map[status] || 'bg-gray-100 text-gray-600';
    },

    stockStatusLabel(status) {
      const map = {
        in_stock: 'Em estoque',
        low_stock: 'Estoque baixo',
        reserved: 'Reservado',
        out_of_stock: 'Zerado',
        not_tracked: 'Não controlado',
        unknown: 'Sem mínimo',
      };
      return map[status] || 'Sem status';
    },

    // 0076: disponível = físico − reservado (item não rastreado = sem limite).
    // O carrinho/pedido bloqueia pela DISPONIBILIDADE, não pelo físico, para não
    // vender um pneu já comprometido com uma entrega.
    stockAvailable(item) {
      if (!item || !item.is_tracked) return Infinity;
      return this.num(item.quantity_on_hand) - this.num(item.quantity_reserved);
    },

    // Frente de caixa e dropdown de venda mostram o que pode ser vendido agora.
    // Se houver reserva aberta, explicita o físico para o usuário entender a diferença.
    stockAvailabilityLabel(item) {
      if (!item || !item.is_tracked) return 'sem controle';
      const available = this.stockAvailable(item);
      const reserved = this.num(item.quantity_reserved);
      if (reserved > 0) return `${available} disp. (${this.num(item.quantity_on_hand)} fis.)`;
      return `${available} un.`;
    },

    stockPositionValue(value) {
      const raw = String(value || '').trim().toLowerCase();
      if (raw.includes('traseiro')) return 'Traseiro';
      if (raw.includes('dianteiro')) return 'Dianteiro';
      return '';
    },

    stockPositionLabel(item) {
      // Coluna própria (migration 0075) tem prioridade.
      const fromColumn = this.stockPositionValue(item?.tire_position);
      if (fromColumn) return fromColumn;
      // Fallback p/ linhas legadas ainda não re-salvas.
      const fromSupplier = this.stockPositionValue(item?.supplier_name);
      if (fromSupplier) return fromSupplier;
      const fromName = this.stockPositionValue(item?.item_name);
      return fromName || '-';
    },

    stockOriginKey(item) {
      const supplier = String(item?.supplier_name || '').toLowerCase();
      return supplier.includes('2w') ? '2w' : 'porta';
    },

    stockOriginLabel(item) {
      return this.stockOriginKey(item) === '2w' ? '2W' : 'Porta';
    },

    stockItemValue(item) {
      const qty = item.is_tracked ? this.num(item.quantity_on_hand) : 0;
      return qty * this.num(item.average_cost || item.sale_price);
    },

    // 0076: rótulo de quantidade na tabela. Mostra físico; quando há reserva aberta,
    // anexa o disponível ("físico (N disp.)") para deixar claro o que está comprometido.
    stockQtyDisplay(item) {
      if (!item || !item.is_tracked) return '-';
      const physical = this.num(item.quantity_on_hand);
      const reserved = this.num(item.quantity_reserved);
      if (reserved > 0) return `${physical} (${this.stockAvailable(item)} disp.)`;
      return physical;
    },

    selectStock(item) {
      this.stockSelected = item.id;
    },

    openStockModal(item) {
      if (item) {
        this.editStock(item);
      } else {
        this.clearStockForm();
      }
      this.stockModalOpen = true;
    },

    closeStockModal() {
      this.stockModalOpen = false;
    },

    // ─── Movimentação de saldo (botões "Dar entrada" / "Ajustar saldo") ───────
    // Reusa POST /estoque (upsert). Como o upsert sobrescreve todas as colunas,
    // remontamos o payload COMPLETO do item e só trocamos quantity_on_hand.
    async _persistStockQuantity(item, newQty) {
      await this.api('estoque', {
        method: 'POST',
        body: JSON.stringify({
          stock_id: item.id,
          item_type: item.item_type || 'pneu',
          item_name: item.item_name,
          tire_size: item.tire_size ?? null,
          tire_width_mm: item.tire_width_mm ?? null,
          tire_aspect_ratio: item.tire_aspect_ratio ?? null,
          tire_rim_diameter: item.tire_rim_diameter ?? null,
          brand: item.brand ?? null,
          supplier_name: item.supplier_name ?? null,
          quantity_on_hand: newQty,
          minimum_quantity: item.minimum_quantity ?? null,
          average_cost: item.average_cost != null ? this.num(item.average_cost) : null,
          sale_price: item.sale_price != null ? this.num(item.sale_price) : null,
          tire_condition: item.tire_condition ?? null,
          shelf_location: item.shelf_location ?? null,
          tire_position: item.tire_position ?? null,
          is_tracked: Boolean(item.is_tracked),
        }),
      });
      await this.loadData();
    },

    openStockEntry(item) {
      if (!item || !item.is_tracked) return;
      this.stockOpItem = item;
      this.stockEntryQty = null;
      this.stockEntryOpen = true;
    },
    closeStockEntry() { this.stockEntryOpen = false; this.stockOpItem = null; },

    async saveStockEntry() {
      const item = this.stockOpItem;
      const delta = this.num(this.stockEntryQty);
      if (!item) return;
      if (delta <= 0) { this.flash('Informe quantas unidades entraram (maior que zero).'); return; }
      this.saving = true; this.savingAction = 'stock-entry';
      try {
        const newQty = this.num(item.quantity_on_hand) + delta;
        await this._persistStockQuantity(item, newQty);
        this.closeStockEntry();
        this.flash(`Entrada de ${delta} un. registrada.`);
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally { this.saving = false; this.savingAction = ''; }
    },

    openStockAdjust(item) {
      if (!item || !item.is_tracked) return;
      this.stockOpItem = item;
      this.stockAdjustQty = this.num(item.quantity_on_hand);
      this.stockAdjustOpen = true;
    },
    closeStockAdjust() { this.stockAdjustOpen = false; this.stockOpItem = null; },

    async saveStockAdjust() {
      const item = this.stockOpItem;
      if (!item) return;
      if (this.stockAdjustQty === null || this.stockAdjustQty === '' || this.num(this.stockAdjustQty) < 0) {
        this.flash('Informe o novo saldo (zero ou mais).'); return;
      }
      this.saving = true; this.savingAction = 'stock-adjust';
      try {
        await this._persistStockQuantity(item, this.num(this.stockAdjustQty));
        this.closeStockAdjust();
        this.flash('Saldo ajustado.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally { this.saving = false; this.savingAction = ''; }
    },

    customerSales(customer) {
      if (!customer) return [];
      const cpf = this.cpfDigits(customer.cpf || '');
      const phone = String(customer.phone || '').replace(/\D/g, '');
      return (this.vendas || []).filter((sale) => {
        if (!this.isPhysicalExitSale(sale)) return false;
        const saleCpf = this.cpfDigits(sale.customer_cpf || '');
        const salePhone = String(sale.customer_phone || '').replace(/\D/g, '');
        return (customer.id && sale.customer_id === customer.id)
          || (!!cpf && saleCpf === cpf)
          || (!!phone && salePhone === phone);
      });
    },

    customerTotalSpent(customer) {
      return this.customerSales(customer).reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    customerAddressLine(customer) {
      const streetWithNumber = [customer?.address_street, customer?.address_number]
        .map((item) => String(item || '').trim()).filter(Boolean).join(', ');
      const parts = [
        streetWithNumber,
        customer?.address_neighborhood,
        customer?.address_city,
      ].map((item) => String(item || '').trim()).filter(Boolean);
      return parts.join(' - ') || customer?.address || '-';
    },

    customerLastSaleLabel(customer) {
      const sales = this.customerSales(customer);
      if (!sales.length) return 'sem venda vinculada';
      const latest = sales
        .slice()
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0];
      return this.formatDate(latest.created_at);
    },

    purchaseItemsLabel(purchase) {
      const items = Array.isArray(purchase.items) ? purchase.items : [];
      if (!items.length) return 'Itens da compra';
      return items.map((it) => `${it.quantity}x ${it.item_name}`).join(', ');
    },

    errMessage(err) {
      const raw = err instanceof Error ? err.message : String(err);
      const map = {
        customer_phone_conflict: 'Já existe um cliente com esse telefone.',
        customer_cpf_conflict: 'Já existe um cliente com esse CPF.',
        customer_not_found: 'Cliente não encontrado.',
        customer_name_required: 'Informe o nome do cliente.',
      };
      return map[raw] || raw;
    },

    flash(msg, kind) {
      // kind: 'success' | 'error' | 'neutral'. Heurística automática se omitido.
      this.statusMessage = msg;
      this.statusKind = kind || this.inferStatusKind(msg);
      if (this.statusTimer) clearTimeout(this.statusTimer);
      this.statusTimer = setTimeout(() => { this.statusMessage = ''; }, 3500);
    },

    inferStatusKind(msg) {
      const text = String(msg || '').toLowerCase();
      if (text.includes('insuficiente') || text.includes('erro') || text.includes('inválido')
          || text.includes('invalida') || text.includes('falha') || text.includes('not found')
          || text.includes('inativ') || text.includes('preencha') || text.includes('selecione')) {
        return 'error';
      }
      if (text.includes('registrada') || text.includes('salv') || text.includes('cancelad')
          || text.includes('atualiz') || text.includes('excluí')) {
        return 'success';
      }
      return 'neutral';
    },
  };
}
