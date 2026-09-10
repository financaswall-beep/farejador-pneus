// Primitivas vetoriais compartilhadas pelos relatórios. Sem serviço externo.
window.REPORT_PDF = (()=>{
  const clean=value=>String(value??'').replace(/[–—]/g,'-').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[·•]/g,' / ').replace(/[^\x20-\xFF]/g,' ');
  const escaped=value=>clean(value).replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
  const fit=(value,n)=>clean(value).length>n?clean(value).slice(0,n-3)+'...':clean(value);
  const text=(value,x,y,size=9,bold=false,color='0.08 0.14 0.20')=>`${color} rg BT /F${bold?2:1} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escaped(value)}) Tj ET\n`;
  const rect=(x,y,w,h,color)=>`${color} rg ${x} ${y} ${w} ${h} re f\n`;
  const rule=(y)=>`0.86 0.90 0.91 RG 0.5 w 30 ${y} m 812 ${y} l S\n`;
  const green='0.00 0.33 0.27',muted='0.36 0.43 0.49';
  const wrap=(value,n=100)=>{const words=clean(value).split(' ').flatMap(word=>word.match(new RegExp('.{1,'+n+'}','g'))||[]),rows=[''];for(const word of words){if(rows.at(-1).length+word.length+1>n)rows.push('');rows[rows.length-1]+=(rows.at(-1)?' ':'')+word;}return rows;};
  function build(contents) {
    const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
    const pages=[];
    for(const content of contents){const page=objects.length;pages.push(page);objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${page+1} 0 R >>`);objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);}
    objects[2]=`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(id=>id+' 0 R').join(' ')}] >>`;
    let pdf='%PDF-1.4\n',offsets=[0];
    for(let id=1;id<objects.length;id++){offsets[id]=pdf.length;pdf+=`${id} 0 obj\n${objects[id]}\nendobj\n`;}
    const xref=pdf.length;pdf+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for(let id=1;id<objects.length;id++)pdf+=`${String(offsets[id]).padStart(10,'0')} 00000 n \n`;
    pdf+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Uint8Array.from(pdf,c=>c.charCodeAt(0)&255);
  }
  return {clean,escaped,fit,text,rect,rule,green,muted,wrap,build};
})();
