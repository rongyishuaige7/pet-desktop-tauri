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
async function newCase({desktop=false,settingsAction='idle',missing=false,packDelay=0}={}) {
 const context=await browser.newContext({viewport:{width:1120,height:760}});
 await context.route('**/*',route=>['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await context.addInitScript(({desktop,settingsAction,missing,packDelay})=>{
  localStorage.setItem('desktop-sticker-pet:autonomous','off');
  if(!desktop)return;
  const callbacks=new Map(); const listeners=new Map(); let seq=1;
  const state=window.__review={calls:[],root:'/review/A',action:settingsAction,visible:true,delayB:0,emitOnSet:false,generations:0,saves:0};
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
    if(cmd==='get_native_pet_settings')return {frameRoot:state.root,scale:1,currentAction:settingsAction};
    if(cmd==='load_preset_frame_pack'){
     const root=args.request.rootDir;
     if(root==='/review/generated'&&state.savedActions)return {sourceImage:state.savedActions.idle[0],actions:state.savedActions};
     await new Promise(r=>setTimeout(r,root==='/review/B'?state.delayB:packDelay));
     if(missing)throw new Error('audit: custom frame directory does not exist');
     const actions=Object.fromEntries(['idle','sit','sleep','happy','walk','jump'].map(a=>[a,[0,1,2,3,4].map(i=>`/frame-pack/${a}/${String(i).padStart(3,'0')}.png?review=${root}`)]));
     return {sourceImage:actions.idle[0],actions};
    }
    if(cmd==='set_native_pet_frame_root'){
     if(args.rootDir==='/review/generated'&&state.delayGeneratedCommit){state.committing=true;await new Promise(r=>setTimeout(r,state.delayGeneratedCommit));}
     if (state.failB && args.rootDir==='/review/B') throw new Error('audit: invalid pack');
     state.root=args.rootDir;state.visible=true;
     if(state.emitOnSet)setTimeout(()=>{state.action='walk';void state.emit('walk');},30);
     return;
    }
    if(cmd==='set_native_pet_action'){state.action=args.action;return;}
    if(cmd==='set_native_pet_visible'){state.visible=args.visible;return;}
    if(cmd==='set_native_pet_scale'||cmd==='reset_native_pet_position')return;
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
 },{desktop,settingsAction,missing,packDelay});
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.locator('.stage-pet-image').waitFor();
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
 await page.locator('.stage-pet-image, .toast-message.error').first().waitFor();
 await sleep(300);
}
async function record(name,fn){
 try{const detail=await fn();const result={name,...detail};results.push(result);console.log(JSON.stringify(result));}
 catch(e){const result={name,harnessError:e.message};results.push(result);console.log(JSON.stringify(result));}
}
async function openAI(page){
 await page.getByRole('button',{name:/宠物工坊/}).click();
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
   await page.getByRole('button',{name:/宠物工坊/}).click();
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
   await page.getByRole('heading',{name:'伴侣互动台',exact:true}).waitFor();
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
   await page.getByRole('heading',{name:'伴侣互动台',exact:true}).waitFor();
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
   await page.getByRole('button',{name:/我的宠物架/}).click();
   page.once('dialog',d=>d.accept());
   await page.locator('.pet-card').filter({hasText:'测试甲'}).getByTitle('删除宠物').click();
   await page.locator('.pet-card').filter({hasText:'测试甲'}).waitFor({state:'detached'});
   await page.getByRole('button',{name:/互动伴侣台/}).click();
   const stored=await page.evaluate(async()=>{const m=await import('/src/storage.ts');return (await m.loadPet())?.id;});
   const empty=await page.locator('.stage-empty-state').isVisible();
   await page.screenshot({path:join(evidenceDir,'delete-nonactive-fixed.png')});
   return {passed:stored==='B'&&!empty,storedActive:stored,previewEmpty:empty,errors};
  }finally{await context.close();}
 });
 await record('cross_tab_action_sync',async()=>{
  const {context,page}=await newCase();
  try{
   await seed(page);
   const second=await context.newPage();await second.goto(base);await second.locator('.stage-pet-image').waitFor();
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
   const src=await page.locator('.stage-pet-image').count();
   const messages=await page.locator('.toast-message').allTextContents();
   const emptyMessage=await page.locator('.stage-empty-state').innerText();
   return {passed:src===0&&messages.some(m=>m.includes('加载宠物失败')),emptyMessage,src,messages};
  }finally{await context.close();}
 });
 await record('native_event_during_pet_deployment',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true,active:'A'});
   await page.evaluate(()=>{window.__review.delayB=500;window.__review.emitOnSet=true;});
   await page.getByRole('button',{name:/我的宠物架/}).click();
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
   await page.getByRole('button',{name:'🚀 跳跃',exact:true}).click();await sleep(800);
   const actions=await page.evaluate(()=>window.__review.calls.filter(c=>c.cmd==='set_native_pet_action').map(c=>c.action));
   return {passed:actions.join(',')==='jump',outgoingNativeActions:actions};
  }finally{await context.close();}
 });
 await record('startup_native_action_overwritten',async()=>{
  const {context,page}=await newCase({desktop:true,settingsAction:'sleep',packDelay:50});
  try{
   await seed(page,{desktop:true,active:'A'});await sleep(400);
   const visible=await page.locator('.action-pill-btn.active').innerText();
   const native=await page.evaluate(()=>window.__review.action);
   return {passed:native==='sleep'&&visible.includes('睡觉'),nativeAction:native,visibleAction:visible};
  }finally{await context.close();}
 });
 await record('rename_save_button_styles',async()=>{
  const {context,page}=await newCase();
  try{
   await seed(page);await page.getByTitle('重命名当前宠物').click();
   const styles=await page.locator('.btn-icon-save').evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,color:s.color,accent:getComputedStyle(document.documentElement).getPropertyValue('--accent-amber')};});
   return {passed:styles.background==='rgb(255, 159, 28)'&&styles.color==='rgb(255, 255, 255)',styles};
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
   await page.getByRole('button',{name:/我的宠物架/}).click();
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
   await page.getByRole('button',{name:/我的宠物架/}).click();
   await page.locator('.pet-card').filter({hasText:'测试乙'}).getByRole('button',{name:/派去桌面/}).click();
   await page.waitForFunction(()=>document.querySelector('.widget-name')?.textContent==='测试乙');
   await page.evaluate(()=>window.__review.emit({action:'sleep',petId:'A',revision:100}));
   await page.getByRole('button',{name:/互动伴侣台/}).click();
   const action=await page.locator('.action-pill-btn.active').innerText();
   return {passed:action.includes('待机'),action};
  }finally{await context.close();}
 });
 await record('last_desktop_pet_is_hidden',async()=>{
  const {context,page}=await newCase({desktop:true});
  try{
   await seed(page,{desktop:true});await page.getByRole('button',{name:/我的宠物架/}).click();
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
   await seed(page);await page.getByRole('button',{name:/我的宠物架/}).click();
   for (const name of ['测试甲','测试乙']) {
    page.once('dialog',d=>d.accept());
    const card=page.locator('.pet-card').filter({hasText:name});
    await card.getByTitle('删除宠物').click();await card.waitFor({state:'detached'});
   }
   await page.reload();await page.locator('.stage-empty-state').waitFor();
   const stored=await page.evaluate(async()=>(await (await import('/src/storage.ts')).loadAllPets()).length);
   return {passed:stored===0,stored};
  }finally{await context.close();}
 });
}finally{await browser.close();if(results.some(r=>!r.passed))process.exitCode=1;await writeFile(join(evidenceDir,'workflow-results.json'),JSON.stringify(results,null,2));console.log('EVIDENCE_DIR='+evidenceDir);}
