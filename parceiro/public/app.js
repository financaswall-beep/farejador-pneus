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
    unitName: '',     // nome da loja logada (de /api/me) — mostrado no topo p/ saber em qual unidade se está (porta única 0095)
    partnerName: '',  // nome do parceiro (de /api/me) — 2ª linha do topo quando difere do nome da loja
    // Mapa EFETIVO das 8 telas, resolvido no servidor (/api/me.permissions). Default
    // conservador (tudo false) até resolver — o menu só aparece depois do /api/me.
    permissions: { vendas: false, estoque: false, pedidos: false, clientes: false, entregas: false, retiradas: false, batepapo: false, resumo: false, financeiro: false },
    funcionarios: [],            // Etapa 4c: logins de funcionário (só o dono carrega)
    funcionarioForm: { label: '', username: '', password: '' },
    selectedFuncionario: null,   // Bloco 1: funcionário aberto no painel da Equipe (null = mostra "adicionar")
    resetSenhaValue: '',         // Bloco 1: senha nova digitada no painel (sem prompt do navegador)
    revokeConfirmId: null,       // Bloco 1: id do funcionário aguardando confirmação inline de desativar
    // ─── Bloco 2 (2026-06-12): acesso + comissão POR PESSOA do funcionário aberto ───
    funcConfigLoaded: false,     // o config (telas+comissão) do funcionário selecionado carregou?
    funcPermForm: { vendas: true, estoque: true, pedidos: true, clientes: true, entregas: true, retiradas: true, batepapo: true, resumo: false, financeiro: false },
    funcCommForm: { kind: 'percent', value: 0, active: false }, // kind 'percent'(% por venda) | 'fixed'(R$ por venda)
    // ─── Bloco 2 telas #2/#3 (2026-06-12) ───
    selfName: '',                // nome do login atual (chip do topo) — vem de /api/me display_name
    commissionTeam: { rows: [], total_commission: 0 }, // #2 card "Comissão da equipe" (dono, Financeiro)
    perfOpen: false,             // #3 modal "Meu desempenho" aberto?
    perf: null,                  // dados do "Meu desempenho" (self); null = carregando
    // ─── Configurações da Loja (Fase 1) ───
    // Bloco 1 (2026-06-12): a aba 'area' morreu — o município virou parte de 'atendimento'.
    configTab: 'loja',           // 'loja' | 'atendimento' | 'equipe'
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
    photoSoundOn: true,         // alerta sonoro SEMPRE ligado (sem mute — pedido de foto não pode passar batido)
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

    // ─── RELATÓRIOS (0108): só dono. Histórico de vendas por período; mostra TUDO
    //     (inclusive arquivado, com desarquivar). É o backstop "puxar relatório".
    relRange: 'mes',     // 'hoje' | 'semana' | 'mes' | 'mes_passado' | 'custom'
    relStatus: 'todos',  // 'ativos' | 'cancelados' | 'todos'
    relFrom: '',         // custom (yyyy-mm-dd)
    relTo: '',
    relRows: [],
    relLoading: false,
    relView: 'vendas',     // sub-aba: 'vendas' | 'pneus' | 'caixa'
    relPneusRows: [],      // ranking pneu mais vendido (período)
    relPneusLoading: false,
    relCaixa: null,        // { entrou, saiu, saldo, vendas_total, vendas_count, despesas_total, compras_total }
    relCaixaLoading: false,

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
    window.PARCEIRO_MODULES.configEquipe, // passo 6: Bloco 2 — acesso + comissão POR PESSOA (drawer Equipe)
    window.PARCEIRO_MODULES.comissao, // passo 6: Bloco 2 telas #2/#3 — Comissão da equipe (dono) + Meu desempenho (chip)
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
    window.PARCEIRO_MODULES.core, // passo 10: init/api/loadData/navegacao (o encanamento)
    window.PARCEIRO_MODULES.auth, // passo 10: login/firstAccess/logout/applySession (sessao)
    window.PARCEIRO_MODULES.resumo, // passo 10: derivadas do Resumo (vendas concluidas, serie 7d)
    window.PARCEIRO_MODULES.pedidos, // passo 10: aba Pedidos (criacao/filtros) + status de entrega
    window.PARCEIRO_MODULES.entregas, // passo 10: tela Entrega (rota) + tela Retiradas (pickup)
    window.PARCEIRO_MODULES.arquivar, // passo 11 (0108): "tirar da tela" (arquivar) — some da lista, fica no Relatório
    window.PARCEIRO_MODULES.relatorios, // passo 12 (0108): aba Relatórios (só dono) — histórico + desarquivar
  ]);
}
