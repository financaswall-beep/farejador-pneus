window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botMilly = function () {
  let consultaMillyRev = 0;
  const consultaMillyUrl = '/admin/api/bot/consulta-milly';
  return {
    consultaMillyAtiva: null,
    consultaMillyCanal: null,
    consultaMillyFluxo: null,
    consultaMillySalvando: false,
    consultaMillyErro: '',
    get podeControlarMilly() {
      return this.adminAuthenticated && this.panelScope === 'matrix' &&
        this.adminUser?.role === 'owner' && this.adminUser.auth_type === 'session';
    },
    get consultaMillyStatus() {
      if (this.consultaMillyErro) return this.consultaMillyErro;
      if (this.consultaMillyAtiva === null) return 'Consultando configuração…';
      if (!this.consultaMillyAtiva) return 'Consultas pausadas. A atendente segue as regras habituais.';
      if (this.consultaMillyFluxo !== true) return 'Consultas configuradas. Para usá-las, a instalação precisa ter a atendente automática e o envio em fila habilitados.';
      if (this.consultaMillyCanal === false) return 'Canal da Milly indisponível. As consultas estão ativadas e a atendente segue as regras habituais até a conexão voltar.';
      if (this.consultaMillyCanal === null) return 'Consultas ativadas. A disponibilidade da conexão está pendente de confirmação.';
      return 'Consultas ativadas para negociações da Matriz atendidas pela conexão da Milly.';
    },
    async carregarConsultaMilly() {
      if (!this.podeControlarMilly || this.consultaMillySalvando) return;
      const rev = ++consultaMillyRev;
      try {
        const result = await this.apiGet(consultaMillyUrl);
        if (rev !== consultaMillyRev) return;
        this.consultaMillyAtiva = result.ativa;
        this.consultaMillyCanal = result.canal_disponivel;
        this.consultaMillyFluxo = result.fluxo_disponivel;
        this.consultaMillyErro = '';
      } catch {
        if (rev !== consultaMillyRev) return;
        this.consultaMillyAtiva = null;
        this.consultaMillyErro = 'Não foi possível conferir o estado das consultas.';
      }
    },
    async alterarConsultaMilly() {
      if (!this.podeControlarMilly || this.consultaMillySalvando) return;
      if (this.consultaMillyAtiva === null) return this.carregarConsultaMilly();
      consultaMillyRev++;
      this.consultaMillySalvando = true;
      try {
        const result = await this.apiPut(consultaMillyUrl, { ativa: !this.consultaMillyAtiva });
        this.consultaMillyAtiva = result.ativa;
        this.consultaMillyFluxo = result.fluxo_disponivel;
        this.consultaMillyErro = '';
      } catch {
        this.consultaMillyAtiva = null;
        this.consultaMillyErro = 'A alteração não foi confirmada. Atualize o estado antes de tentar novamente.';
      } finally {
        this.consultaMillySalvando = false;
      }
    },
  };
};
