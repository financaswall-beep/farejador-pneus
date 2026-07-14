// Vendas da Matriz: leitura comercial unificada de varejo + atacado.
// O Financeiro continua dono de custos, lucro, cobranças, despesas e caixa.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.varejo = function () {
  return {
    applyPedidos(rows) {
      const deliveryLabels = { pending: 'Em separação', dispatched: 'Saiu pra entrega', delivered: 'Entregue', failed: 'Entrega falhou' };
      this.pedidos = (rows || []).map((row) => {
        const isPartner = !!row.is_partner;
        const cancelled = row.status === 'cancelled' || row.partner_status === 'cancelled';
        let status, statusClass, dotClass;
        if (cancelled) {
          status = 'Cancelado'; statusClass = 'bg-rose-50 text-rose-700'; dotClass = 'bg-rose-500';
        } else if (isPartner) {
          status = deliveryLabels[row.delivery_status] || row.partner_status || 'Pedido';
          const done = row.delivery_status === 'delivered';
          statusClass = done ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700';
          dotClass = done ? 'bg-emerald-500' : 'bg-amber-500';
        } else {
          status = ({ open: 'Aberto', confirmed: 'Confirmado', pending: 'Pendente', delivered: 'Entregue', paid: 'Pago' })[row.status] || row.status || 'Aberto';
          const waiting = row.status === 'open' || row.status === 'pending';
          statusClass = waiting ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700';
          dotClass = waiting ? 'bg-amber-500' : 'bg-emerald-500';
        }
        const items = Array.isArray(row.items) ? row.items : [];
        const pagto = isPartner
          ? (row.payment_status === 'pago' ? 'Pago' : 'A receber')
          : (row.payment_method || '-');
        return {
          id: row.order_id,
          createdAt: row.created_at,
          data: this.formatDateTime(row.created_at),
          cliente: row.contact_name || 'Cliente',
          telefone: row.contact_phone || row.phone || '',
          itens: this.itemSummary(items),
          rawItems: items,
          itensCount: items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
          pagto,
          fulfillmentMode: row.fulfillment_mode || null,
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

    vendasInicioPeriodo() {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      if (this.vendasPeriodo === '7d') d.setDate(d.getDate() - 6);
      if (this.vendasPeriodo === '30d') d.setDate(d.getDate() - 29);
      return d;
    },
    vendaNoPeriodo(value) {
      const d = new Date(value);
      return !Number.isNaN(d.getTime()) && d >= this.vendasInicioPeriodo();
    },

    // Varejo = pedido da própria Matriz. Pedido roteado ao parceiro permanece na Rede.
    vendasVarejo() {
      return this.pedidos.filter((p) => p.unitSlug === 'main');
    },
    vendasVarejoPeriodo() {
      return this.vendasVarejo().filter((p) => this.vendaNoPeriodo(p.createdAt));
    },
    vendasVarejoAtivas() {
      return this.vendasVarejoPeriodo().filter((p) => p.status !== 'Cancelado');
    },
    vendasVarejoTotal() {
      return this.vendasVarejoAtivas().reduce((sum, p) => sum + Number(p.totalAmount || 0), 0);
    },
    varejoResumoKpis() {
      const vendas = this.varejoResumo ? Number(this.varejoResumo.vendas_count || 0) : this.vendasVarejoAtivas().length;
      const total = this.varejoResumo ? Number(this.varejoResumo.faturamento || 0) : this.vendasVarejoTotal();
      const canceladas = Number(this.varejoResumo?.cancelled_count ?? this.vendasVarejoPeriodo().filter((p) => p.status === 'Cancelado').length);
      return {
        vendas, total, canceladas,
        ticket: vendas ? total / vendas : 0,
        cancelPct: vendas + canceladas ? (canceladas / (vendas + canceladas)) * 100 : 0,
      };
    },
    vendasVarejoFiltradas() {
      const busca = this.varejoBusca.trim().toLocaleLowerCase('pt-BR');
      return this.vendasVarejoPeriodo().filter((p) => {
        const aguardando = p.status === 'Aberto' || p.status === 'Pendente';
        if (this.varejoStatusFiltro === 'confirmadas' && (aguardando || p.status === 'Cancelado')) return false;
        if (this.varejoStatusFiltro === 'andamento' && !aguardando) return false;
        if (this.varejoStatusFiltro === 'canceladas' && p.status !== 'Cancelado') return false;
        if (!busca) return true;
        return `${p.cliente} ${p.itens} ${p.pagto} ${p.status}`.toLocaleLowerCase('pt-BR').includes(busca);
      });
    },
    varejoResumoOperacional() {
      const ativas = this.vendasVarejoAtivas();
      const porHora = {};
      ativas.forEach((p) => {
        const hora = new Date(p.createdAt).getHours();
        porHora[hora] = (porHora[hora] || 0) + p.itensCount;
      });
      const abertas = this.logistica?.abertas || [];
      return {
        clientes: new Set(ativas.map((p) => p.cliente).filter(Boolean)).size,
        pneus: ativas.reduce((sum, p) => sum + p.itensCount, 0),
        pico: Math.max(0, ...Object.values(porHora)),
        aguardando: this.vendasAguardando(),
        separacao: abertas.filter((d) => d.delivery_status === 'pending').length,
        emRota: abertas.filter((d) => d.delivery_status === 'dispatched').length,
      };
    },
    varejoMedidasMaisVendidas() {
      const totais = new Map();
      this.vendasVarejoAtivas().forEach((p) => (p.rawItems || []).forEach((item) => {
        const nome = item.product_name || item.product_code || 'Produto';
        totais.set(nome, (totais.get(nome) || 0) + Number(item.quantity || 0));
      }));
      const rows = [...totais].map(([nome, quantidade]) => ({ nome, quantidade })).sort((a, b) => b.quantidade - a.quantidade).slice(0, 5);
      const max = rows[0]?.quantidade || 1;
      return rows.map((row) => ({ ...row, pct: (row.quantidade / max) * 100 }));
    },
    varejoPagamentos() {
      const grupos = [
        { id: 'pix', label: 'PIX', cor: '#047857', valor: 0 },
        { id: 'cartao', label: 'Cartão', cor: '#86d394', valor: 0 },
        { id: 'dinheiro', label: 'Dinheiro', cor: '#f59e0b', valor: 0 },
        { id: 'outros', label: 'Outros', cor: '#d1d5db', valor: 0 },
      ];
      this.vendasVarejoAtivas().forEach((p) => {
        const nome = String(p.pagto || '').toLocaleLowerCase('pt-BR');
        const id = nome.includes('pix') ? 'pix' : (nome.includes('cart') ? 'cartao' : (nome.includes('dinheiro') ? 'dinheiro' : 'outros'));
        grupos.find((g) => g.id === id).valor += 1;
      });
      const total = grupos.reduce((sum, g) => sum + g.valor, 0) || 1;
      return grupos.map((g) => ({ ...g, pct: (g.valor / total) * 100 }));
    },
    varejoPagamentoGradient() {
      let inicio = 0;
      return `conic-gradient(${this.varejoPagamentos().map((g) => { const fim = inicio + g.pct; const fatia = `${g.cor} ${inicio}% ${fim}%`; inicio = fim; return fatia; }).join(', ')})`;
    },

    vendasInativos() {
      return this.atacadoRanking.filter((b) => Number(b.orders_count || 0) > 0 && Number(b.days_since_last || 0) > this.atacadoStaleDays);
    },
    vendasNuncaCompraram() {
      return this.atacadoRanking.filter((b) => Number(b.orders_count || 0) === 0);
    },
    recompraWhatsLink(b) {
      const digits = String(b?.phone || '').replace(/\D/g, '');
      if (!digits) return null;
      const tel = digits.startsWith('55') ? digits : `55${digits}`;
      const msg = Number(b.orders_count || 0) > 0
        ? `Oi, ${b.name}! Tudo bem? Passando para saber se está precisando repor algum pneu.`
        : `Oi, ${b.name}! Tudo bem? Temos pneus para atacado na Matriz Farejador. Posso te ajudar com alguma medida?`;
      return `https://wa.me/${tel}?text=${encodeURIComponent(msg)}`;
    },
    vendasAguardando() {
      if (this.varejoResumo && this.varejoResumo.pending_count != null) return Number(this.varejoResumo.pending_count || 0);
      return this.vendasVarejoPeriodo().filter((p) => p.status === 'Aberto' || p.status === 'Pendente').length;
    },
    vendasResumoGeral() {
      const varejoCount = this.varejoResumo
        ? Number(this.varejoResumo.vendas_count || 0)
        : this.vendasVarejoAtivas().length;
      const atacadoCount = Number(this.atacadoResumo?.vendas_count || 0);
      const varejoValor = this.varejoResumo
        ? Number(this.varejoResumo.faturamento || 0)
        : this.vendasVarejoTotal();
      const atacadoValor = Number(this.atacadoResumo?.faturamento || 0);
      const canceladas = Number(this.varejoResumo?.cancelled_count ?? this.vendasVarejoPeriodo().filter((p) => p.status === 'Cancelado').length)
        + Number(this.atacadoResumo?.cancelled_count || 0);
      const vendas = varejoCount + atacadoCount;
      const valor = varejoValor + atacadoValor;
      return {
        vendas,
        valor,
        ticket: vendas > 0 ? valor / vendas : 0,
        canceladas,
        cancelPct: vendas + canceladas > 0 ? (canceladas / (vendas + canceladas)) * 100 : 0,
        varejoCount,
        varejoValor,
        atacadoCount,
        atacadoValor,
      };
    },
    vendasCanais() {
      const r = this.vendasResumoGeral();
      const max = Math.max(r.varejoCount, r.atacadoCount, 1);
      return [
        { id: 'varejo', label: 'Varejo', vendas: r.varejoCount, valor: r.varejoValor, ticket: r.varejoCount ? r.varejoValor / r.varejoCount : 0, barra: (r.varejoCount / max) * 100, icon: 'user-round' },
        { id: 'atacado', label: 'Atacado', vendas: r.atacadoCount, valor: r.atacadoValor, ticket: r.atacadoCount ? r.atacadoValor / r.atacadoCount : 0, barra: (r.atacadoCount / max) * 100, icon: 'warehouse' },
      ];
    },

    vendasHistorico() {
      const varejo = this.vendasVarejoPeriodo().map((p) => ({
        key: `v:${p.id}`, id: p.id, canal: 'Varejo', canalId: 'varejo', createdAt: p.createdAt,
        data: p.data, cliente: p.cliente, itens: p.itens, itensCount: p.itensCount, pagto: p.pagto,
        telefone: p.telefone,
        total: p.total, totalAmount: p.totalAmount, status: p.status, statusClass: p.statusClass,
        cancelavel: p.status !== 'Cancelado', varejo: p,
      }));
      const atacado = this.atacadoVendas
        .filter((v) => this.vendaNoPeriodo(v.sold_at))
        .map((v) => {
          const cancelled = v.status === 'cancelled';
          const qty = (v.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
          return {
            key: `a:${v.id}`, id: v.id, canal: 'Atacado', canalId: 'atacado', createdAt: v.sold_at,
            data: this.vendaData(v), cliente: v.buyer_name, itens: `${qty} pneu(s)`, itensCount: qty,
            pagto: v.payment_status === 'pending' ? 'Fiado' : 'Pago',
            total: this.formatCurrency(Number(v.total_amount || 0)), totalAmount: Number(v.total_amount || 0),
            status: cancelled ? 'Cancelada' : 'Confirmada',
            statusClass: cancelled ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700',
            cancelavel: !cancelled, recibo: this.reciboWhatsLink(v), atacado: v,
          };
        });
      return [...varejo, ...atacado].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    vendasHistoricoFiltrado() {
      const busca = this.vendasBusca.trim().toLocaleLowerCase('pt-BR');
      return this.vendasHistorico().filter((row) => {
        if (this.vendasHistoricoCanal !== 'todos' && row.canalId !== this.vendasHistoricoCanal) return false;
        if (!busca) return true;
        return `${row.cliente} ${row.itens} ${row.pagto} ${row.status}`.toLocaleLowerCase('pt-BR').includes(busca);
      });
    },

    async loadVarejoResumo() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      try {
        this.varejoResumo = (await this.apiGet('/admin/api/varejo/resumo?period=' + this.vendasPeriodo)) || null;
      } catch (err) {
        this.varejoResumo = null;
      }
    },
    async loadVendasData() {
      await Promise.allSettled([this.loadVarejoResumo(), this.loadAtacadoVendas(), this.logisticaLoaded ? Promise.resolve() : this.loadLogistica()]);
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    async setVendasPeriodo(period) {
      if (this.vendasPeriodo === period) return;
      this.vendasPeriodo = period;
      this.varejoPeriodo = period;
      this.atacadoPeriodo = period;
      await this.loadVendasData();
    },
    async setVarejoPeriodo(period) { await this.setVendasPeriodo(period); },
    async setAtacadoPeriodo(period) { await this.setVendasPeriodo(period); },

    abrirNovaVenda(tipo) {
      this.vendaMenuOpen = false;
      if (tipo === 'atacado') {
        this.vendasTab = 'atacado';
        void this.loadAtacadoVendas();
        return;
      }
      this.openWalkinModal();
    },
    async cancelarVarejo(row) {
      if (!row?.id || row.status === 'Cancelado') return;
      const reason = window.prompt('Motivo do cancelamento da venda:');
      if (reason === null) return;
      if (!reason.trim()) { window.alert('Informe o motivo do cancelamento.'); return; }
      try {
        await this.apiPost(`/admin/api/orders/${row.id}/cancel`, { reason: reason.trim() });
        await this.loadRealData();
        await this.loadVendasData();
      } catch (err) {
        window.alert(`Não consegui cancelar: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
};
