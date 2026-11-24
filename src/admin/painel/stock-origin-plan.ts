export interface OriginPlanRow {
  origin_id: string;
  quantity: number;
  candidate_id: string;
  group_id: string | null;
  location_code: string | null;
  capacity: number;
  supply: number;
  suggested_quantity: number;
}
export interface OriginSelection { candidate_id: string; quantity: number }
interface Edge { to: number; remaining: number; reverse: number }
interface Assignment { row: OriginPlanRow; edge: Edge; initial: number }

/**
 * Várias saídas podem disputar a última peça da pilha. Trate as unidades livres
 * e as sugestões pendentes como capacidades, mantendo fixas as origens já confirmadas.
 * Caminhos aumentantes permitem trocar sugestões entre vendas quando a origem real
 * da primeira só é informada depois da segunda. Nunca usa estoque reservado por fora.
 */
export function planOriginConfirmation(rows: OriginPlanRow[], id: string, selections: OriginSelection[]) {
  const selected = new Map<string,number>();
  const target = rows.filter(row=>row.origin_id === id);
  if (!target.length) throw new Error('stock_origin_changed');
  for (const pick of selections) {
    if (!Number.isSafeInteger(pick.quantity) || pick.quantity<=0 || selected.has(pick.candidate_id))
      throw new Error('stock_origin_invalid');
    const option=target.find(row=>row.candidate_id===pick.candidate_id);
    if (!option) throw new Error('stock_origin_invalid');
    if (pick.quantity>option.capacity || pick.quantity>option.supply) throw new Error('stock_origin_changed');
    selected.set(pick.candidate_id,pick.quantity);
  }
  if ([...selected.values()].reduce((a,b)=>a+b,0)!==target[0]!.quantity)
    throw new Error('stock_origin_invalid');

  const graph:Edge[][]=[[],[]], start=0, end=1;
  const origins=new Map<string,number>();
  const positions=new Map<string,number>();
  const inbound=new Map<string,Edge>(), outbound=new Map<number,Edge>();
  const assignments:Assignment[]=[];
  let required=0;
  function addEdge(from:number,to:number,capacity:number) {
    const forward={to,remaining:capacity,reverse:graph[to]!.length};
    const backward={to:from,remaining:0,reverse:graph[from]!.length};
    graph[from]!.push(forward);
    graph[to]!.push(backward);
    return forward;
  }
  // Saturar as quantidades atualmente sugeridas primeiro reduz mudanças nas outras vendas.
  for(const row of rows) {
    let order=origins.get(row.origin_id);
    if(order===undefined) {
      order=graph.push([])-1;
      origins.set(row.origin_id,order);
      inbound.set(row.origin_id,addEdge(start,order,row.quantity));
      required+=row.quantity;
    }
    const positionKey=JSON.stringify([row.group_id,row.location_code]);
    let position=positions.get(positionKey);
    if(position===undefined) {
      position=graph.push([])-1;
      positions.set(positionKey,position);
      outbound.set(position,addEdge(position,end,row.supply));
    }
    const cap=row.origin_id===id ? selected.get(row.candidate_id)??0 : row.capacity;
    const preferred=Math.min(cap,row.suggested_quantity);
    if (preferred) assignments.push({row,edge:addEdge(order,position,preferred),initial:preferred});
  }
  // Atribuições que já cabem ficam instaladas; só as desloca se a confirmação exigir.
  for(const {row,edge,initial} of assignments) {
    const source=inbound.get(row.origin_id)!, sink=outbound.get(edge.to)!;
    const units=Math.min(initial,source.remaining,sink.remaining);
    for(const link of [source,edge,sink]) {
      link.remaining-=units;
      graph[link.to]![link.reverse]!.remaining+=units;
    }
    required-=units;
  }
  for(const row of rows) {
    const cap=row.origin_id===id ? selected.get(row.candidate_id)??0 : row.capacity;
    const extra=cap-Math.min(cap,row.suggested_quantity);
    if (!extra) continue;
    const order=origins.get(row.origin_id)!;
    const position=positions.get(JSON.stringify([row.group_id,row.location_code]))!;
    assignments.push({row,edge:addEdge(order,position,extra),initial:extra});
  }
  while(required>0) {
    const prev=new Map<number,{from:number; edge:Edge}>();
    const queue=[start];
    for(let idx=0;idx<queue.length && !prev.has(end);idx++) {
      const from=queue[idx]!;
      for(const edge of graph[from]!) {
        if(edge.remaining<=0 || edge.to===start || prev.has(edge.to)) continue;
        prev.set(edge.to,{from,edge});
        queue.push(edge.to);
      }
    }
    if(!prev.has(end)) throw new Error('stock_origin_changed');
    let amount=required;
    for(let node=end;node!==start;) {
      const step=prev.get(node)!;
      amount=Math.min(amount,step.edge.remaining);
      node=step.from;
    }
    for(let node=end;node!==start;) {
      const step=prev.get(node)!;
      step.edge.remaining-=amount;
      graph[node]![step.edge.reverse]!.remaining+=amount;
      node=step.from;
    }
    required-=amount;
  }
  const result=new Map<string,number>();
  for(const {row,edge,initial} of assignments) {
    result.set(row.candidate_id,(result.get(row.candidate_id)??0)+initial-edge.remaining);
  }
  return rows.map(row=>({candidate_id:row.candidate_id,
    delta:(result.get(row.candidate_id)??0)-row.suggested_quantity})).filter(row=>row.delta!==0)
    .sort((a,b)=>a.delta-b.delta || a.candidate_id.localeCompare(b.candidate_id));
}
