import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "投石问路 · 冠英 TradeScout 外贸工作台",
  description: "为冠英商用车制动件发现海外候选买家、核验官网证据，并衔接客户分级、询价与跟进。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
