// Obra 300 (2026-07-05): fatia do painel da MATRIZ — gráficos da Rede: vendas, lucro, pneus.
// VERBATIM das linhas 2420-2617 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.chartsRede = function () {
  return {
    redeExecutiveSalesSeries() {
      const maxLen = Math.max(0, ...this.parceirosRede.map((p) => (Array.isArray(p.serieVendas) ? p.serieVendas.length : 0)));
      const len = maxLen || 1;
      const series = new Array(len).fill(0);
      for (const parceiro of this.parceirosRede) {
        const values = Array.isArray(parceiro.serieVendas) ? parceiro.serieVendas : [];
        const offset = len - values.length;
        for (let i = 0; i < values.length; i += 1) {
          series[offset + i] += Number(values[i] || 0);
        }
      }
      return series;
    },

    redeExecutiveSeriesLabels() {
      const len = Math.max(this.redeExecutiveSalesSeries().length, 1);
      if (len === 1) return ['Hoje'];
      const formatter = new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit',
        month: 'short',
        timeZone: 'America/Sao_Paulo',
      });
      const today = new Date();
      return Array.from({ length: len }, (_, index) => {
        const date = new Date(today);
        date.setDate(date.getDate() - (len - index - 1));
        return formatter.format(date).replace('.', '');
      });
    },

    redeExecutiveGoalDaily() {
      const len = Math.max(this.redeExecutiveSalesSeries().length, 1);
      return Number(this.redeSalesGoal || 0) / len;
    },

    redeResultadosUnidades() {
      return [...this.parceirosRede]
        .filter((parceiro) => parceiro.custoPendente || parceiro.lucroEstimado !== null)
        .sort((a, b) => Number(b.vendasValor || 0) - Number(a.vendasValor || 0));
    },

    redeResultadoBarWidth(parceiro) {
      if (!parceiro || parceiro.custoPendente || parceiro.lucroEstimado === null) return 0;
      const max = Math.max(
        1,
        ...this.redeResultadosUnidades()
          .filter((row) => !row.custoPendente && row.lucroEstimado !== null)
          .map((row) => Math.abs(Number(row.lucroEstimado || 0))),
      );
      const width = Math.round((Math.abs(Number(parceiro.lucroEstimado || 0)) / max) * 100);
      return Math.max(4, Math.min(100, width));
    },

    renderRedeChart() {
      const ctx = document.getElementById('chartRedeVendas');
      if (!ctx) return;
      if (window._redeChart) window._redeChart.destroy();

      window._redeChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: this.redeExecutiveSeriesLabels(),
          datasets: [
            {
              label: 'Vendas realizadas (R$)',
              data: this.redeExecutiveSalesSeries(),
              borderColor: '#047857',
              backgroundColor: 'rgba(16,185,129,0.12)',
              borderWidth: 2.5,
              tension: 0.28,
              fill: true,
              pointRadius: 2.5,
              pointBackgroundColor: '#047857',
              pointBorderColor: '#047857',
              pointBorderWidth: 1,
            },
            {
              label: 'Meta (R$)',
              data: this.redeExecutiveSalesSeries().map(() => this.redeExecutiveGoalDaily()),
              borderColor: '#059669',
              borderDash: [6, 5],
              borderWidth: 1.5,
              pointRadius: 0,
              fill: false,
            },
          ],
        },
        options: {
          ...this.chartOptions('R$ '),
          interaction: { intersect: false, mode: 'index' },
          scales: {
            y: {
              beginAtZero: true,
              position: 'left',
              grid: { color: '#e5e7eb' },
              ticks: {
                color: '#64748b',
                font: { size: 10 },
                callback: (value) => 'R$ ' + Number(value).toLocaleString('pt-BR'),
              },
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
