import { catalogPhoneOutline,catalogPneusOutline } from './watermark-lettering.js';

/** A mesma assinatura da Matriz em fotos e vídeos, com telefone e sem fontes no container. */
export function catalogWatermark(width:number):Buffer {
 const height=Math.round(width*.22);
 return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1000 220"
 role="img" aria-label="2W Pneus — WhatsApp (21) 97250-9411">
 <defs><linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
 <stop stop-color="#08765a"/><stop offset="1" stop-color="#064b3b"/></linearGradient></defs>
 <rect width="1000" height="220" rx="48" fill="url(#plate)" fill-opacity=".9"/>
 <rect x="1" y="1" width="998" height="218" rx="47" fill="none" stroke="#c4f3df" stroke-opacity=".22" stroke-width="2"/>
 <g transform="translate(55 35) scale(.86) skewX(-10)" fill="#fff">
 <path d="M8 34C8 12 23 2 43 2C65 2 79 15 79 34C79 49 71 58 59 67L33 85H79V106H7V88L46 57C56 49 59 44 59 36C59 28 53 22 44 22C34 22 29 27 28 36Z"/>
 <path d="M85 4H108L118 66L132 18H153L167 66L178 4H201L180 106H158L143 58L129 106H105Z"/>
 </g><path d="M54 149H226" stroke="#a7efd2" stroke-width="3" stroke-linecap="round"/>
 <path d="${catalogPneusOutline}" fill="#fff" stroke="#fff" stroke-width=".6" stroke-linejoin="round"/>
 <path d="M271 43V177" stroke="#a7efd2" stroke-opacity=".75" stroke-width="3"/>
 <g transform="translate(310 64) scale(.9)" stroke="#fff" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">
 <path d="M24 77L15 92L35 87A39 39 0 1 0 24 77Z" fill="none"/>
 <path d="M35 28L43 27L49 42L43 48C48 59 53 64 64 68L70 61L83 67C83 78 76 81 68 78C47 72 31 56 28 39C27 33 30 29 35 28Z" fill="#fff" stroke-width="1"/>
 </g><path d="${catalogPhoneOutline}" fill="#fff" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>
 </svg>`);
}

/** Margem segura e telefone legível inclusive nos vídeos de 360 px enviados pelo celular. */
export function catalogWatermarkPlacement(mediaWidth:number,mediaHeight:number){
 const inset=Math.max(8,Math.round(Math.min(mediaWidth,mediaHeight)*.025));
 const width=Math.round(Math.min(480,Math.max(220,mediaWidth*.38),mediaWidth-inset*2,mediaHeight*.9));
 const height=Math.round(width*.22);
 return {width,height,inset,left:mediaWidth-width-inset,top:mediaHeight-height-inset};
}
