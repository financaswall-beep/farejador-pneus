// Fatia 07-14 (fiscal 300): sub-aba INDICADORES do Financeiro da matriz — fluxo de
// caixa (projeção 7/30/90 por vencimento), análise atual e inadimplência.
// VERBATIM do app.financeiro.js pós-redesign 07-13 (commit 116d712); zero régua nova —
// tudo derivado do payload de getMatrizFinanceiroVisao. O giro em VEZES vem PRONTO do
// servidor (indicadores.giro_vezes, 07-12c) — não recalcular na UI (prova V6a crava lá).
// Montado via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.financeiroIndicadores = function () {
  return {
    // Sub-aba Indicadores: somente derivados do payload financeiro real.
    // Não cria série histórica nem prazo médio que o backend ainda não mede.
    finIndicadoresPainel() {
      const v = this.financeiroVisao;
      if (!v) return null;
      const m = v.mes;
      const ind = v.indicadores;
      const faturamento = Number(m.faturamento || 0);
      const custo = Number(m.custo || 0);
      const despesas = Number(m.despesas || 0);
      const lucro = Number(m.lucro || 0);
      const margem = m.margem_pct === null ? null : Number(m.margem_pct);
      const pontoEquilibrio = ind.ponto_equilibrio === null ? null : Number(ind.ponto_equilibrio);
      const pontoPct = pontoEquilibrio && pontoEquilibrio > 0
        ? Math.round((faturamento / pontoEquilibrio) * 1000) / 10
        : null;
      const receber = Number(v.a_receber.total || 0);
      const pagar = Number(v.a_pagar.total || 0);
      const saldoAberto = receber - pagar;
      const cobertura = pagar > 0 ? Math.round((receber / pagar) * 100) / 100 : null;
      const maxResultado = Math.max(faturamento, custo, despesas, Math.abs(lucro), 1);
      const resultados = [
        { label: 'Faturamento', valor: faturamento, pct: (faturamento / maxResultado) * 100, cls: 'bg-emerald-700' },
        { label: 'Custo dos pneus', valor: custo, pct: (custo / maxResultado) * 100, cls: 'bg-gray-400' },
        { label: 'Despesas', valor: despesas, pct: (despesas / maxResultado) * 100, cls: 'bg-rose-400' },
        { label: lucro >= 0 ? 'Lucro' : 'Prejuízo', valor: lucro, pct: (Math.abs(lucro) / maxResultado) * 100, cls: lucro >= 0 ? 'bg-emerald-500' : 'bg-rose-600' },
      ];
      const fontesBase = [
        { label: 'Atacado', valor: Number(m.pernas.atacado.faturamento || 0), lucro: Number(m.pernas.atacado.lucro || 0) },
        { label: 'Varejo (bot + balcão)', valor: Number(m.pernas.varejo.faturamento || 0), lucro: Number(m.pernas.varejo.lucro || 0) },
        { label: 'Frete', valor: Number(m.pernas.frete?.recebido || 0), lucro: Number(m.pernas.frete?.recebido || 0) },
        { label: 'Comissão da rede', valor: Number(m.pernas.comissao?.realizado || 0), lucro: Number(m.pernas.comissao?.realizado || 0) },
      ];
      const fontes = fontesBase.map((item) => {
        const margemFonte = this.finPctLucro(item.valor, item.lucro);
        return { ...item, margem: margemFonte, barra: margemFonte === null ? 0 : Math.max(0, Math.min(100, margemFonte)) };
      });
      const vencidos = Number(v.a_receber.vencidos_count || 0) + Number(v.a_pagar.vencidos_count || 0);
      const saudavel = lucro >= 0 && (pontoPct === null || pontoPct >= 100) && vencidos === 0;
      const critico = lucro < 0;
      const saude = {
        label: critico ? 'Resultado negativo' : saudavel ? 'Saudável' : 'Pede atenção',
        cls: critico ? 'text-rose-600' : saudavel ? 'text-emerald-700' : 'text-amber-600',
        bg: critico ? 'bg-rose-50' : saudavel ? 'bg-emerald-50' : 'bg-amber-50',
      };
      return {
        lucro, margem, pontoEquilibrio, pontoPct,
        receber, pagar, saldoAberto, cobertura, resultados, fontes, vencidos, saude,
      };
    },
    // Indicadores > Fluxo de caixa: projecao honesta feita somente com titulos
    // abertos que ja possuem vencimento. Nao chama resultado de saldo bancario.
    finFluxoItens() {
      const v = this.financeiroVisao;
      if (!v) return [];
      const receber = (v.a_receber.itens || []).map((item) => ({
        ...item,
        direcao: 'entrada',
        origem: item.tipo === 'comissao' ? 'Comissao da rede' : 'Venda atacado',
        descricao: item.nome,
        dias: this.cobrancaDias(item.due_date),
      }));
      const pagar = (v.a_pagar.itens || []).map((item) => ({
        ...item,
        direcao: 'saida',
        origem: item.tipo === 'despesa' ? 'Despesa da Matriz' : 'Fornecedor',
        descricao: item.nome,
        dias: this.cobrancaDias(item.due_date),
      }));
      return [...receber, ...pagar].sort((a, b) => {
        if (a.dias === null && b.dias === null) return Number(b.valor) - Number(a.valor);
        if (a.dias === null) return 1;
        if (b.dias === null) return -1;
        return a.dias - b.dias || Number(b.valor) - Number(a.valor);
      });
    },
    finFluxoStatus(item) {
      if (item.dias === null) return { label: 'Sem vencimento', cls: 'bg-gray-100 text-gray-600' };
      if (item.dias < 0) return { label: 'Vencido', cls: 'bg-rose-50 text-rose-600' };
      if (item.dias === 0) return { label: 'Vence hoje', cls: 'bg-amber-50 text-amber-700' };
      if (item.dias <= 7) return { label: 'Proximos 7 dias', cls: 'bg-emerald-50 text-emerald-700' };
      return { label: 'Previsto', cls: 'bg-gray-100 text-gray-600' };
    },
    finFluxoPainel() {
      const v = this.financeiroVisao;
      if (!v) return null;
      const horizonte = [7, 30, 90].includes(Number(this.finFluxoDias)) ? Number(this.finFluxoDias) : 30;
      const itens = this.finFluxoItens();
      const noHorizonte = itens.filter((item) => item.dias !== null && item.dias <= horizonte);
      const entradas = noHorizonte.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0);
      const saidas = noHorizonte.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0);
      const resultado = Number(v.mes.lucro || 0);
      const impacto = entradas - saidas;
      const defs = horizonte === 7
        ? [
            { label: 'Vencidos', min: -Infinity, max: -1 },
            { label: 'Hoje', min: 0, max: 0 },
            { label: '1 a 3 dias', min: 1, max: 3 },
            { label: '4 a 7 dias', min: 4, max: 7 },
          ]
        : horizonte === 90
          ? [
              { label: 'Vencidos', min: -Infinity, max: -1 },
              { label: 'Hoje', min: 0, max: 0 },
              { label: '1 a 7 dias', min: 1, max: 7 },
              { label: '8 a 30 dias', min: 8, max: 30 },
              { label: '31 a 60 dias', min: 31, max: 60 },
              { label: '61 a 90 dias', min: 61, max: 90 },
            ]
          : [
              { label: 'Vencidos', min: -Infinity, max: -1 },
              { label: 'Hoje', min: 0, max: 0 },
              { label: '1 a 7 dias', min: 1, max: 7 },
              { label: '8 a 15 dias', min: 8, max: 15 },
              { label: '16 a 30 dias', min: 16, max: 30 },
            ];
      const buckets = defs.map((def) => {
        const rows = itens.filter((item) => item.dias !== null && item.dias >= def.min && item.dias <= def.max);
        return {
          label: def.label,
          entrada: rows.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0),
          saida: rows.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0),
        };
      });
      const semData = itens.filter((item) => item.dias === null);
      buckets.push({
        label: 'Sem data',
        entrada: semData.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0),
        saida: semData.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0),
      });
      const maxBar = Math.max(1, ...buckets.flatMap((b) => [b.entrada, b.saida]));
      for (const bucket of buckets) {
        bucket.entradaPct = bucket.entrada > 0 ? Math.max(5, Math.round((bucket.entrada / maxBar) * 100)) : 0;
        bucket.saidaPct = bucket.saida > 0 ? Math.max(5, Math.round((bucket.saida / maxBar) * 100)) : 0;
      }
      const vencidos = itens.filter((item) => item.dias !== null && item.dias < 0);
      const amanha = itens.filter((item) => item.dias === 1);
      return {
        horizonte, resultado, entradas, saidas, impacto,
        buckets,
        movimentos: itens.filter((item) => item.dias === null || item.dias <= horizonte).slice(0, 8),
        vencidosTotal: vencidos.reduce((s, item) => s + Number(item.valor || 0), 0),
        vencidosCount: vencidos.length,
        amanhaTotal: amanha.reduce((s, item) => s + Number(item.valor || 0), 0),
        amanhaCount: amanha.length,
        semDataTotal: semData.reduce((s, item) => s + Number(item.valor || 0), 0),
        semDataCount: semData.length,
      };
    },
    finAtrasosPainel() {
      const itens = this.finFluxoItens().filter((item) => item.dias !== null && item.dias < 0);
      const defs = [
        { label: '1 a 7 dias', min: 1, max: 7 },
        { label: '8 a 30 dias', min: 8, max: 30 },
        { label: 'Mais de 30 dias', min: 31, max: Infinity },
      ];
      const faixas = defs.map((def) => {
        const rows = itens.filter((item) => -item.dias >= def.min && -item.dias <= def.max);
        const receber = rows.filter((item) => item.direcao === 'entrada').reduce((s, item) => s + Number(item.valor || 0), 0);
        const pagar = rows.filter((item) => item.direcao === 'saida').reduce((s, item) => s + Number(item.valor || 0), 0);
        return { label: def.label, receber, pagar, count: rows.length };
      });
      const max = Math.max(1, ...faixas.flatMap((f) => [f.receber, f.pagar]));
      for (const faixa of faixas) {
        faixa.receberPct = faixa.receber > 0 ? Math.max(3, Math.round((faixa.receber / max) * 100)) : 0;
        faixa.pagarPct = faixa.pagar > 0 ? Math.max(3, Math.round((faixa.pagar / max) * 100)) : 0;
      }
      const receber = itens.filter((item) => item.direcao === 'entrada');
      const pagar = itens.filter((item) => item.direcao === 'saida');
      return {
        faixas,
        receberTotal: receber.reduce((s, item) => s + Number(item.valor || 0), 0),
        receberCount: receber.length,
        pagarTotal: pagar.reduce((s, item) => s + Number(item.valor || 0), 0),
        pagarCount: pagar.length,
        itens,
      };
    },
  };
};
