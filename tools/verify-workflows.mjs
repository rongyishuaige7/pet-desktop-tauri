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
function petCard(page,name){return page.locator('.pet-card').filter({has:page.getByText(name,{exact:true})});}
async function deleteCard(card){await card.locator('.pet-card-more > summary').click();await card.getByRole('button',{name:'移到最近移除',exact:true}).click();}
async function joinOrAdopt(page){const adopt=page.getByRole('button',{name:'领养并入住',exact:true});if(await adopt.count()){await adopt.click();return;}const finish=page.getByRole('button',{name:'完成见面',exact:true});if(await finish.count())await finish.click();}
async function chooseSnooze(scope,minutes=60){await scope.getByRole('button',{name:/^(休息…|调整休息…)$/}).click();await scope.getByRole('menuitem',{name:`${minutes} 分钟`,exact:true}).click();}
async function openWorkshopTask(page,label){await page.getByRole('button',{name:/领养与制作/}).click();const task=page.getByRole('button',{name:new RegExp('^'+label)});if(await task.count())await task.click();}
async function newCase({desktop=false,settingsAction='idle',missing=false,packDelay=0,onboarding='dismiss',failStateReads=0,nativeMode='shown',viewport={width:1120,height:760}}={}) {
 const context=await browser.newContext({viewport});
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
  state.emit=async(payload,event='native-pet-action-changed')=>{
   await Promise.all([...listeners.entries()].filter(([,v])=>v.event===event).map(([id,v])=>callbacks.get(v.handler)?.({event:v.event,id,payload})));
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:(_event,id)=>listeners.delete(id)};
  window.__TAURI_INTERNALS__={
   metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
   transformCallback:(fn)=>{const id=seq++;callbacks.set(id,fn);return id;},
   invoke:async(cmd,args={})=>{
    state.calls.push({cmd,root:args.rootDir??args.request?.rootDir,sourceDir:args.sourceDir,assetId:args.assetId,parentDir:args.parentDir,name:args.name,exportFrameRoot:args.frameRoot,action:args.action,request:args.request,expectedPetId:args.expectedPetId,taskId:args.taskId,resume:args.resume,ownerSession:args.ownerSession,stage:args.task?.stage});
    if(cmd==='plugin:event|listen'){const id=seq++;listeners.set(id,args);if(state.dragLeaveDelay&&args.event==='tauri://drag-leave')await new Promise(resolve=>setTimeout(resolve,state.dragLeaveDelay));return id;}
    if(cmd==='plugin:event|unlisten'){listeners.delete(args.eventId);return;}
    if(cmd==='get_native_pet_settings')return {frameRoot:state.root,scale:1,currentAction:settingsAction,petId:state.native.petId};
    if(cmd==='get_native_pet_state'){if(state.failStateReads>0){state.failStateReads--;throw new Error('mock state read failed');}return state.native;}
    if(cmd==='plugin:dialog|open')return state.dialogPath??null;
    if(cmd==='export_pet_package')return {root:'/exports/'+args.name+'-pet-package'};
    if(cmd==='inspect_pet_package')return state.packageSummary??{name:'包伙伴',species:'dog',style:'q-sticker',createdAt:'2026-10-21T00:00:00Z',actions:{idle:5,sit:5,sleep:5,happy:5,walk:5,jump:5},thumbnail:null};
    if(cmd==='import_pet_package')return {assetId:args.assetId,root:'/managed/'+args.assetId,name:'包伙伴',species:'dog',style:'q-sticker',createdAt:'2026-10-21T00:00:00Z',thumbnail:null};
    if(cmd==='delete_managed_asset'){(state.deletedAssets??=[]).push(args.assetId);return;}
    if(cmd==='copy_to_managed_asset'){
     if(state.failManagedCopy)throw new Error('mock managed copy failed');
     if(state.copyDelay)await new Promise(resolve=>setTimeout(resolve,state.copyDelay));
     return {assetId:args.assetId,root:'/managed/'+args.assetId,totalBytes:30*1024};
    }
    if(cmd==='inspect_frame_directory'){
     const report=state.frameInspection??(()=>{const actions=['idle','sit','sleep','happy','walk','jump'].map(action=>({action,frames:5,minFrames:5,maxFrames:60,issues:[]}));return {root:args.rootDir,actions,missingActions:[],totalBytes:6*5*1024,decodedBytes:6*5*512*512*4,valid:true,issues:[],globalIssues:[],thumbnail:null};})();
     if(state.inspectDelay)await new Promise(resolve=>setTimeout(resolve,state.inspectDelay));
     return report;
    }
    if(cmd==='load_preset_frame_pack'){
     const root=args.request.rootDir;
     if(state.generatedLoadDelay&&root==='/review/generated')await new Promise(resolve=>setTimeout(resolve,state.generatedLoadDelay));
     if(root==='/review/generated'&&state.savedActions)return {sourceImage:state.savedActions.idle[0],actions:state.savedActions};
     await new Promise(r=>setTimeout(r,root==='/review/B'?state.delayB:packDelay));
     if(state.missing)throw new Error('audit: custom frame directory does not exist');
     const actions=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,[0,1,2,3,4].map(i=>`/frame-pack/${a}/${String(i).padStart(3,'0')}.png?review=${root}`)]));
     return {sourceImage:actions.idle[0],actions};
    }
    if(cmd==='set_native_pet_frame_root'){
     if(state.failAttach)throw new Error('mock attach failed');
     if(args.rootDir==='/review/generated'&&state.delayGeneratedCommit){state.committing=true;await new Promise(r=>setTimeout(r,state.delayGeneratedCommit));if(state.failGeneratedAttach)throw new Error('宠物选择已更新，已忽略旧请求');}
     if (state.failB && args.rootDir==='/review/B') throw new Error('audit: invalid pack');
     state.root=args.rootDir;state.visible=true;
     Object.assign(state.native,{petId:args.petId??null,petName:args.petName??null,availability:'ready'});
     state.native.actionRevision++;
     state.emitNative();
     if(state.emitOnSet)setTimeout(()=>{state.action='walk';state.native.action='walk';state.native.actionRevision++;void state.emitNative();},30);
     return state.native;
    }
    if(cmd==='hide_studio_window'){state.hideStudio=(state.hideStudio??0)+1;return;}
    if(cmd==='detach_native_pet'){if(args.expectedPetId&&args.expectedPetId!==state.native.petId)throw new Error('TARGET_CHANGED: mock target changed');Object.assign(state.native,{petId:null,petName:null,availability:'absent',visible:false});state.visible=false;state.emitNative();return;}
    if(cmd==='set_native_pet_name'){state.native.petName=args.name;state.emitNative();return;}
    if(cmd==='set_native_pet_action'){state.action=args.action;state.native.action=args.action;state.native.actionRevision++;state.emitNative();return {action:args.action,petId:state.native.petId,revision:state.native.actionRevision};}
    if(cmd==='set_native_pet_visible'){state.native.visibilityMode=args.visible?'shown':'hidden';state.visible=args.visible;state.emitNative();return state.native;}
    if(cmd==='set_native_pet_scale'){state.native.scale=args.scale;return state.native;}
    if(cmd==='reset_native_pet_position')return;
    if(cmd==='update_native_pet_preferences'){
     const r=args.request;const n=state.native;
     if(r.expectedPetId&&r.expectedPetId!==n.petId)throw new Error('TARGET_CHANGED: mock target changed');
     if(r.expectedState&&(r.expectedState.sessionId!==n.sessionId||r.expectedState.revision!==n.revision))throw new Error('STATE_CHANGED: mock state changed');
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
     if(r.kind==='snooze'){
      if(r.durationMinutes!==undefined&&![15,30,60].includes(r.durationMinutes)){
       n.lastOperationError={id:'mock-snooze-error',operation:'snooze',code:'SNOOZE_DURATION_INVALID',recoverable:true};
       await state.emitNative();
       throw new Error('SNOOZE_DURATION_INVALID: mock invalid duration');
      }
      n.visibilityMode='snoozed';n.snoozeUntilMs=Date.now()+(r.durationMinutes??60)*60000;
     }
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
     if(state.generationDelay)await new Promise(resolve=>setTimeout(resolve,state.generationDelay));
     if(state.generations===state.failGenerationAt)throw new Error('mock temporary generation failure');
     return state.makeImage(args.request.aspectRatio==='3:2');
    }
    if(cmd==='list_generation_tasks')return state.generationTasks??[];
    if(cmd==='create_generation_task'){
     const task={...args.task,revision:1,ownerSession:null,createdAt:'2026-10-26T00:00:00Z',updatedAt:'2026-10-26T00:00:00Z'};
     state.activeGenerationTask=task;
     return task;
    }
    if(cmd==='claim_generation_task')return {status:'claimed',task:{...(state.activeGenerationTask??{taskId:args.taskId,pendingPetId:'mock-pending',stage:'draft'}),ownerSession:args.ownerSession,revision:2,updatedAt:'2026-10-26T00:00:00Z'}};
    if(cmd==='update_generation_task'){const task={...args.task,revision:args.expectedRevision+1,ownerSession:args.ownerSession,updatedAt:'2026-10-26T00:00:00Z'};state.activeGenerationTask=task;return task;}
    if(cmd==='release_generation_task')return null;
    if(cmd==='load_generation_task')return state.activeGenerationTask??null;
    if(cmd==='save_manual_frame_pack'){
     state.saves++;state.savedActions=args.request.actions;state.saving=true;
     if(state.manualSaveDelay)await new Promise(resolve=>setTimeout(resolve,state.manualSaveDelay));
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
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('desktop-sticker-pet-db',4);req.onupgradeneeded=()=>{const database=req.result;for(const name of ['pet','pets_collection','metadata','removed_pets','creation_drafts'])if(!database.objectStoreNames.contains(name))database.createObjectStore(name,name==='creation_drafts'?{keyPath:'draftId'}:name==='pets_collection'||name==='removed_pets'?{keyPath:'id'}:undefined);};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  await new Promise((resolve,reject)=>{const stores=['pet','pets_collection','metadata','removed_pets','creation_drafts'];const tx=db.transaction(stores,'readwrite');for(const name of stores)tx.objectStore(name).clear();tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
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
const only=process.env.PET_ONLY?new Set(process.env.PET_ONLY.split(',').map(name=>name.trim()).filter(Boolean)):null;
async function record(name,fn){
 if(only&&!only.has(name))return;
 try{const detail=await fn();const result={name,...detail};results.push(result);console.log(JSON.stringify(result));}
 catch(e){const result={name,harnessError:e.message};results.push(result);console.log(JSON.stringify(result));}
}
async function openAI(page){
 await openWorkshopTask(page,'用照片制作');
 await page.locator('input[type=password]').fill('mock-key');
 await page.getByPlaceholder('https://your-domain.example/upload').fill('https://example.test/upload');
 const data=await page.evaluate(()=>window.__review.makeImage().split(',')[1]);
 await page.locator('input[type=file]').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from(data,'base64')});
 await page.getByRole('checkbox',{name:/我了解照片/}).check();
 await page.getByRole('button',{name:'生成角色图',exact:true}).waitFor();
}
async function generateCharacterReview(page){
 await page.getByRole('button',{name:'生成角色图',exact:true}).click();
 await page.locator('.ai-character-review').waitFor();
}
async function confirmAICharacter(page){
 await page.getByRole('button',{name:'确认角色并生成动作',exact:true}).click();
}
try{
 await record('manual_upload_errors_and_recovery',async()=>{
  const {context,page,errors}=await newCase();
  try{
   await openWorkshopTask(page,'装配动作帧');
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
   await generateCharacterReview(page);
   await confirmAICharacter(page);
   await page.waitForFunction(()=>window.__review.saving===true);
   const frozen=await page.getByPlaceholder('例如：糖宝、奶茶').isDisabled();
   await page.getByRole('button',{name:'取消',exact:true}).click();
   await page.evaluate(()=>{window.__review.releaseSave();});
   await page.getByRole('button',{name:'确认角色并生成动作',exact:true}).waitFor();
   const cancelled=await page.evaluate(async()=>({active:(await (await import('/src/storage.ts')).loadPet())?.id,generations:window.__review.generations,saves:window.__review.saves}));
   await page.evaluate(()=>{window.__review.delayGeneratedCommit=500;});
   await confirmAICharacter(page);
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
   await generateCharacterReview(page);
   await confirmAICharacter(page);
   await page.locator('.toast-message.error').filter({hasText:'动作生成失败'}).first().waitFor();
   const afterFail=await page.evaluate(()=>({generations:window.__review.generations,saves:window.__review.saves,review:Boolean(document.querySelector('.ai-character-review'))}));
   await confirmAICharacter(page);
   await page.locator('.companion-title').waitFor();
   const resumed=await page.evaluate(()=>({generations:window.__review.generations,saves:window.__review.saves}));
   await openAI(page);
   const beforeName=await page.evaluate(()=>window.__review.generations);
   await page.evaluate(()=>{window.__review.failGenerationAt=window.__review.generations+2;});
   await generateCharacterReview(page);
   await confirmAICharacter(page);
   await page.locator('.toast-message.error').filter({hasText:'动作生成失败'}).first().waitFor();
   await page.getByPlaceholder('例如：糖宝、奶茶').fill('新的名字');
   const afterName=await page.evaluate(()=>({generations:window.__review.generations,review:Boolean(document.querySelector('.ai-character-review'))}));
   return {passed:afterFail.review&&resumed.generations===8&&resumed.saves===1&&afterName.review&&afterName.generations===beforeName+2&&errors.length===0,afterFail,resumed,beforeName,afterName,errors};
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
   await deleteCard(petCard(page,'测试甲'));
   await petCard(page,'测试甲').waitFor({state:'detached'});
   await page.getByRole('button',{name:'陪伴',exact:true}).click();
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
   await petCard(page,'测试乙').getByRole('button',{name:/派去桌面/}).click();
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
   await petCard(page,'测试乙').getByRole('button',{name:/派去桌面/}).click();
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
   await petCard(page,'测试乙').getByRole('button',{name:/派去桌面/}).click();
   await page.waitForFunction(()=>document.querySelector('.widget-name')?.textContent==='测试乙');
   await page.evaluate(()=>window.__review.emit({action:'sleep',petId:'A',revision:100}));
   await page.getByRole('button',{name:'陪伴',exact:true}).click();
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
    page.once('dialog',d=>d.accept());const card=petCard(page,name);
    await deleteCard(card);await card.waitFor({state:'detached'});
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
    const card=petCard(page,name);
    await deleteCard(card);await card.waitFor({state:'detached'});
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
  await chooseSnooze(controls,60);
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
   const card=petCard(page,name);
   await deleteCard(card);
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
  await openWorkshopTask(page,'领养现成伙伴');
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
   const card=petCard(page,name);
   await deleteCard(card);
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
  await deleteCard(petCard(page,'测试甲'));
  await page.waitForFunction(()=>window.__review.native.petId==='B');
  const state=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible,petId:window.__review.native.petId}));
  return {passed:state.mode==='hidden'&&state.visible===false&&state.petId==='B'&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('delete_active_pet_while_snoozed_keeps_expiry',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await chooseSnooze(page.locator('.companion-control-buttons'),60);
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='snoozed');
  const before=await page.evaluate(()=>({until:window.__review.native.snoozeUntilMs}));
  await page.getByRole('button',{name:/我的伙伴/}).click();
  page.once('dialog',d=>d.accept());
  await deleteCard(petCard(page,'测试甲'));
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
  await page.waitForTimeout(600);
  const retryTitle=await page.locator('#onboarding-title').innerText();
  if(!retryTitle.includes('很高兴见到你'))return {passed:false,reason:'retry did not leave waiting',retryTitle,debug:await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {error:document.querySelector('.onboarding-error')?.textContent,record:(await s.loadOnboardingRecord()).record,native:window.__review.native};})};
  try{await page.waitForFunction(()=>document.querySelector('#onboarding-title')?.textContent==='等待显示，很高兴见到你',{timeout:30000});}
  catch{return {passed:false,reason:'heading mismatch',retryTitle,debug:await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {title:document.querySelector('#onboarding-title')?.textContent,dialog:Boolean(document.querySelector('.onboarding-dialog')),error:document.querySelector('.onboarding-error')?.textContent,record:(await s.loadOnboardingRecord()).record,active:(await s.loadPet())?.name,native:window.__review.native};})};}
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
  await second.getByRole('button',{name:'下一步',exact:true}).click();
  await second.locator('#onboarding-name').fill('窗口乙');
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'窗口甲，很高兴见到你',exact:true}).waitFor();
  await page.getByRole('button',{name:'完成见面',exact:true}).click();
  await page.waitForTimeout(500);
  const finishDebug=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {record:(await s.loadOnboardingRecord()).record,dialog:Boolean(document.querySelector('.onboarding-dialog')),error:document.querySelector('.onboarding-error')?.textContent,title:document.querySelector('#onboarding-title')?.textContent};});
  if(finishDebug.dialog)return {passed:false,reason:'finish did not close',finishDebug};
  await page.locator('.onboarding-dialog').waitFor({state:'detached'});
  await joinOrAdopt(second);
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
  await page.waitForTimeout(600);
  const retryHeading=await page.locator('#onboarding-title').innerText();
  if(!retryHeading.includes('很高兴见到你'))return {passed:false,reason:'retry did not leave waiting',retryHeading,debug:await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {error:document.querySelector('.onboarding-error')?.textContent,record:(await s.loadOnboardingRecord()).record,native:window.__review.native};})};
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
await record('old_waiting_retry_cannot_overwrite_new_intent',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep',nativeMode:'hidden'});
 try{
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('甲');
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'资料已保存，等待显示',exact:true}).waitFor();
  const newer=await page.evaluate(async()=>{
   const s=await import('/src/storage.ts');const o=await import('/src/onboarding.ts');
   const previousActivePetId=(await s.loadPet())?.id??null;
   const next=o.createOnboardingRecord({state:'in_progress',step:'name',draftName:'乙',phase:'draft',intentId:'intent-2',previousActivePetId});
   const started=await s.startNewAdoptionIntent(next);
   const claim=await s.claimAdoptionRecord(started,'乙',previousActivePetId);
   const committed=o.markAdoptionCommitted(claim.record,claim.record.pendingPetId);
   const pet={id:claim.record.pendingPetId,name:'乙',species:'dog',style:'q-sticker',storageMode:'preset-root',frameRoot:'./frame-pack',createdAt:new Date().toISOString(),sourceImage:'',actions:{idle:[],sit:[],sleep:[],happy:[],walk:[],jump:[]},currentAction:'idle',actionStartedAt:new Date().toISOString(),scale:1};
   await s.commitAdoptedPet(pet,{...committed,displayConfirmed:true},claim.record.previousActivePetId);
   await s.setActivePetId(pet.id);
   return {petId:pet.id,intentId:claim.record.intentId,record:(await s.loadOnboardingRecord()).record};
  });
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await page.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.waitForTimeout(600);
  const after=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:await s.loadAllPets(),active:(await s.loadPet())?.id,record:(await s.loadOnboardingRecord()).record};});
  return {passed:after.record?.intentId==='intent-2'&&after.record?.confirmedPetId===newer.petId&&after.active===newer.petId&&after.pets.length===2&&errors.length===0,newer,after,errors};
 }finally{await context.close();}
});
await record('old_record_new_adoption_draft_saves',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const o=await import('/src/onboarding.ts');await s.saveOnboardingRecord(o.createOnboardingRecord({state:'completed',step:'meet',phase:'committed',confirmedPetId:'A',pendingPetId:'A',intentId:null,displayConfirmed:true,updatedAt:new Date().toISOString()}));});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'领养现成伙伴');
  await page.getByRole('button',{name:'再领养一只',exact:true}).click();
  await page.locator('#onboarding-name').fill('新伙伴');
  const afterStart=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  try{await page.getByRole('heading',{name:'新伙伴，很高兴见到你',exact:true}).waitFor({timeout:30000});}
  catch{return {passed:false,reason:'meet heading missing',debug:await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {title:document.querySelector('#onboarding-title')?.textContent,dialog:Boolean(document.querySelector('.onboarding-dialog')),error:document.querySelector('.onboarding-error')?.textContent,record:(await s.loadOnboardingRecord()).record,active:(await s.loadPet())?.name,pets:(await s.loadAllPets()).map(p=>p.name),native:window.__review.native,toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent)};})};}
  const after=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:await s.loadAllPets(),record:(await s.loadOnboardingRecord()).record};});
  return {passed:afterStart?.state==='in_progress'&&Boolean(afterStart?.intentId)&&after.pets.length===3&&after.pets.some(pet=>pet.name==='新伙伴')&&after.record?.confirmedPetId!==null&&errors.length===0,afterStart,after,errors};
 }finally{await context.close();}
});
await record('follow_window_leaves_waiting_when_native_confirms',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep',nativeMode:'hidden'});
 try{
  const second=await context.newPage();
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await second.locator('.onboarding-dialog').waitFor();
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('待显示');
  await second.getByRole('button',{name:'下一步',exact:true}).click();
  await second.locator('#onboarding-name').fill('待显示');
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'资料已保存，等待显示',exact:true}).waitFor();
  await joinOrAdopt(second);
  await second.getByRole('heading',{name:'资料已保存，等待显示',exact:true}).waitFor();
  const waiting=await second.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await page.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.getByRole('heading',{name:'待显示，很高兴见到你',exact:true}).waitFor();
  const confirmed=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  await second.evaluate((petId)=>{window.__review.native.petId=petId;window.__review.native.availability='ready';window.__review.native.visibilityMode='shown';window.__review.native.visible=true;window.__review.emitNative();},confirmed.confirmedPetId);
  await second.getByRole('heading',{name:'待显示，很高兴见到你',exact:true}).waitFor();
  const followed=await second.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  return {passed:waiting?.displayConfirmed===false&&confirmed?.displayConfirmed===true&&followed?.displayConfirmed===true&&errors.length===0,waiting,confirmed,followed,errors};
 }finally{await context.close();}
});
await record('stale_meet_completion_does_not_overwrite_new_draft',async()=>{
 const {context,page,errors}=await newCase({desktop:true,onboarding:'keep'});
 try{
  const second=await context.newPage();
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await second.locator('.onboarding-dialog').waitFor();
  await page.getByRole('button',{name:'下一步',exact:true}).click();
  await page.locator('#onboarding-name').fill('甲');
  await page.getByRole('button',{name:'领养并入住',exact:true}).click();
  await page.getByRole('heading',{name:'甲，很高兴见到你',exact:true}).waitFor();
  await second.reload({waitUntil:'domcontentloaded'});
  await second.locator('.onboarding-dialog').waitFor();
  const meetButton=await second.getByRole('button',{name:'稍后熟悉',exact:true}).count();
  if(!meetButton)return {passed:false,reason:'second not on meet',debug:await second.evaluate(()=>({title:document.querySelector('#onboarding-title')?.textContent,body:document.querySelector('.onboarding-body')?.textContent}))};
  await second.getByRole('button',{name:'稍后熟悉',exact:true}).click();
  await second.locator('.onboarding-dialog').waitFor({state:'detached'});
  await openWorkshopTask(second,'领养现成伙伴');
  await second.getByRole('button',{name:'再领养一只',exact:true}).click();
  await second.locator('#onboarding-name').fill('乙');
  await second.keyboard.press('Tab');
  await second.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadOnboardingRecord()).record?.draftName==='乙';});
  const before=await second.evaluate(async()=>(await (await import('/src/storage.ts')).loadOnboardingRecord()).record);
  const finishButton=page.getByRole('button',{name:'完成见面',exact:true});
  const staleStillOpen=await finishButton.count()>0;
  if(staleStillOpen)await finishButton.click();
  await page.waitForTimeout(500);
  const after=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {record:(await s.loadOnboardingRecord()).record,error:document.querySelector('.onboarding-error')?.textContent,title:document.querySelector('#onboarding-title')?.textContent,dialog:Boolean(document.querySelector('.onboarding-dialog'))};});
  const handled=staleStillOpen?Boolean(after.error):!after.dialog;
  return {passed:before?.draftName==='乙'&&after.record?.intentId===before?.intentId&&after.record?.draftName==='乙'&&after.record?.state==='in_progress'&&handled&&errors.length===0,before,after,staleStillOpen,handled,errors};
 }finally{await context.close();}
});
await record('shelf_deploy_show_failure_does_not_report_success',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await petCard(page,'测试乙').getByRole('button',{name:/派去桌面/}).click();
  await page.locator('.toast-message.error').filter({hasText:'暂时没能显示'}).waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,native:{petId:window.__review.native.petId,mode:window.__review.native.visibilityMode,visible:window.__review.native.visible},toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await petCard(page,'测试乙').getByRole('button',{name:'重试显示',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visible===true);
  const retried=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible}));
  return {passed:failed.active==='B'&&failed.native.petId==='B'&&failed.native.mode==='hidden'&&failed.native.visible===false&&!failed.toasts.some(text=>text?.includes('派往桌面'))&&failed.toasts.some(text=>text?.includes('暂时没能显示'))&&retried.mode==='shown'&&retried.visible===true&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});

await record('import_show_failure_retries_display_only',async()=>{
 const {context,page,errors}=await newCase({desktop:true,nativeMode:'hidden'});
 try{
  await openWorkshopTask(page,'导入已有伙伴');
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await page.getByRole('button',{name:'一键导入并保存到宠物架',exact:true}).click();
  await page.locator('.toast-message.error').filter({hasText:'暂时没能显示'}).waitFor();
  await page.locator('.recovery-notice').filter({hasText:'还没有显示到桌面'}).waitFor();
  const read=()=>page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,loads:window.__review.calls.filter(c=>c.cmd==='load_preset_frame_pack').length,shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length,visible:window.__review.native.visible,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  const failed=await read();
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await page.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visible===true);
  const retried=await read();
  return {passed:failed.pets===1&&failed.loads===2&&failed.shows===1&&failed.visible===false&&!failed.toasts.some(text=>text?.includes('同步至桌面'))&&retried.pets===1&&retried.loads===2&&retried.shows===2&&retried.toasts.some(text=>text?.includes('已在桌面陪着你'))&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('assembly_show_failure_retries_display_only',async()=>{
 const {context,page,errors}=await newCase({desktop:true,nativeMode:'hidden'});
 try{
  await openWorkshopTask(page,'装配动作帧');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  const file={name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')};
  for(const label of ['待机','坐下','睡觉','开心','走路','跳跃']){
   await page.getByRole('button',{name:new RegExp('^'+label+' \\(')}).click();
   await page.locator('.frame-add-card input[type=file]').setInputFiles(Array.from({length:5},(_,i)=>({...file,name:`${label}-${i}.png`})));
  }
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.locator('.toast-message.error').filter({hasText:'暂时没能显示'}).waitFor();
  const read=()=>page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,saves:window.__review.saves,shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length,visible:window.__review.native.visible,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  const failed=await read();
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await page.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visible===true);
  const retried=await read();
  return {passed:failed.pets===1&&failed.saves===1&&failed.shows===1&&failed.visible===false&&!failed.toasts.some(text=>text?.includes('同步至桌面'))&&retried.pets===1&&retried.saves===1&&retried.shows===2&&retried.visible===true&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('ai_character_confirmation_blocks_actions',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openAI(page);
  await generateCharacterReview(page);
  const first=await page.evaluate(()=>({generations:window.__review.generations,saves:window.__review.saves,review:document.querySelector('.ai-character-review')?.textContent??''}));
  await page.getByRole('button',{name:'调整描述后重新生成',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.ai-character-review')?.textContent?.includes('v2'),null,{timeout:10000});
  const second=await page.evaluate(()=>({generations:window.__review.generations,review:document.querySelector('.ai-character-review')?.textContent??''}));
  const beforeName=await page.evaluate(()=>window.__review.generations);
  await page.getByPlaceholder('例如：糖宝、奶茶').fill('改名不重生成');
  const afterName=await page.evaluate(()=>window.__review.generations);
  await confirmAICharacter(page);
  await page.locator('.companion-title').waitFor({timeout:15000});
  const done=await page.evaluate(async()=>({generations:window.__review.generations,saves:window.__review.saves,pets:(await (await import('/src/storage.ts')).loadAllPets()).length}));
  return {passed:first.generations===1&&first.saves===0&&first.review.includes('v1')&&second.generations===2&&second.review.includes('v2')&&second.review.includes('旧角色版本已保留 1 个')&&afterName===beforeName&&done.generations===8&&done.saves===1&&done.pets===1&&errors.length===0,first,second,beforeName,afterName,done,errors};
 }finally{await context.close();}
});
await record('ai_show_failure_retries_display_only',async()=>{
 const {context,page,errors}=await newCase({desktop:true,nativeMode:'hidden'});
 try{
  await openAI(page);
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await generateCharacterReview(page);
  await confirmAICharacter(page);
  await page.locator('.toast-message.error').filter({hasText:'暂时没能显示'}).waitFor();
  const read=()=>page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,generations:window.__review.generations,saves:window.__review.saves,shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length,visible:window.__review.native.visible,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  const failed=await read();
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await page.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visible===true);
  const retried=await read();
  return {passed:failed.pets===1&&failed.generations===7&&failed.saves===1&&failed.shows===1&&failed.visible===false&&!failed.toasts.some(text=>text?.includes('同步至桌面'))&&retried.pets===1&&retried.generations===7&&retried.saves===1&&retried.shows===2&&retried.visible===true&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('display_retry_invalidated_by_newer_selection',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await petCard(page,'测试乙').getByRole('button',{name:/派去桌面/}).click();
  await petCard(page,'测试乙').getByRole('button',{name:'重试显示',exact:true}).waitFor();
  await page.evaluate(()=>{window.__review.failPreference=false;});
  const second=await context.newPage();
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await second.locator('.companion-pet-button').waitFor();
  await second.evaluate(async()=>{await (await import('/src/storage.ts')).setActivePetId('A');});
  await page.waitForTimeout(300);
  const shows=()=>page.evaluate(()=>window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length);
  const before=await shows();
  await page.waitForTimeout(400);
  const after=await page.evaluate(()=>({visible:window.__review.native.visible,displayRecovery:document.querySelector('.recovery-notice')?.textContent?.includes('还没有显示到桌面')??false,retryButtons:[...document.querySelectorAll('button')].filter(node=>node.textContent?.trim()==='重试显示').length}));
  const afterShows=await shows();
  return {passed:before===1&&afterShows===1&&after.visible===false&&!after.displayRecovery&&after.retryButtons===0&&errors.length===0,before,afterShows,after,errors};
 }finally{await context.close();}
});
await record('display_retry_rejected_by_native_target',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await petCard(page,'测试乙').getByRole('button',{name:/派去桌面/}).click();
  await petCard(page,'测试乙').getByRole('button',{name:'重试显示',exact:true}).waitFor();
  await page.evaluate(()=>{window.__review.failPreference=false;window.__review.native.petId='intruder';});
  await petCard(page,'测试乙').getByRole('button',{name:'重试显示',exact:true}).click();
  await page.waitForTimeout(400);
  const state=await page.evaluate(()=>({shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length,visible:window.__review.native.visible,displayRecovery:document.querySelector('.recovery-notice')?.textContent?.includes('还没有显示到桌面')??false,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)}));
  return {passed:state.shows===2&&state.visible===false&&!state.displayRecovery&&state.toasts.some(text=>text?.includes('已失效'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('display_retry_is_not_replayed_after_reload',async()=>{
 const {context,page,errors}=await newCase({desktop:true,nativeMode:'hidden'});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.failPreference=true;});
  await petCard(page,'测试乙').getByRole('button',{name:/派去桌面/}).click();
  await petCard(page,'测试乙').getByRole('button',{name:'重试显示',exact:true}).waitFor();
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.companion-pet-button').waitFor();
  await page.waitForTimeout(500);
  const reloaded=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,pets:(await s.loadAllPets()).length,shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length,visible:window.__review.native.visible,mode:window.__review.native.visibilityMode,recovery:Boolean(document.querySelector('.recovery-notice'))};});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'立即唤回',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visible===true);
  const recalled=await page.evaluate(()=>({visible:window.__review.native.visible,mode:window.__review.native.visibilityMode}));
  return {passed:reloaded.active==='B'&&reloaded.pets===2&&reloaded.shows===0&&reloaded.visible===false&&!reloaded.recovery&&recalled.visible===true&&recalled.mode==='shown'&&errors.length===0,reloaded,recalled,errors};
 }finally{await context.close();}
});
await record('web_import_reports_preview_not_desktop',async()=>{
 const {context,page,errors}=await newCase();
 try{
  await openWorkshopTask(page,'导入已有伙伴');
  await page.getByRole('button',{name:'一键导入并保存到宠物架',exact:true}).click();
  await page.locator('.toast-message.success').filter({hasText:'可在网页预览'}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.status-chip')?.textContent?.includes('网页演示'));
  const state=await page.evaluate(async()=>({pets:(await (await import('/src/storage.ts')).loadAllPets()).length,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent),webTag:document.querySelector('.status-chip')?.textContent?.includes('网页演示')??false}));
  return {passed:state.pets===1&&state.toasts.some(text=>text?.includes('可在网页预览'))&&!state.toasts.some(text=>text?.includes('桌面')||text?.includes('同步'))&&state.webTag&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('compact_first_screen_controls_are_reachable',async()=>{
 const {context,page,errors}=await newCase({desktop:true,viewport:{width:840,height:620}});
 try{
  await seed(page,{desktop:true,active:'A'});
  const measure=()=>page.evaluate(()=>{
   const rect=(el)=>{const r=el.getBoundingClientRect();return {top:r.top,left:r.left,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
   return {status:rect(document.querySelector('.status-chip')),bar:rect(document.querySelector('.companion-core-controls')),buttons:[...document.querySelectorAll('.companion-control-buttons button')].map(el=>({text:(el.textContent||'').trim(),...rect(el)})),scrollTop:document.querySelector('.app-content')?.scrollTop??0,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,bars:document.querySelectorAll('.companion-controls').length};
  });
  const inView=(r)=>Boolean(r)&&r.top>=-0.5&&r.left>=-0.5&&r.bottom<=620.5&&r.right<=840.5;
  const buttonsOk=(state)=>state.buttons.length===3&&state.buttons.every(button=>inView(button)&&button.width>=40&&button.height>=40);
  const normal=await measure();
  const normalOk=inView(normal.status)&&inView(normal.bar)&&buttonsOk(normal)&&normal.buttons.some(button=>button.text==='暂时收起')&&normal.buttons.some(button=>button.text==='休息…')&&normal.buttons.some(button=>button.text.includes('偏好设置'))&&normal.scrollTop===0&&normal.bars===1&&normal.scrollWidth<=normal.clientWidth;
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  const hidden=await measure();
  const hiddenOk=inView(hidden.status)&&buttonsOk(hidden)&&hidden.buttons.some(button=>button.text==='立即唤回')&&hidden.scrollTop===0;
  await chooseSnooze(page.locator('.companion-control-buttons'),60);
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='snoozed');
  const snoozed=await measure();
  const snoozedOk=inView(snoozed.status)&&buttonsOk(snoozed)&&snoozed.buttons.some(button=>button.text==='提前唤回')&&snoozed.scrollTop===0;
  await page.screenshot({path:join(evidenceDir,'c01-compact-840x620.png')});
  return {passed:normalOk&&hiddenOk&&snoozedOk&&errors.length===0,normalOk,hiddenOk,snoozedOk,normal,hidden,snoozed,errors};
 }finally{await context.close();}
});
await record('compact_long_name_and_zoom_reflow',async()=>{
 const {context,page,errors}=await newCase({desktop:true,viewport:{width:1120,height:760}});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.evaluate(async()=>{await (await import('/src/storage.ts')).renamePet('A','一二三四五六七八九十一二三四五六七八九十');});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('.companion-title').waitFor();
  const wide=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,titleRight:document.querySelector('.companion-title')?.getBoundingClientRect().right??0,innerWidth:window.innerWidth,bars:document.querySelectorAll('.companion-controls').length}));
  await page.setViewportSize({width:420,height:310});
  await page.waitForTimeout(250);
  const zoom=await page.evaluate(()=>{const buttons=[...document.querySelectorAll('.companion-control-buttons button')].map(el=>{const r=el.getBoundingClientRect();return {text:(el.textContent||'').trim(),width:r.width,height:r.height,left:r.left,right:r.right};});return {scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,buttons,bars:document.querySelectorAll('.companion-controls').length};});
  const zoomOk=zoom.scrollWidth<=zoom.clientWidth&&zoom.buttons.length===3&&zoom.buttons.every(button=>button.width>=40&&button.height>=40&&button.left>=-0.5&&button.right<=420.5)&&zoom.bars===1;
  return {passed:wide.scrollWidth<=wide.clientWidth&&wide.bars===1&&wide.titleRight<=wide.innerWidth&&zoomOk&&errors.length===0,wide,zoom,errors};
 }finally{await context.close();}
});
await record('keyboard_focus_clear_of_sticky_controls',async()=>{
 const {context,page,errors}=await newCase({desktop:true,viewport:{width:840,height:620}});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.evaluate(()=>{const content=document.querySelector('.app-content');if(content)content.scrollTop=content.scrollHeight;});
  await page.waitForTimeout(200);
  const stops=[];
  for(let i=0;i<20;i++){
   await page.keyboard.press('Tab');
   stops.push(await page.evaluate(()=>{const el=document.activeElement;if(!el||el===document.body)return null;const r=el.getBoundingClientRect();const bar=document.querySelector('.companion-core-controls')?.getBoundingClientRect();return {tag:el.tagName,text:(el.textContent||'').trim().slice(0,32),top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,barBottom:bar?.bottom??0,barLeft:bar?.left??0,barRight:bar?.right??0,inBar:Boolean(el.closest('.companion-core-controls'))};}));
  }
  const usable=stops.filter(Boolean);
  const inView=usable.filter(stop=>stop.top>=-0.5&&stop.bottom<=620.5&&stop.left>=-0.5&&stop.right<=840.5);
  const covered=usable.filter(stop=>!stop.inBar&&stop.top<stop.barBottom&&stop.bottom>0&&stop.right>stop.barLeft&&stop.left<stop.barRight);
  const core=usable.filter(stop=>stop.inBar).length;
  const details=usable.filter(stop=>stop.text.includes('更多动作')).length;
  return {passed:usable.length>=12&&inView.length===usable.length&&covered.length===0&&core>=2&&details>=1&&errors.length===0,stops:usable,covered,core,details,errors};
 }finally{await context.close();}
});
await record('compact_recovery_not_covered_by_sticky_bar',async()=>{
 const {context,page,errors}=await newCase({desktop:true,missing:true,viewport:{width:840,height:620}});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.recovery-notice').waitFor();
  const state=await page.evaluate(()=>{const rect=(el)=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom};};return {recovery:rect(document.querySelector('.recovery-notice')),bar:rect(document.querySelector('.companion-core-controls')),scrollTop:document.querySelector('.app-content')?.scrollTop??0};});
  return {passed:state.recovery.top>=0&&state.recovery.bottom<=state.bar.top+1&&state.bar.bottom<=620.5&&state.scrollTop===0&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('shelf_current_card_actions_follow_state',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const card=petCard(page,'测试甲');
  const read=()=>card.evaluate(el=>({status:el.querySelector('.pet-card-status')?.textContent?.trim()??null,primary:el.querySelector('.pet-card-action-row .btn-primary')?.textContent?.trim()??null,secondary:el.querySelector('.pet-card-action-row .btn-secondary')?.textContent?.trim()??null,buttons:[...el.querySelectorAll('.pet-card-action-row button')].map(button=>button.textContent?.trim())}));
  const shown=await read();
  await page.getByRole('button',{name:'回到陪伴',exact:true}).click();
  const onStage=await page.locator('.companion-page').isVisible();
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const hidden=await read();
  await page.getByRole('button',{name:'唤回伙伴',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='shown');
  const recalled=await read();
  await page.getByRole('button',{name:'回到陪伴',exact:true}).click();
  await chooseSnooze(page.locator('.companion-control-buttons'),60);
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='snoozed');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const snoozed=await read();
  await page.screenshot({path:join(evidenceDir,'c02-shelf-actions.png')});
  const untilBefore=await page.evaluate(()=>window.__review.native.snoozeUntilMs);
  await chooseSnooze(card,30);
  await page.waitForTimeout(300);
  const adjusted=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)}));
  const noDuplicate=snoozed.buttons.filter(text=>text?.includes('唤回')).length===1&&!snoozed.buttons.includes('立即唤回');
  return {passed:shown.status?.includes('显示中')&&shown.primary==='回到陪伴'&&onStage&&hidden.status?.includes('已收起')&&hidden.primary==='唤回伙伴'&&recalled.status?.includes('显示中')&&snoozed.status?.includes('休息中')&&snoozed.primary==='提前唤回'&&snoozed.secondary==='调整休息…'&&noDuplicate&&adjusted.mode==='snoozed'&&adjusted.until<untilBefore&&adjusted.until>Date.now()&&adjusted.toasts.some(text=>text?.includes('休息到'))&&errors.length===0,shown,hidden,recalled,snoozed,noDuplicate,untilBefore,adjusted,errors};
 }finally{await context.close();}
});
await record('shelf_current_card_recall_and_retry_stay_on_shelf',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.failPreference=true;});
  const card=petCard(page,'测试甲');
  await card.getByRole('button',{name:'唤回伙伴',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.pet-card.active-pet .pet-card-status')?.textContent?.includes('等待显示'));
  const failed=await page.evaluate(()=>({shelf:Boolean(document.querySelector('.shelf-grid')),nav:document.querySelector('.nav-item.active')?.textContent,visible:window.__review.native.visible,status:document.querySelector('.pet-card.active-pet .pet-card-status')?.textContent?.trim(),primary:document.querySelector('.pet-card.active-pet .pet-card-action-row .btn-primary')?.textContent?.trim(),recovery:Boolean(document.querySelector('.recovery-notice'))}));
  await page.evaluate(()=>{window.__review.failPreference=false;});
  await card.getByRole('button',{name:'重试显示',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visible===true);
  const retried=await page.evaluate(()=>({shelf:Boolean(document.querySelector('.shelf-grid')),status:document.querySelector('.pet-card.active-pet .pet-card-status')?.textContent?.trim(),primary:document.querySelector('.pet-card.active-pet .pet-card-action-row .btn-primary')?.textContent?.trim()}));
  return {passed:failed.shelf&&failed.nav?.includes('我的伙伴')&&failed.visible===false&&failed.status?.includes('等待显示')&&failed.primary==='重试显示'&&failed.recovery&&retried.shelf&&retried.status?.includes('显示中')&&retried.primary==='回到陪伴'&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('shelf_native_mismatch_does_not_borrow_other_pet_status',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.evaluate(()=>{Object.assign(window.__review.native,{petId:'B',petName:'测试乙',availability:'ready',visibilityMode:'shown',visible:true});window.__review.emitNative();});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const cardA=petCard(page,'测试甲');
  const cardB=petCard(page,'测试乙');
  const read=(card)=>card.evaluate(el=>({status:el.querySelector('.pet-card-status')?.textContent?.trim()??null,primary:el.querySelector('.pet-card-action-row .btn-primary')?.textContent?.trim()??null}));
  const mismatchA=await read(cardA);
  const mismatchB=await read(cardB);
  await cardA.getByRole('button',{name:'恢复伙伴',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.petId==='A'&&window.__review.native.visible===true);
  const recovered=await read(cardA);
  return {passed:mismatchA.status?.includes('需要恢复')&&mismatchA.primary==='恢复伙伴'&&mismatchB.status===null&&mismatchB.primary==='派去桌面'&&recovered.status?.includes('显示中')&&recovered.primary==='回到陪伴'&&errors.length===0,mismatchA,mismatchB,recovered,errors};
 }finally{await context.close();}
});
await record('shelf_asset_recovery_preserves_hidden_intent',async()=>{
 const {context,page,errors}=await newCase({desktop:true,missing:true,nativeMode:'hidden'});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.recovery-notice').waitFor();
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const card=petCard(page,'测试甲');
  const read=()=>card.evaluate(el=>({status:el.querySelector('.pet-card-status')?.textContent?.trim()??null,primary:el.querySelector('.pet-card-action-row .btn-primary')?.textContent?.trim()??null}));
  const before=await read();
  await page.evaluate(()=>{window.__review.missing=false;});
  await card.getByRole('button',{name:'恢复素材',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.availability==='ready');
  const after=await read();
  const native=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible}));
  return {passed:before.status?.includes('素材需要恢复')&&before.primary==='恢复素材'&&native.mode==='hidden'&&native.visible===false&&after.status?.includes('已收起')&&after.primary==='唤回伙伴'&&errors.length===0,before,after,native,errors};
 }finally{await context.close();}
});
await record('shelf_position_recovery_does_not_wake_hidden_pet',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const card=petCard(page,'测试甲');
  await card.locator('.pet-card-more > summary').click();
  const offered=await card.getByRole('button',{name:'找回位置',exact:true}).isVisible();
  await card.getByRole('button',{name:'找回位置',exact:true}).click();
  await page.waitForTimeout(300);
  const after=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,visible:window.__review.native.visible,resetCalls:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='resetPosition').length,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)}));
  await page.evaluate(()=>{window.__review.native.capabilities.resetPosition=false;window.__review.emitNative();});
  await page.waitForTimeout(150);
  await card.locator('.pet-card-more > summary').click();
  const hiddenWhenUnsupported=await card.getByRole('button',{name:'找回位置',exact:true}).count()===0;
  return {passed:offered&&after.mode==='hidden'&&after.visible===false&&after.resetCalls===1&&after.toasts.some(text=>text?.includes('显示或休息状态没有改变'))&&hiddenWhenUnsupported&&errors.length===0,offered,after,hiddenWhenUnsupported,errors};
 }finally{await context.close();}
});
await record('snooze_menu_durations_and_keyboard',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  const controls=page.locator('.companion-control-buttons');
  await controls.getByRole('button',{name:'休息…',exact:true}).click();
  const menuVisible=await page.getByRole('menu',{name:'选择休息时长'}).isVisible();
  const before=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs}));
  await page.keyboard.press('Escape');
  const menuClosed=await page.getByRole('menu').count()===0;
  const focusRestored=await page.evaluate(()=>document.activeElement?.textContent?.trim()==='休息…');
  const unchanged=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs}));
  await controls.getByRole('button',{name:'休息…',exact:true}).click();
  await page.getByRole('menuitem',{name:'15 分钟',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='snoozed');
  const fifteen=await page.evaluate(()=>({until:window.__review.native.snoozeUntilMs,now:Date.now(),status:document.querySelector('.status-chip')?.textContent,note:[...document.querySelectorAll('.companion-control-note')].map(node=>node.textContent).join(' ')}));
  await controls.getByRole('button',{name:'调整休息…',exact:true}).click();
  const keepVisible=await page.getByRole('menuitem',{name:'保持收起',exact:true}).isVisible();
  await page.getByRole('menuitem',{name:'30 分钟',exact:true}).click();
  await page.waitForTimeout(200);
  const thirty=await page.evaluate(()=>({until:window.__review.native.snoozeUntilMs,now:Date.now()}));
  await controls.getByRole('button',{name:'调整休息…',exact:true}).click();
  await page.getByRole('menuitem',{name:'保持收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  const kept=await page.evaluate(()=>({mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs,status:document.querySelector('.status-chip')?.textContent,buttons:[...document.querySelectorAll('.companion-control-buttons button')].map(button=>button.textContent?.trim())}));
  await controls.getByRole('button',{name:'休息…',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='15 分钟');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='snoozed');
  const keyboard=await page.evaluate(()=>({until:window.__review.native.snoozeUntilMs,now:Date.now()}));
  return {passed:menuVisible&&before.mode==='shown'&&before.until===null&&menuClosed&&focusRestored&&unchanged.mode==='shown'&&unchanged.until===null&&fifteen.status?.includes('休息中')&&fifteen.note.includes('约剩 15 分钟')&&fifteen.until-fifteen.now>=14*60000&&fifteen.until-fifteen.now<=15*60000&&keepVisible&&thirty.until-thirty.now>=29*60000&&thirty.until-thirty.now<=30*60000&&kept.mode==='hidden'&&kept.until===null&&kept.status?.includes('已收起')&&kept.buttons.includes('立即唤回')&&!kept.buttons.includes('提前唤回')&&keyboard.until-keyboard.now>=14*60000&&keyboard.until-keyboard.now<=15*60000&&errors.length===0,menuVisible,before,menuClosed,focusRestored,unchanged,fifteen,keepVisible,thirty,kept,keyboard,errors};
 }finally{await context.close();}
});
await record('snooze_remaining_does_not_write_native',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await chooseSnooze(page.locator('.companion-control-buttons'),15);
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='snoozed');
  const before=await page.evaluate(()=>window.__review.calls.filter(call=>call.cmd==='update_native_pet_preferences').length);
  await page.waitForTimeout(2500);
  const after=await page.evaluate(()=>({writes:window.__review.calls.filter(call=>call.cmd==='update_native_pet_preferences').length,note:[...document.querySelectorAll('.companion-control-note')].map(node=>node.textContent).join(' ')}));
  return {passed:after.writes===before&&after.note.includes('约剩')&&errors.length===0,before,after,errors};
 }finally{await context.close();}
});
await record('snooze_legacy_call_defaults_to_an_hour',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  const result=await page.evaluate(async()=>{
   await window.__TAURI_INTERNALS__.invoke('update_native_pet_preferences',{request:{kind:'snooze'}});
   return {until:window.__review.native.snoozeUntilMs,now:Date.now(),mode:window.__review.native.visibilityMode};
  });
  const invalid=await page.evaluate(async()=>{
   const before={mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs};
   try{
    await window.__TAURI_INTERNALS__.invoke('update_native_pet_preferences',{request:{kind:'snooze',durationMinutes:45}});
    return {rejected:false,before};
   }catch(error){
    return {rejected:true,message:String(error),before,after:{mode:window.__review.native.visibilityMode,until:window.__review.native.snoozeUntilMs}};
   }
  });
  return {passed:result.mode==='snoozed'&&result.until-result.now>=59*60000&&result.until-result.now<=60*60000&&invalid.rejected&&invalid.message.includes('SNOOZE_DURATION_INVALID')&&invalid.after.mode===invalid.before.mode&&invalid.after.until===invalid.before.until&&errors.length===0,result,invalid,errors};
 }finally{await context.close();}
});
await record('preference_explanations_follow_actual_state',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  const read=()=>page.locator('.companion-toggles').innerText();
  const initial=await read();
  await page.locator('#companion-paused').click();
  await page.waitForFunction(()=>window.__review.native.animationPaused===true);
  const paused=await read();
  await page.locator('.sidebar-settings').click();
  await page.locator('#settings-motion').selectOption('reduce');
  await page.waitForFunction(()=>window.__review.native.motionPreference==='reduce');
  await page.keyboard.press('Escape');
  const reducedPaused=await read();
  await page.locator('#companion-paused').click();
  await page.waitForFunction(()=>window.__review.native.animationPaused===false);
  const reducedOnly=await read();
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  const hidden=await read();
  await page.locator('#companion-autonomous').click();
  await page.waitForFunction(()=>window.__review.native.autonomous===false);
  const autonomousOff=await read();
  return {passed:initial.includes('已开启，会按节奏自动切换姿态')&&initial.includes('跟随系统，当前正常播放')&&paused.includes('已开启，动画暂停期间暂不切换姿态')&&paused.includes('已暂停；关闭后会恢复播放')&&reducedPaused.includes('已开启，动画暂停期间暂不切换姿态')&&reducedPaused.includes('已暂停；关闭低动态不会自动恢复播放')&&reducedOnly.includes('已开启，当前因减少动态而暂停')&&reducedOnly.includes('当前因减少动态而暂停')&&hidden.includes('已开启，收起期间暂不切换姿态')&&hidden.includes('收起或休息期间不播放动画')&&autonomousOff.includes('保持当前姿态，仍可手动互动')&&errors.length===0,initial,paused,reducedPaused,reducedOnly,hidden,autonomousOff,errors};
 }finally{await context.close();}
});
await record('workshop_task_direct_entries',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.locator('.shelf-empty').getByRole('button',{name:'导入已有伙伴',exact:true}).click();
  const importHeading=await page.locator('#workshop-task-title').innerText();
  const importButton=await page.getByRole('button',{name:'一键导入并保存到宠物架',exact:true}).count();
  const galleryOnImport=await page.locator('.preset-gallery').count();
  await page.getByRole('button',{name:/返回任务选择/}).click();
  const taskCards=await page.locator('.workshop-task-card').count();
  const taskNames=await page.locator('.workshop-task-card strong').allTextContents();
  await page.getByRole('button',{name:/领养现成伙伴/}).click();
  const galleryVisible=await page.locator('.preset-gallery').isVisible();
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.getByRole('button',{name:/制作新宠物/}).click();
  const chooserVisible=await page.locator('.workshop-task-card').count()===4;
  await page.getByRole('button',{name:/用照片制作/}).click();
  const aiVisible=await page.locator('#workshop-api-key').isVisible();
  const aiHeading=await page.locator('#workshop-task-title').innerText();
  return {passed:importHeading.includes('导入已有伙伴')&&importButton===1&&galleryOnImport===0&&taskCards===4&&taskNames.join(',')==='领养现成伙伴,导入已有伙伴,装配动作帧,用照片制作'&&galleryVisible&&chooserVisible&&aiVisible&&aiHeading.includes('用照片制作')&&errors.length===0,importHeading,importButton,galleryOnImport,taskCards,taskNames,galleryVisible,chooserVisible,aiVisible,aiHeading,errors};
 }finally{await context.close();}
});
await record('workshop_session_inputs_survive_page_switch',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await openWorkshopTask(page,'导入已有伙伴');
  await page.locator('#workshop-name').fill('保留测试');
  await page.locator('#workshop-preset-dir').fill('/tmp/keep-frames');
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.getByRole('button',{name:/领养与制作/}).click();
  const importKept={heading:await page.locator('#workshop-task-title').innerText(),name:await page.locator('#workshop-name').inputValue(),dir:await page.locator('#workshop-preset-dir').inputValue()};
  await page.getByRole('button',{name:/返回任务选择/}).click();
  await page.getByRole('button',{name:/装配动作帧/}).click();
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  const file={name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')};
  await page.locator('.frame-add-card input[type=file]').setInputFiles(Array.from({length:5},(_,i)=>({...file,name:`keep-${i}.png`})));
  await page.waitForFunction(()=>document.querySelectorAll('.frame-thumb-img').length===5);
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.getByRole('button',{name:/领养与制作/}).click();
  const framesKept={heading:await page.locator('#workshop-task-title').innerText(),count:await page.locator('.frame-thumb-img').count(),active:await page.locator('.seg-tab-btn.active').innerText()};
  await page.getByRole('button',{name:/返回任务选择/}).click();
  await page.getByRole('button',{name:/用照片制作/}).click();
  await page.locator('#workshop-api-key').fill('keep-key');
  await page.locator('#workshop-upload-url').fill('https://example.test/keep');
  await page.locator('#workshop-notes').fill('保留描述');
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.getByRole('button',{name:/领养与制作/}).click();
  const aiKept={heading:await page.locator('#workshop-task-title').innerText(),key:await page.locator('#workshop-api-key').inputValue(),url:await page.locator('#workshop-upload-url').inputValue(),notes:await page.locator('#workshop-notes').inputValue()};
  return {passed:importKept.heading.includes('导入已有伙伴')&&importKept.name==='保留测试'&&importKept.dir==='/tmp/keep-frames'&&framesKept.heading.includes('装配动作帧')&&framesKept.count===5&&framesKept.active.includes('待机')&&aiKept.heading.includes('用照片制作')&&aiKept.key==='keep-key'&&aiKept.url==='https://example.test/keep'&&aiKept.notes==='保留描述'&&errors.length===0,importKept,framesKept,aiKept,errors};
 }finally{await context.close();}
});
await record('workshop_task_labels_and_keyboard',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'用照片制作');
  const labels=await page.evaluate(()=>({name:document.querySelector('label[for="workshop-name"]')?.textContent?.trim(),species:document.querySelector('label[for="workshop-species"]')?.textContent?.trim(),api:document.querySelector('label[for="workshop-api-key"]')?.textContent?.trim(),upload:document.querySelector('label[for="workshop-upload-url"]')?.textContent?.trim(),photo:document.querySelector('label[for="workshop-photo"]')?.textContent?.trim(),notes:document.querySelector('label[for="workshop-notes"]')?.textContent?.trim()}));
  await page.getByRole('button',{name:/返回任务选择/}).click();
  const names=await page.locator('.workshop-task-card').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')));
  const first=page.locator('.workshop-task-card').first();
  await first.focus();
  await page.keyboard.press('Enter');
  const presetsVisible=await page.locator('.preset-gallery').isVisible();
  const headingFocus=await page.evaluate(()=>document.activeElement?.id);
  await page.getByRole('button',{name:/返回任务选择/}).click();
  const second=page.locator('.workshop-task-card').nth(1);
  await second.focus();
  await page.keyboard.press('Enter');
  const inputFocus=await page.evaluate(()=>document.activeElement?.id);
  return {passed:labels.name==='宠物名称'&&labels.species==='宠物种类'&&labels.api==='Minimax API Key'&&labels.upload==='公网参考图上传服务地址'&&labels.photo==='宠物照片'&&labels.notes==='特征描述（可选）'&&names.every(name=>name&&name.includes('：'))&&presetsVisible&&headingFocus==='workshop-task-title'&&inputFocus==='workshop-name'&&errors.length===0,labels,names,presetsVisible,headingFocus,inputFocus,errors};
 }finally{await context.close();}
});
await record('tutorial_desktop_practice_is_optional',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.sidebar-settings').click();
  await page.getByRole('button',{name:'查看教学',exact:true}).click();
  await page.locator('.onboarding-dialog').waitFor();
  const practice=page.getByRole('button',{name:'去桌面看看',exact:true});
  const visible=await practice.isVisible();
  const skippable=await page.getByRole('button',{name:'稍后熟悉',exact:true}).isVisible();
  await practice.click();
  await page.waitForTimeout(200);
  const hiddenCalls=await page.evaluate(()=>window.__review.calls.filter(call=>call.cmd==='hide_studio_window').length);
  const dialogStill=await page.locator('.onboarding-dialog').isVisible();
  await page.keyboard.press('Escape');
  const web=await newCase();
  try{
   await seed(web.page);
   await web.page.locator('.sidebar-settings').click();
   await web.page.getByRole('button',{name:'查看教学',exact:true}).click();
   const webPractice=await web.page.getByRole('button',{name:'去桌面看看',exact:true}).count();
   return {passed:visible&&skippable&&hiddenCalls===1&&dialogStill&&webPractice===0&&errors.length===0&&web.errors.length===0,visible,skippable,hiddenCalls,dialogStill,webPractice,errors,webErrors:web.errors};
  }finally{await web.context.close();}
 }finally{await context.close();}
});
await record('workshop_repair_import_updates_existing_pet',async()=>{
 const {context,page,errors}=await newCase({desktop:true,missing:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.recovery-notice').waitFor();
  await page.getByRole('button',{name:'修复素材',exact:true}).click();
  const heading=await page.locator('#workshop-task-title').innerText();
  const banner=await page.locator('.workshop-repair-note').innerText();
  await page.evaluate(()=>{window.__review.missing=false;});
  await page.getByRole('button',{name:'更新素材并保留当前伙伴',exact:true}).click();
  await page.locator('.toast-message.success').filter({hasText:'已更新'}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:await s.loadAllPets(),active:(await s.loadPet())?.id,recovery:Boolean(document.querySelector('.recovery-notice'))};});
  const names=state.pets.map(pet=>pet.name).sort();
  return {passed:heading.includes('修复「测试甲」')&&banner.includes('不会新建伙伴')&&state.pets.length===2&&state.active==='A'&&!state.recovery&&names.join(',')==='测试乙,测试甲'&&errors.length===0,heading,banner,state,names,errors};
 }finally{await context.close();}
});
await record('workshop_long_task_survives_page_switch',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openAI(page);
  await page.evaluate(()=>{window.__review.generationDelay=250;});
  await generateCharacterReview(page);
  await confirmAICharacter(page);
  await page.waitForTimeout(120);
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.waitForTimeout(180);
  await page.getByRole('button',{name:/领养与制作/}).click();
  const during=await page.evaluate(()=>({heading:document.querySelector('#workshop-task-title')?.textContent,button:[...document.querySelectorAll('button')].map(node=>node.textContent?.trim()).find(text=>text?.includes('生成中'))??null}));
  await page.locator('.companion-title').waitFor({timeout:15000});
  const after=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,generations:window.__review.generations,saves:window.__review.saves,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  return {passed:during.heading?.includes('用照片制作')&&Boolean(during.button)&&after.pets===1&&after.generations===7&&after.saves===1&&!after.toasts.some(text=>text?.includes('已取消'))&&errors.length===0,during,after,errors};
 }finally{await context.close();}
});
await record('recent_removal_undo_noncurrent',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'B'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.locator('.removal-undo').waitFor();
  await page.screenshot({path:join(evidenceDir,'c05-recent-removal.png')});
  const before=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,pets:(await s.loadAllPets()).length,removed:(await s.loadRemovedPets()).length,remaining:Number(document.querySelector('.removal-undo')?.getAttribute('data-remaining')),text:document.querySelector('.removal-undo')?.textContent??'',recentCards:document.querySelectorAll('.removed-card').length};});
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadRemovedPets()).length===0;});
  const after=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,pets:(await s.loadAllPets()).length,removed:(await s.loadRemovedPets()).length,notice:Boolean(document.querySelector('.removal-undo'))};});
  return {passed:before.active==='B'&&before.pets===1&&before.removed===1&&before.recentCards===1&&before.remaining>=9&&before.text.includes('当前桌面伙伴保持不变')&&after.active==='B'&&after.pets===2&&after.removed===0&&!after.notice&&errors.length===0,before,after,errors};
 }finally{await context.close();}
});
await record('recent_removal_undo_current_preserves_hidden',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('.companion-control-buttons').getByRole('button',{name:'暂时收起',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.visibilityMode==='hidden');
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.waitForFunction(()=>window.__review.native.petId==='B');
  const removed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,removed:(await s.loadRemovedPets()).length,mode:window.__review.native.visibilityMode,visible:window.__review.native.visible,text:document.querySelector('.removal-undo')?.textContent??''};});
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.petId==='A');
  const restored=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,removed:(await s.loadRemovedPets()).length,mode:window.__review.native.visibilityMode,visible:window.__review.native.visible};});
  return {passed:removed.active==='B'&&removed.removed===1&&removed.mode==='hidden'&&removed.visible===false&&removed.text.includes('当前伙伴由「测试乙」接替')&&restored.active==='A'&&restored.removed===0&&restored.mode==='hidden'&&restored.visible===false&&errors.length===0,removed,restored,errors};
 }finally{await context.close();}
});
await record('recent_removal_undo_after_newer_selection',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.locator('.removal-undo').waitFor();
  await page.evaluate(async()=>{await (await import('/src/storage.ts')).setActivePetId('B');});
  await page.waitForTimeout(200);
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadRemovedPets()).length===0;});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,pets:(await s.loadAllPets()).length,removed:(await s.loadRemovedPets()).length,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  return {passed:state.active==='B'&&state.pets===2&&state.removed===0&&state.toasts.some(text=>text?.includes('当前伙伴保持不变'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('recent_removal_last_pet_survives_reload',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.locator('.removal-undo').waitFor();
  await deleteCard(petCard(page,'测试乙'));
  await page.waitForFunction(()=>window.__review.native.petId===null);
  const emptied=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,removed:(await s.loadRemovedPets()).length};});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.locator('.shelf-empty').waitFor();
  const reloaded=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,removed:(await s.loadRemovedPets()).length,cards:document.querySelectorAll('.removed-card').length};});
  await page.getByRole('button',{name:'恢复到伙伴架',exact:true}).first().click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadAllPets()).length===1;});
  const restored=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id};});
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  const stageEmpty=await page.locator('.companion-empty').isVisible();
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.locator('.pet-card').getByRole('button',{name:/派去桌面/}).first().click();
  await page.waitForFunction(()=>Boolean(window.__review.native.petId));
  const deployed=await page.evaluate(async()=>({active:(await (await import('/src/storage.ts')).loadPet())?.id,native:window.__review.native.petId}));
  return {passed:emptied.pets===0&&emptied.removed===2&&reloaded.pets===0&&reloaded.removed===2&&reloaded.cards===2&&restored.pets===1&&!restored.active&&stageEmpty&&deployed.active===deployed.native&&errors.length===0,emptied,reloaded,restored,stageEmpty,deployed,errors};
 }finally{await context.close();}
});
await record('recent_removal_timer_pauses_on_hover',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'B'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  const notice=page.locator('.removal-undo');
  await notice.waitFor();
  await page.bringToFront();
  await page.mouse.move(5,5);
  const start=Number(await notice.getAttribute('data-remaining'));
  await page.waitForFunction(start=>Number(document.querySelector('.removal-undo')?.getAttribute('data-remaining'))<start,start,{timeout:5000});
  const afterWait=Number(await notice.getAttribute('data-remaining'));
  await notice.hover();
  const paused=Number(await notice.getAttribute('data-remaining'));
  await page.waitForTimeout(1400);
  const afterHover=Number(await notice.getAttribute('data-remaining'));
  await page.mouse.move(5,5);
  await page.waitForFunction(paused=>Number(document.querySelector('.removal-undo')?.getAttribute('data-remaining'))<paused,paused,{timeout:5000});
  const afterResume=Number(await notice.getAttribute('data-remaining'));
  await page.getByRole('button',{name:'撤销',exact:true}).focus();
  const focusPaused=Number(await notice.getAttribute('data-remaining'));
  await page.waitForTimeout(1200);
  const afterFocus=Number(await notice.getAttribute('data-remaining'));
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  return {passed:start>=9&&afterWait<start&&afterHover===paused&&afterResume<afterHover&&afterFocus===focusPaused&&errors.length===0,start,afterWait,paused,afterHover,afterResume,focusPaused,afterFocus,errors};
 }finally{await context.close();}
});
await record('recent_removal_multi_window_single_copy',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'B'});
  const second=await context.newPage();
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await second.getByRole('button',{name:/我的伙伴/}).click();
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.locator('.removal-undo').waitFor();
  await second.locator('.removed-card').waitFor();
  await second.getByRole('button',{name:'恢复到伙伴架',exact:true}).click();
  await second.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadRemovedPets()).length===0;});
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await page.waitForTimeout(400);
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,pets:(await s.loadAllPets()).length,removed:(await s.loadRemovedPets()).length,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  return {passed:state.active==='B'&&state.pets===2&&state.removed===0&&state.toasts.some(text=>text?.includes('已经在伙伴架'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('recent_removal_native_sync_retry',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.failAttach=true;});
  await deleteCard(petCard(page,'测试甲'));
  await page.locator('.recovery-notice').filter({hasText:'资料已移除，桌面尚未同步'}).waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,removed:(await s.loadRemovedPets()).length,native:window.__review.native.petId,notice:document.querySelector('.removal-undo')?.textContent??''};});
  await page.evaluate(()=>{window.__review.failAttach=false;});
  await page.getByRole('button',{name:'重试同步',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.petId==='B');
  const retried=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {active:(await s.loadPet())?.id,removed:(await s.loadRemovedPets()).length,recovery:Boolean(document.querySelector('.recovery-notice'))};});
  return {passed:failed.active==='B'&&failed.removed===1&&failed.native==='A'&&failed.notice.includes('当前伙伴由「测试乙」接替')&&retried.active==='B'&&retried.removed===1&&!retried.recovery&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('recent_removal_broken_replacement_aborts',async()=>{
 const {context,page,errors}=await newCase({desktop:true,missing:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.locator('.toast-message.error').filter({hasText:'接替伙伴的素材暂时不可用'}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,removed:(await s.loadRemovedPets()).length,notice:Boolean(document.querySelector('.removal-undo'))};});
  return {passed:state.pets===2&&state.active==='A'&&state.removed===0&&!state.notice&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('recent_removal_preserves_paused',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.locator('#companion-paused').click();
  await page.waitForFunction(()=>window.__review.native.animationPaused===true);
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.waitForFunction(()=>window.__review.native.petId==='B');
  const removed=await page.evaluate(()=>({active:window.__review.native.petId,paused:window.__review.native.animationPaused}));
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await page.waitForFunction(()=>window.__review.native.petId==='A');
  const restored=await page.evaluate(()=>({active:window.__review.native.petId,paused:window.__review.native.animationPaused}));
  return {passed:removed.active==='B'&&removed.paused===true&&restored.active==='A'&&restored.paused===true&&errors.length===0,removed,restored,errors};
 }finally{await context.close();}
});
await record('recent_removal_restore_with_missing_assets_reports',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'B'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await deleteCard(petCard(page,'测试甲'));
  await page.locator('.removal-undo').waitFor();
  await page.evaluate(()=>{window.__review.missing=true;});
  await page.getByRole('button',{name:'恢复到伙伴架',exact:true}).click();
  await page.locator('.toast-message').filter({hasText:'素材暂时不可用'}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,removed:(await s.loadRemovedPets()).length};});
  return {passed:state.pets===2&&state.active==='B'&&state.removed===0&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('workshop_preflight_is_read_only',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  const before=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,loads:window.__review.calls.filter(c=>c.cmd==='load_preset_frame_pack').length,attaches:window.__review.calls.filter(c=>c.cmd==='set_native_pet_frame_root').length};});
  await page.evaluate(()=>{
   const actions=['idle','sit','sleep','happy','walk','jump'].map(action=>({action,frames:action==='walk'?0:5,minFrames:5,maxFrames:60,issues:action==='walk'?['至少需要 5 帧，当前只有 0 帧']:[]}));
   window.__review.frameInspection={root:'/tmp/incomplete',actions,missingActions:['walk'],totalBytes:5120,decodedBytes:1024,valid:false,issues:['walk：至少需要 5 帧'],globalIssues:[],thumbnail:null};
  });
  await page.getByRole('button',{name:'预检目录（只读）',exact:true}).click();
  await page.locator('.frame-inspection.is-invalid').waitFor();
  const invalid=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {text:document.querySelector('.frame-inspection')?.textContent??'',importDisabled:[...document.querySelectorAll('button')].some(button=>button.textContent?.includes('一键导入并保存到宠物架')&&button.disabled),pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,loads:window.__review.calls.filter(c=>c.cmd==='load_preset_frame_pack').length,attaches:window.__review.calls.filter(c=>c.cmd==='set_native_pet_frame_root').length};});
  await page.evaluate(()=>{
   const actions=['idle','sit','sleep','happy','walk','jump'].map(action=>({action,frames:5,minFrames:5,maxFrames:60,issues:[]}));
   window.__review.frameInspection={root:'/tmp/complete',actions,missingActions:[],totalBytes:5120,decodedBytes:1024,valid:true,issues:[],globalIssues:[],thumbnail:null};
  });
  await page.getByRole('button',{name:'预检目录（只读）',exact:true}).click();
  await page.locator('.frame-inspection.is-valid').waitFor();
  const valid=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {text:document.querySelector('.frame-inspection')?.textContent??'',importDisabled:[...document.querySelectorAll('button')].some(button=>button.textContent?.includes('一键导入并保存到宠物架')&&button.disabled),pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,loads:window.__review.calls.filter(c=>c.cmd==='load_preset_frame_pack').length,attaches:window.__review.calls.filter(c=>c.cmd==='set_native_pet_frame_root').length};});
  return {passed:before.pets===2&&before.active==='A'&&invalid.text.includes('预检发现')&&invalid.text.includes('缺少动作')&&invalid.importDisabled&&invalid.pets===2&&invalid.active==='A'&&invalid.loads===before.loads&&invalid.attaches===before.attaches&&valid.text.includes('预检通过')&&!valid.importDisabled&&valid.pets===2&&valid.active==='A'&&valid.loads===before.loads&&valid.attaches===before.attaches&&errors.length===0,before,invalid,valid,errors};
 }finally{await context.close();}
});
await record('workshop_preflight_stale_result_is_ignored',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  await page.evaluate(()=>{
   const actions=['idle','sit','sleep','happy','walk','jump'].map(action=>({action,frames:5,minFrames:5,maxFrames:60,issues:[]}));
   window.__review.inspectDelay=700;
   window.__review.frameInspection={root:'/tmp/A',actions,missingActions:[],totalBytes:5120,decodedBytes:1024,valid:true,issues:[],globalIssues:[],thumbnail:null};
  });
  const input=page.locator('#workshop-preset-dir');
  await input.fill('/tmp/A');
  await page.getByRole('button',{name:'预检目录（只读）',exact:true}).click();
  await input.fill('/tmp/B');
  await page.waitForTimeout(1000);
  const state=await page.evaluate(()=>({reports:document.querySelectorAll('.frame-inspection').length,button:[...document.querySelectorAll('button')].find(button=>button.textContent?.includes('预检目录'))?.textContent,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent),calls:window.__review.calls.filter(c=>c.cmd==='inspect_frame_directory').map(c=>c.root)}));
  return {passed:state.reports===0&&state.button?.includes('预检目录（只读）')&&!state.toasts.some(text=>text?.includes('预检通过'))&&state.calls.includes('/tmp/A')&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('workshop_preflight_shows_global_capacity_issue',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  await page.evaluate(()=>{
   const actions=['idle','sit','sleep','happy','walk','jump'].map(action=>({action,frames:5,minFrames:5,maxFrames:60,issues:[]}));
   const issue='帧包解码总量超过 256 MiB';
   window.__review.frameInspection={root:'/tmp/capacity',actions,missingActions:[],totalBytes:30*2048,decodedBytes:30*2048*2048*4,valid:false,issues:[issue],globalIssues:[issue],thumbnail:null};
  });
  await page.getByRole('button',{name:'预检目录（只读）',exact:true}).click();
  await page.locator('.frame-inspection.is-invalid').waitFor();
  const state=await page.evaluate(()=>({text:document.querySelector('.frame-inspection')?.textContent??'',disabled:[...document.querySelectorAll('button')].some(button=>button.textContent?.includes('一键导入并保存到宠物架')&&button.disabled)}));
  return {passed:state.text.includes('超过 256 MiB')&&state.text.includes('容量或全局限制')&&state.disabled&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('workshop_directory_choose_and_cancel',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  const input=page.locator('#workshop-preset-dir');
  const before=await input.inputValue();
  await page.evaluate(()=>{window.__review.dialogPath=null;});
  await page.getByRole('button',{name:'选择目录…',exact:true}).click();
  await page.locator('.toast-message').filter({hasText:'已取消选择'}).waitFor();
  const cancelled=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {value:document.querySelector('#workshop-preset-dir')?.value,reports:document.querySelectorAll('.frame-inspection').length,pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,inspects:window.__review.calls.filter(c=>c.cmd==='inspect_frame_directory').length};});
  await page.evaluate(()=>{window.__review.dialogPath='/tmp/chosen';});
  await page.getByRole('button',{name:'选择目录…',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#workshop-preset-dir')?.value==='/tmp/chosen');
  const selected=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {value:document.querySelector('#workshop-preset-dir')?.value,reports:document.querySelectorAll('.frame-inspection').length,pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,inspects:window.__review.calls.filter(c=>c.cmd==='inspect_frame_directory').length,dialogs:window.__review.calls.filter(c=>c.cmd==='plugin:dialog|open').length};});
  return {passed:cancelled.value===before&&cancelled.reports===0&&cancelled.pets===2&&cancelled.active==='A'&&cancelled.inspects===0&&selected.value==='/tmp/chosen'&&selected.reports===0&&selected.pets===2&&selected.active==='A'&&selected.inspects===0&&selected.dialogs===2&&errors.length===0,before,cancelled,selected,errors};
 }finally{await context.close();}
});
await record('workshop_directory_drop_sets_path',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  await page.waitForTimeout(100);
  await page.evaluate(async()=>{await window.__review.emit({type:'drop',paths:['/tmp/dropped'],position:{x:10,y:10}},'tauri://drag-drop');});
  await page.waitForFunction(()=>document.querySelector('#workshop-preset-dir')?.value==='/tmp/dropped');
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {value:document.querySelector('#workshop-preset-dir')?.value,reports:document.querySelectorAll('.frame-inspection').length,pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,inspects:window.__review.calls.filter(c=>c.cmd==='inspect_frame_directory').length,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  return {passed:state.value==='/tmp/dropped'&&state.reports===0&&state.pets===2&&state.active==='A'&&state.inspects===0&&state.toasts.some(text=>text?.includes('已收到目录'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('workshop_drag_drop_ignored_after_leaving_import',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.evaluate(()=>{window.__review.dragLeaveDelay=800;});
  await openWorkshopTask(page,'导入已有伙伴');
  const input=page.locator('#workshop-preset-dir');
  const before=await input.inputValue();
  await page.waitForTimeout(150);
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.waitForTimeout(100);
  await page.evaluate(async()=>{await window.__review.emit({type:'drop',paths:['/tmp/late-drop'],position:{x:10,y:10}},'tauri://drag-drop');});
  await page.waitForTimeout(1000);
  await openWorkshopTask(page,'导入已有伙伴');
  const after=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {value:document.querySelector('#workshop-preset-dir')?.value,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent),pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id};});
  return {passed:after.value===before&&after.value!=='/tmp/late-drop'&&!after.toasts.some(text=>text?.includes('已收到目录'))&&after.pets===2&&after.active==='A'&&errors.length===0,before,after,errors};
 }finally{await context.close();}
});
await record('managed_import_copies_and_persists_managed_root',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  await page.getByRole('button',{name:'一键导入并保存到宠物架',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadAllPets()).length===3;});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const active=await s.loadPet();const all=await s.loadAllPets();return {activeId:active?.id,activeRoot:active?.frameRoot,activeMode:active?.assetMode,activeAssetId:active?.assetId,pets:all.length,copies:window.__review.calls.filter(c=>c.cmd==='copy_to_managed_asset').map(c=>({source:c.sourceDir,assetId:c.assetId})),loadRoots:window.__review.calls.filter(c=>c.cmd==='load_preset_frame_pack').map(c=>c.root),managerRoot:window.__review.root};});
  return {passed:state.pets===3&&state.activeMode==='managed'&&state.activeRoot?.startsWith('/managed/')&&state.activeAssetId&&state.copies.length===1&&state.copies[0].source==='/review/A'&&state.loadRoots.includes(state.activeRoot)&&state.managerRoot===state.activeRoot&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('external_import_keeps_source_reference',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  await page.getByRole('checkbox',{name:/继续引用外部目录/}).check();
  await page.getByRole('button',{name:'一键导入并保存到宠物架',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadAllPets()).length===3;});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const active=await s.loadPet();return {root:active?.frameRoot,mode:active?.assetMode,copies:window.__review.calls.filter(c=>c.cmd==='copy_to_managed_asset').length,pets:(await s.loadAllPets()).length};});
  return {passed:state.pets===3&&state.root==='/review/A'&&state.mode==='external'&&state.copies===0&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('managed_copy_failure_creates_no_pet',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  await page.evaluate(()=>{window.__review.failManagedCopy=true;});
  await page.getByRole('button',{name:'一键导入并保存到宠物架',exact:true}).click();
  await page.locator('.toast-message.error').filter({hasText:'导入失败'}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,copies:window.__review.calls.filter(c=>c.cmd==='copy_to_managed_asset').length,loads:window.__review.calls.filter(c=>c.cmd==='load_preset_frame_pack').length,native:window.__review.native.petId};});
  return {passed:state.pets===2&&state.active==='A'&&state.copies===1&&state.loads===1&&state.native==='A'&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('managed_takeover_copies_external_pet',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const card=petCard(page,'测试甲');
  await card.locator('summary').click();
  await card.getByRole('button',{name:'交给应用保管',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return Boolean((await s.loadPet())?.frameRoot?.startsWith('/managed/'));});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,mode:pet?.assetMode,assetId:pet?.assetId,pets:(await s.loadAllPets()).length,copies:window.__review.calls.filter(c=>c.cmd==='copy_to_managed_asset').map(c=>({source:c.sourceDir,assetId:c.assetId})),nativeRoot:window.__review.root,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  return {passed:state.pets===2&&state.mode==='managed'&&state.root?.startsWith('/managed/')&&state.assetId?.startsWith('A-')&&state.copies.length===1&&state.copies[0].source==='/review/A'&&state.nativeRoot===state.root&&state.toasts.some(text=>text?.includes('交给应用保管'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('managed_takeover_failure_keeps_external',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.failManagedCopy=true;});
  const card=petCard(page,'测试甲');
  await card.locator('summary').click();
  await card.getByRole('button',{name:'交给应用保管',exact:true}).click();
  await page.locator('.toast-message.error').filter({hasText:'交给应用保管失败'}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,mode:pet?.assetMode,pets:(await s.loadAllPets()).length,copies:window.__review.calls.filter(c=>c.cmd==='copy_to_managed_asset').length,nativeRoot:window.__review.root};});
  return {passed:state.pets===2&&state.root==='/review/A'&&state.mode!=='managed'&&state.copies===1&&state.nativeRoot==='/review/A'&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('relocate_asset_preserves_hidden_and_source_reference',async()=>{
 const {context,page,errors}=await newCase({desktop:true,nativeMode:'hidden'});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  const before=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,mode:pet?.assetMode,shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length};});
  await page.evaluate(()=>{window.__review.dialogPath='/tmp/relocated';});
  page.once('dialog',dialog=>dialog.accept());
  const card=petCard(page,'测试甲');
  await card.locator('summary').click();
  await card.getByRole('button',{name:'重新定位素材',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return Boolean((await s.loadPet())?.frameRoot?.startsWith('/managed/'));});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,mode:pet?.assetMode,assetId:pet?.assetId,sourceImage:pet?.sourceImage,actionFrames:pet?.actions.idle.length,active:(await s.loadPet())?.id,native:window.__review.native.petId,visibility:window.__review.native.visibilityMode,visible:window.__review.native.visible,shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length,copies:window.__review.calls.filter(c=>c.cmd==='copy_to_managed_asset').map(c=>c.sourceDir)};});
  return {passed:before.root==='/review/A'&&state.active==='A'&&state.mode==='managed'&&state.root?.startsWith('/managed/')&&state.sourceImage===''&&state.actionFrames===0&&state.native==='A'&&state.visibility==='hidden'&&state.visible===false&&state.shows===before.shows&&state.copies.includes('/tmp/relocated')&&errors.length===0,before,state,errors};
 }finally{await context.close();}
});
await record('relocate_asset_rejects_removed_target',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.dialogPath='/tmp/relocate-stale';window.__review.copyDelay=700;});
  page.once('dialog',dialog=>dialog.accept());
  const card=petCard(page,'测试甲');
  await card.locator('summary').click();
  await card.getByRole('button',{name:'重新定位素材',exact:true}).click();
  await page.waitForTimeout(150);
  await page.evaluate(async()=>{await (await import('/src/storage.ts')).softRemovePet('A');});
  await page.locator('.toast-message.error').filter({hasText:'目标伙伴已被移除'}).waitFor();
  await page.waitForFunction(()=>Array.isArray(window.__review.deletedAssets)&&window.__review.deletedAssets.length>0);
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,removed:(await s.loadRemovedPets()).length,roots:(await s.loadAllPets()).map(p=>p.frameRoot),deleted:window.__review.deletedAssets??[]};});
  return {passed:state.pets===1&&state.active==='B'&&state.removed===1&&!state.roots.some(root=>root?.startsWith('/managed/'))&&state.deleted.length===1&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('managed_takeover_rejects_stale_reference',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.copyDelay=700;});
  const card=petCard(page,'测试甲');
  await card.locator('summary').click();
  await card.getByRole('button',{name:'交给应用保管',exact:true}).click();
  await page.waitForTimeout(150);
  await page.evaluate(async()=>{await (await import('/src/storage.ts')).updatePetAssetReference('A','/managed/newer','managed','newer');});
  await page.locator('.toast-message.error').filter({hasText:'交给应用保管失败'}).waitFor();
  await page.waitForFunction(()=>Array.isArray(window.__review.deletedAssets)&&window.__review.deletedAssets.length>0);
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,assetId:pet?.assetId,mode:pet?.assetMode,deleted:window.__review.deletedAssets??[],copies:window.__review.calls.filter(c=>c.cmd==='copy_to_managed_asset').map(c=>c.assetId)};});
  return {passed:state.root==='/managed/newer'&&state.assetId==='newer'&&state.mode==='managed'&&state.deleted.length===1&&state.deleted[0]===state.copies[0]&&state.deleted[0]!==state.assetId&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('relocate_attach_failure_keeps_new_reference_and_retries_load',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.dialogPath='/tmp/relocate-attach';window.__review.failAttach=true;});
  page.once('dialog',dialog=>dialog.accept());
  const card=petCard(page,'测试甲');
  await card.locator('summary').click();
  await card.getByRole('button',{name:'重新定位素材',exact:true}).click();
  await page.locator('.recovery-notice').filter({hasText:'资料已更新，桌面待同步'}).waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,mode:pet?.assetMode,nativeRoot:window.__review.root,recovery:document.querySelector('.recovery-notice')?.textContent??''};});
  await page.evaluate(()=>{window.__review.failAttach=false;});
  await page.getByRole('button',{name:'重试加载',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return pet?.frameRoot===window.__review.root&&!document.querySelector('.recovery-notice');});
  const retried=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,nativeRoot:window.__review.root,recovery:Boolean(document.querySelector('.recovery-notice'))};});
  return {passed:failed.root?.startsWith('/managed/')&&failed.mode==='managed'&&failed.nativeRoot==='/review/A'&&failed.recovery.includes('资料已更新，桌面待同步')&&retried.root===retried.nativeRoot&&!retried.recovery&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('export_pet_package_from_shelf',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await page.getByRole('button',{name:/我的伙伴/}).click();
  await page.evaluate(()=>{window.__review.dialogPath='/tmp/exports';});
  const card=petCard(page,'测试甲');
  await card.locator('summary').click();
  await card.getByRole('button',{name:'导出完整伙伴包',exact:true}).click();
  await page.locator('.toast-message').filter({hasText:'已导出完整伙伴包'}).waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {pets:(await s.loadAllPets()).length,active:(await s.loadPet())?.id,exports:window.__review.calls.filter(c=>c.cmd==='export_pet_package').map(c=>({parent:c.parentDir,name:c.name,root:c.exportFrameRoot}))};});
  return {passed:state.pets===2&&state.active==='A'&&state.exports.length===1&&state.exports[0].parent==='/tmp/exports'&&state.exports[0].name==='测试甲'&&state.exports[0].root==='/review/A'&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('import_pet_package_saves_without_switching',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'导入已有伙伴');
  const showsBefore=await page.evaluate(()=>window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length);
  await page.evaluate(()=>{window.__review.dialogPath='/tmp/package';window.__review.packageSummary={name:'包伙伴',species:'dog',style:'q-sticker',createdAt:'2026-10-21T00:00:00Z',actions:{idle:5,sit:5,sleep:5,happy:5,walk:5,jump:5},thumbnail:null};});
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'导入完整伙伴包…',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadAllPets()).length===3;});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const all=await s.loadAllPets();const active=await s.loadPet();const imported=all.find(p=>p.name==='包伙伴');return {pets:all.length,active:active?.id,importedRoot:imported?.frameRoot,importedMode:imported?.assetMode,importedId:imported?.id,importedCreatedAt:imported?.createdAt,native:window.__review.native.petId,shows:window.__review.calls.filter(c=>c.cmd==='update_native_pet_preferences'&&c.request?.kind==='show').length,imports:window.__review.calls.filter(c=>c.cmd==='import_pet_package').length,toasts:[...document.querySelectorAll('.toast-message')].map(node=>node.textContent)};});
  return {passed:state.pets===3&&state.active==='A'&&state.importedRoot?.startsWith('/managed/')&&state.importedMode==='managed'&&state.importedId&&state.importedCreatedAt==='2026-10-21T00:00:00Z'&&state.native==='A'&&state.shows===showsBefore&&state.imports===1&&state.toasts.some(text=>text?.includes('当前伙伴未改变'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('assembly_draft_autosaves_and_restores',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.draft-status.is-saved').waitFor();
  const saved=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {revision:d?.revision,frames:d?.manualFrames.idle.length,pending:d?.pendingPetId,disabled:[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('保存全套动作并应用到桌面'))?.disabled};});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  const restored=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {frames:d?.manualFrames.idle.length,count:[...document.querySelectorAll('.seg-tab-btn')].find(b=>b.textContent?.includes('待机'))?.textContent};});
  return {passed:saved.revision===1&&saved.frames===1&&saved.pending&&saved.disabled===true&&restored.frames===1&&restored.count?.includes('1/5')&&errors.length===0,saved,restored,errors};
 }finally{await context.close();}
});
await record('assembly_reorder_changes_frame_order',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  const images=await page.evaluate(()=>['#71402a','#2f6b3f'].map(color=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];}));
  const files=images.map((data,index)=>({name:`00${index+1}.png`,mimeType:'image/png',buffer:Buffer.from(data,'base64')}));
  await page.locator('.frame-add-card input[type=file]').setInputFiles(files);
  await page.waitForFunction(()=>document.querySelectorAll('.frame-thumb-img').length===2);
  const before=await page.evaluate(()=>[...document.querySelectorAll('.frame-thumb-img')].map(img=>img.getAttribute('src')));
  await page.getByRole('button',{name:'后移第 1 帧',exact:true}).click();
  const after=await page.evaluate(()=>[...document.querySelectorAll('.frame-thumb-img')].map(img=>img.getAttribute('src')));
  return {passed:before.length===2&&after[0]===before[1]&&after[1]===before[0]&&errors.length===0,before,after,errors};
 }finally{await context.close();}
});
await record('assembly_submit_uses_pending_id_and_clears_draft',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const frames=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.saveCreationDraft({schemaVersion:1,draftId:'manual-assembly',pendingPetId:'pending-a04',name:'草稿伙伴',species:'cat',manualFrames:frames},null);});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadAllPets()).length===1;});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();const draft=await s.loadCreationDraft('manual-assembly');return {id:pet?.id,name:pet?.name,draft:draft?{name:draft.name,revision:draft.revision,frames:draft.manualFrames.idle.length,pending:draft.pendingPetId}:null,pets:(await s.loadAllPets()).length};});
  return {passed:state.id==='pending-a04'&&state.name==='草稿伙伴'&&!state.draft&&state.pets===1&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('assembly_discard_draft_keeps_formal_pets',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true});
  await openWorkshopTask(page,'装配动作帧');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.draft-status.is-saved').waitFor();
  const before=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {draft:Boolean(await s.loadCreationDraft('manual-assembly')),pets:(await s.loadAllPets()).length};});
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'丢弃草稿',exact:true}).click();
  await page.locator('.draft-status.is-idle').waitFor();
  const after=await page.evaluate(async()=>{const s=await import('/src/storage.ts');return {draft:Boolean(await s.loadCreationDraft('manual-assembly')),pets:(await s.loadAllPets()).length,frames:document.querySelectorAll('.frame-thumb-img').length};});
  return {passed:before.draft&&before.pets===2&&!after.draft&&after.pets===2&&after.frames===0&&errors.length===0,before,after,errors};
 }finally{await context.close();}
});
await record('assembly_late_submit_returns_existing_commit',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const frames=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.saveCreationDraft({schemaVersion:1,draftId:'manual-assembly',pendingPetId:'pending-a04',name:'草稿伙伴',species:'cat',manualFrames:frames},null);});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(()=>{window.__review.manualSaveDelay=700;});
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.waitForTimeout(150);
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const actions=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.savePet({id:'pending-a04',name:'乙窗口伙伴',species:'cat',style:'q-sticker',createdAt:'2026-10-21T00:00:00Z',storageMode:'preset-root',frameRoot:'/review/B',sourceImage:img,actions,currentAction:'idle',actionStartedAt:new Date().toISOString(),scale:1});await s.deleteCreationDraft('manual-assembly');});
  const beforeRevision=await page.evaluate(async()=>(await import('/src/storage.ts')).loadSelectionRevision());
  await page.locator('.toast-message').filter({hasText:'另一窗口完成'}).waitFor({timeout:5000});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {name:pet?.name,id:pet?.id,draft:Boolean(await s.loadCreationDraft('manual-assembly')),pets:(await s.loadAllPets()).length,native:window.__review.root,revision:await s.loadSelectionRevision(),toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent)};});
  return {passed:state.id==='pending-a04'&&state.name==='乙窗口伙伴'&&!state.draft&&state.pets===1&&state.revision===beforeRevision&&state.toasts.some(t=>t?.includes('另一窗口完成'))&&errors.length===0,beforeRevision,state,errors};
 }finally{await context.close();}
});
await record('assembly_attach_failure_after_commit_keeps_saved_pet',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const frames=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.saveCreationDraft({schemaVersion:1,draftId:'manual-assembly',pendingPetId:'pending-a04',name:'草稿伙伴',species:'cat',manualFrames:frames},null);});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(()=>{window.__review.failAttach=true;});
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.waitForTimeout(1500);
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {petId:pet?.id,root:pet?.frameRoot,draft:Boolean(await s.loadCreationDraft('manual-assembly')),status:document.querySelector('.draft-status')?.textContent,recovery:document.querySelector('.recovery-notice')?.textContent,toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent),native:window.__review.root};});
  if(!failed.recovery)return {passed:false,failed,errors};
  await page.evaluate(()=>{window.__review.failAttach=false;});
  await page.getByRole('button',{name:'重试加载',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return pet?.frameRoot===window.__review.root&&!document.querySelector('.recovery-notice');});
  const retried=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {root:pet?.frameRoot,native:window.__review.root,recovery:Boolean(document.querySelector('.recovery-notice'))};});
  return {passed:failed.petId==='pending-a04'&&failed.root?.startsWith('/review/generated')&&!failed.draft&&!failed.toasts.some(t=>t?.includes('保存帧包失败'))&&failed.native==='/review/A'&&retried.root===retried.native&&!retried.recovery&&errors.length===0,failed,retried,errors};
 }finally{await context.close();}
});
await record('assembly_commit_superseded_during_hydration',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'装配动作帧');
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const frames=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.saveCreationDraft({schemaVersion:1,draftId:'manual-assembly',pendingPetId:'pending-a04',name:'草稿伙伴',species:'cat',manualFrames:frames},null);});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(()=>{window.__review.generatedLoadDelay=800;});
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.waitForTimeout(150);
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');await s.setActivePetId('B');await window.__TAURI_INTERNALS__.invoke('set_native_pet_frame_root',{rootDir:'/review/B',petId:'B',petName:'测试乙'});});
  await page.waitForTimeout(1200);
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {active:pet?.id,native:window.__review.root,nativePet:window.__review.native.petId,pets:(await s.loadAllPets()).length,draft:Boolean(await s.loadCreationDraft('manual-assembly')),toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent)};});
  return {passed:state.active==='B'&&state.native==='/review/B'&&state.nativePet==='B'&&state.pets===3&&!state.draft&&!state.toasts.some(t=>t?.includes('成功保存'))&&state.toasts.some(t=>t?.includes('选择已更新'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('assembly_stale_attach_does_not_rollback_new_selection',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'装配动作帧');
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const frames=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.saveCreationDraft({schemaVersion:1,draftId:'manual-assembly',pendingPetId:'pending-a04',name:'草稿伙伴',species:'cat',manualFrames:frames},null);});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(()=>{window.__review.delayGeneratedCommit=700;window.__review.failGeneratedAttach=true;});
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.waitForTimeout(150);
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');await s.setActivePetId('B');await window.__TAURI_INTERNALS__.invoke('set_native_pet_frame_root',{rootDir:'/review/B',petId:'B',petName:'测试乙'});});
  await page.locator('.toast-message').filter({hasText:'选择已更新'}).waitFor({timeout:5000});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();return {active:pet?.id,native:window.__review.root,nativePet:window.__review.native.petId,draft:Boolean(await s.loadCreationDraft('manual-assembly')),recovery:Boolean(document.querySelector('.recovery-notice')),toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent)};});
  return {passed:state.active==='B'&&state.native==='/review/B'&&state.nativePet==='B'&&!state.draft&&!state.recovery&&!state.toasts.some(t=>t?.includes('恢复原桌宠失败'))&&!state.toasts.some(t=>t?.includes('成功保存'))&&state.toasts.some(t=>t?.includes('选择已更新'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('assembly_attach_selection_read_failure_does_not_rollback',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await seed(page,{desktop:true,active:'A'});
  await openWorkshopTask(page,'装配动作帧');
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const frames=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.saveCreationDraft({schemaVersion:1,draftId:'manual-assembly',pendingPetId:'pending-a04',name:'草稿伙伴',species:'cat',manualFrames:frames},null);});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(()=>{window.__review.delayGeneratedCommit=700;window.__review.failGeneratedAttach=true;});
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.waitForTimeout(150);
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');await s.setActivePetId('B');await window.__TAURI_INTERNALS__.invoke('set_native_pet_frame_root',{rootDir:'/review/B',petId:'B',petName:'测试乙'});window.__review.failSelectionRead=true;});
  await page.locator('.toast-message').filter({hasText:'无法确认当前选择'}).waitFor({timeout:5000});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');window.__review.failSelectionRead=false;const pet=await s.loadPet();return {active:pet?.id,native:window.__review.root,nativePet:window.__review.native.petId,recovery:Boolean(document.querySelector('.recovery-notice')),toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent)};});
  return {passed:state.active==='B'&&state.native==='/review/B'&&state.nativePet==='B'&&!state.recovery&&!state.toasts.some(t=>t?.includes('恢复原桌宠失败'))&&!state.toasts.some(t=>t?.includes('成功保存'))&&state.toasts.some(t=>t?.includes('无法确认当前选择'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('assembly_draft_flushes_when_leaving_frames',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.waitForFunction(()=>!document.querySelector('#workshop-name')?.disabled);
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.frame-thumb-img').waitFor();
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return d?.manualFrames.idle.length===1;},{timeout:5000});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {frames:d?.manualFrames.idle.length,revision:d?.revision};});
  return {passed:state.frames===1&&state.revision>=1&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('assembly_draft_save_failure_keeps_old_version',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.draft-status.is-saved').waitFor();
  const before=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {name:d?.name,revision:d?.revision};});
  await page.evaluate(()=>{window.__review.failDraftSave=true;});
  await page.locator('#workshop-name').fill('未保存名字');
  await page.locator('.draft-status.is-unsaved').waitFor();
  const failed=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {input:document.querySelector('#workshop-name')?.value,draftName:d?.name,revision:d?.revision};});
  await page.evaluate(()=>{window.__review.failDraftSave=false;});
  await page.locator('#workshop-name').fill('恢复保存');
  await page.locator('.draft-status.is-saved').waitFor({timeout:5000});
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return d?.name==='恢复保存';},{timeout:5000});
  const recovered=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {name:d?.name,revision:d?.revision};});
  return {passed:failed.input==='未保存名字'&&failed.draftName===before.name&&failed.revision===before.revision&&recovered.name==='恢复保存'&&recovered.revision>before.revision&&errors.length===0,before,failed,recovered,errors};
 }finally{await context.close();}
});
await record('assembly_leave_during_inflight_save_persists_latest',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.waitForFunction(()=>!document.querySelector('#workshop-name')?.disabled);
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(()=>{window.__review.draftSaveDelay=700;});
  await page.locator('#workshop-name').fill('在途编辑');
  await page.waitForTimeout(900);
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await page.waitForTimeout(3000);
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {name:d?.name,revision:d?.revision};});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('#workshop-name').waitFor();
  const restored=await page.locator('#workshop-name').inputValue();
  return {passed:state.name==='在途编辑'&&restored==='在途编辑'&&errors.length===0,state,restored,errors};
 }finally{await context.close();}
});
await record('assembly_first_edit_after_discard_autosaves',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.waitForFunction(()=>!document.querySelector('#workshop-name')?.disabled);
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.draft-status.is-saved').waitFor();
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'丢弃草稿',exact:true}).click();
  await page.locator('.draft-status.is-idle').waitFor();
  await page.locator('#workshop-name').fill('首笔编辑');
  await page.locator('.draft-status.is-saved').waitFor({timeout:5000});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {name:d?.name,revision:d?.revision};});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('#workshop-name').waitFor();
  const restored=await page.locator('#workshop-name').inputValue();
  return {passed:state.name==='首笔编辑'&&restored==='首笔编辑'&&errors.length===0,state,restored,errors};
 }finally{await context.close();}
});
await record('assembly_pending_flush_return_and_submit',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.waitForFunction(()=>!document.querySelector('#workshop-name')?.disabled);
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const img=window.__review.makeImage();const frames=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,Array(5).fill(img)]));await s.saveCreationDraft({schemaVersion:1,draftId:'manual-assembly',pendingPetId:'pending-a04',name:'草稿伙伴',species:'cat',manualFrames:frames},null);});
  await page.reload({waitUntil:'domcontentloaded'});
  await openWorkshopTask(page,'装配动作帧');
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(()=>{window.__review.blockDraftSave=true;});
  await page.locator('#workshop-name').fill('旧内容');
  await page.waitForFunction(()=>window.__review.draftSaveBlocked===true,{timeout:5000});
  await page.locator('#workshop-name').fill('最新内容');
  await page.getByRole('button',{name:'陪伴',exact:true}).click();
  await openWorkshopTask(page,'装配动作帧');
  await page.waitForFunction(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.includes('保存全套动作并应用到桌面'));return Boolean(button)&&!button.disabled;});
  await page.getByRole('button',{name:'保存全套动作并应用到桌面',exact:true}).click();
  await page.evaluate(()=>{window.__review.blockDraftSave=false;window.__review.releaseDraftSave?.();});
  await page.waitForFunction(async()=>{const s=await import('/src/storage.ts');return (await s.loadAllPets()).length===1;},null,{timeout:8000});
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const pet=await s.loadPet();const d=await s.loadCreationDraft('manual-assembly');return {name:pet?.name,id:pet?.id,draft:Boolean(d),toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent),blocked:window.__review.draftSaveBlocked,count:window.__review.draftSaveBlockCount};});
  return {passed:state.name==='最新内容'&&state.id==='pending-a04'&&!state.draft&&!state.toasts.some(t=>t?.includes('其他窗口已更新'))&&errors.length===0,state,errors};
 }finally{await context.close();}
});
await record('assembly_two_pages_conflict_keeps_latest_draft',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  await page.waitForFunction(()=>!document.querySelector('#workshop-name')?.disabled);
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.draft-status.is-saved').waitFor();
  const second=await context.newPage();
  await second.goto(base,{waitUntil:'domcontentloaded'});
  await openWorkshopTask(second,'装配动作帧');
  await second.locator('.draft-status.is-saved').waitFor();
  await second.locator('#workshop-name').fill('乙窗口');
  await second.locator('.draft-status.is-saved').waitFor();
  const revisionAfterSecond=await second.evaluate(async()=>{const s=await import('/src/storage.ts');return (await s.loadCreationDraft('manual-assembly'))?.revision;});
  await page.locator('#workshop-name').fill('甲窗口');
  await page.locator('.draft-status.is-conflict').waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {input:document.querySelector('#workshop-name')?.value,draftName:d?.name,revision:d?.revision};});
  return {passed:state.input==='甲窗口'&&state.draftName==='乙窗口'&&state.revision===revisionAfterSecond&&errors.length===0,revisionAfterSecond,state,errors};
 }finally{await context.close();}
});
await record('generation_task_list_and_consent',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await page.evaluate(()=>{window.__review.generationTasks=[{taskId:'task-old',revision:2,stage:'interrupted',pendingPetId:'pending-old',species:'cat',completedActions:2,updatedAt:'2026-10-26T00:00:00Z'}];});
  await openWorkshopTask(page,'用照片制作');
  await page.locator('.generation-task-list').waitFor();
  const listText=await page.locator('.generation-task-list').textContent();
  const consent=page.getByRole('checkbox',{name:/我了解照片/});
  const generate=page.getByRole('button',{name:'生成角色图',exact:true});
  const before=await generate.isDisabled();
  await consent.check();
  const after=await generate.isDisabled();
  await page.getByRole('button',{name:'继续',exact:true}).click();
  await page.locator('.toast-message').filter({hasText:'已领取上次制作任务'}).waitFor();
  const claims=await page.evaluate(()=>window.__review.calls.filter(c=>c.cmd==='claim_generation_task').map(c=>({taskId:c.taskId,resume:c.resume})));
  return {passed:listText?.includes('上次制作未完成')&&listText?.includes('2/6')&&before&&!after&&claims.length===1&&claims[0].taskId==='task-old'&&claims[0].resume===true&&errors.length===0,listText,before,after,claims,errors};
 }finally{await context.close();}
});
await record('assembly_draft_conflict_keeps_local_input',async()=>{
 const {context,page,errors}=await newCase({desktop:true});
 try{
  await openWorkshopTask(page,'装配动作帧');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.fillStyle='#71402a';x.fillRect(20,10,60,80);return c.toDataURL().split(',')[1];});
  await page.locator('.frame-add-card input[type=file]').setInputFiles({name:'001.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await page.locator('.draft-status.is-saved').waitFor();
  await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');await s.saveCreationDraft({...d,name:'其他窗口草稿'},d.revision);});
  await page.locator('#workshop-name').fill('本地名字');
  await page.locator('.draft-status.is-conflict').waitFor();
  const state=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {input:document.querySelector('#workshop-name')?.value,draftName:d?.name,finalDisabled:[...document.querySelectorAll('button')].some(b=>b.textContent?.includes('保存全套动作并应用到桌面')&&b.disabled),toasts:[...document.querySelectorAll('.toast-message')].map(n=>n.textContent)};});
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'丢弃草稿',exact:true}).click();
  await page.locator('.toast-message').filter({hasText:'未删除'}).waitFor();
  const afterDiscard=await page.evaluate(async()=>{const s=await import('/src/storage.ts');const d=await s.loadCreationDraft('manual-assembly');return {input:document.querySelector('#workshop-name')?.value,draftName:d?.name};});
  return {passed:state.input==='本地名字'&&state.draftName==='其他窗口草稿'&&state.finalDisabled&&afterDiscard.input==='本地名字'&&afterDiscard.draftName==='其他窗口草稿'&&state.toasts.some(t=>t?.includes('其他窗口已更新'))&&errors.length===0,state,afterDiscard,errors};
 }finally{await context.close();}
});
}finally{
 if(only){const seen=new Set(results.map(result=>result.name));const missing=[...only].filter(name=>!seen.has(name));if(missing.length){console.error('PET_ONLY matched no scenario: '+missing.join(', '));process.exitCode=1;}}
 await browser.close();
 if(results.some(result=>!result.passed))process.exitCode=1;
 await writeFile(join(evidenceDir,'workflow-results.json'),JSON.stringify(results,null,2));
 console.log('EVIDENCE_DIR='+evidenceDir);
}
