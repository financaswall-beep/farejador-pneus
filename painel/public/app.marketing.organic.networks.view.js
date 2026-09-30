window.MARKETING_ORGANIC_NETWORKS_TEMPLATE = `
<section class="mor-network-section" x-effect="if(moAnalysisTab==='metrics' && moSelected?.key) morLoadMetrics()">
  <div class="mor-section-heading"><div><h3>Desempenho por rede</h3><p>Contadores acumulados da publicação. Podem incluir impulsionamento.</p></div><button class="mor-link" type="button" @click="morLoadMetrics(true)" :disabled="moInsightsLoading"><i data-lucide="refresh-cw"></i>Atualizar métricas</button></div>
  <p x-show="moInsightsLoading" role="status">Consultando as redes…</p><p class="mo-notice" x-show="moInsightsError" role="alert" x-text="moInsightsError"></p>
  <div class="mor-network-grid">
    <template x-for="network in morNetworkCards()" :key="network.platform">
      <article class="mor-network-card" :style="'--network-color:'+morColor(network.platform)">
        <header><span class="mor-network-name"><template x-if="morBrand(network.platform)"><img :src="morBrand(network.platform)" alt=""></template><strong x-text="moNetworkLabel(network.platform)"></strong></span><span class="mo-badge" x-text="mpStatus(network.status)"></span></header>
        <strong class="mor-network-views" x-text="moSummaryNumber(network.views)"></strong><span class="mor-network-caption">visualizações acumuladas</span>
        <p class="mor-network-warning" x-show="network.error">Não foi possível consultar esta rede. Atualize para tentar novamente.</p>
        <p class="mor-network-warning" x-show="network.insights?.notice" x-text="network.insights?.notice"></p>
        <p class="mor-network-warning" x-show="!network.insights && !network.error">As métricas estarão disponíveis quando a rede confirmar a publicação.</p>
        <dl class="mor-network-metrics"><template x-for="metric in (network.insights?.rows || []).filter(r=>!['views','post_media_view'].includes(r.metric))" :key="metric.metric"><div><dt x-text="metric.label"></dt><dd :title="metric.value==null ? metric.message : ''" x-text="metric.value==null?'—':moSummaryNumber(metric.value)"></dd></div></template></dl>
        <small x-show="network.observed_at" x-text="'Consulta: '+moDate(network.observed_at,true)"></small>
        <a class="mor-link" x-show="moSafeSocialUrl(network.post_url)" :href="moSafeSocialUrl(network.post_url)" target="_blank" rel="noopener noreferrer" x-text="'Ver no '+moNetworkLabel(network.platform)+' ↗'"></a>
      </article>
    </template>
  </div>
  <p class="mor-card-subtitle">— indica dado indisponível. Alcance e visualizações têm definições próprias em cada rede e não representam pessoas únicas somadas.</p>
  <section class="mor-card mor-history-card">
    <div class="mor-section-heading"><div><h3>Evolução das visualizações</h3><p>Acumulado observado nas coletas; separado do período comercial acima.</p></div><select class="mo-input" aria-label="Período do histórico de visualizações" x-model="morDays" @change="morLoadMetrics()"><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option></select></div>
    <div class="mor-views-chart" x-show="morHasHistory()"><canvas x-ref="morViewsChart" role="img" aria-label="Evolução das visualizações acumuladas por rede"></canvas></div>
    <p class="mor-chart-empty" x-show="!morHasHistory()">Ainda não há coletas para mostrar neste período.</p>
    <p class="mor-info" role="status" x-text="morHistoryNotice()"></p>
    <details class="mor-history-data" x-show="morHasHistory()"><summary>Ver valores do gráfico</summary><div class="mor-history-scroll"><table><thead><tr><th>Data</th><template x-for="series in morHistorySeries()" :key="series.platform"><th x-text="moNetworkLabel(series.platform)"></th></template></tr></thead><tbody><template x-for="(date,index) in morHistoryDates()" :key="date"><tr><td x-text="moDate(date+'T12:00:00Z')"></td><template x-for="series in morHistorySeries()" :key="series.platform"><td x-text="moSummaryNumber(series.points[index])"></td></template></tr></template></tbody></table></div></details>
  </section>
</section>`;

window.MARKETING_ORGANIC_CONTENT_TEMPLATE = `
<div x-show="moSelected?.key && !moDetailLoading" class="mor-content-context">
  <article class="mor-content-strip">
    <span class="mor-post-thumb"><template x-if="moSelected?.image_url"><img :src="moSelected.image_url" alt="Prévia do conteúdo" referrerpolicy="no-referrer" @error="moImageFailed(moSelected)"></template><template x-if="!moSelected?.image_url"><i data-lucide="image"></i></template></span>
    <div class="mor-content-copy"><h3 x-text="moSelected?.title"></h3><p x-text="moDate(moSelected?.published_at,true)"></p><div class="mor-network-icons"><template x-for="delivery in morDeliveries()" :key="delivery.platform"><span :title="moNetworkLabel(delivery.platform)"><template x-if="morBrand(delivery.platform)"><img :src="morBrand(delivery.platform)" :alt="moNetworkLabel(delivery.platform)"></template><template x-if="!morBrand(delivery.platform)"><b x-text="moNetworkLabel(delivery.platform)"></b></template></span></template></div></div>
    <span class="mp-badge" :class="'mp-state-'+moSelected?.status" x-text="morStatus(moSelected)"></span>
    <button class="mor-link" type="button" x-show="moSelected?.publisher_id" @click="morSendingOpen=!morSendingOpen" :aria-expanded="morSendingOpen">Detalhes do envio<i data-lucide="chevron-down"></i></button>
  </article>
  <nav class="mor-network-chips" aria-label="Rede analisada" x-show="moAnalysisTab!=='compare'">
    <button type="button" :aria-pressed="morNetwork==='all'" @click="morChooseNetwork('all')" :disabled="moDetailLoading">Todas as redes</button>
    <template x-for="platform in morNetworks()" :key="platform"><button type="button" :aria-pressed="morNetwork===platform" @click="morChooseNetwork(platform)" :disabled="moDetailLoading"><template x-if="morBrand(platform)"><img :src="morBrand(platform)" alt=""></template><span x-text="moNetworkLabel(platform)"></span></button></template>
  </nav>
  <section class="mor-sending-details" x-show="morSendingOpen">
    <p>Destinos publicados ou incertos não são reenviados automaticamente.</p>
    <template x-for="delivery in morDeliveries()" :key="delivery.platform"><article><div><strong x-text="moNetworkLabel(delivery.platform)"></strong><span x-text="mpFormat(delivery.format)+' · '+mpStatus(delivery.status)"></span><small x-show="delivery.error_code" x-text="mpErrorText({message:delivery.error_code})"></small></div><a class="mor-link" x-show="moSafeSocialUrl(delivery.post_url)" :href="moSafeSocialUrl(delivery.post_url)" target="_blank" rel="noopener noreferrer">Ver na rede ↗</a><button type="button" class="mo-button" x-show="delivery.status==='uncertain'" @click="mpOpenReconciliation(morPublisherPost(),delivery)" :disabled="mpBusy">Conferir na rede</button></article></template>
    <button type="button" class="mo-button" x-show="morDeliveries().some(d=>d.status==='failed')" @click="morRetry()" :disabled="mpBusy || !moData?.sending_enabled">Repetir somente destinos com falha</button>
    <p class="mo-notice" x-show="mpError" role="alert" x-text="mpError"></p><p class="mor-info" x-show="mpMessage" role="status" x-text="mpMessage"></p>
  </section>
</div>`;
