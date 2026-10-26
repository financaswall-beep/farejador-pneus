import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function screen(mode = 'photos') {
  const row = { product_id: 'product-one', tire_size: '100/80-14', brand: 'Kenda', tire_condition: 'novo', enabled: true,
    product_code: 'KD-014', photos: [{ id: 'photo-one', angle: 'front', is_primary: true }, { id: 'photo-side', angle: 'side', is_primary: false }], video: { id: 'video-one' } };
  const state: any = { selected: row, screen: mode, enabled: true, storageReady: true, botReady: true, search: '', filter: 'all', page: 1, busy: false, angle: 'front', preview: mode === 'preview' };
  const app: any = { matrixPhotos: state, mcphPhoto: (item = state.selected, angle = state.angle) => item.photos?.find((photo: any) => photo.angle === angle),
    mcphPrimary: () => row.photos.find(photo => photo.is_primary), mcphFiltered: () => [row], mcphPageRows: () => [row], mcphVideoSize: () => '2,4 MB · 15 segundos', mcphRequest: vi.fn() };
  const host: any = { dataset: {}, innerHTML: '', contains: () => false, querySelectorAll: () => [], querySelector: () => null };
  const C: any = { operationCatalogUtils: { conditionLabel: () => 'Novo' }, elements: { catalogPanel: { scrollTop: 0 } }, matrixCatalogMetal: { mediaChanged: vi.fn() } };
  const context = { window: { Caixa: C }, document: { activeElement: null, getElementById: () => null } };
  runInNewContext(readFileSync('painel/public/caixa-catalog-metal-view.js', 'utf8'), context);
  runInNewContext(readFileSync('painel/public/caixa-catalog-media-view.js', 'utf8'), context);
  const image = vi.fn((photo: any) => 'blob:' + photo.id), videoSource = vi.fn(() => 'blob:video-one');
  const render = () => { C.catalogMetalMedia.render({ app, host, image, videoSource }); return host.innerHTML as string; };
  return { row, state, app, render, host, image, videoSource };
}
describe('mídias do Catálogo da Matriz', () => {
  it('a prévia mostra a foto do produto sem disparar mensagem ou escrita', () => {
    const a = screen('preview'), html = a.render();
    expect(html).toContain('Nenhuma mensagem foi enviada');
    expect(html).toContain('data-mcph-image="photo-one"');
    expect(html).not.toContain('data-action="camera"');
    expect(a.app.mcphRequest).not.toHaveBeenCalled();
  });
  it.each(['photos', 'video', 'preview'])('não depende de Drive na tela %s', mode => {
    const a = screen(mode); a.state.drive = { configured: true, email: 'private-drive@example.invalid' };
    a.row['drive_enabled' as keyof typeof a.row] = true as never;
    const html = a.render(); expect(html).not.toMatch(/Drive|drive-enabled|private-drive/);
    expect(a.app.mcphRequest).not.toHaveBeenCalled();
  });
  it('escapa identificação do produto e erros recebidos da fonte', () => {
    const a = screen(); a.row.brand = '<img src=x onerror=alert(1)>'; a.state.error = '<script>bad()</script>';
    const html = a.render(); expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img src=x'); expect(html).not.toContain('<script>');
  });
  it('mantém os ângulos e oferece definir como principal somente na foto correta', () => {
    const a = screen(); expect(a.render()).toContain('Foto principal do atendimento');
    a.state.angle = 'side'; const html = a.render();
    expect(html).toContain('data-action="primary"'); expect(html).toContain('data-mcph-image="photo-side"');
    expect(html).not.toContain('Foto principal do atendimento');
  });
  it('uma foto basta e os ângulos ausentes não ganham fotos inventadas', () => {
    const a = screen(); a.row.photos = a.row.photos.slice(0, 1); a.state.angle = 'side';
    const html = a.render(); expect(html).toContain('Uma foto basta. Os outros ângulos são opcionais.');
    expect(html).not.toContain('data-mcph-image="photo-side"');
  });
  it('carrega o vídeo pelo identificador daquele produto', () => {
    const a = screen('video'); const html = a.render();
    expect(html).toContain('data-mcph-video="video-one"'); expect(html).toContain('blob:video-one');
    expect(a.videoSource).toHaveBeenCalledWith(a.row.video); expect(a.app.mcphRequest).not.toHaveBeenCalled();
  });
});
