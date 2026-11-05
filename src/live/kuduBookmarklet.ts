/**
 * The "Logsift for Kudu" bookmarklet: run on an App Service's Kudu site, it opens Logsift and answers
 * its requests to list folders and read files with Kudu's VFS API (GET only), using the user's Kudu
 * sign-in. It only answers the Logsift window it opened, only from Logsift's origin, and refuses paths
 * with "..". It reads log files only (see isKuduLogPath in kudu.ts, the same rule): even a Logsift page
 * that asked for more could not read the app's settings or secrets. The Kudu tab has to stay open while
 * Logsift watches.
 *
 * `kuduScript(origin)` is the code; `kuduBookmarklet(origin)` the javascript: link to drag to the bookmarks
 * bar. It is written as plain ES2017 so any current browser runs it.
 */
export function kuduScript(logsiftOrigin: string): string {
  const L = JSON.stringify(logsiftOrigin);
  return `(function(){
var L=${L},h=location.hostname;
if(!/\\.scm\\.([a-z0-9-]+\\.)?azurewebsites\\.net$/i.test(h)){alert("Logsift: click this bookmark on your app's Kudu site (Azure portal > App Service > Advanced Tools > Go).");return;}
if(window.__logsiftKudu&&!window.__logsiftKudu.closed){window.__logsiftKudu.focus();return;}
var app=h.split(".")[0];
var w=window.open(L+"/?source=kudu&app="+encodeURIComponent(app),"logsift-kudu");
if(!w){alert("Logsift: allow pop-ups for this site, then click the bookmark again.");return;}
window.__logsiftKudu=w;
var okPath=function(p){return typeof p==="string"&&p.split("/").indexOf("..")<0&&/^[\\w .()\\/-]*$/.test(p);};
var LOGEXT=/\\.(log|txt|csv|tsv|json|jsonl|ndjson|clef|xml|gz|zip)$/i,SECRET=/(appsettings|web\\.config|\\.config$|^\\.env|secret|password|connectionstring|credential)/i;
var okRead=function(p){if(!okPath(p))return false;var s=p.split("/").filter(Boolean),f=s.pop()||"";if(!LOGEXT.test(f)||SECRET.test(f))return false;return s[0]==="LogFiles"||s.some(function(x){return /log/i.test(x);});};
var vfs=function(p){return "/api/vfs/"+p.split("/").filter(Boolean).map(encodeURIComponent).join("/");};
window.addEventListener("message",function(e){
if(e.source!==w||e.origin!==L)return;
var m=e.data||{};
if(m.type==="logsift-ready"){w.postMessage({type:"logsift-hello",app:app},L);return;}
if(m.type!=="logsift-call")return;
var reply=function(o,t){o.type="logsift-reply";o.id=m.id;w.postMessage(o,L,t||[]);};
var fail=function(x){reply({ok:false,error:String(x&&x.message||x)});};
if(!okPath(m.path))return fail("bad path");
if(m.op==="list"){
fetch(vfs(m.path)+"/",{credentials:"include"}).then(function(r){if(!r.ok)throw new Error("Kudu answered "+r.status);return r.json();}).then(function(a){
reply({ok:true,data:a.map(function(x){return {name:x.name,size:x.size,mtime:x.mtime,dir:x.mime==="inode/directory"};})});}).catch(fail);
}else if(m.op==="read"){
if(!okRead(m.path))return fail("not a log file");
var s=+m.start,en=+m.end;
if(!(en>s))return reply({ok:true,data:new ArrayBuffer(0)});
fetch(vfs(m.path),{credentials:"include",headers:{Range:"bytes="+s+"-"+(en-1)}}).then(function(r){
if(!r.ok)throw new Error("Kudu answered "+r.status);
return r.arrayBuffer().then(function(b){return r.status===206?b:b.slice(s,en);});
}).then(function(b){reply({ok:true,data:b},[b]);}).catch(fail);
}else fail("bad request");
});
var d=document.createElement("div");
d.textContent="Logsift is reading logs through this tab: keep it open while you watch.";
d.style.cssText="position:fixed;z-index:99999;left:0;right:0;top:0;padding:6px 12px;font:13px sans-serif;background:#1d7a3a;color:#fff;text-align:center";
document.body.appendChild(d);
})();`;
}

/** The bookmark's address. */
export function kuduBookmarklet(logsiftOrigin: string): string {
  // Newlines are fine in the script but not in a URL; nothing in it needs more escaping than this.
  return `javascript:${encodeURIComponent(kuduScript(logsiftOrigin).replace(/\n/g, ''))}`;
}
