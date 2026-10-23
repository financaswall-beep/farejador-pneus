import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';

it('monta o painel com os scripts reais na ordem do HTML e preserva as duas revisões', () => {
  const proof = readFileSync('scripts/prova-paridade-matriz.cjs', 'utf8');
  const mockBrowser = proof.slice(proof.indexOf('function criarSandbox()'), proof.indexOf('function tipoDe('));
  const sandbox = new Function('Buffer', mockBrowser + '; return criarSandbox();')(Buffer);
  const html = readFileSync('painel/public/index.html', 'utf8');
  // The shared chat mounts real nodes before painelApp() is constructed.
  // Register IDs from both the page and dynamically generated markup.
  const nodes = new Map<string, any>();
  const originalCreate = sandbox.document.createElement;
  function element() {
    const node = originalCreate();
    node.children = [];
    node.append = (...children: any[]) => {
      node.children.push(...children);
      for (const child of children) if (child.id) nodes.set(child.id, child);
    };
    Object.defineProperty(node, 'innerHTML', {
      get() { return node.markup || ''; },
      set(value: string) {
        node.markup = value;
        for (const match of value.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1]!, element());
      },
    });
    return node;
  }
  sandbox.document.createElement = element;
  sandbox.document.body = element();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1]!, element());
  sandbox.document.getElementById = (id: string) => nodes.get(id) || null;
  const context = createContext(sandbox);
  const scripts = [...html.matchAll(/<script[^>]+src="\/admin\/painel\/([^"?]+\.js)(?:\?[^"]*)?"/g)]
    .map(match => match[1]!).filter(file => !file.startsWith('vendor/'));
  for (const file of scripts) runInContext(readFileSync('painel/public/' + file, 'utf8'), context, { filename: file });
  expect(nodes.get('bot-chat-root').children[0].id).toBe('chat-panel');
  expect(nodes.get('chat-search')).toBeTruthy();
  expect(typeof sandbox.FarejadorBotChat.chat.renderThread).toBe('function');
  const app = runInContext('painelApp()', context);
  expect(typeof app.loadMarketingReviews).toBe('function');
  expect(typeof app.marketingReviewSubmit).toBe('function');
  expect(app.metaIdentityReviews.pending).toBe(0);
  expect(app.googleConversionReviews).toEqual([]);
  expect(typeof app.googleAdsOpen).toBe('function');
  expect(typeof app.closeMarketingCampaignDetail).toBe('function');
  const staticRoutes = readFileSync('src/admin/painel/route-static.ts', 'utf8');
  expect(staticRoutes).toContain("'app.marketing.reviews.js'");
});
