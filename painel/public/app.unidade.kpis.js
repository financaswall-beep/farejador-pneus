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
      if (typeof tipo === 'string' && tipo.startsWith('Pedido')) return 'bg-indigo-50 text-indigo-700';
      if (tipo === 'Compra pneus') return 'bg-blue-50 text-blue-700';
      if (tipo === 'Pagamento funcionário') return 'bg-purple-50 text-purple-700';
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
        { label: 'Resultado positivo', ok: Number(parceiro.lucroEstimado || 0) >= 0, peso: 20 },
        { label: 'Vendeu hoje', ok: this.parceiroVendaHojeValor(parceiro) > 0, peso: 15 },
        { label: 'Estoque atualizado', ok: Number(parceiro.diasSemAtualizar ?? 99) <= 3, peso: 15 },
        { label: 'Estoque saudável', ok: estoqueItens.length > 0 && !estoqueItens.some((item) => ['zerado', 'baixo'].includes(item.status)), peso: 15 },
        { label: 'Margem boa', ok: margemValor >= 20, peso: 15 },
        { label: 'Custos registrados', ok: Number(parceiro.comprasPneus || 0) > 0 || Number(parceiro.despesasExtras || 0) > 0 || Number(parceiro.folha || 0) > 0, peso: 10 },
        { label: 'Parceria 2W ativa', ok: Number(parceiro.vendas2w || 0) > 0, peso: 10 },
      ];
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

    // ─── AÇÕES ──────────────────────────────────────
  };
};
