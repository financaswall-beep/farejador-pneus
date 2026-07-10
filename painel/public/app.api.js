// Obra 300 (2026-07-05): fatia do painel da MATRIZ — credenciais + apiGet/Post/Put + salvar raio de entrega.
// VERBATIM das linhas 605-704 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.api = function () {
  return {
    ensureCredentials() {
      if (!this.operatorLabel) {
        this.operatorLabel = prompt('Nome do operador') || 'Wallace';
        localStorage.setItem('farejador_operator_label', this.operatorLabel);
      }

      if (!this.apiToken && location.pathname.startsWith('/admin/painel')) {
        const token = prompt('ADMIN_AUTH_TOKEN para carregar dados reais');
        if (token) {
          this.apiToken = token;
          sessionStorage.setItem('farejador_admin_token', token);
        }
      }
    },

    apiHeaders() {
      return {
        Authorization: `Bearer ${this.apiToken}`,
        'X-Operator-Label': this.operatorLabel,
        'Content-Type': 'application/json',
      };
    },

    async apiGet(path) {
      if (!this.apiToken) throw new Error('missing_admin_token');
      const response = await fetch(path, { headers: this.apiHeaders() });
      if (response.status === 401 || response.status === 429) {
        if (response.status === 401) {
          this.apiToken = '';
          sessionStorage.removeItem('farejador_admin_token');
        }
      }
      if (!response.ok) throw new Error(`api_${response.status}`);
      return response.json();
    },

    async apiPost(path, body) {
      if (!this.apiToken) throw new Error('missing_admin_token');
      const response = await fetch(path, {
        method: 'POST',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const e = new Error(payload.error || `api_${response.status}`);
        e.payload = payload; e.status = response.status; // detalhe do erro (ex.: oversell)
        throw e;
      }
      return response.json();
    },

    async apiPut(path, body) {
      if (!this.apiToken) throw new Error('missing_admin_token');
      const response = await fetch(path, {
        method: 'PUT',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `api_${response.status}`);
      }
      return response.json();
    },

    // Matriz define o raio de entrega do parceiro selecionado (proximidade-primeiro Fase 2).
    async salvarRaioEntrega() {
      const p = this.selectedParceiro();
      if (!p) return;
      if (!p.fazEntrega) { alert('Este parceiro está como só retirada — peça pra ele ligar a entrega no painel antes de definir o raio.'); return; }
      let km = p.deliveryRadiusKm;
      if (km === '' || km === undefined) km = null;
      if (km !== null) {
        km = Number(km);
        if (!Number.isFinite(km) || km <= 0) { alert('Informe um raio válido (km maior que zero).'); return; }
        if (km > 9999.99) { alert('Raio muito grande.'); return; }
      }
      this.savingRaio = true;
      try {
        await this.apiPut(`/admin/api/partners/${encodeURIComponent(p.id)}/delivery-radius`, { delivery_radius_km: km });
        p.deliveryRadiusKm = km;
        this.raioSalvoMsg = km === null ? 'Raio limpo.' : 'Raio salvo.';
        setTimeout(() => { this.raioSalvoMsg = ''; }, 2500);
      } catch (err) {
        const msg = String(err && err.message || err);
        alert(msg === 'partner_pickup_only'
          ? 'Esse parceiro está como só retirada — não dá pra definir raio.'
          : 'Não consegui salvar o raio: ' + msg);
      } finally {
        this.savingRaio = false;
      }
    },

  };
};
