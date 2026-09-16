window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.vehicleTypes=function(){return {
    catalogoVehicleType: 'all', stockVehicleType: 'all', tireLotVehicleType: 'all',
    vehicleMatches(value, filter) { return !filter || filter === 'all' || (filter === 'unknown' ? value == null : value === filter); },
    get stockVehicleRows() { return (this.atacadoStock || []).filter(row => this.vehicleMatches(row.vehicle_type, this.stockVehicleType)); },
    vehicleFilterLabel(value) { return !value || value === 'all' ? 'Todos os pneus' : this.vehicleTypeLabel(value); },
    vehicleForVariant(item) {
      const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return (this.atacadoStock || []).find(row => String(row.measure || '').replace(/\D/g, '') === String(item.measure || '').replace(/\D/g, '') && key(row.brand) === key(item.brand) && row.tire_condition === item.tire_condition)?.vehicle_type || null;
    },
    purchaseVehicleResolve(item) {
      const key = value => String(value || '').replace(/[^0-9]/g, '');
      const rows = (this.catalogoRows || []).filter(row => row.product_type === 'tire' && key(row.tire_size) === key(item.measure)
        && String(row.brand || '').toLowerCase() === String(item.brand || '').toLowerCase() && row.tire_condition === item.tire_condition);
      if (!item.vehicle_type && rows.length === 1) item.vehicle_type = rows[0].vehicle_type || '';
    },
    vehicleTypeLabel(value) { return { motorcycle: 'Moto', car: 'Carro', mixed: 'Misto' }[value] || 'Não identificado'; },

    saleVehicleType: 'all',
    get saleVehicleProducts() { return (this.produtos || []).filter(row => (this.saleVehicleType === 'all' || row.product_type !== 'service') && this.vehicleMatches(row.vehicle_type, this.saleVehicleType)); },
    saleVehicleChanged() { this.saleForm.product_id=this.saleVehicleProducts.find(row=>row.walkin_sellable)?.product_id || ''; this.onProductChanged(); },
    get catalogoVehicleSummary() {
      const rows=(this.catalogoRows || []).filter(row => (this.catalogoVehicleType==='all'||row.product_type==='tire') && this.vehicleMatches(row.vehicle_type,this.catalogoVehicleType));
      const products=rows.filter(row => !row.measure_draft && row.catalogued!==false);
      return {products:products.length,brands:new Set(rows.map(row=>row.brand).filter(Boolean)).size,
        stock_only:rows.filter(row=>row.catalogued===false && !row.measure_draft).length,
        incomplete_registrations:rows.filter(row=>row.measure_draft).length,
        without_price:rows.filter(row=>!row.measure_draft && !(Number(row.price_amount)>0)).length,
        without_position:products.filter(row=>row.product_type==='tire' && !row.tire_position).length};
    },
  };
};
