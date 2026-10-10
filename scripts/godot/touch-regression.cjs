/* Real touch drags, finger release ordering, stored preferences, and rotation. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.GAME_URL||'http://127.0.0.1:8765/?quality=low';
const output=process.env.GAME_TEST_OUTPUT||'test-results/godot/touch-regression';
fs.mkdirSync(output,{recursive:true});
let checks=0;
const check=(ok,message)=>{assert.ok(ok,message);checks++;console.log('PASS',message)};
const state=p=>p.evaluate(()=>window.tidelockState);
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',proxy:process.env.BROWSER_PROXY?{server:process.env.BROWSER_PROXY}:undefined,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const errors=[];
 try{
 for(const viewport of [{width:915,height:412},{width:740,height:360}]){
  const context=await browser.newContext({viewport,hasTouch:true,isMobile:true,deviceScaleFactor:2});
  const page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.addInitScript(()=>{if(!localStorage.getItem('touch-regression-seeded')){localStorage.setItem('tidelock-settings-v1',JSON.stringify({touch:false,sound:false}));localStorage.setItem('touch-regression-seeded','1')}});
  await page.goto(base);await page.waitForFunction(()=>window.tidelockState?.mode==='title',null,{timeout:90000});
  check((await state(page)).touch,`${viewport.width}: physical touch overrides stale disabled preference`);
  const cdp=await context.newCDPSession(page);
  const b=await page.locator('canvas').boundingBox();
  async function point(x,y,id){const scale=Math.min(b.width/1280,b.height/720);return{x:b.x+(b.width-1280*scale)/2+x*scale,y:b.y+(b.height-720*scale)/2+y*scale,id};}
  async function touches(type,points){await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:await Promise.all(points.map(([x,y,id])=>point(x,y,id)))});}
  async function tap(x,y){const p=await point(x,y,1);await page.touchscreen.tap(p.x,p.y);}
  await tap(240,410);await page.waitForFunction(()=>window.tidelockState?.mode==='playing');
  await page.screenshot({path:`${output}/start-${viewport.width}.png`});
  for(const [label,dx,dy] of [['right',1,0],['left',-1,0],['backward',0,1],['forward',0,-1]]){
   const before=(await state(page)).position;
   await touches('touchStart',[[124,586,1]]);await touches('touchMove',[[124+dx*62,586+dy*62,1]]);await page.waitForTimeout(450);
   await touches('touchEnd',[]);await page.waitForTimeout(250);
   const after=await state(page),travel=(after.position[0]-before[0])*dx+(after.position[1]-before[1])*dy;
   check(travel>25,`${viewport.width}: drag moves ${label}`);
   check(Math.hypot(...after.stick)<0.01,`${viewport.width}: ${label} release stops stick`);
  }
  // A thumb placed outside the old fixed circle creates a usable floating stick.
  let before=await state(page);
  await touches('touchStart',[[340,560,1]]);await touches('touchMove',[[402,560,1]]);await page.waitForTimeout(350);await touches('touchEnd',[]);await page.waitForTimeout(250);
  check((await state(page)).position[0]>before.position[0]+20,`${viewport.width}: floating stick works away from old circle`);
  // Lower right used to be a dead area. Rotate both ways, release look first, keep moving.
  before=await state(page);
  await touches('touchStart',[[124,586,1],[760,565,2]]);
  await touches('touchMove',[[186,586,1],[820,565,2]]);await page.waitForFunction(y=>window.tidelockState.yaw<y-0.1,before.yaw);
  check((await state(page)).yaw<before.yaw-0.1,`${viewport.width}: lower-right swipe turns right while moving`);
  await touches('touchMove',[[186,586,1],[700,565,2]]);await page.waitForFunction(y=>window.tidelockState.yaw>y+0.1,before.yaw);
  check((await state(page)).yaw>before.yaw+0.1,`${viewport.width}: swipe turns left`);
  await touches('touchMove',[[186,586,1],[760,565,2]]);await page.waitForTimeout(250);
  await touches('touchEnd',[[760,565,2]]);await page.waitForTimeout(180);
  const held=await state(page);await page.waitForTimeout(350);const continuing=await state(page);
  check(held.move_touch>=0&&continuing.position[0]>held.position[0]+20,`${viewport.width}: releasing look thumb does not cancel movement`);
  await touches('touchEnd',[]);await page.waitForTimeout(200);
  check((await state(page)).move_touch===-1&&(await state(page)).look_touch===-1,`${viewport.width}: both finger owners released`);
  // Releasing movement first must leave the camera controllable.
  await touches('touchStart',[[124,586,1],[780,310,2]]);await touches('touchEnd',[[124,586,1]]);
  before=await state(page);await touches('touchMove',[[840,310,2]]);await page.waitForFunction(y=>window.tidelockState.yaw<y-0.1,before.yaw);
  check((await state(page)).yaw<before.yaw-0.1,`${viewport.width}: look survives movement-thumb release`);
  await touches('touchEnd',[]);
  await page.screenshot({path:`${output}/touch-${viewport.width}.png`});
  await touches('touchStart',[[186,586,1]]);await page.setViewportSize({width:412,height:915});await page.waitForTimeout(300);await touches('touchEnd',[]);await page.setViewportSize(viewport);await page.waitForTimeout(400);
  check((await state(page)).move_touch===-1&&Math.hypot(...(await state(page)).stick)<0.01,`${viewport.width}: screen rotation cancels held movement`);
  await context.close();
 }
 check(errors.length===0,'no touch or shader runtime errors: '+errors.join('\n'));
 fs.writeFileSync(output+'/results.json',JSON.stringify({checks,errors},null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
