import {Check} from 'lucide-react';

const steps = ['Собрать условия', 'Получить черновик', 'Проверить детали', 'Скачать договор'];

export function ContractProgress({current}: {current: number | null}) {
  return <ol className="contract-progress" aria-label="Этапы работы над договором">
    {steps.map((label, index) => {
      const complete = current !== null && index < current;
      const active = current === index;
      return <li key={label} className={active ? 'is-current' : complete ? 'is-complete' : ''} aria-current={active ? 'step' : undefined}>
        <span className="progress-marker" aria-hidden="true">{complete ? <Check size={13}/> : String(index + 1).padStart(2, '0')}</span>
        <span>{label}{active && <small>Текущий этап</small>}{complete && <span className="sr-only"> — завершён</span>}</span>
      </li>;
    })}
  </ol>;
}
