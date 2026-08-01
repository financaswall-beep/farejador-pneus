/** Ações específicas dos cards da rota; mescladas no componente Alpine principal. */
function entregasCardActions() {
  return {
    async entreguei(d, pm) {
      this.salvando = true; this.msg = null;
      try {
        await this.api('POST', '/api/entregas/status', { order_id: d.order_id, status: 'delivered', payment_method: pm });
        this.pagando = null;
        this.msg = { ok: true, text: 'Entrega confirmada!' };
        await this.carregar();
      } catch (err) {
        this.msg = { ok: false, text: 'Não consegui confirmar a entrega.' };
      } finally { this.salvando = false; }
    },

    async atualizarStatus(d, status) {
      this.salvando = true; this.msg = null;
      try {
        await this.api('POST', '/api/entregas/status', { order_id: d.order_id, status });
        this.pagando = null;
        this.msg = { ok: true, text: status === 'dispatched'
          ? 'Entrega marcada como saiu para entrega.'
          : 'Entrega voltou para pendente.' };
        await this.carregar();
      } catch (err) {
        this.msg = { ok: false, text: 'Não consegui atualizar a entrega.' };
      } finally { this.salvando = false; }
    },

    ordemRotaKey() {
      return this.rotaAberta?.trip_id ? `farejador_entregador_ordem_${this.rotaAberta.trip_id}` : '';
    },

    aplicarOrdemSalva() {
      if (!this.rotaAberta?.entregas?.length) return;
      const key = this.ordemRotaKey();
      if (!key) return;
      try {
        const salva = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(salva) || salva.length === 0) return;
        const posicao = new Map(salva.map((id, index) => [id, index]));
        this.rotaAberta.entregas = [...this.rotaAberta.entregas].sort((a, b) => {
          const pa = posicao.has(a.order_id) ? posicao.get(a.order_id) : Number.MAX_SAFE_INTEGER;
          const pb = posicao.has(b.order_id) ? posicao.get(b.order_id) : Number.MAX_SAFE_INTEGER;
          return pa - pb;
        });
      } catch (err) { /* ordem local corrompida: usa a ordem do servidor */ }
    },

    moverParada(index, direcao) {
      if (!this.rotaAberta?.entregas) return;
      const destino = index + direcao;
      if (destino < 0 || destino >= this.rotaAberta.entregas.length) return;
      const entregas = [...this.rotaAberta.entregas];
      [entregas[index], entregas[destino]] = [entregas[destino], entregas[index]];
      this.rotaAberta.entregas = entregas;
      const key = this.ordemRotaKey();
      if (key) localStorage.setItem(key, JSON.stringify(entregas.map((item) => item.order_id)));
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },

    async carregarFotoPneu(photoRequestId) {
      if (!photoRequestId || this.fotoPneuUrls[photoRequestId]) return;
      try {
        const res = await fetch(`/api/entregas/fotos/${photoRequestId}/imagem`, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (res.status === 401) { this.forcarLogout(); return; }
        if (!res.ok) return;
        const blob = await res.blob();
        this.fotoPneuUrls = { ...this.fotoPneuUrls, [photoRequestId]: URL.createObjectURL(blob) };
      } catch (err) { /* foto é acessória; o restante do card continua utilizável */ }
    },

    async abrirFotoPneu(photoRequestId) {
      if (!this.fotoPneuUrls[photoRequestId]) await this.carregarFotoPneu(photoRequestId);
      const url = this.fotoPneuUrls[photoRequestId];
      if (url) this.fotoPneuAberta = { open: true, url };
    },

    fecharFotoPneu() {
      this.fotoPneuAberta = { open: false, url: null };
    },

    statusEntregaTexto(d) {
      if (d.delivery_status === 'delivered') return 'entregue';
      if (d.delivery_status === 'dispatched') return 'a caminho';
      return 'pendente';
    },

    statusEntregaClasse(d) {
      if (d.delivery_status === 'delivered') return 'bg-emerald-100 text-emerald-700';
      if (d.delivery_status === 'dispatched') return 'bg-amber-100 text-amber-700';
      return 'bg-slate-100 text-slate-600';
    },

    statusEntregaSubtitulo(d) {
      if (d.delivery_status === 'delivered') return 'Parada finalizada';
      if (d.delivery_status === 'dispatched') return 'Entrega em andamento';
      return 'Aguardando saída';
    },
  };
}
