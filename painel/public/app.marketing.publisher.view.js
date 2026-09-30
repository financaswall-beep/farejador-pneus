// Template estático. Dados do operador são exibidos exclusivamente por x-text/x-model.
window.MARKETING_PUBLISHER_TEMPLATE = `
<div class="mp-screen">
  <p class="mp-notice mp-warning" x-show="mpConfig && (!mpConfig.enabled || !mpConfig.schema_ready || !mpConfig.storage_ready || !mpConfig.sending)" x-text="!mpConfig?.schema_ready?'A migration da Central precisa ser aplicada.':!mpConfig?.enabled?'Central preparada. Ative a configuração no servidor para começar.':!mpConfig?.storage_ready?'Configure o bucket privado do Supabase para enviar suas mídias.':'Rascunhos disponíveis. O envio às redes precisa ser habilitado no servidor.'"></p>
  <p class="mp-notice mp-error" role="alert" x-show="mpError" x-text="mpError"></p><p class="mp-notice" role="status" x-show="mpMessage" x-text="mpMessage"></p>
  <template x-for="warning in mpWarnings" :key="warning"><p class="mp-notice mp-warning" role="status" x-text="mpErrorText({message:warning})"></p></template>
  <p class="mp-muted" x-show="mpLoading">Atualizando publicações…</p>
  <div class="mp-columns" x-show="mpTab==='create'">
    <aside class="mp-card mp-library">
      <h3><i data-lucide="folder"></i>Biblioteca de mídia</h3>
      <label class="mp-search"><i data-lucide="search"></i><input type="search" placeholder="Buscar arquivo" aria-label="Buscar arquivo" x-model="mpSearch"></label>
      <div class="mp-chips"><button @click="mpKind='all'" :aria-pressed="mpKind==='all'">Todos</button><button @click="mpKind='video'" :aria-pressed="mpKind==='video'">Vídeos</button><button @click="mpKind='photo'" :aria-pressed="mpKind==='photo'">Fotos</button></div>
      <label class="mp-upload" @dragover.prevent @drop.prevent="mpUploadFiles($event)" :class="{'mp-disabled':!mpConfig?.enabled||!mpConfig?.storage_ready||mpUploadBusy}">
        <i data-lucide="cloud-upload"></i><strong>Enviar fotos ou vídeos</strong><span>Arraste ou <u>escolha arquivos</u></span>
        <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,video/mp4,video/quicktime" @change="mpUploadFiles($event)" :disabled="mpUploadBusy||!mpConfig?.enabled||!mpConfig?.storage_ready" aria-label="Enviar fotos ou vídeos">
      </label>
      <input type="file" x-ref="mpResumeInput" hidden @change="mpUploadFiles($event)" aria-label="Selecionar o mesmo arquivo para continuar envio">
      <div class="mp-upload-progress" x-show="mpUploadBusy"><span x-text="mpUploadName"></span><progress max="100" :value="mpUploadProgress||0"></progress><small x-text="mpUploadPhase+' '+(mpUploadProgress==null?'':(mpUploadProgress||0)+'%')"></small></div>
      <small class="mp-muted" x-text="'Fotos até '+mpBytes(Math.min(8388608,mpConfig?.max_file_bytes||524288000))+' · Vídeos até '+mpBytes(mpConfig?.max_file_bytes||524288000)"></small>
      <small class="mp-muted mp-upload-help">Envio retomável. Se interromper, selecione o mesmo arquivo para continuar. Fotos HEIC são convertidas no servidor.</small>
      <div class="mp-media-grid">
        <template x-for="media in mpVisibleMedia()" :key="media.id">
          <div class="mp-media-tile"><button type="button" @click="mpSelectMedia(media)" :disabled="mpBusy||mpMediaNeedsRecovery(media)" :class="{'is-selected':mpForm?.media_id===media.id}">
            <img :src="mpThumbnail(media)" @error="media.thumbnail_url=null" :alt="media.name" loading="lazy"><span class="mp-tile-kind" x-show="media.kind==='video'&&media.duration"><i data-lucide="play"></i><span x-text="Math.round(Number(media.duration))+'s'"></span></span><span class="mp-tile-check" x-show="mpForm?.media_id===media.id">✓</span>
          </button><div><span x-text="media.name"></span><button class="mp-icon" type="button" @click="mpRemoveMedia(media)" :disabled="mpBusy||mpUploadBusy" :aria-label="'Remover '+media.name"><i data-lucide="trash-2"></i></button></div>
            <small class="mp-error-text" x-show="media.thumbnail_error&&media.status==='ready'">Miniatura indisponível; mídia preservada.</small>
            <div class="mp-media-recovery" x-show="mpMediaNeedsRecovery(media)">
              <small x-text="media.status==='ready'?'Falta conferir o vídeo.':mpMediaReceived(media)?'Recebido; falta conferir o arquivo.':mpStatus(media.status)"></small>
              <small class="mp-error-text" x-show="media.error_code" x-text="mpErrorText({message:media.error_code})"></small>
              <button class="mp-link" type="button" x-show="mpMediaCanFinalize(media)" @click="mpReprocessMedia(media)" :disabled="mpBusy||mpUploadBusy">Conferir arquivo</button>
              <button class="mp-link" type="button" x-show="media.status!=='ready'&&!mpMediaReceived(media)" @click="mpResumeMedia=media;$refs.mpResumeInput.click()" :disabled="mpBusy||mpUploadBusy">Continuar envio</button>
            </div>
          </div>
        </template>
      </div>
      <div class="mp-empty" x-show="!mpVisibleMedia().length && !mpUploadBusy"><i data-lucide="images"></i><p>Sua biblioteca começa aqui.</p><small>Envie uma foto ou um vídeo para criar a publicação.</small></div>
      <div class="mp-selected-file" x-show="mpSelectedMedia()"><h4>Arquivo selecionado</h4><div><img :src="mpThumbnail(mpSelectedMedia())" alt=""><span><strong x-text="mpSelectedMedia()?.name"></strong><small x-text="mpBytes(mpSelectedMedia()?.bytes||0)"></small></span></div></div>
    </aside>
    <section class="mp-card mp-editor">
      <div class="mp-card-heading"><h3>Editar publicação</h3><small :class="mpDirty?'mp-muted':''" x-text="mpDirty?'Alterações não salvas':mpForm?.version?'Rascunho salvo':'Novo rascunho'"></small></div>
      <template x-if="mpForm"><fieldset :disabled="mpBusy">
        <label class="mp-label">Título interno<input maxlength="180" type="text" x-model="mpForm.title" @input="mpDirty=true" placeholder="Ex.: Pneus para rodar tranquilo"></label>
        <div class="mp-label">Mídia da publicação</div>
        <div class="mp-editor-media" x-show="mpSelectedMedia()"><img :src="mpThumbnail(mpSelectedMedia())" alt=""><div><strong x-text="mpSelectedMedia()?.name"></strong><small x-text="mpSelectedMedia()?.kind==='video'?'Vídeo · '+Math.round(Number(mpSelectedMedia()?.duration))+' segundos':'Foto'"></small><button class="mp-link" @click="mpOpenPreview(mpSelectedMedia())" type="button">Ver mídia <i data-lucide="external-link"></i></button></div><button class="mp-icon" type="button" @click="mpForm.media_id=null;mpDirty=true" aria-label="Desmarcar mídia"><i data-lucide="x"></i></button></div>
        <div class="mp-empty mp-editor-placeholder" x-show="!mpSelectedMedia()"><i data-lucide="image-plus"></i><p>Escolha uma mídia na biblioteca.</p></div>
        <div class="mp-caption-heading"><h4>Texto da publicação</h4><button class="mp-button mp-ai" type="button" @click="mpGenerateCaption()" :disabled="mpAiBusy||!mpBrief.trim()||!mpConfig?.ai_ready||!mpConfig?.enabled"><i data-lucide="sparkles"></i><span x-text="mpAiBusy?'Gerando…':'Gerar texto com IA'"></span></button></div>
        <label class="mp-label"><span>O que você quer destacar?</span><input maxlength="1200" type="text" x-model="mpBrief" placeholder="Pneus para moto, atendimento e entrega"></label>
        <textarea class="mp-caption" maxlength="2200" rows="8" x-model="mpForm.caption" @input="mpDirty=true" placeholder="Escreva a legenda da publicação" aria-label="Texto da publicação"></textarea>
        <div class="mp-caption-footer"><small>Revise o texto gerado antes de publicar.</small><small x-text="mpForm.caption.length+' / 2200'"></small></div>
        <h4 class="mp-preview-title">Prévia por rede <small>Confira a mídia completa antes de publicar.</small></h4>
        <div class="mp-preview-grid"><template x-for="destination in mpForm.destinations.filter(d=>d.selected)" :key="destination.platform"><article class="mp-network-preview" :class="destination.format==='feed'?'mp-preview-feed':'mp-preview-vertical'">
          <header><img :src="'/assets/brands/'+destination.platform+'.svg'" :alt="destination.platform"><span><strong x-text="destination.platform==='instagram'?'Instagram':'Facebook'"></strong><small x-text="mpFormat(destination.format)"></small></span></header>
          <button type="button" @click="mpOpenPreview(mpSelectedMedia())" :disabled="!mpSelectedMedia()"><img x-show="mpSelectedMedia()" :src="mpThumbnail(mpSelectedMedia())" alt="Prévia da mídia"><span x-show="!mpSelectedMedia()">Sem mídia</span></button>
          <p x-show="destination.format!=='story'" x-text="(mpCustom?destination.caption:mpForm.caption)||'Sua legenda aparecerá aqui.'"></p><small x-show="destination.format==='story'">Story utiliza a mídia. A legenda não é sobreposta ao arquivo.</small>
        </article></template></div>
      </fieldset></template>
    </section>
    <aside class="mp-card mp-destinations">
      <h3>Destinos e publicação</h3><p class="mp-muted">Escolha as contas e o formato.</p>
      <template x-if="mpForm"><fieldset :disabled="mpBusy">
        <template x-for="destination in mpForm.destinations" :key="destination.platform"><div class="mp-destination">
          <label><input type="checkbox" x-model="destination.selected" @change="mpDirty=true"><img :src="'/assets/brands/'+destination.platform+'.svg'" :alt="destination.platform"><span><strong x-text="destination.platform==='instagram'?'Instagram':'Facebook'"></strong><small x-text="destination.platform==='instagram'?'@2wp.pneus':'2W Pneus'"></small></span></label>
          <select x-model="destination.format" @change="mpDirty=true" :aria-label="'Formato no '+destination.platform"><option value="feed" :disabled="mpSelectedMedia()?.kind==='video'">Feed</option><option value="reel" :disabled="mpSelectedMedia()?.kind==='photo'">Reel</option><option value="story">Story</option></select>
        </div></template>
        <p class="mp-muted mp-tiktok-note">TikTok entra em uma próxima etapa.</p>
        <p class="mp-notice mp-warning" x-show="mpKnownPermissionBlock()">Há destinos sem permissão de publicação. Confira Gerenciar contas.</p>
        <button class="mp-link" type="button" @click="mpCustom=!mpCustom;if(mpCustom)mpForm.destinations.forEach(d=>{if(!d.caption)d.caption=mpForm.caption});mpDirty=true"><i data-lucide="sliders-horizontal"></i>Personalizar texto por rede</button>
        <div x-show="mpCustom"><template x-for="destination in mpForm.destinations.filter(d=>d.selected)" :key="destination.platform"><label class="mp-label"><span x-text="destination.platform==='instagram'?'Legenda do Instagram':'Legenda do Facebook'"></span><textarea maxlength="2200" rows="3" x-model="destination.caption" @input="mpDirty=true" :disabled="destination.format==='story'"></textarea></label></template></div>
        <div class="mp-schedule"><h4>Quando publicar?</h4><div class="mp-radio-row"><label><input type="radio" value="now" x-model="mpWhen">Agora</label><label><input type="radio" value="schedule" x-model="mpWhen">Agendar</label></div>
          <div class="mp-date-time" x-show="mpWhen==='schedule'"><label><small>Data</small><input type="date" x-model="mpDate" aria-label="Data da publicação"></label><label><small>Horário</small><input type="time" x-model="mpTime" aria-label="Horário da publicação"></label></div><small class="mp-muted">Horário de Brasília</small>
        </div>
        <div class="mp-upcoming"><h4><i data-lucide="calendar-days"></i>Próximas publicações</h4><template x-for="post in mpUpcoming()" :key="post.id"><div class="mp-upcoming-item"><span><strong x-text="post.title"></strong><small x-text="mpDateLabel(post.scheduled_at)"></small></span><span class="mp-badge">Agendada</span></div></template><small class="mp-muted" x-show="!mpUpcoming().length">Nenhuma publicação agendada.</small><button class="mp-link" type="button" @click="mpTab='calendar'">Abrir calendário →</button></div>
        <label class="mp-cleanup"><input type="checkbox" x-model="mpForm.delete_after_publish" @change="mpDirty=true"><span>Apagar a mídia após publicar em todas as redes<small>Miniatura, legenda, links e histórico ficam salvos. Arquivos usados em outro rascunho são preservados.</small></span></label>
        <button class="mp-button mp-primary mp-full" type="button" @click="mpSubmit()" :disabled="mpBusy||mpUploadBusy||!mpConfig?.sending||mpKnownPermissionBlock()||!mpSelectedMedia()||!mpForm.destinations.some(d=>d.selected)"><i :data-lucide="mpWhen==='schedule'?'clock':'send'"></i><span x-text="mpBusy?'Aguarde…':mpWhen==='schedule'?'Agendar publicação':'Publicar agora'"></span></button>
        <div class="mp-actions"><button class="mp-button" type="button" @click="mpSave()" :disabled="mpBusy||!mpConfig?.enabled||!mpConfig?.schema_ready"><i data-lucide="save"></i>Salvar rascunho</button><button class="mp-button" type="button" @click="mpNew()" :disabled="mpBusy">Limpar</button></div>
      </fieldset></template>
    </aside>
  </div>
  <section class="mp-card mp-calendar" x-show="mpTab==='calendar'">
    <div class="mp-card-heading"><div><h3>Calendário de publicações</h3><p class="mp-muted">Agendamentos e resultados no horário de Brasília.</p></div><button class="mp-button" @click="mpNew()"><i data-lucide="plus"></i>Nova publicação</button></div>
    <div class="mp-month-nav"><button class="mp-icon" @click="mpCalendarMove(-1)" aria-label="Mês anterior"><i data-lucide="chevron-left"></i></button><h4 x-text="mpCalendarLabel()"></h4><button class="mp-icon" @click="mpCalendarMove(1)" aria-label="Próximo mês"><i data-lucide="chevron-right"></i></button></div>
    <div class="mp-weekdays"><template x-for="day in ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb']"><span x-text="day"></span></template></div>
    <div class="mp-calendar-grid"><template x-for="cell in mpCalendarDays()" :key="cell.key"><div class="mp-calendar-cell"><strong x-text="cell.day||''"></strong><template x-for="post in cell.posts" :key="post.id"><div class="mp-calendar-post" :class="'mp-state-'+post.status"><strong x-text="post.title"></strong><small x-text="mpDateLabel(post.scheduled_at)"></small><span x-text="mpStatus(post.status)"></span><button class="mp-link" x-show="post.status==='scheduled'" @click="mpAction(post,'cancel')" :disabled="mpBusy">Cancelar agendamento</button></div></template></div></template></div>
    <p class="mp-muted">Para alterar uma publicação agendada, cancele o agendamento e crie uma nova publicação. Envios já iniciados não são cancelados.</p>
  </section>
  <section class="mp-card mp-history" x-show="mpTab==='drafts'">
    <div class="mp-card-heading"><div><h3 x-text="mpTab==='drafts'?'Seus rascunhos':'Publicações e acompanhamento'"></h3><p class="mp-muted" x-text="mpTab==='drafts'?'Retome seus conteúdos antes de publicar.':'Confira o resultado de cada rede. Envios incertos não são repetidos automaticamente.'"></p></div><button class="mp-button" @click="mpNew()"><i data-lucide="plus"></i>Nova publicação</button></div>
    <div class="mp-history-filters"><label class="mp-search"><i data-lucide="search"></i><input type="search" placeholder="Buscar publicação" x-model="mpHistorySearch" aria-label="Buscar publicação"></label><select x-model="mpHistoryNetwork" aria-label="Filtrar por rede"><option value="all">Todas as redes</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select><button class="mp-button" @click="mpLoad()" :disabled="mpLoading"><i data-lucide="refresh-cw"></i>Atualizar</button></div>
    <div class="mp-post-list"><template x-for="post in mpFilteredPosts()" :key="post.id"><article class="mp-post-card">
      <div class="mp-card-heading"><div><h4 x-text="post.title"></h4><small class="mp-muted" x-text="mpDateLabel(post.scheduled_at||post.updated_at)"></small></div><span class="mp-badge" :class="'mp-state-'+post.status" x-text="mpStatus(post.status)"></span></div>
      <p class="mp-post-caption" x-text="post.caption"></p><small class="mp-muted" x-text="post.media_name||'Mídia ainda não selecionada'"></small>
      <div class="mp-deliveries"><template x-for="delivery in post.deliveries" :key="delivery.platform"><div><img :src="'/assets/brands/'+delivery.platform+'.svg'" :alt="delivery.platform"><span><strong x-text="delivery.platform==='instagram'?'Instagram':'Facebook'"></strong><small x-text="mpFormat(delivery.format)+' · '+mpStatus(delivery.status)"></small><small class="mp-error-text" x-show="delivery.error_code" x-text="delivery.status==='uncertain'?'Confira na rede antes de tentar outro envio.':mpErrorText({message:delivery.error_code})"></small></span><a class="mp-link" x-show="delivery.post_url" :href="delivery.post_url" target="_blank" rel="noopener noreferrer">Ver na rede ↗</a><button class="mp-link" x-show="delivery.status==='uncertain'" type="button" @click="mpOpenReconciliation(post,delivery)" :disabled="mpBusy">Registrar conferência</button></div></template></div>
      <div class="mp-actions"><button class="mp-button mp-primary" x-show="post.status==='draft'" @click="mpEdit(post)">Continuar edição →</button><button class="mp-button" x-show="post.status==='draft'" @click="mpAction(post,'cancel')" :disabled="mpBusy">Descartar rascunho</button><button class="mp-button" x-show="post.deliveries.some(d=>d.status==='failed')" @click="mpAction(post,'retry')" :disabled="mpBusy||!mpConfig?.sending">Repetir destinos com falha</button></div>
    </article></template></div>
    <div class="mp-empty" x-show="!mpFilteredPosts().length"><i data-lucide="file-text"></i><p x-text="mpTab==='drafts'?'Nenhum rascunho salvo.':'Nenhuma publicação neste filtro.'"></p></div>
    <p class="mp-muted">São exibidas as 200 publicações mais recentes criadas nesta Central. As métricas das suas redes ficam na aba Resultados.</p>
  </section>
  <template x-if="mpPreview"><div class="mp-modal-overlay" @click.self="mpPreview=null" @keydown.escape.window="mpPreview=null"><section class="mp-modal mp-media-modal" role="dialog" aria-modal="true" aria-label="Prévia da mídia"><div class="mp-card-heading"><h3 x-text="mpPreview.name"></h3><button class="mp-icon" @click="mpPreview=null" aria-label="Fechar prévia"><i data-lucide="x"></i></button></div><template x-if="mpPreview.kind==='video'"><video :src="mpPreview.url" controls playsinline preload="metadata"></video></template><template x-if="mpPreview.kind==='photo'"><img :src="mpPreview.url" :alt="mpPreview.name"></template><small class="mp-muted">Prévia do arquivo original. A rede pode adaptar a apresentação.</small></section></div></template>
</div>`;

window.MARKETING_PUBLISHER_CONNECTIONS_TEMPLATE = `
<template x-if="mpConnectionsOpen">
  <div class="mp-modal-overlay" @click.self="mpConnectionsOpen=false" @keydown.escape.window="mpConnectionsOpen=false">
    <section class="mp-modal" role="dialog" aria-modal="true" aria-label="Contas da Central">
      <div class="mp-card-heading">
        <h3>Contas da Central</h3>
        <button class="mp-icon" type="button" @click="mpConnectionsOpen=false" aria-label="Fechar contas"><i data-lucide="x"></i></button>
      </div>
      <p class="mp-muted">A Central usa as contas 2W Pneus já configuradas no Farejador.</p>
      <template x-for="account in mpConfig?.accounts||[]" :key="account.platform">
        <div class="mp-connection-row">
          <img :src="'/assets/brands/'+account.platform+'.svg'" :alt="account.platform">
          <span>
            <strong x-text="account.label"></strong>
            <small x-text="mpConnectionBusy?'Verificando…':mpConnectionLabel(account.platform)"></small>
            <small class="mp-error-text" x-show="mpConnectionError(account.platform)" x-text="mpConnectionError(account.platform)"></small>
            <small class="mp-error-text" x-show="mpMissingPermissions(account.platform)" x-text="'Permissões ausentes: '+mpMissingPermissions(account.platform)"></small>
          </span>
        </div>
      </template>
      <p>A conta e as permissões são conferidas antes do envio. Sem confirmação das permissões, o destino permanece bloqueado.</p>
      <p class="mp-muted">Configure o token e o bucket privado no servidor. Nenhuma chave secreta é enviada ao navegador.</p>
      <p class="mp-notice mp-error" role="alert" x-show="mpError" x-text="mpError"></p>
      <button class="mp-button mp-full" type="button" @click="mpCheckConnections()" :disabled="mpConnectionBusy">Verificar novamente</button>
    </section>
  </div>
</template>`;

window.MARKETING_PUBLISHER_RECONCILIATION_TEMPLATE = `
  <template x-if="mpReconciliation"><div class="mp-modal-overlay" @click.self="if(!mpBusy)mpReconciliation=null" @keydown.escape.window="if(!mpBusy)mpReconciliation=null">
    <section class="mp-modal" role="dialog" aria-modal="true" aria-label="Conferir publicação incerta">
      <div class="mp-card-heading"><h3>Conferir na rede</h3><button class="mp-icon" @click="mpReconciliation=null" :disabled="mpBusy" aria-label="Fechar conferência"><i data-lucide="x"></i></button></div>
      <p><strong x-text="mpReconciliation.title"></strong><br><span x-text="mpReconciliation.platform==='instagram'?'Instagram':'Facebook'"></span></p>
      <p class="mp-muted">Confira a conta na rede. Sua decisão será registrada. Um envio incerto não é repetido sem prova de que não foi publicado.</p>
      <label class="mp-label">Resultado da conferência<select x-model="mpReconciliation.decision" :disabled="mpBusy"><option value="published">Encontrei a publicação</option><option value="not_published">Não encontrei; verificar se pode reenviar</option><option value="abandon">Encerrar este destino sem reenviar</option></select></label>
      <label class="mp-label" x-show="mpReconciliation.decision==='published'">Link ou ID da publicação<input type="text" maxlength="2048" x-model="mpReconciliation.provider_id" :disabled="mpBusy" placeholder="Cole o link do post ou Reel"><small class="mp-muted">Cole o link permanente do post ou Reel, ou informe o ID da Meta. A Central verifica a publicação na conta conectada. Para Stories do Instagram, use o ID da Meta.</small></label>
      <label class="mp-label">Observação da conferência<textarea rows="3" minlength="10" maxlength="500" x-model="mpReconciliation.note" :disabled="mpBusy" placeholder="Descreva o que conferiu na conta (mínimo 10 caracteres)"></textarea></label>
      <label class="mp-cleanup"><input type="checkbox" x-model="mpReconciliation.confirmed" :disabled="mpBusy"><span>Confirmo que conferi esta conta e este conteúdo.</span></label>
      <p class="mp-notice mp-warning" x-show="mpReconciliation.decision==='abandon'">Encerra somente este destino e preserva a mídia. Isso não confirma que a publicação falhou; criar outra igual pode duplicar o post.</p>
      <p class="mp-notice mp-error" x-show="mpError" role="alert" x-text="mpError"></p>
      <button class="mp-button mp-primary mp-full" type="button" @click="mpReconcile()" :disabled="mpBusy||!mpReconciliation.confirmed||mpReconciliation.note.trim().length<10" x-text="mpBusy?'Conferindo…':'Registrar e verificar'"></button>
    </section>
  </div></template>
`;
