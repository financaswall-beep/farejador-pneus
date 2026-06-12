/**
 * app.config.js - fabrica `config` do painel do parceiro (obra <=300, passo 6/11).
 * MORA AQUI: autorizacao de UI (isOwner/canSee/firstAllowedSection - pintura;
 * a trava real e o backend), funcionarios Etapa 4c (listar/criar/reset senha/
 * revogar) e Configuracoes da loja (carregar + salvar loja/atendimento/area de
 * entrega/permissoes do funcionario).
 * NAO MORA AQUI: o ESTADO role/permissions/forms (fica na raiz ate o passo 10);
 * loadData/navegacao (raiz, passo 10).
 * VEIO DE: app.js commit f2f8322, linhas 472-708 VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.config = () => ({
    get isOwner() { return this.role === 'owner'; },

    // Pode VER a tela? Dono vê tudo; funcionário depende da permissão efetiva
    // (resolvida no servidor em /api/me.permissions). Usado no menu pra Resumo e
    // Financeiro (Configurações segue isOwner — cadeado duro). É só pintura de UI;
    // a trava de verdade é o requireScreen/requireOwner no backend.
    canSee(tela) {
      if (this.isOwner) return true;
      // Seção 'entrega' usa a permissão 'entregas' (chave do backend/DB allow_entregas).
      const key = tela === 'entrega' ? 'entregas' : tela;
      return !!(this.permissions && this.permissions[key]);
    },

    // ─── Etapa 4c: funcionários ───
    async loadFuncionarios() {
      if (!this.isOwner) return;
      try {
        const res = await this.api('funcionarios');
        this.funcionarios = res.rows || [];
      } catch (err) {
        console.warn('funcionarios_unavailable', err);
        this.funcionarios = [];
      }
    },

    // Bloco 1: abre o painel de um funcionário. Limpa senha/confirmação pendentes.
    // Bloco 2: carrega telas+comissão DESTE funcionário (loadFuncConfig, configEquipe).
    selectFuncionario(f) {
      this.selectedFuncionario = f;
      this.resetSenhaValue = '';
      this.revokeConfirmId = null;
      this.loadFuncConfig(f);
      this.$nextTick(() => lucide.createIcons());
    },

    // Quantas das 9 telas o perfil libera. Hoje é "um perfil só" da loja, então dá o
    // mesmo número pra todo funcionário; no Bloco 2 (acesso por pessoa) passa a variar.
    get permCount() {
      const keys = ['vendas', 'estoque', 'pedidos', 'clientes', 'entregas', 'retiradas', 'batepapo', 'resumo', 'financeiro'];
      return keys.reduce((n, k) => n + (this.permForm && this.permForm[k] ? 1 : 0), 0);
    },

    async createFuncionario() {
      const username = (this.funcionarioForm.username || '').trim();
      const password = this.funcionarioForm.password || '';
      if (!username || password.length < 6) {
        this.flash('Informe usuário e senha (mínimo 6 caracteres).');
        return;
      }
      this.saving = true; this.savingAction = 'funcionario';
      try {
        await this.api('funcionarios', {
          method: 'POST',
          body: JSON.stringify({
            label: (this.funcionarioForm.label || '').trim() || null,
            username,
            password,
          }),
        });
        this.funcionarioForm = { label: '', username: '', password: '' };
        await this.loadFuncionarios();
        this.flash('Funcionário criado. Passe o usuário e a senha pra ele.');
      } catch (err) {
        this.flash(err && err.payload && err.payload.error === 'username_taken'
          ? 'Esse usuário já existe. Escolha outro.'
          : this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    // Bloco 1: reseta a senha pelo painel do funcionário (sem o prompt do navegador).
    // A senha nova vem do input no painel (this.resetSenhaValue).
    async confirmResetSenha(f) {
      const nova = this.resetSenhaValue || '';
      if (nova.length < 6) { this.flash('A senha precisa de ao menos 6 caracteres.'); return; }
      this.saving = true; this.savingAction = 'funcionario';
      try {
        await this.api(`funcionarios/${f.id}/reset-senha`, {
          method: 'POST',
          body: JSON.stringify({ password: nova }),
        });
        this.resetSenhaValue = '';
        this.flash('Senha redefinida. Passe a nova senha pro funcionário.', 'success');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    // Bloco 1: desativa o login. A confirmação é inline no painel (revokeConfirmId),
    // sem o confirm() do navegador. Re-aponta o funcionário aberto pro estado novo.
    async doRevoke(f) {
      this.saving = true; this.savingAction = 'funcionario';
      try {
        await this.api(`funcionarios/${f.id}`, { method: 'DELETE' });
        await this.loadFuncionarios();
        this.revokeConfirmId = null;
        this.selectedFuncionario = this.funcionarios.find((x) => x.id === f.id) || null;
        this.flash('Login desativado.', 'success');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    // ─── Configurações da Loja (Fase 1) ───
    // Primeira tela que o funcionário pode ver (fallback de navegação).
    firstAllowedSection() {
      const order = ['vendas', 'pedidos', 'estoque', 'clientes', 'entrega', 'retiradas', 'batepapo', 'resumo', 'financeiro'];
      return order.find((s) => this.canSee(s)) || null;
    },

    // Carrega TUDO da tela Configurações (dados da loja + atendimento + área +
    // permissões + funcionários). Só o dono chega aqui (backend é requireOwner cru).
    async loadConfiguracoes() {
      if (!this.isOwner) return;
      await this.loadFuncionarios();
      try {
        const cfg = await this.api('configuracoes');
        const loja = cfg.loja || {};
        this.lojaForm = {
          display_name: loja.display_name || '',
          address_street: loja.address_street || '',
          address_number: loja.address_number || '',
          address_neighborhood: loja.address_neighborhood || '',
          address_city: loja.address_city || '',
          address_complement: loja.address_complement || '',
          cep: loja.cep || '',
          opening_hours_text: loja.opening_hours_text || '',
          maps_url: loja.maps_url || '',
        };
        this.atendimentoForm = {
          faz_entrega: loja.faz_entrega !== undefined ? !!loja.faz_entrega : true,
          tem_retirada: loja.tem_retirada !== undefined ? !!loja.tem_retirada : true,
          delivery_radius_km: (loja.delivery_radius_km !== undefined && loja.delivery_radius_km !== null)
            ? Number(loja.delivery_radius_km) : null,
        };
        this.coverageList = Array.isArray(cfg.coverage) ? cfg.coverage : [];
        // Área: edita o município da loja (ou o 1º coberto). Só o município — a
        // entrega é decidida pelo raio (aba Atendimento), não por bairros.
        const baseMunicipio = (loja.address_city || (this.coverageList[0] && this.coverageList[0].municipio) || '').toString();
        this.areaForm = { municipio: baseMunicipio };
        // Permissões: preenche os toggles com o efetivo do servidor.
        if (cfg.permissions && typeof cfg.permissions === 'object') {
          this.permForm = { ...this.permForm, ...cfg.permissions };
        }
        this.configLoaded = true;
        this.$nextTick(() => lucide.createIcons());
      } catch (err) {
        console.warn('configuracoes_unavailable', err);
        this.flash(this.errMessage(err));
      }
    },

    async saveLoja() {
      if (!this.lojaForm.display_name.trim()) { this.flash('Informe o nome de exibição da loja.'); return; }
      this.saving = true; this.savingAction = 'loja';
      try {
        await this.api('configuracoes/loja', { method: 'PUT', body: JSON.stringify(this.lojaForm) });
        this.flash('Dados da loja salvos.', 'success');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    async saveAtendimento() {
      if (!this.atendimentoForm.faz_entrega && !this.atendimentoForm.tem_retirada) {
        this.flash('Marque pelo menos uma opção: entrega ou retirada.'); return;
      }
      // Raio só vale quando faz entrega. Vazio = null (não preenchido → fora da
      // entrega quando a Rede ligar o roteamento por proximidade). > 0 e ≤ 9999,99.
      let radius = null;
      if (this.atendimentoForm.faz_entrega) {
        const raw = this.atendimentoForm.delivery_radius_km;
        if (raw !== null && raw !== '' && raw !== undefined) {
          radius = Number(raw);
          if (!Number.isFinite(radius) || radius <= 0) {
            this.flash('Informe um raio de entrega válido (km maior que zero).'); return;
          }
          if (radius > 9999.99) { this.flash('Raio de entrega muito grande.'); return; }
        }
      }
      this.saving = true; this.savingAction = 'atendimento';
      try {
        await this.api('configuracoes/atendimento', {
          method: 'PUT',
          body: JSON.stringify({
            faz_entrega: !!this.atendimentoForm.faz_entrega,
            tem_retirada: !!this.atendimentoForm.tem_retirada,
            delivery_radius_km: radius,
          }),
        });
        // Reflete o que o backend gravou (zera o raio quando não faz entrega).
        this.atendimentoForm.delivery_radius_km = radius;
        // Bloco 1: a cidade base (era a aba "Área de entrega") salva junto. Só manda se
        // preenchida — município vazio não bloqueia salvar o atendimento.
        const municipio = (this.areaForm.municipio || '').trim();
        if (municipio) {
          await this.api('configuracoes/area', {
            method: 'PUT',
            body: JSON.stringify({ municipio, city_wide: true, neighborhoods: [] }),
          });
        }
        this.flash('Atendimento salvo.', 'success');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    async savePermissoes() {
      this.saving = true; this.savingAction = 'permissoes';
      try {
        // Envia só as 8 telas; 'config' nunca existe aqui (cadeado duro). O servidor
        // ainda descarta qualquer chave fora da allowlist (defesa em profundidade).
        const body = {
          vendas: !!this.permForm.vendas,
          estoque: !!this.permForm.estoque,
          pedidos: !!this.permForm.pedidos,
          clientes: !!this.permForm.clientes,
          entregas: !!this.permForm.entregas,
          retiradas: !!this.permForm.retiradas,
          batepapo: !!this.permForm.batepapo,
          resumo: !!this.permForm.resumo,
          financeiro: !!this.permForm.financeiro,
        };
        const res = await this.api('configuracoes/permissoes', { method: 'PUT', body: JSON.stringify(body) });
        if (res.permissions && typeof res.permissions === 'object') {
          this.permForm = { ...this.permForm, ...res.permissions };
        }
        this.flash('Permissões do funcionário salvas.', 'success');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },
});
