import { afterEach, describe, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({BOT_AUDIO_MODEL:'gpt-transcribe',OPENAI_API_KEY:'fixture'}));
vi.mock('../../../src/shared/config/env.js', () => ({env:config}));
import { transcribeAudio, AUDIO_RULES } from '../../../src/atendente-v2/audio-transcription.js';
import { transcriptionConfidence } from '../../../src/atendente-v2/audio-model.js';
const audio = Buffer.from('OggS'+'fixture'.repeat(5));
afterEach(() => {config.BOT_AUDIO_MODEL='gpt-transcribe';});

describe('GPT-Transcribe e compatibilidade de áudio', () => {
  it('envia OGG com metadados e contrato novo, sem language nem logprobs', async () => {
    const fetcher = vi.fn(async (_url: unknown, options: any) => {
      const form=options.body as FormData;
      expect(form.get('model')).toBe('gpt-transcribe');
      expect(form.getAll('languages[]')).toEqual(['pt']);
      expect(form.has('language')).toBe(false);
      expect(form.has('include[]')).toBe(false);
      expect(form.get('response_format')).toBe('json');
      expect(form.get('prompt')).toContain('loja de pneus');
      expect(form.getAll('keywords[]')).toContain('meia-vida');
      expect(form.getAll('keywords[]').some(word => /\d/.test(String(word)))).toBe(false);
      const file=form.get('file') as File;
      expect(file.name).toBe('mensagem.ogg');expect(file.type).toBe('audio/ogg');
      return Response.json({text:' Sou de Itaboraí. ',languages:[{code:'pt'}],usage:{type:'duration',seconds:4}});
    });
    const usage=vi.fn(async()=>{});
    expect(await transcribeAudio(audio,fetcher,usage)).toEqual({text:'Sou de Itaboraí.',confidence:'low'});
    expect(usage).toHaveBeenCalledExactlyOnceWith({type:'duration',seconds:4});
    expect(AUDIO_RULES).toContain('não significa áudio incompreensível');
  });
  it.each(['gpt-4o-mini-transcribe','gpt-4o-transcribe'])('preserva contrato de %s para rollback', async model => {
    config.BOT_AUDIO_MODEL=model;
    const fetcher=vi.fn(async (_url:unknown,options:any)=>{
      expect(options.body.get('language')).toBe('pt');
      expect(options.body.getAll('include[]')).toEqual(['logprobs']);
      expect(options.body.has('languages[]')).toBe(false);
      expect(options.body.has('keywords[]')).toBe(false);
      return Response.json({text:'Quero dois pneus.',logprobs:[{logprob:-0.1}]});
    });
    expect(await transcribeAudio(audio,fetcher)).toMatchObject({confidence:'medium'});
  });
  it.each([undefined,null,[],{},[{logprob:-3}],[{logprob:-0.1},{}],[{logprob:1}]])
    ('não transforma confiança ausente/inválida em certeza: %j', value => {
      expect(transcriptionConfidence('gpt-4o-transcribe',value)).toBe('low');
    });
  it('não fabrica medidor de certeza para GPT-Transcribe', () => {
    expect(transcriptionConfidence('gpt-transcribe',[{logprob:-0.01}])).toBe('low');
  });
  it.each(['',null,123,' '.repeat(10),'a'.repeat(16001)])('recusa transcrição vazia/inválida', async text => {
    await expect(transcribeAudio(audio,async()=>Response.json({text}))).rejects.toThrow('audio_transcript_invalid');
  });
  it('falha sanitizada permite pedir texto sem expor erro/credencial do provedor', async () => {
    await expect(transcribeAudio(audio,async()=>Response.json({error:'sensitive-provider-detail'},{status:400})))
      .rejects.toThrow(/^audio_transcription_failed$/);
  });
});
