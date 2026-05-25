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
    apiToken: localStorage.getItem('farejador_admin_token') || '',
    operatorLabel: localStorage.getItem('farejador_operator_label') || 'Wallace',
    apiStatus: 'mock',
    apiError: null,
    serverEnvironment: null,
    chatwootBaseUrl: null,
    chatwootAccountId: null,
    agentV2WorkerEnabled: null,
    shadowSelectedIndex: 0,
    selectedParceiroIndex: 0,
    unidadeTab: 'visao',
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
    shadowLastLoadedAt: null,
    shadowRefreshing: false,
    shadowAutoRefreshId: null,

    // ─── MENUS ──────────────────────────────────────
    liveMenu: [
      { id: 'resumo',   label: 'Resumo',       icon: 'layout-dashboard' },
      { id: 'operacao', label: 'Operação',     icon: 'message-circle', badge: '3' },
      { id: 'pedidos',  label: 'Pedidos',      icon: 'shopping-bag' },
      { id: 'rede',     label: 'Rede',         icon: 'network', badge: '6' },
      { id: 'shadow',   label: 'Bot / Shadow', icon: 'bot', badge: '125' },
    ],

    futureMenu: [
      { id: 'financeiro',   label: 'Financeiro',    icon: 'wallet' },
      { id: 'estoque',      label: 'Estoque',       icon: 'package' },
      { id: 'logistica',    label: 'Logística',     icon: 'truck' },
      { id: 'colaboradores',label: 'Colaboradores', icon: 'users' },
      { id: 'catalogo',     label: 'Catálogo',      icon: 'tag' },
      { id: 'compras',      label: 'Compras',       icon: 'shopping-cart' },
      { id: 'relatorios',   label: 'Relatórios',    icon: 'bar-chart-3' },
    ],

    // ─── FILTROS DE TEMPO ───────────────────────────
    timeFilters: [
      { id: 'hoje',    label: 'Hoje' },
      { id: 'semana',  label: 'Última semana' },
      { id: 'mes',     label: 'Último mês' },
      { id: 'ano',     label: 'Último ano' },
    ],

    // ─── MOCK: Notificações ─────────────────────────
    notificacoes: [
      {
        title: 'Draft pronto · aguardando confirmação',
        desc: 'João Silva · 1× Levorin 90/90-18 · R$ 180 · Pix',
        time: 'há 2 min',
        icon: 'receipt',
        iconBg: 'bg-orange-100',
        iconColor: 'text-brand-600',
        read: false
      },
      {
        title: 'Bot bloqueado pelo validador',
        desc: 'SayValidator rejeitou preço abaixo do mínimo na conversa #c2e0',
        time: 'há 5 min',
        icon: 'shield-alert',
        iconBg: 'bg-rose-100',
        iconColor: 'text-rose-600',
        read: false
      },
      {
        title: 'Cliente aguardando há 12 min',
        desc: 'Maria Costa · WhatsApp · sem resposta humana',
        time: 'há 12 min',
        icon: 'clock',
        iconBg: 'bg-amber-100',
        iconColor: 'text-amber-700',
        read: false
      },
      {
        title: 'Nova escalação humana',
        desc: 'Ana Lima pediu pra falar com um humano',
        time: 'há 18 min',
        icon: 'arrow-up-right',
        iconBg: 'bg-blue-100',
        iconColor: 'text-blue-700',
        read: false
      },
      {
        title: 'Estoque baixo',
        desc: 'Pirelli 100/80-18 · apenas 3 unidades em estoque',
        time: 'há 28 min',
        icon: 'package',
        iconBg: 'bg-amber-100',
        iconColor: 'text-amber-700',
        read: false
      },
      {
        title: 'Venda registrada',
        desc: 'Carlos R. · 2× Michelin 180/55-17 · R$ 1.420 · Cartão',
        time: 'há 32 min · Wallace',
        icon: 'check-circle-2',
        iconBg: 'bg-emerald-100',
        iconColor: 'text-emerald-700',
        read: true
      },
      {
        title: 'Incidente do bot · severidade média',
        desc: 'Validator bloqueou bot 5x na última hora',
        time: 'há 1h',
        icon: 'alert-triangle',
        iconBg: 'bg-rose-100',
        iconColor: 'text-rose-600',
        read: true
      },
      {
        title: 'Pedido cancelado',
        desc: '#42 · Ana Lima · motivo: cliente desistiu',
        time: 'há 1h15',
        icon: 'x-circle',
        iconBg: 'bg-gray-100',
        iconColor: 'text-gray-600',
        read: true
      },
    ],

    // ─── MOCK: KPIs ─────────────────────────────────
    kpis: [
      {
        label: 'Faturamento',
        value: 'R$ 121.920',
        delta: '+21,20%',
        deltaClass: 'bg-emerald-50 text-emerald-700',
        icon: 'trending-up',
        iconBg: 'bg-emerald-100',
        iconColor: 'text-emerald-700'
      },
      {
        label: 'Pedidos',
        value: '89',
        delta: '+12',
        deltaClass: 'bg-purple-50 text-purple-700',
        icon: 'shopping-bag',
        iconBg: 'bg-purple-100',
        iconColor: 'text-purple-700'
      },
      {
        label: 'Clientes',
        value: '127',
        delta: '+18',
        deltaClass: 'bg-blue-50 text-blue-700',
        icon: 'users',
        iconBg: 'bg-blue-100',
        iconColor: 'text-blue-700'
      },
      {
        label: 'Conversas',
        value: '412',
        delta: '+18%',
        deltaClass: 'bg-amber-50 text-amber-700',
        icon: 'message-circle',
        iconBg: 'bg-amber-100',
        iconColor: 'text-amber-700'
      },
    ],

    // ─── MOCK: Últimas vendas ───────────────────────
    ultimasVendas: [
      {
        nome: 'João Silva', initial: 'J', avatarBg: 'bg-gradient-to-br from-orange-400 to-orange-600',
        local: 'Rio do Ouro', itens: '1× Levorin 90/90-18',
        tag: 'Recorrente', tagClass: 'bg-emerald-50 text-emerald-700',
        valor: '+R$ 180,00', delta: '+7,5%', deltaClass: 'text-emerald-600'
      },
      {
        nome: 'Maria Costa', initial: 'M', avatarBg: 'bg-gradient-to-br from-pink-400 to-pink-600',
        local: 'Niterói', itens: '2× Pirelli 110/80-17',
        tag: 'Novo cliente', tagClass: 'bg-blue-50 text-blue-700',
        valor: '+R$ 720,00', delta: '+22,5%', deltaClass: 'text-emerald-600'
      },
      {
        nome: 'Pedro Santos', initial: 'P', avatarBg: 'bg-gradient-to-br from-indigo-400 to-indigo-600',
        local: 'São Gonçalo', itens: '1× Pirelli 130/90-16',
        tag: 'Recorrente', tagClass: 'bg-emerald-50 text-emerald-700',
        valor: '+R$ 380,00', delta: '+8,21%', deltaClass: 'text-emerald-600'
      },
      {
        nome: 'Carlos Rodrigues', initial: 'C', avatarBg: 'bg-gradient-to-br from-teal-400 to-teal-600',
        local: 'Centro', itens: '2× Michelin 180/55-17',
        tag: 'VIP', tagClass: 'bg-amber-50 text-amber-700',
        valor: '+R$ 1.420,00', delta: '+34,12%', deltaClass: 'text-emerald-600'
      },
      {
        nome: 'Ana Lima', initial: 'A', avatarBg: 'bg-gradient-to-br from-rose-400 to-rose-600',
        local: 'Madureira', itens: '1× Levorin 140/70-17',
        tag: 'Cancelado', tagClass: 'bg-rose-50 text-rose-700',
        valor: '−R$ 250,00', delta: '−100%', deltaClass: 'text-rose-600'
      },
    ],

    // ─── MOCK: Conversas ativas ─────────────────────
    conversasAtivas: [
      {
        name: 'João Silva', initial: 'J',
        avatarBg: 'bg-gradient-to-br from-orange-400 to-orange-600',
        channel: 'WhatsApp', channelClass: 'bg-emerald-50 text-emerald-700',
        ago: '2min', lastMsg: 'pode fechar, é Pix mesmo',
        slots: [
          { k: 'moto', v: 'Fan 160' },
          { k: 'medida', v: '90/90-18' },
          { k: 'posição', v: 'traseiro' },
          { k: 'pagto', v: 'Pix' },
          { k: 'bairro', v: 'Rio do Ouro' },
        ],
        phone: '+55 21 99999-1234',
        draft: '1× Levorin 90/90-18 · R$ 180 · Pix · Entrega Rio do Ouro'
      },
      {
        name: 'Maria Costa', initial: 'M',
        avatarBg: 'bg-gradient-to-br from-pink-400 to-pink-600',
        channel: 'Instagram', channelClass: 'bg-pink-50 text-pink-700',
        ago: '8min', lastMsg: 'tem 100/80 pra Titan?',
        slots: [
          { k: 'moto', v: 'Titan' },
          { k: 'medida', v: '100/80-17' },
        ],
        phone: '@mariacosta',
        draft: null
      },
      {
        name: 'Pedro Santos', initial: 'P',
        avatarBg: 'bg-gradient-to-br from-indigo-400 to-indigo-600',
        channel: 'WhatsApp', channelClass: 'bg-emerald-50 text-emerald-700',
        ago: '14min', lastMsg: 'qual o preço pra par no Twister?',
        slots: [
          { k: 'moto', v: 'Twister' },
          { k: 'medida', v: '110/70-17 + 140/70-17' },
          { k: 'qtd', v: '2 pneus' },
        ],
        phone: '+55 21 98888-5678',
        draft: '1× Pirelli 110/70-17 + 1× Pirelli 140/70-17 · R$ 720 · ?'
      },
    ],

    // ─── MOCK: Pedidos ──────────────────────────────
    pedidos: [
      { data: '18/05 14:32', cliente: 'João Silva',   itens: '1× Levorin 90/90-18',           pagto: 'Pix',      operador: 'Wallace', total: 'R$ 180',   status: 'Confirmado', statusClass: 'bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
      { data: '18/05 11:15', cliente: 'Maria Costa',  itens: '2× Pirelli 110/80-17',          pagto: 'Cartão',   operador: 'Wallace', total: 'R$ 720',   status: 'Confirmado', statusClass: 'bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
      { data: '17/05 18:42', cliente: 'Pedro Santos', itens: '1× Pirelli 130/90-16',          pagto: 'Pix',      operador: 'Wallace', total: 'R$ 380',   status: 'Confirmado', statusClass: 'bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
      { data: '17/05 16:01', cliente: 'Ana Lima',     itens: '1× Levorin 140/70-17',          pagto: 'Pix',      operador: 'Wallace', total: 'R$ 250',   status: 'Cancelado',  statusClass: 'bg-rose-50 text-rose-700',       dotClass: 'bg-rose-500' },
      { data: '17/05 12:48', cliente: 'Carlos R.',    itens: '2× Michelin 180/55-17',         pagto: 'Cartão',   operador: 'Wallace', total: 'R$ 1.420', status: 'Confirmado', statusClass: 'bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
      { data: '17/05 10:22', cliente: 'Bruno F.',     itens: '1× Levorin 100/80-18 + serviço',pagto: 'Dinheiro', operador: 'Wallace', total: 'R$ 240',   status: 'Confirmado', statusClass: 'bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
      { data: '16/05 19:14', cliente: 'Felipe S.',    itens: '1× Pirelli 150/60-17',          pagto: 'Pix',      operador: 'Wallace', total: 'R$ 410',   status: 'Confirmado', statusClass: 'bg-emerald-50 text-emerald-700', dotClass: 'bg-emerald-500' },
    ],

    produtos: [],

    redeKpis: [
      { label: 'Parceiros ativos', value: '6', detail: '2 em credenciamento', icon: 'building-2', tone: 'bg-blue-50 text-blue-700' },
      { label: 'Vendas da rede', value: 'R$ 18.430', detail: 'últimos 7 dias', icon: 'trending-up', tone: 'bg-emerald-50 text-emerald-700' },
      { label: 'SKUs cadastrados', value: '214', detail: 'somando estoques locais', icon: 'package', tone: 'bg-amber-50 text-amber-700' },
      { label: 'Alertas operacionais', value: '9', detail: 'estoque baixo ou sem venda', icon: 'alert-triangle', tone: 'bg-rose-50 text-rose-700' },
    ],

    parceirosRede: [
      {
        nome: 'Borracharia Rio do Ouro',
        documento: '12.345.678/0001-90',
        responsavel: 'Carlos',
        whatsapp: '+55 21 98888-0101',
        endereco: 'Estrada do Rio do Ouro, 1200 - São Gonçalo/RJ',
        modeloComercial: 'Credenciado · comissão por venda',
        comissao: '8%',
        cidade: 'São Gonçalo',
        status: 'Ativo',
        vendas: 'R$ 4.820',
        vendasValor: 4820,
        pedidos: 31,
        ticket: 'R$ 155',
        estoque: '43 SKUs',
        estoqueBaixo: 3,
        margem: '28%',
        comprasPneus: 2710,
        folha: 1280,
        despesasExtras: 420,
        lucroEstimado: 410,
        alerta: '3 baixos',
        serieVendas: [420, 610, 540, 790, 880, 720, 860],
        seriePedidos: [3, 4, 3, 6, 7, 4, 4],
        topPneus: ['90/90-18', '100/80-18', '110/70-17'],
        estoqueItens: [
          { pneu: '90/90-18 traseiro', qtd: 4, minimo: 6, ultimaCompra: '14/05', fornecedor: 'Rinaldi', custoMedio: 'R$ 92', custo: 'R$ 92', venda: 'R$ 155', margem: '41%', status: 'baixo' },
          { pneu: '100/80-18 traseiro', qtd: 11, minimo: 5, ultimaCompra: '12/05', fornecedor: 'Levorin', custoMedio: 'R$ 108', custo: 'R$ 108', venda: 'R$ 180', margem: '40%', status: 'ok' },
          { pneu: '110/70-17 dianteiro', qtd: 7, minimo: 4, ultimaCompra: '10/05', fornecedor: 'Pirelli', custoMedio: 'R$ 120', custo: 'R$ 120', venda: 'R$ 210', margem: '43%', status: 'ok' },
          { pneu: '80/100-18 dianteiro', qtd: null, minimo: null, ultimaCompra: '-', fornecedor: '-', custoMedio: '-', custo: '-', venda: '-', margem: '-', status: 'não controlado' },
        ],
        equipe: ['Carlos', 'João'],
        diasSemAtualizar: 1,
        lancamentos: [
          { tipo: 'Venda', data: 'Hoje 15:20', descricao: '90/90-18 traseiro · Pix', valor: 155 },
          { tipo: 'Compra pneus', data: 'Ontem 10:14', descricao: 'Reposição 90/90-18 · 10 un.', valor: -920 },
          { tipo: 'Pagamento funcionário', data: '17/05', descricao: 'Diária João', valor: -180 },
          { tipo: 'Despesa extra', data: '16/05', descricao: 'Conserto compressor', valor: -240 },
        ],
        custosRecentes: [
          { label: 'Compra pneus', value: 'R$ 2.710' },
          { label: 'Funcionários', value: 'R$ 1.280' },
          { label: 'Despesas extras', value: 'R$ 420' },
        ],
      },
      {
        nome: 'Pneus Alcântara',
        documento: '23.456.789/0001-10',
        responsavel: 'Renata',
        whatsapp: '+55 21 97777-0202',
        endereco: 'Rua João Caetano, 88 - Alcântara, São Gonçalo/RJ',
        modeloComercial: 'Credenciado · mensalidade + comissão',
        comissao: '6%',
        cidade: 'São Gonçalo',
        status: 'Ativo',
        vendas: 'R$ 3.260',
        vendasValor: 3260,
        pedidos: 19,
        ticket: 'R$ 172',
        estoque: '31 SKUs',
        estoqueBaixo: 0,
        margem: '24%',
        comprasPneus: 1840,
        folha: 980,
        despesasExtras: 260,
        lucroEstimado: 180,
        alerta: 'ok',
        serieVendas: [280, 320, 410, 520, 480, 610, 640],
        seriePedidos: [2, 2, 3, 4, 3, 3, 2],
        topPneus: ['100/80-18', '80/100-18', '2.75-18'],
        estoqueItens: [
          { pneu: '100/80-18 traseiro', qtd: 8, minimo: 4, ultimaCompra: '15/05', fornecedor: 'Levorin', custoMedio: 'R$ 104', custo: 'R$ 104', venda: 'R$ 175', margem: '41%', status: 'ok' },
          { pneu: '80/100-18 dianteiro', qtd: 6, minimo: 4, ultimaCompra: '13/05', fornecedor: 'Rinaldi', custoMedio: 'R$ 88', custo: 'R$ 88', venda: 'R$ 150', margem: '41%', status: 'ok' },
          { pneu: '2.75-18 dianteiro', qtd: 5, minimo: 3, ultimaCompra: '09/05', fornecedor: 'Technic', custoMedio: 'R$ 72', custo: 'R$ 72', venda: 'R$ 130', margem: '45%', status: 'ok' },
        ],
        equipe: ['Renata'],
        diasSemAtualizar: 0,
        lancamentos: [
          { tipo: 'Venda', data: 'Hoje 12:11', descricao: '100/80-18 traseiro', valor: 175 },
          { tipo: 'Ajuste estoque', data: 'Hoje 09:40', descricao: 'Conferência balcão', valor: 0 },
          { tipo: 'Despesa extra', data: 'Ontem', descricao: 'Motoboy local', valor: -60 },
        ],
        custosRecentes: [
          { label: 'Compra pneus', value: 'R$ 1.840' },
          { label: 'Funcionários', value: 'R$ 980' },
          { label: 'Despesas extras', value: 'R$ 260' },
        ],
      },
      {
        nome: 'Moto Pneus Niterói',
        documento: '34.567.890/0001-22',
        responsavel: 'Paulo',
        whatsapp: '+55 21 96666-0303',
        endereco: 'Av. Central, 455 - Niterói/RJ',
        modeloComercial: 'Credenciado premium',
        comissao: '10%',
        cidade: 'Niterói',
        status: 'Ativo',
        vendas: 'R$ 5.910',
        vendasValor: 5910,
        pedidos: 27,
        ticket: 'R$ 219',
        estoque: '58 SKUs',
        estoqueBaixo: 1,
        margem: '31%',
        comprasPneus: 3290,
        folha: 1460,
        despesasExtras: 480,
        lucroEstimado: 680,
        alerta: '1 baixo',
        serieVendas: [760, 830, 690, 920, 870, 1010, 830],
        seriePedidos: [4, 5, 3, 5, 4, 4, 2],
        topPneus: ['140/70-17', '110/70-17', '130/70-17'],
        estoqueItens: [
          { pneu: '140/70-17 traseiro', qtd: 9, minimo: 4, ultimaCompra: '16/05', fornecedor: 'Pirelli', custoMedio: 'R$ 210', custo: 'R$ 210', venda: 'R$ 330', margem: '36%', status: 'ok' },
          { pneu: '110/70-17 dianteiro', qtd: 3, minimo: 5, ultimaCompra: '11/05', fornecedor: 'Michelin', custoMedio: 'R$ 128', custo: 'R$ 128', venda: 'R$ 215', margem: '40%', status: 'baixo' },
          { pneu: '130/70-17 traseiro', qtd: 14, minimo: 6, ultimaCompra: '12/05', fornecedor: 'Levorin', custoMedio: 'R$ 176', custo: 'R$ 176', venda: 'R$ 285', margem: '38%', status: 'ok' },
          { pneu: '150/60-17 traseiro', qtd: 2, minimo: 3, ultimaCompra: '08/05', fornecedor: 'Pirelli', custoMedio: 'R$ 260', custo: 'R$ 260', venda: 'R$ 410', margem: '37%', status: 'baixo' },
        ],
        equipe: ['Paulo', 'Diego'],
        diasSemAtualizar: 0,
        lancamentos: [
          { tipo: 'Venda', data: 'Hoje 16:05', descricao: '140/70-17 + instalação', valor: 330 },
          { tipo: 'Venda', data: 'Hoje 11:18', descricao: '130/70-17 traseiro', valor: 285 },
          { tipo: 'Compra pneus', data: '16/05', descricao: 'Pirelli mix aro 17', valor: -3290 },
          { tipo: 'Pagamento funcionário', data: '15/05', descricao: 'Diária Diego', valor: -220 },
        ],
        custosRecentes: [
          { label: 'Compra pneus', value: 'R$ 3.290' },
          { label: 'Funcionários', value: 'R$ 1.460' },
          { label: 'Despesas extras', value: 'R$ 480' },
        ],
      },
      {
        nome: 'Parceiro Tribobó',
        documento: 'CPF 123.456.789-00',
        responsavel: 'Marcos',
        whatsapp: '+55 21 95555-0404',
        endereco: 'Tribobó - São Gonçalo/RJ',
        modeloComercial: 'Em credenciamento',
        comissao: 'a definir',
        cidade: 'São Gonçalo',
        status: 'Credenciamento',
        vendas: 'R$ 0',
        vendasValor: 0,
        pedidos: 0,
        ticket: 'R$ 0',
        estoque: 'aguardando',
        estoqueBaixo: 0,
        margem: '-',
        comprasPneus: 0,
        folha: 0,
        despesasExtras: 0,
        lucroEstimado: 0,
        alerta: 'cadastro',
        serieVendas: [0, 0, 0, 0, 0, 0, 0],
        seriePedidos: [0, 0, 0, 0, 0, 0, 0],
        topPneus: ['aguardando catálogo'],
        estoqueItens: [],
        equipe: ['Marcos'],
        diasSemAtualizar: 8,
        lancamentos: [],
        custosRecentes: [
          { label: 'Compra pneus', value: 'R$ 0' },
          { label: 'Funcionários', value: 'R$ 0' },
          { label: 'Despesas extras', value: 'R$ 0' },
        ],
      },
      {
        nome: 'Borracharia Itaipu',
        documento: '45.678.901/0001-33',
        responsavel: 'Leandro',
        whatsapp: '+55 21 94444-0505',
        endereco: 'Estrada de Itaipu, 300 - Niterói/RJ',
        modeloComercial: 'Credenciado · comissão por venda',
        comissao: '7%',
        cidade: 'Niterói',
        status: 'Ativo',
        vendas: 'R$ 2.140',
        vendasValor: 2140,
        pedidos: 12,
        ticket: 'R$ 178',
        estoque: '27 SKUs',
        estoqueBaixo: 2,
        margem: '21%',
        comprasPneus: 1260,
        folha: 740,
        despesasExtras: 310,
        lucroEstimado: -170,
        alerta: 'sem venda hoje',
        serieVendas: [390, 420, 310, 460, 360, 200, 0],
        seriePedidos: [2, 3, 2, 2, 2, 1, 0],
        topPneus: ['90/90-18', '100/90-18', '110/90-17'],
        estoqueItens: [
          { pneu: '90/90-18 traseiro', qtd: 0, minimo: 5, ultimaCompra: '02/05', fornecedor: 'Rinaldi', custoMedio: 'R$ 94', custo: 'R$ 94', venda: 'R$ 155', margem: '39%', status: 'zerado' },
          { pneu: '100/90-18 traseiro', qtd: 2, minimo: 4, ultimaCompra: '07/05', fornecedor: 'Levorin', custoMedio: 'R$ 118', custo: 'R$ 118', venda: 'R$ 190', margem: '38%', status: 'baixo' },
          { pneu: '110/90-17 traseiro', qtd: 6, minimo: 3, ultimaCompra: '04/05', fornecedor: 'Technic', custoMedio: 'R$ 132', custo: 'R$ 132', venda: 'R$ 220', margem: '40%', status: 'ok' },
        ],
        equipe: ['Leandro'],
        diasSemAtualizar: 4,
        lancamentos: [
          { tipo: 'Compra pneus', data: '07/05', descricao: 'Reposição aro 18', valor: -1260 },
          { tipo: 'Pagamento funcionário', data: '06/05', descricao: 'Ajuda balcão', valor: -160 },
          { tipo: 'Despesa extra', data: '05/05', descricao: 'Energia/água rateada', valor: -150 },
        ],
        custosRecentes: [
          { label: 'Compra pneus', value: 'R$ 1.260' },
          { label: 'Funcionários', value: 'R$ 740' },
          { label: 'Despesas extras', value: 'R$ 310' },
        ],
      },
      {
        nome: 'Oficina Colubandê',
        documento: 'CPF 987.654.321-00',
        responsavel: 'Aline',
        whatsapp: '+55 21 93333-0606',
        endereco: 'Colubandê - São Gonçalo/RJ',
        modeloComercial: 'Em credenciamento',
        comissao: 'a definir',
        cidade: 'São Gonçalo',
        status: 'Credenciamento',
        vendas: 'R$ 0',
        vendasValor: 0,
        pedidos: 0,
        ticket: 'R$ 0',
        estoque: '12 SKUs',
        estoqueBaixo: 0,
        margem: '-',
        comprasPneus: 650,
        folha: 0,
        despesasExtras: 90,
        lucroEstimado: -740,
        alerta: 'validar preço',
        serieVendas: [0, 0, 0, 0, 0, 0, 0],
        seriePedidos: [0, 0, 0, 0, 0, 0, 0],
        topPneus: ['90/90-18', '100/80-18'],
        estoqueItens: [
          { pneu: '90/90-18 traseiro', qtd: 4, minimo: 3, ultimaCompra: '18/05', fornecedor: 'Rinaldi', custoMedio: 'R$ 96', custo: 'R$ 96', venda: 'pendente', margem: '-', status: 'validar preço' },
          { pneu: '100/80-18 traseiro', qtd: 8, minimo: 3, ultimaCompra: '18/05', fornecedor: 'Levorin', custoMedio: 'R$ 109', custo: 'R$ 109', venda: 'pendente', margem: '-', status: 'validar preço' },
        ],
        equipe: ['Aline'],
        diasSemAtualizar: 2,
        lancamentos: [
          { tipo: 'Compra pneus', data: '18/05', descricao: 'Carga inicial credenciamento', valor: -650 },
          { tipo: 'Despesa extra', data: '18/05', descricao: 'Material cadastro visual', valor: -90 },
        ],
        custosRecentes: [
          { label: 'Compra pneus', value: 'R$ 650' },
          { label: 'Funcionários', value: 'R$ 0' },
          { label: 'Despesas extras', value: 'R$ 90' },
        ],
      },
    ],

    alertasRede: [
      { tipo: 'Estoque baixo', texto: '90/90-18 traseiro abaixo do mínimo em 3 parceiros', tom: 'text-amber-700 bg-amber-50' },
      { tipo: 'Sem venda hoje', texto: 'Borracharia Itaipu ainda não registrou venda hoje', tom: 'text-rose-700 bg-rose-50' },
      { tipo: 'Credenciamento', texto: '2 parceiros aguardam validação de catálogo inicial', tom: 'text-blue-700 bg-blue-50' },
    ],

    // ─── COMPUTED ───────────────────────────────────
    shadowPairs: [],
    shadowKpis: [
      { label: 'Mensagens cliente', value: '0' },
      { label: 'Bot gerou resposta', value: '0' },
      { label: 'Humano respondeu', value: '0' },
      { label: 'Bot bloqueado', value: '0' },
    ],

    currentPageTitle() {
      const all = [...this.liveMenu, ...this.futureMenu];
      return all.find(i => i.id === this.currentPage)?.label || '';
    },

    notifBadgeCount() {
      return this.notificacoes.filter(n => !n.read).length;
    },

    currentShadowPair() {
      return this.shadowPairs[this.shadowSelectedIndex] || this.shadowPairs[0] || null;
    },

    selectShadowPair(index) {
      this.shadowSelectedIndex = index;
      this.$nextTick(() => lucide.createIcons());
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
      if (tipo === 'Compra pneus') return 'bg-blue-50 text-blue-700';
      if (tipo === 'Pagamento funcionário') return 'bg-purple-50 text-purple-700';
      if (tipo === 'Despesa extra') return 'bg-amber-50 text-amber-700';
      return 'bg-gray-100 text-gray-700';
    },

    lancamentoValorClass(valor) {
      return Number(valor || 0) >= 0 ? 'text-emerald-700' : 'text-rose-700';
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
        throw new Error(payload.error || `api_${response.status}`);
      }
      return response.json();
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

    shadowStatusLabel(pair) {
      if (!pair) return 'Sem par';
      if (pair.comparison_status === 'paired') return 'Pareado';
      if (pair.comparison_status === 'bot_blocked') return 'Bot bloqueado';
      if (pair.comparison_status === 'missing_human_reply') return 'Aguardando humano';
      if (pair.comparison_status === 'missing_bot_shadow') return 'Sem shadow';
      if (pair.comparison_status === 'bot_empty') return 'Bot vazio';
      return pair.comparison_status || 'Pendente';
    },

    shadowStatusClass(pair) {
      const status = pair?.comparison_status;
      if (status === 'paired') return 'bg-emerald-50 text-emerald-700';
      if (status === 'bot_blocked') return 'bg-rose-50 text-rose-700';
      if (status === 'missing_human_reply') return 'bg-amber-50 text-amber-700';
      if (status === 'missing_bot_shadow' || status === 'bot_empty') return 'bg-gray-100 text-gray-700';
      return 'bg-blue-50 text-blue-700';
    },

    chatwootUrl(target = this.currentShadowPair()) {
      if (!target?.chatwoot_conversation_id || !this.chatwootBaseUrl || !this.chatwootAccountId) return null;
      return `${this.chatwootBaseUrl}/app/accounts/${this.chatwootAccountId}/conversations/${target.chatwoot_conversation_id}`;
    },

    openChatwootConversation(target) {
      const url = this.chatwootUrl(target);
      if (!url) return;

      const popup = window.open('', '_blank');
      if (popup) {
        popup.opener = null;
        popup.location.href = url;
        return;
      }

      window.location.assign(url);
    },

    openCurrentShadowInChatwoot() {
      this.openChatwootConversation(this.currentShadowPair());
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

    applyResumo(rows) {
      const row = rows?.[0];
      if (!row) return;
      this.kpis = [
        { label: 'Faturamento hoje', value: this.formatCurrency(row.faturamento_hoje), delta: 'real', deltaClass: 'bg-emerald-50 text-emerald-700', icon: 'trending-up', iconBg: 'bg-emerald-100', iconColor: 'text-emerald-700' },
        { label: 'Pedidos hoje', value: String(row.pedidos_confirmados || row.vendas_hoje || 0), delta: `${row.vendas_hoje || 0} vendas`, deltaClass: 'bg-purple-50 text-purple-700', icon: 'shopping-bag', iconBg: 'bg-purple-100', iconColor: 'text-purple-700' },
        { label: 'Conversas hoje', value: String(row.conversas_hoje || 0), delta: `${row.drafts_pendentes || 0} drafts`, deltaClass: 'bg-blue-50 text-blue-700', icon: 'message-circle', iconBg: 'bg-blue-100', iconColor: 'text-blue-700' },
        { label: 'Bot shadow', value: String(row.shadow_turns_hoje || 0), delta: `${row.shadow_blocked_hoje || 0} blocked`, deltaClass: 'bg-amber-50 text-amber-700', icon: 'bot', iconBg: 'bg-amber-100', iconColor: 'text-amber-700' },
      ];
    },

    applyOperacao(rows) {
      this.conversasAtivas = (rows || []).map((row, index) => {
        const slots = row.slots ? Object.entries(row.slots).slice(0, 6).map(([k, v]) => ({ k, v: this.displaySlot(v) })) : [];
        return {
          id: row.conversation_id,
          chatwoot_conversation_id: row.chatwoot_conversation_id,
          draft_id: row.draft_id,
          draft_payment_method: row.draft_payment_method,
          draft_fulfillment_mode: row.draft_fulfillment_mode,
          draft_delivery_address: row.draft_delivery_address,
          name: row.contact_name || `Conversa ${row.chatwoot_conversation_id}`,
          initial: this.initials(row.contact_name),
          avatarBg: ['bg-gradient-to-br from-orange-400 to-orange-600', 'bg-gradient-to-br from-pink-400 to-pink-600', 'bg-gradient-to-br from-indigo-400 to-indigo-600'][index % 3],
          channel: row.channel_type || 'Chatwoot',
          channelClass: row.channel_type === 'instagram' ? 'bg-pink-50 text-pink-700' : 'bg-emerald-50 text-emerald-700',
          ago: row.last_activity_at ? this.formatDateTime(row.last_activity_at) : '-',
          lastMsg: row.last_customer_message || '(sem mensagem)',
          slots,
          phone: row.contact_phone || '',
          draft: row.draft_id ? [row.draft_payment_method, row.draft_fulfillment_mode, row.draft_delivery_address].filter(Boolean).join(' · ') : null,
        };
      });
    },

    applyPedidos(rows) {
      this.pedidos = (rows || []).map((row) => {
        const cancelled = row.status === 'cancelled';
        return {
          data: this.formatDateTime(row.created_at),
          cliente: row.contact_name || 'Cliente',
          itens: this.itemSummary(row.items),
          pagto: row.payment_method || '-',
          operador: row.registered_by || '-',
          total: this.formatCurrency(row.total_amount),
          status: cancelled ? 'Cancelado' : (row.status === 'confirmed' ? 'Confirmado' : row.status || 'Aberto'),
          statusClass: cancelled ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700',
          dotClass: cancelled ? 'bg-rose-500' : 'bg-emerald-500',
        };
      });
    },

    applyProdutos(rows) {
      this.produtos = rows || [];
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

    applyRede(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return;

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
          lancamentos: events.map((event) => ({
            tipo: this.mapPartnerEventType(event.type),
            data: event.event_at ? this.formatDateTime(event.event_at) : '-',
            descricao: event.description || '-',
            valor: Number(event.amount || 0),
          })),
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

    applyShadow(rows) {
      this.shadowPairs = rows || [];
      if (this.shadowSelectedIndex >= this.shadowPairs.length) {
        this.shadowSelectedIndex = Math.max(0, this.shadowPairs.length - 1);
      }
      const total = this.shadowPairs.length;
      const withBot = this.shadowPairs.filter((row) => row.agent_turn_id).length;
      const withHuman = this.shadowPairs.filter((row) => row.human_text).length;
      const blocked = this.shadowPairs.filter((row) => row.bot_status === 'blocked').length;
      this.shadowKpis = [
        { label: 'Mensagens cliente', value: String(total) },
        { label: 'Bot gerou resposta', value: String(withBot) },
        { label: 'Humano respondeu', value: String(withHuman) },
        { label: 'Bot bloqueado', value: String(blocked) },
      ];
      const shadowMenuItem = this.liveMenu.find((item) => item.id === 'shadow');
      if (shadowMenuItem) shadowMenuItem.badge = total > 0 ? String(total) : '';
      this.shadowLastLoadedAt = new Date();
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

    async reviewShadow(pair, verdict) {
      if (!pair?.agent_turn_id) return;

      try {
        await this.apiPost('/admin/api/shadow/review', {
          turn_id: pair.agent_turn_id,
          verdict,
        });
        this.shadowPairs = this.shadowPairs.filter((row) => row.agent_turn_id !== pair.agent_turn_id);
        if (this.shadowSelectedIndex >= this.shadowPairs.length) {
          this.shadowSelectedIndex = Math.max(0, this.shadowPairs.length - 1);
        }
        this.applyShadow(this.shadowPairs);
      } catch (err) {
        this.apiError = err instanceof Error ? err.message : String(err);
      }
    },

    async refreshShadowData() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;

      this.shadowRefreshing = true;
      try {
        const shadow = await this.apiGet('/admin/api/dashboard/shadow?limit=50');
        this.serverEnvironment = shadow.environment || this.serverEnvironment;
        this.chatwootBaseUrl = shadow.chatwoot_base_url || this.chatwootBaseUrl;
        this.chatwootAccountId = shadow.chatwoot_account_id || this.chatwootAccountId;
        this.agentV2WorkerEnabled = shadow.agent_v2_worker_enabled;
        this.applyShadow(shadow.rows);
        this.apiStatus = 'real';
        this.apiError = null;
      } catch (err) {
        this.apiStatus = 'mock';
        this.apiError = err instanceof Error ? err.message : String(err);
      } finally {
        this.shadowRefreshing = false;
      }
    },

    startShadowAutoRefresh() {
      if (this.shadowAutoRefreshId) return;
      this.shadowAutoRefreshId = setInterval(() => {
        if (this.currentPage === 'shadow' && !this.shadowRefreshing) {
          void this.refreshShadowData();
        }
      }, 10000);
    },

    async loadRealData() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;

      try {
        const [resumo, operacao, pedidos, shadow, produtos, rede] = await Promise.all([
          this.apiGet('/admin/api/dashboard/resumo'),
          this.apiGet('/admin/api/dashboard/operacao?limit=50'),
          this.apiGet('/admin/api/dashboard/pedidos?limit=50'),
          this.apiGet('/admin/api/dashboard/shadow?limit=50'),
          this.apiGet('/admin/api/dashboard/produtos?limit=100'),
          this.apiGet(`/admin/api/dashboard/rede?period=${encodeURIComponent(this.redePeriod)}`),
        ]);
        this.serverEnvironment = resumo.environment || operacao.environment || pedidos.environment || shadow.environment || produtos.environment || rede.environment || null;
        this.chatwootBaseUrl = shadow.chatwoot_base_url || operacao.chatwoot_base_url || resumo.chatwoot_base_url || pedidos.chatwoot_base_url || produtos.chatwoot_base_url || rede.chatwoot_base_url || null;
        this.chatwootAccountId = shadow.chatwoot_account_id || operacao.chatwoot_account_id || resumo.chatwoot_account_id || pedidos.chatwoot_account_id || produtos.chatwoot_account_id || rede.chatwoot_account_id || null;
        this.agentV2WorkerEnabled = shadow.agent_v2_worker_enabled ?? resumo.agent_v2_worker_enabled ?? null;
        this.applyResumo(resumo.rows);
        this.applyOperacao(operacao.rows);
        this.applyPedidos(pedidos.rows);
        this.applyShadow(shadow.rows);
        this.applyProdutos(produtos.rows);
        this.applyRede(rede.rows);
        this.apiStatus = 'real';
        this.apiError = null;
      } catch (err) {
        this.apiStatus = 'mock';
        this.apiError = err instanceof Error ? err.message : String(err);
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
      this.startShadowAutoRefresh();
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

      this.$watch('currentPage', () => {
        this.$nextTick(() => {
          lucide.createIcons();
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
          if (this.currentPage === 'shadow') void this.refreshShadowData();
        });
      });
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

      window._perfChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Hoje'],
          datasets: [{
            data: [180, 240, 60, 320, 280, 410, 432],
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
                label: function(ctx) { return 'R$ ' + (ctx.parsed.y * 10).toFixed(0); }
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
