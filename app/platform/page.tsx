import type { Metadata } from "next";
import TradeScoutPlatform from "@/components/platform/TradeScoutPlatform";
import { chatGPTSignInPath, chatGPTSignOutPath } from "../chatgpt-auth";
import "./platform.css";
import "./waterlily.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "投石问路 · 冠英 TradeScout 外贸工作台",
  description: "面向商用车制动件外贸的获客与询价跟进工作台。让每条线索，都有下一步。",
};

export default function PlatformPage() {
  return <TradeScoutPlatform signInHref={chatGPTSignInPath("/platform")} signOutHref={chatGPTSignOutPath("/platform")} />;
}
