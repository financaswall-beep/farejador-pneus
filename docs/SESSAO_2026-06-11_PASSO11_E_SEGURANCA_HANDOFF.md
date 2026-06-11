# Sessão 2026-06-11 — Passo 11 (encerramento da obra do painel) + auditoria de segurança

> Domínio: `parceiro` · Branch: `feat/refatoracao-painel-300` · Orquestrador (Claude Fable 5)
> Pré-leitura: `PLANO_REFATORACAO_PAINEL_300_2026-06-10.md` (§5 ondas, §6 tabela dos passos),
> handoffs 06-10…06-11d, `docs/SEGURANCA.md`.

---

## 0. TL;DR

1. **Correção de fato operacional (palavra do dono):** o deploy **NÃO é automático** — o
   Wallace aperta **Deploy no Coolify** após o push no main. Registros antigos diziam
   "Coolify sobe sozinho" = ERRADO/não-confiável. CLAUDE.md (§1 Deploy) e memória
   `feedback_deploy_automatico` corrigidos. **Conferência feita:** produção
   (`farejador.smarttecsolutions.com.br/parceiro/borracharia-rio-do-ouro/`) == `origin/main`
   `9d0f989` **byte a byte** (sha256 `index.html` `6ee3eef1…`, `app.js` `9ae355f4…`) → o fluxo
   dele sobe o código CERTO. Ritual novo: pós-Deploy, EU confiro o ar por curl + etiqueta `?v=`.
2. **Passo 11 FEITO DE CÓDIGO** (`98c7a5c`): obra do painel ≤300 **completa na branch**.
3. **2 auditorias de segurança (Opus, em paralelo):** a refatoração **não introduziu
   regressão**; achados são pré-existentes (hardening). Detalhe na §3.
4. **FALTA (do dono):** validar o painel no celular → autorizar o merge da Onda C →
   apertar Deploy. Depois: gatilho da **porta única de login**.

---

## 1. Passo 11 — o que foi feito (commit `98c7a5c`)

| Item | O que | Prova |
|---|---|---|
| **M4 etiqueta** | `?v=20260611-onda-b` → `?v=20260611-onda-c` nos 24 `<script>` do `index.html` (cache-bust da onda C; `style.css` tem etiqueta própria, não tocado) | AO VIVO na 4101: 24 scripts **200**, 0 etiqueta velha no HTML servido, painel **boota**, console só com o nag pré-existente do Tailwind CDN, **zero req falha** |
| **Regra do teto 300** | CLAUDE.md §3 ganha a convenção permanente: `parceiro/public/app*.js` ≤300 linhas; fiscal `npm run checar-tamanho` + `npm run prova-painel` ao tocar o painel | — |
| **Apaga teto temporário** | `git rm scripts/obra-painel-teto.json` (era rastreado) — some a muleta, vale o **teto universal de 300**; `app.js`=263 passa folgado | `checar-tamanho` verde sem o json |
| **Faxina** | 10 goldens `obra-teste-passo*.cjs` (one-off, "ficam até o passo 11" pelo próprio cabeçalho) **arquivados** em `_backup-goldens-painel-onda-c-2026-06-11.tgz` e removidos. Lançador `obra-preview-4101.cjs` mantido (preview de pé) | tgz confere 10 arquivos |

**Bateria COMPLETA verde (portão final, rodada uma última vez):**
`prova-painel` = **paridade 465** props idênticas ao baseline + **contratos 69** idênticos +
**24 arquivos ≤300**; **10 goldens = 508 asserções, 0 falha**; **vitest 379, 0 falha**;
**typecheck exit 0**.

> Nota de processo: o commit nasceu com um `@` solto no subject (usei sintaxe de here-string
> do PowerShell `@'…'@` na ferramenta Bash — no bash o `@` é literal). Corrigido com
> `--amend` antes de qualquer push. Lição: na ferramenta **Bash**, usar aspas normais / `$'…'`,
> nunca `@'…'@`.

---

## 2. O que FALTA (sequência de fechamento — parte do dono em negrito)

1. **Dono valida o painel no celular** (venda, estoque, chat, foto, login — o dia a dia real).
2. **Dono autoriza o merge** da Onda C no `main`.
3. Eu faço `git merge` da branch no main + push (= passo meu).
4. **Dono aperta Deploy no Coolify** (~2-10 min).
5. Eu confiro de fora que o ar subiu (etiqueta `?v=onda-c` no site real + hash vs main).
6. **Só então:** dispara o **GATILHO da porta única de login** (feature à parte, §5 do plano;
   desenho em `project_porta_unica_login` + handoff 06-12 §8). O passo 10 já deixou o login
   isolado em `app.auth.js` (123 linhas) — cama arrumada.

Rollback (se algo aparecer no ar): `git revert -m 1 <merge>` → dono redeploya.

---

## 3. Auditoria de segurança — 2 revisores Opus em paralelo (SÓ-LEITURA)

**Veredicto convergente: a refatoração do passo 10 foi "só movido" — NENHUMA regressão de
segurança.** Conferido: os 5 módulos novos (auth/core/resumo/pedidos/entregas) estão todos
registrados na montagem; o 401→login está intacto (`app.core.js:46-52`); o Bearer é sempre
mandado (`app.core.js:118-122`); `canSee`/`isOwner` são só pintura — a trava real é no
servidor e não foi tocada. **Cross-tenant fechado na raiz** (a função `validate_partner_session`
filtra por `slug` no banco → token de A na URL de B = 0 linhas = 401). **XSS limpo** (zero
`innerHTML`/`x-html`/`eval`; dado de cliente/chat cai em `x-text`, escapado). **Sem segredo
hardcoded** no front; `.env` não-staged.

**Achados PRÉ-EXISTENTES (não são da obra; nenhum bloqueia o merge):**

| # | Sev | O que | Onde | Ação sugerida |
|---|---|---|---|---|
| S1 | **ALTO (operacional — depende de você)** | `PARTNER_DATABASE_URL` ausente → o portal cai pro `DATABASE_URL` (role `postgres`, que **ignora RLS**); aí o isolamento passa a depender só do `WHERE unit_id`, e `getPartnerPhotoImage` (`queries.ts:3535`) confia só em RLS → vazaria foto entre parceiros. Hoje só emite `warn`, não falha (fail-OPEN). | `src/parceiro/db.ts:18-24` | **Confirmar no Coolify que `PARTNER_DATABASE_URL` está setado** (role `farejador_partner_app`). Endurecer: `throw` em vez de `warn` quando `FAREJADOR_ENV==='prod'` e a env faltar (fail-CLOSED). |
| S2 | MÉDIA | **Zero cabeçalhos de segurança HTTP** (sem `@fastify/helmet`/CSP/`X-Frame-Options`) + 4 CDNs sem SRI e com versão flutuante (`alpinejs@3.x.x`, `lucide@latest`, `cdn.tailwindcss.com`, `chart.js`). CDN comprometido → JS roda na sessão do parceiro e exfiltra o token. Vale mais quanto mais lojas entram. | bootstrap Fastify + `index.html:8,32,33,34` | Adicionar helmet com CSP liberando só os CDNs em uso (`frame-ancestors 'none'`); pinar versão + `integrity`/SRI. **Validar no preview antes do prod — CSP estrita quebra Alpine/Tailwind fácil.** |
| S3 | BAIXA | Token de sessão em `localStorage` (legível por JS; um XSS futuro lê direto). Trocar por cookie `HttpOnly` é mudança grande e **introduz CSRF** que hoje não existe (Bearer manual é imune). | `app.js:35` | Não trocar agora; o mitigador real é a CSP (S2). |
| S4 | BAIXA | Token na **query string** do SSE (`/chat/stream?token=…`) — pode cair em log de proxy. Já documentado e marcado "SEGURO"; endpoint revalida + `requireScreen('batepapo')`; token 30d revogável. | `app.chat.js:160`, `app.foto.js:50` | Opcional: token efêmero de 1 uso pro stream. Não urgente. |
| S5 | BAIXA | `linkPartnerChatCustomer` é a única query do portal no pool admin (bypassa RLS); protege com `WHERE unit_id` mas é defesa de camada única. | `queries.ts:2640-2660` | Opcional: migrar pra `withPartnerContext` (recupera defesa dupla). |
| S6 | (dívida conhecida) | **SEC-002** segue aberto — `network.partner_unit_permissions` (+ `partner_sessions`, `unit_coverage`) sem RLS; isolamento só por `WHERE`. Não vaza hoje (call sites auditados). | `docs/SEGURANCA.md` | Sessão dedicada; é caminho quente de autorização, não mexer às pressas. |

**Recomendação de prioridade:** **S1 é o único que eu trataria já** — e a parte 1 (confirmar a env
no Coolify) é tua, custa 1 minuto. S2 vale agendar pra antes da Rede crescer. S3-S6 são contexto.

**Fora de escopo (não revisado):** bot/atendente-v2, matriz/admin, webhooks de ingestão, RLS
no nível das migrations (a auditoria 06-06 cobre), Coolify/segredos/CORS de prod.

---

## 4. Estado dos arquivos / ambiente

- Branch `feat/refatoracao-painel-300`: HEAD `98c7a5c` (passo 11). Onda A+B já no main.
- Previews de pé (NÃO derrubar): **4100** `parceiro-preview`, **4101** `parceiro-obra-4101`.
- `_backup-goldens-painel-onda-c-2026-06-11.tgz` na raiz (10 goldens, recuperável).
- CLAUDE.md §1 (Deploy) e §3 (teto 300) atualizados; memória `feedback_deploy_automatico` reescrita.
