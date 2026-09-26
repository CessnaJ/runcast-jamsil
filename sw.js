// Offline app shell only. Weather and third-party maps are never intercepted.
const CACHE = 'runcast-shell-v7';
const SHELL = ['/mobile.html','/assets/mobile.css','/assets/mobile.js','/assets/mobile-extra.js','/assets/refresh-scheduler.mjs','/assets/weather-domain.mjs','/assets/ui-icons.mjs','/manifest.webmanifest','/assets/pwa-icon-192.png','/assets/pwa-icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('runcast-shell-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!SHELL.includes(url.pathname))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(url.pathname,copy)));}
    return response;
  }).catch(()=>caches.match(url.pathname).then(response=>response||Response.error())));
});
