// Obra 300 (2026-07-05): fatia do painel da MATRIZ — gráficos da unidade + chartOptions + renderChart genérico.
// VERBATIM das linhas 2852-3000 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.chartsUnidade = function () {
  return {
    renderVendaHojeChart() {
      const ctx = document.getElementById('chartVendaHoje');
      if (!ctx) return;
      if (window._vendaHojeChart) window._vendaHojeChart.destroy();

      const total = this.parceirosRede.length;
      const semVenda = this.unidadesSemVendaHoje().length;
      const comVenda = total - semVenda;

      window._vendaHojeChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Venderam hoje', 'Sem venda hoje'],
          datasets: [{
            data: [comVenda, semVenda],
            backgroundColor: ['#10b981', '#f43f5e'],
            borderWidth: 0,
            hoverOffset: 4,
          }],
        },
        options: {
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 8,
              callbacks: {
                label: (ctx) => `${ctx.label}: ${ctx.parsed} unidades`,
              },
            },
          },
        },
      });
    },

    renderParceiroChart() {
      const ctx = document.getElementById('chartParceiroVendas');
      const parceiro = this.selectedParceiro();
      if (!ctx || !parceiro) return;
      if (window._parceiroChart) window._parceiroChart.destroy();

      window._parceiroChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Hoje'],
          datasets: [{
            label: parceiro.nome,
            data: parceiro.serieVendas,
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37,99,235,0.07)',
            tension: 0.35,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#2563eb',
            pointBorderWidth: 2,
          }],
        },
        options: this.chartOptions('R$ '),
      });
    },

    chartOptions(prefix = '') {
      return {
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#111827',
            padding: 10,
            titleFont: { size: 11 },
            bodyFont: { size: 12, weight: '600' },
            callbacks: {
              label: function(ctx) { return prefix + Number(ctx.parsed.y || 0).toLocaleString('pt-BR'); }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#9ca3af', font: { size: 11 } },
            border: { display: false }
          },
          y: {
            grid: { color: '#f3f4f6' },
            ticks: { color: '#9ca3af', font: { size: 11 } },
            border: { display: false }
          }
        }
      };
    },

    renderChart() {
      const ctx = document.getElementById('chartPerformance');
      if (!ctx) return;
      if (window._perfChart) window._perfChart.destroy();

      const fmtDia = (d) => {
        const dt = new Date(d);
        return Number.isFinite(dt.getTime()) ? dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : String(d);
      };
      window._perfChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: this.resumoSeries.map((s) => fmtDia(s.dia)),
          datasets: [{
            data: this.resumoSeries.map((s) => s.faturamento),
            borderColor: '#111827',
            backgroundColor: 'rgba(17,24,39,0.05)',
            tension: 0.35,
            fill: true,
            pointRadius: 4,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#111827',
            pointBorderWidth: 2,
            pointHoverRadius: 6
          }]
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              titleFont: { size: 11 },
              bodyFont: { size: 12, weight: '600' },
              callbacks: {
                label: (item) => this.formatCurrency(item.parsed.y)
              }
            }
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false }
            },
            y: {
              grid: { color: '#f3f4f6' },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false }
            }
          }
        }
      });
    }
  };
};
