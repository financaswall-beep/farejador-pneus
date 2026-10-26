(function(){
  'use strict';
  const C=window.Caixa,skin=C?.chatMetal;if(!skin)return;
  const ch=C.chat,s=ch.state,chooser=skin.dialog('Anexar arquivo'),preview=skin.dialog('Conferir anexo');
  chooser.id='cm-chat-attachments';preview.id='cm-chat-preview';
  let starting=false,disposePlayer=null;
  const recipient=()=>{const row=s.detail||s.rows.find(r=>r.id===s.id);return 'Para '+(row?.name||'o cliente');};
  function close(dialog){if(dialog.open)dialog.close();}
  const reset=ch.resetMedia;ch.resetMedia=function(){close(chooser);reset();};
  function discard(){starting=false;ch.resetMedia();close(preview);}
  const oldAttach=ch.el('attach').onclick,oldMic=ch.el('mic').onclick;
  function choose(kind){close(chooser);ch.chooseMedia(kind);}
  function openChooser(){chooser.replaceChildren(skin.header('Anexar arquivo',()=>close(chooser),recipient()));const content=document.createElement('div');content.className='cm-media-content';const menu=document.createElement('div');menu.className='cm-attachment-menu';
    [['camera','camera','Fotografar agora','Tire uma foto na hora.'],['gallery','photo','Foto ou vídeo da galeria','Escolha um arquivo da galeria.'],['audio','mic','Arquivo de áudio','Envie um áudio gravado.'],['pdf','paperclip','Documento PDF','Envie um arquivo em PDF.']].forEach(([kind,icon,label,help])=>{const b=skin.button('',()=>choose(kind),true);b.className='cm-attachment-option';const copy=document.createElement('span'),strong=document.createElement('strong'),small=document.createElement('small');strong.textContent=label;small.textContent=help;copy.append(strong,small);b.innerHTML=ch.icon(icon);b.append(copy);const arrow=document.createElement('span');arrow.textContent='›';arrow.className='cm-choice-arrow';b.appendChild(arrow);menu.appendChild(b);});content.append(menu,skin.button('Cancelar',()=>close(chooser),true));chooser.appendChild(content);chooser.showModal();}
  ch.el('attach').onclick=()=>{if(!skin.active())return oldAttach();if(s.id&&s.detail)openChooser();};
  async function startRecording(){
    if(starting||s.sending)return;starting=true;render();
    try{await oldMic();}finally{starting=false;if(skin.active())render();}
  }
  ch.el('mic').onclick=()=>{if(!skin.active())return oldMic();if(ch.recording)return ch.stopRecording();if(s.id&&s.detail)void startRecording();};
  function box(){const element=document.createElement('section');element.className='cm-media-card';return element;}
  function paragraph(text,className){const p=document.createElement('p');p.textContent=text;if(className)p.className=className;return p;}
  function render(){
    disposePlayer?.();disposePlayer=null;
    if(!skin.active()||(!starting&&!ch.recording&&!ch.media)){skin.audio?.stopLive();close(preview);return;}
    const media=ch.media,isAudio=media?.mime.startsWith('audio/'),isImage=media?.mime.startsWith('image/'),recording=starting||ch.recording;
    const clock=ch.el('record-time');
    const title=recording?'Gravar áudio':isAudio?'Conferir áudio':isImage?'Prévia da foto':'Conferir anexo';
    preview.replaceChildren(skin.header(title,discard,recipient()));const content=document.createElement('div');content.className='cm-media-content';
    if(recording){
      const state=s.detail?.mode==='human'?'Atendimento humano · bot pausado':'Preparando atendimento';content.appendChild(paragraph(state,'cm-record-owner'));
      const card=box(),label=document.createElement('strong');label.className='cm-record-label';label.textContent=ch.recording?'● Gravando':'Preparando microfone…';card.appendChild(label);
      if(ch.recording){if(clock){clock.className='cm-record-time';card.appendChild(clock);}const canvas=document.createElement('canvas');canvas.className='cm-record-wave';canvas.setAttribute('aria-hidden','true');card.append(canvas,paragraph('Até 2 minutos.'));requestAnimationFrame(()=>skin.audio?.drawLive(canvas));}
      content.appendChild(card);if(ch.recording)content.appendChild(skin.button('■ Parar gravação',()=>ch.stopRecording(),true));content.appendChild(skin.button('Descartar',discard,true));
    }else if(media){
      skin.audio?.stopLive();
      const card=box();
      if(isImage){const image=document.createElement('img');image.src=media.url;image.alt='Prévia da foto a enviar';image.className='cm-media-photo';card.appendChild(image);}
      else if(isAudio){const h=document.createElement('h3');h.textContent='Áudio gravado';card.appendChild(h);disposePlayer=skin.audio?.player(card,media);}
      else if(media.mime.startsWith('video/')){const video=document.createElement('video');video.controls=true;video.src=media.url;video.className='cm-media-video';card.appendChild(video);}
      else card.appendChild(paragraph('Documento PDF pronto para enviar.'));
      content.appendChild(card);
      if(isAudio)content.appendChild(paragraph('Ouça antes de enviar.','cm-media-hint'));
      else{const label=document.createElement('label');label.className='cm-media-caption';label.textContent='Legenda (opcional)';const field=document.createElement('textarea');field.id='cm-chat-caption';field.rows=2;field.maxLength=4000;field.value=ch.el('input').value;field.oninput=()=>{ch.el('input').value=field.value;ch.el('input').dispatchEvent(new Event('input',{bubbles:true}));};label.appendChild(field);content.appendChild(label);}
      const actions=document.createElement('footer');actions.className='cm-sheet-actions'+(isImage?' cm-photo-actions':'');const send=skin.button(isImage?'Enviar foto':isAudio?'Enviar áudio':'Enviar anexo',()=>void ch.send());send.prepend(C.createSvg([{d:'m3 3 18 9-18 9 4-9-4-9Zm4 9h14'}]));send.id='cm-chat-send-media';send.disabled=s.sending;
      actions.append(send);if(isAudio)actions.appendChild(skin.button('Gravar novamente',()=>void startRecording(),true));else if(isImage)actions.appendChild(skin.button('Trocar foto',()=>ch.chooseMedia('image',media.photoRequestId),true));
      const cancel=skin.button('Descartar',discard,true);cancel.className='cm-discard';actions.appendChild(cancel);content.appendChild(actions);
    }
    preview.appendChild(content);if(!preview.open)preview.showModal();
  }
  const oldRender=ch.renderMedia;ch.renderMedia=function(){oldRender();render();};
  preview.addEventListener('cancel',event=>{event.preventDefault();discard();});
  skin.media={leave:()=>{starting=false;disposePlayer?.();disposePlayer=null;skin.audio?.stopLive();close(chooser);close(preview);}};
}());
