// Obra 300 (2026-07-05): fatia do painel da MATRIZ — pedidos do varejo + resumo do varejo (0117) + períodos.
// VERBATIM das linhas 769-843 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.varejo = function () {
  return {
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
    // Resumo do varejo com custo CONGELADO na venda (0117): faturamento/custo/lucro vêm do
    // SERVIDOR (mesma régua da lista — unit 'main', cancelado fora — mas sem o limite de
    // linhas dela). A lista continua alimentando a tabela; o resumo alimenta os CARDS.
    async loadVarejoResumo() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      try {
        this.varejoResumo = (await this.apiGet('/admin/api/varejo/resumo?period=' + this.varejoPeriodo)) || null;
      } catch (err) {
        this.varejoResumo = null; // cards caem no cálculo local da lista (fallback honesto)
      }
    },
    async setVarejoPeriodo(p) {
      this.varejoPeriodo = p;
      await this.loadVarejoResumo();
    },
    async setAtacadoPeriodo(p) {
      this.atacadoPeriodo = p;
      try {
        this.atacadoResumo = (await this.apiGet('/admin/api/wholesale/resumo?period=' + p)) || null;
      } catch (err) { /* mantém o resumo anterior na tela */ }
    },

    // ── REDE — comissões como lançamento (0118): o GET já roda a varredura no servidor
    // (cria lançamento de venda 2W realizada; estorna o de venda cancelada). ──
  };
};
