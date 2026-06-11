/**
 * app.charts.resumo.js - fabrica `chartsResumo` do painel do parceiro (obra <=300, passo 3/11).
 * MORA AQUI: o maestro renderAllCharts (unico ponto que repinta TUDO: init, troca de
 * tema, resize, loadData) + os graficos das abas Resumo (vendas 7d, resultado do mes)
 * e Estoque (composicao, entradas/saidas). Charts leem `this.*` e pintam no canvas;
 * instancias vivem em window._xxxChart (F5 do plano - NAO mexer).
 * NAO MORA AQUI: graficos do Financeiro (app.charts.financeiro.js) nem do PDV
 * (app.charts.pdv.js). VEIO DE: app.js commit 8445d42, blocos VERBATIM por linha.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.chartsResumo = () => ({
    renderAllCharts() {
      this.renderPosSparkline();
      this.renderSalesTrendChart();
      this.renderResultChart();
      this.renderStockChart();
      this.renderStockMovementChart();
      this.renderFinanceBarChart();
      this.renderFinanceSplitChart();
      this.renderFinanceOriginChart();
      this.renderFinanceUnitsChart();
      this.renderFinanceRevenuePosChart();
      this.renderFinanceCostsPosChart();
    },

    renderSalesTrendChart() {
      const ctx = document.getElementById('chartSalesTrend');
      if (!ctx) return;
      if (window._salesTrendChart) window._salesTrendChart.destroy();

      const series = this.salesSeries7d;
      const total = series.reduce((s, d) => s + d.value, 0);
      if (!total) {
        window._salesTrendChart = new Chart(ctx, {
          type: 'bar',
          data: { labels: series.map((d) => d.label), datasets: [{ data: series.map(() => 0), backgroundColor: '#e5e7eb', borderRadius: 6 }] },
          options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#9ca3af', font: { size: 11 } } }, y: { display: false } } },
        });
        return;
      }

      window._salesTrendChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            data: series.map((d) => d.value),
            backgroundColor: '#10b981',
            borderRadius: 6,
            barThickness: 18,
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
            x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 11 } }, border: { display: false } },
            y: { grid: { color: '#f3f4f6' }, ticks: { color: '#9ca3af', font: { size: 11 }, callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },

    renderResultChart() {
      const ctx = document.getElementById('chartResult');
      if (!ctx) return;
      if (window._resultChart) window._resultChart.destroy();

      const r = this.resumo || {};
      const result = this.num(r.estimated_result_month);
      // Reconcilia com o resultado: Saldo = Vendas - CMV - Despesas (nao Compras).
      const data = [this.num(r.sales_month), this.num(r.cogs_month), this.num(r.expenses_month), result];

      window._resultChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['Vendas', 'Custo pneus', 'Despesas', 'Lucro'],
          datasets: [{
            data,
            backgroundColor: ['#3b82f6', '#f59e0b', '#ef4444', result >= 0 ? '#10b981' : '#e11d48'],
            borderRadius: 6,
            barThickness: 28,
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
            x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 11 } }, border: { display: false } },
            y: { grid: { color: '#f3f4f6' }, ticks: { color: '#9ca3af', font: { size: 11 }, callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') }, border: { display: false } },
          },
        },
      });
    },

    renderStockChart() {
      const ctx = document.getElementById('chartStock');
      if (!ctx) return;
      if (window._stockChart) window._stockChart.destroy();

      const s = this.stockBreakdown;
      const data = [s.in_stock, s.low_stock, s.out_of_stock, s.not_tracked, s.unknown];
      const total = data.reduce((sum, v) => sum + v, 0);

      window._stockChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Ok', 'Baixo', 'Zerado', 'Não controlado', 'Desconhecido'],
          datasets: [{
            data,
            backgroundColor: ['#10b981', '#f59e0b', '#ef4444', '#94a3b8', '#cbd5e1'],
            borderWidth: 0,
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '60%',
          plugins: {
            legend: { position: 'right', labels: { color: '#374151', font: { size: 11 }, boxWidth: 10, padding: 10 } },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => total > 0 ? `${ctx.label}: ${ctx.parsed} (${Math.round(ctx.parsed / total * 100)}%)` : `${ctx.label}: 0`,
              },
            },
          },
        },
      });
    },

    renderStockMovementChart() {
      const ctx = document.getElementById('chartStockMovement');
      if (!ctx) return;
      if (window._stockMovementChart) window._stockMovementChart.destroy();
      const series = this.stockMovementSeries;
      window._stockMovementChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: series.map((item) => item.label),
          datasets: [
            { label: 'Entradas', data: series.map((item) => item.entradas), backgroundColor: '#047857', borderRadius: 4 },
            { label: 'Saídas', data: series.map((item) => item.saidas), backgroundColor: '#94a3b8', borderRadius: 4 },
          ],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', align: 'end', labels: { boxWidth: 10, color: '#475569', font: { size: 11 } } },
            tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y} un.` } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 } }, border: { display: false } },
            y: { beginAtZero: true, grid: { color: '#e5e7eb' }, ticks: { precision: 0, color: '#64748b' }, border: { display: false } },
          },
        },
      });
    },
});
