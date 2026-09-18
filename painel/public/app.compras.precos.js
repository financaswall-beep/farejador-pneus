window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasPrecos = function () {
  return {
    comprasPriceVisibleGroups() {
      return window.PurchasePriceUtils.filter(this.comprasPriceGroups(), { query: this.comprasPriceVariantSearch });
    },
    comprasPriceHistoryDate(value) {
      return value ? window.FarejadorTime.formatDate(value) : '—';
    },
    comprasPriceHistoryChart() {
      return window.PurchasePriceUtils.chart(this.comprasPriceSelected(), value => this.comprasPriceHistoryDate(value));
    },
  };
};
