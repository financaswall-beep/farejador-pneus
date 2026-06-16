/**
 * app.arquivar.js - fabrica `arquivar` do painel (0108). "Tirar da tela" QUALQUER
 * item (pedido/despesa/compra) SEM apagar do banco: some da lista de trabalho e
 * fica no Relatório. 🔒 So tipos cujo TOTAL vem do backend (golden rule: arquivar
 * nunca some dinheiro do total). `this` = objeto unico de app.js.
 * REGRA: teto 300 (npm run checar-tamanho).
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.arquivar = () => ({
  // Tira o item da tela (arquiva). Avisa se ainda esta "em aberto". NUNCA apaga —
  // o backend so esconde da lista (o Relatorio mostra tudo). Recarrega no sucesso.
  async arquivarItem(tipo, id, opts = {}) {
    if (!id) return;
    const label = opts.label || 'isso';
    const pergunta = opts.aberto
      ? `"${label}" ainda esta EM ABERTO.\nTirar da tela mesmo assim? (nao apaga — continua no Relatorio)`
      : `Tirar "${label}" da tela? (nao apaga — continua no Relatorio)`;
    if (!confirm(pergunta)) return;
    const action = `arquivar-${tipo}-${id}`;
    this.saving = true;
    this.savingAction = action;
    try {
      await this.api(`itens/${tipo}/${encodeURIComponent(id)}/arquivar`, { method: 'POST' });
      await this.loadData();
      this.flash('Tirado da tela — ta no Relatorio se precisar.', 'success');
    } catch (err) {
      this.flash(this.errMessage(err));
    } finally {
      this.saving = false;
      this.savingAction = '';
    }
  },
});
