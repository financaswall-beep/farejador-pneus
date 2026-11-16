import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js', () => ({ env: {} }));
import { InstagramRemovalGraph } from '../../../src/marketing/publisher/instagram-removal-graph.js';
import { accountId } from '../../../src/marketing/publisher/model.js';

const account = accountId('instagram');
const config = {enabled:true,publish:true,scopeValid:true,instagramId:account,apiVersion:'v27.0',appId:'77',appSecret:'fixture'};
const fetcher = vi.fn<typeof fetch>();
const graph = new InstagramRemovalGraph(config, 'fixture-user', fetcher);
const token = {type:'USER',app_id:'77',is_valid:true,scopes:['instagram_basic','instagram_manage_contents']};
const json = (value: unknown, status=200) => new Response(JSON.stringify(value), {status});
beforeEach(() => fetcher.mockReset());

it('usa o token de usuário e só aceita o recibo da mídia da 2W', async () => {
  fetcher.mockResolvedValueOnce(json({data:token})).mockResolvedValueOnce(json({id:'42',owner:{id:account}}))
    .mockResolvedValueOnce(json({success:true,deleted_id:'42'}));
  await graph.removePublishedMedia(account,'42');
  expect(fetcher.mock.calls.map(([url,req]) => [new URL(String(url)).pathname,req?.method])).toEqual([
    ['/v27.0/debug_token','GET'],['/v27.0/42','GET'],['/v27.0/42','DELETE'],
  ]);
  expect(new Headers(fetcher.mock.calls[2]![1]?.headers).get('Authorization')).toBe('Bearer fixture-user');
});
it.each([{type:'PAGE'}, {app_id:'88'}, {is_valid:false}, {expires_at:1}, {data_access_expires_at:1},
  {scopes:['instagram_content_publish']}, {granular_scopes:[{scope:'instagram_manage_contents',target_ids:['99']}]}])(
  'bloqueia antes do DELETE com token incompatível %j', async fields => {
    fetcher.mockResolvedValueOnce(json({data:{...token,...fields}}));
    await expect(graph.removePublishedMedia(account,'42')).rejects.toThrow(/publisher_removal_/);
    expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejeita outro perfil ou outro ID antes da exclusão', async () => {
  await expect(graph.removePublishedMedia('99','42')).rejects.toThrow('publisher_removal_target_invalid');
  await expect(graph.removePublishedMedia(account,'42/media')).rejects.toThrow('publisher_removal_target_invalid');
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValueOnce(json({data:token})).mockResolvedValueOnce(json({id:'42',owner:{id:'99'}}));
  await expect(graph.removePublishedMedia(account,'42')).rejects.toThrow('meta_post_owner_mismatch');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([json({success:true,deleted_id:'99'}),json({success:true}),json({},504),json({},408)])(
  'resposta ambígua nunca confirma exclusão', async receipt => {
    fetcher.mockResolvedValueOnce(json({data:token})).mockResolvedValueOnce(json({id:'42',owner:{id:account}}))
      .mockResolvedValueOnce(receipt);
    await expect(graph.removePublishedMedia(account,'42')).rejects.toMatchObject({uncertain:true});
});
