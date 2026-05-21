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
    savingAction: '',
    loginError: '',
    statusMessage: '',
    statusKind: 'neutral',  // 'success' | 'error' | 'neutral' — define cor do toast
    statusTimer: null,
    lastUpdatedAt: null,
    currentSection: 'resumo',
    currentTab: 'sale',

    resumo: null,
    vendas: [],
    estoque: [],
    compras: [],
    despesas: [],
    produtos: [],

    saleForm: { customer_name: '', customer_phone: '', source_tag: 'porta', partner_stock_id: '', quantity: 1, unit_price: 0, payment_method: 'Pix', fulfillment_mode: 'pickup', delivery_address: '' },
    stockForm: { stock_id: null, item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', supplier_name: '', quantity_on_hand: null, minimum_quantity: null, average_cost: null, sale_price: null, is_tracked: true },
    purchaseForm: { supplier_name: '', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', quantity: 1, unit_cost: 0, sale_price: null },
    expenseForm: { category: 'employee_payment', description: '', amount: 0 },

    menu: [
      { id: 'resumo',     label: 'Resumo',        icon: 'layout-dashboard' },
      { id: 'vendas',     label: 'Vendas',         icon: 'receipt' },
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
    init() {
      this.$nextTick(() => lucide.createIcons());
      if (this.apiToken) {
        this.authed = true;
        this.$nextTick(() => this.loadData());
      }

      // re-render charts on resize (debounced)
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (this.authed) this.renderAllCharts(); }, 160);
      });
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
        throw new Error(payload.error || `api_${response.status}`);
      }
      return response.json();
    },

    async loadData() {
      if (!this.apiToken) return;
      this.loading = true;
      try {
        const [resumo, vendas, estoque, compras, despesas, produtos] = await Promise.all([
          this.api('resumo'),
          this.api('vendas'),
          this.api('estoque'),
          this.api('compras'),
          this.api('despesas'),
          this.api('produtos'),
        ]);
        this.resumo = (resumo.rows && resumo.rows[0]) || null;
        this.vendas = vendas.rows || [];
        this.estoque = estoque.rows || [];
        this.compras = compras.rows || [];
        this.despesas = despesas.rows || [];
        this.produtos = produtos.rows || [];
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

    get totalCusts() {
      return this.num(this.resumo?.purchases_month) + this.num(this.resumo?.expenses_month);
    },

    get salesTodayCount() {
      const today = new Date().toISOString().slice(0, 10);
      return this.vendas.filter((sale) => String(sale.created_at || '').slice(0, 10) === today && sale.status !== 'cancelled').length;
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

    get salesSeries7d() {
      const days = [];
      const now = new Date();
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push({
          key: d.toISOString().slice(0, 10),
          label: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
          value: 0,
        });
      }
      for (const sale of this.vendas) {
        if (sale.status === 'cancelled') continue;
        const key = String(sale.created_at || '').slice(0, 10);
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

    get saleTotalLabel() {
      return this.money(this.num(this.saleForm.quantity) * this.num(this.saleForm.unit_price));
    },

    get purchaseTotalLabel() {
      return this.money(this.num(this.purchaseForm.quantity) * this.num(this.purchaseForm.unit_cost));
    },

    get financeCostSplit() {
      return [
        { label: 'Compras', value: this.num(this.resumo?.purchases_month), color: '#f59e0b' },
        { label: 'Despesas', value: this.num(this.resumo?.expenses_month), color: '#ef4444' },
      ];
    },

    get currentSectionMeta() {
      const meta = {
        resumo: {
          title: 'Resumo',
          subtitle: 'Vis\u00e3o geral da opera\u00e7\u00e3o local',
        },
        vendas: {
          title: 'Vendas',
          subtitle: 'Registrar venda e acompanhar pedidos',
        },
        estoque: {
          title: 'Estoque',
          subtitle: 'Cadastrar pneus e controlar saldo local',
        },
        financeiro: {
          title: 'Financeiro',
          subtitle: 'Compras, despesas e resultado simples',
        },
      };
      return meta[this.currentSection] || meta.resumo;
    },

    // â”€â”€â”€ NAVEGAÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    goToSection(id) {
      this.currentSection = id;
      if (id === 'vendas') this.currentTab = 'sale';
      if (id === 'estoque') this.currentTab = 'stock';
      if (id === 'financeiro') this.currentTab = 'purchase';
      this.$nextTick(() => {
        const main = document.getElementById('partner-main');
        if (main) main.scrollTo({ top: 0, behavior: 'auto' });
        lucide.createIcons();
        requestAnimationFrame(() => this.renderAllCharts());
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
      const qtyLabel = item.is_tracked
        ? `${item.quantity_on_hand ?? 0} un.`
        : 'sem controle';
      parts.push(qtyLabel);
      return parts.join(' - ');
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
      this.saving = true;
      this.savingAction = 'sale';
      try {
        const body = {
          customer_name: this.saleForm.customer_name.trim() || null,
          // Telefone vai pro banco em E.164 (+5521...). Estado local guarda sÃ³ dÃ­gitos.
          customer_phone: this.toE164Phone(this.saleForm.customer_phone),
          items: [{
            // Aponta direto pro estoque local do parceiro â€” sem catÃ¡logo da matriz.
            partner_stock_id: this.saleForm.partner_stock_id,
            quantity: this.num(this.saleForm.quantity) || 1,
            unit_price: this.num(this.saleForm.unit_price) || 0,
          }],
          payment_method: this.saleForm.payment_method,
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
          customer_name: '', customer_phone: '', partner_stock_id: '',
          source_tag: this.saleForm.source_tag || 'porta',
          quantity: 1, unit_price: 0,
          payment_method: this.saleForm.payment_method,
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
        is_tracked: Boolean(item.is_tracked),
      };
      this.currentTab = 'stock';
      this.goToSection('estoque');
    },

    clearStockForm() {
      this.stockForm = { stock_id: null, item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', supplier_name: '', quantity_on_hand: null, minimum_quantity: null, average_cost: null, sale_price: null, is_tracked: true };
    },

    async saveStock() {
      if (!this.stockForm.item_name.trim()) { this.flash('Nome do item é obrigatório.'); return; }

      // ValidaÃ§Ã£o da medida: ou estÃ¡ toda preenchida, ou totalmente vazia.
      const tireParts = [this.stockForm.tire_width, this.stockForm.tire_aspect, this.stockForm.tire_rim];
      const filledCount = tireParts.filter((v) => v !== null && v !== '' && Number(v) > 0).length;
      if (filledCount > 0 && filledCount < 3) {
        this.flash('Preencha largura, perfil e aro completos, ou deixe os três vazios.');
        return;
      }
      const tireSize = filledCount === 3 ? this.composeTireSize(this.stockForm.tire_width, this.stockForm.tire_aspect, this.stockForm.tire_rim) : null;

      this.saving = true;
      this.savingAction = 'stock';
      try {
        await this.api('estoque', {
          method: 'POST',
          body: JSON.stringify({
            stock_id: this.stockForm.stock_id || null,
            item_name: this.stockForm.item_name.trim(),
            tire_size: tireSize,
            // DimensÃµes separadas (migration 0038) â€” banco indexa pra busca rÃ¡pida
            tire_width_mm: tireSize ? this.num(this.stockForm.tire_width) : null,
            tire_aspect_ratio: tireSize ? this.num(this.stockForm.tire_aspect) : null,
            tire_rim_diameter: tireSize ? this.num(this.stockForm.tire_rim) : null,
            brand: this.stockForm.brand?.trim() || null,
            supplier_name: this.stockForm.supplier_name?.trim() || null,
            quantity_on_hand: this.stockForm.is_tracked ? this.num(this.stockForm.quantity_on_hand) : null,
            minimum_quantity: this.stockForm.minimum_quantity !== null && this.stockForm.minimum_quantity !== '' ? this.num(this.stockForm.minimum_quantity) : null,
            average_cost: this.stockForm.average_cost !== null && this.stockForm.average_cost !== '' ? this.num(this.stockForm.average_cost) : null,
            sale_price: this.stockForm.sale_price !== null && this.stockForm.sale_price !== '' ? this.num(this.stockForm.sale_price) : null,
            is_tracked: this.stockForm.is_tracked,
          }),
        });
        this.clearStockForm();
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
      this.saving = true;
      this.savingAction = 'purchase';
      try {
        await this.api('compras', {
          method: 'POST',
          body: JSON.stringify({
            supplier_name: this.purchaseForm.supplier_name.trim() || null,
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
        this.purchaseForm = { supplier_name: '', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', quantity: 1, unit_cost: 0, sale_price: null };
        await this.loadData();
        this.flash('Compra registrada e estoque atualizado.');
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

    // â”€â”€â”€ CHARTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    renderAllCharts() {
      this.renderSalesTrendChart();
      this.renderResultChart();
      this.renderStockChart();
      this.renderFinanceBarChart();
      this.renderFinanceSplitChart();
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
            backgroundColor: ['#2563eb', '#f59e0b', '#ef4444', result >= 0 ? '#10b981' : '#e11d48'],
            borderRadius: 6,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => this.money(ctx.parsed.y) } },
          },
          scales: {
            x: { grid: { display: false } },
            y: { grid: { color: '#f3f4f6' }, ticks: { callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') } },
          },
        },
      });
    },

    renderFinanceSplitChart() {
      const ctx = document.getElementById('chartFinanceSplit');
      if (!ctx) return;
      if (window._financeSplitChart) window._financeSplitChart.destroy();

      const split = this.financeCostSplit;
      window._financeSplitChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: split.map((item) => item.label),
          datasets: [{
            data: split.map((item) => item.value),
            backgroundColor: split.map((item) => item.color),
            borderWidth: 0,
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '62%',
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 10, padding: 12 } },
            tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${this.money(ctx.parsed)}` } },
          },
        },
      });
    },

    // â”€â”€â”€ MÃSCARAS / FORMATAÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Telefone: estado guarda apenas dÃ­gitos (max 11). Display Ã© (DD) 9XXXX-XXXX.
    // No submit, vai normalizado pra E.164 (+55DDXXXXXXXXX) via toE164Phone().
    onPhoneInput(value) {
      return String(value || '').replace(/\D/g, '').slice(0, 11);
    },

    formatPhoneDisplay(rawDigits) {
      const d = String(rawDigits || '').replace(/\D/g, '');
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
        other: 'Outra',
      };
      return map[category] || category || 'Despesa';
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
        out_of_stock: 'bg-rose-50 text-rose-700',
        not_tracked: 'bg-gray-100 text-gray-600',
        unknown: 'bg-gray-100 text-gray-500',
      };
      return map[status] || 'bg-gray-100 text-gray-600';
    },

    purchaseItemsLabel(purchase) {
      const items = Array.isArray(purchase.items) ? purchase.items : [];
      if (!items.length) return 'Itens da compra';
      return items.map((it) => `${it.quantity}x ${it.item_name}`).join(', ');
    },

    errMessage(err) {
      if (err instanceof Error) return err.message;
      return String(err);
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

