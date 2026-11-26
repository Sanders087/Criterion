'use client';
import { useState } from 'react';
import { asClientError } from '../lib/criterion/client-session';
import { CriterionError } from '../components/criterion-error';

export default function PageError({ reset }: { error: Error; reset: () => void }) {
  const [diagnosis] = useState(() => asClientError(undefined,'ui'));
  return <main className="auth-page"><section className="auth-card">
    <h1>Не удалось отобразить страницу</h1>
    <CriterionError error={diagnosis}/>
    <button type="button" className="button secondary" onClick={reset}>Попробовать снова</button>
  </section></main>;
}
