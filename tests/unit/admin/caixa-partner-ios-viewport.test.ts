import { describe, expect, it, vi } from 'vitest';
import { partnerScreen } from './helpers/partner-simple-dom.js';

const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const chrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';

function screen(userAgent: string, partner = true) {
  const fixture = partnerScreen(partner);
  const viewport = { height: 780, offsetTop: 0, scale: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  Object.assign(fixture.context.window.navigator, { userAgent });
  Object.assign(fixture.context.window, { visualViewport: viewport, innerHeight: 844 });
  return { ...fixture, viewport, html: fixture.context.document.documentElement };
}

describe('rolagem do parceiro no iOS', () => {
  it.each([safari, chrome])('prende só a página externa, acompanha o teclado e libera ao sair (%s)', userAgent => {
    const f = screen(userAgent);
    f.ready();
    expect(f.html.classList.contains('partner-ios-locked')).toBe(true);
    expect(f.html.style['--partner-ios-height']).toBe('780px');
    expect(f.context.window.scrollTo).toHaveBeenCalledWith(0, 0);
    const resize = f.viewport.addEventListener.mock.calls.find(([event]) => event === 'resize')![1];
    f.viewport.height = 440; f.viewport.offsetTop = 64;
    resize();
    expect(f.html.style['--partner-ios-height']).toBe('440px');
    expect(f.html.style['--partner-ios-top']).toBe('64px');
    f.C.partnerHome.sync('partner-stock');
    expect(f.viewport.addEventListener).toHaveBeenCalledTimes(2);
    f.viewport.scale = 2; f.viewport.height = 220;
    resize();
    expect(f.html.style['--partner-ios-height']).toBe('440px');
    f.C.partnerHome.reset();
    expect(f.html.classList.contains('partner-ios-locked')).toBe(false);
    expect(f.html.style['--partner-ios-height']).toBeUndefined();
    expect(f.html.style['--partner-ios-top']).toBeUndefined();
    expect(f.viewport.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it.each(['Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0'])('preserva a rolagem fora do iOS (%s)', userAgent => {
    const f = screen(userAgent);
    f.ready();
    expect(f.html.classList.contains('partner-ios-locked')).toBe(false);
    expect(f.html.style.setProperty).not.toHaveBeenCalled();
    expect(f.viewport.addEventListener).not.toHaveBeenCalled();
    expect(f.context.window.scrollTo).not.toHaveBeenCalled();
  });

  it('não altera a matriz no iPhone', () => {
    const f = screen(safari, false);
    f.ready();
    expect(f.html.classList.contains('partner-ios-locked')).toBe(false);
    expect(f.viewport.addEventListener).not.toHaveBeenCalled();
  });

  it('libera a página quando a sessão expira', () => {
    const f = screen(safari);
    f.ready();
    f.setSession('');
    f.C.partnerHome.sync('partner-home');
    expect(f.html.classList.contains('partner-ios-locked')).toBe(false);
    expect(f.html.style['--partner-ios-height']).toBeUndefined();
  });
});
