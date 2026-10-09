/* Check legacy cache migration and corrupt-checkpoint recovery. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const phase=process.env.TIDELOCK_MIGRATION_PHASE || '/tmp/tidelock-migration-phase';
fs.mkdirSync('test-results/godot',{recursive:true});
fs.writeFileSync(phase,'old');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH===undefined?'/usr/bin/chromium':(process.env.CHROMIUM_PATH||undefined),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try {
 const page=await browser.newPage({viewport:{width:800,height:450}});
 page.setDefaultTimeout(90000);
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.goto('http://127.0.0.1:8766/?quality=low');
 await page.waitForFunction(()=>window.tidelockState?.mode==='title');
 await page.evaluate(async()=>{
  await caches.open('unrelated-project');
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
 });
 await page.reload();
 await page.waitForFunction(()=>document.body.textContent.includes('OLD TIDELOCK TITLE'));
 fs.writeFileSync(phase,'new');
 await page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration();await reg.update()});
 await page.waitForFunction(()=>window.tidelockState?.mode==='title',null,{timeout:90000});
 assert.equal(await page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).length),0);
 assert(await page.evaluate(async()=>(await caches.keys()).includes('unrelated-project')));
 assert(!(await page.evaluate(async()=>(await caches.keys()).some(n=>n.startsWith('workbox-')))));
 console.log('PASS cached legacy title upgrades without deleting unrelated caches');
 await page.mouse.click(505*0.625,540*0.625);
 await page.waitForFunction(()=>window.tidelockState.mode==='credits');
 await page.screenshot({path:'test-results/godot/credits.png'});
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>window.tidelockState.mode==='title');
 console.log('PASS credits and keyboard return');
 await page.evaluate(()=>localStorage.setItem('tidelock-harbor-v1','broken-json'));
 await page.reload();await page.waitForFunction(()=>window.tidelockState?.has_save);
 await page.mouse.click(240*0.625,478*0.625);
 await page.waitForFunction(()=>window.tidelockState?.notice||!window.tidelockState?.has_save);
 assert.equal((await page.evaluate(()=>window.tidelockState)).mode,'title');
 await page.screenshot({path:'test-results/godot/corrupt-checkpoint.png'});
 console.log('PASS corrupt checkpoint offers a new mission');
 assert.equal(errors.length,0,errors.join('\n'));
 fs.writeFileSync('test-results/godot/migration-results.json',JSON.stringify({legacyCacheUpgrade:true,otherCachesPreserved:true,credits:true,corruptSaveRecovery:true,errors},null,2));
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
