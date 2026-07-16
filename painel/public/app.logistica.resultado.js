// Fatia da Logistica: memoria de calculo e apresentacao do resultado por rota.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaResultado = function () {
  return {
    rotaResumo(t) {
      const r = t?.resumo;
      if (!r) return null;
      const despesas = Number(t.despesas_total || 0);
      if (!r.entregues && !despesas) return null;
      const frete = Number(r.frete_total || 0);
      const lucro = Number(r.lucro_pneus || 0);
      return {
        entregues: Number(r.entregues || 0), frete, lucro, despesas,
        resultado: Math.round((frete + lucro - despesas) * 100) / 100,
        semCusto: Number(r.itens_sem_custo || 0),
      };
    },
    logisticaRotaSelecionada() {
      if (!this.logisticaRotaSelecionadaId) return null;
      return (this.logistica?.rotas_recentes || [])
        .find((t) => t.id === this.logisticaRotaSelecionadaId) || null;
    },
    abrirResultadoRota(t) {
      if (!t?.id || t.status !== 'closed') return;
      this.logisticaTab = 'rotas';
      this.logisticaRotaSelecionadaId = t.id;
      this.$nextTick(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        window.lucide && window.lucide.createIcons();
      });
    },
    voltarParaRotas() {
      this.logisticaRotaSelecionadaId = null;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    rotaResultado(t) {
      const r = t?.resumo;
      if (!r) return null;
      const frete = Number(r.frete_total || 0);
      const lucroPneus = Number(r.lucro_pneus || 0);
      const despesas = Number(t.despesas_total || 0);
      const faturamento = Number(r.faturamento_total ?? (Number(r.faturamento_pneus || 0) + frete));
      const resultado = Math.round((frete + lucroPneus - despesas) * 100) / 100;
      const entregues = Number(r.entregues || 0);
      const comprovantesPendentes = (t.receipts || []).filter((receipt) =>
        receipt.ai_status !== 'parsed' || (receipt.ai_expense_id && receipt.expense_amount == null));
      const semCusto = Number(r.itens_sem_custo || 0);
      return {
        faturamento,
        faturamentoPneus: Number(r.faturamento_pneus || 0),
        custoPneus: Number(r.custo_pneus || 0),
        frete, lucroPneus, despesas, resultado,
        margem: faturamento > 0 ? Math.round((resultado / faturamento) * 1000) / 10 : 0,
        entregues,
        naoEntregues: Number(r.nao_entregues ?? Math.max(Number(t.deliveries_count || 0) - entregues, 0)),
        custoPorEntrega: entregues > 0 ? despesas / entregues : 0,
        resultadoPorEntrega: entregues > 0 ? resultado / entregues : 0,
        semCusto,
        comprovantesPendentes,
        completo: semCusto === 0 && comprovantesPendentes.length === 0,
        pedidos: Array.isArray(t.pedidos_resultado) ? t.pedidos_resultado : [],
        despesasDetalhadas: Array.isArray(t.despesas) ? t.despesas : [],
      };
    },
    rotaResultadoLabel(t) {
      const r = this.rotaResultado(t);
      if (!r) return 'Sem resultado';
      if (!r.completo) return 'Resultado parcial';
      return r.resultado >= 0 ? 'Rota lucrativa' : 'Rota no prejuízo';
    },
    rotaResultadoBadgeClass(t) {
      const r = this.rotaResultado(t);
      if (!r?.completo) return 'bg-amber-50 text-amber-700 border-amber-100';
      return r.resultado >= 0
        ? 'bg-emerald-50 text-emerald-800 border-emerald-100'
        : 'bg-rose-50 text-rose-700 border-rose-100';
    },
    rotaResultadoValorClass(t) {
      return Number(this.rotaResultado(t)?.resultado || 0) >= 0 ? 'text-emerald-700' : 'text-rose-600';
    },
    rotaBarraPercentual(valor, faturamento) {
      const base = Math.max(Math.abs(Number(faturamento || 0)), 1);
      return Math.max(0, Math.min(100, Math.round((Math.abs(Number(valor || 0)) / base) * 100)));
    },
    rotaDataFechamento(t) {
      const value = t?.ended_at || t?.started_at;
      if (!value) return 'data não informada';
      return new Date(value).toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', year: 'numeric',
      });
    },
    logisticaPedidoResultadoLabel(p) {
      if (p?.order_number) return String(p.order_number).startsWith('#') ? p.order_number : `#${p.order_number}`;
      return p?.order_id ? `#${String(p.order_id).slice(0, 8).toUpperCase()}` : '—';
    },
    logisticaDespesaCategoriaLabel(category) {
      const found = (this.despesaCategorias || []).find((item) => item.id === category);
      return found?.label || String(category || 'Despesa');
    },
    logisticaComprovanteStatusLabel(receipt) {
      if (receipt?.ai_status === 'parsed' && receipt.expense_amount != null) return 'Lido e lançado';
      if (receipt?.ai_status === 'unreadable') return 'Revisar leitura';
      if (receipt?.ai_status === 'skipped') return 'Aguardando lançamento';
      return 'Aguardando leitura';
    },
  };
};
