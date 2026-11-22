# 本次发布验收

日期：2026-11-22，北京时间。基线 v23 / `78eca887d3c8b41b3cb24e0d9ad70f103e47ee11`。

| 检查 | 实际结果 |
| --- | --- |
| 锁定依赖安装 | `npm ci --no-audit --no-fund` 成功；未改依赖版本，仅改包名与命令 |
| TypeScript | `npm run typecheck` 通过 |
| 自动化测试 | `npm test`：121 项通过、0 失败（原有 114 + 新增 7） |
| 生产构建 | `npm run build` 成功；19 条页面/API 路由保留；框架提示根路由静态分类未知，不是构建失败 |
| 本地迁移 | `npm run db:migrate:local` 成功执行两个迁移，仅本地 D1 |
| 密钥扫描 | 自带规则扫描检查待发布文件和原有 Git 历史；235 个待发布文件及原历史 355 个 blob，最终提交前检查 0 命中 |
| 浏览器 | 实际页面加载、本地合成客户保存、沟通原文保存、记忆 diff、取消及刷新后保留原资料已实测；截图来自实际运行 UI |
| B1X | SDK/端点/模型/用量与异常 mock 测试通过；真实 Key 未提供，本次未实机联调 |
| Tavily | 独立 Key、隔离、失败分类、空结果与人工路径 mock 通过；本次未实机联调 |
| GitHub 发布 | 已发布公开仓库 https://github.com/18937607468-blip/yiji-tradescout ，235 个文件与本地发布树哈希完全一致 |
| GitHub Actions | 首轮远端 CI 全部通过；依赖安装、历史密钥扫描、TypeScript、121 项测试、生产构建、本地 D1 迁移均成功 |

自动化业务集成测试执行真实业务函数及 SQLite 迁移，只有外部 HTTP 响应是明确 mock。浏览器操作使用新的本地访客空间和合成资料；没有变更线上业务数据。继承文档里的历史真实服务结果不是本轮成功证据。

产品图片隐私清理：删除 JPEG 的 EXIF、XMP、Photoshop 元数据与注释，保留色彩配置。清理前后 RGB 像素 SHA-256 一致，未重绘产品图；公开仓库只上传清理后文件。

远端成功证据：提交 `aff99cffdadb07c4345a6833916d3fe759a61a01`，运行 [Verify TradeScout #1](https://github.com/18937607468-blip/yiji-tradescout/actions/runs/44978543222)，job `verify` conclusion 为 `success`。该结果针对该提交，后续文档修订与最新状态以 Actions 页面为准。公开仓库通过已授权 GitHub API 发布当前完整文件树，提交父级为用户创建的 Initial commit；原 Sites 历史未移植到 GitHub，其基线 SHA 与差异在来源文档中保留。
