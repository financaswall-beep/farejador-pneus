import { describe,it,expect } from 'vitest';
import { draftSchema,publicationStatus,validateFormats,uploadSchema } from '../../../src/marketing/publisher/model.js';

describe('Publicações: contratos e estados',()=>{
  it('não permite destinos repetidos, TikTok ou ID de conta vindo do cliente',()=>{
    const draft={version:0,title:'Pneu novo',media_id:null,caption:'Legenda',delete_after_publish:true,
      destinations:[{platform:'instagram',format:'feed'}]};
    expect(draftSchema.safeParse(draft).success).toBe(true);
    expect(draftSchema.safeParse({...draft,destinations:[...draft.destinations,...draft.destinations]}).success).toBe(false);
    expect(draftSchema.safeParse({...draft,destinations:[{platform:'tiktok',format:'reel'}]}).success).toBe(false);
    expect(draftSchema.safeParse({...draft,destinations:[{platform:'facebook',format:'feed',account_id:'999'}]}).success).toBe(false);
    expect(draftSchema.safeParse({...draft,environment:'prod'}).success).toBe(false);
  });
  it('preserva resultado parcial e distingue trabalho em andamento de falhas',()=>{
    expect(publicationStatus(['published','published'])).toBe('published');
    expect(publicationStatus(['published','failed'])).toBe('partial');
    expect(publicationStatus(['published','uncertain'])).toBe('partial');
    expect(publicationStatus(['failed','verifying'])).toBe('publishing');
    expect(publicationStatus(['uncertain'])).toBe('failed');
    expect(publicationStatus(['cancelled'])).toBe('cancelled');
  });
  it('valida formatos e restringe tipos/tamanhos de upload',()=>{
    expect(()=>validateFormats('photo',[{platform:'instagram',format:'reel'}])).toThrow('publisher_format_incompatible');
    expect(()=>validateFormats('video',[{platform:'facebook',format:'feed'}])).toThrow('publisher_format_incompatible');
    expect(()=>validateFormats('photo',[])).toThrow('publisher_destination_required');
    expect(()=>validateFormats('video',[{platform:'instagram',format:'story'}])).not.toThrow();
    const file={id:'ad5e2be8-2725-4a4f-96a6-c77aceecdc80',name:'arquivo.html',mime:'text/html',bytes:500};
    expect(uploadSchema.safeParse(file).success).toBe(false);
    expect(uploadSchema.safeParse({...file,mime:'video/mp4',bytes:501*1024*1024}).success).toBe(false);
  });
});
