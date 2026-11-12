// Server uji: sajikan web/ + meniru Edge Function (/api) ke Postgres lokal lewat psql.
const http=require('http'),fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
const root=path.join(__dirname,'..','web');let lastOtp={};
const mime={'.html':'text/html','.js':'text/javascript','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
http.createServer((req,res)=>{
  if(req.url==='/__otp'){res.end(JSON.stringify(lastOtp));return;}
  if(req.url==='/api'&&req.method==='POST'){let b='';req.on('data',d=>b+=d);req.on('end',()=>{
    try{const [a,t,p]=JSON.parse(b);
      const out=execFileSync('psql',['-tAq','-v','ON_ERROR_STOP=1','-c',"select public.ls_api($1,$2,$3,$4)".replace(/\$(\d)/g,(m,i)=>"'"+[a,t||'',JSON.stringify(p||{}),'{"wa":true}'][i-1].replace(/'/g,"''")+"'")+'::text'.slice(0,0)],{env:{...process.env,PGHOST:'/tmp',PGPORT:'5433',PGUSER:'postgres',PGDATABASE:'ls'}}).toString().trim();
      const j=JSON.parse(out);if(j.data&&j.data._send){lastOtp={phone:j.data._send.phone,code:j.data._send.debug_code};delete j.data._send;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify(j));
    }catch(e){res.statusCode=200;res.end(JSON.stringify({ok:false,error:'devserver: '+String(e.message).slice(0,200)}));}});return;}
  let f=path.join(root,req.url.split('?')[0]);if(f.endsWith('/'))f+='index.html';
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f=path.join(root,'index.html');
  res.setHeader('content-type',mime[path.extname(f)]||'application/octet-stream');res.end(fs.readFileSync(f));
}).listen(8099,()=>console.log('ok'));
