import { z } from 'zod';
export const angleSchema=z.enum(['front','side','detail']);
export type PhotoAngle=z.infer<typeof angleSchema>;
export const folderSchema=z.string().trim().max(500).transform(value=>{
 if(!value)return null;
 if(/^[A-Za-z0-9_-]{10,200}$/.test(value))return value;
 try {const url=new URL(value);if(url.protocol==='https:'&&url.hostname==='drive.google.com'){
  const id=/\/folders\/([A-Za-z0-9_-]{10,200})(?:\/|$)/.exec(url.pathname)?.[1];
  if(id)return id;
 }}catch{/* Validation below. */}
 return 'invalid';
}).refine(value=>value!=='invalid','Informe o link de uma pasta do Google Drive.');
export class CatalogPhotoError extends Error {
 constructor(public readonly code:string,public readonly status=400){super(code);}
}
export interface CatalogPhoto {
 id:string;environment:'prod'|'test';product_id:string;angle:PhotoAngle;is_primary:boolean;
 storage_path:string;original_path:string|null;width:number;height:number;source:string;created_at:Date;
}
export function driveAngle(name:string):PhotoAngle|null {
 const stem=name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\.[^.]+$/,'');
 if(/^(principal|frontal|frente|front)$/.test(stem))return 'front';
 if(/^(lateral|lado|side)$/.test(stem))return 'side';
 if(/^(detalhe|traseira|traseiro|detail)$/.test(stem))return 'detail';
 return null;
}
export function catalogPhotoPayload(body:string){
 try{const data=JSON.parse(body);return typeof data.catalog_photo_id==='string'?data as {
  catalog_photo_id:string;product_id:string;unit_id:string;caption:string}:null;}catch{return null;}
}
