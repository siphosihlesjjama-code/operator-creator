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
 const job=(await db.from("render_jobs").select("*").eq("provider","shotstack").eq("provider_job_id",String(event.id)).maybeSingle()).data;
 if(!job)return json({status:"IGNORED",reason:"UNKNOWN_RENDER_JOB"},200);
 if(job.status==="COMPLETED")return json({status:"ALREADY_PROCESSED",render_job_id:job.id},200);
 const cfg=Deno.env.get("SHOTSTACK_ENV")==="v1"?"v1":"stage";
 const checked=await provider("https://api.shotstack.io/edit/"+cfg+"/render/"+encodeURIComponent(String(event.id))+"?data=false",key);
 if(!checked.ok)return json({error:"PROVIDER_VERIFY_FAILED"},502);
 const resp=checked.data?.response||checked.data||{};const mapped=statusMap(String(resp.status||event.status||""));
 if(mapped==="FAILED"){
   await db.from("render_jobs").update({status:"FAILED",provider_status:String(resp.status||event.status||"failed"),error_code:"PROVIDER_RENDER_FAILED",last_error:String(resp.error||event.error||"Provider render failed"),completed_at:now()}).eq("id",job.id);
   await db.from("production_runs").update({render_status:"FAILED",current_stage:"assembly"}).eq("id",job.production_run_id);
   return json({status:"FAILED",render_job_id:job.id},200);
 }
 if(mapped!=="COMPLETED"){
   await db.from("render_jobs").update({status:mapped,provider_status:String(resp.status||event.status||"processing"),started_at:job.started_at||now()}).eq("id",job.id);
   await db.from("production_runs").update({render_status:mapped,current_stage:"assembly"}).eq("id",job.production_run_id);
   return json({status:mapped,render_job_id:job.id},200);
 }
 const outputUrl=String(resp.url||event.url||"");if(!outputUrl)return json({status:"PROCESSING",render_job_id:job.id},200);
 const probe=await provider("https://api.shotstack.io/edit/"+cfg+"/probe/"+encodeURIComponent(outputUrl),key);
 if(!probe.ok)return json({error:"FINAL_MEDIA_PROBE_FAILED"},502);
 const media=await fetch(outputUrl);if(!media.ok)return json({error:"RENDER_OUTPUT_DOWNLOAD_FAILED"},502);
 const bytes=new Uint8Array(await media.arrayBuffer());if(bytes.byteLength===0||bytes.byteLength>250*1024*1024)return json({error:"RENDER_OUTPUT_SIZE_INVALID"},502);
 const path=job.user_id+"/production/"+job.production_run_id+"/final-"+job.id+".mp4";
 const up=await db.storage.from("creator-assets").upload(path,bytes,{contentType:"video/mp4",upsert:false});
 if(up.error&&up.error.message?.toLowerCase().includes("already exists")){
   const existing=(await db.from("assets").select("*").eq("user_id",job.user_id).eq("storage_path",path).maybeSingle()).data;
   if(existing){await db.from("render_jobs").update({status:"COMPLETED",provider_status:"done",asset_id:existing.id,completed_at:now(),last_error:null}).eq("id",job.id);await db.from("production_runs").update({render_status:"COMPLETED",current_stage:"final_qa",final_asset_id:existing.id}).eq("id",job.production_run_id);return json({status:"COMPLETED",render_job_id:job.id,asset_id:existing.id},200);}
 }
 if(up.error)return json({error:"RENDER_OUTPUT_STORAGE_FAILED"},500);
 const asset=(await db.from("assets").insert({user_id:job.user_id,storage_path:path,asset_type:"video",mime_type:"video/mp4",file_size_bytes:bytes.byteLength,status:"READY",metadata:{production_run_id:job.production_run_id,render_job_id:job.id,provider:"shotstack",provider_output:resp,probe:probe.data?.response||probe.data||null}}).select("id").single()).data;
 if(!asset)return json({error:"RENDER_OUTPUT_ASSET_RECORD_FAILED"},500);
 await db.from("render_jobs").update({status:"COMPLETED",provider_status:"done",asset_id:asset.id,completed_at:now(),last_error:null}).eq("id",job.id);
 await db.from("production_runs").update({render_status:"COMPLETED",current_stage:"final_qa",final_asset_id:asset.id}).eq("id",job.production_run_id);
 return json({status:"COMPLETED",render_job_id:job.id,asset_id:asset.id},200);
});