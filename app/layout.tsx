import type { Metadata } from 'next';
import './globals.css';
import './brand-theme.css';
import './ux112.css';
import './ux113.css';
import './ux114.css';
import './ux116.css';
import {CriterionIntro} from '../components/criterion-intro';
export const metadata: Metadata = {title:'Criterion 1.16 — договорённости на бумаге',description:'Создавайте, проверяйте и сохраняйте договоры в одном рабочем пространстве.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ru"><body><CriterionIntro/>{children}</body></html>}
