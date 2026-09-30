import { z } from 'zod';
import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { isReasoningModel } from '../../shared/openai-model.js';
import { requestOpenAIResponse } from '../../atendente-v2/openai-responses-http.js';
import { CAPTION_PROMPT, CAPTION_VERSION } from './prompt.js';
import { PublisherError, type Environment } from './model.js';

const envelope=z.object({status:z.literal('completed'),output:z.array(z.object({
  type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional(),
})),usage:z.object({input_tokens:z.number().int().nonnegative(),output_tokens:z.number().int().nonnegative()}).optional()});
export function minimizeBrief(value:string):string {
  return value.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email omitido]')
    .replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}\b/g,'[CPF omitido]')
    .replace(/(?:\+?55\s*)?\(?\d{2}\)?[\s-]*9?\d{4}[\s-]*\d{4}\b/g,'[telefone omitido]');
}
export async function generateCaption(pool:Pool,environment:Environment,brief:string,request=requestOpenAIResponse) {
  if(!env.OPENAI_API_KEY)throw new PublisherError('publisher_ai_missing',503);
  const minimized=minimizeBrief(brief);
  const reasoning=isReasoningModel(env.OPENAI_MODEL);
  const response=envelope.safeParse(await request(JSON.stringify({model:env.OPENAI_MODEL,store:false,
    instructions:CAPTION_PROMPT,input:minimized,max_output_tokens:reasoning?4096:1024,
    ...(reasoning?{reasoning:{effort:'low'}}:{})})));
  if(!response.success)throw new PublisherError('publisher_ai_response_invalid',502);
  const caption=response.data.output.filter(o=>o.type==='message').flatMap(o=>o.content??[])
    .filter(c=>c.type==='output_text').map(c=>c.text??'').join('\n').trim();
  if(!caption || caption.length>2200)throw new PublisherError('publisher_ai_response_invalid',502);
  const saved=await pool.query<{id:string}>(`INSERT INTO analytics.publisher_captions(environment,brief,caption,extractor_version,
    confidence_level,model,input_tokens,output_tokens) VALUES($1,$2,$3,$4,'low',$5,$6,$7) RETURNING id`,
    [environment,minimized,caption,CAPTION_VERSION,env.OPENAI_MODEL,response.data.usage?.input_tokens??0,response.data.usage?.output_tokens??0]);
  return {id:saved.rows[0]!.id,caption,requires_review:true};
}
