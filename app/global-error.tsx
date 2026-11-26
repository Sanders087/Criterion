'use client';
import PageError from './error';

export default function RootError(props: { error: Error; reset: () => void }) {
  return <html lang="ru"><body><PageError {...props}/></body></html>;
}
