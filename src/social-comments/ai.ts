import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { requestOpenAIResponse } from '../atendente-v2/openai-responses-http.js';
import { COMMENT_PROMPT } from './prompt.js';
import { COMMENT_TOOLS, isCommentTool, parseCommentToolArgs, type CommentLookup } from './commerce.js';
import { publicReply } from './public-reply.js';
import type { Platform } from './config.js';

export const decisionSchema = z.object({
  action:z.enum(['reply','delete','ignore']), sentiment:z.enum(['positive','neutral','negative']),
  reply_text:z.string().max(1000), reason:z.string().min(1).max(400),
  confidence_level:z.enum(['low','medium','high']),
}).strict().refine(d=>d.action === 'delete' ? d.sentiment === 'negative' && d.reply_text === '' && d.confidence_level === 'high'
  : d.action === 'reply' ? d.sentiment !== 'negative' && d.reply_text.trim().length > 0 : d.reply_text === '');
export type Decision = z.infer<typeof decisionSchema>;
export interface AiDecision { decision: Decision; model: string; inputTokens: number; outputTokens: number }

export function minimizePublicText(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[e-mail]')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,'[documento]')
    .replace(/(?:\+55\s*)?\(?\b\d{2}\)?[\s-]*\d{4,5}[\s-]*\d{4}\b/g,'[telefone]')
    .replace(/@[a-z0-9_.]+/gi,'[perfil]');
}

const envelopeSchema = z.object({
  status: z.literal('completed'), model: z.string().optional(),
  // Preservar itens originais (inclusive reasoning criptografado) entre rodadas de ferramentas.
  output: z.array(z.object({ type: z.string(), content: z.array(z.object({
    type: z.string(), text: z.string().optional(),
  }).passthrough()).optional() }).passthrough()),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).optional(),
});
const callSchema = z.object({ type: z.literal('function_call'), name: z.string(),
  call_id: z.string().min(1), arguments: z.string().max(4000) });
const MAX_TOOL_ROUNDS = 3, MAX_TOOL_CALLS = 6;

/** Sem IDs de clientes ou histórico privado. Somente ferramentas comerciais públicas de leitura. */
export async function decideComment(comment: string, post: string,
  request = requestOpenAIResponse,
  options: { platform?: Platform; lookup?: CommentLookup } = {}): Promise<AiDecision> {
  const platform = options.platform ?? 'facebook';
  const input: unknown[] = [{role:'system',content:COMMENT_PROMPT},
    {role:'user',content:JSON.stringify({platform, consultas_disponiveis:Boolean(options.lookup),
      publication:minimizePublicText(post.slice(0,6000)),comment:minimizePublicText(comment.slice(0,8000))})}];
  let inputTokens = 0, outputTokens = 0, calls = 0;
  const seenIds = new Set<string>();
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const toolsAllowed = Boolean(options.lookup) && round < MAX_TOOL_ROUNDS && calls < MAX_TOOL_CALLS;
    const raw = await request(JSON.stringify({model:env.OPENAI_MODEL,store:false,max_output_tokens:2048,
    input, include: ['reasoning.encrypted_content'],
    ...(options.lookup ? {tools:COMMENT_TOOLS,tool_choice:toolsAllowed ? 'auto' : 'none'} : {}),
    text:{format:{type:'json_schema',name:'comment_decision',strict:true,schema:{
      type:'object',additionalProperties:false,
      required:['action','sentiment','reply_text','reason','confidence_level'],
      properties:{action:{type:'string',enum:['reply','delete','ignore']},sentiment:{type:'string',enum:['positive','neutral','negative']},
        reply_text:{type:'string'},reason:{type:'string'},confidence_level:{type:'string',enum:['low','medium','high']}}}}},
    }));
    const envelope = envelopeSchema.parse(raw);
    inputTokens += envelope.usage?.input_tokens ?? 0;
    outputTokens += envelope.usage?.output_tokens ?? 0;
    const messages = envelope.output.filter(x=>x.type === 'message').flatMap(x=>x.content ?? []);
    if (messages.some(x=>x.type === 'refusal')) throw new Error('comment_ai_refusal');
    if (envelope.output.some(x=>!['message','reasoning','function_call'].includes(x.type))) throw new Error('comment_tool_not_allowed');
    const toolCalls = envelope.output.filter(x=>x.type === 'function_call');
    if (toolCalls.length) {
      if (!toolsAllowed || calls + toolCalls.length > MAX_TOOL_CALLS) throw new Error('comment_tool_limit');
      // Valida o lote inteiro antes de executar qualquer consulta.
      const parsed = toolCalls.map(rawCall => {
        const call = callSchema.parse(rawCall);
        if (!isCommentTool(call.name)) throw new Error('comment_tool_not_allowed');
        if (seenIds.has(call.call_id)) throw new Error('comment_tool_duplicate');
        seenIds.add(call.call_id);
        return { ...call, name: call.name, args: parseCommentToolArgs(call.name, JSON.parse(call.arguments)) };
      });
      calls += parsed.length;
      input.push(...envelope.output);
      for (const call of parsed) {
        let result: unknown;
        try { result = await options.lookup!(call.name, call.args); }
        catch { result = { erro:'consulta_indisponivel', orientacao:'Não confirme dados comerciais sem consulta; encaminhe ao atendimento privado.' }; }
        input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result ?? {erro:'consulta_indisponivel'})});
      }
      continue;
    }
    let decision = decisionSchema.parse(JSON.parse(messages.filter(x=>x.type === 'output_text').map(x=>x.text ?? '').join('')));
    if (decision.action === 'reply') decision = decisionSchema.parse({ ...decision,
      reply_text:publicReply(decision.reply_text, platform, comment) });
    return {decision,model:envelope.model ?? env.OPENAI_MODEL,inputTokens,outputTokens};
  }
  throw new Error('comment_tool_limit');
}
