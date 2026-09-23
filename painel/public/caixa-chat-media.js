(function(){
  'use strict';
  const C=window.Caixa,ch=C.chat;
  let recorder=null,stream=null,timer=null,mediaVersion=0,requesting=false;
  ch.media=null;ch.recording=false;
  const input=document.createElement('input');input.type='file';input.hidden=true;input.accept='image/jpeg,image/png,image/webp,audio/*,video/mp4,application/pdf';document.body.append(input);
  ch.toBase64=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
  ch.resetMedia=function(){
    mediaVersion++;requesting=false;if(recorder&&recorder.state!=='inactive')recorder.stop();recorder=null;
    if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;clearInterval(timer);ch.recording=false;
    if(ch.media)URL.revokeObjectURL(ch.media.url);ch.media=null;ch.renderMedia();
  };
  ch.stopRecording=function(){if(recorder&&recorder.state!=='inactive')recorder.stop();};
  async function prepare(file,photoRequestId,version=mediaVersion){
    if(file.size>16*1024*1024)throw Error('chat_media_invalid');
    let blob=file,mime=file.type.split(';')[0];
    if(mime.startsWith('image/')){
      const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'}),scale=Math.min(1,1600/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
      blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('chat_media_invalid')),'image/jpeg',0.82));mime='image/jpeg';
    }
    if(!['image/jpeg','audio/webm','audio/ogg','audio/mp4','audio/mpeg','video/mp4','application/pdf'].includes(mime))throw Error('chat_media_invalid');
    if(version!==mediaVersion)return;
    if(ch.media)URL.revokeObjectURL(ch.media.url);
    ch.media={blob,mime,url:URL.createObjectURL(blob),photoRequestId};ch.renderMedia();
  }
  let selectedPhoto=null,selectedConversation=null;
  ch.el('attach').onclick=()=>{selectedPhoto=null;selectedConversation=ch.state.id;input.removeAttribute('capture');input.accept='image/jpeg,image/png,image/webp,audio/*,video/mp4,application/pdf';input.click();};
  ch.el('panel').addEventListener('click',event=>{
    const button=event.target.closest('[data-photo]');if(!button)return;
    selectedPhoto=button.dataset.photoId;selectedConversation=ch.state.id;input.accept='image/*';
    if(button.dataset.photo==='camera')input.setAttribute('capture','environment');else input.removeAttribute('capture');input.click();
  });
  input.onchange=async()=>{
    const file=input.files[0],id=ch.state.id,photo=selectedPhoto;input.value='';if(!file||id!==selectedConversation)return;
    ch.resetMedia();const version=mediaVersion;
    try{await prepare(file,photo,version);if(ch.state.id!==id||version!==mediaVersion)return;void ch.setControl(id,'takeover');}
    catch(error){C.showToast(ch.errorText(error));}
  };
  ch.renderMedia=function(){
    const box=ch.el('media-preview');if(!box)return;
    box.classList.toggle('hidden',!ch.media&&!ch.recording);
    ch.el('mic').classList.toggle('recording',ch.recording);
    ch.el('mic').setAttribute('aria-label',ch.recording?'Parar gravação':'Gravar áudio');
    if(ch.recording){box.innerHTML='<span class="chat-recording-dot"></span><strong>Gravando <time id="chat-record-time">0:00</time></strong><button id="chat-cancel-media">Cancelar</button>';}
    else if(ch.media){const m=ch.media;
      box.innerHTML=(m.mime.startsWith('audio/')?`<audio controls src="${m.url}"></audio>`:m.mime.startsWith('image/')?`<img src="${m.url}" alt="Prévia da foto a enviar">`:m.mime.startsWith('video/')?`<video controls src="${m.url}"></video>`:'<strong>PDF pronto para enviar</strong>')+'<button id="chat-cancel-media" aria-label="Descartar anexo">×</button>';
    }else box.replaceChildren();
    const cancel=ch.el('cancel-media');if(cancel)cancel.onclick=ch.resetMedia;
    ch.el('compose-hint').textContent=ch.recording?'Toque no microfone para parar. Limite: 2 minutos.':ch.media?.mime.startsWith('audio/')?'Ouça o áudio antes de enviar.':'Ao digitar, você assume o atendimento.';
  };
  ch.el('mic').onclick=async()=>{
    if(ch.recording){ch.stopRecording();return;}
    if(requesting)return;
    if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){C.showToast('Este navegador não permite gravar. Você pode anexar um áudio.');return;}
    const id=ch.state.id;ch.resetMedia();const version=mediaVersion;requesting=true;
    try{
      const capture=await navigator.mediaDevices.getUserMedia({audio:true});
      if(version!==mediaVersion||id!==ch.state.id||!ch.state.active){capture.getTracks().forEach(t=>t.stop());return;}
      stream=capture;requesting=false;
      const mime=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mime)throw Error('unsupported_audio');
      const current=new MediaRecorder(capture,{mimeType:mime}),chunks=[],startedAt=Date.now();recorder=current;
      current.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      current.onstop=async()=>{
        capture.getTracks().forEach(t=>t.stop());if(version!==mediaVersion)return;
        stream=null;recorder=null;clearInterval(timer);ch.recording=false;
        if(id===ch.state.id){try{await prepare(new Blob(chunks,{type:mime.split(';')[0]}),undefined,version);}catch(error){C.showToast(ch.errorText(error));}}
        ch.renderMedia();
      };
      recorder.start(1000);ch.recording=true;ch.renderMedia();void ch.setControl(id,'takeover');
      timer=setInterval(()=>{const seconds=Math.floor((Date.now()-startedAt)/1000);if(ch.el('record-time'))ch.el('record-time').textContent=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');if(seconds>=120)ch.stopRecording();},250);
    }catch(_){if(version!==mediaVersion)return;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;ch.recording=false;ch.renderMedia();C.showToast('Não consegui acessar o microfone. Confira a permissão do navegador.');}
    finally{if(version===mediaVersion)requesting=false;}
  };
}());
