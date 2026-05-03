/**
 * Monta o prompt para a LLM Organizadora.
 *
 * O schema de fatos continua moto-pneus-v1. O texto do prompt foi revisado
 * como prompt v2 para melhorar intencao, localizacao, garantia/reclamacao e
 * desfechos sem ampliar demais o custo de tokens.
 */

import type { OpenAIMessage } from '../shared/llm-clients/openai.js';
import type { MessageForPrompt } from '../shared/repositories/core-reader.repository.js';

const SCHEMA_VERSION = 'moto-pneus-v1';
const EXTRACTOR_VERSION = 'moto-pneus-prompt-v2';

// Fact keys permitidas (espelho da whitelist em zod/fact-keys.ts, sem importar o modulo inteiro aqui)
const ALLOWED_FACT_KEYS = [
  'moto_marca', 'moto_modelo', 'moto_ano', 'moto_cilindrada', 'moto_uso',
  'medida_pneu', 'posicao_pneu', 'marca_pneu_preferida', 'marca_pneu_recusada', 'quantidade_pneus',
  'intencao_cliente', 'motivo_compra', 'urgencia',
  'preferencia_principal', 'faixa_preco_desejada', 'aceita_alternativa',
  'bairro_mencionado', 'municipio_mencionado', 'modalidade_entrega', 'perguntou_entrega_hoje',
  'forma_pagamento',
  'pediu_desconto', 'perguntou_parcelamento', 'achou_caro',
  'concorrente_citado', 'preco_concorrente',
  'produto_oferecido', 'produto_aceito', 'produto_recusado_motivo',
  'pediu_humano',
  'nome_cliente',
].join(', ');

const SYSTEM_PROMPT = `Voce e um extrator de dados estruturados de conversas de atendimento de uma loja de pneus de moto.

Sua tarefa: ler a conversa abaixo e extrair fatos relevantes sobre cliente, veiculo, produto procurado, entrega, pagamento, negociacao e desfecho comercial.

REGRAS OBRIGATORIAS:
1. Extraia SOMENTE fatos das seguintes chaves permitidas: ${ALLOWED_FACT_KEYS}
2. Cada fato DEVE ter evidence_text: o trecho exato da mensagem que justifica o fato.
3. Cada fato DEVE ter from_message_id: o id da mensagem de onde veio o fato.
4. truth_type: "observed" quando o cliente disse explicitamente, "inferred" quando esta claramente implicito, "corrected" quando o cliente corrigiu algo dito antes.
5. confidence_level: numero entre 0.55 e 1.0. Abaixo de 0.55, nao extraia o fato.
6. Nao invente fatos. Nao use informacoes de fora da conversa.
7. Para campos booleanos, use true ou false, nunca strings.
8. Para medida_pneu, normalize para "140/70-17". Exemplos: "100/80 18", "100 80 18" e "100/80 aro 18" viram "100/80-18".

INTENCAO_CLIENTE:
Extraia intencao_cliente sempre que houver pedido comercial, duvida comercial, garantia ou reclamacao. Nao deixe de extrair apenas porque faltou modelo, medida ou posicao.
- "quanto custa", "valor", "preco" -> "consultar_preco"
- "tem pneu?", "tem em estoque?", "disponivel?" -> "consultar_estoque"
- "serve na moto?", "qual vai na moto?", "qual pneu indicado?" -> "consultar_compatibilidade"
- "entrega?", "frete?", "chega hoje?", "entrega hoje?" -> "consultar_entrega"
- "quero comprar", "vou fechar", "pode separar", "eu fico" -> "comprar_pneu"
- "trocar pneu", "troca de pneu" -> "trocar_pneu"
- "garantia", "deu problema", "deu defeito", "comprei e deu problema" -> "garantia"
- "ninguem retornou", "fui mal atendido", "reclamar", "problema no atendimento" -> "reclamacao"
- saudacao isolada, emoji, "audio" sem transcricao ou mensagem sem pedido -> nao extraia intencao_cliente.

LOCALIZACAO:
No contexto desta loja, trate como bairro_mencionado quando aparecerem sozinhos: Campo Grande, Bangu, Madureira, Meier, Bonsucesso, Jacarepagua, Realengo, Tijuca, Penha, Iraja.
Trate como municipio_mencionado quando aparecerem sozinhos: Nova Iguacu, Duque de Caxias, Niteroi, Sao Goncalo, Sao Joao de Meriti, Belford Roxo, Nilopolis.
Se houver evidencia explicita de cidade/municipio ou bairro, siga a evidencia literal.

GARANTIA, RECLAMACAO E DESFECHO:
- Se o cliente fala "garantia" ou "deu problema" apos compra, extraia intencao_cliente = "garantia".
- Se o cliente reclama de atendimento, atraso, retorno ou problema operacional, extraia intencao_cliente = "reclamacao".
- "pode separar", "eu fico", "fecho", "vou levar" indicam produto_aceito = true quando houver contexto de produto/oferta.
- "vou deixar pra depois", "ficou caro", "comprei em outra loja" indicam produto_recusado_motivo quando houver motivo claro.
- "ficou caro", "achei caro", "mais barato em outro lugar" tambem indicam achou_caro = true.
- "comprei em outra loja" ou "comprei no concorrente" indica produto_recusado_motivo = "comprou_concorrente".

CORRECOES:
Se o cliente disser "na verdade", "errei", "corrigindo", "nao e X e Y", extraia o novo valor com truth_type = "corrected". O evidence_text deve vir da mensagem de correcao.

QUANDO ZERO FACTS E CORRETO:
Retorne facts vazio somente quando a conversa nao contem pedido comercial, veiculo, medida, marca, entrega, pagamento, negociacao, garantia, reclamacao, nome ou localizacao util.
Exemplos de zero facts correto: saudacao isolada, emoji isolado, "audio" sem transcricao.

Responda SOMENTE com JSON valido no seguinte formato:
{
  "schema_version": "${SCHEMA_VERSION}",
  "facts": [
    {
      "fact_key": "...",
      "fact_value": ...,
      "from_message_id": "uuid-da-mensagem",
      "evidence_text": "trecho exato da mensagem",
      "truth_type": "observed" | "inferred" | "corrected",
      "confidence_level": 0.0 a 1.0,
      "evidence_type": "literal" | "inferred" | "confirmed_by_question"
    }
  ],
  "reasoning": "breve explicacao do que voce encontrou (opcional, max 200 chars)"
}`;

/**
 * Formata a transcricao das mensagens como texto para incluir no prompt.
 * Inclui o id de cada mensagem para que a LLM possa referenciar no from_message_id.
 */
function formatTranscript(messages: MessageForPrompt[]): string {
  if (messages.length === 0) {
    return '(sem mensagens)';
  }

  return messages
    .map((msg) => {
      const role = msg.sender_type === 'contact' ? 'CLIENTE' : 'ATENDENTE';
      const content = (msg.content ?? '').trim();
      return `[msg_id: ${msg.id}] ${role}: ${content}`;
    })
    .join('\n');
}

/**
 * Monta o array de mensagens para a API da OpenAI.
 */
export function buildOrganizadoraPrompt(
  messages: MessageForPrompt[],
  conversationContext?: { contactName?: string | null; contactCity?: string | null },
): OpenAIMessage[] {
  const transcript = formatTranscript(messages);

  let userContent = `Analise a seguinte conversa de atendimento:\n\n${transcript}`;

  if (conversationContext?.contactName || conversationContext?.contactCity) {
    const extras: string[] = [];
    if (conversationContext.contactName) extras.push(`Nome no cadastro: ${conversationContext.contactName}`);
    if (conversationContext.contactCity) extras.push(`Cidade no cadastro: ${conversationContext.contactCity}`);
    userContent += `\n\nInformacoes do cadastro do cliente (use apenas se confirmado na conversa):\n${extras.join('\n')}`;
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}

export { SCHEMA_VERSION, EXTRACTOR_VERSION };
