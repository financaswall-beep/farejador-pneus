// Obra 300 (2026-07-05): fatia do painel da MATRIZ — credenciais + apiGet/Post/Put + salvar raio de entrega.
// VERBATIM das linhas 605-704 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_INTEGRITY = window.PAINEL_INTEGRITY || (() => {
  const storageKey = 'farejador_integrity_operations_v1';
  let operations = {};
  try { operations = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch (_) { operations = {}; }
  return {
    operations,
    save() {
      try { sessionStorage.setItem(storageKey, JSON.stringify(this.operations)); } catch (_) { /* memória ainda protege a aba */ }
    },
    operation(scope, entityId) {
      const slot = `${scope}:${entityId || 'new'}`;
      if (!this.operations[slot]) {
        const key = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        this.operations[slot] = { key };
        this.save();
      }
      return this.operations[slot];
    },
    complete(scope, entityId) {
      delete this.operations[`${scope}:${entityId || 'new'}`];
      this.save();
    },
  };
})();

let integrityRecoveryPromise = null;
function recoverPendingIntegrityOperations(state) {
  if (integrityRecoveryPromise) return integrityRecoveryPromise;
  integrityRecoveryPromise = (async () => {
    const forms = [
      { scope: 'wholesale-sale-create', domain: 'wholesale_sale.create',
        label: 'a venda anterior', message: 'atacadoMsg' },
      { scope: 'wholesale-purchase-create', domain: 'wholesale_purchase.create',
        label: 'a compra anterior', message: 'compraMsg' },
      { scope: 'matriz-expense-create', domain: 'matriz_expense.create',
        label: 'a despesa anterior', message: 'despesaMsg' },
    ];
    const recovered = [];
    const unresolved = [];
    for (const form of forms) {
      const operation = window.PAINEL_INTEGRITY.operations[`${form.scope}:form`];
      if (!operation || typeof operation.key !== 'string') continue;
      try {
        const resolution = await state.apiPost('/admin/api/integrity/resolve', {
          domain: form.domain, idempotency_key: operation.key,
        });
        if (resolution.status === 'completed') {
          window.PAINEL_INTEGRITY.complete(form.scope, 'form');
          state[form.message] = { ok: true,
            text: `O servidor confirmou ${form.label} após a recarga. Nenhum lançamento foi repetido.` };
          recovered.push(form.label);
        } else if (resolution.status === 'incomplete') {
          unresolved.push(form.label);
        }
      } catch (error) {
        console.error('integrity recovery failed', form.domain, error);
        unresolved.push(form.label);
      }
    }
    if (recovered.length) {
      window.alert(`Recuperação concluída: o servidor confirmou ${recovered.join(', ')}. A chave antiga foi liberada e nada será duplicado.`);
    }
    if (unresolved.length) {
      window.alert(`Ainda não foi possível confirmar ${unresolved.join(', ')}. A chave foi mantida por segurança; tente recarregar novamente antes de lançar outra operação.`);
    }
  })();
  return integrityRecoveryPromise;
}
window.PAINEL_MODULES.api = function () {
  return {
    async ensureCredentials() {
      if (this.adminAuthenticated) {
        await recoverPendingIntegrityOperations(this);
        return true;
      }
      const response = await fetch('/admin/api/auth/me', { credentials: 'same-origin' });
      if (!response.ok) {
        location.replace('/admin/login');
        return false;
      }
      const payload = await response.json();
      this.adminUser = payload.user;
      this.operatorLabel = payload.user.display_name;
      this.adminAuthenticated = true;
      if (payload.user.role !== 'owner') {
        this.liveMenu = this.liveMenu.filter((item) => item.id !== 'colaboradores');
      }
      await recoverPendingIntegrityOperations(this);
      return true;
    },

    apiHeaders() {
      return {
        'Content-Type': 'application/json',
      };
    },

    adminUnauthorized() {
      this.adminAuthenticated = false;
      this.adminUser = null;
      location.replace('/admin/login');
    },

    async apiGet(path) {
      if (!this.adminAuthenticated) throw new Error('missing_admin_session');
      const response = await fetch(path, { credentials: 'same-origin', headers: this.apiHeaders() });
      if (response.status === 401) this.adminUnauthorized();
      if (!response.ok) throw new Error(`api_${response.status}`);
      return response.json();
    },

    async apiPost(path, body) {
      if (!this.adminAuthenticated) throw new Error('missing_admin_session');
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (response.status === 401) this.adminUnauthorized();
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const e = new Error(payload.error || `api_${response.status}`);
        e.payload = payload; e.status = response.status; // detalhe do erro (ex.: oversell)
        throw e;
      }
      return response.json();
    },

    async apiPut(path, body) {
      if (!this.adminAuthenticated) throw new Error('missing_admin_session');
      const response = await fetch(path, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: this.apiHeaders(),
        body: JSON.stringify(body),
      });
      if (response.status === 401) this.adminUnauthorized();
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `api_${response.status}`);
      }
      return response.json();
    },

    async logoutAdmin() {
      try {
        await fetch('/admin/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } finally {
        this.adminAuthenticated = false;
        location.replace('/admin/login');
      }
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
