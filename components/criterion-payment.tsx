'use client';
import {useState} from 'react';
import {LockKeyhole,ShieldCheck,RefreshCw,ArrowUpRight} from 'lucide-react';
import type {Contract} from '../lib/criterion/domain';

export function LockedDraft({doc,busy,ready,testMode=false,email='',onPay,onCheck}:{doc:Contract;busy:boolean;ready:boolean;testMode?:boolean;email?:string;onPay:(email:string)=>void;onCheck:()=>void}){
  const refunded=doc.billing?.state==='refunded';
  const [receiptEmail,setReceiptEmail]=useState(email);
  return <div className="payment-layout">
    <div className="locked-preview" aria-hidden="true">
      <article className="contract-paper"><div className="paper-brand">CRITERION<span>ЧЕРНОВИК</span></div><h2>{doc.title}</h2>
        <div className="blurred-draft">{doc.sections.map(section=><section key={section.id}><h3>{section.title}</h3><p>{'Согласованные условия договора, права и обязанности сторон. '.repeat(9)}</p></section>)}</div>
      </article>
    </div>
    <section className="payment-card" aria-label="Открыть договор">
      <span className="payment-icon"><LockKeyhole size={25}/></span>
      <div className="eyebrow">ВАШ ЧЕРНОВИК ГОТОВ</div>
      <h2>{refunded?'Оплата возвращена':'Откройте полный договор'}</h2>
      <p>{refunded?'Доступ к полному тексту закрыт после возврата. Если это произошло по ошибке, обратитесь в поддержку.':'Интервью и подготовка черновика бесплатны. Одна оплата открывает этот договор в вашем аккаунте.'}</p>
      <div className="contract-price">199 <span>₽ / договор</span></div>
      <ul><li>Полный текст и ручное редактирование</li><li>Скачивание Word, TXT и печать / PDF</li><li>Две ИИ-операции: правки или повторные проверки</li><li>Повторное открытие без новой оплаты</li></ul>
      {testMode&&<p className="payment-note" role="status">Тестовый режим Т-Банка. Используйте только тестовую карту: реальные деньги не списываются.</p>}
      {!refunded&&<form onSubmit={event=>{event.preventDefault();onPay(receiptEmail.trim())}}><label className="receipt-email">Email для чека<input type="email" name="receiptEmail" autoComplete="email" maxLength={64} required value={receiptEmail} disabled={busy} onChange={event=>setReceiptEmail(event.target.value)}/></label><button type="submit" className="button primary full" disabled={busy||!ready}>{testMode?'Проверить тестовую оплату 199 ₽':'Оплатить 199 ₽'}<ArrowUpRight size={17}/></button></form>}
      {!ready&&!refunded&&<p className="payment-note" role="status">Оплата скоро станет доступна. Черновик сохранён — вернитесь к нему позже.</p>}
      <button className="button secondary full" disabled={busy} onClick={onCheck}><RefreshCw size={16}/>Проверить оплату</button>
      <p className="payment-note"><ShieldCheck size={16}/>На странице Т-Банка выберите СБП, SberPay или карту. После оплаты вы вернётесь к договору; подтверждение проверяется автоматически.</p>
    </section>
  </div>;
}
