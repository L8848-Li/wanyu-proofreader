const {chromium}=require('playwright');
const preset = require('../../../backend/keyboards/hinghwa-dialect.json');
let realPreset = false;
(async()=>{
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || 'chrome'});const page=await browser.newPage();page.on('dialog', dialog=>dialog.accept()); const errors=[];page.on('pageerror',e=>errors.push(e.message));
const row={'字词':'测试','读音':'tɛ','释义':'演示材料'};const record={id:'page1',project:'project1',page_number:1,pdf_page:5,ocr_row_json:JSON.stringify(row),expand:{project:{name:'虚构测试项目'},project_file:{id:'file1',collectionId:'project_files',file:'fixture.pdf'}}};
await page.route('**/api/**',async route=>{const url=route.request().url();if(url.includes('/api/files/')) throw Error('Restricted PDF must not use direct file URLs'); if(url.endsWith('/pdf')) return route.fulfill({contentType:'application/pdf',headers:{'X-PDF-Start-Page':'5','X-PDF-End-Page':'5','X-PDF-Total-Pages':'10'},body:Buffer.from('JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDkwOTAyMzUyNSswOCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDkwOTAyMzUyNSswOCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTg2Cj4+CnN0cmVhbQpHYXJXMFltUz81JjRIRENgS1ksImo/Y1xJJ1hTSlVmY1EkbFQhIkdiPVlFOEVoRiZxSEE3ND0pX2ZOblNcOUhPVllUZFRzIz9RRjw+YV5uTi9fNi1wXURHcFgqL2YoUEMsK0U1Pys+WlY4KmwyJGtnXlNeXD0vLillNUFgXzBRPXA5SnJEQWVTTydTSGBvOkxgImlmciooO1YwSic0KS1NKm90MjU8UDxEJjgzIUoyK3NcaGE9WjUxfj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAgbiAKMDAwMDAwMDQwMiAwMDAwMCBuIAowMDAwMDAwNDcwIDAwMDAwIG4gCjAwMDAwMDA3MzEgMDAwMDAgbiAKMDAwMDAwMDc5MCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9JRCAKWzwxNDdmNjJkZDU0NjExMzQxZjk4ODUwZDZmNzQ1Y2Y1MD48MTQ3ZjYyZGQ1NDYxMTM0MWY5ODg1MGQ2Zjc0NWNmNTA+XQolIFJlcG9ydExhYiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDUgMCBSCi9Sb290IDQgMCBSCi9TaXplIDgKPj4Kc3RhcnR4cmVmCjEwNjYKJSVFT0YK', 'base64')});let data={items:[],totalItems:0,totalPages:1,page:1,perPage:100};
if(url.endsWith('/task'))data=record;
if(url.endsWith('/claim'))data={...record,leaseToken:'fixture-lease',leaseExpiresAt:'2099-01-01T00:00:00Z'};
if(url.endsWith('/mine'))data=[record];
if(url.endsWith('/keyboards'))data={items:[{keyboardId:'ipa',name:'音标键盘',definition:{sections:[{id:'vowels',label:'元音',defaultOpen:true,keys:['ɑ','ɛ','ə','ɔ'].map(value=>({value}))},{id:'tones',label:'声调',keys:[{value:'˥'}]}]}}],defaultKeyboardId:'ipa'};
if(url.endsWith('/arbitration'))data={page:record,attempts:[{id:'a',pass_no:1,row_json:JSON.stringify(row)},{id:'b',pass_no:2,row_json:JSON.stringify({...row,读音:'ta'})}]};
if (url.endsWith('/keyboards') && realPreset) data={items:[{keyboardId:preset.id,name:preset.name,definition:preset}],defaultKeyboardId:preset.id};
if(url.endsWith('/findings'))data={page:'page1',hints:[{field:'读音',kind:'reading_format_invalid',severity:'strong',message:{key:'long_digit_run',params:{runs:['5333'],run_count:1}},highlight:true,evidence:{char_offsets:[[0,2]]}},{field:'声调',kind:'punctuation_mix',severity:'warn',message:{key:'punctuation_width_mixed_in_column',params:{}},highlight:false,evidence:{}},{field:'',kind:'page_outlier',severity:'warn',message:{key:'pdf_page_backtrack',params:{from_page:9,to_page:5,backtrack:4}},highlight:false,evidence:{}}],truncated:false};
await route.fulfill({json:data});});
for(const admin of [false,true]){
await page.setViewportSize({width:1440,height:900});await page.goto('http://localhost:5173/tests/fixtures/review.html'+(admin?'?admin':''));await page.waitForTimeout(1000); await page.locator('.ipa-key').first().waitFor({timeout:3000});
await page.locator('.pdf-loading-mask').waitFor({state:'hidden'}); if(await page.locator('.pdf-page-label').innerText() !== '第 5 / 10 页') throw Error('Restricted PDF source page mapping');
const source=await page.locator('.source-panel').boundingBox(),key=await page.locator('.keyboard-panel').boundingBox(),fields=await page.locator('.fields-panel').boundingBox();if(!(key.x<fields.x && key.y>source.y))throw Error('Desktop placement');
await page.screenshot({path:`/tmp/review-${admin?'arb':'proof'}-desktop.png`});
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150); await page.screenshot({path:`/tmp/review-${admin?'arb':'proof'}-mobile-pdf.png`});
await page.getByRole('button',{name:'字符键盘',exact:true}).click();await page.getByRole('button',{name:'钉住',exact:true}).click();
await page.getByRole('button',{name:'声调 1',exact:true}).click(); if(!await page.getByRole('button',{name:'插入字符 ˥',exact:true}).isVisible())throw Error('Group switch failed'); await page.getByRole('button',{name:'元音 4',exact:true}).click(); await page.locator('.ipa-key').first().click();
if(!await page.locator('textarea:visible').first().inputValue().then(v=>v.includes('ɑ')))throw Error('Insertion failed');
await page.screenshot({path:`/tmp/review-${admin?'arb':'proof'}-mobile.png`});
if(!admin){await page.getByRole('button',{name:'下一个',exact:true}).click();if(await page.locator('.proofread-field:visible').count()!==1)throw Error('Field navigation');await page.getByRole('button',{name:'下一个',exact:true}).click();await page.getByRole('button',{name:'整条总览',exact:true}).click();if(await page.locator('.proofread-field:visible').count()!==3)throw Error('Overview');if(await page.locator('.ipa-key').first().isVisible())throw Error('Overview keyboard not hidden');}
}
// A desktop focus change must follow the field into the single-field layout.
for (const admin of [false, true]) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => localStorage.clear())
  await page.goto('http://localhost:5173/tests/fixtures/review.html' + (admin ? '?admin' : ''))
  await page.locator('.ipa-key').first().waitFor()
  if (!admin) {
    // #161 非空 hints 的真渲染覆盖：字段级可点 chip 1 个 + 整条级 2 个
    // （其中「声调」是列名不在本行的孤儿 hint，必须并入整条级而不是消失）。
    if (await page.locator('.field-hint-chip').count() !== 3) throw Error('Machine hint chips not rendered')
    await page.locator('button.field-hint-chip').first().click()
    if (!await page.locator('.source-value__hit').first().isVisible()) throw Error('Hint click did not highlight source span')
  }
  if (admin) await page.getByRole('button', { name: '全部字段 3', exact: true }).click()
  const fieldCards = page.locator(admin ? '.arbitration-field' : '.proofread-field')
  const inputs = fieldCards.locator('textarea')
  // Save a caret in the first field, then a replacement selection in the third.
  await inputs.nth(0).focus()
  await inputs.nth(0).evaluate(el => { el.setSelectionRange(1, 1); el.dispatchEvent(new Event('select')) })
  await inputs.nth(2).focus()
  await inputs.nth(2).evaluate(el => { el.setSelectionRange(1, 3); el.dispatchEvent(new Event('select')) })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForFunction(selector => {
    const cards = [...document.querySelectorAll(selector)]
    return cards.filter(el => el.getBoundingClientRect().height > 0).length === 1
  }, admin ? '.arbitration-field' : '.proofread-field')
  if (!await fieldCards.nth(2).isVisible()) throw Error(`${admin ? 'Arbitration' : 'Proofreading'}: desktop target hidden after resize`)
  await page.getByRole('button', { name: '字符键盘', exact: true }).click()
  await page.getByRole('button', { name: '钉住', exact: true }).click()
  await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
  if (await inputs.nth(2).inputValue() !== '演ɑ料') throw Error('Resize lost replacement selection')
  if (await inputs.nth(0).inputValue() !== row.字词 || await inputs.nth(1).inputValue() !== row.读音) throw Error('Resize changed a hidden field')
  // Return to the first field and use its independent remembered caret.
  await page.getByRole('navigation', { name: '字段导航' }).getByRole('combobox').selectOption('0')
  await inputs.nth(2).evaluate(el => el.dispatchEvent(new Event('select')))
  await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
  if (await inputs.nth(0).inputValue() !== '测ɑ试') throw Error('Field navigation lost remembered caret')
  // Cross back to desktop, choose another target, and enter mobile again.
  await page.setViewportSize({ width: 1440, height: 900 })
  await inputs.nth(1).focus()
  await inputs.nth(1).evaluate(el => { el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')) })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '字符键盘', exact: true }).click()
  await page.getByRole('button', { name: '插入字符 ɑ', exact: true }).click()
  if (!await fieldCards.nth(1).isVisible() || await inputs.nth(1).inputValue() !== 'ɑtɛ') throw Error('Repeated resize uses stale target')
}
// Exercise the shipped preset with both shortcut and complete categories.
realPreset = true;
await page.addInitScript(() => localStorage.clear());
for (const admin of [false, true]) for (const mobile of [false, true]) {
  await page.setViewportSize(mobile ? {width:390,height:844} : {width:1440,height:900});
  await page.evaluate(() => localStorage.clear());
  await page.goto('http://localhost:5173/tests/fixtures/review.html'+(admin?'?admin':''));
  await page.locator('.ipa-key').first().waitFor({state:'attached'});
  await page.locator('.pdf-loading-mask').waitFor({state:'hidden'});
  if (mobile) {
    await page.getByRole('button',{name:'字符键盘',exact:true}).click();
    await page.getByRole('button',{name:'钉住',exact:true}).click();
    if(await page.locator('.keyboard-section-switcher button[aria-pressed="true"]').innerText()!=='常用校对 24')throw Error('Wrong initial mobile group');
  } else {
    if(await page.locator('details.ipa-section[open]').count()!==1)throw Error('Only shortcuts should start expanded');
  }
  const group = id => page.locator('details.ipa-section').filter({has:page.locator('summary',{hasText:preset.sections.find(s=>s.id===id).label})});
  const choose=async id=>{
    const section=preset.sections.find(s=>s.id===id);
    if(mobile) await page.getByRole('button',{name:section.label+' '+section.keys.length,exact:true}).click();
    else if(!await group(id).getAttribute('open').then(v=>v!==null)) await group(id).locator('summary').click();
    return group(id);
  };
  const insert=async (id,value)=>{
    const section=await choose(id),key=preset.sections.find(s=>s.id===id).keys.find(k=>k.value===value);
    await section.getByRole('button',{name:key.hint||'插入字符 '+value,exact:true}).click();
  };
  const count=new Set(preset.sections.flatMap(s=>s.keys.map(k=>k.value))).size;
  if(!await page.locator('.ipa-keyboard-heading').innerText().then(t=>t.includes(count+' 个字符')))throw Error('Shortcut duplicates inflated total');
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:`/tmp/keyboard-default-${admin?'arb':'proof'}-${mobile?'mobile':'desktop'}.png`});
  const field=page.locator('textarea:visible').first();
  await field.fill('甲乙');await field.focus();
  await field.evaluate(el=>{el.setSelectionRange(1,1);el.dispatchEvent(new Event('select'))});
  await insert('common-proofreading','ã');
  await insert('nasalized','ã');
  if(await field.inputValue()!=='甲ãã乙')throw Error('Shortcut/category values or caret differ');
  await field.evaluate(el=>{el.focus();el.setSelectionRange(1,3);el.dispatchEvent(new Event('select'))});
  await insert('common-proofreading','ɒ̃');
  if(await field.inputValue()!=='甲ɒ̃乙')throw Error('Shortcut lost replacement selection');
  await field.fill('甲a乙');await field.focus();
  await field.evaluate(el=>{el.setSelectionRange(2,2);el.dispatchEvent(new Event('select'))});
  await insert('combining-marks','̃');
  await insert('dictionary-symbols','〔');await insert('common-proofreading','〕');
  if(await field.inputValue()!=='甲ã〔〕乙')throw Error('Mark label leaked or cross-group caret changed');
  for(const section of preset.sections) {
    const visible=await choose(section.id);
    if(await visible.locator('.ipa-key:visible').count()!==section.keys.length)throw Error('Unreachable category '+section.id);
    // Long groups scroll within the dock; even the last key must be fully reachable.
    const last=visible.locator('.ipa-key').last();await last.scrollIntoViewIfNeeded();
    const keyBox=await last.boundingBox(),dockBox=await page.locator('.keyboard-dock-content').boundingBox();
    if(keyBox.y<dockBox.y-1 || keyBox.y+keyBox.height>dockBox.y+dockBox.height+1)throw Error('Clipped last key '+section.id);
  }
  await insert('mandarin-tones','ǖ');
  if(await field.inputValue()!=='甲ã〔〕ǖ乙')throw Error('Complete Mandarin group lost caret');
  const loaded=await page.evaluate(async values=>Promise.all(values.map(async value=>(await document.fonts.load('16px "Fangji Phonetic"',value)).length>0)),[...new Set(preset.sections.flatMap(s=>s.keys.map(k=>k.value)))]);
  if(loaded.some(value=>!value))throw Error('Keyboard value has no bundled font');
  await choose('common-proofreading');
  await page.screenshot({path:`/tmp/keyboard-symbols-${admin?'arb':'proof'}-${mobile?'mobile':'desktop'}.png`});
}
if(errors.length)throw Error(errors.join('\n'));console.log('Desktop/mobile layout, group switching, protected PDF mapping, cross-breakpoint targets and per-field selections passed for both review views.');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
