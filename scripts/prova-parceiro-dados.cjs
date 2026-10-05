// Cenários exclusivamente locais. Não consulta Chatwoot ou banco de dados.
const stores = new Map();
function initial(scenario) {
  const item = (size, qty = 1) => ({ tire_size: size, label: size, quantity: qty, tire_condition: 'meia_vida' });
  const items = [item('90/90-18'), item('80/100-14')];
  const pickup = { order_id: '11111111-1111-4111-8111-111111111111', order_number: 'PED-0248', awaiting_pickup: true, customer_name: 'Carlos', status: 'confirmed', payment_method: null, total_amount: 180, created_at: new Date().toISOString(), items };
  const delivery = (id, name, status, courier) => ({ order_id: id, order_status: 'confirmed', order_number: name === 'Maria' ? 'PED-0249' : 'PED-0250', customer_name: name, delivery_address: 'Rua dos Pneus, 100 — Méier, Rio de Janeiro', delivery_status: status, delivery_courier: courier, total_amount: 120, items: [item('90/90-18')], created_at: new Date().toISOString() });
  const photo = { id: '44444444-4444-4444-8444-444444444444', tire_size: '90/90-18', brand: null, photo_count: 0, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 900000).toISOString(), status: 'pending' };
  return {
    pickups: ['avisos', 'retirada'].includes(scenario) ? [pickup] : [],
    deliveries: ['avisos', 'entrega'].includes(scenario) ? [delivery('22222222-2222-4222-8222-222222222222', 'Maria', 'pending', null), delivery('33333333-3333-4333-8333-333333333333', 'Pedro', 'dispatched', 'João Meier')] : [],
    photos: ['avisos', 'foto'].includes(scenario) ? [photo] : [],
    waiting: ['esperando', 'fila'].includes(scenario) ? Array.from({ length: scenario === 'fila' ? 3 : 1 }, (_, index) => ({
      id: '55555555-5555-4555-8555-' + String(index + 1).padStart(12, '5'), revision: index + 1,
      items: index === 0 ? items : [item(index === 1 ? '100/90-18' : '110/90-17')],
      expires_at: new Date(Date.now() + 282000 + index * 8000).toISOString(),
    })) : [],
    stock: items.map((row, index) => ({ ...row, stock_id: 'stock-' + index, item_type: 'pneu', is_tracked: true, quantity_on_hand: 3, quantity_reserved: index ? 0 : 2 })),
  };
}
function fixturePayload(req, url, input) {
  const token = String(req.headers.authorization || '');
  const scenario = token.startsWith('Bearer preview-only-') ? token.slice('Bearer preview-only-'.length).split(':')[0] : 'vazio';
  if (!stores.has(token)) stores.set(token, initial(scenario));
  const data = stores.get(token);
  const pathname = url.pathname;
  if (pathname.endsWith('/confirmacoes-estoque')) return { enabled: true, rows: data.waiting };
  if (pathname.includes('/confirmacoes-estoque/') && req.method === 'POST') {
    data.waiting = data.waiting.filter(row => row.id !== pathname.split('/').at(-1));
    return { ok: true, status: input.available ? 'confirmed' : 'rejected' };
  }
  if (pathname.endsWith('/pedidos-foto')) return { enabled: true, photo_requests: data.photos };
  if (pathname.includes('/pedidos-foto/') && pathname.endsWith('/foto') && req.method === 'POST') {
    const id = pathname.split('/pedidos-foto/')[1].split('/')[0];
    const photo = data.photos.find(row => row.id === id);
    if (photo) { photo.status = 'answered'; photo.has_photo = true; photo.photo_count += 1; }
    return { ok: true, attached: true };
  }
  if (pathname.endsWith('/retiradas')) return { rows: data.pickups, service_catalog: [] };
  if (pathname.includes('/retiradas/') && ['POST', 'DELETE'].includes(req.method)) {
    data.pickups = data.pickups.filter(row => row.order_id !== pathname.split('/').at(-1));
    return req.method === 'DELETE' ? { cancelled: true } : { retrieved: true };
  }
  if (pathname.endsWith('/operacao/entregas')) return { rows: data.deliveries, summary: {},
    replenishment: scenario === 'avisos' ? { preview_only: true, measure: '90/90-18' } : null };
  if (pathname.includes('/api/entregas/') && req.method === 'POST') {
    const row = data.deliveries.find(item => item.order_id === pathname.split('/').at(-1));
    if (row) { row.delivery_status = input.delivery_status; row.delivery_courier = input.delivery_courier; }
    return { ok: true };
  }
  if (pathname.endsWith('/operacao/estoque')) return { rows: data.stock };
  return null;
}
module.exports = { fixturePayload };
