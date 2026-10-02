// Marketing — gráfico diário de investimento e conversas, isolado do estado da visão.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

window.PAINEL_MODULES.marketingChart = function () {
  return {
    renderMarketingChart() {
      this.renderMarketingSeries({ canvasId: 'chartMarketingRhythm', chartKey: '_marketingRhythmChart',
        rows: this.paidChartRows(), seriesKey: 'conversations', seriesLabel: 'Conversas na Meta' });
    },
    renderMarketingSeries({ canvasId, chartKey, rows, seriesKey, seriesLabel }) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || typeof Chart === 'undefined') return;
      if (window[chartKey]) window[chartKey].destroy();
      window[chartKey] = null;
      if (!rows.length) return;
      const safe = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      };
      window[chartKey] = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: rows.map((row) => this.marketingDateLabel(row.date)),
          datasets: [
            {
              label: 'Investimento (R$)',
              type: 'bar',
              data: rows.map((row) => safe(row.spend)),
              yAxisID: 'investment',
              borderColor: '#99d9c6',
              backgroundColor: 'rgba(115,199,172,0.65)',
              borderWidth: 0,
              borderRadius: 3,
              maxBarThickness: 20,
              tension: 0.28,
              fill: true,
              pointRadius: 2.5,
              pointBackgroundColor: '#047857',
              pointBorderColor: '#047857',
              pointBorderWidth: 1,
            },
            {
              label: seriesLabel,
              type: 'line',
              data: rows.map((row) => safe(row[seriesKey])),
              yAxisID: 'conversations',
              borderColor: '#005e4c',
              borderWidth: 2,
              tension: 0.28,
              pointRadius: 3,
              pointBackgroundColor: '#005e4c',
              fill: false,
            },
          ],
        },
        options: {
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              titleFont: { size: 11 },
              bodyFont: { size: 12, weight: '600' },
              callbacks: {
                label: (context) => context.dataset.yAxisID === 'investment'
                  ? `Investimento: ${Number(context.parsed.y || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`
                  : `${seriesLabel}: ${Number(context.parsed.y || 0).toLocaleString('pt-BR')}`,
              },
            },
          },
          scales: {
            investment: {
              beginAtZero: true,
              position: 'left',
              grid: { color: '#e5e7eb' },
              ticks: {
                color: '#64748b',
                font: { size: 10 },
                callback: (value) => `R$ ${Number(value).toLocaleString('pt-BR')}`,
              },
              border: { display: false },
            },
            conversations: {
              beginAtZero: true,
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: { color: '#059669', font: { size: 10 }, precision: 0 },
              border: { display: false },
            },
            x: {
              grid: { display: false },
              ticks: {
                autoSkip: true,
                maxTicksLimit: 7,
                maxRotation: 0,
                color: '#64748b',
                font: { size: 10 },
              },
              border: { display: false },
            },
          },
        },
      });
    },
  };
};
