#!/usr/bin/env node
'use strict';

/**
 * chatwoot-client-sim.cjs
 * Simula um cliente enviando mensagens no Chatwoot via API REST.
 * Chamado por simular-cliente-chatwoot.bat
 *
 * Modos:
 *   --name="Nome"          nome do contato (nova conversa)
 *   --phone="+55..."       telefone do contato (nova conversa)
 *   --conversation=123     entrar em conversa existente
 *   --contact-source=xyz   source_id do contato (modo publico sem token)
 *
 * Env esperada (via --env-file=.env ou shell):
 *   CHATWOOT_PUBLIC_BASE_URL, CHATWOOT_ACCOUNT_ID, CHATWOOT_INBOX_ID,
 *   CHATWOOT_INBOX_IDENTIFIER, CHATWOOT_API_TOKEN (opcional)
 */

const readline = require('node:readline');
const https = require('node:https');
const http = require('node:http');
const { randomBytes } = require('node:crypto');

// ── Config ──────────────────────────────────────────────────────

const BASE_URL = (process.env.CHATWOOT_PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const INBOX_ID = parseInt(process.env.CHATWOOT_INBOX_ID || '1', 10);
const API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const INBOX_IDENTIFIER = process.env.CHATWOOT_INBOX_IDENTIFIER || '';
const API_V1 = `${BASE_URL}/api/v1`;

// ── Arg parsing ─────────────────────────────────────────────────

const args = {};
for (const arg of process.argv.slice(2)) {
  const clean = arg.replace(/^--/, '');
  const eq = clean.indexOf('=');
  if (eq === -1) {
    args[clean] = true;
  } else {
    args[clean.slice(0, eq)] = clean.slice(eq + 1);
  }
}

// ── HTTP helper ─────────────────────────────────────────────────

function request(method, url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : undefined;
    const headers = {
      'Content-Type': 'application/json',
      ...(API_TOKEN ? { 'api_access_token': API_TOKEN } : {}),
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...extraHeaders,
    };

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      rejectUnauthorized: false, // Supabase pooler / self-signed
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json).slice(0, 300)}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`HTTP ${res.statusCode} (resposta nao-JSON): ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── API helpers ─────────────────────────────────────────────────

function extrairId(resp) {
  if (!resp) return undefined;
  // Chatwoot v3+ wraps em payload
  if (resp.payload?.contact?.id) return resp.payload.contact.id;
  if (resp.payload?.id)          return resp.payload.id;
  // Versoes anteriores retornam direto
  if (resp.contact?.id)          return resp.contact.id;
  if (typeof resp.id === 'number') return resp.id;
  if (resp.data?.id)             return resp.data.id;
  return undefined;
}

async function criarContato(nome, telefone) {
  const resp = await request('POST', `${API_V1}/accounts/${ACCOUNT_ID}/contacts`, {
    name: nome,
    phone_number: telefone,
  });
  const id = extrairId(resp);
  if (!id) {
    console.error('\n  [DEBUG] Resposta completa do contato:', JSON.stringify(resp, null, 2));
    throw new Error('Nao foi possivel extrair o ID do contato da resposta da API');
  }
  return { id, raw: resp };
}

async function criarConversa(contactId) {
  const resp = await request('POST', `${API_V1}/accounts/${ACCOUNT_ID}/conversations`, {
    inbox_id: INBOX_ID,
    contact_id: contactId,
  });
  // Conversa retorna id diretamente (nao em payload.contact)
  const id = resp?.id ?? resp?.payload?.id ?? resp?.data?.id;
  if (!id) {
    console.error('\n  [DEBUG] Resposta completa da conversa:', JSON.stringify(resp, null, 2));
    throw new Error('Nao foi possivel extrair o ID da conversa da resposta da API');
  }
  return { id, raw: resp };
}

async function criarConversaPublica(nome, telefone, mensagemInicial) {
  // Widget API — nao precisa de token de usuario
  return request('POST', `${API_V1}/widget/conversations`, {
    contact: { name: nome, phone_number: telefone },
    message: { content: mensagemInicial },
  }, {
    'api_access_token': INBOX_IDENTIFIER,
    ...(API_TOKEN ? {} : {}),
  });
}

async function enviarMensagem(conversaId, texto) {
  return request(
    'POST',
    `${API_V1}/accounts/${ACCOUNT_ID}/conversations/${conversaId}/messages`,
    { content: texto, message_type: 'incoming', private: false },
  );
}

async function buscarMensagens(conversaId) {
  return request(
    'GET',
    `${API_V1}/accounts/${ACCOUNT_ID}/conversations/${conversaId}/messages`,
  );
}

async function buscarConversa(conversaId) {
  return request(
    'GET',
    `${API_V1}/accounts/${ACCOUNT_ID}/conversations/${conversaId}`,
  );
}

// ── Geradores ────────────────────────────────────────────────────

function gerarNome() {
  const nomes = ['Ana', 'Carlos', 'Maria', 'Pedro', 'Julia', 'Lucas', 'Fernanda', 'Rafael'];
  const sobrenomes = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Costa', 'Lima'];
  return nomes[Math.floor(Math.random() * nomes.length)] + ' ' + sobrenomes[Math.floor(Math.random() * sobrenomes.length)];
}

function gerarTelefone() {
  const num = 900000000 + Math.floor(Math.random() * 99999999);
  return `+5521${num}`;
}

// ── Exibe mensagens ───────────────────────────────────────────────

function exibirMensagens(payload) {
  const msgs = Array.isArray(payload) ? payload : (payload?.payload || []);
  if (!msgs.length) {
    console.log('  (nenhuma mensagem)');
    return;
  }
  const ultimas = msgs.slice(-15);
  for (const m of ultimas) {
    const tipo = m.message_type === 0 ? 'CLIENTE  ' : m.message_type === 1 ? 'ATENDENTE' : 'SISTEMA  ';
    const hora = m.created_at ? new Date(m.created_at * 1000).toLocaleTimeString('pt-BR') : '';
    console.log(`  [${tipo}] ${hora}  ${m.content || '(sem texto)'}`);
  }
}

// ── Loop interativo ───────────────────────────────────────────────

async function loopChat(conversaId) {
  const url = `${BASE_URL}/app/accounts/${ACCOUNT_ID}/conversations/${conversaId}`;

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  CONVERSA #${conversaId}  |  MODO CLIENTE`);
  console.log(`  Voce digita aqui como CLIENTE`);
  console.log(`  Responda no Chatwoot UI como ATENDENTE`);
  console.log('══════════════════════════════════════════════════════');
  console.log(`  URL: ${url}`);
  console.log('');
  console.log('  Comandos: /ver  /id  /sair');
  console.log('──────────────────────────────────────────────────────');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const perguntar = () => {
    rl.question('Cliente > ', async (linha) => {
      const texto = linha.trim();

      if (!texto) {
        return perguntar();
      }

      if (texto === '/sair') {
        console.log('  Saindo...');
        rl.close();
        return;
      }

      if (texto === '/id') {
        console.log(`  Conversa: #${conversaId}`);
        return perguntar();
      }

      if (texto === '/ver') {
        try {
          const resp = await buscarMensagens(conversaId);
          console.log('  ── Mensagens ────────────────────────────────');
          exibirMensagens(resp);
          console.log('  ─────────────────────────────────────────────');
        } catch (e) {
          console.log(`  [ERRO] ${e.message}`);
        }
        return perguntar();
      }

      try {
        const resp = await enviarMensagem(conversaId, texto);
        console.log(`  [OK] Mensagem #${resp.id} enviada`);
      } catch (e) {
        console.log(`  [ERRO] Falha ao enviar: ${e.message}`);
      }

      perguntar();
    });
  };

  rl.on('close', () => {
    // sai do processo — bat captura o retorno
    process.exit(0);
  });

  perguntar();
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  // Modo: conversa existente
  if (args.conversation) {
    const conversaId = parseInt(args.conversation, 10);
    if (isNaN(conversaId)) {
      console.error('[ERRO] --conversation deve ser um numero inteiro');
      process.exit(1);
    }
    try {
      const info = await buscarConversa(conversaId);
      console.log(`  Conversa #${conversaId} encontrada — status: ${info.status}`);
    } catch (e) {
      console.error(`[ERRO] Conversa #${conversaId} nao encontrada: ${e.message}`);
      process.exit(1);
    }
    await loopChat(conversaId);
    return;
  }

  // Modo: nova conversa
  const nome = args.name || gerarNome();
  const telefone = args.phone || gerarTelefone();

  console.log('');
  console.log(`  Contato: ${nome}  |  ${telefone}`);

  if (!API_TOKEN) {
    console.error('[ERRO] CHATWOOT_API_TOKEN nao encontrado no .env.');
    console.error('       Preencha CHATWOOT_API_TOKEN no .env e tente novamente.');
    process.exit(1);
  }

  let conversaId;

  try {
    process.stdout.write('  Criando contato...');
    const contato = await criarContato(nome, telefone);
    process.stdout.write(` ID ${contato.id}\n`);

    process.stdout.write('  Criando conversa...');
    const conversa = await criarConversa(contato.id);
    conversaId = conversa.id;
    process.stdout.write(` ID #${conversaId}\n`);
  } catch (e) {
    console.error(`\n[ERRO] ${e.message}`);
    process.exit(1);
  }

  await loopChat(conversaId);
}

main().catch((e) => {
  console.error(`[ERRO FATAL] ${e.message}`);
  process.exit(1);
});
