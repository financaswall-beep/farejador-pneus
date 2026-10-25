/** 2W em curvas vetoriais: o container não precisa instalar fontes para desenhar a marca. */
export function catalogWatermark(width:number):Buffer {
 const height=Math.round(width*.55);
 return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 240 130">
 <g transform="translate(24 12) skewX(-10)" fill="#fff" stroke="#063f31" stroke-width="2" stroke-linejoin="round" opacity=".76">
 <path d="M8 34C8 12 23 2 43 2C65 2 79 15 79 34C79 49 71 58 59 67L33 85H79V106H7V88L46 57C56 49 59 44 59 36C59 28 53 22 44 22C34 22 29 27 28 36Z"/>
 <path d="M85 4H108L118 66L132 18H153L167 66L178 4H201L180 106H158L143 58L129 106H105Z"/>
 </g></svg>`);
}
