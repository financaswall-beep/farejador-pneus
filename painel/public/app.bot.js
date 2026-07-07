// TELA DO BOT (2026-07-06): dados e ações da aba Bot — campainha (cliente esperando),
// visão (cards/mapa/radar) e deep-link pro Chatwoot. O DESENHO do mapa mora em
// app.bot.mapa.js; aqui é só estado/carregadores/getters.
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.bot = function () {
  return {
    // Leve de propósito: roda no boot e no refresh de 15s em QUALQUER página —
    // cliente esperando é alarme, não estatística. Badge acende na aba do menu.
    async loadBotCampainha() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      try {
        this.botCampainha = await this.apiGet('/admin/api/bot/campainha');
      } catch (err) {
        this.botCampainha = null; // sem resposta = sem alarme inventado
      }
      const item = this.liveMenu.find((i) => i.id === 'bot');
      if (item) {
        const n = this.botMudas.length + this.botEscalados.length;
        item.badge = n > 0 ? String(n) : null;
      }
    },

    async loadBotVisao() {
      this.ensureCredentials();
      if (!this.apiToken || !location.pathname.startsWith('/admin/painel')) return;
      this.botLoading = true;
      try {
        this.botVisao = await this.apiGet(
          '/admin/api/bot/visao?period=' + encodeURIComponent(this.botPeriodo),
        );
      } catch (err) {
        this.botVisao = null;
      }
      this.botLoading = false;
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderBotMapa();
      });
    },

    setBotPeriodo(p) {
      this.botPeriodo = p;
      this.botMapaSel = null;
      void this.loadBotVisao();
    },

    // ─── getters derivados (nada de estado duplicado) ───
    get botMudas() {
      return (this.botCampainha && this.botCampainha.mudas) || [];
    },
    get botEscalados() {
      return (this.botCampainha && this.botCampainha.escalados) || [];
    },
    get botCards() {
      return (this.botVisao && this.botVisao.cards) || null;
    },
    get botRadar() {
      return (this.botVisao && this.botVisao.radar) || [];
    },
    get botSemRegiao() {
      return (this.botVisao && this.botVisao.sem_regiao) || 0;
    },
    get botMapaRows() {
      return (this.botVisao && this.botVisao.mapa) || [];
    },
    // Horário de pico: barrinhas proporcionais (madrugada/manhã/tarde/noite).
    get botHorarios() {
      const c = this.botCards;
      if (!c) return [];
      const itens = [
        { label: 'Madrugada', n: Number(c.conv_madrugada || 0) },
        { label: 'Manhã', n: Number(c.conv_manha || 0) },
        { label: 'Tarde', n: Number(c.conv_tarde || 0) },
        { label: 'Noite', n: Number(c.conv_noite || 0) },
      ];
      const max = Math.max(1, ...itens.map((i) => i.n));
      return itens.map((i) => ({ ...i, pct: Math.round((i.n / max) * 100) }));
    },

    // ─── Chatwoot: a conversa se resolve LÁ; aqui só o atalho ───
    chatwootConvUrl(chatwootId) {
      if (!this.chatwootBaseUrl || !this.chatwootAccountId || !chatwootId) return null;
      return this.chatwootBaseUrl + '/app/accounts/' + this.chatwootAccountId +
        '/conversations/' + chatwootId;
    },
    abrirNoChatwoot(chatwootId) {
      const url = this.chatwootConvUrl(chatwootId);
      if (url) window.open(url, '_blank', 'noopener');
    },

    botMinutosLabel(min) {
      if (min == null) return '';
      if (min >= 60) return Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0');
      return min + ' min';
    },
    botQuandoLabel(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
        ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    },
  };
};
