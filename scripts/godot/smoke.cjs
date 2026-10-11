/* Exercises the exported Godot game through real keyboard and multi-touch input.
   The read-only diagnostic state observes gameplay; it cannot mutate the game. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.GAME_URL || 'http://127.0.0.1:8765/?quality=low';
const output = process.env.GAME_TEST_OUTPUT || 'test-results/godot';
fs.mkdirSync(output,{recursive:true});
for(const name of ['results.json','failure.png']){const p=output+'/'+name;if(fs.existsSync(p))fs.unlinkSync(p);}
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
let checks=0;
function check(value,label){assert.ok(value,label);checks++;console.log('PASS',label);}
async function state(page){return page.evaluate(()=>window.tidelockState);}
async function mode(page,name){try{await page.waitForFunction(n=>window.tidelockState?.mode===n,name,{timeout:90000});}catch(e){console.log('FAILED MODE',name,await state(page));console.log('CHECKPOINT',await page.evaluate(()=>localStorage.getItem('tidelock-harbor-v1')));await page.screenshot({path:output+'/failure.png'});throw e;}}
async function tap(page,x,y){const box=await page.locator('canvas').boundingBox();const scale=Math.min(box.width/1280,box.height/720);const ox=box.x+(box.width-1280*scale)/2,oy=box.y+(box.height-720*scale)/2;await page.mouse.click(ox+x*scale,oy+y*scale);await page.waitForTimeout(180);}
function blocked(p,w,open){const has=(r,g=0)=>p[0]>=r[0]-g&&p[0]<=r[0]+r[2]+g&&p[1]>=r[1]-g&&p[1]<=r[1]+r[3]+g;
 if(!has(w.bounds,-19))return true;
 if(w.obstacles.some(r=>has(r,19)))return true;
 if(w.pumps.some(q=>distance(p,q)<49))return true;
 if(has(w.canal,19)&&!w.bridges.some(r=>has([r[0]+19,r[1]-19,r[2]-38,r[3]+38])))return true;
 return !open&&has([2020,1090,28,270],19);
}
function clear(a,b,w,open){const n=Math.ceil(distance(a,b)/8);for(let i=0;i<=n;i++)if(blocked([a[0]+(b[0]-a[0])*i/Math.max(n,1),a[1]+(b[1]-a[1])*i/Math.max(n,1)],w,open))return false;return true;}
function pathfind(start,target,w,open){const grid=30;const key=p=>p.join(',');let root=[Math.round(start[0]/grid),Math.round(start[1]/grid)];
 // The planner pads obstacles more than the game does, so Mara can stand inside the
 // padding (beside a pump); start from the nearest clear cell instead.
 if(blocked(root.map(v=>v*grid),w,open)){let best;for(let dx=-3;dx<=3;dx++)for(let dy=-3;dy<=3;dy++){const c=[root[0]+dx,root[1]+dy];if(!blocked(c.map(v=>v*grid),w,open)&&(!best||Math.hypot(dx,dy)<best[0]))best=[Math.hypot(dx,dy),c];}if(best)root=best[1];}const queue=[root];const prev=new Map([[key(root),null]]);let end;
 for(let cursor=0;cursor<queue.length;cursor++){const cell=queue[cursor],point=cell.map(v=>v*grid);
  if(distance(point,target)<42&&clear(point,target,w,open)){end=cell;break;}
  for(const d of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){const n=[cell[0]+d[0],cell[1]+d[1]],k=key(n);if(prev.has(k))continue;const np=n.map(v=>v*grid);if(clear(point,np,w,open)){prev.set(k,cell);queue.push(n);}}
 }
 assert.ok(end,`target ${target} has a navigable route from ${start}`);const points=[];for(let p=end;p;p=prev.get(key(p)))points.unshift(p.map(v=>v*grid));points.push(target);
 // Collapse straight sections; keep every turn and verify shortcut visibility.
 const result=[];let at=start;for(let i=0;i<points.length;){let far=i;while(far+1<points.length&&(()=>{const dx=Math.abs(points[far+1][0]-at[0]),dy=Math.abs(points[far+1][1]-at[1]);return dx<1||dy<1||Math.abs(dx-dy)<1;})()&&clear(at,points[far+1],w,open))far++;result.push(points[far]);at=points[far];i=far+1;}return result;
}
async function walk(page,target){
 const pulse=setInterval(()=>page.keyboard.press('q').catch(()=>{}),9800);
 try {
  // A patrol rescue or an overshot corner invalidates the old route. Replan from
  // observed gameplay state instead of continuing through its remaining walls.
  for(let route=0;route<4;route++){
   let s=await state(page);if(distance(s.position,target)<30)return;
   const rescues=s.rescues,points=pathfind(s.position,target,s.world,s.pumps.every(Boolean));
   let replan=false;
   for(const point of points){
    let reached=false;
    for(let attempt=0;attempt<25;attempt++){
     s=await state(page);
     if(s.rescues!==rescues){replan=true;break;}
     if(distance(s.position,point)<19){reached=true;break;}
     const wx=point[0]-s.position[0],wy=point[1]-s.position[1];
     const dx=wx*Math.cos(s.yaw)-wy*Math.sin(s.yaw),dy=wx*Math.sin(s.yaw)+wy*Math.cos(s.yaw);
     const keys=[];if(Math.abs(dx)>12)keys.push(dx>0?'d':'a');if(Math.abs(dy)>12)keys.push(dy>0?'s':'w');
     if(!keys.length){reached=true;break;}
     for(const k of keys)await page.keyboard.down(k);
     await page.waitForTimeout(Math.min(700,Math.max(70,distance(s.position,point)/175*1000-80)));
     for(const k of keys)await page.keyboard.up(k);
     await page.waitForTimeout(190);
    }
    if(replan||!reached){console.log('Replanning walk',target,(await state(page)).position);break;}
   }
   s=await state(page);if(distance(s.position,target)<70)return;
  }
  const s=await state(page);assert.fail(`arrived at ${target}: ${s.position}; rescues=${s.rescues}`);
 }finally{clearInterval(pulse);for(const k of ['w','a','s','d'])await page.keyboard.up(k);}
}
// A patrol can still catch Mara between arriving and pressing USE; a rescue moves
// her to the checkpoint, so walk back and use the target again.
async function reach(page,target,expected){for(let attempt=0;attempt<3;attempt++){await walk(page,target);const before=(await state(page)).rescues;await page.keyboard.press('e');try{await page.waitForFunction(m=>window.tidelockState?.mode===m,expected,{timeout:8000});return;}catch(error){if((await state(page)).rescues===before)break;console.log('Rescued before use; walking back',target);}}await mode(page,expected);}
async function repair(page,index){await page.keyboard.press('e');await mode(page,'puzzle');const before=await state(page);await page.keyboard.press('e');await page.waitForTimeout(200);check((await state(page)).mode==='puzzle','incorrect circuit cannot energize pump');const targets=[[0,1,3],[2,0,1],[1,3,2]][index];
 for(let i=0;i<3;i++){const turns=(targets[i]-before.dials[i]+4)%4;for(let j=0;j<turns;j++){await page.keyboard.press(String(i+1));await page.waitForTimeout(70);}}
 await page.keyboard.press('e');await mode(page,'playing');await page.waitForTimeout(200);check((await state(page)).pumps[index],`pump ${index+1} restored through rotary controls`);}
(async()=>{
 const browser=await chromium.launch({proxy:process.env.BROWSER_PROXY?{server:process.env.BROWSER_PROXY,bypass:'localhost,127.0.0.1'}:undefined,executablePath:process.env.CHROMIUM_PATH===undefined?'/usr/bin/chromium':(process.env.CHROMIUM_PATH||undefined),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const failures=[];const requests=[];
 function monitor(page){page.on('pageerror',e=>failures.push(e.message));page.on('console',m=>{if(m.type()==='error')failures.push(m.text());});page.on('requestfailed',r=>requests.push(r.url()+' '+r.failure()?.errorText));}
 try{
 let s;
 if(process.env.GAME_TEST_SCOPE!=="touch"){
 const context=await browser.newContext({viewport:{width:800,height:450}});const page=await context.newPage();monitor(page);await page.goto(base);await mode(page,'title');check(true,'Godot WebGL title boots');await page.screenshot({path:output+'/title.png'});
 await tap(page,170,540);await mode(page,'settings');await tap(page,640,280);await page.waitForTimeout(200);check(!(await state(page)).sound,'sound toggle changes real setting');await tap(page,640,345);check((await state(page)).motion,'reduced motion changes real setting');await tap(page,640,580);await mode(page,'title');
 await tap(page,240,410);await mode(page,'playing');await page.waitForTimeout(200);check((await state(page)).health===100,'new game enters a live mission');console.log('WebGL performance',((st)=>({fps:st.fps,adapter:st.adapter}))(await state(page)));check((await state(page)).renderer==='first-person-3d','active game is first-person 3D');
 await page.mouse.move(400,225);await page.waitForTimeout(1000);let lookBefore=await state(page);await page.mouse.move(456,lookBefore.pitch>0?244:206);try{await page.waitForFunction(before=>Math.abs(window.tidelockState.yaw-before.yaw)>0.05&&Math.abs(window.tidelockState.pitch-before.pitch)>0.02,lookBefore,{timeout:10000});}catch(error){console.log('MOUSE LOOK', {before:lookBefore,after:await state(page),pointerLocked:await page.evaluate(()=>Boolean(document.pointerLockElement))});throw error;}check(true,'mouse moves first-person camera');await page.mouse.move(400,225);await page.waitForTimeout(600);await page.keyboard.press('f');await page.waitForTimeout(220);check(!(await state(page)).flashlight,'flashlight toggles');await page.keyboard.press('f');await page.screenshot({path:output+'/harbor.png'});await page.keyboard.press('q');await page.waitForTimeout(160);check((await state(page)).notice.includes('Induction pulse'),'first-person induction effects trigger');await page.screenshot({path:output+'/pulse.png'});
 await page.keyboard.press('Tab');await mode(page,'journal');await page.screenshot({path:output+'/journal.png'});await page.keyboard.press('Tab');await mode(page,'playing');
 await page.keyboard.press('Escape');await mode(page,'pause');let time=(await state(page)).time;await page.waitForTimeout(800);check(Math.abs((await state(page)).time-time)<0.2,'pause stops tide simulation');await page.keyboard.press('Escape');await mode(page,'playing');
 // Talk to Ivo: subtitled lines, a three-way reply, and the choice kept in the checkpoint.
 await walk(page,[535,1112]);await page.keyboard.press('e');await mode(page,'dialogue');await page.screenshot({path:output+'/dialogue.png'});
 for(let i=0;i<20&&(await state(page)).options===0;i++){await page.keyboard.press('e');await page.waitForTimeout(160);}
 check((await state(page)).options===3,'conversation reaches a three-way reply');await page.screenshot({path:output+'/dialogue-choice.png'});
 await page.keyboard.press('2');await page.waitForTimeout(160);
 for(let i=0;i<20&&(await state(page)).mode==='dialogue';i++){await page.keyboard.press('e');await page.waitForTimeout(160);}
 await mode(page,'playing');s=await state(page);check(s.talked[0]&&s.flags.includes('ivo_trust'),'conversation reply is recorded');
 s=await state(page);
 await walk(page,s.world.fuses[0]);await page.keyboard.press('e');await page.waitForTimeout(220);check((await state(page)).fuses===1,'fuse picked up through proximity interaction');
 await walk(page,[s.world.pumps[0][0],s.world.pumps[0][1]+65]);await repair(page,0);check((await state(page)).fuses===0,'repair consumes inventory');await page.screenshot({path:output+'/pump-restored.png'});
 // Reload the actual browser storage, then continue the checkpoint.
 await page.reload();await mode(page,'title');check(!(await state(page)).sound&&(await state(page)).motion,'field settings persist across reload');await tap(page,240,478);await mode(page,'playing');check((await state(page)).pumps[0],'checkpoint persists across immediate reload');
 for(let i=0;i<3;i++){s=await state(page);await reach(page,s.world.logs[i],'log');await page.screenshot({path:output+`/log-${i+1}.png`});await tap(page,640,634);await mode(page,'playing');if(i>0){s=await state(page);await walk(page,s.world.fuses[i]);await page.keyboard.press('e');await page.waitForTimeout(200);await walk(page,[s.world.pumps[i][0],s.world.pumps[i][1]+65]);await repair(page,i);if(i===1){await walk(page,[1635,585]);await walk(page,[1635,815]);check((await state(page)).position[1]>785,'first-person bridge crosses from the north quay');await page.screenshot({path:output+'/bridge.png'});}}}
 s=await state(page);check(s.pumps.every(Boolean)&&s.logs.every(Boolean),'all pumps and authored shift logs reachable');await walk(page,s.world.exit);await page.keyboard.press('e');await mode(page,'ending');await tap(page,640,466);check((await state(page)).ending==='broadcast','report choice produces an ending');await page.screenshot({path:output+'/ending.png'});
 await page.reload();await mode(page,'title');await tap(page,240,478);await mode(page,'ending');check((await state(page)).ending==='broadcast','completed ending persists across reload');await context.close();
 }
 const mobile=await browser.newContext({viewport:{width:915,height:412},isMobile:true,hasTouch:true,deviceScaleFactor:1});const phone=await mobile.newPage();monitor(phone);await phone.goto(base+(base.includes('?')?'&':'?')+'touch=1');await mode(phone,'title');await tap(phone,240,410);await mode(phone,'playing');check((await state(phone)).touch,'mobile touch controls enabled');await phone.screenshot({path:output+'/mobile.png'});const lightBefore=(await state(phone)).flashlight;const lightBox=await phone.locator('canvas').boundingBox(),lightScale=Math.min(lightBox.width/1280,lightBox.height/720);await phone.touchscreen.tap(lightBox.x+(lightBox.width-1280*lightScale)/2+985*lightScale,lightBox.y+(lightBox.height-720*lightScale)/2+615*lightScale);await phone.waitForTimeout(220);check((await state(phone)).flashlight!==lightBefore,'touch flashlight toggle works');
 const cdp=await mobile.newCDPSession(phone);const scale=412/720;const ox=(915-1280*scale)/2;const pt=(x,y)=>({x:ox+x*scale,y:y*scale});
 const start=(await state(phone)).position;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...pt(180,586),id:1},{...pt(1210,510),id:2}]});await phone.waitForTimeout(500);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await phone.waitForTimeout(220);s=await state(phone);check(s.position[0]>start[0]+25,'touch joystick moves the player');check(s.notice.includes('Induction pulse'),'simultaneous touch move and pulse works');
 // Simultaneous movement and camera aiming, then undo the look with an actual drag.
 const beforeLook=await state(phone);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...pt(124,560),id:1},{...pt(800,350),id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...pt(124,560),id:1},{...pt(840,370),id:2}]});await phone.waitForTimeout(300);check(Math.abs((await state(phone)).yaw-beforeLook.yaw)>0.05,'multi-touch movement and first-person aiming work');await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...pt(124,586),id:1},{...pt(800,350),id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await phone.waitForTimeout(200);check(Math.abs((await state(phone)).yaw-beforeLook.yaw)<0.03,'touch look returns without drift');
 // Touch-only pickup and first pump, with player-controlled stick durations.
 async function dragMove(dx,dy,ms){await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...pt(124+dx*60,586+dy*60),id:1}]});await phone.waitForTimeout(ms);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await phone.waitForTimeout(220);}
 // Near the target use a partial stick and halve corrections after three steps: at low
 // frame rates every touch lasts at least a frame, so a full stick always overshoots.
 async function touchWalk(target){const s0=await state(phone);for(const point of pathfind(s0.position,target,s0.world,s0.pumps.every(Boolean)))await touchStep(point,point===target?15:19);}
 async function touchStep(target,near){for(let i=0;i<20;i++){const pos=(await state(phone)).position;if(distance(pos,target)<near)return;const st=await state(phone),wx=target[0]-pos[0],wy=target[1]-pos[1],dx=wx*Math.cos(st.yaw)-wy*Math.sin(st.yaw),dy=wx*Math.sin(st.yaw)+wy*Math.cos(st.yaw),len=Math.hypot(dx,dy);const k=Math.min(1,Math.max(0.3,len/90));await dragMove(dx/len*k,dy/len*k,Math.max(40,Math.min(550,len/(175*k)*1000-60)*(i<3?1:0.5)));}assert.fail('touch navigation did not reach target');}
 s=await state(phone);await touchWalk(s.world.fuses[0]);await phone.touchscreen.tap(pt(1100,580).x,pt(1100,580).y);await phone.waitForTimeout(250);check((await state(phone)).fuses===1,'touch USE collects a fuse');await touchWalk([s.world.pumps[0][0],s.world.pumps[0][1]+65]);await phone.touchscreen.tap(pt(1100,580).x,pt(1100,580).y);await mode(phone,'puzzle');await phone.screenshot({path:output+'/mobile-puzzle.png'});
 for(const [x,n] of [[420,3],[640,3],[860,3]])for(let i=0;i<n;i++){await phone.touchscreen.tap(pt(x,453).x,pt(x,453).y);await phone.waitForTimeout(100);}
 await phone.touchscreen.tap(pt(640,587).x,pt(640,587).y);await mode(phone,'playing');check((await state(phone)).pumps[0],'touch-only circuit repair works');
 check(failures.length===0,'no browser or Godot runtime errors: '+failures.join('\n'));check(requests.length===0,'no failed network requests: '+requests.join('\n'));fs.writeFileSync(output+'/results.json',JSON.stringify({checks,failures,requests,desktopComplete:process.env.GAME_TEST_SCOPE!=="touch",touchPumpComplete:true},null,2));console.log(`Browser checks: ${checks} passed`);await mobile.close();
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
