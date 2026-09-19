const origin=process.env.FRONTEND_URL || 'http://127.0.0.1:5175';
const output=process.env.SCREENSHOT_DIR || '/tmp';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const f=JSON.parse(fs.readFileSync(process.env.RARE_BROWSER_FIXTURE || '/tmp/fangji-rare-fixture.json','utf8'));
const {sample,key,project,users,admin,baseUrl}=f;
const pageId=f.pages[2].id;
async function api(path,token,body){
 const r=await fetch(baseUrl+path,{method:body?'POST':'GET',headers:{Authorization:token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const raw=await r.text();assert(r.ok,raw);return JSON.parse(raw);
}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 async function loggedPage(auth){
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true});
  await context.addInitScript(auth=>{if(!localStorage.getItem('pocketbase_auth'))localStorage.setItem('pocketbase_auth',JSON.stringify({token:auth.token,model:auth.record}))},auth);
  return context.newPage();
 }
 for(let i=0;i<2;i++){
  const page=await loggedPage(users[i]);
  await page.goto(`${origin}/tasks`);
  // Claim through the actual front-end service and save its lease like the hall.
  const claim=await page.evaluate(async({projectId,userId})=>{
   const {claimNextProjectPage}=await import('/src/services/pagesService.js');
   const {saveTaskLease}=await import('/src/lib/taskLease.js');
   const claim=await claimNextProjectPage(projectId,userId);
   saveTaskLease(sessionStorage,{userId,pageId:claim.id,token:claim.leaseToken,expiresAt:claim.leaseExpiresAt});return claim;
  },{projectId:project.id,userId:users[i].record.id});
  assert.equal(claim.id,pageId);
  await page.goto(`${origin}/tasks/${pageId}/edit`);
  const field=page.getByRole('textbox',{name:`${key} 校对结果`,exact:true});
  await field.waitFor();assert.equal(await field.inputValue(),sample);
  const value=sample+(i?'乙':'甲');
  await field.fill(value);
  // Browser localStorage uses the actual autosave and restores after reload.
  await page.waitForFunction(({id,value})=>{const raw=Object.keys(localStorage).find(k=>k.includes('task-draft')&&k.endsWith(id));return raw&&localStorage.getItem(raw).includes(value)},{id:pageId,value});
  await page.reload();await field.waitFor();assert.equal(await field.inputValue(),value);
  assert.match(await page.locator('.draft-indicator').innerText(),/已恢复/);
  await page.evaluate(()=>document.fonts.ready);
  if(i===0)await page.screenshot({path:`${output}/rare-editor.png`,fullPage:true});
  await page.getByRole('button',{name:'检查并提交',exact:true}).click();
  const sent=page.waitForResponse(r=>r.url().endsWith(`/pages/${pageId}/submit`)&&r.request().method()==='POST');
  await page.getByRole('button',{name:'确认提交',exact:true}).click();assert((await sent).ok());
  await page.context().close();
 }
 const arb=await api(`/api/fangji/pages/${pageId}/arbitration`,admin.token);
 assert.deepEqual(arb.attempts.map(a=>JSON.parse(a.row_json)[key]),[sample+'甲',sample+'乙']);
 const page=await loggedPage(admin);
 await page.goto(`${origin}/admin/projects/${project.id}/arbitration/${pageId}`);
 const finalField=page.getByRole('textbox',{name:`${key}的最终仲裁结果`,exact:true});
 await finalField.fill(sample+'终');
 await page.getByLabel('仲裁说明', {exact:false}).fill(sample);
 await page.screenshot({path:`${output}/rare-arbitration.png`,fullPage:true});
 await page.getByRole('button',{name:'检查并完成仲裁',exact:true}).first().click();
 const arbitrated=page.waitForResponse(r=>r.url().endsWith(`/pages/${pageId}/arbitrate`)&&r.request().method()==='POST');
 await page.getByRole('dialog').getByRole('button',{name:/确认|完成/}).click();
 assert((await arbitrated).ok());
 const saved=await api(`/api/collections/pages/records/${pageId}`,admin.token);
 assert.equal(JSON.parse(saved.proofread_row_json)[key],sample+'终');assert.equal(saved.arbitration_note,sample);
 await page.goto(`${origin}/admin/projects/${project.id}`);
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('button',{name:'导出校对结果 CSV',exact:true}).click();
 const download=await downloadPromise;
 const bytes=fs.readFileSync(await download.path());
 assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
 const csv=bytes.toString('utf8');
 assert.deepEqual(csv.replace(/^\uFEFF/, '').split('\r\n').map(line=>line.split(',')), [
  ['PDF页码',key,'释义'],['1',sample,sample+'终'],['2',sample,sample],['3',sample+'终',sample]
 ]);
 assert(!csv.includes('\uFFFD'));
 fs.writeFileSync('/tmp/fangji-rare-export.csv',bytes);
 await page.context().close();await browser.close();
 console.log('PASS real Chrome/backend: source load, edit, autosave/localStorage, reload restore, 2 submissions, arbitration UI/note, download BOM CSV.');
})().catch(e=>{console.error(e);process.exit(1)});
