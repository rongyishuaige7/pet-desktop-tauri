// Use a separately installed Playwright so production dependencies stay small.
const { chromium } = await import(process.env.PET_PLAYWRIGHT_MODULE || 'playwright-core');
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const evidenceDir=process.env.PET_EVIDENCE_DIR;
if (!evidenceDir) throw new Error('Set PET_EVIDENCE_DIR to an existing temporary output directory');
const base=process.env.PET_PREVIEW_URL || 'http://localhost:1420';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Local preview URL required');
const browser=await chromium.launch({executablePath:process.env.PET_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const results=[];
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function openCompanionDetails(page){const details=page.locator('.companion-details');if(await details.count()&&!(await details.evaluate(el=>el.open)))await details.locator('summary').click();}
async function newCase({desktop=false,settingsAction='idle',missing=false,packDelay=0,onboarding='dismiss',failStateReads=0,nativeMode='shown'}={}) {
 const context=await browser.newContext({viewport:{width:1120,height:760}});
 await context.route('**/*',route=>['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await context.addInitScript(({desktop,settingsAction,missing,packDelay,failStateReads,nativeMode})=>{
  localStorage.setItem('desktop-sticker-pet:autonomous','off');
  if(!desktop)return;
  const callbacks=new Map(); const listeners=new Map(); let seq=1;
  const state=window.__review={calls:[],root:'/review/A',action:settingsAction,visible:true,delayB:0,emitOnSet:false,generations:0,saves:0};
  state.native={sessionId:'mock-session',revision:1,petId:null,petName:null,availability:'absent',visibilityMode:nativeMode,snoozeUntilMs:null,visible:false,action:settingsAction,actionRevision:1,animationPaused:false,autonomous:true,motionPreference:'system',systemReducedMotion:false,effectivePaused:false,effectiveAutonomous:false,scale:1,clickThrough:true,pending:false,autostart:{enabled:false,pending:false},lastOperationError:null,capabilities:{nativeWindow:true,tapFeedback:true,clickThrough:true,resetPosition:true,autostart:true,systemReducedMotion:true}};
  state.missing=missing;state.failPreference=false;state.failAutostart=false;state.failStateReads=failStateReads;state.stalePreferenceReply=false;state.failAttach=false;state.lastInteractionAt=0;
  state.refreshNative=()=>{const n=state.native;n.revision++;n.effectivePaused=n.animationPaused||n.motionPreference==='reduce'||(n.motionPreference==='system'&&n.systemReducedMotion);n.visible=Boolean(n.petId)&&n.visibilityMode==='shown'&&n.availability==='ready';n.effectiveAutonomous=n.autonomous&&!n.effectivePaused&&n.visible&&n.availability==='ready';return n;};
  state.emitNative=async()=>{const n=state.refreshNative();await Promise.all([...listeners.entries()].filter(([,v])=>v.event==='native-pet-state-changed').map(([id,v])=>callbacks.get(v.handler)?.({event:v.event,id,payload:n})));return n;};
  state.makeImage=(sheet=false)=>{
   const canvas=document.createElement('canvas');canvas.width=sheet?900:300;canvas.height=sheet?600:300;
   const ctx=canvas.getContext('2d');ctx.fillStyle='#00ff00';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#71402a';
   for(let i=0;i<(sheet?5:1);i++)ctx.fillRect((i%3)*300+80,Math.floor(i/3)*300+35,140,240);
   return canvas.toDataURL('image/png');
  };
  state.emit=async(payload)=>{
   await Promise.all([...listeners.entries()].filter(([,v])=>v.event==='native-pet-action-changed').map(([id,v])=>callbacks.get(v.handler)?.({event:v.event,id,payload})));
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event,id)=>listeners.delete(id)};
  window.__TAURI_INTERNALS__={
   transformCallback:(fn)=>{const id=seq++;callbacks.set(id,fn);return id;},
   invoke:async(cmd,args={})=>{
    state.calls.push({cmd,root:args.rootDir??args.request?.rootDir,action:args.action});
    if(cmd==='plugin:event|listen'){const id=seq++;listeners.set(id,args);return id;}
    if(cmd==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
    if(cmd==='get_native_pet_settings')return {frameRoot:state.root,scale:1,currentAction:settingsAction,petId:state.native.petId};
    if(cmd==='get_native_pet_state'){if(state.failStateReads>0){state.failStateReads--;throw new Error('mock state read failed');}return state.native;}
    if(cmd==='load_preset_frame_pack'){
     const root=args.request.rootDir;
     if(root==='/review/generated'&&state.savedActions)return {sourceImage:state.savedActions.idle[0],actions:state.savedActions};
     await new Promise(r=>setTimeout(r,root==='/review/B'?state.delayB:packDelay));
     if(state.missing)throw new Error('audit: custom frame directory does not exist');
     const actions=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,[0,1,2,3,4].map(i=>`/frame-pack/${a}/${String(i).padStart(3,'0')}.png?review=${root}`)]));
     return {sourceImage:actions.idle[0],actions};
    }
    if(cmd==='set_native_pet_frame_root'){
     if(state.failAttach)throw new Error('mock attach failed');
     if(args.rootDir==='/review/generated'&&state.delayGeneratedCommit){state.committing=true;await new Promise(r=>setTimeout(r,state.delayGeneratedCommit));}
     if (state.failB && args.rootDir==='/review/B') throw new Error('audit: invalid pack');
     state.root=args.rootDir;state.visible=true;
     Object.assign(state.native,{petId:args.petId??null,petName:args.petName??null,availability:'ready'});
     state.native.actionRevision++;
     state.emitNative();
     if(state.emitOnSet)setTimeout(()=>{state.action='walk';state.native.action='walk';state.native.actionRevision++;void state.emitNative();},30);
     return state.native;
    }
    if(cmd==='detach_native_pet'){Object.assign(state.native,{petId:null,petName:null,availability:'absent',visible:false});state.visible=false;state.emitNative();return;}
    if(cmd==='set_native_pet_name'){state.native.petName=args.name;state.emitNative();return;}
    if(cmd==='set_native_pet_action'){state.action=args.action;state.native.action=args.action;state.native.actionRevision++;state.emitNative();return {action:args.action,petId:state.native.petId,revision:state.native.actionRevision};}
    if(cmd==='set_native_pet_visible'){state.native.visibilityMode=args.visible?'shown':'hidden';state.visible=args.visible;state.emitNative();return state.native;}
    if(cmd==='set_native_pet_scale'){state.native.scale=args.scale;return state.native;}
    if(cmd==='reset_native_pet_position')return;
    if(cmd==='update_native_pet_preferences'){
     const r=args.request;const n=state.native;
     if(state.failPreference){
      n.lastOperationError={id:'mock-pref-error',operation:r.kind,code:'SETTINGS_WRITE_FAILED',recoverable:true};
      await state.emitNative();
      throw new Error('mock settings write failed');
     }
     if(r.kind==='setAutostart'&&state.failAutostart){
      n.lastOperationError={id:'mock-autostart-error',operation:r.kind,code:'AUTOSTART_FAILED',recoverable:true};
      await state.emitNative();
      throw new Error('mock autostart failed');
     }
     if(r.kind==='show'){n.visibilityMode='shown';n.snoozeUntilMs=null;n.actionRevision++;}
     if(r.kind==='hide'){n.visibilityMode='hidden';n.snoozeUntilMs=null;}
     if(r.kind==='snooze'){n.visibilityMode='snoozed';n.snoozeUntilMs=Date.now()+3600000;}
     if(r.kind==='setAnimationPaused')n.animationPaused=r.value;
     if(r.kind==='setAutonomous')n.autonomous=r.value;
     if(r.kind==='setScale')n.scale=r.value;
     if(r.kind==='setClickThrough')n.clickThrough=r.value;
     if(r.kind==='setMotionPreference')n.motionPreference=r.value;
     if(r.kind==='setAutostart')n.autostart={...n.autostart,enabled:r.value};
     n.lastOperationError=null;
     const staleRevision=n.revision-1;
     await state.emitNative();
     if(state.stalePreferenceReply&&r.kind==='hide'){
      return {...n,revision:staleRevision,visibilityMode:'shown',visible:true};
     }
     return state.native;
    }
    if(cmd==='interact_native_pet'){
     const n=state.native;const reason=!n.petId||(args.petId&&args.petId!==n.petId)?'stalePet':!n.visible?'hidden':n.availability!=='ready'?'notReady':n.animationPaused?'paused':null;
     if(reason)return {accepted:false,reason,state:n};
     const now=Date.now();
     if(now-state.lastInteractionAt<1500)return {accepted:false,reason:'cooldown',state:n};
     state.lastInteractionAt=now;
     const reduced=n.motionPreference==='reduce'||(n.motionPreference==='system'&&n.systemReducedMotion);
     if(!reduced){n.action=args.kind==='pet'?'happy':'jump';state.action=n.action;n.actionRevision++;}
     await state.emitNative();
     return {accepted:true,state:n};
    }
    if(cmd==='upload_reference_image')return 'https://example.test/mock-reference.png';
    if(cmd==='generate_minimax_image'){
     state.generations++;
     if(state.generations===state.failGenerationAt)throw new Error('mock temporary generation failure');
     return state.makeImage(args.request.aspectRatio==='3:2');
    }
    if(cmd==='save_manual_frame_pack'){
     state.saves++;state.savedActions=args.request.actions;state.saving=true;
     if(state.blockSave)await new Promise(resolve=>state.releaseSave=resolve);
     return {frameRoot:'/review/generated',sourceImage:state.savedActions.idle[0]};
    }
    throw new Error('unexpected mock IPC: '+cmd);
   }
  };
 },{desktop,settingsAction,missing,packDelay,failStateReads,nativeMode});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.locator('.companion-pet-button, .onboarding-dialog, .toast-message.error').first().waitFor();
 if(onboarding==='dismiss'){
  await page.waitForTimeout(300);
  const dialog=page.locator('.onboarding-dialog');
  if(await dialog.count()){
   const browse=page.getByRole('button',{name:'先浏览'});
   if(await browse.count())await browse.click();
   await dialog.waitFor({state:'detached'}).catch(()=>{});
  }
 }
 return {context,page,errors};
}
async function seed(page,{desktop=false,active='A',empty=true}={}){
 await page.evaluate(async({desktop,active,empty})=>{
  const storage=await import('/src/storage.ts');
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('desktop-sticker-pet-db',2);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction(['pet','pets_collection','metadata'],'readwrite');for(const name of ['pet','pets_collection','metadata'])tx.objectStore(name).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  for(const id of ['A','B']){
   const actions=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,desktop&&empty?[]:[0,1,2,3,4].map(i=>`/frame-pack/${a}/${String(i).padStart(3,'0')}.png`)]));
   await storage.savePet({id,name:id==='A'?'测试甲':'测试乙',species:'dog',style:'q-sticker',createdAt:'2026-10-21T00:00:00Z',storageMode:'preset-root',frameRoot:'/review/'+id,sourceImage:desktop&&empty?'':actions.idle[0],actions,currentAction:'idle',actionStartedAt:'2026-10-21T00:00:00Z',scale:1});
  }
  await storage.setActivePetId(active);
 },{desktop,active,empty});
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('.companion-pet-button, .toast-message.error').first().waitFor();
 await sleep(300);
}
async function record(name,fn){
 try{const detail=await fn();const result={name,...detail};results.push(result);console.log(JSON.stringify(result));}
 catch(e){const result={name,harnessError:e.message};results.push(result);console.log(JSON.stringify(result));}
}
async function openAI(page){
 await page.getByRole('button',{name:/领养与制作/}).click();
 await page.getByRole('button',{name:/AI 照片转宠物/}).click();
 await page.locator('input[type=password]').fill('mock-key');
 await page.getByPlaceholder('https://your-domain.example/upload').fill('https://example.test/upload');
 const data=await page.evaluate(()=>window.__review.makeImage().split(',')[1]);
 await page.locator('input[type=file]').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});
 await page.getByRole('button',{name:'开始 AI 自动生成全套帧包',exact:true}).waitFor();
}
try{
 await record('manual_upload_errors_and_recovery',async()=>{
  const {context,page,errors}=await newCase();
  try{
   await page.getByRole('button',{name:/领养与制作/}).click();
   await page.getByRole('button',{name:/动作帧装配台/}).click();
   const input=page.locator('input[type=file]');
   await input.setInputFiles({name:'wrong.pdf',mimeType:'application/pdf',buffer:Buffer.from('not a picture')});
   await page.locator('.toast-message.error').filter({hasText:'读取动作帧失败'}).waitFor();
   const rejected=await page.locator('.frame-thumb-img').count()===0;
   const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const ctx=c.getContext('2d');ctx.fillStyle='#71402a';ctx.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
   const file={name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')};
   await input.setInputFiles(Array.from({length:61},(_,i)=>({...file,name:`${i}.png`})));
   await page.locator('.toast-message.error').filter({hasText:'最多 60 帧'}).waitFor();
   await input.setInputFiles(file);
   await page.locator('.frame-thumb-img').waitFor();
   return {passed:rejected&&await page.locator('.frame-thumb-img').count()===1&&errors.length===0,rejected,errors};
  }finally{await context.close();}
 });
 await record('ai_cancel_during_save_and_resume',async()=>{
  const {context,page,errors}=await newCase({desktop:true});
  try{
   await openAI(page);
   const previous=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadPet())?.id);
   await page.evaluate(()=>{window.__review.blockSave=true;});
   await page.getByRole('button',{name:'开始 AI 自动生成全套帧包',exact:true}).click();
   await page.waitForFunction(()=>window.__review.saving===true);
   const frozen=await page.getByPlaceholder('例如：糖宝、奶茶').isDisabled();
   await page.getByRole('button',{name:'取消',exact:true}).click();
   await page.evaluate(()=>window.__review.releaseSave());
   await page.getByRole('button',{name:'继续上次生成',exact:true}).waitFor();
   const cancelled=await page.evaluate(async()=>({active:(await (await import('/src/storage.ts')).loadPet())?.id,generations:window.__review.generations,saves:window.__review.saves}));
   await page.evaluate(()=>{window.__review.delayGeneratedCommit=500;});
   await page.getByRole('button',{name:'继续上次生成',exact:true}).click();
   await page.waitForFunction(()=>window.__review.committing===true);
   const committingLocked=await page.getByRole('button',{name:'取消',exact:true}).count()===0&&await page.getByRole('button',{name:'完成入住中...',exact:true}).isDisabled();
   await page.locator('.companion-title').waitFor();
   const resumed=await page.evaluate(async()=>({active:(await (await import('/src/storage.ts')).loadPet())?.id,generations:window.__review.generations,saves:window.__review.saves}));
   return {passed:frozen&&committingLocked&&cancelled.active===previous&&cancelled.generations===7&&cancelled.saves===1&&resumed.active!==previous&&resumed.generations===7&&resumed.saves===1&&errors.length===0,frozen,committingLocked,cancelled,resumed,errors};
  }finally{await context.close();}
 });
 await record('ai_failure_resume_and_input_invalidation',async()=>{
  const {context,page,errors}=await newCase({desktop:true});
  try{
   await openAI(page);await page.evaluate(()=>{window.__review.failGenerationAt=3;});
   await page.getByRole('button',{name:'开始 AI 自动生成全套帧包',exact:true}).click();
   await page.getByRole('button',{name:'继续上次生成',exact:true}).waitFor();
   await page.getByRole('button',{name:'继续上次生成',exact:true}).click();
   await page.locator('.companion-title').waitFor();
   const resumed=await page.evaluate(()=>({generations:window.__review.generations,saves:window.__review.saves}));
   await openAI(page);await page.evaluate(()=>{window.__review.failGenerationAt=window.__review.generations+2;});
   await page.getByRole('button',{name:'开始 AI 自动生成全套帧包',exact:true}).click();
   await page.getByRole('button',{name:'继续上次生成',exact:true}).waitFor();
   await page.getByPlaceholder('例如：糖宝、奶茶').fill('新的名字');
   await page.getByRole('button',{name:'开始 AI 自动生成全套帧包',exact:true}).waitFor();
   const invalidated=await page.getByRole('button',{name:'继续上次生成',exact:true}).count()===0;
   return {passed:resumed.generations===8&&resumed.saves===1&&invalidated&&errors.length===0,resumed,invalidated,errors};
  }finally{await context.close();}
 });
 await record('generated_frame_pixels_and_sheet_validation',async()=>{
  const {context,page,errors}=await newCase();
  try{
   const result=await page.evaluate(async()=>{
    const {normalizeActionFrames,subjectBounds,loadFrameImage}=await import('/src/frame-quality.ts');
    const {sliceSpriteSheet}=await import('/src/sprite-sheet.ts');
    const frame=(top,bottom)=>{const c=document.createElement('canvas');c.width=c.height=300;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(80,top,140,bottom-top+1);return c.toDataURL();};
    const frames=[frame(35,274),frame(20,259)];
    const bounds=async frames=>Promise.all(frames.map(async source=>{const image=await loadFrameImage(source);const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return {width:c.width,height:c.height,...subjectBounds(ctx.getImageData(0,0,c.width,c.height).data,c.width,c.height)};}));
    const grounded=await bounds(await normalizeActionFrames(frames,'idle',true));
    const jumping=await bounds(await normalizeActionFrames(frames,'jump',true));
    let rejectsSheet=false;try{await sliceSpriteSheet(frames[0]);}catch(e){rejectsSheet=e.message.includes('网格');}
    return {grounded,jumping,rejectsSheet};
   });
   const {grounded,jumping,rejectsSheet}=result;
   return {passed:grounded.every(b=>b.width===512&&b.height===512&&b.top>=32&&b.bottom<=475)&&Math.abs(grounded[0].bottom-grounded[1].bottom)<=1&&jumping[0].bottom-jumping[1].bottom>=20&&rejectsSheet&&errors.length===0,...result,errors};
  }finally{await context.close();}
 });
 await record('delete_nonactive_pet',async()=>{
  const {context,page,errors}=await newCase();
  try{
   await seed(page,{active:'B'});
   await page.getByRole('button',{name:/我的伙伴/}).click();
   page.once('dialog',d=>d.accept());
   await page.locator('.pet-card').filter({hasText:'测试甲'}).getByTitle('删除宠物').click();
   await page.locator('.pet-card').filter({hasText:'测试甲'}).waitFor({state:'detached'});
   await page.getByRole('button',{name:/陪伴/}).click();
   const stored=await page.evaluate(async()=>{const m=await import('/src/storage.ts');return (await m.loadPet())?.id;});
   const empty=await page.locator('.companion-empty').isVisible();
   await page.screenshot({path:join(evidenceDir,'delete-nonactive-fixed.png')});
   return {passed:stored==='B'&&!empty,storedActive:stored,previewEmpty:empty,errors};
  }finally{await context.close();}
 });
 await record('cross_tab_action_sync',async()=>{
  const {context,page}=await newCase();
  try{
   await seed(page);
   const second=await context.newPage();await second.goto(base);await second.locator('.companion-pet-button').waitFor();
   await openCompanionDetails(page);await openCompanionDetails(second);
   await page.getByRole('button',{name:'🐾 走路',exact:true}).click();await sleep(150);
   const firstAction=await page.locator('.action-pill-btn.active').innerText();
   const secondAction=await second.locator('.action-pill-btn.active').innerText();
   return {passed:firstAction===secondAction,firstAction,secondAction};
  }finally{await context.close();}
 });
 await record('missing_custom_pack_silent_substitution',async()=>{
  const {context,page}=await newCase({desktop:true,missing:true});
  try{
   await seed(page,{desktop:true});
   const src=await page.locator('.companion-pet-button img').count();
   const messages=await page.locator('.toast-message').allTextContents();
   const recoveryText=await page.locator('.recovery-notice').innerText();
   return {passed:src===0&&messages.some(m=>m.includes('加载宠物失败'))&&recoveryText.includes('暂时找不到')&&recoveryText.includes('重试加载'),recoveryText,src,messages};
  }finally{await context.close();}
 });
 await record('native_event_during_pet_deployment',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true,active:'A'});
   await page.evaluate(()=>{window.__review.delayB=500;window.__review.emitOnSet=true;});
   await page.getByRole('button',{name:/我的伙伴/}).click();
   await page.locator('.pet-card').filter({hasText:'测试乙'}).getByRole('button',{name:/派去桌面/}).click();
   await sleep(800);
   const stored=await page.evaluate(async()=>{const m=await import('/src/storage.ts');return (await m.loadPet())?.id;});
   const visible=await page.locator('.widget-name').innerText();
   return {passed:stored==='B'&&visible==='测试乙',storedActive:stored,visibleActive:visible,native:await page.evaluate(()=>({root:window.__review.root,action:window.__review.action}))};
  }finally{await context.close();}
 });
 await record('desktop_preview_writes_native_idle',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true});
   await page.evaluate(()=>window.__review.calls=[]);
   await openCompanionDetails(page);
   await page.getByRole('button',{name:'🚀 跳跃',exact:true}).click();await sleep(800);
   const actions=await page.evaluate(()=>window.__review.calls.filter(c=>c.cmd==='set_native_pet_action').map(c=>c.action));
   return {passed:actions.join(',')==='jump',outgoingNativeActions:actions};
  }finally{await context.close();}
 });
 await record('startup_native_action_overwritten',async()=>{
  const {context,page}=await newCase({desktop:true,settingsAction:'sleep',packDelay:50});
  try{
   await seed(page,{desktop:true,active:'A'});await sleep(400);
   await openCompanionDetails(page);
   const visible=await page.locator('.action-pill-btn.active').innerText();
   const native=await page.evaluate(()=>window.__review.action);
   return {passed:native==='sleep'&&visible.includes('睡觉'),nativeAction:native,visibleAction:visible};
  }finally{await context.close();}
 });
 await record('rename_save_button_styles',async()=>{
  const {context,page}=await newCase();
  try{
   await seed(page);await page.getByTitle('重命名当前伙伴').click();
   const styles=await page.locator('.btn-icon-save').evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,color:s.color,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent-amber')};});
   return {passed:styles.background==='rgb(127, 77, 34)'&&styles.color==='rgb(255, 255, 255)',styles};
  }finally{await context.close();}
 });
 await record('loads_only_selected_pack_once',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true});
   const roots=await page.evaluate(()=>window.__review.calls.filter(c=>c.cmd==='load_preset_frame_pack').map(c=>c.root));
   return {passed:roots.length===1&&roots[0]==='/review/A',roots};
  }finally{await context.close();}
 });
 await record('failed_deploy_retains_selected_pet',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true});await page.evaluate(()=>window.__review.failB=true);
   await page.getByRole('button',{name:/我的伙伴/}).click();
   await page.locator('.pet-card').filter({hasText:'测试乙'}).getByRole('button',{name:/派去桌面/}).click();
   await page.locator('.toast-message.error').waitFor();
   const state=await page.evaluate(async()=>({stored:(await (await import('/src/storage.ts')).loadPet())?.id,root:window.__review.root}));
   const visible=await page.locator('.widget-name').innerText();
   return {passed:state.stored==='A'&&state.root==='/review/A'&&visible==='测试甲',...state,visible};
  }finally{await context.close();}
 });
 await record('old_pet_event_after_deploy_is_ignored',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true});
   await page.getByRole('button',{name:/我的伙伴/}).click();
   await page.locator('.pet-card').filter({hasText:'测试乙'}).getByRole('button',{name:/派去桌面/}).click();
   await page.waitForFunction(()=>document.querySelector('.widget-name')?.textContent==='测试乙');
   await page.evaluate(()=>window.__review.emit({action:'sleep',petId:'A',revision:100}));
   await page.getByRole('button',{name:/陪伴/}).click();
   await openCompanionDetails(page);
   const action=await page.locator('.action-pill-btn.active').innerText();
   return {passed:action.includes('待机'),action};
  }finally{await context.close();}
 });
 await record('last_desktop_pet_is_hidden',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true});await page.getByRole('button',{name:/我的伙伴/}).click();
   for (const name of ['测试甲','测试乙']) {
    page.once('dialog',d=>d.accept());const card=page.locator('.pet-card').filter({hasText:name});
    await card.getByTitle('删除宠物').click();await card.waitFor({state:'detached'});
   }
   const visible=await page.evaluate(()=>window.__review.visible);
   return {passed:visible===false,visible};
  }finally{await context.close();}
 });
 await record('empty_collection_stays_empty_after_reload',async()=>{
  const {context,page}=await newCase();
  try{
   await seed(page);await page.getByRole('button',{name:/我的伙伴/}).click();
   for (const name of ['测试甲','测试乙']) {
    page.once('dialog',d=>d.accept());
    const card=page.locator('.pet-card').filter({hasText:name});
    await card.getByTitle('删除宠物').click();await card.waitFor({state:'detached'});
   }
   await page.reload();await page.locator('.companion-empty').waitFor();
   const stored=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadAllPets()).length);
   return {passed:stored===0,stored};
  }finally{await context.close();}
 });
await record('visibility_snooze_and_pause_controls',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  const controls=page.locator('.companion-control-buttons');
  await controls.getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('已收起'));
  const hidden=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible}));
  await controls.getByRole('button',{name:'立即唤回',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('正在桌面陪着你'));
  const shown=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible}));
  await controls.getByRole('button',{name:'休息一小时',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('休息中'));
  const snoozed=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs,visible:window.__review.native.visible}));
  await controls.getByRole('button',{name:'提前唤回',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('正在桌面陪着你'));
  const woken=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs}));
  const pausedBefore=await page.locator('#companion-paused').isChecked();
  await page.locator('#companion-paused').click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('动画已暂停'));
  const paused=await page.evaluate(()=>window.__review.native.animationPaused);
  const pausedAfter=await page.locator('#companion-paused').isChecked();
  await page.locator('#companion-paused').click();
  await page.waitForFunction(()=>!document.querySelector('.status-chip')?.textContent.includes('动画已暂停'));
  const resumed=await page.evaluate(()=>window.__review.native.animationPaused);
  return {passed:hidden.mode==='hidden'&&hidden.visible===false&&shown.mode==='shown'&&shown.visible===true&&snoozed.mode==='snoozed'&&snoozed.visible===false&&snoozed.until>Date.now()&&woken.mode==='shown'&&woken.until===null&&paused===true&&pausedBefore===false&&pausedAfter===true&&resumed===false&&errors.length===0,hidden,shown,snoozed,woken,paused,pausedBefore,pausedAfter,resumed,errors};
 }finally{await context.close();}
});
await record('onboarding_clean_install_adopts_once',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  const dialog=page.locator('.onboarding-dialog');
  await page.waitForTimeout(400);
  if(!await dialog.count()){
   const debug=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {body:document.body.innerText,onboarding:await s.loadOnboardingRecord(),initialized:await s.isCollectionInitialized(),pets:(await s.loadAllPets()).length,native:window.__review.native};});
   return {passed:false,reason:'no onboarding dialog',debug};
  }
  const firstHeading=await dialog.getByRole('heading').first().innerText();
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('团子');
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'团子，很高兴见到你',exact:true}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pets=await s.loadAllPets();const active=await s.loadPet();const record=(await s.loadOnboardingRecord()).record;return {count:pets.length,name:active?.name,activeId:active?.id,record,native:window.__review.native};});
  await page.getByRole('button',{name:'完成见面',exact:true}).click();
  await dialog.waitFor({state:'detached'});
  const done=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  return {passed:firstHeading.includes('给今天添一点陪伴')&&state.count===1&&state.name==='团子'&&state.record?.confirmedPetId===state.activeId&&state.native.petId===state.activeId&&done?.state==='completed'&&errors.length===0,firstHeading,state,done,errors};
 }finally{await context.close();}
});
await record('onboarding_old_user_is_not_forced',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  await seed(page,{desktop:true,active:'A'});
  const dialog=await page.locator('.onboarding-dialog').count();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,record:(await s.loadOnboardingRecord()).record};});
  return {passed:dialog===0&&state.pets===2&&state.active==='A'&&state.record?.state==='completed'&&state.record?.confirmedPetId==='A'&&errors.length===0,dialog,state,errors};
 }finally{await context.close();}
});
await record('onboarding_resumes_prepared_adoption',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const o=await import('/src/onboarding.ts');await s.saveOnboardingRecord(o.createOnboardingRecord({state:'in_progress',step:'name',draftName:'团子',adoptionId:'adoption-a',pendingPetId:'pending-a',phase:'prepared'}));});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.onboarding-dialog').waitFor();
  const draft=await page.locator('#onboarding-name').inputValue();
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'团子，很高兴见到你',exact:true}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:await s.loadAllPets(),active:(await s.loadPet())?.id,record:(await s.loadOnboardingRecord()).record};});
  return {passed:draft==='团子'&&state.pets.length===1&&state.pets[0].id==='pending-a'&&state.active==='pending-a'&&state.record?.adoptionId==='adoption-a'&&errors.length===0,draft,state,errors};
 }finally{await context.close();}
});
await record('onboarding_double_click_creates_one_pet',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('咕唧');
  await page.evaluate(()=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent?.includes('领养并入住'));button?.click();button?.click();});
  await page.getByRole('heading',{name:'咕唧，很高兴见到你',exact:true}).waitFor();
  await page.waitForTimeout(600);
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,record:(await s.loadOnboardingRecord()).record};});
  return {passed:state.pets===1&&state.record?.phase==='committed'&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('onboarding_empty_old_user_stays_empty',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  for(const name of ['测试甲','测试乙']){
   page.once('dialog',d=>d.accept());
   const card=page.locator('.pet-card').filter({hasText:name});
   await card.getByTitle('删除宠物').click();
   await card.waitFor({state:'detached'});
  }
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.companion-empty').waitFor();
  const dialog=await page.locator('.onboarding-dialog').count();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,record:(await s.loadOnboardingRecord()).record};});
  return {passed:dialog===0&&state.pets===0&&state.record?.state==='completed'&&errors.length===0,dialog,state,errors};
 }finally{await context.close();}
});
await record('onboarding_commit_failure_rolls_back_and_retries',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.getByRole('button',{name:/领养与制作/}).click();
  await page.getByRole('button',{name:'再领养一只',exact:true}).click();
  await page.locator('#onboarding-name').fill('团子');
  await page.evaluate(()=>{
   window.__origPut=IDBObjectStore.prototype.put;
   window.__failCommit=true;
   IDBObjectStore.prototype.put=function(value,key){
    const req=window.__origPut.apply(this,arguments);
    if(window.__failCommit&&this.name==='metadata'&&key==='onboarding_v1'&&value&&value.phase==='committed')queueMicrotask(()=>this.transaction.abort());
    return req;
   };
  });
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.locator('.onboarding-error').waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,native:window.__review.native.petId,record:(await s.loadOnboardingRecord()).record};});
  await page.evaluate(()=>{window.__failCommit=false;});
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await page.getByRole('heading',{name:'团子，很高兴见到你',exact:true}).waitFor();
  const retried=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.name,native:window.__review.native.petId,record:(await s.loadOnboardingRecord()).record};});
  return {passed:failed.pets===2&&failed.active==='A'&&failed.native==='A'&&failed.record?.phase==='prepared'&&retried.pets===3&&retried.active==='团子'&&retried.native===retried.record?.confirmedPetId&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('onboarding_corrupt_record_is_not_a_clean_install',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');await s.saveOnboardingRecord({});});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.toast-message.error').filter({hasText:'资料读取失败'}).waitFor();
  const dialog=await page.locator('.onboarding-dialog').count();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,record:await s.loadOnboardingRecord()};});
  return {passed:dialog===0&&state.record.corrupt===true&&state.pets===0&&errors.length===0,dialog,state,errors};
 }finally{await context.close();}
});
await record('interactions_cooldown_and_low_motion',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.getByRole('button',{name:'摸摸头',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.companion-speech')?.textContent.includes('收到你的摸摸'));
  const first=await page.evaluate(()=>({action:window.__review.native.action,rev:window.__review.native.actionRevision}));
  await page.getByRole('button',{name:'打个招呼',exact:true}).click();
  await page.waitForTimeout(120);
  const cooldown=await page.evaluate(()=>({action:window.__review.native.action,rev:window.__review.native.actionRevision}));
  await page.waitForTimeout(1600);
  await page.getByRole('button',{name:'打个招呼',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.action==='jump');
  const second=await page.evaluate(()=>({action:window.__review.native.action,rev:window.__review.native.actionRevision}));
  const controls=page.locator('.companion-control-buttons');
  await controls.getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('已收起'));
  const hiddenDisabled=await page.getByRole('button',{name:'摸摸头',exact:true}).isDisabled();
  const hiddenHelp=await page.locator('.companion-help').innerText();
  await controls.getByRole('button',{name:'立即唤回',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('正在桌面陪着你'));
  await page.locator('#companion-paused').click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('动画已暂停'));
  const pausedDisabled=await page.getByRole('button',{name:'摸摸头',exact:true}).isDisabled();
  await page.locator('#companion-paused').click();
  await page.waitForFunction(()=>!document.querySelector('.status-chip')?.textContent.includes('动画已暂停'));
  await page.locator('.sidebar-settings').click();
  await page.locator('#settings-motion').selectOption('reduce');
  await page.waitForFunction(()=>window.__review.native.motionPreference==='reduce');
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('低动态'));
  await page.waitForTimeout(1600);
  const revBefore=await page.evaluate(()=>window.__review.native.actionRevision);
  await page.getByRole('button',{name:'摸摸头',exact:true}).click();
  await page.waitForTimeout(350);
  const lowMotion=await page.evaluate(()=>({rev:window.__review.native.actionRevision,action:window.__review.native.action,motion:window.__review.native.motionPreference,speech:document.querySelector('.companion-speech')?.textContent,last:window.__review.lastInteractionAt,now:Date.now(),disabled:document.querySelector('.companion-primary-actions button')?.disabled}));
  if(!lowMotion.speech?.includes('收到你的摸摸'))return {passed:false,reason:'low motion interaction missing speech',revBefore,lowMotion,errors};
  return {passed:first.action==='happy'&&cooldown.rev===first.rev&&cooldown.action==='happy'&&second.action==='jump'&&hiddenDisabled&&hiddenHelp.includes('先唤回')&&pausedDisabled&&lowMotion.rev===revBefore&&lowMotion.motion==='reduce'&&errors.length===0,first,cooldown,second,hiddenDisabled,hiddenHelp,pausedDisabled,revBefore,lowMotion,errors};
 }finally{await context.close();}
});
await record('settings_drawer_capabilities_and_narrow_layout',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.locator('.sidebar-settings').click();
  await page.locator('.settings-drawer').waitFor();
  const capabilities=await page.locator('.capability-list').innerText();
  await page.locator('#settings-autonomous').click();
  await page.waitForFunction(()=>window.__review.native.autonomous===false);
  const autonomousChecked=await page.locator('#settings-autonomous').isChecked();
  await page.locator('#settings-paused').click();
  await page.waitForFunction(()=>window.__review.native.animationPaused===true);
  const pausedChecked=await page.locator('#settings-paused').isChecked();
  await page.keyboard.press('Escape');
  await page.locator('.settings-drawer').waitFor({state:'detached'});
  const focusRestored=await page.evaluate(()=>document.activeElement?.classList.contains('sidebar-settings'));
  await page.setViewportSize({width:840,height:620});
  await page.waitForTimeout(250);
  const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth,inner:window.innerWidth}));
  await page.locator('.sidebar-settings').click();
  await page.locator('.settings-drawer').waitFor();
  const drawerBox=await page.locator('.settings-drawer').boundingBox();
  const drawerOverflow=await page.locator('.settings-drawer').evaluate(el=>getComputedStyle(el).overflowY);
  await page.keyboard.press('Escape');
  return {passed:capabilities.includes('透明区域穿透')&&capabilities.includes('支持')&&autonomousChecked===false&&pausedChecked===true&&focusRestored&&overflow.scroll<=overflow.inner&&overflow.body<=overflow.inner&&drawerBox.width<=840&&drawerBox.height<=620&&drawerOverflow==='auto'&&errors.length===0,capabilities,autonomousChecked,pausedChecked,focusRestored,overflow,drawerBox,drawerOverflow,errors};
 }finally{await context.close();}
});
await record('recovery_retry_dismiss_and_reopen',async()=>{
 const {context,page,errors}=await newCase({desktop:true,missing:true});
 try{
  await seed(page,{desktop:true});
  await page.locator('.recovery-notice').waitFor();
  const title=await page.locator('#recovery-title').innerText();
  await page.locator('.recovery-details summary').click();
  const code=await page.locator('.recovery-code-row code').innerText();
  await page.getByRole('button',{name:'关闭这条提示'}).click();
  const reopened=await page.locator('.recovery-reopen').isVisible();
  await page.locator('.recovery-reopen').click();
  await page.locator('.recovery-notice').waitFor();
  await page.evaluate(()=>{window.__review.missing=false;});
  await page.getByRole('button',{name:'重试加载',exact:true}).click();
  await page.locator('.recovery-notice').waitFor({state:'detached'});
  const images=await page.locator('.companion-pet-button img').count();
  return {passed:title.includes('暂时找不到')&&code.includes('ASSET_NOT_FOUND')&&reopened&&images===1&&errors.length===0,title,code,reopened,images,errors};
 }finally{await context.close();}
});
await record('settings_save_failure_keeps_confirmed_value',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.locator('.sidebar-settings').click();
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await page.locator('#settings-autonomous').click();
  await page.locator('.recovery-notice').waitFor();
  const failed=await page.evaluate(()=>({autonomous:window.__review.native.autonomous,error:window.__review.native.lastOperationError}));
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await page.getByRole('button',{name:'重试保存',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.autonomous===false);
  await page.locator('.recovery-notice').waitFor({state:'detached'});
  const retried=await page.evaluate(()=>({autonomous:window.__review.native.autonomous,error:window.__review.native.lastOperationError}));
  return {passed:failed.autonomous===true&&failed.error?.code==='SETTINGS_WRITE_FAILED'&&retried.autonomous===false&&retried.error===null&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('onboarding_skip_and_resume_after_reload',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('咕唧');
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'咕唧，很高兴见到你',exact:true}).waitFor();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.onboarding-dialog').waitFor();
  const resumed=await page.locator('#onboarding-title').innerText();
  const count=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadAllPets()).length);
  await page.getByRole('button',{name:'稍后熟悉',exact:true}).click();
  await page.locator('.onboarding-dialog').waitFor({state:'detached'});
  const record=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  return {passed:resumed.includes('很高兴见到你')&&count===1&&record?.state==='completed'&&errors.length===0,resumed,count,record,errors};
 }finally{await context.close();}
});
await record('shelf_empty_and_reonboard_entry',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  for(const name of ['测试甲','测试乙']){
   page.once('dialog',d=>d.accept());
   const card=page.locator('.pet-card').filter({hasText:name});
   await card.getByTitle('删除宠物').click();
   await card.waitFor({state:'detached'});
  }
  const emptyText=await page.locator('.shelf-empty').innerText();
  await page.getByRole('button',{name:'去领养',exact:true}).click();
  await page.locator('.onboarding-dialog').waitFor();
  const nameStep=await page.locator('#onboarding-name').count()===1;
  await page.keyboard.press('Escape');
  await page.locator('.onboarding-dialog').waitFor({state:'detached'});
  return {passed:emptyText.includes('这里暂时没有伙伴')&&emptyText.includes('去领养')&&emptyText.includes('导入已有伙伴')&&nameStep&&errors.length===0,emptyText,nameStep,errors};
 }finally{await context.close();}
});
await record('autostart_failure_keeps_value_and_retries',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.locator('.sidebar-settings').click();
  await page.locator('.settings-drawer').waitFor();
  const autostartCount=await page.locator('#settings-autostart').count();
  if(!autostartCount)return {passed:false,reason:'autostart row missing',drawer:await page.locator('.settings-drawer').innerText(),capabilities:await page.evaluate(()=>window.__review.native.capabilities)};
  await page.evaluate(()=>{window.__review.failAutostart=true;});
  await page.locator('#settings-autostart').click();
  await page.locator('.recovery-notice').waitFor();
  const failed=await page.evaluate(()=>({enabled:window.__review.native.autostart.enabled,error:window.__review.native.lastOperationError}));
  await page.locator('.sidebar-settings').click();
  await page.locator('.settings-drawer').waitFor();
  const checkedAfterFailure=await page.locator('#settings-autostart').isChecked();
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{window.__review.failAutostart=false;});
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.autostart.enabled===true);
  await page.locator('.recovery-notice').waitFor({state:'detached'});
  return {passed:failed.enabled===false&&failed.error?.code==='AUTOSTART_FAILED'&&checkedAfterFailure===false&&errors.length===0,failed,checkedAfterFailure,errors};
 }finally{await context.close();}
});
await record('web_mode_marks_demo_and_hides_system_settings',async()=>{
 const {context,page,errors}=await newCase();
 try{
  await seed(page);
  const status=await page.locator('.status-chip').innerText();
  await page.locator('.sidebar-settings').click();
  await page.locator('.settings-drawer').waitFor();
  const hasClickThrough=await page.locator('#settings-click-through').count();
  const hasAutostart=await page.locator('#settings-autostart').count();
  const capabilities=await page.locator('.capability-list').innerText();
  await page.keyboard.press('Escape');
  return {passed:status.includes('网页演示')&&hasClickThrough===0&&hasAutostart===0&&capabilities.includes('暂不支持')&&errors.length===0,status,hasClickThrough,hasAutostart,capabilities,errors};
 }finally{await context.close();}
});
await record('onboarding_keyboard_only_adoption',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  await page.locator('.onboarding-dialog').waitFor();
  const initialFocus=await page.evaluate(()=>document.activeElement?.textContent?.trim());
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.id==='onboarding-name');
  await page.keyboard.type('团子');
  await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'团子，很高兴见到你',exact:true}).waitFor();
  const focusAfterMeet=await page.evaluate(()=>document.activeElement?.textContent?.trim());
  if(!focusAfterMeet?.includes('完成见面'))return {passed:false,reason:'meet focus missing',focusAfterMeet};
  await page.keyboard.press('Enter');
  await page.locator('.onboarding-dialog').waitFor({state:'detached'});
  const pets=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadAllPets()).length);
  return {passed:initialFocus?.includes('下一步')&&focusAfterMeet?.includes('完成见面')&&pets===1&&errors.length===0,initialFocus,focusAfterMeet,pets,errors};
 }finally{await context.close();}
});
await record('settings_tutorial_reopens_meet_step',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.locator('.sidebar-settings').click();
  await page.getByRole('button',{name:'查看教学',exact:true}).click();
  await page.locator('.onboarding-dialog').waitFor();
  const title=await page.locator('#onboarding-title').innerText();
  await page.keyboard.press('Escape');
  await page.locator('.onboarding-dialog').waitFor({state:'detached'});
  const record=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  return {passed:title.includes('很高兴见到你')&&record?.state==='completed'&&errors.length===0,title,record,errors};
 }finally{await context.close();}
});
await record('stale_command_reply_does_not_override_event',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await page.evaluate(()=>{window.__review.stalePreferenceReply=true;});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('已收起'));
  const state=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible,status:document.querySelector('.status-chip')?.textContent}));
  return {passed:state.mode==='hidden'&&state.visible===false&&state.status?.includes('已收起')&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('two_windows_create_one_adoption',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  const second=await context.newPage();
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await second.locator('.onboarding-dialog').waitFor();
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await second.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('窗口甲');
  await second.locator('#onboarding-name').fill('窗口乙');
  await Promise.all([
   page.getByRole('button',{name:'领养并入住',exact:true}).click(),
   second.getByRole('button',{name:'领养并入住',exact:true}).click()
  ]);
  await page.locator('.onboarding-dialog').waitFor();
  await second.locator('.onboarding-dialog').waitFor();
  await page.waitForTimeout(500);
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:await s.loadAllPets(),record:(await s.loadOnboardingRecord()).record};});
  const titles=[await page.locator('#onboarding-title').innerText(),await second.locator('#onboarding-title').innerText()];
  return {passed:state.pets.length===1&&state.record?.phase==='committed'&&titles.every(title=>title.includes('很高兴见到你'))&&errors.length===0,pets:state.pets,record:state.record,titles,errors};
 }finally{await context.close();}
});
await record('delete_active_pet_while_hidden_keeps_hidden',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  page.once('dialog',d=>d.accept());
  await page.locator('.pet-card').filter({hasText:'测试甲'}).getByTitle('删除宠物').click();
  await page.waitForFunction(()=>window.__review.native.petId==='B');
  const state=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible,petId:window.__review.native.petId}));
  return {passed:state.mode==='hidden'&&state.visible===false&&state.petId==='B'&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('delete_active_pet_while_snoozed_keeps_expiry',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'休息一小时',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='snoozed');
  const before=await page.evaluate(()=>({until:window.__review.native.snoozeUntilMs}));
  await page.getByRole('button',{name:/我的伙伴/}).click();
  page.once('dialog',d=>d.accept());
  await page.locator('.pet-card').filter({hasText:'测试甲'}).getByTitle('删除宠物').click();
  await page.waitForFunction(()=>window.__review.native.petId==='B');
  const state=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs,visible:window.__review.native.visible,petId:window.__review.native.petId}));
  return {passed:state.mode==='snoozed'&&state.until===before.until&&state.visible===false&&state.petId==='B'&&errors.length===0,before,state,errors};
 }finally{await context.close();}
});
await record('adoption_show_failure_waits_and_retries_display',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  await page.evaluate(()=>{window.__review.native.visibilityMode='hidden';window.__review.native.visible=false;window.__review.emitNative();});
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('等待显示');
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'资料已保存，等待显示',exact:true}).waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {visible:window.__review.native.visible,mode:window.__review.native.visibilityMode,record:(await s.loadOnboardingRecord()).record,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await page.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.getByRole('heading',{name:'等待显示，很高兴见到你',exact:true}).waitFor();
  const retried=await page.evaluate(()=>({visible:window.__review.native.visible,mode:window.__review.native.visibilityMode,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)}));
  return {passed:failed.visible===false&&failed.record?.phase==='committed'&&!failed.toasts.some(text=>text?.includes('入住桌面'))&&retried.visible===true&&retried.mode==='shown'&&retried.toasts.some(text=>text?.includes('已经显示到桌面'))&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('browser_autonomous_checkbox_and_storage_stay_together',async()=>{
 const {context,page,errors}=await newCase();
 try{
  await seed(page);
  const checkbox=page.locator('#companion-autonomous');
  const before=await checkbox.isChecked();
  if(!before)await checkbox.click();
  await page.waitForFunction(()=>document.querySelector('#companion-autonomous')?.checked===true);
  const enabled=await page.evaluate(()=>({stored:localStorage.getItem('desktop-sticker-pet:autonomous'),checked:document.querySelector('#companion-autonomous')?.checked}));
  await checkbox.click();
  await page.waitForFunction(()=>document.querySelector('#companion-autonomous')?.checked===false);
  const disabled=await page.evaluate(()=>({stored:localStorage.getItem('desktop-sticker-pet:autonomous'),checked:document.querySelector('#companion-autonomous')?.checked}));
  return {passed:enabled.stored==='on'&&enabled.checked===true&&disabled.stored==='off'&&disabled.checked===false&&errors.length===0,before,enabled,disabled,errors};
 }finally{await context.close();}
});
await record('connection_retry_recovers_event_subscription',async()=>{
 const {context,page,errors}=await newCase({desktop:true,failStateReads:2});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.recovery-notice').waitFor();
  await page.getByRole('button',{name:'重试连接',exact:true}).click();
  await page.locator('.recovery-notice').waitFor({state:'detached'});
  await page.evaluate(()=>{window.__review.native.visibilityMode='hidden';window.__review.native.visible=false;window.__review.emitNative();});
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent.includes('已收起'));
  const state=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,status:document.querySelector('.status-chip')?.textContent}));
  return {passed:state.mode==='hidden'&&state.status?.includes('已收起')&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('prepared_second_adoption_resumes_name_not_old_companion',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const o=await import('/src/onboarding.ts');await s.saveOnboardingRecord(o.createOnboardingRecord({state:'in_progress',step:'name',draftName:'新伙伴',confirmedPetId:'A',pendingPetId:'new-pet',adoptionId:'new-adoption',previousActivePetId:'A',phase:'prepared'}));});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.onboarding-dialog').waitFor();
  const title=await page.locator('#onboarding-title').innerText();
  const input=await page.locator('#onboarding-name').count();
  const value=input?await page.locator('#onboarding-name').inputValue():'';
  return {passed:title.includes('想怎么称呼它')&&input===1&&value==='新伙伴'&&errors.length===0,title,input,value,errors};
 }finally{await context.close();}
});
await record('stale_window_after_first_finishes_joins_result',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  const second=await context.newPage();
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await second.locator('.onboarding-dialog').waitFor();
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('窗口甲');
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'窗口甲，很高兴见到你',exact:true}).waitFor();
  await page.getByRole('button',{name:'完成见面',exact:true}).click();
  await page.waitForTimeout(500);
  const finishDebug=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {record:(await s.loadOnboardingRecord()).record,dialog:Boolean(document.querySelector('.onboarding-dialog')),error:document.querySelector('.onboarding-error')?.textContent,title:document.querySelector('#onboarding-title')?.textContent};});
  if(finishDebug.dialog)return {passed:false,reason:'finish did not close',finishDebug};
  await page.locator('.onboarding-dialog').waitFor({state:'detached'});
  await second.getByRole('button',{name:'下一步',exact:true}).click();
  await second.locator('#onboarding-name').fill('窗口乙');
  await second.getByRole('button',{name:'领养并入住',exact:true}).click();
  await second.waitForTimeout(500);
  const secondDebug=await second.evaluate(async()=>{const s=await import('/src/storage.ts');return {record:(await s.loadOnboardingRecord()).record,pets:await s.loadAllPets(),dialog:Boolean(document.querySelector('.onboarding-dialog')),error:document.querySelector('.onboarding-error')?.textContent,title:document.querySelector('#onboarding-title')?.textContent};});
  if(secondDebug.dialog)return {passed:false,reason:'second did not close',finishDebug,secondDebug};
  await second.locator('.onboarding-dialog').waitFor({state:'detached'});
  const state=await second.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:await s.loadAllPets(),active:(await s.loadPet())?.id,record:(await s.loadOnboardingRecord()).record};});
  return {passed:state.pets.length===1&&state.record?.state==='completed'&&state.active===state.pets[0].id&&errors.length===0,pets:state.pets,record:state.record,errors};
 }finally{await context.close();}
});
await record('adoption_show_failure_reload_keeps_waiting',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep',nativeMode:'hidden'});
 try{
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('待显示伙伴');
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'资料已保存，等待显示',exact:true}).waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {record:(await s.loadOnboardingRecord()).record,native:window.__review.native};});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'资料已保存，等待显示',exact:true}).waitFor();
  const reloaded=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {record:(await s.loadOnboardingRecord()).record,native:window.__review.native};});
  await page.keyboard.press('Escape');
  const stillWaiting=await page.locator('.onboarding-dialog').isVisible();
  await page.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.getByRole('heading',{name:'待显示伙伴，很高兴见到你',exact:true}).waitFor();
  const confirmed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {record:(await s.loadOnboardingRecord()).record,native:window.__review.native};});
  return {passed:failed.record?.displayConfirmed===false&&failed.native.visible===false&&reloaded.record?.displayConfirmed===false&&reloaded.native.visible===false&&stillWaiting&&confirmed.record?.displayConfirmed===true&&confirmed.native.visible===true&&errors.length===0,failed,reloaded,stillWaiting,confirmed,errors};
 }finally{await context.close();}
});
await record('retry_after_editing_prepared_name_uses_new_name',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('旧名字');
  await page.evaluate(()=>{window.__review.failAttach=true;});
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.locator('.onboarding-error').waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,record:(await s.loadOnboardingRecord()).record};});
  await page.evaluate(()=>{window.__review.failAttach=false;});
  await page.locator('#onboarding-name').fill('新名字');
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'新名字，很高兴见到你',exact:true}).waitFor();
  const retried=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:await s.loadAllPets(),record:(await s.loadOnboardingRecord()).record};});
  return {passed:failed.pets===0&&failed.record?.phase==='prepared'&&retried.pets.length===1&&retried.pets[0].name==='新名字'&&retried.record?.draftName==='新名字'&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('web_scheduling_stops_when_hidden_paused_or_reduced',async()=>{
 const cases=[];
 for(const scenario of ['hidden','paused','reduced']){
  const {context,page,errors}=await newCase();
  try{
   await seed(page);
   const checkbox=page.locator('#companion-autonomous');
   if(!(await checkbox.isChecked()))await checkbox.click();
   if(scenario==='hidden')await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
   if(scenario==='paused')await page.locator('#companion-paused').click();
   if(scenario==='reduced'){
    await page.locator('.sidebar-settings').click();
    await page.locator('#settings-motion').selectOption('reduce');
    await page.keyboard.press('Escape');
   }
   const before=await page.evaluate(async()=>({pet:await (await import('/src/storage.ts')).loadPet()}));
   await page.waitForTimeout(14000);
   const after=await page.evaluate(async()=>({pet:await (await import('/src/storage.ts')).loadPet()}));
   cases.push({scenario,errors,before:{action:before.pet?.currentAction,startedAt:before.pet?.actionStartedAt},after:{action:after.pet?.currentAction,startedAt:after.pet?.actionStartedAt}});
  }finally{await context.close();}
 }
 return {passed:cases.every(item=>item.after.action==='idle'&&item.after.startedAt===item.before.startedAt&&item.errors.length===0),cases};
});
}finally{await browser.close();if(results.some(r=>!r.passed))process.exitCode=1;await writeFile(join(evidenceDir,'workflow-results.json'),JSON.stringify(results,null,2));console.log('EVIDENCE_DIR='+evidenceDir);}
