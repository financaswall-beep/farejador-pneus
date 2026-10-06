// Prévia local: preços e pedidos fictícios, sem consultas ou escrita no banco.
function buyFixture(req, url, input, data) {
  const rows = [['90/90-18',12,6500],['110/90-17',6,8000],['2.75-18',15,5000],['100/90-18',10,7500],['80/100-14',8,5500],['195/65-15',7,11000]]
    .map(([measure,quantity_available,price_cents]) => ({ measure,quantity_available,price_cents,brand:'Pirelli',tire_condition:'meia_vida',
      vehicle_type: measure === '195/65-15' ? 'car' : 'motorcycle',offer_key:JSON.stringify([measure,'Pirelli','meia_vida']) }));
  if (url.pathname.endsWith('/operacao/comprar')) return { rows, checkout_enabled: false };
  if (url.pathname.endsWith('/operacao/comprar/pedidos') && req.method === 'POST') {
    data.buyRequests ||= new Map();
    if (!data.buyRequests.has(input.idempotency_key)) data.buyRequests.set(input.idempotency_key,{ request_id:'preview-buy-' + data.buyRequests.size,
      request_number:'CMP-0001',status:'pending',items:input.items });
    return data.buyRequests.get(input.idempotency_key);
  }
  return null;
}
module.exports = { buyFixture };
