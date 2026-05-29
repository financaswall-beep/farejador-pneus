# Handoff — Responsividade mobile do Portal Parceiro (2026-05-29)

Documento de continuidade pra outra LLM/dev tocar o trabalho de **deixar o Portal Parceiro bom no celular**. Escrito por Claude (Opus 4.8). Self-contained: assume zero contexto da conversa anterior.

---

## 0. TL;DR do estado atual

- **O que está pronto:** a tela **Frente de caixa (vendas)** tem um layout próprio de celular, dentro de um `@media (max-width: 768px)` isolado. O desktop **não foi tocado**.
- **O que falta:** as outras telas (Estoque, Financeiro, Clientes, Resumo, Pedidos) só recebem o tratamento genérico (empilham em 1 coluna). Faltam polimentos por tela (tabelas, forms, charts).
- **Status git:** este trabalho mobile está **NÃO commitado** (working tree). A feature anterior `item_type` (insumos/serviços) já está commitada (`7fdb7bc`) e tem a migration `0067` **pendente de aplicar em prod**.

---

## 1. Como o portal funciona (contexto mínimo)

- SPA única em **Alpine.js + Tailwind (CDN) + Chart.js**, **sem build step**. Arquivos:
  - `parceiro/public/index.html` — markup + diretivas Alpine (`x-show`, `x-text`, `x-model`, `@click`).
  - `parceiro/public/app.js` — `parceiroApp()` retorna o objeto de estado/“controller” do Alpine (getters, métodos).
  - `parceiro/public/style.css` — CSS custom (o grosso do visual; Tailwind cobre utilitários soltos).
- Backend Fastify em `src/parceiro/` (`route.ts`, `queries.ts`, `auth.ts`). Não é necessário pra mexer no layout.
- Navegação por **seções** via `currentSection` (`resumo` | `vendas` | `clientes` | `estoque` | `financeiro`). Cada seção é um `<section x-show="currentSection === '...'">`.
- Ao publicar, **suba o cache-bust** nos links do `index.html` (`?v=...` em `style.css` e `app.js`), senão o navegador serve cache velho.

---

## 2. Como a responsividade funciona aqui (a regra de ouro)

**Todo CSS mobile vai dentro de `@media (max-width: 768px) { ... }`.** O navegador só lê esse bloco quando a largura ≤ 768px. No desktop é como se não existisse → **desktop nunca quebra**. `<meta name="viewport" content="width=device-width, initial-scale=1">` já está no `<head>` (faz o celular reportar a largura real).

- Esconder no celular: `display:none` **dentro** do `@media`.
- Esconder no desktop: `display:none` **fora** + reexibir dentro do `@media` (ex.: o botão flutuante `.pos-fab-finalize`).
- O elemento **continua no HTML**; só não é desenhado. Por isso é seguro.

Breakpoint atual: **768px**. Se for mexer, é o único número a trocar. Considerar um breakpoint intermediário (ex.: 1024px tablet) é opção futura.

---

## 3. O que já foi feito (tela Frente de caixa / `vendas`)

Tudo no bloco `@media (max-width: 768px)` no **fim** de `parceiro/public/style.css` (logo após o `@media (max-width: 1280px)`).

| Mudança | Como |
|---|---|
| **Sidebar → barra de abas no rodapé** | `.pos-sidebar` vira `position:fixed; bottom:0; height:58px; flex-direction:row`. `.pos-nav` horizontal; `.pos-nav-item` vira ícone+label pequeno; `.pos-logo`/`.pos-settings`/`.pos-version`/`kbd` escondidos. |
| **Conteúdo rola** | `.pos-main { display:block; height:100%; overflow-y:auto; padding-bottom:66px }` (espaço pra barra). |
| **Topbar compacto** | `.pos-topbar` vira flex-wrap; escondidos: `.pos-global-search`, `.pos-top-icons`, `.pos-online` (o “Sistema online”), textos secundários do `.pos-user`. Nome da empresa (`.pos-company .font-bold`) forçado a 1 linha com ellipsis. |
| **KPIs 2 a 2** | `.pos-kpis`/`.pos-kpis-inline` viram `grid-template-columns:1fr 1fr`, cards menores, `.pos-spark` escondido. |
| **Checkout empilha** | `.pos-checkout`/`.pos-grid` viram `display:block`; `.pos-products`/`.pos-center`/`.pos-summary` ficam `width:100%`. |
| **Card de produto enxuto** | `.pos-product-card` vira grid `minmax(0,1fr) auto 28px`; foto (`.pos-tire-thumb`) e estrela (`.pos-star`) escondidas; subtítulo (`.pos-product-info small`) escondido (perde 1 linha). |
| **Filtros escondidos** | `.pos-filter-row { display:none }` (o campo de busca já filtra). |
| **Demais grids em 1 coluna** | `.pos-page-grid`(+`.finance`/`.customers`), `.pos-chart-grid`, `.pos-cadastro-grid` → `1fr`. `.pos-footer` escondido. |
| **Botão flutuante “Finalizar”** | Pílula amarela fixa (`.pos-fab-finalize`), aparece só com item no carrinho, rola até o resumo. Ver abaixo. |

### Botão flutuante de finalizar
- HTML: dentro da `<section ... class="pos-grid pos-checkout">` da tela `vendas`, **após** o `</aside>` do `.pos-summary`:
  ```html
  <button class="pos-fab-finalize" x-show="posCart.length"
          @click="document.querySelector('.pos-summary').scrollIntoView({ behavior: 'smooth', block: 'start' })"
          title="Ir para finalizar a venda">
    <i data-lucide="shopping-bag"></i>
    <span x-text="'Finalizar • ' + money(posCartTotal)"></span>
  </button>
  ```
- CSS: regra base `.pos-fab-finalize { display:none }` (esconde no desktop, fica antes do `@media (max-width:1280px)`) + `display:flex` dentro do `@media (max-width:768px)`.
- O usuário descreveu como “setinha amarela”; foi entregue como pílula “Finalizar • R$”. Se quiser seta literal, trocar o ícone `shopping-bag` por `arrow-down` (ou `corner-down-right`).

---

## 4. O que falta (próximos passos sugeridos, em ordem)

1. **Tela Estoque** — a tabela `.pos-dark-table` usa `grid-template-columns` com larguras fixas (8 colunas) que **estouram no celular**. Opções: virar “cards” empilhados no mobile, ou esconder colunas secundárias (Posição/Custo) e manter Medida/Qtd/Venda/Ações. O form lateral (`.pos-side-panel`, abas Pneu/Insumo/Serviço) já empilha via `.pos-page-grid 1fr`, mas revisar tamanho dos inputs.
2. **Tela Financeiro** — os charts (`.pos-chart-box` canvas) precisam de altura fixa no mobile pra não sumir/esticar; os forms (`.pos-form-grid`) revisar de 2→1 coluna. O gauge do score (`.finance-gauge`, SVG) já é fluido (`width:100%`).
3. **Tela Clientes** — tabela + form, mesmo tratamento do Estoque.
4. **Tela Resumo** — KPIs já viram 2 colunas; revisar os 3 charts.
5. **Pedidos** — placeholder hoje.
6. **Polish do FAB** — opcional: trocar ícone por seta; mostrar também a contagem de itens.
7. **(Maior) PWA** — adicionar `manifest.json` + service worker pra “Adicionar à tela inicial” (ícone, tela cheia, sem barra do navegador). Não exige app nativo. É o passo que faz “virar app” de verdade.

**Princípio:** cada tela ganha layout próprio de celular — **não encolher** o desktop. Empilhar em coluna cheia, alvos de toque grandes, esconder o que é decorativo/redundante.

---

## 5. Como testar visualmente (preview local)

O portal exige login (`authed`). Pra inspeção visual rápida, sobe um estático e força o estado pelo Alpine.

```bash
# servir os arquivos estáticos (qualquer http server)
npx http-server parceiro/public -p 4599 -c-1
```

No navegador/preview, **largura de celular** (ex.: 375×812) e injetar estado (o `_x_dataStack[0]` é o objeto reativo do Alpine na raiz `[x-data]`):

```js
const d = document.querySelector('[x-data]')._x_dataStack[0];
d.authed = true;                 // pula o login
d.currentSection = 'vendas';     // ou 'estoque', 'financeiro'...
// dados fake pra ver os cards do PDV:
d.produtos = [
  {stock_id:'a1',item_name:'Pneu 90/90-18',item_type:'pneu',tire_size:'90/90-18',tire_rim_diameter:18,brand:'Levorin',sale_price:280,quantity_on_hand:5,is_tracked:true,stock_status:'in_stock',supplier_name:'Traseiro'},
  {stock_id:'b2',item_name:'Câmara de ar aro 18',item_type:'insumo',tire_size:null,brand:'Maggion',sale_price:35,quantity_on_hand:12,is_tracked:true,stock_status:'in_stock'},
  {stock_id:'c3',item_name:'Troca de pneu',item_type:'servico',tire_size:null,brand:null,sale_price:20,quantity_on_hand:null,is_tracked:false,stock_status:'not_tracked'},
];
d.posCart = [{partner_stock_id:'a1',item_name:'Pneu 90/90-18',quantity:1,unit_price:280,available:5}];
if (window.lucide) lucide.createIcons(); // re-renderiza ícones após mudanças
```

Gotchas:
- **Ícones lucide**: `<i data-lucide="...">` só vira SVG quando `lucide.createIcons()` roda. Após mudar DOM dinamicamente, chamar de novo.
- Sempre recarregar com cache-bust (`index.html?cb=`+Date.now()) ao testar CSS.

---

## 6. Contexto de banco/feature relacionado (não bloqueia o mobile)

- A feature **`item_type`** (pneu/insumo/serviço) está commitada, e a **migration `0067_partner_item_type.sql` foi APLICADA em prod em 2026-05-29 (via MCP)** no projeto Supabase Farejador (`aoqtgwzeyznycuakrdhp`). Antes de aplicar, a coluna ausente derrubava `getPartnerEstoque`/`getPartnerProdutos`; como o `loadData()` carrega tudo num `Promise.all`, **todas** as telas ficavam vazias e os saves "não funcionavam" — não só insumo/serviço. Aplicar destravou as 5 telas. Detalhes na seção "2026-05-29" do `parceiro/README.md`.
- Remote git ativo do parceiro é **`pneus`** (`github.com/financaswall-beep/farejador-pneus`), não o `origin`. Push: `git push pneus main`.

---

## 7. Arquivos tocados neste trabalho mobile

| Arquivo | O quê |
|---|---|
| `parceiro/public/style.css` | Bloco `@media (max-width:768px)` no fim + regra base `.pos-fab-finalize { display:none }`. |
| `parceiro/public/index.html` | Botão `.pos-fab-finalize` na seção `vendas`. |

Nada no backend. Para reverter tudo: `git restore parceiro/public/style.css parceiro/public/index.html` (cuidado: isso também reverte o que estiver junto não-commitado — confira `git diff` antes).

---

## 8. Convenções de estilo do projeto (pra manter coerência)

- Amarelo brand `#ffd000` (var `--pos-yellow`) = ação/destaque. Verde emerald = positivo. Vermelho rose = destrutivo/erro.
- Fundo escuro `#0b0f12`; painéis `.pos-panel` com borda `--pos-line`.
- Nada de framework novo, nada de build. Mantém Alpine + CSS custom.
- Comentar o **porquê** das decisões não-óbvias (padrão do repo).
