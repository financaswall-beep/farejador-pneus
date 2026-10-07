import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const photo = (id: string, group = id, name = 'Carlos') => ({ id, photo_group_id: group, customer_name: name,
  tire_size: id === 'b' ? '80/100-14' : 'Pneu 90/90-18', brand: 'Pirelli', photo_count: 0,
  expires_at: new Date(Date.now() + 282000).toISOString() });
type Screen = ReturnType<typeof partnerScreen>;
async function capture(s: Screen, file = 'foto', inputIndex = 0) {
  const input = s.root.querySelectorAll('input')[inputIndex];
  input.files = [file]; await input.fire('change');
  await vi.waitFor(() => expect(s.C.partnerPhoto.busy()).toBe(false));
}
async function pair(s: Screen) {
  s.C.state.photoRequests = [photo('a', 'group'), photo('b', 'group')]; s.ready(); s.C.partnerPhoto.open('a');
  await capture(s, 'primeiro'); await s.button('PRÓXIMO PNEU').click(); await capture(s, 'segundo');
  await s.button('CONFERIR FOTOS').click();
}
describe('Câmera e conferência do parceiro', () => {
  it('um pneu mantém câmera nativa e envia só depois da conferência', async () => {
    const s = partnerScreen(); s.C.state.photoRequests = [photo('a')]; s.ready(); s.C.partnerPhoto.open('a');
    expect(s.root.textContent).toContain('Foto do pneu');
    expect(s.root.textContent).not.toContain('PNEU 1 DE');
    const input = s.root.querySelectorAll('input')[0] as any;
    expect(input.capture).toBe('environment'); expect(input.accept).toBe('image/*');
    await capture(s);
    expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
    expect(s.root.textContent).not.toContain('PRÓXIMO PNEU');
    s.C.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ attached: true }) });
    await s.button('ENVIAR FOTO').click();
    await vi.waitFor(() => expect(s.C.showToast).toHaveBeenCalledWith('Foto encaminhada ao cliente.'));
    expect(s.C.authenticatedFetch.mock.calls[0][0]).toContain('/a/foto');
  });
  it('dois pneus da mesma solicitação preservam a medida e o UUID de cada imagem', async () => {
    const s = partnerScreen();
    s.C.compressPhoto.mockImplementation(async (file: string) => ({ file })); await pair(s);
    expect(s.root.textContent).toContain('Conferir fotos'); expect(s.root.querySelectorAll('img')).toHaveLength(2);
    expect(s.root.textContent).toContain('90/90-18'); expect(s.root.textContent).toContain('80/100-14');
    expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
    s.C.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({ attached: true }) });
    await s.button('ENVIAR FOTOS').click();
    await vi.waitFor(() => expect(s.C.authenticatedFetch).toHaveBeenCalledTimes(2));
    expect(s.C.authenticatedFetch.mock.calls.map((call: any[]) => [call[0].split('/').at(-2), call[1].body.file]))
      .toEqual([['a', 'primeiro'], ['b', 'segundo']]);
  });
  it('não agrupa clientes com o mesmo nome, nem pedidos antigos sem grupo', async () => {
    const s = partnerScreen(); s.C.state.photoRequests = [photo('a'), photo('b'), { ...photo('c'), photo_group_id: undefined }];
    s.ready(); s.C.partnerHome.open('partner-photos');
    expect(s.root.querySelectorAll('.ps-photo-request')).toHaveLength(3);
    s.C.partnerPhoto.open('a'); await capture(s);
    expect(s.root.textContent).not.toContain('PRÓXIMO PNEU');
  });
  it('cancelar a câmera não apaga a foto; refazer no fluxo de dois pneus substitui sem aumentar a quantidade', async () => {
    const s = partnerScreen(); s.C.state.photoRequests = [photo('a', 'group'), photo('b', 'group')]; s.ready(); s.C.partnerPhoto.open('a'); await capture(s);
    const input = s.root.querySelectorAll('input')[0]; input.files = []; await input.fire('change');
    expect(s.root.querySelectorAll('img')).toHaveLength(1);
    expect(s.context.URL.revokeObjectURL).not.toHaveBeenCalled();
    await capture(s, 'nova'); expect(s.root.querySelectorAll('img')).toHaveLength(1);
    expect(s.context.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it('uma falha no segundo envio conserva essa foto e não reenvia a primeira', async () => {
    const s = partnerScreen(); await pair(s);
    s.C.authenticatedFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ attached: true }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'failed' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ attached: true }) });
    await s.button('ENVIAR FOTOS').click();
    await vi.waitFor(() => expect(s.root.textContent).toContain('Tente enviar as restantes'));
    expect(s.root.querySelectorAll('img')).toHaveLength(1);
    await s.button('ENVIAR FOTOS').click();
    await vi.waitFor(() => expect(s.C.showToast).toHaveBeenCalledWith('Fotos encaminhadas ao cliente.'));
    expect(s.C.authenticatedFetch.mock.calls.map((call: any[]) => call[0].split('/').at(-2))).toEqual(['a', 'b', 'b']);
  });
  it('respeita limite de três fotos, pausa timer ao sair e limpa URLs no logout', async () => {
    const s = partnerScreen(); s.C.state.photoRequests = [photo('a')]; s.ready(); s.C.partnerPhoto.open('a');
    await capture(s); await capture(s, '2'); await capture(s, '3');
    expect(s.root.querySelectorAll('img')).toHaveLength(3); expect(s.button('+ OUTRA FOTO')).toBeUndefined();
    s.C.partnerHome.open('partner-sales'); expect(s.context.window.clearInterval).toHaveBeenCalled();
    s.C.partnerHome.reset(); expect(s.context.URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });
  it('logout durante a compressão não restaura dados nem envia fotos na nova sessão', async () => {
    const s = partnerScreen(); s.C.state.photoRequests = [photo('a')]; s.ready(); s.C.partnerPhoto.open('a');
    let finish!: (value: unknown) => void;
    s.C.compressPhoto.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const input = s.root.querySelectorAll('input')[0]; input.files = ['foto']; await input.fire('change');
    s.setSession('session-b'); s.C.partnerHome.reset(); finish({}); await Promise.resolve(); await Promise.resolve();
    expect(s.root.querySelectorAll('img')).toHaveLength(0); expect(s.context.URL.createObjectURL).not.toHaveBeenCalled();
    expect(s.C.authenticatedFetch).not.toHaveBeenCalled();
  });
});
