import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList,isIP } from 'node:net';

const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],
  ['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],
  ['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)
  blocked.addSubnet(address,prefix,'ipv4');
// Only global unicast IPv6, excluding transition, benchmark and documentation space.
const ipv6Global=new BlockList();ipv6Global.addSubnet('2000::',3,'ipv6');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)
  blocked.addSubnet(address,prefix,'ipv6');
export function publicAddress(address:string) {
  const family=isIP(address);
  return family===4?!blocked.check(address,'ipv4'):family===6
    &&ipv6Global.check(address,'ipv6')&&!blocked.check(address,'ipv6');
}
export function callbackUrl(raw:string) {
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')
    ||url.hostname.endsWith('.')||url.hostname==='localhost'||url.hostname.endsWith('.localhost'))throw new Error('invalid_callback');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(isIP(host)&&!publicAddress(host))throw new Error('invalid_callback');
  return url;
}
export type WebhookSender=(url:string,body:string,headers:Record<string,string>)=>Promise<{status:number;body:string}>;

/** Resolve for each connection, pin the validated address, keep original TLS hostname. No redirects/proxies. */
export const sendWebhook:WebhookSender=(raw,body,headers)=>sendPublicRequest(raw,'POST',body,headers);
export const getPublicHealth=(raw:string)=>sendPublicRequest(raw,'GET','',{});
async function sendPublicRequest(raw:string,method:'GET'|'POST',body:string,headers:Record<string,string>) {
  const url=callbackUrl(raw);
  if(Buffer.byteLength(body)>256*1024)throw new Error('payload_too_large');
  let timer:NodeJS.Timeout|undefined;
  const addresses=await Promise.race([
    lookup(url.hostname.replace(/^\[|\]$/g,''),{all:true,verbatim:true}),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('callback_timeout')),3000);}),
  ]).finally(()=>clearTimeout(timer));
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new Error('invalid_callback');
  const address=addresses.find(item=>item.family===4)??addresses[0]!;
  return new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=request(url,{method,agent:false,family:address.family,...{autoSelectFamily:false},
      headers:{...headers,'content-length':Buffer.byteLength(body)},
      lookup:(_host,_options,done)=>done(null,address.address,address.family),
    },response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{
        size+=chunk.length;
        if(size>8192)req.destroy(new Error('callback_response_too_large'));else chunks.push(chunk);
      });
      response.on('error',()=>reject(new Error('callback_network_error')));
      response.on('end',()=>resolve({status:response.statusCode??0,body:Buffer.concat(chunks).toString('utf8')}));
    });
    const deadline=setTimeout(()=>req.destroy(new Error('callback_timeout')),10_000);
    req.on('close',()=>clearTimeout(deadline));
    req.on('error',()=>reject(new Error('callback_network_error')));
    req.end(body);
  });
};
