/**
 * Teste isolado da Organizadora: pega a transcrição da conv 592 do banco,
 * roda o MESMO prompt de producao com o modelo especificado, e salva um
 * relatorio comparavel.
 *
 * Uso:
 *   # rodar com modelo do .env (OPENAI_MODEL)
 *   npx tsx --env-file=.env scripts/teste-organizadora-modelo.ts
 *
 *   # forcar modelo especifico (override do .env)
 *   MODEL=gpt-5.4 npx tsx --env-file=.env scripts/teste-organizadora-modelo.ts
 *
 *   # outra conv
 *   CONV_UUID=<uuid> npx tsx --env-file=.env scripts/teste-organizadora-modelo.ts
 *
 * Salva o relatorio em: ./reports/organizadora-<modelo>-<timestamp>.txt
 */

import { Client } from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildOrganizadoraPrompt, EXTRACTOR_VERSION, SCHEMA_VERSION } from '../src/organizadora/prompt.js';
import { callOpenAI } from '../src/shared/llm-clients/openai.js';

const DATABASE_URL = process.env.DATABASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CONV_UUID = process.env.CONV_UUID || 'c6d3b44c-b291-4051-a79d-21a423b80a45'; // conv 592 default
const TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS) || 60000;

if (!DATABASE_URL) { console.error('DATABASE_URL ausente'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY ausente'); process.exit(1); }

const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();

  // 1. Buscar transcrição da conversa
  const msgs = await client.query(
    `SELECT id::text, sender_type, message_type_name AS message_type, content, sent_at
     FROM core.messages
     WHERE conversation_id = $1
       AND is_private = false
       AND content IS NOT NULL
       AND content != ''
     ORDER BY sent_at ASC;`,
    [CONV_UUID],
  );

  if (msgs.rows.length === 0) {
    console.error(`Sem mensagens na conv ${CONV_UUID}`);
    process.exit(1);
  }

  // 2. Buscar contexto do contato
  const contact = await client.query(
    `SELECT ct.name, ct.city
     FROM core.contacts ct
     JOIN core.conversations c ON c.contact_id = ct.id
     WHERE c.id = $1;`,
    [CONV_UUID],
  );
  const contactName = contact.rows[0]?.name ?? null;
  const contactCity = contact.rows[0]?.city ?? null;

  // 3. Montar prompt (mesma funcao que producao usa)
  const promptMessages = buildOrganizadoraPrompt(
    msgs.rows.map((m: any) => ({
      id: m.id,
      sender_type: m.sender_type,
      message_type: m.message_type,
      content: m.content,
      sent_at: m.sent_at,
    })),
    { contactName, contactCity },
  );

  console.log(`=== TESTE ORGANIZADORA ===`);
  console.log(`conv UUID:        ${CONV_UUID}`);
  console.log(`modelo:           ${MODEL}`);
  console.log(`mensagens:        ${msgs.rows.length}`);
  console.log(`schema_version:   ${SCHEMA_VERSION}`);
  console.log(`extractor_version: ${EXTRACTOR_VERSION}`);
  console.log(`prompt total chars (system+user): ${promptMessages.reduce((s: number, m: any) => s + m.content.length, 0)}`);
  console.log();

  // 4. Chamar OpenAI
  const start = Date.now();
  let llmResult;
  try {
    llmResult = await callOpenAI({
      apiKey: OPENAI_API_KEY!,
      model: MODEL,
      messages: promptMessages,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err: any) {
    console.error(`ERRO ao chamar OpenAI: ${err.message}`);
    process.exit(1);
  }

  const elapsed = Date.now() - start;

  // 5. Tentar parsear JSON
  let parsed: any = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(llmResult.content);
  } catch (e: any) {
    parseError = e.message;
  }

  // 6. Montar relatorio
  const reportLines: string[] = [];
  reportLines.push(`=== RELATORIO ORGANIZADORA — ${new Date().toISOString()} ===`);
  reportLines.push(``);
  reportLines.push(`Modelo:           ${MODEL}`);
  reportLines.push(`Conv UUID:        ${CONV_UUID}`);
  reportLines.push(`Mensagens input:  ${msgs.rows.length}`);
  reportLines.push(`Duracao:          ${elapsed}ms (LLM: ${llmResult.durationMs}ms)`);
  reportLines.push(`Tokens:           in=${llmResult.inputTokens} | out=${llmResult.outputTokens}`);
  reportLines.push(`Parse JSON:       ${parseError ? 'FALHOU: ' + parseError : 'ok'}`);
  reportLines.push(``);
  reportLines.push('--- TRANSCRIÇÃO ENVIADA ---');
  for (const m of msgs.rows) {
    const role = m.sender_type === 'contact' ? 'CLIENTE   ' : 'ATENDENTE ';
    reportLines.push(`  ${role}: ${m.content?.slice(0, 120)}`);
  }
  reportLines.push(``);

  if (parsed?.facts && Array.isArray(parsed.facts)) {
    reportLines.push(`--- FACTS EXTRAIDOS (${parsed.facts.length}) ---`);
    for (const f of parsed.facts) {
      reportLines.push(
        `  ${f.fact_key} = ${JSON.stringify(f.fact_value)} | ${f.truth_type} | conf=${f.confidence_level} | evidence="${(f.evidence_text ?? '').slice(0, 80)}"`,
      );
    }
    reportLines.push(``);

    // Destaque: tem preco_cotado e taxa_frete_cotada?
    const hasPreco = parsed.facts.some((f: any) => f.fact_key === 'preco_cotado');
    const hasFrete = parsed.facts.some((f: any) => f.fact_key === 'taxa_frete_cotada');
    reportLines.push(`--- DESTAQUE DA RODADA ---`);
    reportLines.push(`  preco_cotado:       ${hasPreco ? 'SIM' : 'NAO'}`);
    reportLines.push(`  taxa_frete_cotada:  ${hasFrete ? 'SIM' : 'NAO'} <-- foco do A/B`);
    reportLines.push(``);
  } else {
    reportLines.push(`--- OUTPUT BRUTO (parse falhou ou sem facts) ---`);
    reportLines.push(llmResult.content);
    reportLines.push(``);
  }

  if (parsed?.reasoning) {
    reportLines.push(`--- REASONING DO LLM ---`);
    reportLines.push(`  ${parsed.reasoning}`);
    reportLines.push(``);
  }

  const report = reportLines.join('\n');
  console.log(report);

  // 7. Salvar
  const reportsDir = join(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const safeModel = MODEL.replace(/[^a-z0-9.-]/gi, '_');
  const filename = join(reportsDir, `organizadora-${safeModel}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  writeFileSync(filename, report, 'utf8');
  console.log(`\nRelatorio salvo em: ${filename}`);

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
