import type { Metadata } from 'next';
import './globals.css';
import '@/components/radar/research-workspace.css';
import { UiLanguageProvider } from '@/components/radar/ui-language';
export const metadata: Metadata = {
  title: 'Paper Radar · 每日论文',
  description:
    '你的论文研究工作台。按主题、作者与 Persona 标签发现值得关注的研究。前端演示，使用模拟数据。',
  icons: { icon: '/favicon.svg' },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <UiLanguageProvider>{children}</UiLanguageProvider>
      </body>
    </html>
  );
}
