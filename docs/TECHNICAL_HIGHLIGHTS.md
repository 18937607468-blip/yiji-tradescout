# 四项技术亮点：源码、调用链与复核

本表对应基于线上 v23 的 GitHub 发布修复版。**121 项本地测试通过；B1X/Tavily 实机鉴权未验证。** 运行 `npm test`，或按下表运行单个测试文件。所有 HTTP 测试都明确 mock；D1 SQL 使用 Node SQLite 内存适配执行真实迁移和业务持久化逻辑。

| 重点 | 真实调用链 | 对应测试 | 失败与边界 |
| --- | --- | --- | --- |
| A：官网取证 | `app/api/platform/research/route.ts` → `researchCompany` (`lib/platform/research.mjs`) → `fetchPublicPage` / `pageEvidence` (`web.mjs`) → `mutatePlatform` (`store.mjs`) | `scripts/platform-cloud.test.mjs`、`scripts/publication-acceptance.test.mjs` | URL、片段、抓取时间、内容 hash；主页失败返回明确错误，保留旧证据；模型缺配置仍保留本次已取得原文 |
| A：模型有据整理 | `modelResearch` → `getModelConnection` (`model-config.mjs`) → `executeModelCall` (`model-usage.mjs`) → `validateResearch` → `assessProductMatch` / `researchGradeFor` (`screening.mjs`) | `scripts/precision-screening.test.mjs`、`scripts/model-usage.test.mjs`、新增验收 A | Zod schema、原句存在、来源 ID、WVA/OE 编号空间、同句品类/用途、企业自身角色；下单/成交断言及无原文邮箱/金额拒绝。规则不是通用语义蕴含证明 |
| A：展示分层 | `components/platform/CompanyDrawer.tsx` → 原文证据、研究整理、跟进安排；模型事实保存 `model_summary_pending_review` | 新增 A–D 集成测试；本次实际浏览器查看原文与差异 | 来源自述、模型待核对摘要、业务员确认区分；建议不自动覆盖跟进，也不等于人工事实核准 |
| B：产品/HS/市场查询 | `components/platform/BuyerDiscovery.tsx` → `app/api/platform/buyer-discovery/route.ts` → `planBuyerDiscovery` / `discoveryQueries` (`buyer-discovery.mjs`) → `assessCompanyHs` (`customs-catalog.mjs`) | `scripts/buyer-discovery.test.mjs` | 预览查询后人工确认；HS 6/8/10 位、歧义品类确认；搜索词不包含聊天、财报或私有联系人 |
| B：发现、核验、保存 | `searchMoreBuyers` → `searchPublicCandidates` → `inspectBuyerCandidate` → `saveBuyerCandidate` | `scripts/buyer-discovery.test.mjs`、新增 B 与 A–D 集成测试 | Tavily 独立 Key；401/403 鉴权、429、超时、网络、空列表分开；域名去重、引用 hash、官网归属人工确认；不自动升为合格买家 |
| B：隔离与备用入口 | `store.mjs` 按 owner 保存；输入 hash 区分市场/品类；`company-website.mjs` → `inspectCompanyWebsiteUrl` | `scripts/company-website.test.mjs`、`scripts/search-config.test.mjs`、新增 B | 无 Key 零外呼；历史缓存保留其原始配置来源，不重标为当前 Key 验证；UI 条件改变后旧结果不可作为新结果保存；手工网址不冒充搜索成功 |
| C：记忆差异 | `CommunicationChanges.tsx` → `TradeScoutPlatform.tsx` 的服务端 mutation → `app/api/platform/action/route.ts` → `domain.mjs` 中 `add_communication` / `propose_memory` | 新增 C、`scripts/platform-cloud.test.mjs` | 沟通原话/发生时间/记录时间分别留存；一般资料由人工提出，非模型自动“学习”；propose 只保存 before/after，未应用 |
| C：确认/取消/冲突 | `domain.mjs` 中 `apply_memory` / `cancel_memory` → `store.mjs` 的 CAS 写入 | 新增 C 两项；实际浏览器执行取消并刷新 | 取消仅变更提议状态和审计，不改客户业务字段；取消后不可应用；重复消息/应用幂等；字段时序与 before-value 冲突可见；`memoryByInquiry` 隔离询盘 |
| D：业务闭环 | `CompanyForms.tsx` / `CompanyDrawer.tsx` → `domain.mjs` 的客户/任务操作 → `store.mjs`；询价 `InquiryWorkspace.tsx` → `inquiries.mjs` | 新增 D、A–D 集成、`scripts/fitment-inquiries.test.mjs` | 名称+市场及官网去重、服务端 revision、保存回读、负责人/日期/下一步；数量变化生成需求确认任务，未写成交 |
| D：材料参考 | `MaterialCostCalculator.tsx` → `inquiries.mjs` 的 `save_material_calculation` → `material-cost.mjs` | `scripts/material-cost.test.mjs`、`scripts/fitment-inquiries.test.mjs` | mm/cm/m/in、kg/g/吨/lb 等换算，服务端重算；询价条件变动旧参考 stale；不是全成本或正式销售报价 |

## 可重复验证

```bash
node --test scripts/publication-acceptance.test.mjs
node --test scripts/precision-screening.test.mjs scripts/buyer-discovery.test.mjs scripts/company-website.test.mjs scripts/search-config.test.mjs
node --test scripts/platform-cloud.test.mjs scripts/model-usage.test.mjs scripts/fitment-inquiries.test.mjs scripts/material-cost.test.mjs
```

新增 7 项验收：A 反例拒绝；B 未配置零外呼与手工官网；B 按用户/国家/品类缓存隔离；C 提议/取消；C 幂等/旧消息/冲突/询盘隔离；D 50→200 非成交与跟进回读；A–D 完整业务调用链。

## B1X 调用事实

唯一固定业务提供方配置为 `lib/platform/model-config.mjs` 的 `BASE_URL` 与 `MODEL`；实际调用在 `lib/platform/model-usage.mjs` 的 `client.chat.completions.create()`。不使用 Responses API、不切换科研模型 Key、不使用 Codex 额度。密钥按账号 AES-GCM 加密保存在服务端 `model_config`；加密主密钥为运行时 `APP_DATA_KEY`。源码仓库不含任何真实配置或 D1 数据。

## 已知限制

规则与引用校验降低显见幻觉，不能证明网页所述真实、译文完全忠实或买家实际采购。通用记忆中的 `inquiryId` 是调用者提供的逻辑隔离键，真实询价操作另由 `inquiries.mjs` 校验客户归属。大规模生产运行还需容量、运维和部署身份边界评估；不在比赛验收中虚称已经完成。
