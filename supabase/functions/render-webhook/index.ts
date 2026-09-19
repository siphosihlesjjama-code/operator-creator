import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
const now=()=>new Date().toISOString();
const statusMap=(s:string)=>["queued","fetching","preprocessing"].includes(s)?"QUEUED":["rendering","generating","saving"].includes(s)?"PROCESSING":s==="done"?"COMPLETED":s==="failed"?"FAILED":"PROCESSING";

async function provider(url:string,key:string){
 const c=new AbortController();const t=setTimeout(()=>c.abort(),60000);
 try{const r=await fetch(url,{signal:c.signal,headers:{"Accept":"application/json","x-api-key":key}});const data=await r.json().catch(()=>({}));return {ok:r.ok,status:r.status,data};}
 catch(e:any){return {ok:false,status:0,data:{error:e?.name==="AbortError"?"TIMEOUT":String(e?.message||"NETWORK_ERROR")}}}
 finally{clearTimeout(t)}
}

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok");
 if(req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 const event=await req.json().catch(()=>null);
 if(!event||event.type!=="edit"||event.action!=="render"||!event.id)return json({error:"INVALID_CALLBACK"},400);
 const secretRaw=Deno.env.get("SUPABASE_SECRET_KEYS");const secret=secretRaw?JSON.parse(secretRaw).default:Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
 const url=Deno.env.get("SUPABASE_URL")!;
 if(!secret)return json({error:"SUPABASE_SECRET_NOT_CONFIGURED"},503);
 const db=createClient(url,secret);
 const key=Deno.env.get("SHOTSTACK_API_KEY")||"";
 if(!key)return json({error:"SHOTSTACK_API_KEY_NOT_CONFIGURED"},503);

 const providerName="shotstack";
 const eventType=String(event.type);
 const action=String(event.action);
 const eventId=String(event.id);
 const job=(await db.from("render_jobs").select("*").eq("provider",providerName).eq("provider_job_id",eventId).maybeSingle()).data;
 if(!job)return json({status:"IGNORED",reason:"UNKNOWN_RENDER_JOB"},200);

 const inserted=await db.from("render_webhook_events").insert({
   provider:providerName,event_type:eventType,action,event_id:eventId,render_job_id:job.id,
   status:"PROCESSING",attempt_count:1,payload:event
 }).select("id,status,attempt_count").single();

 let ledger:any=inserted.data;
 if(inserted.error){
   const existing=(await db.from("render_webhook_events").select("id,status,attempt_count").eq("provider",providerName).eq("event_type",eventType).eq("action",action).eq("event_id",eventId).maybeSingle()).data;
   if(!existing)return json({error:"WEBHOOK_LEDGER_FAILED"},500);
   if(existing.status==="COMPLETED")return json({status:"ALREADY_PROCESSED",render_job_id:job.id},200);
   if(existing.status==="PROCESSING")return json({status:"PROCESSING",render_job_id:job.id},202);
   const claim=await db.from("render_webhook_events").update({
     status:"PROCESSING",attempt_count:Number(existing.attempt_count||1)+1,error_message:null,payload:event
   }).eq("id",existing.id).eq("status","FAILED").select("id,status,attempt_count").maybeSingle();
   if(claim.error||!claim.data)return json({status:"PROCESSING",render_job_id:job.id},202);
   ledger=claim.data;
 }

 const failLedger=async(message:string)=>{
   await db.from("render_webhook_events").update({status:"FAILED",error_message:message}).eq("id",ledger.id);
 };
 const completeLedger=async()=>{
   await db.from("render_webhook_events").update({status:"COMPLETED",error_message:null,completed_at:now()}).eq("id",ledger.id);
 };

 try{
   if(job.status==="COMPLETED"){await completeLedger();return json({status:"ALREADY_PROCESSED",render_job_id:job.id},200);}
   const cfg=Deno.env.get("SHOTSTACK_ENV")==="v1"?"v1":"stage";
   const checked=await provider("https://api.shotstack.io/edit/"+cfg+"/render/"+encodeURIComponent(eventId)+"?data=false",key);
   if(!checked.ok){await failLedger("PROVIDER_VERIFY_FAILED");return json({error:"PROVIDER_VERIFY_FAILED"},502);}
   const resp=checked.data?.response||checked.data||{};
   const mapped=statusMap(String(resp.status||event.status||""));
   if(mapped==="FAILED"){
     const message=String(resp.error||event.error||"Provider render failed");
     await db.from("render_jobs").update({status:"FAILED",provider_status:String(resp.status||event.status||"failed"),error_code:"PROVIDER_RENDER_FAILED",last_error:message,completed_at:now()}).eq("id",job.id);
     await db.from("production_runs").update({render_status:"FAILED",current_stage:"assembly"}).eq("id",job.production_run_id);
     await failLedger(message); return json({status:"FAILED",render_job_id:job.id},200);
   }
   if(mapped!=="COMPLETED"){
     await db.from("render_jobs").update({status:mapped,provider_status:String(resp.status||event.status||"processing"),started_at:job.started_at||now()}).eq("id",job.id);
     await db.from("production_runs").update({render_status:mapped,current_stage:"assembly"}).eq("id",job.production_run_id);
     await db.from("render_webhook_events").update({payload:event}).eq("id",ledger.id);
     return json({status:mapped,render_job_id:job.id},200);
   }

   const outputUrl=String(resp.url||event.url||"");
   if(!outputUrl){await failLedger("RENDER_OUTPUT_URL_MISSING");return json({status:"PROCESSING",render_job_id:job.id},200);}
   const probe=await provider("https://api.shotstack.io/edit/"+cfg+"/probe/"+encodeURIComponent(outputUrl),key);
   if(!probe.ok){await failLedger("FINAL_MEDIA_PROBE_FAILED");return json({error:"FINAL_MEDIA_PROBE_FAILED"},502);}
   const probeData=probe.data?.response||probe.data||{};
   const metadata=probeData?.metadata||{};
   const streams=Array.isArray(metadata.streams)?metadata.streams:[];
   const video=streams.find((s:any)=>String(s.codec_type||"").toLowerCase()==="video");
   if(!video||!Number(video.width)||!Number(video.height)||!(Number(video.duration)>0)){
     await failLedger("FINAL_MEDIA_PROBE_INVALID");
     return json({error:"FINAL_MEDIA_PROBE_INVALID"},502);
   }

   const media=await fetch(outputUrl);
   if(!media.ok){await failLedger("RENDER_OUTPUT_DOWNLOAD_FAILED");return json({error:"RENDER_OUTPUT_DOWNLOAD_FAILED"},502);}
   const bytes=new Uint8Array(await media.arrayBuffer());
   const contentType=String(media.headers.get("content-type")||"video/mp4").split(";")[0].toLowerCase();
   const magicOk=bytes.byteLength>=12 && String.fromCharCode(...bytes.slice(4,8))==="ftyp";
   const jobAspect=String(job.aspect_ratio||"16:9");
   const expectedHeight=String(job.resolution||"1080p")==="720p"?720:String(job.resolution||"1080p")==="1080p"?1080:String(job.resolution||"1080p")==="1440p"?1440:String(job.resolution||"1080p")==="2160p"?2160:null;
   const actualWidth=Number(video.width), actualHeight=Number(video.height);
   const actualDuration=Number(video.duration);
   const actualAspect=actualHeight>0?actualWidth/actualHeight:0;
   const expectedAspect=jobAspect==="9:16"?9/16:jobAspect==="1:1"?1:jobAspect==="4:5"?4/5:16/9;
   const aspectOk=actualAspect>0 && Math.abs(actualAspect-expectedAspect)<0.02;
   if(bytes.byteLength===0||bytes.byteLength>250*1024*1024||contentType!=="video/mp4"||!magicOk){
     await failLedger("RENDER_OUTPUT_INVALID");return json({error:"RENDER_OUTPUT_INVALID"},502);
   }
   if(expectedHeight && actualHeight!==expectedHeight || !aspectOk || actualDuration<=0){
     await failLedger("FINAL_MEDIA_EXPECTATION_MISMATCH");return json({error:"FINAL_MEDIA_EXPECTATION_MISMATCH"},422);
   }

   const path=job.user_id+"/production/"+job.production_run_id+"/final-"+job.id+".mp4";
   const up=await db.storage.from("creator-assets").upload(path,bytes,{contentType:"video/mp4",upsert:false});
   let assetId:string|null=null;
   if(up.error&&up.error.message?.toLowerCase().includes("already exists")){
     const existing=(await db.from("assets").select("id,status").eq("user_id",job.user_id).eq("storage_path",path).maybeSingle()).data;
     if(existing)assetId=existing.id;
     else{await failLedger("RENDER_OUTPUT_STORAGE_RACE");return json({error:"RENDER_OUTPUT_STORAGE_RACE"},409);}
   }else if(up.error){
     await failLedger("RENDER_OUTPUT_STORAGE_FAILED");return json({error:"RENDER_OUTPUT_STORAGE_FAILED"},500);
   }else{
     const asset=(await db.from("assets").insert({
       user_id:job.user_id,storage_path:path,asset_type:"video",mime_type:"video/mp4",
       file_size_bytes:bytes.byteLength,status:"READY",
       metadata:{production_run_id:job.production_run_id,render_job_id:job.id,provider:"shotstack",provider_output:resp,probe:probeData}
     }).select("id").single()).data;
     if(!asset){await failLedger("RENDER_OUTPUT_ASSET_RECORD_FAILED");return json({error:"RENDER_OUTPUT_ASSET_RECORD_FAILED"},500);}
     assetId=asset.id;
   }

   await db.from("render_jobs").update({status:"COMPLETED",provider_status:"done",asset_id:assetId,completed_at:now(),last_error:null}).eq("id",job.id);
   await db.from("production_runs").update({render_status:"COMPLETED",current_stage:"final_qa",final_asset_id:assetId}).eq("id",job.production_run_id);
   await completeLedger();
   return json({status:"COMPLETED",render_job_id:job.id,asset_id:assetId},200);
 }catch(e:any){
   const message=String(e?.message||"RENDER_WEBHOOK_PROCESSING_FAILED");
   await failLedger(message);
   return json({error:"RENDER_WEBHOOK_PROCESSING_FAILED",message},500);
 }
});