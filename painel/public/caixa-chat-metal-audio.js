(function(){
  'use strict';
  const C=window.Caixa,skin=C?.chatMetal;if(!skin)return;
  const ch=C.chat,AudioContext=window.AudioContext||window.webkitAudioContext;
  let live=null,frame=0;
  const time=value=>{const seconds=Math.max(0,Math.floor(Number(value)||0));return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');};
  function bars(canvas,values,progress=1){
    const width=Math.max(200,canvas.clientWidth||300),height=75,ratio=window.devicePixelRatio||1;
    canvas.width=width*ratio;canvas.height=height*ratio;
    const ctx=canvas.getContext('2d');if(!ctx)return;ctx.scale(ratio,ratio);ctx.clearRect(0,0,width,height);
    const count=values.length,step=width/count;
    values.forEach((value,i)=>{const h=Math.max(4,Math.min(65,value*65));ctx.fillStyle=i/count<=progress?'#075e3c':'#8ca99a';ctx.beginPath();if(ctx.roundRect)ctx.roundRect(i*step+1,(height-h)/2,Math.max(2,step-3),h,3);else ctx.rect(i*step+1,(height-h)/2,Math.max(2,step-3),h);ctx.fill();});
  }
  function stopLive(){cancelAnimationFrame(frame);frame=0;if(live){void live.context.close().catch(()=>{});live=null;}}
  ch.observeRecording=function(stream){
    if(!skin.active()||!AudioContext)return;stopLive();
    try{const context=new AudioContext(),source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=512;source.connect(analyser);live={context,analyser};void context.resume().catch(()=>{});}catch(_){stopLive();}
  };
  function drawLive(canvas){
    cancelAnimationFrame(frame);
    function draw(){
      if(!ch.recording||!canvas.isConnected){frame=0;return;}
      const values=Array(40).fill(0);
      if(live){const data=new Uint8Array(live.analyser.fftSize);live.analyser.getByteTimeDomainData(data);for(let i=0;i<40;i++){const start=Math.floor(i*data.length/40),end=Math.floor((i+1)*data.length/40);let peak=0;for(let j=start;j<end;j++)peak=Math.max(peak,Math.abs(data[j]-128)/128);values[i]=peak;}}
      bars(canvas,values);frame=requestAnimationFrame(draw);
    }draw();
  }
  function player(container,media){
    let disposed=false,points=Array(48).fill(0),duration=Number(media.durationSeconds)||0,decodeContext=null;
    const audio=document.createElement('audio');audio.src=media.url;audio.preload='metadata';
    const row=document.createElement('div');row.className='cm-audio-player';
    const play=skin.button('▶',async()=>{try{if(audio.paused)await audio.play();else audio.pause();}catch(_){if(disposed)return;audio.controls=true;container.appendChild(audio);C.showToast('Use o controle de áudio para ouvir a gravação.');}});play.className='cm-audio-play';play.setAttribute('aria-label','Ouvir áudio');
    const copy=document.createElement('div'),canvas=document.createElement('canvas');canvas.className='cm-audio-wave';canvas.setAttribute('aria-hidden','true');
    const seek=document.createElement('input');seek.type='range';seek.min='0';seek.step='.1';seek.max=String(duration||1);seek.value='0';seek.disabled=!duration;seek.setAttribute('aria-label','Posição do áudio');
    const stamp=document.createElement('span');stamp.className='cm-audio-position';
    function update(){if(disposed)return;if(Number.isFinite(audio.duration)&&audio.duration>0)duration=audio.duration;seek.max=String(duration||1);seek.disabled=!duration;seek.value=String(audio.currentTime||0);stamp.textContent=time(audio.currentTime)+' / '+time(duration);play.textContent=audio.paused?'▶':'Ⅱ';play.setAttribute('aria-label',audio.paused?'Ouvir áudio':'Pausar áudio');bars(canvas,points,duration?audio.currentTime/duration:0);}
    seek.oninput=()=>{if(duration)audio.currentTime=Number(seek.value);};
    ['loadedmetadata','durationchange','timeupdate','play','pause','ended'].forEach(event=>audio.addEventListener(event,update));
    copy.append(canvas,seek,stamp);row.append(play,copy);container.appendChild(row);requestAnimationFrame(update);
    if(AudioContext){try{decodeContext=new AudioContext();void media.blob.arrayBuffer().then(data=>decodeContext.decodeAudioData(data)).then(buffer=>{
      if(disposed)return;duration=buffer.duration;const data=buffer.getChannelData(0),step=Math.max(1,Math.floor(data.length/48));points=Array.from({length:48},(_,i)=>{let peak=0;for(let j=i*step;j<Math.min(data.length,(i+1)*step);j+=Math.max(1,Math.floor(step/200)))peak=Math.max(peak,Math.abs(data[j]));return peak;});update();
    }).catch(()=>{}).finally(()=>{void decodeContext.close().catch(()=>{});});}catch(_){/* O controle nativo continua disponível. */}}
    return ()=>{disposed=true;audio.pause();audio.removeAttribute('src');audio.load();};
  }
  skin.audio={stopLive,drawLive,player};
}());
