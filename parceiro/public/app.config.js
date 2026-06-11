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

    async resetFuncionarioSenha(f) {
      const nome = f.label || f.username || 'funcionário';
      const nova = prompt(`Nova senha para "${nome}" (mínimo 6 caracteres):`);
      if (nova === null) return; // cancelou
      if ((nova || '').length < 6) { this.flash('A senha precisa de ao menos 6 caracteres.'); return; }
      this.saving = true; this.savingAction = 'funcionario';
      try {
        await this.api(`funcionarios/${f.id}/reset-senha`, {
          method: 'POST',
          body: JSON.stringify({ password: nova }),
        });
        this.flash('Senha redefinida. Passe a nova senha pro funcionário.');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    async revokeFuncionario(f) {
      if (!confirm(`Desativar o login "${f.label || 'Funcionário'}"? Ele perde o acesso na hora.`)) return;
      this.saving = true; this.savingAction = 'funcionario';
      try {
        await this.api(`funcionarios/${f.id}`, { method: 'DELETE' });
        await this.loadFuncionarios();
        this.flash('Login desativado.');
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
        this.flash('Modo de atendimento salvo.', 'success');
      } catch (err) {
        this.flash(this.errMessage(err));
      } finally {
        this.saving = false; this.savingAction = '';
      }
    },

    // A busca/escolha de bairros saiu da UI (Fase 3): a entrega é decidida pelo
    // raio em km (aba Atendimento). Salvar a área = declarar o município (cidade
    // inteira), o plano B de quando o cliente não manda a localização.
    async saveArea() {
      if (!this.areaForm.municipio.trim()) { this.flash('Informe o município da área de entrega.'); return; }
      this.saving = true; this.savingAction = 'area';
      try {
        await this.api('configuracoes/area', {
          method: 'PUT',
          body: JSON.stringify({
            municipio: this.areaForm.municipio.trim(),
            city_wide: true,
            neighborhoods: [],
          }),
        });
        this.flash('Área de entrega salva.', 'success');
        await this.loadConfiguracoes();
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
