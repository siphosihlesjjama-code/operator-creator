export type Session={access_token:string;refresh_token?:string;user:{id:string;email?:string}};
const KEY="oc_session";
export function readSession():Session|null{try{return JSON.parse(localStorage.getItem(KEY)||"null")}catch{return null}}
export function writeSession(s:Session|null){if(s)localStorage.setItem(KEY,JSON.stringify(s));else localStorage.removeItem(KEY)}
