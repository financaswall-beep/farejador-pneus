// TELA DO BOT (2026-07-06): o DESENHO do mapa — malha IBGE (window.MAPA_RM, asset
// mapa-rm-dados.js) pintada com o dado do servidor (botMapaRows). Paleta combinada
// com o dono 07-06: cinza neutro = sem dado; UMA cor por assunto (azul = chamou,
// verde = pediu, teal = efetivou, vermelho = faltou); mais escuro = mais forte.
// Nomes NÃO ficam visíveis — moram no clique/tooltip (decisão do dono).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botMapa = function () {
  const RAMPS = {
    chamou: ['#B5D4F4', '#85B7EB', '#378ADD', '#185FA5', '#0C447C'],
    pediu: ['#C0DD97', '#97C459', '#639922', '#3B6D11', '#27500A'],
    efetivou: ['#9FE1CB', '#5DCAA5', '#1D9E75', '#0F6E56', '#085041'],
    faltou: ['#F7C1C1', '#F09595', '#E24B4A', '#A32D2D', '#791F1F'],
  };
  const SEM_DADO = '#f1f5f9'; // slate-100: município parado vira moldura, não grita
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

  return {
    botCamadas: [
      { id: 'chamou', label: 'Quem chamou', desc: 'Conversas com região identificada, por município' },
      { id: 'pediu', label: 'Virou pedido', desc: 'Dessas conversas, quantas fecharam pedido' },
      { id: 'efetivou', label: 'Entregou', desc: 'Pedidos que chegaram na mão do cliente' },
      { id: 'faltou', label: 'Faltou pneu', desc: 'Pediram e a Rede NÃO tinha — expansão/reposição' },
    ],

    botCamadaAtual() {
      return this.botCamadas.find((c) => c.id === this.botCamada) || this.botCamadas[0];
    },

    setBotCamada(id) {
      this.botCamada = id;
      this.botMapaSel = null;
      this.renderBotMapa();
    },

    // Linha do servidor pro município do desenho — casamento por nome normalizado
    // (o sensor grava o canônico do dicionário, ex. "Maricá"; o IBGE usa o mesmo nome).
    botMapaRowDe(nomeIbge) {
      const alvo = norm(nomeIbge);
      return this.botMapaRows.find((r) => norm(r.municipio) === alvo) || null;
    },

    get botLegenda() {
      return RAMPS[this.botCamada] || RAMPS.chamou;
    },

    // Reconstrói o SVG inteiro a cada pintura — são 24 caminhos, custo desprezível,
    // e evita estado pendurado no DOM (mesma filosofia dos charts: re-render burro).
    renderBotMapa() {
      const el = document.getElementById('bot-mapa');
      const dados = window.MAPA_RM;
      if (!el || !dados || this.currentPage !== 'bot') return;

      const ramp = this.botLegenda;
      const rows = this.botMapaRows;
      const camada = this.botCamada;
      const max = Math.max(1, ...rows.map((r) => Number(r[camada] || 0)));
      const NS = 'http://www.w3.org/2000/svg';

      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + dados.W + ' ' + dados.H);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Mapa da área do bot por município');
      svg.style.width = '100%';
      svg.style.height = 'auto';

      const fundo = document.createElementNS(NS, 'rect');
      fundo.setAttribute('width', dados.W);
      fundo.setAttribute('height', dados.H);
      fundo.setAttribute('rx', '10');
      fundo.setAttribute('fill', '#f8fafc');
      svg.appendChild(fundo);

      for (const m of dados.munis) {
        const row = this.botMapaRowDe(m.n);
        const v = row ? Number(row[camada] || 0) : 0;
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', m.d);
        p.setAttribute('fill', v > 0 ? ramp[Math.min(4, Math.floor((v / max) * 4.999))] : SEM_DADO);
        p.setAttribute('stroke', '#cbd5e1');
        p.setAttribute('stroke-width', '0.8');
        p.setAttribute('stroke-linejoin', 'round');
        p.style.cursor = 'pointer';

        const sel = this.botMapaSel && norm(this.botMapaSel.municipio) === norm(m.n);
        if (sel) {
          p.setAttribute('stroke', '#0f172a');
          p.setAttribute('stroke-width', '2.2');
        }

        const title = document.createElementNS(NS, 'title');
        title.textContent = m.n + (v > 0 ? ' — ' + v : '');
        p.appendChild(title);

        p.addEventListener('mouseenter', () => {
          if (!(this.botMapaSel && norm(this.botMapaSel.municipio) === norm(m.n))) {
            p.setAttribute('stroke', '#0f172a');
            p.setAttribute('stroke-width', '1.6');
          }
        });
        p.addEventListener('mouseleave', () => {
          if (!(this.botMapaSel && norm(this.botMapaSel.municipio) === norm(m.n))) {
            p.setAttribute('stroke', '#cbd5e1');
            p.setAttribute('stroke-width', '0.8');
          }
        });
        p.addEventListener('click', () => {
          this.botMapaSel = row
            ? { municipio: m.n, chamou: row.chamou, pediu: row.pediu, efetivou: row.efetivou, faltou: row.faltou }
            : { municipio: m.n, chamou: 0, pediu: 0, efetivou: 0, faltou: 0 };
          this.renderBotMapa();
        });

        svg.appendChild(p);
      }

      el.replaceChildren(svg);
    },
  };
};
