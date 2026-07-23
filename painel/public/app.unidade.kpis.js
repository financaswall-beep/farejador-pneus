// Obra 300 (2026-07-05): fatia do painel da MATRIZ — derivadas da unidade + classes de status + saúde (score).
// VERBATIM das linhas 456-549 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.unidadeKpis = function () {
  return {
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
      return Number(parceiro.cogsValor || 0) + Number(parceiro.folha || 0) + Number(parceiro.despesasExtras || 0);
    },

    parceiroLucroClass(parceiro = this.selectedParceiro()) {
      if (parceiro?.custoPendente) return 'text-amber-700';
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
      if (typeof tipo === 'string' && tipo.startsWith('Pedido')) return 'bg-teal-50 text-teal-700';
      if (tipo === 'Compra pneus') return 'bg-emerald-50 text-emerald-700';
      if (tipo === 'Pagamento funcionário') return 'bg-slate-100 text-slate-700';
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
      const checks = [
        { label: 'Vendeu hoje', ok: this.parceiroVendaHojeValor(parceiro) > 0, peso: 15 },
        { label: 'Estoque atualizado', ok: Number(parceiro.diasSemAtualizar ?? 99) <= 3, peso: 15 },
        { label: 'Estoque saudável', ok: estoqueItens.length > 0 && !estoqueItens.some((item) => ['zerado', 'baixo'].includes(item.status)), peso: 15 },
        { label: 'Custos registrados', ok: Number(parceiro.comprasPneus || 0) > 0 || Number(parceiro.despesasExtras || 0) > 0 || Number(parceiro.folha || 0) > 0, peso: 10 },
        { label: 'Parceria 2W ativa', ok: Number(parceiro.vendas2w || 0) > 0, peso: 10 },
      ];
      if (parceiro.custoPendente) {
        checks.unshift({ label: 'Custo histórico confirmado', ok: false, peso: 35 });
      } else {
        checks.unshift({ label: 'Resultado positivo', ok: Number(parceiro.lucroEstimado || 0) >= 0, peso: 20 });
        checks.push({ label: 'Margem boa', ok: margemValor >= 20, peso: 15 });
      }
      // Nota do cliente (0105/0131): só entra quando HÁ amostra — o único sinal que o
      // parceiro não falsifica. Sem nota ainda → o check não aparece (não pune a amostra
      // vazia; o saudeScore normaliza pelos pesos presentes).
      if (Number(parceiro.satisfacaoCount || 0) > 0) {
        checks.push({
          label: `Cliente satisfeito (${Number(parceiro.satisfacaoNota).toFixed(1)}⭐, ${parceiro.satisfacaoCount})`,
          ok: Number(parceiro.satisfacaoNota || 0) >= 4, peso: 20,
        });
      }
      return checks;
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

    unidadeEstoqueFiltrado(parceiro = this.selectedParceiro()) {
      let rows = parceiro?.estoqueItens || [];
      if (this.unidadeStockFiltro === 'baixo') rows = rows.filter((item) => item.status === 'baixo');
      if (this.unidadeStockFiltro === 'zerado') rows = rows.filter((item) => item.status === 'zerado');
      if (this.unidadeStockFiltro === 'nao_controlado') rows = rows.filter((item) => item.qtd === null);
      const term = String(this.unidadeStockBusca || '').trim().toLocaleLowerCase('pt-BR');
      if (!term) return rows;
      return rows.filter((item) => [item.pneu, item.fornecedor]
        .some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(term)));
    },

    unidadeEstoqueQuantidade(parceiro = this.selectedParceiro()) {
      return (parceiro?.estoqueItens || []).reduce((sum, item) =>
        sum + (item.qtd === null ? 0 : Number(item.qtd || 0)), 0);
    },

    unidadeEstoqueValor(parceiro = this.selectedParceiro()) {
      return (parceiro?.estoqueItens || []).reduce((sum, item) =>
        sum + (item.qtd === null ? 0 : Number(item.qtd || 0) * Number(item.custoValor || 0)), 0);
    },

    unidadeEstoqueCritico(parceiro = this.selectedParceiro()) {
      return (parceiro?.estoqueItens || []).filter((item) => ['baixo', 'zerado'].includes(item.status)).length;
    },

    unidadeLancamentosFiltrados(parceiro = this.selectedParceiro()) {
      const rows = parceiro?.lancamentos || [];
      if (this.unidadeLancamentoFiltro === 'vendas') return rows.filter((item) => item.tipo === 'Venda');
      if (this.unidadeLancamentoFiltro === 'pedidos') return rows.filter((item) => item.pendente);
      if (this.unidadeLancamentoFiltro === 'compras') return rows.filter((item) => item.tipo === 'Compra pneus');
      if (this.unidadeLancamentoFiltro === 'despesas') {
        return rows.filter((item) => ['Pagamento funcionário', 'Despesa extra'].includes(item.tipo));
      }
      return rows;
    },

    unidadeEntradasValor(parceiro = this.selectedParceiro()) {
      return (parceiro?.lancamentos || []).reduce((sum, item) =>
        sum + (!item.pendente && Number(item.valor || 0) > 0 ? Number(item.valor || 0) : 0), 0);
    },

    unidadeSaidasValor(parceiro = this.selectedParceiro()) {
      return (parceiro?.lancamentos || []).reduce((sum, item) =>
        sum + (Number(item.valor || 0) < 0 ? Math.abs(Number(item.valor || 0)) : 0), 0);
    },

    unidadePedidosEmCurso(parceiro = this.selectedParceiro()) {
      return (parceiro?.lancamentos || []).filter((item) => item.pendente).length;
    },

    unidadeSaldoOperacional(parceiro = this.selectedParceiro()) {
      return this.unidadeEntradasValor(parceiro) - this.unidadeSaidasValor(parceiro);
    },

    // ─── AÇÕES ──────────────────────────────────────
  };
};
