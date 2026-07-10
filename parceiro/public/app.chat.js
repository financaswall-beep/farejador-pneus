/**
 * app.chat.js - fabrica `chat` do painel do parceiro (obra <=300, passo 5/11).
 * MORA AQUI: nucleo da aba Bate-papo (F7) - getters da conversa ativa/nao lidas,
 * paineis e etiquetas, filtro/labels/mapeadores banco->tela, loadChat/mensagens,
 * tempo real (SSE com fallback de poll 5s + poll lento 30s), selecionar conversa,
 * marcar lida, enviar com bolha otimista e scroll.
 * NAO MORA AQUI: cliente vinculado e carrinho do chat (app.chat.cliente.js);
 * o ESTADO chat* (fica na raiz ate o passo 10); o SSE da FOTO (app.foto.js).
 * VEIO DE: app.js commit 29b2ec6, linhas 1953-1988 + 2222-2426 VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.chat = () => ({
    // â”€â”€â”€ BATE-PAPO (F7) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    get chatActive() {
      return this.chatConversations.find((c) => c.id === this.chatActiveId) || null;
    },
    get chatUnreadTotal() {
      return this.chatConversations.reduce((sum, c) => sum + (c.unread || 0), 0);
    },
    // ─── Tela 4: acordeão Pedido/Cliente + card ocioso ───
    get chatIdle() { return !this.chatPanelPedido && !this.chatPanelCliente; },
    // Acordeão EXCLUSIVO: abrir um fecha o outro (uma seção por vez na coluna).
    toggleChatPanel(which) {
      if (which === 'pedido') {
        this.chatPanelPedido = !this.chatPanelPedido;
        if (this.chatPanelPedido) this.chatPanelCliente = false;
      } else {
        this.chatPanelCliente = !this.chatPanelCliente;
        if (this.chatPanelCliente) this.chatPanelPedido = false;
      }
      this.$nextTick(() => lucide.createIcons());
    },
    openChatPanel(which) {
      if (which === 'pedido') { this.chatPanelPedido = true; this.chatPanelCliente = false; }
      else { this.chatPanelCliente = true; this.chatPanelPedido = false; }
      this.$nextTick(() => lucide.createIcons());
    },
    // ─── Tela 4: etiquetas manuais (LOCAL, Fase 1 nao persiste) ───
    convTags(id) { return (id && this.chatTags[id]) || []; },
    tagMeta(tagId) { return this.chatTagPalette.find((t) => t.id === tagId) || null; },
    toggleConvTag(tagId) {
      const id = this.chatActiveId;
      if (!id) return;
      const cur = new Set(this.chatTags[id] || []);
      if (cur.has(tagId)) cur.delete(tagId); else cur.add(tagId);
      this.chatTags = { ...this.chatTags, [id]: [...cur] };
      this.$nextTick(() => lucide.createIcons());
    },
    get chatFilteredConversations() {
      const f = this.chatFilter;
      return this.chatConversations.filter((c) => {
        if (f === 'all') return true;
        if (f === 'unread') return (c.unread || 0) > 0;
        return c.channel === f;
      });
    },

    // â”€â”€ Mapeamento banco -> formato que a tela consome â”€â”€
    chatChannelLabel(channel) {
      return { whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook' }[channel] || 'Outro';
    },
    chatInitials(name) {
      const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return '?';
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    },
    chatTimeLabel(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(d);
    },
    mapChatConversation(row, keepMessages) {
      const name = row.customer_name || row.customer_identifier || 'Cliente';
      return {
        id: row.id,
        name,
        initials: this.chatInitials(name),
        channel: row.channel || 'other',
        channelLabel: this.chatChannelLabel(row.channel),
        avatar: row.customer_avatar_url || null,
        phone: row.customer_identifier || '',
        time: this.chatTimeLabel(row.last_message_at || row.created_at),
        unread: Number(row.unread_count || 0),
        last: row.last_message || '',
        // Slots captados pelo bot (ainda nao estruturados): so localizacao/intent existem.
        measure: null, position: null, bike: null,
        city: row.customer_location || null,
        suggested: null,
        messages: keepMessages || [],
        _loaded: !!keepMessages,
      };
    },
    chatMapMessage(row) {
      return {
        id: row.id,
        from: row.direction === 'inbound' ? 'them' : 'me',
        text: row.content || '',
        time: this.chatTimeLabel(row.created_at),
      };
    },

    async loadChat() {
      if (!this.apiToken) return;
      try {
        const data = await this.api('chat/conversations');
        const prev = new Map(this.chatConversations.map((c) => [c.id, c]));
        this.chatConversations = (data.rows || []).map((row) => {
          const old = prev.get(row.id);
          const mapped = this.mapChatConversation(row, old ? old.messages : null);
          mapped._loaded = old ? old._loaded : false;
          // Conversa aberta = lida. Se chegou msg nova (servidor ainda conta),
          // avisa o servidor pra zerar de vez (senao o badge volta no proximo poll).
          if (row.id === this.chatActiveId) {
            if (mapped.unread > 0) void this.markChatRead(row.id);
            mapped.unread = 0;
          }
          return mapped;
        });
        // Mantem o fio aberto atualizado (mensagens novas aparecem no polling).
        if (this.chatActiveId && this.chatConversations.some((c) => c.id === this.chatActiveId)) {
          await this.loadChatMessages(this.chatActiveId);
        }
      } catch (err) {
        console.warn('chat_load_failed', err);
      }
    },

    async loadChatMessages(id) {
      try {
        const data = await this.api(`chat/conversations/${id}/messages`);
        const conv = this.chatConversations.find((c) => c.id === id);
        if (!conv) return;
        const wasAtEnd = this._chatNearBottom();
        conv.messages = (data.rows || []).map((row) => this.chatMapMessage(row));
        conv._loaded = true;
        if (wasAtEnd) this.$nextTick(() => this.scrollChatToEnd());
      } catch (err) {
        console.warn('chat_messages_failed', err);
      }
    },

    startChatPolling() {
      this.stopChatPolling();
      void this.loadChat();
      // Fatia 3: tempo real via SSE (push). Em cada evento recarrega a lista.
      void this.startChatSse();
      // Rede de seguranca: poll lento sempre ligado, pega evento perdido (ex.:
      // SSE caiu e voltou entre dois eventos).
      this.chatTimer = setInterval(() => { void this.loadChat(); }, 30000);
    },
    async startChatSse() {
      // FIX 2026-06-10: era `this.token`, que NUNCA existiu (o estado chama
      // apiToken) → o SSE do chat nunca conectava e o "tempo real" era o poll
      // de 5s, silenciosamente. Achado na construção do alerta de foto.
      if (!window.EventSource || !this.apiToken) { this.startChatFallbackPoll(); return; }
      try {
        const issued = await this.api('chat/stream-ticket', { method: 'POST' });
        const url = `/parceiro/${this.slug}/api/chat/stream?ticket=${encodeURIComponent(issued.ticket)}`;
        const es = new EventSource(url);
        es.addEventListener('message', () => { void this.loadChat(); });
        es.onopen = () => { this.stopChatFallbackPoll(); }; // SSE de pe: nao precisa do poll rapido.
        es.onerror = () => {
          // EventSource reconecta sozinho em quedas transitorias (readyState
          // CONNECTING). So caimos no poll rapido se fechou de vez (ex.: token
          // invalido -> CLOSED).
          if (es.readyState === EventSource.CLOSED) { this.startChatFallbackPoll(); }
        };
        this.chatES = es;
      } catch (err) {
        console.warn('chat_sse_failed', err);
        this.startChatFallbackPoll();
      }
    },
    startChatFallbackPoll() {
      if (this.chatFastTimer) return;
      this.chatFastTimer = setInterval(() => { void this.loadChat(); }, 5000);
    },
    stopChatFallbackPoll() {
      if (this.chatFastTimer) { clearInterval(this.chatFastTimer); this.chatFastTimer = null; }
    },
    stopChatPolling() {
      if (this.chatTimer) { clearInterval(this.chatTimer); this.chatTimer = null; }
      this.stopChatFallbackPoll();
      if (this.chatES) { this.chatES.close(); this.chatES = null; }
    },

    selectChat(id) {
      this.chatActiveId = id;
      this.chatCustomer = null; // Fase 2a: limpa enquanto carrega o cliente da nova conversa
      this.chatResetOrder();    // Fase 2b: zera o carrinho ao trocar de conversa
      const c = this.chatConversations.find((x) => x.id === id);
      if (c) c.unread = 0;
      void this.markChatRead(id); // zera no servidor (senao o badge volta no poll)
      void this.loadChatMessages(id);
      void this.loadChatCustomer(id); // Fase 2a: cliente vinculado + métricas
      this.$nextTick(() => { lucide.createIcons(); this.scrollChatToEnd(); });
    },
    async markChatRead(id) {
      try {
        await this.api(`chat/conversations/${id}/read`, { method: 'POST' });
      } catch (err) {
        console.warn('chat_mark_read_failed', err);
      }
    },
    async sendChat() {
      // Fatia 2: grava otimista na tela, manda pro backend (que grava no banco
      // e dispara o Chatwoot). O polling/eco traz a versao persistida depois.
      const text = (this.chatDraft || '').trim();
      const conv = this.chatActive;
      if (!text || !conv || this.chatSending) return;

      const clientToken = 'pc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const optimistic = {
        id: clientToken,
        from: 'me',
        text,
        time: this.chatTimeLabel(new Date().toISOString()),
        pending: true,
      };
      conv.messages = conv.messages || [];
      conv.messages.push(optimistic);
      this.chatDraft = '';
      this.chatSending = true;
      this.$nextTick(() => this.scrollChatToEnd());

      try {
        await this.api(`chat/conversations/${conv.id}/send`, {
          method: 'POST',
          body: JSON.stringify({ content: text, client_token: clientToken }),
        });
        optimistic.pending = false;
        // Recarrega o fio: a msg ja esta persistida no banco (substitui a otimista).
        await this.loadChatMessages(conv.id);
      } catch (err) {
        // Rollback: tira a bolha otimista e devolve o texto pro input.
        conv.messages = conv.messages.filter((m) => m.id !== clientToken);
        this.chatDraft = text;
        this.flash('Nao consegui enviar a mensagem. Tente de novo.');
        console.warn('chat_send_failed', err);
      } finally {
        this.chatSending = false;
      }
    },
    _chatNearBottom() {
      const box = document.getElementById('pos-chat-messages');
      if (!box) return true;
      return (box.scrollHeight - box.scrollTop - box.clientHeight) < 80;
    },
    scrollChatToEnd() {
      const box = document.getElementById('pos-chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    },
});
