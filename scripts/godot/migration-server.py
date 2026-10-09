import http.server,pathlib,os
root=pathlib.Path(__file__).resolve().parents[2] / 'dist'
phase=pathlib.Path(os.environ.get('TIDELOCK_MIGRATION_PHASE','/tmp/tidelock-migration-phase'))
old="""self.addEventListener('install',e=>e.waitUntil(caches.open('workbox-precache-v2-'+self.registration.scope).then(c=>c.put(self.registration.scope,new Response('<html><head><link rel="icon" href="index.icon.png"></head><body>OLD TIDELOCK TITLE</body></html>',{headers:{'Content-Type':'text/html'}})))));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(caches.match(self.registration.scope));});"""
class Handler(http.server.SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(root),**kwargs)
 def do_GET(self):
  if self.path=='/sw.js' and phase.read_text()=='old':
   data=old.encode();self.send_response(200);self.send_header('Content-Type','application/javascript');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
  else:super().do_GET()
 def log_message(self,*args):pass
phase.write_text('old')
http.server.ThreadingHTTPServer(('127.0.0.1',8766),Handler).serve_forever()
