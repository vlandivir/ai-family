import "./style.css";

export const metadata = { title: "AI Family · Задачи", robots: { index: false, follow: false } };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
