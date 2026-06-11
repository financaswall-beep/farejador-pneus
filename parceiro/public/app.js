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

// ─── MONTAGEM DA OBRA ≤300 (plano §2) ─────────────────────────────────
// Junta o ESTADO + as fábricas de módulo (window.PARCEIRO_MODULES.*) num
// objeto SÓ — o mesmo `this` pra todo mundo, nenhum módulo tem estado próprio.
// Object.getOwnPropertyDescriptors preserva os getters VIVOS (reatividade).
// ⚠️ NUNCA trocar por spread ({ ...f() }): spread EXECUTA o getter e congela
// o valor — a tela para de reagir. Risco nº 1 da obra inteira.
// A ordem do array `fabricas` é a ordem de merge: DOCUMENTADA E FIXA.
function montarParceiroApp(estado, fabricas) {
  const out = estado;
  for (const f of fabricas) {
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(f()));
  }
  return out;
}

function parceiroApp() {
  const slug = location.pathname.split('/').filter(Boolean)[1] || '';
  const tokenKey = `farejador_partner_token_${slug}`;

  const estado = {
    // â”€â”€â”€ ESTADO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    slug,
    tokenKey,
    apiToken: localStorage.getItem(tokenKey) || '',
    tokenInput: '',              // P1: código de acesso (só no primeiro acesso do dono)
    loginMode: 'login',          // 'login' (usuário+senha) | 'firstAccess' (dono cola código)
    loginUsername: '',
    loginPassword: '',
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
    role: '',  // Etapa 4: 'owner' | 'funcionario' — vem de /api/me. Default vazio (não-dono) até resolver, pra não piscar menu proibido.
    // Mapa EFETIVO das 8 telas, resolvido no servidor (/api/me.permissions). Default
    // conservador (tudo false) até resolver — o menu só aparece depois do /api/me.
    permissions: { vendas: false, estoque: false, pedidos: false, clientes: false, entregas: false, retiradas: false, batepapo: false, resumo: false, financeiro: false },
    funcionarios: [],            // Etapa 4c: logins de funcionário (só o dono carrega)
    funcionarioForm: { label: '', username: '', password: '' },
    // ─── Configurações da Loja (Fase 1) ───
    configTab: 'loja',           // 'loja' | 'atendimento' | 'area' | 'equipe'
    configLoaded: false,
    lojaForm: { display_name: '', address_street: '', address_number: '', address_neighborhood: '', address_city: '', address_complement: '', cep: '', opening_hours_text: '', maps_url: '' },
    atendimentoForm: { faz_entrega: true, tem_retirada: true, delivery_radius_km: null },
    // Área de entrega: por município. Fase 1 edita 1 município por vez (o da loja).
    // Fase 3 (proximidade-primeiro): a aba Área encolheu pra só o MUNICÍPIO (plano B
    // de quando o cliente não manda localização) — a entrega é decidida pelo RAIO em km
    // (aba Atendimento). A parte de bairros saiu da UI (o raio aposentou).
    areaForm: { municipio: '' },
    coverageList: [],            // cobertura atual (lida do GET), só pra exibir o resumo
    // Permissões de tela do funcionário (toggles). 'config' NUNCA aparece aqui.
    permForm: { vendas: true, estoque: true, pedidos: true, clientes: true, entregas: true, retiradas: true, batepapo: true, resumo: false, financeiro: false },
    sidebarCollapsed: localStorage.getItem(`farejador_sidebar_collapsed_${slug}`) === '1',  // menu recolhido (só ícones), salvo neste aparelho
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
    chatSending: false, // trava de envio em andamento (sendChat nao aceita duplo clique)
    // ─── FOTO SOB DEMANDA (0094) ─ cards de pedido de foto + alerta global.
    //     O bot pede uma foto do pneu → card aparece AQUI (topo do Bate-papo) e
    //     o alerta toca em QUALQUER aba (banner + badge + título + bip).
    photoRequests: [],          // fila da unidade (pendentes + recentes)
    photoSending: {},           // { [id]: true } durante upload
    photoPreview: { id: null, dataUrl: null, blob: null }, // preview antes de enviar
    photoES: null,              // SSE GLOBAL (vive desde o login, não só na aba)
    photoPollTimer: null,       // rede de segurança (25s)
    photoTickTimer: null,       // tick de 1s pro countdown (só roda com card pendente)
    photoLastPendingCount: 0,   // detecta card NOVO → bip + flash
    audioUnlocked: false,       // política de autoplay: destrava no 1º toque
    photoSoundOn: localStorage.getItem(`farejador_photo_sound_${slug}`) !== '0', // bip ligado por padrão
    photoThumbUrls: {},         // cache { photo_request_id: objectURL } (img não manda Bearer → fetch+blob)
    photoLightbox: { open: false, url: null }, // foto ampliada (card de separação)
    // ─── BATE-PAPO (Tela 4): UI do painel direito ───
    chatPanelPedido: false,   // painel "Criar pedido" expandido? (acordeão exclusivo: começa fechado)
    chatPanelCliente: true,   // painel "Cliente" expandido? (contexto do atendimento — abre primeiro)
    chatTagMenu: false,       // seletor de etiquetas aberto?
    chatTags: {},             // { [conversationId]: ['orcamento', ...] } — LOCAL (Fase 1, nao persiste)
    chatTagPalette: [
      { id: 'orcamento', label: 'Orçamento', cls: 't-orcamento' },
      { id: 'pedido',    label: 'Pedido',    cls: 't-pedido' },
      { id: 'duvida',    label: 'Dúvida',    cls: 't-duvida' },
      { id: 'garantia',  label: 'Garantia',  cls: 't-garantia' },
      { id: 'retorno',   label: 'Retorno',   cls: 't-retorno' },
      { id: 'vip',       label: 'VIP',       cls: 't-vip' },
    ],
    chatCustomer: null,       // Fase 2a: cliente vinculado + métricas { linked, customer, metrics, last_orders } | { linked:false, suggestion }
    chatCustomerFormOpen: false, // cadastro inline do cliente na própria tela do chat
    chatCustomerSearch: '',       // busca de cliente JÁ cadastrado pra vincular
    chatCustomerSearchResults: [],
    chatCustomerSearchTimer: null,
    // Fase 2b: carrinho próprio do chat (separado do PDV do balcão)
    chatOrderCart: [],
    chatOrderProduct: '',
    chatOrderQty: 1,
    chatOrderPrice: 0,
    chatOrderAddress: '',
    // Entrega: filtro (em aberto x entregues) e rascunho do entregador por pedido.
    deliveryShowDone: false,
    deliveryDrafts: {},
    // Como o cliente pagou na entrega (COD), por pedido. Default Pix; vira o
    // metodo da conta a receber ao finalizar, pra o caixa registrar a forma.
    deliveryPayDrafts: {},
    // Retirada (pickup do bot): forma de pagamento recebida no balcão, por pedido.
    pickupPayDrafts: {},
    // Cancelar com motivo: qual pedido está com o form de cancelamento aberto + o texto.
    cancelOpenId: null,
    cancelReasonText: '',
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
    retiradas: [],   // tela Retiradas: feed próprio (pickup aguardando), guard requireScreen('retiradas')
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
    orderCustomerTimer: null, // debounce da busca de cliente (onOrderCustomerSearch)

    // Ordem da rota de entrega (aba Entrega). Salva neste aparelho, por unidade.
    routeOrder: [],
    stockForm: { stock_id: null, item_type: 'pneu', item_name: '', tire_width: null, tire_aspect: null, tire_rim: null, brand: '', supplier_name: '', quantity_on_hand: null, minimum_quantity: null, average_cost: null, sale_price: null, tire_condition: 'Novo', shelf_location: '', tire_position: '', is_tracked: true, product_id: null, catalog_name: null },
    // P1 (vínculo ao catálogo): estado da busca de produto pro robô achar o estoque.
    catalogQuery: '',
    catalogResults: [],
    catalogSearching: false,
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
    // Recolhe/expande o menu lateral (só ícones <-> completo). Libera largura pra tela.
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      try { localStorage.setItem(`farejador_sidebar_collapsed_${this.slug}`, this.sidebarCollapsed ? '1' : '0'); }
      catch (e) { /* localStorage indisponível: estado só nesta sessão */ }
      // largura do conteúdo mudou: re-renderiza ícones e gráficos pra reajustar.
      this.$nextTick(() => { lucide.createIcons(); requestAnimationFrame(() => this.renderAllCharts()); });
    },

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
        // Sessão pode ter expirado/sido revogada (validade de 30d). Se a carga
        // falhar com 401, volta pro login limpo em vez de travar numa tela vazia.
        this.$nextTick(async () => {
          try {
            await this.loadData();
            // Foto sob demanda: canal global (SSE + poll) vive desde já — o
            // alerta tem que tocar em QUALQUER aba, não só no Bate-papo.
            this.startPhotoGlobal();
          } catch (err) {
            if (err && err.status === 401) {
              this.apiToken = '';
              localStorage.removeItem(this.tokenKey);
              this.authed = false;
            }
          }
        });
      }

      // Política de autoplay: o PRIMEIRO toque/clique em qualquer lugar destrava
      // o áudio do bip de foto (sem isso o navegador bloqueia som programático).
      document.addEventListener('pointerdown', () => this.unlockAudio(), { once: true });

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
    // Guarda o token de SESSÃO (ps_…) emitido pelo login. É o que o navegador
    // manda como Bearer daqui pra frente (no lugar do código de acesso cru).
    applySession(token) {
      this.apiToken = token || '';
      if (token) localStorage.setItem(this.tokenKey, token);
    },

    // Login normal: usuário + senha → sessão.
    async login() {
      const username = (this.loginUsername || '').trim();
      const password = this.loginPassword || '';
      if (!username || !password) { this.loginError = 'Informe usuário e senha.'; return; }
      this.loading = true;
      this.loginError = '';
      try {
        const res = await fetch(`/parceiro/${this.slug}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          if (res.status === 429) this.loginError = 'Muitas tentativas. Espere alguns minutos e tente de novo.';
          else if (res.status === 401) this.loginError = 'Usuário ou senha incorretos.';
          else this.loginError = 'Não foi possível entrar agora. Tente de novo.';
          return;
        }
        const data = await res.json();
        this.applySession(data.session_token);
        await this.loadData();
        this.authed = true;
        this.loginPassword = '';
        this.unlockAudio();        // clique do Entrar = gesto que destrava o bip
        this.startPhotoGlobal();   // alerta de foto vive desde o login
      } catch (err) {
        this.loginError = this.errMessage(err);
        this.applySession('');
      } finally {
        this.loading = false;
      }
    },

    // Primeiro acesso do dono: cola o código de acesso (uma vez) e escolhe
    // usuário+senha. O backend define as credenciais e já devolve uma sessão.
    async firstAccess() {
      const token = (this.tokenInput || '').trim();
      const username = (this.loginUsername || '').trim();
      const password = this.loginPassword || '';
      if (!token) { this.loginError = 'Cole o código de acesso que você recebeu.'; return; }
      if (!username || password.length < 6) {
        this.loginError = 'Escolha um usuário e uma senha de pelo menos 6 caracteres.';
        return;
      }
      this.loading = true;
      this.loginError = '';
      try {
        const res = await fetch(`/parceiro/${this.slug}/api/set-credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ username, password }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          if (res.status === 429) this.loginError = 'Muitas tentativas. Espere alguns minutos e tente de novo.';
          else if (res.status === 401) this.loginError = 'Código de acesso inválido ou expirado.';
          else if (payload.error === 'username_taken') this.loginError = 'Esse usuário já existe. Escolha outro.';
          else if (payload.error === 'credentials_already_set') this.loginError = 'Esse login já tem senha. Entre com usuário e senha.';
          else this.loginError = 'Não foi possível concluir o primeiro acesso.';
          return;
        }
        const data = await res.json();
        this.applySession(data.session_token);
        await this.loadData();
        this.authed = true;
        this.loginPassword = '';
        this.tokenInput = '';
        this.loginMode = 'login';
        this.unlockAudio();
        this.startPhotoGlobal();
        this.flash('Pronto! Da próxima vez é só usuário e senha.');
      } catch (err) {
        this.loginError = this.errMessage(err);
      } finally {
        this.loading = false;
      }
    },

    async logout() {
      // Revoga a sessão no servidor (idempotente; código cru = no-op).
      try {
        await fetch(`/parceiro/${this.slug}/api/logout`, { method: 'POST', headers: this.apiHeaders(false) });
      } catch (e) { /* offline: o front limpa local mesmo assim */ }
      this.stopPhotoGlobal();
      this.photoRequests = [];
      this.apiToken = '';
      this.tokenInput = '';
      this.loginUsername = '';
      this.loginPassword = '';
      this.loginMode = 'login';
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
        // Etapa 4: descobre o papel ANTES de carregar. Funcionário não pode
        // bater nos endpoints de financeiro (403) — /api/me é liberado pros dois.
        const me = await this.api('me');
        this.role = me.role === 'owner' ? 'owner' : 'funcionario';
        // permissions efetivo vem do servidor (gate §5.5); guardamos pra pintar o menu.
        if (me.permissions && typeof me.permissions === 'object') {
          this.permissions = { ...this.permissions, ...me.permissions };
        }
        // Se cair logado numa seção que não pode ver, manda pra uma tela permitida.
        if (!this.canSee(this.currentSection) && !['config'].includes(this.currentSection)) {
          this.currentSection = this.canSee('vendas') ? 'vendas' : (this.firstAllowedSection() || 'vendas');
        }

        // Carrega cada feed só se a tela é permitida (canSee), e tolera falha
        // individual: com requireScreen no backend, um feed proibido devolve 403 —
        // não pode derrubar o resto da tela. produtos é feed de APOIO (não-tela),
        // sempre carrega. Helper: pega .rows e engole erro pra não travar loadData.
        const safeRows = async (path) => {
          try { return (await this.api(path)).rows || []; }
          catch (err) { console.warn(`${path}_unavailable`, err); return []; }
        };
        const safeRow = async (path) => {
          try { const r = await this.api(path); return (r.rows && r.rows[0]) || null; }
          catch (err) { console.warn(`${path}_unavailable`, err); return null; }
        };

        const [produtos, vendas, retiradas, estoque, clientes] = await Promise.all([
          safeRows('produtos'),
          this.canSee('vendas') ? safeRows('vendas') : Promise.resolve([]),
          // Tela Retiradas tem feed próprio (guard requireScreen('retiradas')): o balconista
          // que só vê Retiradas carrega a fila SEM precisar da permissão de vendas.
          this.canSee('retiradas') ? safeRows('retiradas') : Promise.resolve([]),
          this.canSee('estoque') ? safeRows('estoque') : Promise.resolve([]),
          this.canSee('clientes') ? safeRows('clientes') : Promise.resolve([]),
        ]);
        this.produtos = produtos;
        this.vendas = vendas;
        this.retiradas = retiradas;
        this.estoque = estoque;
        this.clientes = clientes;

        // Resumo (tela Resumo) e Financeiro (caixa/contas) seguem a permissão
        // efetiva — o dono PODE ter liberado ao funcionário (PLANO §2.3). O resumo
        // alimenta KPIs das DUAS telas, então carrega pra qualquer uma das duas.
        if (this.canSee('resumo') || this.canSee('financeiro')) {
          this.resumo = await safeRow('resumo');
        }
        if (this.canSee('financeiro')) {
          const [compras, despesas, payables, receivables, fluxo] = await Promise.all([
            safeRows('compras'),
            safeRows('despesas'),
            safeRows('contas-a-pagar'),
            safeRows('contas-a-receber'),
            safeRow('fluxo-caixa'),
          ]);
          this.compras = compras;
          this.despesas = despesas;
          this.payables = payables;
          this.receivables = receivables;
          this.fluxoCaixa = fluxo;
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
      return this.completedSales.filter((sale) => sale.customer_id || sale.customer_name || sale.customer_phone || sale.customer_cpf).length;
    },


    get salesTodayCount() {
      const today = this.dateKeySaoPaulo(new Date());
      return this.completedSales.filter((sale) => this.dateKeySaoPaulo(this.saleRealizedAt(sale)) === today).length;
    },

    get activeSales() {
      return this.vendas.filter((sale) => sale.status !== 'cancelled');
    },

    // Venda realizada: pickup/balcão conta na criação; delivery só depois de entregue.
    // Delivery aberto é reserva + a receber, não venda concluída.
    get completedSales() {
      return this.activeSales
        .filter((sale) => this.isPhysicalExitSale(sale))
        .sort((a, b) => new Date(this.saleRealizedAt(b) || 0).getTime() - new Date(this.saleRealizedAt(a) || 0).getTime());
    },

    get completedPartnerSales() {
      return this.completedSales.filter((sale) => this.normalizeSource(sale.source_tag || sale.source) === '2w');
    },

    get completedDoorSales() {
      return this.completedSales.filter((sale) => this.normalizeSource(sale.source_tag || sale.source) === 'porta');
    },

    get completedPartnerSalesTotal() {
      return this.completedPartnerSales.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    get completedDoorSalesTotal() {
      return this.completedDoorSales.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    get partnerSalesShareLabel() {
      const total = this.completedSales.length;
      if (!total) return 'sem vendas ainda';
      return `${Math.round((this.completedPartnerSales.length / total) * 100)}% das vendas`;
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
      const reason = prompt(`Marcar a entrega de ${who} como NÃO entregue?\n\nEscreva o motivo (o estoque volta e nada entra no caixa):`);
      if (reason === null) return; // cancelou o prompt
      if (this.isTwoW(sale) && !reason.trim()) { this.flash('Escreva o motivo (pedido da Rede 2W).'); return; }
      this.setDeliveryStatus(sale, 'failed', reason.trim());
    },

    async setDeliveryStatus(sale, status, reason) {
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
          body: JSON.stringify({ delivery_status: status, delivery_courier: courier || null, payment_method, reason: reason ?? null }),
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

    // ─── Retirada reservada do bot (pickup): tela Retiradas ───
    // Deriva do feed PRÓPRIO this.retiradas (GET /api/retiradas, já filtrado no
    // servidor pra pickup aguardando) — não de this.vendas — pra o balconista que
    // só tem permissão 'retiradas' ver a fila sem precisar de 'vendas'.
    get pickupAwaiting() {
      return this.retiradas.filter((o) => o.fulfillment_mode === 'pickup' && o.awaiting_pickup && o.status !== 'cancelled');
    },
    get pickupAwaitingCount() { return this.pickupAwaiting.length; },
    get pickupAwaitingAmount() { return this.pickupAwaiting.reduce((s, o) => s + this.num(o.total_amount), 0); },
    isTwoW(sale) { return this.normalizeSource(sale && (sale.source_tag || sale.source)) === '2w'; },

    async markRetrieved(sale) {
      if (!sale || !sale.order_id) return;
      const action = `retrieve-${sale.order_id}`;
      const payment_method = this.pickupPayDrafts[sale.order_id] || 'Pix';
      this.saving = true; this.savingAction = action;
      try {
        await this.api(`retiradas/${sale.order_id}`, { method: 'POST', body: JSON.stringify({ payment_method }) });
        await this.loadData();
        this.flash('Retirada finalizada — pneu baixado e dinheiro no caixa.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    // Cancelar retirada com motivo (ex.: cliente reservou e não veio). 2W exige motivo (anti-trapaça).
    // Usa o endpoint de RETIRADAS (não vendas) pra o balconista que só tem 'retiradas' poder cancelar.
    openCancelOrder(sale) { this.cancelOpenId = sale.order_id; this.cancelReasonText = ''; },
    closeCancelOrder() { this.cancelOpenId = null; this.cancelReasonText = ''; },
    async confirmCancelOrder(sale) {
      if (!sale || !sale.order_id) return;
      const reason = (this.cancelReasonText || '').trim();
      if (this.isTwoW(sale) && !reason) {
        this.flash('Escreva o motivo do cancelamento (pedido da Rede 2W).');
        return;
      }
      const action = `cancel-${sale.order_id}`;
      this.saving = true; this.savingAction = action;
      try {
        await this.api(`retiradas/${sale.order_id}`, { method: 'DELETE', body: JSON.stringify({ reason }) });
        await this.loadData();
        this.flash('Pedido cancelado — reserva liberada.');
        this.cancelOpenId = null; this.cancelReasonText = '';
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
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
        if (!this.isPhysicalExitSale(sale)) continue;
        const key = this.dateKeySaoPaulo(this.saleRealizedAt(sale));
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

    // â”€â”€â”€ NAVEGAÃ‡ÃƒO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    goToSection(id) {
      // Fase 1: Configurações segue só-dono (cadeado duro). Resumo/Financeiro e as
      // demais telas seguem a permissão efetiva (canSee). A trava real é o backend;
      // isto é só pra UI não ir pra uma tela vazia/proibida.
      if (id === 'config' && !this.isOwner) return;
      if (id !== 'config' && !this.canSee(id)) return;
      if (id === 'config') { this.loadConfiguracoes(); }
      if (id === 'pedidos') { this.resetOrderForm(); this.orderMobileStep = 'list'; }
      // Chat: liga o polling so quando a aba esta aberta; desliga ao sair (economiza requests).
      if (id === 'batepapo') this.startChatPolling();
      else this.stopChatPolling();
      // Abrir o chat recolhe o menu automaticamente pra dar espaço; o botão manual sempre manda.
      if (id === 'batepapo' && !this.sidebarCollapsed) {
        this.sidebarCollapsed = true;
        try { localStorage.setItem(`farejador_sidebar_collapsed_${this.slug}`, '1'); }
        catch (e) { /* localStorage indisponível */ }
      }
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
  };

  return montarParceiroApp(estado, [
    window.PARCEIRO_MODULES.format, // passo 1: máscaras/moeda/datas/deep-links/helpers
    window.PARCEIRO_MODULES.labels, // passo 2: rótulos/chips de status/toast/errMessage
    window.PARCEIRO_MODULES.chartsResumo, // passo 3: maestro renderAllCharts (F9: renders orfaos apagados)
    window.PARCEIRO_MODULES.chartsPdv, // passo 3: graficos da tela PDV (reagem ao tema)
    window.PARCEIRO_MODULES.foto, // passo 4: foto sob demanda (SSE global, countdown, upload, bip)
    window.PARCEIRO_MODULES.chat, // passo 5: nucleo do Bate-papo (SSE/poll, conversas, enviar)
    window.PARCEIRO_MODULES.chatCliente, // passo 5: cliente vinculado + carrinho do chat
    window.PARCEIRO_MODULES.config, // passo 6: isOwner/canSee + funcionarios + configuracoes da loja
    window.PARCEIRO_MODULES.estoqueKpis, // passo 7: KPIs/filtros/series de estoque + stockAvailable 0076
    window.PARCEIRO_MODULES.estoqueForms, // passo 7: form/inativar/catalogo + entrada/ajuste de saldo
    window.PARCEIRO_MODULES.pdvKpis, // passo 8: leitura do PDV (carrinho/caixa do dia/produtos/rotulos)
    window.PARCEIRO_MODULES.pdv, // passo 8: fluxo de vender (carrinho, checkout, finalizar, cancelar)
    window.PARCEIRO_MODULES.pdvClientes, // passo 8: cliente na venda (busca/cadastro/CRUD/VIP)
    window.PARCEIRO_MODULES.financeiroKpis, // passo 9: leitura do financeiro (custos/series/totais de contas)
    window.PARCEIRO_MODULES.financeiroScore, // passo 9: saude da loja (healthChecks + score 0-1000 do gauge)
    window.PARCEIRO_MODULES.financeiroCompras, // passo 9: compra de pneu + despesa direta
    window.PARCEIRO_MODULES.financeiroContas, // passo 9: conta a PAGAR (criar/editar/quitar/cancelar)
    window.PARCEIRO_MODULES.financeiroReceber, // passo 9: conta a RECEBER (criar/editar/receber/cancelar)
  ]);
}
