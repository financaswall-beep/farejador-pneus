import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { archiveBlockers, findArchivedCatalogTires, getProductIdentity, getProductImpact } from '../painel/catalog-product-impact.js';
import { applyCatalogProduct, catalogIdentityBody, catalogStatusBody, planCatalogProduct } from '../painel/catalog-product-lifecycle.js';
import { registerInventoryRead as read, registerInventoryWrite as write } from './inventory-registry.js';

read('consultar_impacto_produto_catalogo','Consulte a identidade do pneu, situação, vendas, referências e impedimentos para arquivar ou substituir a ficha.',
  z.object({product_id:z.string().uuid()}).strict(),async ({product_id})=>{
    const produto=await getProductIdentity(pool,env.FAREJADOR_ENV,product_id);
    const impacto=await getProductImpact(pool,env.FAREJADOR_ENV,produto);
    return {produto,impacto,impedimentos_arquivamento:archiveBlockers(impacto)};
  });
read('buscar_produtos_arquivados_catalogo','Localize pneus arquivados por código, nome ou medida, inclusive para reativação.',
  z.object({q:z.string().trim().min(2).max(160)}).strict(),({q})=>findArchivedCatalogTires(pool,env.FAREJADOR_ENV,q));
write('catalog','corrigir_identidade_produto_catalogo','Corrige o nome na ficha. Mudar código, marca, medida ou condição cria uma nova ficha com outro código e arquiva a anterior, preservando o código original. Mostre impedimentos, dependências e o que permanece na ficha antiga antes de confirmar.',
  catalogIdentityBody,(db,data,actor)=>applyCatalogProduct(db,env.FAREJADOR_ENV,data,actor),false,
  (db,data)=>planCatalogProduct(db,env.FAREJADOR_ENV,data));
write('catalog','alterar_status_produto_catalogo','Arquiva ou reativa um pneu. Confira os vínculos, preços, saldo e operações em aberto na prévia. Ficha arquivada deixa de ser oferecida; a reativação recupera o mesmo ID e seus vínculos.',
  catalogStatusBody,(db,data,actor)=>applyCatalogProduct(db,env.FAREJADOR_ENV,data,actor),false,
  (db,data)=>planCatalogProduct(db,env.FAREJADOR_ENV,data));
