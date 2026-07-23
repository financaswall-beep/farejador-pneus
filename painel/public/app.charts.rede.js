// Obra 300 (2026-07-05): fatia do painel da MATRIZ — gráficos da Rede: vendas, lucro, pneus.
// VERBATIM das linhas 2420-2617 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.chartsRede = function () {
  return {
    renderRedeChart() {
      const ctx = document.getElementById('chartRedeVendas');
      if (!ctx) return;
      if (window._redeChart) window._redeChart.destroy();

      window._redeChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: this.redeSeriesLabels(),
          datasets: [
            {
              label: 'Vendas reais da rede',
              data: this.redeSalesSeries(),
              yAxisID: 'y',
              borderColor: '#047857',
              backgroundColor: 'rgba(4,120,87,0.08)',
              tension: 0.35,
              fill: true,
              pointRadius: 4,
              pointBackgroundColor: '#ffffff',
              pointBorderColor: '#047857',
              pointBorderWidth: 2,
            },
            {
              label: 'Meta diária',
              data: this.redeSalesSeries().map(() => this.redeGoalDaily()),
              yAxisID: 'y',
              borderColor: '#6ee7b7',
              borderDash: [6, 5],
              borderWidth: 2,
              pointRadius: 0,
              fill: false,
            },
            {
              label: 'Pedidos reais',
              data: this.redeOrderSeries(),
              yAxisID: 'y1',
              borderColor: '#34d399',
              backgroundColor: 'rgba(52,211,153,0.08)',
              tension: 0.35,
              fill: false,
              pointRadius: 3,
              pointBackgroundColor: '#ffffff',
              pointBorderColor: '#34d399',
              pointBorderWidth: 2,
            },
          ],
        },
        options: {
          ...this.chartOptions('R$ '),
          scales: {
            y: {
              beginAtZero: true,
              position: 'left',
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                callback: (value) => 'R$ ' + Number(value).toLocaleString('pt-BR'),
              },
              border: { display: false },
            },
            y1: {
              beginAtZero: true,
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: {
                precision: 0,
                color: '#059669',
                font: { size: 11 },
              },
              border: { display: false },
            },
            x: {
              grid: { display: false },
              ticks: { color: '#9ca3af', font: { size: 11 } },
              border: { display: false },
            },
          },
        },
      });
    },

    renderRedeLucroChart() {
      const ctx = document.getElementById('chartRedeLucro');
      if (!ctx) return;
      if (window._redeLucroChart) window._redeLucroChart.destroy();

      const parceiros = this.parceirosRede
        .filter((parceiro) => !parceiro.custoPendente && parceiro.lucroEstimado !== null)
        .sort((a, b) => Number(b.lucroEstimado) - Number(a.lucroEstimado));

      window._redeLucroChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: parceiros.map((parceiro) => parceiro.nome.replace('Borracharia ', '').replace('Pneus ', '')),
          datasets: [{
            data: parceiros.map((parceiro) => Number(parceiro.lucroEstimado || 0)),
            backgroundColor: parceiros.map((parceiro) => Number(parceiro.lucroEstimado || 0) >= 0 ? '#10b981' : '#f43f5e'),
            borderRadius: 6,
            barThickness: 16,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: function(ctx) {
                  return Number(ctx.parsed.x || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
                }
              }
            }
          },
          scales: {
            x: {
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                callback: function(value) { return 'R$ ' + Number(value).toLocaleString('pt-BR'); }
              },
              border: { display: false }
            },
            y: {
              grid: { display: false },
              ticks: { color: '#6b7280', font: { size: 11 } },
              border: { display: false }
            }
          }
        },
      });
    },

    renderPneusRedeChart() {
      const ctx = document.getElementById('chartPneusRede');
      if (!ctx) return;
      if (window._pneusRedeChart) window._pneusRedeChart.destroy();

      const itens = this.pneusMaisVendidosRede();
      const maxValor = Math.max(...itens.map((i) => i.quantidade), 1);
      const totalVendidos = itens.reduce((sum, item) => sum + Number(item.quantidade || 0), 0);

      window._pneusRedeChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: itens.map((i) => i.pneu),
          datasets: [{
            data: itens.map((i) => i.quantidade),
            backgroundColor: itens.map((i, idx) => idx === 0 ? '#059669' : '#a7f3d0'),
            borderRadius: 6,
            barThickness: 18,
          }],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111827',
              padding: 10,
              callbacks: {
                label: (ctx) => {
                  const pct = totalVendidos > 0 ? Math.round((ctx.parsed.x / totalVendidos) * 100) : 0;
                  return `${ctx.parsed.x} pneus vendidos (${pct}% do top)`;
                },
              },
            },
          },
          scales: {
            x: {
              max: maxValor,
              grid: { color: '#f3f4f6' },
              ticks: {
                color: '#9ca3af',
                font: { size: 11 },
                stepSize: 1,
                precision: 0,
              },
              border: { display: false },
            },
            y: {
              grid: { display: false },
              ticks: {
                color: '#374151',
                font: { size: 12, weight: '500' },
              },
              border: { display: false },
            },
          },
        },
      });
    },

  };
};
