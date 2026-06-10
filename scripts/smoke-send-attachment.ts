/**
 * SMOKE AO VIVO do sendAttachment (Tijolo 3 — GATE antes de ligar PHOTO_REQUESTS).
 *
 * ⚠️ MANDA UMA IMAGEM REAL pra conversa do Chatwoot informada — ela chega no
 * WhatsApp do contato daquela conversa. SÓ rodar com um chatwoot_conversation_id
 * de TESTE indicado pelo dono (ex.: a conversa do próprio Wallace).
 *
 * Uso: npx tsx --env-file=.env scripts/smoke-send-attachment.ts <chatwoot_conversation_id>
 *
 * O que prova: o formato multipart attachments[] contra o NOSSO Chatwoot
 * (self-hosted no Coolify) — a única peça do Tijolo 3 não provável offline.
 */
import sharp from 'sharp';
import { sendAttachment } from '../src/atendente-v2/sender.js';

async function main(): Promise<void> {
  const convId = Number(process.argv[2]);
  if (!Number.isInteger(convId) || convId <= 0) {
    console.error('Uso: npx tsx --env-file=.env scripts/smoke-send-attachment.ts <chatwoot_conversation_id>');
    console.error('⚠️ A imagem CHEGA NO WHATSAPP do contato dessa conversa — use uma conversa de TESTE.');
    process.exit(1);
  }

  // Imagem de teste gerada na hora (quadrado cinza com texto implícito no filename).
  const img = await sharp({
    create: { width: 320, height: 240, channels: 3, background: { r: 40, g: 44, b: 52 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  console.log(`Enviando imagem de teste (${img.length} bytes) pra conversa ${convId}...`);
  await sendAttachment(
    convId,
    { buffer: img, filename: 'smoke-foto-teste.jpg', contentType: 'image/jpeg' },
    '🧪 Teste técnico do sistema de fotos — pode ignorar esta mensagem.',
  );
  console.log('OK: Chatwoot aceitou o multipart. Confira se a imagem + legenda chegaram na conversa.');
}

main().catch((err) => {
  console.error(`ERRO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
