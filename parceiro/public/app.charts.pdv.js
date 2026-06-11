/**
 * app.charts.pdv.js - fabrica `chartsPdv` do painel do parceiro (obra <=300, passo 3/11).
 * MORA AQUI: os graficos da tela PDV - sparkline de vendas de hoje, linha de vendas
 * 30d (RevenuePos) e donut de custos (CostsPos); os 3 reagem ao tema claro/escuro
 * (this.theme). Charts leem `this.*` e pintam no canvas; instancias vivem em
 * window._xxxChart (F5 - NAO mexer).
 * NAO MORA AQUI: o maestro renderAllCharts (app.charts.resumo.js). Estes 3 sao os
 * unicos renders vivos (F9 apagou os 8 orfaos). VEIO DE: app.js commit 8445d42, VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.chartsPdv = () => ({
    renderPosSparkline() {
      const ctx = document.getElementById('chartPosSpark');
      if (!ctx) return;
      if (window._posSparkChart) window._posSparkChart.destroy();

      const series = this.posSalesTodayHourly;
      window._posSparkChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            data: series.map((d) => d.value),
            borderColor: this.theme === 'light' ? '#1e40af' : '#facc15',
            backgroundColor: this.theme === 'light' ? 'rgba(30,64,175,.12)' : 'rgba(250,204,21,.12)',
            borderWidth: 2,
            tension: .35,
            pointRadius: 0,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      });
    },

    renderFinanceRevenuePosChart() {
      const ctx = document.getElementById('chartFinanceRevenuePos');
      if (!ctx) return;
      if (window._financeRevenuePosChart) window._financeRevenuePosChart.destroy();

      const series = this.financeRevenueSeries30d;
      const light = this.theme === 'light';
      window._financeRevenuePosChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: series.map((d) => d.label),
          datasets: [{
            label: 'Vendas',
            data: series.map((d) => d.value),
            borderColor: light ? '#1e40af' : '#ffd000',
            backgroundColor: light ? 'rgba(30, 64, 175, 0.10)' : 'rgba(255, 208, 0, 0.14)',
            fill: true,
            tension: 0.36,
            pointRadius: 2.4,
            pointHoverRadius: 4,
            pointBackgroundColor: light ? '#1e40af' : '#ffd000',
            borderWidth: 2,
          }],
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: light ? '#0f172a' : '#05080b',
              borderColor: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.12)',
              borderWidth: 1,
              padding: 10,
              callbacks: { label: (item) => this.money(item.parsed.y) },
            },
          },
          scales: {
            x: { grid: { display: false }, ticks: { color: light ? '#64748b' : '#8b949e', maxTicksLimit: 7, font: { size: 11 } }, border: { color: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.1)' } },
            y: {
              beginAtZero: true,
              grid: { color: light ? 'rgba(15,23,42,.08)' : 'rgba(255,255,255,.07)' },
              ticks: { color: light ? '#64748b' : '#8b949e', callback: (v) => 'R$ ' + Number(v).toLocaleString('pt-BR') },
              border: { display: false },
            },
          },
        },
      });
    },

    renderFinanceCostsPosChart() {
      const ctx = document.getElementById('chartFinanceCostsPos');
      if (!ctx) return;
      if (window._financeCostsPosChart) window._financeCostsPosChart.destroy();

      const split = this.financeCostSplit;
      const totalCostsLabel = this.money(this.totalCusts);
      const light = this.theme === 'light';
      window._financeCostsPosChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: split.map((item) => item.label),
          datasets: [{
            data: split.map((item) => item.value),
            backgroundColor: split.map((item) => item.color === '#dc3f4d' ? '#c94b57' : item.color),
            borderColor: light ? '#ffffff' : '#11161b',
            borderWidth: 5,
            hoverBorderColor: light ? '#ffffff' : '#11161b',
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '68%',
          layout: { padding: { bottom: 8 } },
          plugins: {
            legend: { position: 'bottom', labels: { color: light ? '#475569' : '#d1d5db', boxWidth: 10, padding: 14, font: { size: 11 } } },
            tooltip: {
              backgroundColor: light ? '#0f172a' : '#05080b',
              borderColor: light ? 'rgba(15,23,42,.12)' : 'rgba(255,255,255,.12)',
              borderWidth: 1,
              padding: 10,
              callbacks: { label: (item) => `${item.label}: ${this.money(item.parsed)}` },
            },
          },
        },
        plugins: [{
          id: 'financeCostsPosCenterLabel',
          afterDraw(chart) {
            const { ctx: canvasCtx, chartArea } = chart;
            if (!chartArea) return;
            const meta = chart.getDatasetMeta(0);
            const arc = meta.data && meta.data[0];
            // Centro do donut: usar coordenadas do próprio arco quando disponíveis
            // (Chart.js já considera o espaço reservado pra legenda). Fallback pro
            // centro do chartArea.
            const cx = (arc && typeof arc.x === 'number')
              ? arc.x
              : (chartArea.left + chartArea.right) / 2;
            const cy = (arc && typeof arc.y === 'number')
              ? arc.y
              : (chartArea.top + chartArea.bottom) / 2;
            canvasCtx.save();
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            // Offsets simétricos em torno de cy para o bloco (valor + rótulo)
            // ficar visualmente centralizado no buraco do donut.
            canvasCtx.fillStyle = light ? '#0f172a' : '#f8fafc';
            canvasCtx.font = '700 15px Inter, system-ui, sans-serif';
            canvasCtx.fillText(totalCostsLabel, cx, cy - 9);
            canvasCtx.fillStyle = light ? '#64748b' : '#9ca3af';
            canvasCtx.font = '400 10px Inter, system-ui, sans-serif';
            canvasCtx.fillText('Custos', cx, cy + 9);
            canvasCtx.restore();
          },
        }],
      });
    },
});
