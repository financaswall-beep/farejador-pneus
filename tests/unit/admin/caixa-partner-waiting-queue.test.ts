import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const item = (id: string, seconds: number, revision = 1) => ({
  id, revision, expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
  customer_name: 'Identidade protegida',
  items: [{ tire_size: '90/90-18', quantity: 1, tire_condition: 'meia_vida' }],
});

describe('Fila de confirmações do parceiro', () => {
  it('atende três pedidos por urgência, avança sozinho e preserva prazo e revisão de cada um', async () => {
    const { C, root, ready, button, node } = partnerScreen(); ready();
    C.partnerData.state.waiting = [item('terceiro', 290, 3), item('primeiro', 180, 1), item('segundo', 240, 2)];
    C.partnerHome.refresh = vi.fn(async () => C.partnerWaiting.sync(C.partnerData.state.waiting));
    C.partnerWaiting.sync(C.partnerData.state.waiting); C.partnerHome.render();
    expect(root.textContent).toContain('PEDIDO 1 DE 3');
    expect(root.textContent).toContain('Mais 2 clientes aguardando');
    expect(root.textContent).not.toContain('Identidade protegida');
    expect(node('partner-home-badge').textContent).toBe('3');
    const secondDeadline = C.partnerData.state.waiting.find((row: any) => row.id === 'segundo').expires_at;

    await button('TENHO').click();
    await vi.waitFor(() => expect(C.partnerWaiting.current()?.id).toBe('segundo'));
    expect(C.partnerHome.currentTab()).toBe('partner-waiting');
    expect(root.textContent).toContain('PEDIDO 2 DE 3');
    expect(root.textContent).toContain('Mais 1 cliente aguardando');
    expect(C.partnerWaiting.current().expires_at).toBe(secondDeadline);
    expect(node('partner-home-badge').textContent).toBe('2');

    await button('NÃO TENHO').click();
    await vi.waitFor(() => expect(C.partnerWaiting.current()?.id).toBe('terceiro'));
    expect(root.textContent).toContain('PEDIDO 3 DE 3');
    expect(root.textContent).not.toContain('clientes aguardando');
    expect(JSON.parse(C.authenticatedFetch.mock.calls[1][1].body)).toEqual({ available: false, revision: 2 });

    await button('TENHO').click();
    await vi.waitFor(() => expect(C.partnerHome.currentTab()).toBe('partner-home'));
    expect(root.textContent).toContain('Tudo em dia!');
    expect(C.partnerWaiting.count()).toBe(0);
    expect(C.authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(node('partner-home-badge').classList.contains('hidden')).toBe(true);
  });

  it('atualiza o contador quando chega outro pedido sem reiniciar o relógio do atual', () => {
    const { C, root, ready } = partnerScreen(); ready();
    const current = item('atual', 180);
    C.partnerWaiting.sync([current]); C.partnerHome.render();
    expect(root.textContent).not.toContain('PEDIDO 1 DE');
    C.partnerWaiting.sync([current, item('novo', 290)]); C.partnerHome.render();
    expect(root.textContent).toContain('PEDIDO 1 DE 2');
    expect(C.partnerWaiting.current().expires_at).toBe(current.expires_at);
  });

  it('não repete resposta com clique duplo nem repõe um pedido respondido por consulta atrasada', async () => {
    const { C, ready, button } = partnerScreen(); ready();
    const rows = [item('atual', 180), item('proximo', 240)];
    C.partnerData.state.waiting = rows;
    C.partnerHome.refresh = vi.fn(async () => C.partnerWaiting.sync(rows));
    let resolve: (value: any) => void = () => {};
    C.authenticatedFetch.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    C.partnerWaiting.sync(rows);
    button('TENHO').click(); button('ENVIANDO…').click();
    expect(C.authenticatedFetch).toHaveBeenCalledOnce();
    resolve({ ok: true, json: async () => ({ ok: true, status: 'confirmed' }) });
    await vi.waitFor(() => expect(C.partnerWaiting.current()?.id).toBe('proximo'));
    expect(C.partnerWaiting.count()).toBe(1);
  });

  it('pula pedidos vencidos e limpa a fila quando muda a sessão', () => {
    const { C, root, ready } = partnerScreen(); ready();
    C.partnerData.state.waiting = [item('vencido', -10), item('valido', 240)];
    C.partnerWaiting.sync(C.partnerData.state.waiting); C.partnerHome.render();
    expect(C.partnerWaiting.current().id).toBe('valido');
    expect(C.partnerWaiting.count()).toBe(1);
    expect(root.textContent).not.toContain('PEDIDO 1 DE');
    C.partnerHome.reset();
    expect(C.partnerWaiting.current()).toBeNull(); expect(C.partnerWaiting.count()).toBe(0);
  });

  it('mantém o pedido e a fila quando a resposta falha', async () => {
    const { C, ready, root, button } = partnerScreen(); ready();
    C.partnerData.state.waiting = [item('atual', 180), item('proximo', 240)];
    C.authenticatedFetch.mockRejectedValueOnce(new Error('network_failure'));
    C.partnerWaiting.sync(C.partnerData.state.waiting);
    button('TENHO').click();
    await vi.waitFor(() => expect(root.textContent).toContain('Não consegui concluir'));
    expect(C.partnerWaiting.current().id).toBe('atual');
    expect(C.partnerWaiting.count()).toBe(2);
    expect(root.textContent).toContain('PEDIDO 1 DE 2');
    expect(button('TENHO').disabled).toBe(false);
  });

  it('abre o próximo quando o atual vence, sem enviar resposta nem renovar a validade', () => {
    vi.useFakeTimers();
    try {
      const { C, context, ready } = partnerScreen(); ready();
      const next = item('proximo', 240);
      C.partnerData.state.waiting = [item('atual', 2), next];
      C.partnerWaiting.sync(C.partnerData.state.waiting);
      vi.advanceTimersByTime(3000);
      context.window.setInterval.mock.calls[0][0]();
      expect(C.partnerWaiting.current().id).toBe('proximo');
      expect(C.partnerWaiting.current().expires_at).toBe(next.expires_at);
      expect(C.authenticatedFetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
