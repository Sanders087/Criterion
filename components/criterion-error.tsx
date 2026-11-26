'use client';
import { useState } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { supportData, type ApiError } from '../lib/criterion/client-session';
import './criterion-error.css';

export function CriterionError({error,onDismiss}:{error:ApiError|null;onDismiss?:()=>void}) {
  if (!error) return null;
  return <ErrorReport key={error.occurredAt+error.code+(error.requestId||'')} error={error} onDismiss={onDismiss}/>;
}
function ErrorReport({error,onDismiss}:{error:ApiError;onDismiss?:()=>void}) {
  const [copy,setCopy] = useState<'idle'|'copied'|'manual'>('idle');
  const report = supportData(error);
  async function copyReport() {
    try { await navigator.clipboard.writeText(report); setCopy('copied'); }
    catch { setCopy('manual'); }
  }
  return <div className="criterion-error" role="alert">
    <AlertCircle size={18} aria-hidden="true"/>
    <div className="criterion-error-body">
      <p>{error.message}</p>
      <button type="button" className="text-button" onClick={copyReport}>Скопировать для поддержки</button>
      {copy==='copied' && <span role="status">Скопировано</span>}
      {copy==='manual' && <label>Скопируйте выделенный текст вручную
        <textarea aria-label="Данные ошибки для поддержки" rows={4} readOnly value={report}
          ref={node=>{ if(node){node.focus();node.select();} }}/>
      </label>}
    </div>
    {onDismiss && <button type="button" className="icon-button" aria-label="Закрыть ошибку" onClick={onDismiss}><X size={16}/></button>}
  </div>;
}
