export type ChatScope='conversation'|'chatwoot_conversation'|'conversation_self'|'contact'|'message'|'fact'|'cart'|'turn';
export interface FullSource {
  key:string; area:string; table:string; fields:string[]; dates:string[]; dateOnly:string[]; scalar:string[]; scope?:ChatScope;
}
const words=(value:string)=>value.split(' ').filter(Boolean);
export function source(table:string,area:string,fields:string,dates:string,scalar:string,scope?:ChatScope):FullSource {
  const dateNames=words(dates).map(d=>d.split(':')[0]!);
  const definition={key:table,area,table,fields:words(fields),dates:dateNames,
    dateOnly:words(dates).filter(d=>d.endsWith(':date')).map(d=>d.split(':')[0]!),scalar:[...words(scalar),...dateNames],scope};
  if(!/^[a-z_]+\.[a-z_]+$/.test(table)||!definition.fields.every(f=>/^[a-z_][a-z0-9_]*$/.test(f)))throw Error('invalid_source_definition');
  return definition;
}
