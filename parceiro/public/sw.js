/**
 * Tombstone da PWA antiga do parceiro.
 *
 * Este arquivo precisa continuar publicado por um ciclo de rollout: instalações
 * existentes procuram a mesma URL para atualizar o worker. Ao ativar, ele remove
 * o próprio registro e conduz qualquer janela ainda aberta à Operação da Loja.
 */

self.addEventListener('install', () => {
  // Assume já — não espera o painel fechar pra ativar a versão nova.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await self.registration.unregister();
    await Promise.all(windows.map((client) => client.navigate('/operacao')));
  })());
});
