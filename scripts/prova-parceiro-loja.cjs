// Somente a prévia local: memória isolada por sessão, sem banco ou Chatwoot.
function storeFixture(req, url, input, data) {
  data.loja ||= {
    display_name: 'Borracharia Meier', opening_hours_text: 'Seg. a sáb. • 8h às 18h',
    address_street: 'Rua Dias da Cruz', address_number: '120', address_neighborhood: 'Méier',
    address_city: 'Rio de Janeiro', address_complement: null, cep: '20720-010', maps_url: null,
    faz_entrega: true, tem_retirada: true, delivery_radius_km: 5,
  };
  data.team ||= [
    { id: '66666666-6666-4666-8666-666666666666', label: 'Pedro Santos', username: 'pedro.santos', revoked_at: null },
    { id: '77777777-7777-4777-8777-777777777777', label: 'Ana Lima', username: 'ana.lima', revoked_at: null },
  ];
  const pathname = url.pathname;
  if (pathname.endsWith('/configuracoes')) return { loja: data.loja };
  if (pathname.endsWith('/configuracoes/loja') && req.method === 'PUT') { Object.assign(data.loja, input); return { updated: true }; }
  if (pathname.endsWith('/configuracoes/atendimento') && req.method === 'PUT') { Object.assign(data.loja, input); return { updated: true }; }
  if (pathname.endsWith('/funcionarios')) {
    if (req.method === 'POST') {
      const row = { id: require('node:crypto').randomUUID(), label: input.label, username: input.username, revoked_at: null };
      data.team.push(row); return row;
    }
    return { rows: data.team };
  }
  const row = data.team.find(person => pathname.includes('/funcionarios/' + person.id));
  if (!row) return null;
  if (pathname.endsWith('/config')) return { permissions: row.permissions || { vendas: true, estoque: true, retiradas: true, entregas: true }, commission: { active: false } };
  if (pathname.endsWith('/permissoes')) { row.permissions = input; return { permissions: input }; }
  if (pathname.endsWith('/reset-senha')) return { reset: true };
  if (pathname.endsWith('/reativar')) { row.revoked_at = null; return { reactivated: true }; }
  if (req.method === 'DELETE') { row.revoked_at = new Date().toISOString(); return { revoked: true }; }
  return null;
}
module.exports = { storeFixture };
