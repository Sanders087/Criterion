import test from 'node:test';
import assert from 'node:assert/strict';
import {makeContract,draftTemplate,review,snapshot,fields,SECTIONS,demoContract} from '../lib/criterion/domain.ts';
import {ensureStructure,mergeFacts,repeatedQuestion,templateSections} from '../lib/criterion/ai.ts';
import {docx} from '../lib/criterion/export.ts';

test('All supported contract kinds retain a complete structure; unknown facts are explicit',()=>{
 for(const kind of ['services','sale','lease','work','nda','other'] as const){const d=makeContract(kind,'form');d.sections=draftTemplate(d);assert.deepEqual(d.sections.map(s=>s.id),SECTIONS.map(s=>s.id));assert.ok(d.sections.every(s=>s.content.trim()));assert.ok(d.sections.find(s=>s.id==='parties')!.content.includes('<…>'));assert.ok(review(d).some(i=>i.severity==='high'))}
});
test('Lease context never becomes website-work acceptance',()=>{
 const d=makeContract('lease','form');d.facts={subject:'Офис № 8',acceptance:'По акту передачи ключей'};d.sections=draftTemplate(d);assert.match(d.sections.find(s=>s.id==='subject')!.content,/Офис № 8/);const a=d.sections.find(s=>s.id==='acceptance')!.content;assert.match(a,/передачи и приёмки/);assert.match(a,/акту передачи ключей/);assert.doesNotMatch(a,/сайт|результат работы/);
});
test('Payment on delivery and agreed penalty map to their sections, not the end',()=>{
 const d=makeContract('sale','form');d.facts={payment:'Оплата при получении товара',liability:'0,2% за день просрочки'};d.sections=draftTemplate(d);assert.match(d.sections.find(s=>s.id==='payment')!.content,/Оплата при получении/);assert.match(d.sections.find(s=>s.id==='liability')!.content,/0,2%/);assert.doesNotMatch(d.sections.find(s=>s.id==='other')!.content,/0,2%/);
});
test('Versions are immutable copies',()=>{const d=demoContract();const v=snapshot(d,'Снимок');const original=v.sections[0].content;d.sections[0].content='changed';assert.equal(v.sections[0].content,original)});
test('Changing or dropping a template section fails explicitly',()=>{const s=demoContract().sections;assert.doesNotThrow(()=>ensureStructure(s,s));assert.throws(()=>ensureStructure(s.slice(0,3),s));assert.throws(()=>ensureStructure(s.map((v,i)=>i===0?{...v,title:'Другой заголовок'}:v),s))});
test('Repeated assistant questions are detected independent of punctuation',()=>{const d=makeContract('sale','ai');d.messages.push({id:'x',at:'x',role:'assistant',text:'Какой срок оплаты?'});assert.equal(repeatedQuestion('Какой срок оплаты.',d.messages),true);assert.equal(repeatedQuestion('Как передаётся товар?',d.messages),false)});
test('Fact extraction is restricted to this contract schema',()=>{const d=makeContract('services','ai');d.facts.partyA='Анна';const f=mergeFacts(d,{partyB:'Борис',partyA:'',owner:'attacker',revision:'100'});assert.deepEqual(f,{partyA:'Анна',partyB:'Борис'})});
test('Custom template validation rejects malformed source',()=>{assert.throws(()=>templateSections({prompt:'',sources:'',template:'not json'}));assert.throws(()=>templateSections({prompt:'',sources:'',template:'[]'}))});
test('Word export is ZIP-based OOXML and contains the complete Unicode document',()=>{const bytes=docx(demoContract());assert.equal(new DataView(bytes.buffer).getUint32(0,true),0x04034b50);const text=new TextDecoder().decode(bytes);assert.ok(text.includes('word/document.xml'));assert.ok(text.includes('Реквизиты и подписи'));assert.ok(text.includes('80 000 рублей'))});

test('Unknown facts and unchosen alternatives both require review',()=>{const d=demoContract();d.sections=[{id:'subject',title:'Предмет',content:'Объект <…>. Расходы [несёт заказчик / несёт исполнитель].'}];const issues=review(d);assert.ok(issues.some(i=>i.id==='missing-subject'));assert.ok(issues.some(i=>i.id==='alternatives-subject'))});
test('DOCX applies the supplied fonts, margins, table separators and party emphasis',()=>{const d=demoContract();const text=new TextDecoder().decode(docx(d));assert.match(text,/w:ascii="Garamond"/);assert.match(text,/w:sz w:val="36"/);assert.match(text,/w:top="2160" w:right="850" w:bottom="1140" w:left="1701"/);assert.match(text,/w:line="240"/);assert.match(text,/w:pStyle w:val="ListParagraph"/);assert.equal((text.match(/w:fill="C8C8C8"/g)||[]).length,d.sections.length);assert.equal((text.match(/<w:tr>/g)||[]).length,d.sections.length*2+1);assert.match(text,/<w:b w:val="1"\/>[^]*?ИП Анна Смирнова/);assert.doesNotMatch(text,/<w:i\/>|<w:u w:val="single"/)});
