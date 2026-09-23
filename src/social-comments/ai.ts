import { z } from 'zod';
import { env } from '../shared/config/env.js';
import { requestOpenAIResponse } from '../atendente-v2/openai-responses-http.js';
import { COMMENT_PROMPT } from './prompt.js';

export const decisionSchema = z.object({
  action:z.enum(['reply','delete','ignore']), sentiment:z.enum(['positive','neutral','negative']),
  reply_text:z.string().max(1000), reason:z.string().min(1).max(400),
  confidence_level:z.enum(['low','medium','high']),
}).strict().refine(d=>d.action === 'delete' ? d.sentiment === 'negative' && d.reply_text === ''
  : d.action === 'reply' ? d.sentiment !== 'negative' && d.reply_text.trim().length > 0 : d.reply_text === '');
export type Decision = z.infer<typeof decisionSchema>;
export interface AiDecision { decision: Decision; model: string; inputTokens: number; outputTokens: number }

export function minimizePublicText(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[e-mail]')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,'[documento]')
    .replace(/(?:\+55\s*)?\(?\b\d{2}\)?[\s-]*\d{4,5}[\s-]*\d{4}\b/g,'[telefone]')
    .replace(/@[a-z0-9_.]+/gi,'[perfil]');
}

/** Only public text, no contact IDs, customer history or database tools sent to the model. */
export async function decideComment(comment: string, post: string,
  request = requestOpenAIResponse): Promise<AiDecision> {
  const raw = await request(JSON.stringify({model:env.OPENAI_MODEL,store:false,max_output_tokens:2048,
    input:[{role:'system',content:COMMENT_PROMPT},
      {role:'user',content:JSON.stringify({publication:minimizePublicText(post.slice(0,6000)),comment:minimizePublicText(comment.slice(0,8000))})}],
    text:{format:{type:'json_schema',name:'comment_decision',strict:true,schema:{
      type:'object',additionalProperties:false,
      required:['action','sentiment','reply_text','reason','confidence_level'],
      properties:{action:{type:'string',enum:['reply','delete','ignore']},sentiment:{type:'string',enum:['positive','neutral','negative']},
        reply_text:{type:'string'},reason:{type:'string'},confidence_level:{type:'string',enum:['low','medium','high']}}}}},
  }));
  const envelope = z.object({status:z.literal('completed'),model:z.string().optional(),
    output:z.array(z.object({type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional()})),
    usage:z.object({input_tokens:z.number().int().nonnegative(),output_tokens:z.number().int().nonnegative()}).optional(),
  }).parse(raw);
  const messages = envelope.output.filter(x=>x.type === 'message').flatMap(x=>x.content ?? []);
  if (messages.some(x=>x.type === 'refusal')) throw new Error('comment_ai_refusal');
  const decision = decisionSchema.parse(JSON.parse(messages.filter(x=>x.type === 'output_text').map(x=>x.text ?? '').join('')));
  return {decision,model:envelope.model ?? env.OPENAI_MODEL,inputTokens:envelope.usage?.input_tokens ?? 0,outputTokens:envelope.usage?.output_tokens ?? 0};
}
