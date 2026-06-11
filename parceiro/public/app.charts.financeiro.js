/**
 * app.charts.financeiro.js - fabrica `chartsFinanceiro` do painel do parceiro (obra <=300, passo 3/11).
 * MORA AQUI: os graficos da aba Financeiro - barras vendas/custos/lucro, donut do
 * split de custos, donut da origem dos pneus e linha de receita 30d. Charts leem
 * `this.*` e pintam no canvas; instancias vivem em window._xxxChart (F5 - NAO mexer).
 * NAO MORA AQUI: graficos do Resumo/Estoque (app.charts.resumo.js) nem do PDV
 * (app.charts.pdv.js). VEIO DE: app.js commit 8445d42, blocos VERBATIM por linha.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.chartsFinanceiro = () => ({
    renderFinanceBarChart() {
      const ctx = document.getElementById('chartFinanceBar');
      if (!ctx) return;
      if (window._financeBarChart) window._financeBarChart.destroy();

      const r = this.resumo || {};
      const result = this.num(r.estimated_result_month);
      window._financeBarChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Vendas', 'Custo pneus', 'Despesas', 'Lucro'],
          datasets: [{
            // Reconcilia: Resultado = Vendas - CMV - Despesas (nao Compras).
            data: [this.num(r.sales_month), this.num(r.cogs_month), this.num(r.expenses_month), result],
            backgroundColor: ['#047857', '#6b7280', '#dc3f4d', result >= 0 ? '#047857' : '#be123c'],
            borderRadius: 5,
            barThickness: 46,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: { label: (ctx) => this.money(ctx.parsed.y) },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#475569', font: { size: 11 } }, border: { display: false } },
            y: { grid: { color: '#e5e7eb' }, ticks: { color: '#475569', callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },

    renderFinanceSplitChart() {
      const ctx = document.getElementById('chartFinanceSplit');
      if (!ctx) return;
      if (window._financeSplitChart) window._financeSplitChart.destroy();

      const split = this.financeCostSplit;
      const totalCostsLabel = this.money(this.totalCusts);
      window._financeSplitChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: split.map((item) => item.label),
          datasets: [{
            data: split.map((item) => item.value),
            backgroundColor: split.map((item) => item.color),
            borderColor: '#ffffff',
            borderWidth: 4,
            hoverBorderColor: '#ffffff',
            radius: '98%',
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '54%',
          layout: { padding: 0 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${this.money(ctx.parsed)}` } },
          },
        },
        plugins: [{
          id: 'financeCostCenterLabel',
          afterDraw(chart) {
            const { ctx: canvasCtx, chartArea } = chart;
            if (!chartArea) return;
            const arc = chart.getDatasetMeta(0).data[0];
            const x = arc?.x ?? (chartArea.left + chartArea.right) / 2;
            const y = arc?.y ?? (chartArea.top + chartArea.bottom) / 2;
            canvasCtx.save();
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            canvasCtx.fillStyle = '#111827';
            canvasCtx.font = '600 20px Inter, system-ui, sans-serif';
            canvasCtx.fillText(totalCostsLabel, x, y - 8);
            canvasCtx.fillStyle = '#64748b';
            canvasCtx.font = '400 12px Inter, system-ui, sans-serif';
            canvasCtx.fillText('Total de custos', x, y + 16);
            canvasCtx.restore();
          },
        }],
      });
    },

    renderFinanceOriginChart() {
      const ctx = document.getElementById('chartFinanceOrigin');
      if (!ctx) return;
      if (window._financeOriginChart) window._financeOriginChart.destroy();

      const split = this.financeOriginSplit;
      const totalUnits = split.reduce((sum, item) => sum + this.num(item.count), 0);
      window._financeOriginChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: split.map((item) => item.label),
          datasets: [{
            data: split.map((item) => item.count),
            backgroundColor: split.map((item) => item.color),
            borderColor: '#ffffff',
            borderWidth: 4,
            hoverBorderColor: '#ffffff',
            radius: '98%',
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '54%',
          layout: { padding: 0 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed} pneus` } },
          },
        },
        plugins: [{
          id: 'financeOriginCenterLabel',
          afterDraw(chart) {
            const { ctx: canvasCtx, chartArea } = chart;
            if (!chartArea) return;
            const arc = chart.getDatasetMeta(0).data[0];
            const x = arc?.x ?? (chartArea.left + chartArea.right) / 2;
            const y = arc?.y ?? (chartArea.top + chartArea.bottom) / 2;
            canvasCtx.save();
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            canvasCtx.fillStyle = '#111827';
            canvasCtx.font = '600 22px Inter, system-ui, sans-serif';
            canvasCtx.fillText(String(totalUnits), x, y - 8);
            canvasCtx.fillStyle = '#64748b';
            canvasCtx.font = '400 12px Inter, system-ui, sans-serif';
            canvasCtx.fillText('Pneus', x, y + 16);
            canvasCtx.restore();
          },
        }],
      });
    },

    renderFinanceUnitsChart() {
      const ctx = document.getElementById('chartFinanceUnits');
      if (!ctx) return;
      if (window._financeUnitsChart) window._financeUnitsChart.destroy();

      const series = this.financeRevenueSeries30d;
      window._financeUnitsChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            data: series.map((d) => d.value),
            borderColor: '#047857',
            backgroundColor: 'rgba(4, 120, 87, 0.12)',
            fill: true,
            tension: 0.35,
            pointRadius: 2.5,
            pointHoverRadius: 4,
            pointBackgroundColor: '#047857',
            borderWidth: 2,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => this.money(ctx.parsed.y) } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#475569', maxTicksLimit: 8, font: { size: 11 } }, border: { display: false } },
            y: { beginAtZero: true, grid: { color: '#e5e7eb' }, ticks: { color: '#475569', callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },
});
