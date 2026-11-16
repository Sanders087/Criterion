'use client';
import {useEffect,useRef,useState} from 'react';

// A short, skippable entrance. No network, storage or animation dependencies.
export function CriterionIntro(){
 const canvas=useRef<HTMLCanvasElement>(null);
 const [visible,setVisible]=useState(false);
 const [preview,setPreview]=useState(false);
 useEffect(()=>{
  if(location.pathname!=='/'||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  setPreview(process.env.NODE_ENV==='development'&&new URLSearchParams(location.search).get('intro')==='preview');
  setVisible(true);
 },[]);
 useEffect(()=>{
  if(!visible)return;
  const el=canvas.current,ctx=el?.getContext('2d');
  if(!el||!ctx){setVisible(false);return;}
  let frame=0,disposed=false,start=0;
  const close=()=>setVisible(false);
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape')close();};
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const motion=()=>{if(reduced.matches)close();};
  const shell=document.querySelector<HTMLElement>('.shell'),previousFocus=document.activeElement;
  const oldInert=shell?.inert??false;if(shell)shell.inert=true;
  const oldOverflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  window.addEventListener('keydown',key);reduced.addEventListener('change',motion);
  const deadline=preview?undefined:setTimeout(close,4800);
  const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio||1,2);
  el.width=w*dpr;el.height=h*dpr;ctx.scale(dpr,dpr);
  const mask=document.createElement('canvas');mask.width=900;mask.height=180;
  const m=mask.getContext('2d');if(!m){close();return;}
  m.strokeStyle='#73baff';m.lineWidth=2.3;
  m.save();m.translate(5,25);m.scale(3,3);
  m.stroke(new Path2D('M28 10a14 14 0 1 0 0 20M11 16h20M11 24h20'));m.restore();
  m.fillStyle='white';m.font='600 102px "Jost", "Segoe UI", sans-serif';
  m.fillText('CRITERION',145,128);const end=145+m.measureText('CRITERION').width;m.fillStyle='#6fb6ff';m.beginPath();m.arc(end+17,120,7,0,Math.PI*2);m.fill();
  const pixels=m.getImageData(0,0,900,180).data;
  const logoWidth=end+35;
  const scale=Math.min((w-48)/logoWidth,.92),left=(w-logoWidth*scale)/2,top=h*.46-90*scale;
  const points:{x:number;y:number;sx:number;sy:number;delay:number;r:number}[]=[];
  for(let y=0;y<180;y+=4)for(let x=0;x<900;x+=4){if(pixels[(y*900+x)*4+3]>120){
   const angle=Math.random()*Math.PI*2,radius=Math.max(w,h)*(.3+Math.random()*.5);
   points.push({x:left+x*scale,y:top+y*scale,sx:w/2+Math.cos(angle)*radius,sy:h*.46+Math.sin(angle)*radius,delay:Math.random()*.45,r:Math.max(.65,scale*1.25)});
  }}
  function draw(now:number){
   if(disposed||!ctx||!el)return;if(!start)start=now;
   const t=(now-start)/1000;
   ctx.clearRect(0,0,w,h);
   const fade=!preview&&t>3.1?Math.max(0,1-(t-3.1)/.65):1;
   ctx.globalAlpha=fade;
   for(const p of points){
    const progress=Math.min(1,Math.max(0,(t-p.delay)/2.05));
    const ease=1-Math.pow(1-progress,4);
    const x=p.sx+(p.x-p.sx)*ease,y=p.sy+(p.y-p.sy)*ease;
    ctx.fillStyle=p.x<left+130*scale?'#73baff':'#d3e8ff';
    ctx.globalAlpha=fade*(.35+.65*ease);
    ctx.beginPath();ctx.arc(x,y,p.r,0,Math.PI*2);ctx.fill();
   }
   ctx.globalAlpha=fade*Math.min(1,Math.max(0,(t-2.3)/.45));
   ctx.shadowColor='#6fb6ff';ctx.shadowBlur=12;ctx.drawImage(mask,left,top,900*scale,180*scale);ctx.shadowBlur=0;
   if(t>=3.75){if(!preview)close();return;}frame=requestAnimationFrame(draw);
  }
  frame=requestAnimationFrame(draw);
  return()=>{disposed=true;cancelAnimationFrame(frame);clearTimeout(deadline);window.removeEventListener('keydown',key);reduced.removeEventListener('change',motion);document.body.style.overflow=oldOverflow;if(shell)shell.inert=oldInert;if(previousFocus instanceof HTMLElement&&previousFocus!==document.body)previousFocus.focus({preventScroll:true});};
 },[visible,preview]);
 if(!visible)return null;
 return <div className="criterion-intro" data-preview={preview||undefined} aria-label="Заставка Criterion"><div className="intro-grid"/><canvas ref={canvas} aria-hidden="true"/><div className="intro-caption"><span>ИЗ РАЗГОВОРА — ДОГОВОР</span><i/></div><button className="intro-skip" autoFocus onClick={()=>setVisible(false)}>Перейти к работе <span aria-hidden="true">↗</span></button></div>;
}
