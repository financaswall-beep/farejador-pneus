# ANEXO — Artefatos prontos (Foto sob demanda)

> Companheiro de [PLANO_FOTO_SOB_DEMANDA_2026-06-10.md](PLANO_FOTO_SOB_DEMANDA_2026-06-10.md).
> O plano é o MAPA (decisões, furos, ordem). Este anexo é o **MATERIAL DE OBRA**: o código já
> revisado pelos especialistas, pronto pra colar tijolo a tijolo. Não regerar — usar isto.
> **Última revisão de schema: BYTEA em tabela SEPARADA** (`banco` contestou e melhorou o BYTEA inline).

---

## A. BANCO — Migration 0094 FINAL (BYTEA, tabela de blob separada)

> ✅ **APLICADA EM PROD 2026-06-10 (Tijolo 1 CONCLUÍDO).** A fonte da verdade agora é o arquivo
> versionado **[db/migrations/0094_photo_requests.sql](../db/migrations/0094_photo_requests.sql)** —
> o SQL abaixo neste anexo é o rascunho da 2ª rodada e ficou DESATUALIZADO em 3 pontos
> (furos achados e consertados NA IMPLEMENTAÇÃO):
> 1. **`SECURITY INVOKER` sem grants = permission denied.** A function precisava que o INVOKER
>    (parceiro) tivesse INSERT no blob + UPDATE na fila. Fix (padrão da casa, 0090): function
>    INVOKER + **GRANTS POR COLUNA** — SELECT sem `conversation_id`/`contact_id` (E2 vira física),
>    UPDATE só em `status/was_late/answered_at` (E6), INSERT só no blob (RLS WITH CHECK amarra).
> 2. **View `security_invoker` exige SELECT na tabela base** — resolvido pelos mesmos grants por coluna.
> 3. **`env_t` mora em `public`** e o `SET search_path` da function não inclui public → DECLARE
>    usa `public.env_t` qualificado (senão CREATE FUNCTION falha na validação do corpo).
> Validação extra no DO $check$: prova E4 (INSERT negado) + E2 (conversation_id ilegível).
> **Provas:** dry-run ok → commit ok → smoke 16/16 (RLS dois sentidos, duplo-clique no-op, SVG
> negado, was_late, guard re-roteamento; rodado com GRANT role transacional + ROLLBACK total)
> → typecheck + 345/345 vitest. Smoke: `scripts/smoke-0094.cjs` (untracked).

**Veredito do `banco` sobre o BYTEA (resumo):** BYTEA aprovado pro MVP, MAS **não inline** na `photo_requests` — os bytes vão em `commerce.photo_request_blobs` (1:1, PK=FK, ON DELETE CASCADE). Motivo: `photo_requests` é fila/máquina-de-estados lida o tempo todo (expirador, view, bot-pool); blob inline faz pg_dump/backup arrastar a foto, e um `SELECT *`/`RETURNING *` distraído puxa 300KB pela rede a cada tick. Tabela separada = a fila fisicamente não tem os bytes pra arrastar (erro impossível por construção). Migrar pro Storage no futuro = trocar write/read, `photo_request_blobs` vira `photo_storage_path`.

### `db/migrations/0094_photo_requests.sql`

```sql
-- ============================================================
-- 0094_photo_requests.sql
-- Foto sob demanda de pneu usado — fundação de dados (Tijolo 1).
-- Contexto: docs/PLANO_FOTO_SOB_DEMANDA_2026-06-10.md
--   Cliente pede foto no WhatsApp -> bot cria "pedido de foto" amarrado à conversa
--   -> card na aba Bate-papo -> borracheiro fotografa -> sistema manda a foto pro
--   cliente sozinho (Chatwoot) -> 10min sem resposta = fallback honesto. Ao fechar
--   o pedido, a foto gruda no item e aparece no card "Em separação".
-- DECISÃO ORQUESTRADOR: foto em Postgres BYTEA, NÃO Supabase Storage (MVP). E o
--   blob em TABELA SEPARADA (photo_request_blobs 1:1) pra a fila ficar leve.
-- ADITIVA. Não toca contrato 0076/0077. Flag PHOTO_REQUESTS (default OFF). Dormante.
-- Assinatura: banco (Claude Opus 4.8), 2026-06-10
-- ============================================================

-- 1. FILA / MÁQUINA DE ESTADOS (leve — SEM bytes)
CREATE TABLE IF NOT EXISTS commerce.photo_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         env_t NOT NULL,
  unit_id             UUID NOT NULL REFERENCES core.units(id),
  conversation_id     BIGINT NOT NULL,             -- chatwoot_conversation_id (endereço de volta; NUNCA na view)
  contact_id          BIGINT,                       -- chatwoot_contact_id (telemetria/erasure)
  tire_size           TEXT NOT NULL,
  brand               TEXT,
  note                TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','answered','sent',
                                          'expired','expired_after_answer','cancelled')),
  was_late            BOOLEAN NOT NULL DEFAULT false,
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  answered_at         TIMESTAMPTZ,
  sent_to_customer_at TIMESTAMPTZ,
  order_item_id       UUID REFERENCES commerce.partner_order_items(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. BLOB (tabela separada, 1:1) — os bytes vivem AQUI e só aqui
CREATE TABLE IF NOT EXISTS commerce.photo_request_blobs (
  photo_request_id UUID PRIMARY KEY REFERENCES commerce.photo_requests(id) ON DELETE CASCADE,
  environment      env_t NOT NULL,
  unit_id          UUID NOT NULL REFERENCES core.units(id),
  photo_bytes      BYTEA NOT NULL,
  photo_mime       TEXT  NOT NULL CHECK (photo_mime IN ('image/jpeg','image/png','image/webp')),
  photo_size_bytes INTEGER NOT NULL CHECK (photo_size_bytes > 0 AND photo_size_bytes <= 8388608),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN commerce.photo_request_blobs.photo_bytes IS
  'JPEG/PNG/WebP re-encodado/comprimido pelo backend (sharp, máx 1600px, EXIF strippado). Servido só pelo painel via RLS. Nunca projetado na fila/view.';

-- 3. ÍNDICES
CREATE INDEX IF NOT EXISTS photo_requests_queue_idx
  ON commerce.photo_requests(environment, unit_id, created_at DESC)
  WHERE status IN ('pending','answered');
CREATE INDEX IF NOT EXISTS photo_requests_expiring_idx
  ON commerce.photo_requests(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS photo_requests_conversation_idx
  ON commerce.photo_requests(environment, conversation_id);
CREATE INDEX IF NOT EXISTS photo_requests_order_item_idx
  ON commerce.photo_requests(order_item_id) WHERE order_item_id IS NOT NULL;

-- 4. TRIGGERS (updated_at + invariante de ambiente)
DROP TRIGGER IF EXISTS photo_requests_set_updated_at ON commerce.photo_requests;
CREATE TRIGGER photo_requests_set_updated_at
  BEFORE UPDATE ON commerce.photo_requests
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();
DROP TRIGGER IF EXISTS env_match_photo_requests_unit ON commerce.photo_requests;
CREATE TRIGGER env_match_photo_requests_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.photo_requests
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','units','unit_id');
DROP TRIGGER IF EXISTS env_match_photo_request_blobs_unit ON commerce.photo_request_blobs;
CREATE TRIGGER env_match_photo_request_blobs_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.photo_request_blobs
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core','units','unit_id');

-- 5. RLS — isolamento por unidade (cópia da 0070), NAS DUAS tabelas
ALTER TABLE commerce.photo_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS photo_requests_isolation ON commerce.photo_requests;
CREATE POLICY photo_requests_isolation ON commerce.photo_requests
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());
ALTER TABLE commerce.photo_request_blobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS photo_request_blobs_isolation ON commerce.photo_request_blobs;
CREATE POLICY photo_request_blobs_isolation ON commerce.photo_request_blobs
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- 6. VIEW DA FILA — whitelist (E2/E16): SEM conversation_id/contact_id/bytes
CREATE OR REPLACE VIEW commerce.partner_photo_queue
WITH (security_invoker = true) AS
  SELECT pr.id, pr.unit_id, pr.tire_size, pr.brand, pr.note, pr.status, pr.was_late,
         pr.expires_at, pr.answered_at, pr.created_at,
         EXISTS (SELECT 1 FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id) AS has_photo
  FROM commerce.photo_requests pr;
COMMENT ON VIEW commerce.partner_photo_queue IS
  'Fila visível ao parceiro (0094). security_invoker -> RLS por unidade. WHITELIST: sem conversation_id/contact_id (anti-bypass, E2) nem bytes. has_photo derivada.';

-- 7. FUNCTION — anexar a foto (idempotente, FOR UPDATE, recebe os BYTES)
CREATE OR REPLACE FUNCTION commerce.attach_partner_photo(
  p_photo_request_id UUID, p_photo_bytes BYTEA, p_photo_mime TEXT, p_photo_size_bytes INTEGER
) RETURNS TABLE (out_status TEXT, out_was_late BOOLEAN, out_attached BOOLEAN)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = commerce, network, pg_temp
AS $function$
DECLARE
  v_environment env_t; v_unit_id UUID; v_status TEXT; v_has_blob BOOLEAN;
  v_new_status TEXT; v_was_late BOOLEAN;
BEGIN
  SELECT pr.environment, pr.unit_id, pr.status,
         EXISTS (SELECT 1 FROM commerce.photo_request_blobs b WHERE b.photo_request_id = pr.id)
    INTO v_environment, v_unit_id, v_status, v_has_blob
  FROM commerce.photo_requests pr WHERE pr.id = p_photo_request_id FOR UPDATE;

  IF v_environment IS NULL THEN
    RAISE EXCEPTION 'Pedido de foto nao encontrado (ou de outra unidade): %', p_photo_request_id
      USING ERRCODE = '42501';
  END IF;
  IF p_photo_bytes IS NULL OR length(p_photo_bytes) = 0 THEN
    RAISE EXCEPTION 'Foto vazia para o pedido %', p_photo_request_id USING ERRCODE = '23514';
  END IF;
  IF p_photo_mime NOT IN ('image/jpeg','image/png','image/webp') THEN
    RAISE EXCEPTION 'MIME nao permitido (%) para o pedido %', p_photo_mime, p_photo_request_id
      USING ERRCODE = '23514';
  END IF;

  IF v_has_blob OR v_status IN ('sent','cancelled') THEN
    RETURN QUERY SELECT v_status, false, false; RETURN;
  END IF;
  IF v_status NOT IN ('pending','expired','answered','expired_after_answer') THEN
    RETURN QUERY SELECT v_status, false, false; RETURN;
  END IF;

  v_was_late := v_status IN ('expired','expired_after_answer');
  v_new_status := 'answered';

  INSERT INTO commerce.photo_request_blobs
    (photo_request_id, environment, unit_id, photo_bytes, photo_mime, photo_size_bytes)
  VALUES (p_photo_request_id, v_environment, v_unit_id, p_photo_bytes, p_photo_mime, p_photo_size_bytes);

  UPDATE commerce.photo_requests
  SET status = v_new_status, was_late = (was_late OR v_was_late), answered_at = now()
  WHERE id = p_photo_request_id;

  RETURN QUERY SELECT v_new_status, v_was_late, true;
END;
$function$;
REVOKE ALL ON FUNCTION commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER) FROM PUBLIC;
COMMENT ON FUNCTION commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER) IS
  'Anexa foto (0094). SECURITY INVOKER -> RLS por unidade. FOR UPDATE + idempotência (duplo-clique=no-op). expired -> was_late. Retorna (status, was_late, attached).';

-- 8. GRANTS — portal lê via VIEW + bytes via RLS; anexa só pela function; SEM INSERT/UPDATE direto
GRANT SELECT ON commerce.partner_photo_queue   TO farejador_partner_app;
GRANT SELECT ON commerce.photo_request_blobs   TO farejador_partner_app;  -- GET .../image
GRANT EXECUTE ON FUNCTION commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER) TO farejador_partner_app;
-- INSERT do pedido + dispatch + migração pro item = bot-pool (role postgres, BYPASSRLS). Sem grant aqui.

-- 9. COMENTÁRIOS
COMMENT ON TABLE commerce.photo_requests IS
  'Fila/máquina de estados dos pedidos de foto (0094). LEVE: sem bytes (photo_request_blobs 1:1). INSERT/dispatch só bot-pool; parceiro lê via partner_photo_queue e anexa via attach_partner_photo. order_item_id amarra ao item da venda (sem coluna nova em partner_order_items).';
COMMENT ON TABLE commerce.photo_request_blobs IS
  'Bytes da foto (BYTEA) 1:1 com photo_requests (PK=FK, ON DELETE CASCADE). SEPARADA pra fila/backup nunca arrastarem blob. RLS por unidade. Servida só pelo painel.';

-- 10. VALIDAÇÃO PÓS-MIGRATION (padrão 0044)
DO $check$
DECLARE v_rls_pr BOOLEAN; v_rls_blob BOOLEAN; v_pol INTEGER;
BEGIN
  SELECT relrowsecurity INTO v_rls_pr   FROM pg_class WHERE oid = 'commerce.photo_requests'::regclass;
  SELECT relrowsecurity INTO v_rls_blob FROM pg_class WHERE oid = 'commerce.photo_request_blobs'::regclass;
  SELECT count(*) INTO v_pol FROM pg_policies
    WHERE schemaname='commerce' AND tablename IN ('photo_requests','photo_request_blobs');
  IF NOT v_rls_pr OR NOT v_rls_blob THEN
    RAISE EXCEPTION '0094 falhou: RLS off (pr=%, blob=%)', v_rls_pr, v_rls_blob;
  END IF;
  IF v_pol < 2 THEN RAISE EXCEPTION '0094 falhou: esperava >=2 policies, achei %', v_pol; END IF;
  RAISE NOTICE '0094 OK: RLS nas 2 tabelas, % policies.', v_pol;
END;
$check$;
```

### Leitura — endpoint imagem (`GET /parceiro/:slug/api/photo-requests/:id/image`)
```sql
SELECT photo_bytes, photo_mime, photo_size_bytes
FROM commerce.photo_request_blobs
WHERE photo_request_id = $1;   -- RLS filtra por unidade; serve com Content-Type=photo_mime, cache curto/privado. Nunca SELECT *.
```

### Leitura — card de separação (lookup por `order_item_id`, sem coluna nova)
```sql
SELECT b.photo_request_id, b.photo_mime, b.photo_size_bytes
FROM commerce.photo_requests pr
JOIN commerce.photo_request_blobs b ON b.photo_request_id = pr.id
WHERE pr.order_item_id = $1
ORDER BY pr.answered_at DESC NULLS LAST LIMIT 1;
-- Na listagem de separação, o has_photo por item sai de um EXISTS contra photo_requests
-- (sem tocar o blob); o blob só é lido no clique do thumb (lightbox -> endpoint de imagem).
```

### Migração da foto pro item (bot-pool, pós-venda — NÃO vai na migration)
```sql
UPDATE commerce.photo_requests pr
SET order_item_id = $item_id
FROM commerce.partner_orders po
WHERE pr.id = $photo_request_id
  AND po.id = $order_id
  AND po.unit_id = pr.unit_id           -- re-roteou pra outra loja -> NÃO migra (guard)
  AND po.environment = pr.environment;   -- test/prod nunca cruzam
-- Travar no SQL do bot que $item_id é item daquele po (sub-SELECT) — o FK sozinho não garante.
```

### Rollback
```sql
DROP FUNCTION IF EXISTS commerce.attach_partner_photo(UUID, BYTEA, TEXT, INTEGER);
DROP VIEW     IF EXISTS commerce.partner_photo_queue;
DROP TABLE    IF EXISTS commerce.photo_request_blobs;   -- CASCADE cai junto
DROP TABLE    IF EXISTS commerce.photo_requests;
-- triggers/policies/índices/grants caem com as tabelas. ZERO impacto em dado existente.
```

**Reconferir antes de colar:** `0070_partner_chat.sql:106-154` (modelo RLS/trigger/grant), `0090_partner_pickup_retrieve_and_source_lock.sql:47-126` (function FOR UPDATE/idempotência/ERRCODE), `0044_partner_rls_policies.sql:367-393` (grants `farejador_partner_app`). `conversation_id`/`contact_id` são BIGINT (IDs Chatwoot, coerente com 0070; NÃO são FK de propósito — o pedido pode nascer antes da conversa espelhada).

---

## B. BOT — tool, envio de anexo, dispatcher, expirador, prompt

### Tool `pedir_foto` (src/atendente-v2/tools.ts)
```jsonc
{
  type: 'function',
  function: {
    name: 'pedir_foto',
    description: 'Pede pra loja tirar uma FOTO ao vivo do pneu USADO em estoque e mandar pro cliente. Use SÓ quando o cliente PEDIR pra ver foto/estado/conservação, e SÓ depois de já ter o pneu escolhido E a loja resolvida (já chamou buscar_produto/buscar_compatibilidade COM bairro/localização). NÃO ofereça foto proativamente. NÃO use pra pneu novo. Retorna status=foto_solicitada + prazo_min: avise "vou pedir pra loja, 1 minutinho 📸" e SIGA a conversa (a foto chega sozinha depois).',
    parameters: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'UUID do pneu (de buscar_produto). Se omitir, uso o último da conversa.' },
        bairro:     { type: 'string', description: 'Bairro/localização do cliente — acha a loja que TEM o pneu.' },
        municipio:  { type: 'string', description: 'Cidade (opcional).' },
      },
      required: [],
      additionalProperties: false,
    },
  },
}
```
**Resolução interna** (re-roda o roteamento — a loja NÃO é persistida pré-pedido): `product_id` → `args` ?? `getRecentProductIds` (conversation-products.ts:108); município+coord → `resolveMunicipioFromBairro`+`fillCityFromPin`+`resolveCustomerLocation` (copy de `localizacao_loja`, tools.ts:594-620); `unit_id` → `decideStoreForItemsGeo` → `geo.routing.unitId` (matriz/only_far ⇒ erro `sem_loja`); `tire_size`/nome → SELECT em `commerce.products`.
**Guards por CÓDIGO:** sem produto → `precisa_produto`; sem loja → `sem_loja`; **máx 2 ativos** (`pending`+`answered`) → `limite`; **dedup** mesmo product+unit pending → devolve existente. Retorno feliz: `{status:'foto_solicitada', prazo_min:10, nome_pneu}`. Após INSERT (bot-pool): `pg_notify('partner_chat', {unit_id, kind:'photo_request', photo_request_id})`. **Sem nudge novo** em agent.ts (pedido vem em texto).

### `sendAttachment` — método NOVO no ChatwootApiClient (src/admin/chatwoot-api.client.ts)
```ts
async sendAttachment(
  chatwootConversationId: number,
  file: { buffer: Buffer; filename: string; contentType: string },
  caption?: string,
): Promise<{ chatwootMessageId: number | null }> {
  const url = `${this.baseUrl}/accounts/${this.accountId}/conversations/${chatwootConversationId}/messages`;
  const form = new FormData();
  if (caption) form.append('content', caption);          // legenda = content (OBRIGATÓRIA)
  form.append('message_type', 'outgoing');
  form.append('private', 'false');
  form.append('attachments[]', new Blob([file.buffer], { type: file.contentType }), file.filename);
  // NÃO setar Content-Type manual: o fetch/undici monta o boundary do multipart sozinho.
  const res = await this.fetchFn(url, {
    method: 'POST',
    headers: { api_access_token: this.apiToken },        // só o token; SEM Content-Type
    body: form,
  });
  // ...mesmo loop de retry/sanitize do requestPost, MAS sem JSON.stringify/Content-Type.
}
```
⚠️ `requestPost` atual força `Content-Type: application/json` (linha 204-206) — NÃO reusar; caminho próprio. Campo é literal `attachments[]` (Rails array). Confirmar Node ≥18 no Coolify (`FormData`/`Blob` nativos; se 16, undici/form-data). **Smoke ao vivo no env test ANTES de ligar a flag** (formato não validado contra nosso Chatwoot).

### Dispatcher (determinístico, ZERO LLM)
```
POST .../photo-requests/:id/photo (painel)
  1. valida :id pertence ao unit_id do TOKEN
  2. re-encode (sharp) -> attach_partner_photo(id, bytes, mime, size)  [§A.7]
  3. dispatchPhotoToCustomer(id, buffer):
       a. lê photo_request -> conversation_id
       b. ChatwootApiClient.sendAttachment(convId, buffer, legenda)
       c. UPDATE status='sent', sent_to_customer_at=now()
```
**Legenda OBRIGATÓRIA** ("Ó ele aqui 📸 — [medida], confere o estado") — sem ela o eco entra com content vazio e `history.ts` DESCARTA (filtro `content <> ''`) → o LLM acha que não mandou e repromete. Legenda diz "esse é o tipo/estado do que temos", NUNCA "esse exato é seu" (estoque não serializado). **Sem insert otimista** (eco do webhook é a única fonte). **Loop impossível:** `dispatcher.ts:216` só enfileira se `sender_type==='contact'` (+ `reconcile-jobs.ts:48`) → foto outgoing nunca acorda o LLM.

### Expirador (setInterval 60s no boot do worker, atrás da flag)
```ts
setInterval(async () => {
  const expired = await client.query(
    `UPDATE agent_or_commerce.photo_requests
        SET status='expired', expires_at=expires_at
      WHERE status='pending' AND expires_at < now()
      RETURNING id, conversation_id`);
  for (const r of expired.rows) await dispatchFallbackToCustomer(r);
}, 60_000);
```
Atômico (UPDATE...RETURNING) → multi-réplica e restart do Coolify seguros (no boot o WHERE pega os vencidos da janela morta). **Foto atrasada:** a function já marca `was_late` (§A.7) → dispatcher manda "chegou! 📸".

### Prompt (src/atendente-v2/prompt.ts) — bloco REATIVO
> **FOTO DO PNEU USADO**: se o cliente pedir pra ver foto/estado/conservação, e você já tem o pneu escolhido e a loja resolvida, chame `pedir_foto`. NÃO ofereça foto sozinho — só quando ele pedir. Depois avise "vou pedir pra loja te mandar uma foto, 1 minutinho 📸" e SIGA a conversa (não fique esperando, a foto chega sozinha). Se voltar `sem_loja`/`precisa_produto`, peça primeiro o bairro/o pneu.

Cliente pede foto SEM localização → tool retorna `sem_loja` → bot usa a foto como gancho pra pedir o bairro ("Mando sim! 📸 Me passa teu bairro que acho a loja que tem ele e já peço a foto").

---

## C. SEGURANÇA — exigências E1–E20 (verbatim, BLOQUEANTE vs Recomendada)

**Isolamento (RLS)**
- **E1 BLOQ** — `photo_requests` nasce com RLS + policy estilo 0070; parceiro SEM INSERT (só SELECT-via-view + UPDATE-via-function). *(atendido no §A: policy + grants)*
- **E2 BLOQ** — `conversation_id`/`contact_id` fora do grant de leitura e fora do SELECT do painel; usar VIEW sem essas colunas. *(atendido: `partner_photo_queue`)*
- **E3 Rec** — triggers `set_updated_at` + `validate_env_match`. *(atendido)*

**Forja de destino / SEC-001**
- **E4 BLOQ** — só o bot cria `photo_request` (INSERT exclusivo do pool postgres); portal sem INSERT. O `conversation_id` é o que o worker está servindo, nunca valor do parceiro.
- **E5 BLOQ** — dispatcher resolve o destino pelo `id` do registro + revalida `unit_id`; upload referencia SÓ `photo_request_id` (nunca aceita conversation_id no corpo).
- **E6 Rec** — UPDATE do portal restrito a colunas de resposta (via function, não UPDATE solto). *(atendido: `attach_partner_photo`)*

**Upload**
- **E7 BLOQ** — validar tipo por MAGIC BYTES (não extensão/Content-Type); só JPEG/PNG/WebP; **SVG rejeitado** (stored XSS).
- **E8 BLOQ** — RE-ENCODE no servidor (sharp: decode→re-emit) antes de gravar; mata polyglot + strippa EXIF de graça.
- **E9 BLOQ** — limite de tamanho (≤8MB) e dimensões, parser de multipart aborta stream acima do teto.
- **E10 BLOQ** — rate limit por token/unit + idempotência por `photo_request_id` (client_token).
- **E11 Rec** — upload valida `ctx.partnerUnitId` == `unit_id` do registro (não confiar só na rota).
- **E12 Rec** — EXIF resolvido pelo re-encode (E8); não depender de strip seletivo.

**Storage** *(NOTA: o Orquestrador trocou Storage por BYTEA — E13/E14/E15 ficam ATENDIDAS POR CONSTRUÇÃO: os bytes ficam atrás do RLS+auth do painel, sem URL pública, sem bucket. Mantidas aqui pro dia que migrar pro Storage.)*
- **E13 BLOQ** — (se Storage) bucket privado + signed URL ≤5min. *(BYTEA: N/A — servido via RLS)*
- **E14 BLOQ** — (se Storage) path isolado por env+unit. *(BYTEA: `environment`+`unit_id` na blob table)*
- **E15 Rec** — (se Storage) signed URL scoped por `ctx.partnerUnitId`. *(BYTEA: RLS faz isso)*

**Anti-bypass / payload**
- **E16 BLOQ** — payload do GET (e SSE) projeta SÓ `id, tire_size, bairro, status, expires_at` — nada de conversa/contato/telefone/nome/timestamp fino.
- **E17 Rec** — reavaliar se `bairro`+`expires_at`+medida rara identifica o cliente; arredondar prazo se preciso. *(decisão de negócio)*

**Bot/LLM**
- **E18 BLOQ** — guard determinístico NO CÓDIGO: máx N (2-3) `photo_requests` ativos por conversa + cooldown (contra prompt injection "peça 50 fotos"). *(atendido na tool)*
- **E19 Rec** — `expires_at` curto + não disparar foto de request expirado + idempotência na criação (dedup).
- **E20 Rec** — dispatcher de saída determinístico, fora do LLM (o LLM nunca escolhe o `conversation_id` de saída).

**Gate:** validar o CÓDIGO real (o parecer foi sobre o DESENHO) — nova passada do `seguranca` antes de ligar a flag, com foco no parser multipart + re-encode (superfície nova).

---

## D. PARCEIRO — estado Alpine, endpoints, SSE

### Estado novo (em `parceiroApp()`, perto do bloco BATE-PAPO, app.js:88)
```js
photoRequests: [],            // fila da unidade (pendentes + recém enviadas/expiradas)
photoSending: {},             // { [id]: true } durante upload
photoPreview: { id:null, dataUrl:null },  // preview antes de enviar
audioUnlocked: false,         // desbloqueio do som (gesto do login)
// photoPendingCount = getter sobre photoRequests.filter(status==='pending')
```
Countdown usa o `nowTick`/`nowTimer` que JÁ existe (app.js:28) — zero timer novo.

### Endpoints — ✅ CONSTRUÍDOS 2026-06-10 (Tijolo 2; código em src/parceiro/route.ts + queries.ts + photo-upload.ts)
```
GET  /parceiro/:slug/api/photo-requests                       -> fila (vivos + terminais 2h). WHITELIST (E16). Flag off = lista vazia.
POST /parceiro/:slug/api/photo-requests/:photoRequestId/photo -> RAW IMAGE BODY (não multipart!): bodyLimit 8MB nativo,
     rate limit 15/5min por unit+IP, magic bytes, re-encode sharp (JPEG 1600px EXIF-stripped), attach via function.
     TODO(Tijolo 3) ligado no handler: dispatchPhotoToCustomer quando attached.
GET  /parceiro/:slug/api/photo-requests/:photoRequestId/image -> bytes via RLS, Cache-Control private.
GET  /parceiro/:slug/api/order-items/:id/photo                (Tijolo 5) -> thumb/lightbox na separação.
```
**DESVIO do desenho original (decisão do Orquestrador na implementação):** upload por **raw image body** (front manda o blob via fetch com Content-Type image/jpeg) em vez de `@fastify/multipart` → 1 dependência a menos (parser de boundary = superfície de CVE), `bodyLimit` nativo cobre E9, e a **idempotência é do banco** (attach FOR UPDATE; retry/duplo-clique = no-op; sem client_token). Deps novas: só `sharp`. Parser `image/*`→Buffer registrado em registerParceiroRoute (hasContentTypeParser guard). Funcionário responde foto via tela `batepapo` (MVP). Provas: 10 testes novos em tests/unit/parceiro/photo-upload.test.ts (355/355 total).

### SSE global + alerta (4 camadas) — reusa `pg_notify('partner_chat')` com `kind:'photo_request'`
- EventSource conecta no boot (após `/api/me`) e fica vivo SEMPRE (hoje só conecta na aba Bate-papo, app.js:2393) — senão o alerta não é global. `loadChat()` pesado continua só na aba. Poll de segurança da fila: 20-30s.
- **Badge** menu Bate-papo + sino do topbar (trocar o número fake hardcoded, index.html:229-232).
- **Banner** fixo abaixo do topbar, `x-show="photoPendingCount>0 && currentSection!=='batepapo'"` → `goToSection('batepapo')`.
- **Title flash** no `nowTick`: alterna `(N) 📷 FOTO` ↔ título normal.
- **Som**: beep 2 tons via `AudioContext` (sintetizado, sem asset), desbloqueado no `@click` do login + `pointerdown once` no document. Toggle em localStorage. ⚠️ iPhone tela travada não toca (limitação SO) → alertas visuais primários.
- Câmera: `<input type="file" accept="image/*" capture="environment">` dentro de `<label>`; compressão canvas→JPEG q0.8 máx 1600px ANTES do POST; `createImageBitmap(file,{imageOrientation:'from-image'})` (EXIF orientation).

---

## E. Estado dos agentes (pra retomar com contexto, se ainda vivos nesta sessão)
- `banco`: ab102959fa4e19795 (DDL BYTEA final) · acaafe4c3f14d4435 (1ª rodada Storage)
- `bot`: ac96e899ec7da62c3 · `parceiro`: ae39ff0a2c864fb05 · `seguranca`: a613d478966f79a81
