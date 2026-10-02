import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { expect, it } from 'vitest';

it('monta o painel com os scripts reais na ordem do HTML e preserva as duas revisões', () => {
  const proof = readFileSync('scripts/prova-paridade-matriz.cjs', 'utf8');
  const mockBrowser = proof.slice(proof.indexOf('function criarSandbox()'), proof.indexOf('function tipoDe('));
  const sandbox = new Function('Buffer', mockBrowser + '; return criarSandbox();')(Buffer);
  const context = createContext(sandbox);
  const html = readFileSync('painel/public/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src="\/admin\/painel\/([^"?]+\.js)(?:\?[^"]*)?"/g)]
    .map(match => match[1]!).filter(file => !file.startsWith('vendor/'));
  for (const file of scripts) runInContext(readFileSync('painel/public/' + file, 'utf8'), context, { filename: file });
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
