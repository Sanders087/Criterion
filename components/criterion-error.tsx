'use client';

import { useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { logClientError, type ApiError } from '../lib/criterion/client-session';

type Props = {
  error: ApiError | null;
  onDismiss?: () => void;
  as?: 'p' | 'div';
};

export function CriterionError({ error, onDismiss, as: Tag = 'div' }: Props) {
  useEffect(() => logClientError(error), [error]);
  if (!error) return null;

  if (!onDismiss) return <Tag className="auth-error" role="alert">{error.message}</Tag>;

  return <div className="error-box" role="alert">
    <AlertCircle size={18} aria-hidden="true"/>
    <span>{error.message}</span>
    <button type="button" className="icon-button" aria-label="Закрыть ошибку" onClick={onDismiss}>
      <X size={16} aria-hidden="true"/>
    </button>
  </div>;
}
