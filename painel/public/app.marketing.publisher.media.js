window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingPublisherMedia = function () {
  return {
    mpUploadBusy:false, mpUploadName:'',
    async mpFileMetadata(file) {
      const url=URL.createObjectURL(file);const video=file.type.startsWith('video/');
      const element=document.createElement(video?'video':'img');
      try {
        await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(new Error('publisher_media_invalid')),20000);
          element.onerror=()=>{clearTimeout(timeout);reject(new Error('publisher_media_invalid'));};
          element[video?'onloadeddata':'onload']=()=>{clearTimeout(timeout);resolve();};
          if(video){element.preload='auto';element.muted=true;element.playsInline=true;}
          element.src=url;
        });
        const width=video?element.videoWidth:element.naturalWidth;const height=video?element.videoHeight:element.naturalHeight;
        if(!width||!height || video&&!Number.isFinite(element.duration))throw new Error('publisher_media_invalid');
        const canvas=document.createElement('canvas');const scale=Math.min(1,320/Math.max(width,height));
        canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
        canvas.getContext('2d').drawImage(element,0,0,canvas.width,canvas.height);
        return {width,height,duration:video?element.duration:null,...(video?{thumbnail:canvas.toDataURL('image/jpeg',0.75)}:{})};
      }finally{if(video){element.pause();element.removeAttribute('src');element.load();}URL.revokeObjectURL(url);}
    },
    mpDirectUpload(url,file) {
      return new Promise((resolve,reject)=>{
        const xhr=new XMLHttpRequest();xhr.open('PUT',url);xhr.timeout=30*60*1000;
        xhr.setRequestHeader('Content-Type',file.type);xhr.setRequestHeader('x-upsert','false');
        xhr.upload.onprogress=event=>{if(event.lengthComputable)this.mpUploadProgress=Math.round(100*event.loaded/event.total);};
        xhr.onerror=xhr.ontimeout=xhr.onabort=()=>reject(new Error('publisher_upload_failed'));
        xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error('publisher_upload_failed'));
        xhr.send(file);
      });
    },
    async mpUploadFiles(event) {
      const files=Array.from(event.target?.files||event.dataTransfer?.files||[]);if(event.target?.value)event.target.value='';
      if(this.mpUploadBusy||!this.mpConfig?.enabled||!this.mpConfig?.storage_ready)return;
      if(this.marketingIsMock?.()){this.mpError='O envio de arquivos não está disponível no modo demonstrativo.';return;}
      this.mpUploadBusy=true;this.mpError='';let completed=0;
      try {
        for(const file of files) {
          if(!['image/jpeg','image/png','image/webp','video/mp4','video/quicktime'].includes(file.type))throw new Error('publisher_media_invalid');
          if(file.size>(file.type.startsWith('image/')?8*1024*1024:this.mpConfig.max_file_bytes))throw new Error('publisher_media_too_large');
          this.mpUploadName=file.name;this.mpUploadProgress=0;
          const metadata=await this.mpFileMetadata(file);const id=crypto.randomUUID();
          const reserved=await this.apiPost('/admin/api/marketing/publisher/media',{id,name:file.name,mime:file.type,bytes:file.size});
          await this.mpDirectUpload(reserved.upload_url,file);
          await this.apiPost('/admin/api/marketing/publisher/media/'+id+'/complete',metadata);
          await this.mpLoad(true);const media=this.mpMedia.find(m=>m.id===id);if(media)this.mpSelectMedia(media);completed++;
        }
        if(completed)this.mpMessage=completed+' arquivo(s) enviado(s).';
      }catch(error){this.mpError=this.mpErrorText(error);}
      finally{this.mpUploadBusy=false;this.mpUploadProgress=null;this.mpUploadName='';}
    },
    async mpRemoveMedia(media) {
      if(this.mpBusy||this.mpUploadBusy || !window.confirm('Remover '+media.name+' da biblioteca?'))return;
      if(this.marketingIsMock?.()){this.mpError='A remoção não está disponível no modo demonstrativo.';return;}
      this.mpBusy=true;this.mpError='';
      try {
        await this.apiPost('/admin/api/marketing/publisher/media/'+media.id+'/remove',{});
        if(this.mpForm?.media_id===media.id){this.mpForm.media_id=null;this.mpDirty=true;}
        await this.mpLoad(true);
      }catch(error){this.mpError=this.mpErrorText(error);}finally{this.mpBusy=false;}
    },
    async mpOpenPreview(media) {
      if(!media)return;
      this.mpError='';
      if(this.marketingIsMock?.()){this.mpPreview={...media,url:media.thumbnail_url};return;}
      try{const result=await this.apiPost('/admin/api/marketing/publisher/media/'+media.id+'/preview',{});this.mpPreview={...media,url:result.url};}
      catch(error){this.mpError=this.mpErrorText(error);}
    },
  };
};
