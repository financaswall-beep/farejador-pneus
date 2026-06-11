/**
 * app.charts.resumo.js - fabrica `chartsResumo` do painel do parceiro (obra <=300, passo 3/11).
 * MORA AQUI: o maestro renderAllCharts (unico ponto que repinta TUDO: init, troca de
 * tema, resize, loadData). Os 3 graficos vivos moram em app.charts.pdv.js; instancias
 * vivem em window._xxxChart (F5 do plano - NAO mexer).
 * HISTORIA (F9, decisao do dono 2026-06-11): 8 renders orfaos (~330 linhas) apagados -
 * os canvas deles sairam do index.html em reforma anterior a obra e os renders nunca
 * pintavam (if !ctx return). app.charts.financeiro.js (4 renders, todo orfao) foi
 * APAGADO inteiro. Recuperavel no git: commit 2aee88a tem tudo.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.chartsResumo = () => ({
    renderAllCharts() {
      this.renderPosSparkline();
      this.renderFinanceRevenuePosChart();
      this.renderFinanceCostsPosChart();
    },
});
