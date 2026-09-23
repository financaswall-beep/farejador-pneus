import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { commentsConfig, ownsAccount, type CommentsConfig } from './config.js';
import { CommentsGraph, MetaCommentError } from './graph.js';
import { commentRevision } from './extract.js';
import { normalizeCommentEvent } from './ingest.js';
import { decideComment } from './ai.js';
import { claimComment, commentsPaused, finishComment, recoverCommentLeases, saveDecision } from './store.js';

interface WorkerDeps { pool?:Pool; config?:CommentsConfig; graph?:CommentsGraph; decide?:typeof decideComment }
export async function processComment(deps: WorkerDeps = {}): Promise<boolean> {
  const pool = deps.pool ?? defaultPool, config = deps.config ?? commentsConfig();
  if (!config.enabled) return false;
  const graph = deps.graph ?? new CommentsGraph(config);
  const task = await claimComment(pool,'generation');
  if (!task) return false;
  try {
    if (!ownsAccount(config,task.platform,task.account_id)
      || task.author_id === config.pageId || task.author_id === config.instagramId) {
      await finishComment(pool,task,'generating','ignored','account_not_eligible');
      return true;
    }
    const post = await graph.post(task.platform,task.account_id,task.post_id);
    const ai = await (deps.decide ?? decideComment)(task.body,post.caption);
    await saveDecision(pool,task,ai,post.url);
  } catch(error) {
    await finishComment(pool,task,'generating',task.attempts>=3 ? 'failed' : 'pending',
      error instanceof MetaCommentError ? error.code : 'comment_analysis_failed');
  }
  return true;
}
export async function publishComment(deps: WorkerDeps = {}): Promise<boolean> {
  const pool = deps.pool ?? defaultPool, config = deps.config ?? commentsConfig();
  if (!config.enabled || !config.publish) return false;
  const graph = deps.graph ?? new CommentsGraph(config);
  const task = await claimComment(pool,'publication');
  if (!task) return false;
  let writeStarted = false;
  try {
    if (!ownsAccount(config,task.platform,task.account_id) || !task.decision_id
      || task.author_id === config.pageId || task.author_id === config.instagramId) {
      await finishComment(pool,task,'sending','ignored','account_not_eligible'); return true;
    }
    if (task.decision_revision !== task.revision) {
      await finishComment(pool,task,'sending','pending','comment_changed'); return true;
    }
    await graph.assertAccount(task.platform,task.account_id);
    await graph.post(task.platform,task.account_id,task.post_id);
    const current = await graph.comment(task.platform,task.comment_id);
    if (current.authorId === config.pageId || current.authorId === config.instagramId) {
      await finishComment(pool,task,'sending','ignored','own_comment'); return true;
    }
    if (commentRevision(current.body) !== task.revision) {
      // Não apaga nem responde com base em um texto que já mudou. Aguarda webhook da edição.
      await finishComment(pool,task,'sending','failed','comment_changed'); return true;
    }
    if (await commentsPaused(pool)) { await finishComment(pool,task,'sending','queued'); return true; }
    // Nova leitura antes da escrita também detecta resposta humana/remocão recebida pelo webhook.
    const active = await pool.query(`SELECT 1 FROM ops.meta_comment_actions a JOIN core.meta_comments c
      ON c.environment=a.environment AND c.id=a.comment_id WHERE a.environment=$1 AND a.comment_id=$2
      AND a.status='sending' AND NOT c.removed AND c.revision=$3 AND a.lease_id=$4`,[env.FAREJADOR_ENV,task.id,task.revision,task.lease_id]);
    if (!active.rowCount) { await finishComment(pool,task,'sending','ignored','comment_no_longer_pending'); return true; }
    if (task.action === 'delete') {
      writeStarted = true;
      await graph.remove(task.comment_id);
      await finishComment(pool,task,'sending','deleted');
    } else if (task.action === 'reply') {
      writeStarted = true;
      const replyId = await graph.reply(task.platform,task.comment_id,task.reply_text);
      await finishComment(pool,task,'sending','replied',null,replyId);
    } else await finishComment(pool,task,'sending','ignored');
  } catch(error) {
    // Inclui falha do banco APÓS aceite da Meta. A próxima execução não repete a escrita.
    const uncertain = writeStarted && (!(error instanceof MetaCommentError) || error.uncertain);
    const retryable = !uncertain && task.attempts < 4 && error instanceof MetaCommentError
      && (/^meta_http_429_/.test(error.code) || (!writeStarted && /^meta_http_5/.test(error.code)));
    await finishComment(pool,task,'sending',uncertain ? 'uncertain' : retryable ? 'queued' : 'failed',
      error instanceof MetaCommentError ? error.code : 'comment_execution_failed');
  }
  return true;
}
export function startCommentsWorker(): () => void {
  const config = commentsConfig();
  if (!config.enabled) return () => undefined;
  let stopped = false, timer:NodeJS.Timeout|null = null;
  const loop = async () => {
    try {
      await recoverCommentLeases(defaultPool);
      await normalizeCommentEvent(defaultPool,config);
      if (config.token && env.OPENAI_API_KEY && !await commentsPaused(defaultPool)) {
        await processComment();
        // Dados de teste nunca acionam as contas de produção.
        if (env.FAREJADOR_ENV === 'prod') await publishComment();
      }
    } catch { logger.warn('Meta comments worker deferred; check comments configuration/migration'); }
    if (!stopped) timer = setTimeout(() => void loop(),5_000);
  };
  void loop();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
