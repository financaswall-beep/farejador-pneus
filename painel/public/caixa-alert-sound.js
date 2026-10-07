(function () {
  'use strict';
  const C = window.Caixa;
  let audio = null, context = null, mediaReady = false, attempting = false;
  let pending = false, pendingAt = 0, generation = 0;
  const enabled = () => localStorage.getItem(C.keys.notifications) !== 'false';
  function recent() { return pending && Date.now() - pendingAt < 60000; }
  function ensureAudio() {
    if (!audio) { audio = new Audio('/operacao/som-pedido-novo.mp3'); audio.preload = 'auto'; }
    return audio;
  }
  function resumeContext() {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!context && Context) context = new Context();
      if (context && context.state !== 'running') return Promise.resolve(context.resume()).catch(() => {});
    } catch (_) { /* a tentativa pelo arquivo de áudio permanece disponível */ }
    return Promise.resolve();
  }
  function synthBeep() {
    if (!context || context.state !== 'running') return false;
    try {
      [880, 1320].forEach(function (frequency, index) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        const start = context.currentTime + index * 0.22;
        oscillator.frequency.value = frequency; oscillator.type = 'square';
        gain.gain.setValueAtTime(0.18, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start); oscillator.stop(start + 0.22);
      });
      return true;
    } catch (_) { return false; }
  }
  function play(resumed = Promise.resolve()) {
    if (!enabled() || !recent() || attempting) return;
    attempting = true;
    const current = generation;
    let played;
    try { const player = ensureAudio(); player.muted = false; player.currentTime = 0; played = player.play(); }
    catch (_) { played = Promise.reject(new Error('audio_blocked')); }
    Promise.resolve(played).then(function () {
      if (current !== generation) return;
      mediaReady = true; pending = false;
    }).catch(async function () {
      if (current !== generation) return;
      mediaReady = false;
      await resumed;
      if (current === generation && enabled() && recent() && synthBeep()) pending = false;
    }).finally(function () { if (current === generation) attempting = false; });
  }
  function prime() {
    if (mediaReady || attempting) return;
    attempting = true;
    const current = generation;
    let played;
    try { const player = ensureAudio(); player.muted = true; played = player.play(); }
    catch (_) { played = Promise.reject(new Error('audio_blocked')); }
    Promise.resolve(played).then(function () {
      if (current !== generation) return;
      audio.pause(); audio.currentTime = 0; mediaReady = true;
    }).catch(function () { if (current === generation) mediaReady = false; })
      .finally(function () {
        if (current !== generation) return;
        if (audio) audio.muted = false;
        attempting = false;
        if (recent()) play();
      });
  }
  function gesture(event) {
    if (!enabled() || event?.isTrusted === false) return;
    // A chamada a play/resume precisa ocorrer dentro do gesto, especialmente no iOS.
    const resumed = resumeContext();
    if (recent()) play(resumed); else { pending = false; prime(); }
  }
  function alert() {
    if (!enabled()) return;
    pending = true; pendingAt = Date.now();
    if (mediaReady || context?.state === 'running') play();
  }
  function clear() {
    generation++; pending = false; attempting = false;
    if (audio) { audio.pause(); audio.muted = false; }
  }
  C.playPartnerAlert = alert;
  C.clearPartnerAlert = clear;
  C.setPhotoSoundEnabled = function (value) { if (value) gesture(); else clear(); };
  // Não usa once: uma rejeição mantém a possibilidade de tentar no próximo toque.
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach(function (type) {
    document.addEventListener(type, gesture, { passive: true });
  });
}());
