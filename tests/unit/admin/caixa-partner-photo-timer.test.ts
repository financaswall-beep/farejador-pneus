import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const photo = (id: string, seconds: number) => ({ id, tire_size: '90/90-18', expires_at: new Date(Date.now() + seconds * 1000).toISOString() });

describe('Relógio do cartão de foto do parceiro', () => {
  it('conta o prazo do servidor a cada segundo e não reinicia ao atualizar os avisos', () => {
    vi.useFakeTimers();
    try {
      const { C, root, ready, context } = partnerScreen();
      C.state.photoRequests = [photo('foto-a', 282)]; ready();
      const timer = () => root.querySelectorAll('span').find(el => el.attributes.role === 'timer')!;
      expect(timer().textContent).toBe('4:42');
      const tick = context.window.setInterval.mock.calls.at(-1)![0];
      vi.advanceTimersByTime(2000); tick();
      expect(timer().textContent).toBe('4:40');
      C.partnerHome.render(); expect(timer().textContent).toBe('4:40');
      expect(C.authenticatedFetch).not.toHaveBeenCalled();
      C.partnerHome.open('partner-photos');
      expect(context.window.clearInterval).toHaveBeenCalledWith(1);
      C.partnerHome.open('partner-home');
      context.window.clearInterval.mockClear(); C.partnerHome.reset();
      expect(context.window.clearInterval).toHaveBeenCalledWith(1);
    } finally { vi.useRealTimers(); }
  });
  it('mostra o menor prazo entre várias fotos e omite o relógio sem validade válida', () => {
    const { C, root, ready } = partnerScreen();
    C.state.photoRequests = [photo('menos-urgente', 600), { id: 'invalida', expires_at: 'inválido' }, photo('urgente', 60)]; ready();
    const timer = root.querySelectorAll('span').find(el => el.attributes.role === 'timer')!;
    expect(timer.textContent).toBe('1:00');
    expect(timer.title).toBe('Menor prazo entre os pedidos de foto');
    C.state.photoRequests = [{ id: 'sem-prazo', tire_size: '90/90-18' }]; C.partnerHome.render();
    expect(root.querySelectorAll('span').some(el => el.attributes.role === 'timer')).toBe(false);
  });
  it('para em zero quando vence, sem esconder o pedido nem cancelar a foto no servidor', () => {
    vi.useFakeTimers();
    try {
      const { C, root, ready, context } = partnerScreen();
      C.state.photoRequests = [photo('foto-a', 2)]; ready();
      const tick = context.window.setInterval.mock.calls.at(-1)![0];
      vi.advanceTimersByTime(3000); tick();
      const timer = root.querySelectorAll('span').find(el => el.attributes.role === 'timer')!;
      expect(timer.textContent).toBe('0:00');
      expect(timer.attributes['aria-label']).toBe('Prazo da foto encerrado');
      expect(context.window.clearInterval).toHaveBeenCalledWith(1);
      expect(root.textContent).toContain('Cliente pediu foto');
      expect(C.state.photoRequests).toHaveLength(1);
      expect(C.authenticatedFetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
