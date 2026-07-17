/**
 * app.financeiro.score.js - fabrica `financeiroScore` do painel do parceiro (obra <=300, passo 9/11).
 * MORA AQUI: a SAUDE DA LOJA - healthChecks/healthScore (checklist do Resumo) e o score
 * financeiro 0-1000 do gauge (financialScore + angulo + nivel + cor por tema + checks +
 * dicas). Le resumo/fluxoCaixa via this; NAO grava nada. A matematica do score e
 * CONTRATO de exibicao: mudar formula = mudar o numero que o dono ve (nao mexer aqui).
 * NAO MORA AQUI: KPIs de leitura (app.financeiro.kpis.js); CRUD de contas.
 * VEIO DE: app.js commit ea22ea3 (range 1092-1255), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.financeiroScore = () => ({
    get healthChecks() {
      const stock = this.stockBreakdown;
      const costPending = this.num(this.resumo?.pending_cost_items_month) > 0
        || this.resumo?.has_pending_cost_month === true;
      const recentStockUpdate = this.estoque.some((item) => {
        if (!item.updated_at) return false;
        return Date.now() - new Date(item.updated_at).getTime() < 7 * 24 * 60 * 60 * 1000;
      });
      return [
        { label: 'Venda registrada hoje',         ok: this.salesTodayCount > 0 },
        costPending
          ? { label: 'Custo histórico pendente', ok: false }
          : { label: 'Resultado mensal positivo', ok: this.num(this.resumo?.estimated_result_month) > 0 },
        { label: 'Estoque cadastrado',            ok: this.num(this.resumo?.stock_items) > 0 },
        { label: 'Sem item zerado',               ok: stock.out_of_stock === 0 },
        { label: 'Estoque atualizado na semana',  ok: recentStockUpdate },
      ];
    },

    get healthScore() {
      const items = this.healthChecks;
      const ok = items.filter((i) => i.ok).length;
      return Math.round((ok / items.length) * 100);
    },

    get financialScore() {
      const sales = this.num(this.resumo?.sales_month);
      const result = this.num(this.resumo?.estimated_result_month);
      const margin = this.estimatedMargin;
      const breakEven = this.totalCusts;
      const cashNet = this.num(this.resumo?.cash_net_month);
      const futureNet = this.num(this.resumo?.net_future_position);
      const overdueIn = this.num(this.fluxoCaixa?.overdue_in);
      const overdueOut = this.num(this.fluxoCaixa?.overdue_out);
      const stockItems = this.num(this.resumo?.stock_items);
      const lowStockItems = this.num(this.resumo?.low_stock_items);
      const costPending = this.num(this.resumo?.pending_cost_items_month) > 0
        || this.resumo?.has_pending_cost_month === true;
      let score = 500;

      if (!costPending) {
        if (result > 0) score += 120;
        if (result < 0) score -= 120;

        if (margin >= 25) score += 140;
        else if (margin >= 15) score += 100;
        else if (margin > 0) score += 50;
        else if (sales > 0) score -= 80;
      }

      if (cashNet >= 0) score += 90;
      else score -= 120;

      if (futureNet >= 0) score += 80;
      else score -= 90;

      if (overdueOut <= 0) score += 80;
      else score -= 150;

      if (overdueIn <= 0) score += 40;
      else score -= 60;

      if (sales > 0) score += 70;
      else score -= 40;

      if (this.avgTicket > 0) score += 45;
      else score -= 20;

      if (!costPending && sales > 0 && breakEven > 0 && sales >= breakEven) score += 70;
      if (!costPending && sales > 0 && breakEven > 0 && sales < breakEven) score -= 70;

      if (stockItems > 0) score += 55;
      else score -= 50;

      if (lowStockItems <= 0) score += 30;
      else score -= Math.min(90, lowStockItems * 30);

      return Math.max(0, Math.min(1000, Math.round(score)));
    },

    get financialScoreAngle() {
      return 180 + ((this.financialScore / 1000) * 180);
    },

    get financialScoreLevel() {
      const score = this.financialScore;
      if (score >= 800) return { label: 'Ótimo', color: 'text-emerald-700', tone: 'bg-emerald-50 border-emerald-100' };
      if (score >= 650) return { label: 'Bom', color: 'text-lime-700', tone: 'bg-lime-50 border-lime-100' };
      if (score >= 500) return { label: 'Regular', color: 'text-amber-700', tone: 'bg-amber-50 border-amber-100' };
      return { label: 'Ruim', color: 'text-rose-700', tone: 'bg-rose-50 border-rose-100' };
    },

    // Cor do arco do gauge: verde (bom) -> amarelo (mais ou menos) -> vermelho (ruim).
    get financialScoreColor() {
      const score = this.financialScore;
      // No tema claro, as faixas vão pra tons mais escuros — verde/amarelo claros somem no fundo branco.
      const light = this.theme === 'light';
      if (score >= 800) return light ? '#059669' : '#10b981'; // verde forte
      if (score >= 650) return light ? '#4d7c0f' : '#84cc16'; // verde
      if (score >= 500) return light ? '#b45309' : '#facc15'; // amarelo/âmbar
      return light ? '#dc2626' : '#ef4444';                   // vermelho
    },

    get financialScoreChecks() {
      const sales = this.num(this.resumo?.sales_month);
      const result = this.num(this.resumo?.estimated_result_month);
      const breakEven = this.totalCusts;
      const overdueOut = this.num(this.fluxoCaixa?.overdue_out);
      const overdueIn = this.num(this.fluxoCaixa?.overdue_in);
      const futureNet = this.num(this.resumo?.net_future_position);
      const stockItems = this.num(this.resumo?.stock_items);
      const lowStockItems = this.num(this.resumo?.low_stock_items);
      const costPending = this.num(this.resumo?.pending_cost_items_month) > 0
        || this.resumo?.has_pending_cost_month === true;

      return [
        {
          label: 'Resultado',
          ok: !costPending && result >= 0,
          value: costPending ? 'Pendente' : this.money(result),
          hint: costPending ? 'Há item vendido sem custo histórico confirmado.' : (result >= 0 ? 'Venda cobre CMV e despesas.' : 'Revise preço, custo ou despesas.'),
        },
        {
          label: 'Margem',
          ok: !costPending && (this.estimatedMargin >= 15 || sales <= 0),
          value: costPending ? 'Pendente' : `${this.estimatedMargin.toFixed(1).replace('.', ',')}%`,
          hint: costPending ? 'A margem não é calculada com custo incompleto.' : (sales <= 0 ? 'Sem vendas no mês.' : (this.estimatedMargin >= 15 ? 'Margem saudável.' : 'Margem baixa para o mês.')),
        },
        {
          label: 'Custo do mês',
          ok: !costPending && (sales >= breakEven || breakEven <= 0),
          value: costPending ? `${this.money(breakEven)} confirmado` : this.money(breakEven),
          hint: costPending ? `${this.num(this.resumo?.pending_cost_items_month)} item(ns) aguardando custo.` : (breakEven <= 0 ? 'Sem custos lançados.' : (sales >= breakEven ? 'Vendas cobrem o custo do mês.' : `Faltam ${this.money(Math.max(0, breakEven - sales))} em vendas.`)),
        },
        {
          label: 'Vencidos',
          ok: overdueOut <= 0 && overdueIn <= 0,
          value: `${this.money(overdueIn)} / ${this.money(overdueOut)}`,
          hint: overdueOut > 0 ? 'Tem conta vencida a pagar.' : (overdueIn > 0 ? 'Tem cliente vencido para cobrar.' : 'Sem vencidos.'),
        },
        {
          label: 'Futuro',
          ok: futureNet >= 0,
          value: this.money(futureNet),
          hint: futureNet >= 0 ? 'A receber cobre o que está em aberto.' : 'Há mais a pagar que a receber.',
        },
        {
          label: 'Estoque',
          ok: stockItems > 0 && lowStockItems <= 0,
          value: `${stockItems} itens`,
          hint: stockItems <= 0 ? 'Cadastre pneus para vender.' : (lowStockItems > 0 ? 'Tem item abaixo do mínimo.' : 'Estoque sem alerta.'),
        },
      ];
    },

    get financialScoreTips() {
      const tips = [];
      const sales = this.num(this.resumo?.sales_month);
      const breakEven = this.totalCusts;
      const overdueOut = this.num(this.fluxoCaixa?.overdue_out);
      const overdueIn = this.num(this.fluxoCaixa?.overdue_in);
      const futureNet = this.num(this.resumo?.net_future_position);
      const lowStockItems = this.num(this.resumo?.low_stock_items);
      const costPending = this.num(this.resumo?.pending_cost_items_month) > 0
        || this.resumo?.has_pending_cost_month === true;

      if (costPending) tips.push(`Confirme o custo histórico de ${this.num(this.resumo?.pending_cost_items_month)} item(ns) vendido(s).`);
      if (overdueOut > 0) tips.push(`Pague ou renegocie ${this.money(overdueOut)} vencidos.`);
      if (overdueIn > 0) tips.push(`Cobre ${this.money(overdueIn)} de clientes vencidos.`);
      if (sales <= 0) tips.push('Registre as vendas do dia para o score sair do modo inicial.');
      if (!costPending && breakEven > 0 && sales < breakEven) tips.push(`Venda mais ${this.money(breakEven - sales)} para cobrir o custo do mês.`);
      if (!costPending && this.estimatedMargin > 0 && this.estimatedMargin < 15) tips.push('Aumente preço ou reduza custo: margem abaixo de 15%.');
      if (futureNet < 0) tips.push('Evite nova compra a prazo até o futuro ficar positivo.');
      if (lowStockItems > 0) tips.push(`Reponha ${lowStockItems} item(ns) abaixo do mínimo.`);
      if (!tips.length) tips.push('Continue registrando vendas, compras e recebimentos no mesmo dia.');
      return tips.slice(0, 3);
    },
});
