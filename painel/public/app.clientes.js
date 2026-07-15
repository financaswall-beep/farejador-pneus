window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.clientes = function () {
  return {
    async loadClientes() {
      if (this.clientesLoading || !this.adminAuthenticated) return;
      this.clientesLoading = true;
      this.clientesError = null;
      try {
        const payload = await this.apiGet('/admin/api/clientes');
        this.clientes = Array.isArray(payload.rows) ? payload.rows : [];
        this.clientesParceiros = Array.isArray(payload.partners) ? payload.partners : [];
        if (!this.clienteSelecionadoId && this.clientes[0]) this.clienteSelecionadoId = this.clientes[0].id;
        if (!this.clienteParceiroSelecionadoId && this.clientesParceiros[0]) this.clienteParceiroSelecionadoId = this.clientesParceiros[0].partner_id;
      } catch (err) {
        this.clientesError = err instanceof Error ? err.message : String(err);
      } finally {
        this.clientesLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },
    setClientesTab(tab) {
      this.clientesTab = tab;
      this.limparClientesFiltros();
      this.clientesPeriodo = tab === 'leads' ? '30' : (tab === 'recompra' || tab === 'parceiros' ? 'todos' : '90');
      const first = tab === 'leads'
        ? ['novo', 'atendimento', 'orcamento', 'perdido'].flatMap((lane) => this.clientesLeads(lane))[0]
        : tab === 'compradores' ? this.clientesCompradores()[0]
          : tab === 'recompra' ? this.clientesRecompra()[0] : this.clientesFiltrados()[0];
      if (first) this.clienteSelecionadoId = first.id;
      this.$nextTick(() => lucide.createIcons());
    },
    limparClientesFiltros() {
      this.clientesBusca = '';
      this.clientesTipo = 'todos';
      this.clientesOrigem = 'todos';
      this.clientesStatus = 'todos';
      this.clientesClasse = 'todos';
      this.clientesPeriodo = '90';
      this.clientesPagina = 1;
    },
    clienteTexto(v) {
      return String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    },
    clientesFiltrados() {
      const q = this.clienteTexto(this.clientesBusca);
      return this.clientes.filter((c) => {
        const hit = !q || this.clienteTexto([c.name, c.phone, c.email, c.origin, c.partner_name].join(' ')).includes(q);
        const tipo = this.clientesTipo === 'todos' || c.kind === this.clientesTipo;
        const origem = this.clientesOrigem === 'todos' || c.source === this.clientesOrigem;
        const status = this.clientesStatus === 'todos' || c.status === this.clientesStatus;
        const classe = this.clientesClasse === 'todos' || (this.clientesClasse === 'vip' ? c.is_vip : !c.is_vip);
        const dias = this.clienteDias(c.last_interaction_at || c.last_purchase_at);
        const periodo = this.clientesPeriodo === 'todos' || dias === null || dias <= Number(this.clientesPeriodo);
        return hit && tipo && origem && status && classe && periodo;
      });
    },
    clientesPaginados(rows) {
      const inicio = (this.clientesPagina - 1) * this.clientesPorPagina;
      return rows.slice(inicio, inicio + this.clientesPorPagina);
    },
    clientesTotalPaginas(rows) {
      return Math.max(1, Math.ceil(rows.length / this.clientesPorPagina));
    },
    clientesMudarPagina(delta, rows) {
      this.clientesPagina = Math.min(this.clientesTotalPaginas(rows), Math.max(1, this.clientesPagina + delta));
    },
    clientesResumo() {
      const rows = this.clientes;
      return {
        ativos: rows.filter((c) => c.status === 'ativo').length,
        vip: rows.filter((c) => c.is_vip).length,
        borracharias: rows.filter((c) => c.kind === 'borracharia').length,
        pessoas: rows.filter((c) => c.kind === 'pessoa_fisica').length,
        leads: rows.filter((c) => Number(c.purchases || 0) === 0 && c.source === 'chatwoot').length,
        compradores: rows.filter((c) => Number(c.purchases || 0) > 0).length,
      };
    },
    clientesLeadsResumo() {
      const todos = this.clientes.filter((c) => Number(c.purchases || 0) === 0 && c.source === 'chatwoot');
      const compradores = this.clientes.filter((c) => Number(c.purchases || 0) > 0 && c.source === 'chatwoot').length;
      const orcamentos = todos.filter((c) => this.clienteLeadLane(c) === 'orcamento').length;
      const semResposta = todos.filter((c) => (this.clienteDias(c.last_interaction_at) ?? 0) >= 3 && this.clienteLeadLane(c) !== 'perdido').length;
      return { novos: this.clientesLeads('novo').length, orcamentos, semResposta, conversao: todos.length + compradores ? (compradores / (todos.length + compradores)) * 100 : 0 };
    },
    clientesCompradoresResumo() {
      const rows = this.clientes.filter((c) => Number(c.purchases || 0) > 0);
      const vendas = rows.reduce((s, c) => s + Number(c.total_spent || 0), 0);
      const compras = rows.reduce((s, c) => s + Number(c.purchases || 0), 0);
      const lucro = rows.reduce((s, c) => s + Number(c.gross_profit || 0), 0);
      return { total: rows.length, ticket: compras ? vendas / compras : 0, margem: vendas && lucro ? (lucro / vendas) * 100 : null, recorrentes: rows.filter((c) => Number(c.purchases || 0) >= 2).length };
    },
    clientesRecompraResumo() {
      const rows = this.clientesRecompra();
      const valor = rows.reduce((s, c) => s + Number(c.avg_ticket || 0), 0);
      const hoje = rows.filter((c) => (this.clienteDias(c.last_purchase_at) ?? 0) === 30).length;
      return { oportunidades: rows.length, valor, hoje };
    },
    clienteSelecionado() {
      return this.clientes.find((c) => c.id === this.clienteSelecionadoId) || null;
    },
    selecionarCliente(c) {
      this.clienteSelecionadoId = c.id;
      this.$nextTick(() => lucide.createIcons());
    },
    clienteTipoLabel(kind) {
      return ({ pessoa_fisica: 'Pessoa física', borracharia: 'Borracharia', parceiro: 'Parceiro', nao_classificado: 'Não classificado' })[kind] || 'Não classificado';
    },
    clienteClasseLabel(c) {
      return c?.is_vip ? 'VIP' : 'Normal';
    },
    clienteProximaAcao(c) {
      if (!c) return '—';
      if (Number(c.purchases || 0) === 0) return this.clienteLeadLane(c) === 'perdido' ? 'Reavaliar' : 'Continuar atendimento';
      const dias = this.clienteDias(c.last_purchase_at);
      return dias !== null && dias >= 30 ? 'Enviar recompra' : 'Acompanhar';
    },
    clienteOrigemLabel(source) {
      return ({ chatwoot: 'Chatwoot', balcao: 'Balcão', parceiro: 'Loja parceira', atacado: 'Atacado' })[source] || source;
    },
    clienteOrigemIcone(c) {
      const origem = this.clienteTexto(c?.origin);
      if (origem.includes('instagram')) return '/assets/brands/instagram.svg';
      if (/facebook|meta ads/.test(origem)) return '/assets/brands/facebook.svg';
      if (/whatsapp|whats app/.test(origem)) return '/assets/brands/whatsapp.svg';
      return '';
    },
    clienteData(value) {
      if (!value) return '—';
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
    },
    clienteDias(value) {
      if (!value) return null;
      const ms = Date.now() - new Date(value).getTime();
      return Math.max(0, Math.floor(ms / 86400000));
    },
    clienteLeadLane(c) {
      const outcome = this.clienteTexto(c.lead_outcome);
      const stage = this.clienteTexto(c.lead_stage);
      if (/(perd|lost|cancel|sem interesse)/.test(outcome)) return 'perdido';
      if (/(orc|cot|propost|offer)/.test(stage)) return 'orcamento';
      if (stage) return 'atendimento';
      return 'novo';
    },
    clientesLeads(lane) {
      return this.clientesFiltrados()
        .filter((c) => Number(c.purchases || 0) === 0 && c.source === 'chatwoot')
        .filter((c) => this.clienteLeadLane(c) === lane);
    },
    clienteLeadSelecionado() {
      const c = this.clienteSelecionado();
      return c && Number(c.purchases || 0) === 0 ? c : null;
    },
    clientesCompradores() {
      return this.clientesFiltrados().filter((c) => Number(c.purchases || 0) > 0)
        .sort((a, b) => Number(b.total_spent || 0) - Number(a.total_spent || 0));
    },
    clientesRecompra() {
      return this.clientesFiltrados().filter((c) => Number(c.purchases || 0) > 0 && (this.clienteDias(c.last_purchase_at) ?? 0) >= 30)
        .sort((a, b) => (this.clienteDias(b.last_purchase_at) ?? 0) - (this.clienteDias(a.last_purchase_at) ?? 0));
    },
    abrirHistoricoCliente(c) {
      this.vendasBusca = c?.phone || c?.name || '';
      this.vendasTab = 'historico';
      this.currentPage = 'vendas';
    },
    clienteMensagem(c) {
      const primeiro = String(c?.name || 'cliente').trim().split(/\s+/)[0];
      return `Olá, ${primeiro}! Tudo bem? Passando para saber se está precisando repor algum pneu. Posso verificar as medidas e condições para você.`;
    },
    clienteOfertaMensagem(c) {
      const primeiro = String(c?.name || 'cliente').trim().split(/\s+/)[0];
      const medida = c?.last_item ? ` para a medida ${c.last_item}` : '';
      return `Olá, ${primeiro}! Separei uma condição de pneu${medida}. Posso te enviar os valores e opções disponíveis?`;
    },
    abrirWhatsAppCliente(c, mensagem = '') {
      const phone = String(c?.phone || '').replace(/\D/g, '');
      if (!phone) { alert('Este cliente não tem telefone cadastrado.'); return; }
      const numero = phone.startsWith('55') ? phone : `55${phone}`;
      window.open(`https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`, '_blank', 'noopener');
    },
    clientesParceirosFiltrados() {
      const q = this.clienteTexto(this.clientesBusca);
      return this.clientesParceiros.filter((p) => !q || this.clienteTexto([p.name, p.phone, p.document_number].join(' ')).includes(q));
    },
    clienteParceiroSelecionado() {
      return this.clientesParceiros.find((p) => p.partner_id === this.clienteParceiroSelecionadoId) || null;
    },
    abrirParceiroDaRede(p) {
      const idx = this.parceirosRede.findIndex((row) => row.id === p.partner_id || row.partner_id === p.partner_id);
      if (idx >= 0) this.openParceiroDetalhe(idx);
      else this.currentPage = 'rede';
    },
    exportarClientes() {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const body = this.clientesFiltrados().map((c) => [c.name, this.clienteTipoLabel(c.kind), c.phone, c.email, c.origin, c.is_vip ? 'VIP' : '', c.purchases, c.total_spent, c.last_purchase_at].map(esc).join(';'));
      const csv = ['Cliente;Tipo;Telefone;Email;Origem;Classe;Compras;Total comprado;Última compra', ...body].join('\r\n');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
      link.download = `clientes-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click(); URL.revokeObjectURL(link.href);
    },
  };
};
