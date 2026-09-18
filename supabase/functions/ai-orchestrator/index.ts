import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const sha=async(v:string)=>{const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")};

function workersFor(prompt:string,available:any[]){
  const p=prompt.toLowerCase(), keys=new Set<string>(["creative_strategist"]);
  if(/video|youtube|tiktok|reel|short|film|ad/.test(p)) keys.add("video_creator");
  if(/thumbnail|image|logo|design|visual|graphic/.test(p)) keys.add("brand_designer");
  if(/voice|narrat|dub|vocal/.test(p)) keys.add("voice_creator");
  if(/music|song|beat|soundtrack|amapiano/.test(p)) keys.add("music_creator");
  if(/script|caption|copy|hook|title|description|lyrics/.test(p)) keys.add("copywriter");
  if(/social|instagram|facebook|linkedin|twitter|x\.com|pinterest|publish|schedule/.test(p)) keys.add("social_manager");
  if(/growth|analytics|performance|audience|engagement|metrics/.test(p)) keys.add("growth_analyst");
  const enabled=new Set(available.filter(w=>w.enabled).map(w=>w.key));
  return [...keys].filter(k=>enabled.has(k));
}
async function openaiText(key:string,prompt:string,worker:string){
  const c=new AbortController();const t=setTimeout(()=>c.abort(),30000);
  try{
    const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",signal:c.signal,
      headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},
      body:JSON.stringify({model:Deno.env.get("OPENAI_TEXT_MODEL")||"gpt-5-mini",
        input:[{role:"system",content:[{type:"input_text",text:"You are the "+worker+" worker in Operator Creator. Produce useful production-ready text. Never claim media was generated unless a media provider actually generated it."}]},
               {role:"user",content:[{type:"input_text",text:prompt}]}]})});
    const d=await r.json().catch(()=>({}));
    if(!r.ok)throw Object.assign(new Error(d?.error?.message||"OpenAI request failed"),{status:r.status});
    return d.output_text||"";
  }finally{clearTimeout(t)}
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
  const auth=req.headers.get("Authorization");
  if(!auth?.startsWith("Bearer "))return json({error:"UNAUTHORIZED_NO_AUTH_HEADER"},401);
  const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!;
  const db=createClient(url,anon,{global:{headers:{Authorization:auth}}});
  const {data:{user},error:ue}=await db.auth.getUser();
  if(ue||!user)return json({error:"UNAUTHORIZED"},401);
  const body=await req.json().catch(()=>null);
  if(!body?.prompt&&!body?.task_id)return json({error:"PROMPT_OR_TASK_REQUIRED"},400);
  const {data:defs,error:de}=await db.from("worker_definitions").select("*").eq("enabled",true);
  if(de)return json({error:"WORKER_REGISTRY_FAILED",detail:de.message},500);
  const prompt=String(body.prompt||"");
  let workflowId=body.workflow_id||null,contentId=body.content_id||null;
  if(!workflowId){
    const {data:w,error:e}=await db.from("workflows").insert({user_id:user.id,prompt,status:"QUEUED",metadata:{orchestrator:"ai-orchestrator"}}).select().single();
    if(e)return json({error:"WORKFLOW_CREATE_FAILED",detail:e.message},500); workflowId=w.id;
  }
  if(!contentId){
    const {data:c,error:e}=await db.from("content").insert({user_id:user.id,title:prompt.slice(0,120)||"Operator Creator output",content_type:"production_request",status:"QUEUED",prompt,metadata:{workflow_id:workflowId}}).select().single();
    if(e)return json({error:"CONTENT_CREATE_FAILED",detail:e.message},500); contentId=c.id;
  }
  const keys=workersFor(prompt,defs||[]),apiKey=Deno.env.get("OPENAI_API_KEY")||"",results:any[]=[];
  for(let i=0;i<keys.length;i++){
    const key=keys[i],def=(defs||[]).find(w=>w.key===key);
    const external=["social_manager","voice_creator"].includes(key)||/\b(publish|post|schedule|upload)\b/i.test(prompt);
    const idem=await sha(workflowId+":"+key+":"+prompt);
    const {data:old}=await db.from("ai_worker_tasks").select("*").eq("user_id",user.id).eq("idempotency_key",idem).maybeSingle();
    if(old){results.push({worker:key,task_id:old.id,status:old.status});continue}
    const {data:task,error:te}=await db.from("ai_worker_tasks").insert({user_id:user.id,workflow_id:workflowId,worker_key:key,task_type:def?.task_type||"text",prompt,status:"QUEUED",idempotency_key:idem,metadata:{external_action:external}}).select().single();
    if(te){results.push({worker:key,status:"FAILED",error:te.message});continue}
    await db.from("workflow_steps").insert({user_id:user.id,workflow_id:workflowId,worker:key,step_order:i+1,status:"QUEUED",task_id:task.id,metadata:{external_action:external}});
    if(external||!["creative_strategist","copywriter"].includes(key)||!apiKey){
      const reason=external?"approval_or_oauth_required":!apiKey?"provider_not_configured":"worker_provider_not_configured";
      await db.from("ai_worker_tasks").update({status:"PROVIDER_NOT_CONFIGURED",completed_at:new Date().toISOString(),error_message:reason}).eq("id",task.id);
      results.push({worker:key,task_id:task.id,status:"PROVIDER_NOT_CONFIGURED",reason});continue;
    }
    await db.from("ai_worker_tasks").update({status:"PROCESSING",started_at:new Date().toISOString()}).eq("id",task.id);
    try{
      const output=await openaiText(apiKey,prompt,key);
      const {data:v}=await db.from("content_versions").insert({user_id:user.id,content_id:contentId,version_number:1,body:output,metadata:{worker:key,task_id:task.id}}).select().single();
      await db.from("ai_worker_tasks").update({status:"COMPLETED",completed_at:new Date().toISOString(),output:{text:output,content_version_id:v?.id||null}}).eq("id",task.id);
      await db.from("workflow_steps").update({status:"COMPLETED",completed_at:new Date().toISOString()}).eq("task_id",task.id);
      results.push({worker:key,task_id:task.id,status:"COMPLETED",output});
    }catch(e:any){
      const retryable=[408,409,429,500,502,503,504].includes(e?.status||500);
      await db.from("ai_worker_tasks").update({status:"FAILED",completed_at:new Date().toISOString(),error_message:e?.message||"Provider failure",metadata:{retryable}}).eq("id",task.id);
      await db.from("workflow_steps").update({status:"FAILED",completed_at:new Date().toISOString()}).eq("task_id",task.id);
      results.push({worker:key,task_id:task.id,status:"FAILED",retryable,error:e?.message||"Provider failure"});
    }
  }
  const failed=results.some(x=>x.status==="FAILED"),done=results.some(x=>x.status==="COMPLETED");
  await db.from("workflows").update({status:failed&&!done?"FAILED":"PROCESSING",metadata:{orchestrator:"ai-orchestrator",worker_count:results.length}}).eq("id",workflowId).eq("user_id",user.id);
  await db.from("audit_events").insert({user_id:user.id,event_type:"workflow_orchestrated",entity_type:"workflow",entity_id:workflowId,metadata:{workers:keys,results:results.map(x=>({worker:x.worker,status:x.status}))}});
  return json({workflow_id:workflowId,content_id:contentId,results});
});
