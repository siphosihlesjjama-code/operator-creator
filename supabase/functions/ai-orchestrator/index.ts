import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"POST,OPTIONS"};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers});
const now=()=>new Date().toISOString();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function extractText(d:any){if(typeof d?.output_text==="string")return d.output_text;return (d?.output||[]).flatMap((x:any)=>(x?.content||[]).filter((c:any)=>typeof c?.text==="string").map((c:any)=>c.text)).join("\n").trim();}
function parseJson(s:string){try{return JSON.parse(s)}catch{const m=s.match(/\{[\s\S]*\}/);if(m)try{return JSON.parse(m[0])}catch{}return null}}
function classify(status:number,network=false){return {retryable:network||status===408||status===409||status===429||status>=500,code:status===401||status===403?"INVALID_CREDENTIALS":status===429?"RATE_LIMITED":status>=500?"PROVIDER_TRANSIENT_ERROR":network?"NETWORK_ERROR":"INVALID_PROVIDER_REQUEST"}}
async function openai(input:any,key:string,model:string,timeout=60000){const c=new AbortController();const t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",signal:c.signal,headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({model,input})});const data=await r.json().catch(()=>({}));return {ok:r.ok,status:r.status,text:r.ok?extractText(data):"",data,network:false}}catch(e:any){return {ok:false,status:0,text:"",data:{error:{message:e?.name==="AbortError"?"Provider timeout":String(e?.message||"Network error")}},network:true}}finally{clearTimeout(t)}}
async function gemini(input:string,key:string,model:string,timeout=60000){const c=new AbortController();const t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+encodeURIComponent(key),{method:"POST",signal:c.signal,headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts:[{text:input}]}]})});const data=await r.json().catch(()=>({}));const text=(data?.candidates?.[0]?.content?.parts||[]).map((p:any)=>p.text||"").join("").trim();return {ok:r.ok,status:r.status,text,data,network:false}}catch(e:any){return {ok:false,status:0,text:"",data:{error:{message:e?.name==="AbortError"?"Provider timeout":String(e?.message||"Network error")}},network:true}}finally{clearTimeout(t)}}
async function provider(input:string,system:string,preferred:string|null){const open=Deno.env.get("OPENAI_API_KEY");const gem=Deno.env.get("GEMINI_API_KEY");const p=preferred||Deno.env.get("AI_PROVIDER")||"auto";const tries=p==="gemini"?["gemini","openai"]:p==="openai"?["openai","gemini"]:["gemini","openai"];for(const x of tries){if(x==="openai"&&open){const r=await openai([{role:"system",content:system},{role:"user",content:input}],open,Deno.env.get("OPENAI_MODEL")||"gpt-5.6-luna");if(r.ok)return {...r,provider:"openai",model:Deno.env.get("OPENAI_MODEL")||"gpt-5.6-luna"};if(!r.network&&r.status>=400&&r.status<500&&r.status!==429)continue}
if(x==="gemini"&&gem){const r=await gemini(system+"\n\n"+input,gem,Deno.env.get("GEMINI_MODEL")||"gemini-2.5-flash-lite");if(r.ok)return {...r,provider:"gemini",model:Deno.env.get("GEMINI_MODEL")||"gemini-2.5-flash-lite"};}}
return {ok:false,status:0,text:"",provider:null,model:null,data:{error:{message:"No configured AI provider is available."}},network:false}}
async function audit(db:any,u:string,event:string,entity:string,id:string|null,details:any={}){await db.from("audit_events").insert({user_id:u,event_type:event,entity_type:entity,entity_id:id,details}).catch(()=>{})}
function brief(prompt:string,brand:any){const p=prompt.toLowerCase();let platform=/tiktok/.test(p)?"tiktok":/instagram|reel/.test(p)?"instagram":/short/.test(p)?"youtube_shorts":/youtube/.test(p)?"youtube":"multi_platform";let format=/podcast/.test(p)?"podcast":/ad|advert/.test(p)?"ad":/short|reel|tiktok/.test(p)?"short_video":"video";return {topic:prompt,platform,audience:brand?.audience||"Define from brand context",objective:brand?.goals||"Create useful, engaging content",format,duration:format==="short_video"?"30-60s":"3-8m",tone:brand?.tone||"clear, confident, natural",language:brand?.preferred_language||"English",niche:brand?.description||"",audience_sophistication:"general",hook_strategy:"curiosity + immediate value",cta_strategy:(brand?.ctas||[])[0]||"follow for more"}}
const pipelineSystem=`You are the AI Producer for Operator Creator. Build a professional content production package. Return ONLY valid JSON with keys: strategy, concepts, script, storyboard, quality. strategy must be a structured content brief. concepts must be an array of exactly 5 distinct concepts, each with title, angle, hook, rationale. script must have title, hook, body, payoff, cta, spoken_script. storyboard must be an array of scenes with scene_number,start_time,end_time,duration,narration,visual_description,camera_direction,on_screen_text,caption,transition,sound_effect,music_direction. quality must contain status,overall_score,factual_confidence,audio_quality,visual_relevance,platform_fit,issues,required_improvements,recommendations. Internal scores are production metrics only. Do not invent factual claims; mark uncertain claims. Favor natural spoken language, platform fit, brand consistency, and narrative-relevant visuals.`;
async function runPipeline(db:any,user:any,prompt:string,workflowId:string,contentId:string|null,brand:any){const run=(await db.from("production_runs").insert({user_id:user.id,workflow_id:workflowId,content_id:contentId,status:"ideating",brief:brief(prompt,brand),current_stage:"ideation",max_attempts:2}).select("*").single()).data;if(!run)throw new Error("Production run could not be created");
const started=Date.now();
const fingerprint=btoa(unescape(encodeURIComponent(prompt.toLowerCase().replace(/\\s+/g," ").trim()))).slice(0,180);
const prior=(await db.from("content_memory").select("topic,memory_type,data").eq("user_id",user.id).ilike("topic","%"+prompt.split(/\\s+/).slice(0,4).join(" ")+"%").limit(10)).data||[];
await db.from("production_runs").update({status:"researching",current_stage:"research"}).eq("id",run.id).eq("user_id",user.id);
let research=await provider(JSON.stringify({brief:run.brief,request:prompt,prior_memory:prior}),`You are the research stage for a content production system. Return ONLY JSON: {"needs_current_research":boolean,"claims":[{"claim":string,"confidence":number,"source_needed":boolean}],"notes":string}. Do not invent sources or URLs. If current verification is required, mark source_needed true and do not treat unverified claims as facts.`,null);
if(research.ok){const rd=parseJson(research.text)||{};await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:run.id,stage:"research",output:rd,provider:research.provider,model:research.model,latency_ms:Date.now()-started,attempt:1});if(Array.isArray(rd.claims))await db.from("research_sources").insert(rd.claims.map((c:any)=>({user_id:user.id,production_run_id:run.id,title:null,url:null,source_type:"ai_research_note",claim:c.claim,verified:false,data:{confidence:c.confidence,source_needed:c.source_needed}})));} 
await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:run.id,stage:"memory_check",output:{fingerprint,prior_count:prior.length},attempt:1,status:"COMPLETED"});
await db.from("production_runs").update({status:"ideating",current_stage:"ideation"}).eq("id",run.id).eq("user_id",user.id);
let r=await provider(JSON.stringify({brief:run.brief,brand,request:prompt,research_notes:research.ok?parseJson(research.text):null,prior_memory:prior}),pipelineSystem,null);
if(!r.ok){await db.from("production_runs").update({status:"failed",current_stage:"ideation"}).eq("id",run.id).eq("user_id",user.id);return {production_run_id:run.id,status:"PROVIDER_NOT_CONFIGURED",message:r.data?.error?.message||"No configured AI provider is available."}}
let pack=parseJson(r.text);if(!pack){await db.from("production_runs").update({status:"failed",current_stage:"ideation"}).eq("id",run.id);return {production_run_id:run.id,status:"FAILED",error:"AI returned malformed structured output"}}
await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:run.id,stage:"ideation",output:{strategy:pack.strategy,concepts:pack.concepts},provider:r.provider,model:r.model,latency_ms:Date.now()-started,attempt:1});
await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:run.id,stage:"writing",output:{script:pack.script},provider:r.provider,model:r.model,latency_ms:Date.now()-started,attempt:1});
await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:run.id,stage:"storyboarding",output:{storyboard:pack.storyboard},provider:r.provider,model:r.model,latency_ms:Date.now()-started,attempt:1});
let q=pack.quality||{};await db.from("quality_reviews").insert({user_id:user.id,production_run_id:run.id,component:"script",status:q.status==="PASS"&&Number(q.overall_score)>=85?"PASS":"FAIL",overall_score:q.overall_score,factual_confidence:q.factual_confidence,audio_quality:q.audio_quality,visual_relevance:q.visual_relevance,platform_fit:q.platform_fit,issues:q.issues||[],required_improvements:q.required_improvements||[],recommendations:q.recommendations||[]});
if(q.status!=="PASS"||Number(q.overall_score)<85){await db.from("production_runs").update({status:"reworking",current_stage:"script_review",attempt_count:1}).eq("id",run.id).eq("user_id",user.id);const fix=await provider(JSON.stringify({original:pack,issues:q.issues,required_improvements:q.required_improvements}),pipelineSystem+"\nRewrite only the failed components. Preserve good components. Return the same JSON schema and improve the weak areas.",r.provider);if(fix.ok){const improved=parseJson(fix.text);if(improved){pack=improved;q=pack.quality||q;await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:run.id,stage:"rework",output:pack,provider:fix.provider,model:fix.model,latency_ms:0,attempt:2});await db.from("quality_reviews").insert({user_id:user.id,production_run_id:run.id,component:"script",status:q.status==="PASS"&&Number(q.overall_score)>=85?"PASS":"FAIL",overall_score:q.overall_score,factual_confidence:q.factual_confidence,audio_quality:q.audio_quality,visual_relevance:q.visual_relevance,platform_fit:q.platform_fit,issues:q.issues||[],required_improvements:q.required_improvements||[],recommendations:q.recommendations||[]});}}}
const pass=q.status==="PASS"&&Number(q.overall_score)>=85;const finalStatus=pass?"ready":"failed";await db.from("production_runs").update({status:finalStatus,current_stage:pass?"ready":"script_review",attempt_count:pass?1:2}).eq("id",run.id).eq("user_id",user.id);
if(contentId){await db.from("content_versions").insert({user_id:user.id,content_id:contentId,version_number:1,body:pack.script?.spoken_script||JSON.stringify(pack.script||{}),asset_ids:[]});await db.from("content").update({status:pass?"READY":"FAILED",metadata:{workflow_id:workflowId,production_run_id:run.id,quality:q,platform:run.brief.platform}}).eq("id",contentId).eq("user_id",user.id)}
await db.from("content_memory").insert({user_id:user.id,content_id:contentId,production_run_id:run.id,memory_type:"production",topic:prompt,fingerprint,data:{brief:run.brief,concepts:pack.concepts,quality:q,platform:run.brief.platform,status:finalStatus}}).catch(()=>{});
await audit(db,user.id,"production_completed","production_run",run.id,{status:finalStatus,quality:q,provider:r.provider});return {production_run_id:run.id,status:finalStatus,provider:r.provider,model:r.model,quality:q,brief:run.brief,script:pack.script,storyboard:pack.storyboard,concepts:pack.concepts}}

function renderConfig(){
  const provider=Deno.env.get("RENDER_PROVIDER")||"";
  const apiKey=Deno.env.get("SHOTSTACK_API_KEY")||"";
  const env=Deno.env.get("SHOTSTACK_ENV")||"stage";
  const version=env==="v1"?"v1":"stage";
  return {provider,apiKey,version,base:"https://api.shotstack.io/edit/"+version};
}
function renderIdempotency(userId:string,runId:string,format:string,aspect:string,resolution:string){
  return "render:"+userId+":"+runId+":"+format+":"+aspect+":"+resolution;
}
function renderDimensions(aspect:string,resolution:string){
  const r=resolution==="720p"?720:resolution==="1080p"?1080:resolution==="1440p"?1440:2160;
  if(aspect==="9:16")return {width:Math.round(r*9/16),height:r};
  if(aspect==="1:1")return {width:r,height:r};
  if(aspect==="4:5")return {width:Math.round(r*4/5),height:r};
  return {width:Math.round(r*16/9),height:r};
}
function providerRenderStatus(s:string){
  if(["queued","fetching","preprocessing"].includes(s))return "QUEUED";
  if(["rendering","generating","saving"].includes(s))return "PROCESSING";
  if(s==="done")return "COMPLETED";
  if(s==="failed")return "FAILED";
  return "PROCESSING";
}
async function shotstackRequest(url:string,apiKey:string,init:RequestInit={}){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),60000);
  try{
    const r=await fetch(url,{...init,signal:c.signal,headers:{"Accept":"application/json","Content-Type":"application/json","x-api-key":apiKey,...(init.headers||{})}});
    const data=await r.json().catch(()=>({}));
    return {ok:r.ok,status:r.status,data,network:false};
  }catch(e:any){
    return {ok:false,status:0,data:{error:e?.name==="AbortError"?"PROVIDER_TIMEOUT":String(e?.message||"NETWORK_ERROR")},network:true};
  }finally{clearTimeout(t)}
}
async function persistRenderedAsset(db:any,userId:string,runId:string,renderJobId:string,outputUrl:string,providerData:any,probe:any=null){
  const response=await fetch(outputUrl);
  if(!response.ok)throw new Error("RENDER_OUTPUT_DOWNLOAD_FAILED");
  const type=response.headers.get("content-type")||"video/mp4";
  const bytes=new Uint8Array(await response.arrayBuffer());
  const maxBytes=250*1024*1024;
  if(bytes.byteLength>maxBytes)throw new Error("RENDER_OUTPUT_TOO_LARGE");
  const path=userId+"/production/"+runId+"/final-"+renderJobId+".mp4";
  const up=await db.storage.from("creator-assets").upload(path,bytes,{contentType:type,upsert:false});
  if(up.error)throw new Error("RENDER_OUTPUT_STORAGE_FAILED");
  const asset=(await db.from("assets").insert({
    user_id:userId,storage_path:path,asset_type:"video",mime_type:type,file_size_bytes:bytes.byteLength,status:"READY",
    metadata:{production_run_id:runId,render_job_id:renderJobId,provider:"shotstack",provider_output:providerData,probe:probe||null}
  }).select("id,storage_path,asset_type,mime_type,file_size_bytes,status,metadata").single()).data;
  if(!asset)throw new Error("RENDER_OUTPUT_ASSET_RECORD_FAILED");
  return asset;
}
async function validatePlatformForPublishing(db:any,userId:string,contentId:string,platform:string,runId:string|null){
  const errors:string[]=[];
  if(!platform)errors.push("PLATFORM_REQUIRED");
  const {data:content}=await db.from("content").select("id,title,metadata,status").eq("id",contentId).eq("user_id",userId).maybeSingle();
  if(!content)errors.push("CONTENT_NOT_FOUND");
  if(content?.status!=="READY")errors.push("CONTENT_NOT_READY");
  let run:any=null;
  if(runId){run=(await db.from("production_runs").select("*").eq("id",runId).eq("user_id",userId).maybeSingle()).data;}
  if(runId&&!run)errors.push("PRODUCTION_RUN_NOT_FOUND");
  if(run&&run.status!=="ready")errors.push("PRODUCTION_NOT_READY");
  const finalId=run?.final_asset_id||null;
  if(runId&&!finalId)errors.push("FINAL_ASSET_REQUIRED");
  if(finalId){
    const {data:asset}=await db.from("assets").select("id,status,mime_type,file_size_bytes,metadata").eq("id",finalId).eq("user_id",userId).maybeSingle();
    if(!asset)errors.push("FINAL_ASSET_NOT_FOUND");
    else{
      if(asset.status!=="READY")errors.push("FINAL_ASSET_NOT_READY");
      if(asset.mime_type!=="video/mp4")errors.push("FINAL_ASSET_MUST_BE_MP4");
      if(!Number(asset.file_size_bytes)||Number(asset.file_size_bytes)<=0)errors.push("FINAL_ASSET_EMPTY");
    }
  }
  const {data:account}=await db.from("social_accounts").select("id,status,platform,scopes").eq("user_id",userId).eq("platform",platform.toLowerCase()).maybeSingle();
  if(!account||String(account.status).toUpperCase()!=="CONNECTED")errors.push("PLATFORM_NOT_CONNECTED");
  if(account?.scopes?.length===0)errors.push("PUBLISH_SCOPE_MISSING");
  const {data:approval}=await db.from("approvals").select("id,status,action").eq("user_id",userId).eq("content_id",contentId).eq("status","APPROVED").order("decided_at",{ascending:false}).limit(1).maybeSingle();
  if(!approval)errors.push("APPROVAL_REQUIRED");
  const platformRules:any={
    youtube:{maxBytes:256*1024*1024*1024,maxSeconds:12*60*60,ratios:["16:9","9:16","1:1"]},
    youtube_shorts:{maxBytes:256*1024*1024*1024,maxSeconds:180,ratios:["9:16"]},
    instagram:{maxBytes:250*1024*1024,maxSeconds:90,ratios:["9:16","1:1","4:5","16:9"]},
    tiktok:{maxBytes:4*1024*1024*1024,maxSeconds:600,ratios:["9:16","1:1","16:9"]},
    facebook:{maxBytes:4*1024*1024*1024,maxSeconds:240,ratios:["9:16","1:1","16:9"]},
    linkedin:{maxBytes:200*1024*1024,maxSeconds:600,ratios:["9:16","1:1","16:9"]},
    x:{maxBytes:512*1024*1024,maxSeconds:140,ratios:["16:9","9:16","1:1"]},
    pinterest:{maxBytes:2*1024*1024*1024,maxSeconds:900,ratios:["9:16","1:1","4:5","16:9"]}
  };
  const rule=platformRules[platform.toLowerCase()];
  if(!rule)errors.push("UNSUPPORTED_PLATFORM");
  if(run?.brief?.aspect_ratio&&rule&&!rule.ratios.includes(run.brief.aspect_ratio))errors.push("ASPECT_RATIO_NOT_SUPPORTED");
  if(run?.brief?.duration_seconds&&rule&&Number(run.brief.duration_seconds)>rule.maxSeconds)errors.push("DURATION_EXCEEDS_PLATFORM_LIMIT");
  if(finalId&&rule){
    const a=(await db.from("assets").select("file_size_bytes").eq("id",finalId).eq("user_id",userId).maybeSingle()).data;
    if(a&&Number(a.file_size_bytes)>rule.maxBytes)errors.push("FILE_SIZE_EXCEEDS_PLATFORM_LIMIT");
  }
  return {valid:errors.length===0,errors};
}

Deno.serve(async(req)=>{if(req.method==="OPTIONS")return new Response("ok",{headers});const auth=req.headers.get("Authorization");if(!auth)return json({error:"UNAUTHORIZED_NO_AUTH_HEADER"},401);const url=Deno.env.get("SUPABASE_URL")!;const key=Deno.env.get("SUPABASE_ANON_KEY")||Deno.env.get("SUPABASE_PUBLISHABLE_KEY")||JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")||"{}").default;const db=createClient(url,key,{global:{headers:{Authorization:auth}}});const {data:{user},error}=await db.auth.getUser();if(error||!user)return json({error:"UNAUTHORIZED"},401);const body=await req.json().catch(()=>null);const action=String(body?.action||""); const actionOnly=["production","generate_scene_images","generate_captions","generate_voice","generate_image","generate_audio","validate_render","queue_render","poll_render","validate_publish","publish"]; if(!body?.prompt&&!body?.task_id&&!actionOnly.includes(action))return json({error:"prompt or task_id or supported action is required"},400);
if(body.action==="generate_scene_images"){
 const runId=String(body.production_run_id||"").trim();
 if(!runId)return json({error:"production_run_id is required"},400);
 const {data:run,error:runErr}=await db.from("production_runs").select("*").eq("id",runId).eq("user_id",user.id).maybeSingle();
 if(runErr||!run)return json({error:"Production run not found"},404);
 const {data:story}=await db.from("production_stage_outputs").select("output").eq("production_run_id",runId).eq("user_id",user.id).eq("stage","storyboarding").order("created_at",{ascending:false}).limit(1).maybeSingle();
 const scenes=Array.isArray(story?.output?.storyboard)?story.output.storyboard:[];
 if(!scenes.length)return json({error:"No storyboard scenes available"},409);
 const open=Deno.env.get("OPENAI_API_KEY"); if(!open)return json({status:"PROVIDER_NOT_CONFIGURED",message:"Image provider is not configured."},200);
 const results:any[]=[];
 for(const scene of scenes.slice(0,10)){
  const sceneNo=Number(scene.scene_number||results.length+1);
  const prompt="Create a production-ready cinematic visual for this video scene. Do not add readable text or logos. Match the described camera direction and visual style. Scene narration: "+String(scene.narration||"")+" Visual: "+String(scene.visual_description||"")+" Camera: "+String(scene.camera_direction||"")+" Mood/music direction: "+String(scene.music_direction||"");
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),90000);
  try{
   const rr=await fetch("https://api.openai.com/v1/images/generations",{method:"POST",signal:ac.signal,headers:{"Authorization":"Bearer "+open,"Content-Type":"application/json"},body:JSON.stringify({model:Deno.env.get("OPENAI_IMAGE_MODEL")||"gpt-image-2",prompt,size:"1024x1024",quality:"medium",output_format:"png"})});
   const data=await rr.json().catch(()=>({})); if(!rr.ok){results.push({scene_number:sceneNo,status:"FAILED",error:classify(rr.status,false).code});continue}
   const b64=data?.data?.[0]?.b64_json; if(!b64){results.push({scene_number:sceneNo,status:"FAILED",error:"NO_IMAGE_DATA"});continue}
   const bytes=Uint8Array.from(atob(b64),ch=>ch.charCodeAt(0)); const path=user.id+"/production/"+runId+"/scene-"+sceneNo+"-"+crypto.randomUUID()+".png";
   const up=await db.storage.from("creator-assets").upload(path,bytes,{contentType:"image/png",upsert:false}); if(up.error){results.push({scene_number:sceneNo,status:"FAILED",error:"ASSET_STORAGE_FAILED"});continue}
   const ins=await db.from("assets").insert({user_id:user.id,storage_path:path,asset_type:"image",mime_type:"image/png",file_size_bytes:bytes.byteLength,status:"READY",metadata:{production_run_id:runId,scene_number:sceneNo,source:"storyboard_scene"}}).select("id,storage_path,asset_type,mime_type,file_size_bytes").single();
   if(ins.error){results.push({scene_number:sceneNo,status:"FAILED",error:"ASSET_RECORD_FAILED"});continue}
   results.push({scene_number:sceneNo,status:"COMPLETED",asset:ins.data}); await db.from("production_media_links").insert({user_id:user.id,production_run_id:runId,scene_number:sceneNo,asset_id:ins.data.id,role:"scene_visual"});
  }catch(e){results.push({scene_number:sceneNo,status:"FAILED",error:e?.name==="AbortError"?"TIMEOUT":"NETWORK_ERROR"});}
  finally{clearTimeout(timer)}
 }
 const completed=results.filter(x=>x.status==="COMPLETED").length;
 await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:runId,stage:"media_generation",output:{scene_results:results,completed,total:results.length},provider:"openai",model:Deno.env.get("OPENAI_IMAGE_MODEL")||"gpt-image-2",attempt:1,status:completed?"COMPLETED":"FAILED"});
 await db.from("production_runs").update({status:completed===results.length?"quality_check":"generating_media",current_stage:completed===results.length?"media_quality":"media_generation"}).eq("id",runId).eq("user_id",user.id);
 await audit(db,user.id,"scene_media_generated","production_run",runId,{completed,total:results.length});
 return json({status:completed===results.length?"COMPLETED":"PARTIAL",production_run_id:runId,scene_results:results},200);
}
if(body.action==="validate_render"){
 const runId=String(body.production_run_id||"").trim(); if(!runId)return json({error:"production_run_id is required"},400);
 const {data:run}=await db.from("production_runs").select("*").eq("id",runId).eq("user_id",user.id).maybeSingle(); if(!run)return json({error:"Production run not found"},404);
 const checks:any[]=[];
 const {data:render}=await db.from("render_jobs").select("*").eq("production_run_id",runId).eq("user_id",user.id).order("created_at",{ascending:false}).limit(1).maybeSingle();
 checks.push({check:"render_job_exists",passed:!!render});
 checks.push({check:"render_completed",passed:render?.status==="COMPLETED"});
 const finalId=render?.asset_id||run.final_asset_id||null;
 let asset:any=null;
 if(finalId)asset=(await db.from("assets").select("id,user_id,storage_path,mime_type,file_size_bytes,status,metadata").eq("id",finalId).eq("user_id",user.id).maybeSingle()).data;
 checks.push({check:"final_asset_exists",passed:!!asset});
 checks.push({check:"final_asset_ready",passed:asset?.status==="READY"});
 checks.push({check:"final_asset_belongs_to_run",passed:!!asset&&String(asset.metadata?.production_run_id||"")===runId});
 checks.push({check:"final_asset_is_mp4",passed:asset?.mime_type==="video/mp4"});
 checks.push({check:"final_asset_nonempty",passed:!!asset&&Number(asset.file_size_bytes)>0});
 const probe=asset?.metadata?.probe||null;
 checks.push({check:"media_probe_passed",passed:!!probe});
 const streams=Array.isArray(probe?.streams)?probe.streams:[];
 const video=streams.find((s:any)=>String(s.codec_type||"").toLowerCase()==="video");
 const audio=streams.find((s:any)=>String(s.codec_type||"").toLowerCase()==="audio");
 const width=Number(probe?.width||video?.width); const height=Number(probe?.height||video?.height); const duration=Number(probe?.duration||video?.duration);
 checks.push({check:"video_stream_present",passed:!!video});
 checks.push({check:"video_dimensions_valid",passed:Number.isFinite(width)&&width>0&&Number.isFinite(height)&&height>0});
 checks.push({check:"video_duration_valid",passed:Number.isFinite(duration)&&duration>0});
 const expectedAspect=String(run.brief?.aspect_ratio||"16:9"); const ratio=height>0?width/height:0;
 const expectedRatio=expectedAspect==="9:16"?9/16:expectedAspect==="1:1"?1:expectedAspect==="4:5"?4/5:16/9;
 checks.push({check:"aspect_ratio_matches",passed:ratio>0&&Math.abs(ratio-expectedRatio)<0.02});
 checks.push({check:"audio_stream_present_when_required",passed:run.brief?.audio_required?!!audio:true});
 const {data:cap}=await db.from("caption_tracks").select("id,status,cues").eq("production_run_id",runId).eq("user_id",user.id).order("created_at",{ascending:false}).limit(1).maybeSingle();
 const cues=Array.isArray(cap?.cues)?cap.cues:[];
 const timing=cues.length>0&&cues.every((x:any)=>Number.isFinite(Number(x.start))&&Number.isFinite(Number(x.end))&&Number(x.start)>=0&&Number(x.end)>Number(x.start)&&Number(x.end)<=duration+0.25);
 checks.push({check:"captions_valid",passed:!!cap&&cap.status==="READY"&&timing});
 const {data:links}=await db.from("production_media_links").select("scene_number,asset_id").eq("production_run_id",runId).eq("user_id",user.id).eq("role","scene_visual");
 const {data:readyAssets}=links?.length?await db.from("assets").select("id,status,metadata").eq("user_id",user.id).in("id",links.map((x:any)=>x.asset_id)):({data:[]});
 const readySet=new Set((readyAssets||[]).filter((a:any)=>a.status==="READY"&&String(a.metadata?.production_run_id||"")===runId).map((a:any)=>a.id));
 checks.push({check:"scene_assets_complete",passed:!!links?.length&&links.every((x:any)=>readySet.has(x.asset_id))});
 const all=checks.every(x=>x.passed);
 await db.from("quality_reviews").insert({user_id:user.id,production_run_id:runId,component:"final_media",status:all?"PASS":"FAIL",overall_score:all?100:0,factual_confidence:null,audio_quality:audio?100:run.brief?.audio_required?0:null,visual_relevance:video?100:0,platform_fit:all?100:0,issues:checks.filter(x=>!x.passed),required_improvements:checks.filter(x=>!x.passed),recommendations:all?["Final media passed structural and provider-probe QA."]:["Resolve failed final media checks before approval or publishing."]});
 await db.from("production_runs").update({status:all?"ready":"failed",current_stage:all?"approval":"final_qa",render_status:all?"COMPLETED":"FAILED",final_asset_id:all?finalId:null}).eq("id",runId).eq("user_id",user.id);
 await audit(db,user.id,all?"final_media_qa_passed":"final_media_qa_failed","production_run",runId,{checks});
 return json({status:all?"PASSED":"FAILED",production_run_id:runId,checks},200);
}
if(body.action==="queue_render"){
 const runId=String(body.production_run_id||"").trim(); if(!runId)return json({error:"production_run_id is required"},400);
 const {data:run}=await db.from("production_runs").select("*").eq("id",runId).eq("user_id",user.id).maybeSingle(); if(!run)return json({error:"Production run not found"},404);
 if(!["ready","quality_check","assembling","generating_media"].includes(run.status))return json({status:"INVALID_RUN_STATE",message:"Production run is not eligible for rendering from its current state."},409);
 const format=String(body.format||"mp4"); const aspect=String(body.aspect_ratio||"16:9"); const resolution=String(body.resolution||"1080p");
 const idempotencyKey=renderIdempotency(user.id,runId,format,aspect,resolution);
 const {data:cap}=await db.from("caption_tracks").select("id,cues").eq("production_run_id",runId).eq("user_id",user.id).order("created_at",{ascending:false}).limit(1).maybeSingle();
 const {data:links}=await db.from("production_media_links").select("scene_number,asset_id").eq("production_run_id",runId).eq("user_id",user.id).eq("role","scene_visual").order("scene_number");
 if(!cap)return json({status:"VALIDATION_FAILED",errors:["CAPTION_TRACK_REQUIRED"]},409);
 if(!links?.length)return json({status:"VALIDATION_FAILED",errors:["SCENE_MEDIA_REQUIRED"]},409);
 const cfg=renderConfig();
 if(cfg.provider!=="shotstack"||!cfg.apiKey){
   const existing=(await db.from("render_jobs").select("id,status").eq("user_id",user.id).eq("idempotency_key",idempotencyKey).maybeSingle()).data;
   if(existing)return json({status:"ALREADY_QUEUED",render_job_id:existing.id,render_status:existing.status},200);
   const ins=await db.from("render_jobs").insert({user_id:user.id,production_run_id:runId,status:"PROVIDER_NOT_CONFIGURED",format,aspect_ratio:aspect,resolution,caption_track_id:cap.id,idempotency_key:idempotencyKey,provider:"shotstack",metadata:{reason:"SHOTSTACK_API_KEY or RENDER_PROVIDER is not configured"}}).select("id,status").single();
   await db.from("production_runs").update({render_status:"PROVIDER_NOT_CONFIGURED",current_stage:"assembly"}).eq("id",runId).eq("user_id",user.id);
   return json({status:"PROVIDER_NOT_CONFIGURED",render_job_id:ins.data?.id||null,message:"Shotstack render provider is not configured."},200);
 }
 const existing=(await db.from("render_jobs").select("*").eq("user_id",user.id).eq("idempotency_key",idempotencyKey).maybeSingle()).data;
 if(existing){
   if(existing.status==="COMPLETED")return json({status:"COMPLETED",render_job_id:existing.id,render_status:"COMPLETED"},200);
   if(existing.provider_job_id)return json({status:existing.status,render_job_id:existing.id,provider_job_id:existing.provider_job_id},200);
   if(existing.status==="PROCESSING"||existing.status==="QUEUED")return json({status:existing.status,render_job_id:existing.id},200);
 }
 let job=existing;
 if(!job){
   const ins=await db.from("render_jobs").insert({user_id:user.id,production_run_id:runId,status:"QUEUED",format,aspect_ratio:aspect,resolution,caption_track_id:cap.id,idempotency_key:idempotencyKey,provider:"shotstack",attempt_number:1,max_attempts:3}).select("*").single();
   if(ins.error){
     const race=(await db.from("render_jobs").select("*").eq("user_id",user.id).eq("idempotency_key",idempotencyKey).maybeSingle()).data;
     if(race)return json({status:race.status,render_job_id:race.id,provider_job_id:race.provider_job_id||null},200);
     return json({status:"FAILED",error:"RENDER_JOB_CREATE_FAILED"},500);
   }
   job=ins.data;
 }
 const {data:story}=await db.from("production_stage_outputs").select("output").eq("production_run_id",runId).eq("user_id",user.id).eq("stage","storyboarding").order("created_at",{ascending:false}).limit(1).maybeSingle();
 const scenes=Array.isArray(story?.output?.storyboard)?story.output.storyboard:[];
 const clips:any[]=[]; const signedAssets:any[]=[];
 for(const link of links){
   const scene=scenes.find((s:any)=>Number(s.scene_number)===Number(link.scene_number));
   const {data:asset}=await db.from("assets").select("id,storage_path,status").eq("id",link.asset_id).eq("user_id",user.id).maybeSingle();
   if(!asset||asset.status!=="READY")return json({status:"VALIDATION_FAILED",render_job_id:job.id,errors:["SCENE_ASSET_NOT_READY:"+String(link.scene_number)]},409);
   const signed=await db.storage.from("creator-assets").createSignedUrl(asset.storage_path,3600);
   if(signed.error||!signed.data?.signedUrl)return json({status:"VALIDATION_FAILED",render_job_id:job.id,errors:["SCENE_ASSET_SIGNED_URL_FAILED:"+String(link.scene_number)]},409);
   signedAssets.push(signed.data.signedUrl);
   const start=Number(scene?.start_time||0); const length=Math.max(0.5,Number(scene?.duration||0)||(Number(scene?.end_time||start+3)-start));
   clips.push({asset:{type:"image",src:signed.data.signedUrl},start,length,fit:"cover",effect:"zoomIn"});
 }
 const cues=Array.isArray(cap.cues)?cap.cues:[];
 const captionClips=cues.map((cue:any)=>({asset:{type:"text",text:String(cue.text||""),width:1500,height:180,font:{family:"Open Sans",color:"#ffffff",size:42,weight:700,lineHeight:1},background:{color:"#000000",opacity:0.65,padding:12,borderRadius:8,wrap:true},alignment:{horizontal:"center",vertical:"center"},stroke:{width:1,color:"#000000"}},start:Number(cue.start),length:Math.max(0.2,Number(cue.end)-Number(cue.start)),position:"bottom"}));
 const dims=renderDimensions(aspect,resolution);
 const timeline={background:"#000000",tracks:[{clips},{clips:captionClips}]};
 const callbackBase=Deno.env.get("PUBLIC_FUNCTION_BASE_URL")||"";
 const payload:any={timeline,output:{format:"mp4",size:dims,fps:30,thumbnail:{capture:1}}};
 if(callbackBase)payload.callback=callbackBase.replace(/\/$/,"")+"/render-webhook";
 const submitted=await shotstackRequest(cfg.base+"/render",cfg.apiKey,{method:"POST",body:JSON.stringify(payload)});
 if(!submitted.ok){
   const retryable=submitted.network||submitted.status===408||submitted.status===409||submitted.status===429||submitted.status>=500;
   await db.from("render_jobs").update({status:retryable?"QUEUED":"FAILED",error_code:retryable?"PROVIDER_TRANSIENT_ERROR":"INVALID_PROVIDER_REQUEST",last_error:String(submitted.data?.message||submitted.data?.error||"Provider submission failed"),provider_status:"submission_failed"}).eq("id",job.id).eq("user_id",user.id);
   return json({status:retryable?"QUEUED":"FAILED",render_job_id:job.id,error_code:retryable?"PROVIDER_TRANSIENT_ERROR":"INVALID_PROVIDER_REQUEST"},retryable?202:502);
 }
 const providerJobId=String(submitted.data?.response?.id||submitted.data?.id||"");
 if(!providerJobId){
   await db.from("render_jobs").update({status:"FAILED",error_code:"PROVIDER_NO_JOB_ID",last_error:"Render provider accepted a response without a job id."}).eq("id",job.id).eq("user_id",user.id);
   return json({status:"FAILED",render_job_id:job.id,error_code:"PROVIDER_NO_JOB_ID"},502);
 }
 const mapped=providerRenderStatus(String(submitted.data?.response?.status||"queued"));
 await db.from("render_jobs").update({status:mapped,provider_job_id:providerJobId,provider_status:String(submitted.data?.response?.status||"queued"),started_at:mapped==="PROCESSING"?now():null,last_error:null}).eq("id",job.id).eq("user_id",user.id);
 await db.from("production_runs").update({render_status:mapped,current_stage:"assembly"}).eq("id",runId).eq("user_id",user.id);
 await audit(db,user.id,"render_submitted","render_job",job.id,{provider:"shotstack",provider_job_id:providerJobId,attempt:job.attempt_number});
 return json({status:mapped,render_job_id:job.id,provider_job_id:providerJobId,provider:"shotstack"},202);
}
if(body.action==="poll_render"){
 const runId=String(body.production_run_id||"").trim(); const renderJobId=String(body.render_job_id||"").trim();
 if(!runId||!renderJobId)return json({error:"production_run_id and render_job_id are required"},400);
 const {data:job}=await db.from("render_jobs").select("*").eq("id",renderJobId).eq("production_run_id",runId).eq("user_id",user.id).maybeSingle();
 if(!job)return json({error:"Render job not found"},404);
 if(job.status==="COMPLETED"||job.status==="FAILED"||job.status==="PROVIDER_NOT_CONFIGURED")return json({status:job.status,render_job_id:job.id,asset_id:job.asset_id||null},200);
 const cfg=renderConfig(); if(cfg.provider!=="shotstack"||!cfg.apiKey)return json({status:"PROVIDER_NOT_CONFIGURED",render_job_id:job.id},200);
 if(!job.provider_job_id)return json({status:job.status,error_code:"PROVIDER_JOB_ID_MISSING",render_job_id:job.id},409);
 const polled=await shotstackRequest(cfg.base+"/render/"+encodeURIComponent(job.provider_job_id),cfg.apiKey,{method:"GET"});
 if(!polled.ok){
   const retryable=polled.network||polled.status===408||polled.status===409||polled.status===429||polled.status>=500;
   const attempts=Number(job.attempt_number||1);
   if(!retryable||attempts>=Number(job.max_attempts||3)){
     await db.from("render_jobs").update({status:"FAILED",error_code:retryable?"RETRY_LIMIT_EXCEEDED":"PROVIDER_STATUS_ERROR",last_error:String(polled.data?.message||polled.data?.error||"Provider status request failed")}).eq("id",job.id).eq("user_id",user.id);
     return json({status:"FAILED",render_job_id:job.id,error_code:retryable?"RETRY_LIMIT_EXCEEDED":"PROVIDER_STATUS_ERROR"},502);
   }
   const next=new Date(Date.now()+Math.min(15*60*1000,Math.pow(2,attempts)*5000)).toISOString();
   await db.from("render_jobs").update({status:"QUEUED",attempt_number:attempts+1,next_retry_at:next,last_error:"Provider status request transient failure"}).eq("id",job.id).eq("user_id",user.id);
   return json({status:"QUEUED",render_job_id:job.id,next_retry_at:next},202);
 }
 const resp=polled.data?.response||polled.data||{}; const mapped=providerRenderStatus(String(resp.status||"queued"));
 if(mapped==="FAILED"){
   await db.from("render_jobs").update({status:"FAILED",provider_status:String(resp.status||"failed"),error_code:"PROVIDER_RENDER_FAILED",last_error:String(resp.error||"Provider render failed"),completed_at:now()}).eq("id",job.id).eq("user_id",user.id);
   await db.from("production_runs").update({render_status:"FAILED",current_stage:"assembly"}).eq("id",runId).eq("user_id",user.id);
   await audit(db,user.id,"render_failed","render_job",job.id,{provider:"shotstack",provider_job_id:job.provider_job_id,error:String(resp.error||"Provider render failed")});
   return json({status:"FAILED",render_job_id:job.id,error_code:"PROVIDER_RENDER_FAILED"},200);
 }
 if(mapped!=="COMPLETED"){
   await db.from("render_jobs").update({status:mapped,provider_status:String(resp.status||"processing"),started_at:job.started_at||now()}).eq("id",job.id).eq("user_id",user.id);
   await db.from("production_runs").update({render_status:mapped,current_stage:"assembly"}).eq("id",runId).eq("user_id",user.id);
   return json({status:mapped,render_job_id:job.id,provider_status:resp.status},200);
 }
 const outputUrl=String(resp.url||""); if(!outputUrl)return json({status:"PROCESSING",render_job_id:job.id,error_code:"PROVIDER_OUTPUT_NOT_READY"},202);
 const probed=await shotstackRequest(cfg.base+"/probe/"+encodeURIComponent(outputUrl),cfg.apiKey,{method:"GET"});
 const probe=probed.ok?(probed.data?.response||probed.data||null):null;
 if(!probe){await db.from("render_jobs").update({status:"FAILED",error_code:"FINAL_MEDIA_PROBE_FAILED",last_error:"Provider could not inspect the completed media."}).eq("id",job.id).eq("user_id",user.id);return json({status:"FAILED",render_job_id:job.id,error_code:"FINAL_MEDIA_PROBE_FAILED"},502);}

 try{
   const asset=await persistRenderedAsset(db,user.id,runId,job.id,outputUrl,resp,probe);
   await db.from("render_jobs").update({status:"COMPLETED",provider_status:"done",asset_id:asset.id,completed_at:now(),last_error:null}).eq("id",job.id).eq("user_id",user.id);
   await db.from("production_runs").update({render_status:"COMPLETED",current_stage:"final_qa",final_asset_id:asset.id}).eq("id",runId).eq("user_id",user.id);
   await audit(db,user.id,"render_completed","render_job",job.id,{provider:"shotstack",provider_job_id:job.provider_job_id,asset_id:asset.id});
   return json({status:"COMPLETED",render_job_id:job.id,asset_id:asset.id},200);
 }catch(e:any){
   await db.from("render_jobs").update({status:"FAILED",error_code:"FINAL_ASSET_PERSIST_FAILED",last_error:String(e?.message||"Failed to persist rendered asset"),completed_at:now()}).eq("id",job.id).eq("user_id",user.id);
   return json({status:"FAILED",render_job_id:job.id,error_code:"FINAL_ASSET_PERSIST_FAILED"},500);
 }
}
if(body.action==="generate_captions"){
 const runId=String(body.production_run_id||"").trim();
 if(!runId)return json({error:"production_run_id is required"},400);
 const {data:run}=await db.from("production_runs").select("*").eq("id",runId).eq("user_id",user.id).maybeSingle();
 if(!run)return json({error:"Production run not found"},404);
 const {data:scriptStage}=await db.from("production_stage_outputs").select("output").eq("production_run_id",runId).eq("user_id",user.id).eq("stage","writing").order("created_at",{ascending:false}).limit(1).maybeSingle();
 const script=String(scriptStage?.output?.script?.spoken_script||"").trim();
 if(!script)return json({error:"No spoken script available"},409);
 const words=script.split(/\s+/).filter(Boolean); const rawDuration=Number(run.brief?.duration_seconds); const duration=Number.isFinite(rawDuration)&&rawDuration>0?rawDuration:60;
 const chunk=Math.max(1,Math.ceil(words.length/Math.max(1,Math.ceil(duration/3))));
 const cues:any[]=[]; for(let i=0;i<words.length;i+=chunk){const part=words.slice(i,i+chunk);const start=Math.min(duration-0.1,(i/words.length)*duration);const end=Math.min(duration,(Math.min(words.length,i+chunk)/words.length)*duration);cues.push({start:Math.round(start*100)/100,end:Math.round(Math.max(start+0.2,end)*100)/100,text:part.join(" ")});}
 const ins=await db.from("caption_tracks").insert({user_id:user.id,production_run_id:runId,content_id:run.content_id,language:run.brief?.language==="English"?"en":"en",format:"webvtt",status:"READY",cues,source:"script_deterministic_v1"}).select("id").single();
 if(ins.error)return json({status:"FAILED",error:"CAPTION_PERSIST_FAILED"},500);
 await db.from("production_runs").update({caption_track_id:ins.data.id,render_status:"QUEUED",current_stage:"assembly"}).eq("id",runId).eq("user_id",user.id);
 await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:runId,stage:"captions",output:{caption_track_id:ins.data.id,cue_count:cues.length},provider:"operator_creator",model:"deterministic_caption_v1",attempt:1,status:"COMPLETED"});
 await audit(db,user.id,"captions_generated","production_run",runId,{caption_track_id:ins.data.id,cue_count:cues.length});
 return json({status:"COMPLETED",production_run_id:runId,caption_track_id:ins.data.id,cues});
}
if(body.action==="generate_voice"){
 const runId=String(body.production_run_id||"").trim(); const sourceAssetId=String(body.source_asset_id||"").trim();
 if(!runId||!sourceAssetId)return json({error:"production_run_id and source_asset_id are required"},400);
 const {data:run}=await db.from("production_runs").select("*").eq("id",runId).eq("user_id",user.id).maybeSingle();
 if(!run)return json({error:"Production run not found"},404);
 const {data:consent}=await db.from("voice_consents").select("id,consent_type,granted_at,revoked_at").eq("user_id",user.id).eq("asset_id",sourceAssetId).is("revoked_at",null).order("granted_at",{ascending:false}).limit(1).maybeSingle();
 if(!consent)return json({status:"VOICE_CONSENT_REQUIRED",message:"An active voice consent record is required before voice generation."},403);
 const providerName=Deno.env.get("VOICE_PROVIDER")||"";
 if(!providerName)return json({status:"PROVIDER_NOT_CONFIGURED",message:"Voice provider is not configured. Consent was verified, but no voice provider was called."},200);
 await db.from("production_stage_outputs").insert({user_id:user.id,production_run_id:runId,stage:"voice_generation",output:{status:"PROVIDER_NOT_CONFIGURED",consent_id:consent.id},provider:providerName,attempt:1,status:"BLOCKED"});
 return json({status:"PROVIDER_NOT_CONFIGURED",message:"Voice provider adapter is not configured yet.",consent_verified:true},200);
}
if(body.action==="generate_image"){
 const prompt=String(body.prompt||"").trim(); if(!prompt)return json({error:"prompt is required"},400);
 const open=Deno.env.get("OPENAI_API_KEY"); if(!open)return json({status:"PROVIDER_NOT_CONFIGURED",message:"Image provider is not configured."},200);
 const c=new AbortController(); const t=setTimeout(()=>c.abort(),90000);
 try{
  const rr=await fetch("https://api.openai.com/v1/images/generations",{method:"POST",signal:c.signal,headers:{"Authorization":"Bearer "+open,"Content-Type":"application/json"},body:JSON.stringify({model:Deno.env.get("OPENAI_IMAGE_MODEL")||"gpt-image-2",prompt,size:body.size||"1024x1024",quality:body.quality||"medium",output_format:"png"})});
  const data=await rr.json().catch(()=>({})); if(!rr.ok)return json({status:"FAILED",provider:"openai",error:classify(rr.status,false).code},rr.status);
  const b64=data?.data?.[0]?.b64_json; if(!b64)return json({status:"FAILED",error:"Image provider returned no image data"},502);
  const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0)); const path=user.id+"/generated/"+crypto.randomUUID()+".png";
  const up=await db.storage.from("creator-assets").upload(path,bytes,{contentType:"image/png",upsert:false}); if(up.error)return json({status:"FAILED",error:"Asset storage failed"},500);
  const asset=(await db.from("assets").insert({user_id:user.id,storage_path:path,asset_type:"image",mime_type:"image/png",file_size_bytes:bytes.byteLength,status:"READY",metadata:{provider:"openai",model:Deno.env.get("OPENAI_IMAGE_MODEL")||"gpt-image-2",prompt}}).select("*").single()).data;
  await db.from("usage_events").insert({user_id:user.id,event_type:"image_generation",provider:"openai",metadata:{model:Deno.env.get("OPENAI_IMAGE_MODEL")||"gpt-image-2",asset_id:asset?.id}}).catch(()=>{});
  return json({status:"COMPLETED",asset});
 }catch(e:any){return json({status:"FAILED",error:e?.name==="AbortError"?"IMAGE_PROVIDER_TIMEOUT":"IMAGE_PROVIDER_ERROR"},502)}finally{clearTimeout(t)}
}
if(body.action==="generate_audio"){
 const runId=String(body.production_run_id||"").trim(); if(!runId)return json({error:"production_run_id is required"},400);
 const {data:run}=await db.from("production_runs").select("*").eq("id",runId).eq("user_id",user.id).maybeSingle(); if(!run)return json({error:"Production run not found"},404);
 const provider=Deno.env.get("AUDIO_PROVIDER")||"";
 if(!provider)return json({status:"PROVIDER_NOT_CONFIGURED",message:"Audio/music provider is not configured."},200);
 return json({status:"PROVIDER_NOT_CONFIGURED",message:"Audio provider adapter is not implemented yet; no audio was fabricated."},200);
}
if(body.action==="validate_publish"){
 const contentId=String(body.content_id||"").trim(); const runId=body.production_run_id?String(body.production_run_id).trim():null; const platform=String(body.platform||"").trim().toLowerCase();
 if(!contentId||!platform)return json({error:"content_id and platform are required"},400);
 const validation=await validatePlatformForPublishing(db,user.id,contentId,platform,runId);
 return json({status:validation.valid?"VALID":"BLOCKED",platform,errors:validation.errors},validation.valid?200:409);
}
if(body.action==="publish"){
 const contentId=String(body.content_id||"").trim(); const runId=body.production_run_id?String(body.production_run_id).trim():null; const platform=String(body.platform||"").trim().toLowerCase();
 if(!contentId||!platform)return json({error:"content_id and platform are required"},400);
 const validation=await validatePlatformForPublishing(db,user.id,contentId,platform,runId);
 if(!validation.valid)return json({status:"BLOCKED",errors:validation.errors},409);
 const idempotencyKey=String(body.idempotency_key||("publish:"+user.id+":"+contentId+":"+platform+":"+(runId||"none"))).slice(0,240);
 const existing=(await db.from("publishing_attempts").select("*").eq("user_id",user.id).eq("idempotency_key",idempotencyKey).maybeSingle()).data;
 if(existing){
   if(existing.status==="PUBLISHED")return json({status:"PUBLISHED",publishing_attempt_id:existing.id,external_post_id:existing.external_post_id},200);
   if(existing.status==="PROCESSING"||existing.status==="QUEUED")return json({status:existing.status,publishing_attempt_id:existing.id},202);
   if(existing.status==="CANCELLED")return json({status:"CANCELLED",publishing_attempt_id:existing.id},409);
 }
 let attempt=existing;
 if(!attempt){
   const ins=await db.from("publishing_attempts").insert({user_id:user.id,production_run_id:runId,content_id:contentId,platform,idempotency_key:idempotencyKey,status:"QUEUED"}).select("*").single();
   if(ins.error){
     const race=(await db.from("publishing_attempts").select("*").eq("user_id",user.id).eq("idempotency_key",idempotencyKey).maybeSingle()).data;
     if(race)return json({status:race.status,publishing_attempt_id:race.id,external_post_id:race.external_post_id||null},200);
     return json({status:"FAILED",error_code:"PUBLISH_ATTEMPT_CREATE_FAILED"},500);
   }
   attempt=ins.data;
 }
 const publisher=Deno.env.get("PUBLISH_PROVIDER")||"";
 if(!publisher){
   await db.from("publishing_attempts").update({status:"PROVIDER_NOT_CONFIGURED",error_code:"PUBLISH_PROVIDER_NOT_CONFIGURED",error_message:"No publishing provider is configured."}).eq("id",attempt.id).eq("user_id",user.id);
   return json({status:"PROVIDER_NOT_CONFIGURED",publishing_attempt_id:attempt.id,message:"Publishing provider is not configured; nothing was published."},200);
 }
 await db.from("publishing_attempts").update({status:"PROCESSING",attempt_number:Number(attempt.attempt_number||1)}).eq("id",attempt.id).eq("user_id",user.id);
 await audit(db,user.id,"publishing_provider_unavailable","publishing_attempt",attempt.id,{platform,publisher});
 await db.from("publishing_attempts").update({status:"FAILED",error_code:"PUBLISHER_ADAPTER_NOT_IMPLEMENTED",error_message:"The configured publisher adapter is not implemented. No external publish call was made."}).eq("id",attempt.id).eq("user_id",user.id);
 return json({status:"FAILED",publishing_attempt_id:attempt.id,error_code:"PUBLISHER_ADAPTER_NOT_IMPLEMENTED"},200);
}
if(body.action==="cancel_publish"){
 const attemptId=String(body.publishing_attempt_id||"").trim(); if(!attemptId)return json({error:"publishing_attempt_id is required"},400);
 const {data:attempt}=await db.from("publishing_attempts").select("*").eq("id",attemptId).eq("user_id",user.id).maybeSingle();
 if(!attempt)return json({error:"Publishing attempt not found"},404);
 if(["PUBLISHED","CANCELLED"].includes(attempt.status))return json({status:attempt.status,publishing_attempt_id:attempt.id},409);
 await db.from("publishing_attempts").update({status:"CANCELLED",error_code:"CANCELLED_BY_USER",error_message:"Publishing operation cancelled before external completion."}).eq("id",attempt.id).eq("user_id",user.id);
 return json({status:"CANCELLED",publishing_attempt_id:attempt.id},200);
}
if(body.action==="production"){const prompt=String(body.prompt||"").trim();const workflow=(await db.from("workflows").insert({user_id:user.id,prompt,status:"QUEUED",metadata:{orchestrator:"ai-orchestrator",pipeline:true}}).select("*").single()).data;if(!workflow)return json({error:"Workflow creation failed"},500);let content=body.content_id?{id:body.content_id}:null;if(!content){content=(await db.from("content").insert({user_id:user.id,brand_id:body.brand_id||null,title:prompt.slice(0,120),content_type:"production_project",status:"QUEUED",platform:brief(prompt,body.brand_context).platform,prompt,metadata:{pipeline:true}}).select("id").single()).data}
const result=await runPipeline(db,user,prompt,workflow.id,content?.id||null,body.brand_context||null);await db.from("workflows").update({status:result.status==="ready"?"COMPLETED":result.status==="PROVIDER_NOT_CONFIGURED"?"QUEUED":"FAILED",metadata:{pipeline:true,production_run_id:result.production_run_id}}).eq("id",workflow.id).eq("user_id",user.id);return json({workflow_id:workflow.id,content_id:content?.id||null,...result})}
return json({error:"Use action=production for the production pipeline."},400)});