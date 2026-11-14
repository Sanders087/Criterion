import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'Criterion 1.1 — договорённости на бумаге',description:'Создавайте, проверяйте и сохраняйте договоры в одном рабочем пространстве.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ru"><body>{children}</body></html>}
