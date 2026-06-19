/**
 * sw.js — service worker da PWA do parceiro (0109).
 *
 * É o "ajudante invisível": o serviço de push do navegador acorda ESTE arquivo
 * mesmo com o painel/navegador FECHADO e ele mostra a notificação nativa (toca,
 * vibra, acende a tela). Ao tocar, abre/foca o painel da loja.
 *
 * De propósito ENXUTO: nada de cache offline aqui (o painel é online-first). Só o
 * que a notificação precisa. Escopo = pasta onde é servido (/parceiro/<slug>/),
 * então os caminhos relativos abaixo resolvem pro slug certo.
 */

self.addEventListener('install', () => {
  // Assume já — não espera o painel fechar pra ativar a versão nova.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    /* payload não-JSON: usa os defaults abaixo */
  }
  const title = data.title || 'Farejador';
  const body = data.body || 'Você tem um aviso novo na sua loja.';
  const tag = data.tag || 'farejador';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true, // mesmo tag tocando de novo ainda alerta (não silencia o 2º)
      icon: './assets/icon-192.png',
      badge: './assets/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: self.registration.scope },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url =
    (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of wins) {
        // Já tem o painel aberto numa aba? foca ela em vez de abrir outra.
        if (c.url.startsWith(url) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
      return undefined;
    })(),
  );
});
