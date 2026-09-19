import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const headers={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization,apikey,content-type","Access-Control-Allow-Methods":"POST,OPTIONS"};
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers});
const ALLOWED:any={
 image:new Set(["image/jpeg","image/png","image/webp","image/gif"]),
 video:new Set(["video/mp4","video/webm","video/quicktime"]),
 audio:new Set(["audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/aac","audio/ogg","audio/webm"]),
};
const LIMITS:any={image:25*1024*1024,video:500*1024*1024,audio:100*1024*1024};

Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers});
 if(req.method!=="POST")return json({error:"METHOD_NOT_ALLOWED"},405);
 const auth=req.headers.get("Authorization"); if(!auth)return json({error:"UNAUTHORIZED"},401);
 const url=Deno.env.get("SUPABASE_URL")!;
 const key=Deno.env.get("SUPABASE_ANON_KEY")||Deno.env.get("SUPABASE_PUBLISHABLE_KEY")||"";
 const db=createClient(url,key,{global:{headers:{Authorization:auth}}});
 const {data:{user},error}=await db.auth.getUser(); if(error||!user)return json({error:"UNAUTHORIZED"},401);
 const body=await req.json().catch(()=>null);
 const path=String(body?.storage_path||"").replace(/^\/+/, "");
 const assetType=String(body?.asset_type||"").toLowerCase();
 const requestedMime=String(body?.mime_type||"").toLowerCase();
 if(!path||!path.startsWith(user.id+"/"))return json({error:"INVALID_STORAGE_PATH"},400);
 if(!ALLOWED[assetType]||!requestedMime||!ALLOWED[assetType].has(requestedMime)){await cleanup();return json({error:"UNSUPPORTED_MEDIA_TYPE"},400);}
 const secretRaw=Deno.env.get("SUPABASE_SECRET_KEYS");const serviceKey=secretRaw?JSON.parse(secretRaw).default:Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
 const admin=serviceKey?createClient(url,serviceKey):null;
 const cleanup=async()=>{if(admin)await admin.storage.from("creator-assets").remove([path]);};
 const {data:obj,error:objError}=admin?await admin.schema("storage").from("objects").select("name,bucket_id,owner_id,metadata").eq("bucket_id","creator-assets").eq("name",path).maybeSingle():{data:null,error:new Error("SUPABASE_SERVICE_NOT_CONFIGURED")};
 if(objError||!obj)return json({error:"UPLOADED_OBJECT_NOT_FOUND"},404);
 if(obj.owner_id&&obj.owner_id!==user.id){await cleanup();return json({error:"STORAGE_OWNERSHIP_MISMATCH"},403);}
 const metadata=obj.metadata||{};
 const actualMime=String(metadata.mimetype||metadata.mimeType||"").toLowerCase();
 const actualSize=Number(metadata.size||0);
 if(actualMime&&!ALLOWED[assetType].has(actualMime)){await cleanup();return json({error:"STORED_MIME_TYPE_NOT_ALLOWED"},400);}
 if(!Number.isFinite(actualSize)||actualSize<=0||actualSize>LIMITS[assetType]){await cleanup();return json({error:"STORED_FILE_SIZE_INVALID"},400);}
 if(requestedMime!==actualMime&&actualMime){await cleanup();return json({error:"MIME_TYPE_MISMATCH"},400);}
 const existing=(await db.from("assets").select("id,status,storage_path,asset_type,mime_type,file_size_bytes").eq("user_id",user.id).eq("storage_path",path).maybeSingle()).data;
 if(existing)return json({status:"ALREADY_REGISTERED",asset:existing},200);
 const {data:asset,error:insertError}=await db.from("assets").insert({
   user_id:user.id,storage_path:path,asset_type:assetType,mime_type:actualMime||requestedMime,
   file_size_bytes:actualSize,status:"READY",metadata:{registered_by:"register-asset",validated:true}
 }).select("id,storage_path,asset_type,mime_type,file_size_bytes,status").single();
 if(insertError)return json({error:"ASSET_REGISTRATION_FAILED",details:insertError.message},500);
 return json({status:"REGISTERED",asset},201);
});