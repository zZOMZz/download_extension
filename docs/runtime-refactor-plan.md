# 下载 Runtime 重构计划

状态：M1–M5 已完成；已变基到 main `9ef39e5`，Bilibili Progressive 兼容、完整回归、构建及扩展 E2E 验收通过。通过 PR 交付，main 主工作区继续独立开发。

## 工作区与范围

- 初始基线：`main` 的 `4853a62`；本轮集成基线更新为已提交的 `main` / `origin/main` `9ef39e5`。
- 分支：`codex/download-runtime`。
- 独立 worktree：`/Users/zzt/.codex/worktrees/download-runtime/download_extension`。
- 当前主工作区 `/Users/zzt/code/download_extension` 继续留给其他需求；本次所有源码、依赖、构建与测试只在新 worktree 中操作。
- 本轮用户已授权将本分支变基到最新 main，验证通过后创建 PR；不直接合并、改写主分支或部署。所有集成仍只在独立 worktree 中完成。
- 本次完成可嵌入 runtime、扩展接入及最小 Node 宿主验证。Web、Electron、云端可以接入相同接口；完整新产品界面、部署服务和分布式调度不包含在本次重构中。
- 保留现有 HLS/DASH/Progressive/SABR 能力与站点会话边界，不承诺把浏览器登录态、短时 URL 或 partial 文件无条件迁移到另一宿主。

## 已确认的问题

1. manager React 页面拥有调度、状态转换、退避恢复、诊断和输出提交；多个管理页没有执行所有权。
2. 页面初始化会把其他页面可能仍在执行的任务判成中断；任务保存缺少执行者校验。
3. 输出先删除 partial 再持久化 completed，存在崩溃恢复窗口；重启/删除任务仅核对目录名。
4. 单项下载与批量下载分别编排，成功/取消/校验语义不同。
5. core 内网络请求固定使用全局 fetch 与浏览器凭据；执行器依赖目录句柄、Translator 和浏览器 Worker。
6. 发现/播放会话是浏览器能力，需与下载核心分开；当前 runtime-client 实际是扩展消息客户端。

## 目标边界

```text
UI / API client -- commands + snapshots/events --> Download Runtime
Browser capture -- structured source material --> Source adapter
Download Runtime --> protocol/media engine + source resolver
Runtime / engine --> Transport / TaskStore / ArtifactStore / TransformBackend
Host implements ports: Extension / Web / Node-Electron / Cloud
```

- Runtime 拥有任务状态机、调度、重试、取消、恢复、执行权和提交顺序；UI 负责用户输入、目录授权和呈现。
- 纯媒体算法保留标准 Uint8Array、URL、AbortSignal 等，不为抽象而包装所有语言能力。
- 网络策略与请求实现分离；宿主提供 fetch-compatible transport 和会话上下文。
- 输出通过稳定身份与随机读写接口访问；明确写入、提交、校验、清理的不同阶段。
- 数据持久化与 UI 文案分离；runtime 使用稳定错误码及结构化事件。
- 当前先保证单宿主唯一执行者；真正增加分布式 worker 时再实现跨主机租约及 fencing。
- 浏览器采集器仍负责 DOM、webRequest、DNR、播放器上下文。云端或 Node 不自动取得这些权限。

## 实施里程碑与验收

### M1：网络与媒体边界

- 抽出宿主可注入的网络 transport，覆盖文本、分片、密钥、Progressive 和 SABR 请求。
- 保留现有重试、timeout、exact range、来源刷新及 host health 行为。
- 分离浏览器采集入口与 headless 可导入的媒体执行能力。
- 验收：所有原协议测试通过；自定义 transport 可以覆盖所有实际出网请求；headless 入口不导入 WXT、React 或 DOM 采集模块。

### M2：输出与协议执行器

- 把协议执行器从 browser 迁入 runtime，通过输出存储与封装 backend 注入宿主能力。
- 浏览器文件系统、文件授权与 Web Worker 保留为宿主实现。
- 核对输出身份，保留 checkpoint 版本 1/2 的读取兼容性。
- 验收：HLS/DASH 恢复、双轨合并、Progressive 整文件重试、过期 URL 刷新与最终校验通过；Node 可提供同一输出接口。

### M3：任务 Runtime 与扩展接入

- 抽离 manager 调度/执行/恢复循环，使 UI 订阅 runtime 状态并发送命令。
- 使用单宿主执行锁保护活跃任务；打开第二个管理页不重置活跃任务，不重复执行。
- 输出提交可恢复：成品验证与 completed 持久化先于 partial 清理；清理可重复执行。
- restart/remove 使用同一目录身份检查规则。
- 单项下载复用 runtime 执行入口，保留文件选择必须由用户手势触发的行为。
- 验收：多客户端执行竞争、恢复、取消、等待重试、输出提交故障边界有针对性测试；原 UI 与协议行为通过检查。

### M4：Node 宿主与跨平台证明

- 增加最小 Node 文件/网络/封装适配及 headless 运行入口，用于本地授权媒体或测试 fixture。
- 使用本地 HTTP fixture 验证同一 runtime 的解析、下载、成品校验与任务恢复，不依赖真实站点账号。
- 明确宿主能力：浏览器会话来源需要相应 provider；不支持的能力返回可诊断错误。
- 验收：无 React/WXT/DOM 的 Node 流程产出有效文件；同一协议测试/契约同时验证浏览器和 Node 适配。

### M5：回归、文档与交付

- 完成 `pnpm typecheck`、完整测试、扩展生产构建、Node smoke/integration 验证。
- 更新 README 与 runtime 架构/接口说明，记录平台限制、恢复保证和未验证事项。
- 检查依赖边界、主工作区是否被改变、worktree Git 状态与最终差异。
- 仅交付本分支，不自动影响 main 的并发需求。

## 持久化与恢复不变量

- 同一任务只有一个有效执行者；界面挂载不等于允许接管。
- 任务 checkpoint 不证明字节已经 durable；恢复必须与实际输出长度和资源指纹对账。
- 完成包含输出关闭及校验；浏览器仅返回 download ID 不等同于文件已完成。
- completed 成功保存前保留恢复所需 partial；completed 之后的清理允许重试。
- 输出目标身份使用 handle ID / artifact identity，显示名称仅用于展示及旧版兼容。
- 凭据/播放授权上下文不进入普通持久化任务或诊断导出。

## 风险与验证边界

- 浏览器真实崩溃、目录权限丢失、MV3 生命周期无法由内存 mock 证明；单列真实浏览器验收结果，未验证则明确标记。
- 扩展 runtime 与页面同寿命时，关闭页面会中断执行；可恢复不等于永不停止。独立后台宿主后续可承载同一 runtime。
- 纯 Web 受 CORS 与文件 API 限制；Node/Electron/云端不继承外部 Chrome 的会话。
- 云对象存储通常需要先写可 seek 的临时文件再发布成品。
- 迁移时保留现有任务/checkpoint 可读性，不静默丢弃用户队列。

## 执行记录

- 2026-09-27：创建隔离 worktree 和重构分支；先写入本计划。主工作区起始状态为干净的 main。
- 起始质量基线：前一轮 review 已通过 TypeScript 检查及 46 个测试文件 / 305 项测试；重构完成后重新验证。

### 实现进展

- M1 完成：Transport 覆盖 HLS 文本/分片/密钥、DASH SIDX/轨道、Progressive、SABR；全局 fetch 失败哨兵验证无漏出网路径。
- M2 完成：HLS/DASH/Progressive executor 迁入 runtime；ArtifactStore / TransformBackend / RandomAccessMedia 隔离文件、封装与范围读能力；保留旧浏览器兼容入口及 checkpoint v1/v2。
- M3 完成：manager 的入队、执行、重试、重启、删除与清理都走 runtime；扩展 Web Locks 保证同源执行排他。outputCommit 覆盖提交、响应丢失、完成后清理重试；冲突 checkpoint 在保存前校验所有权，删除前检查共享引用。单项四协议通过独立的 executeDirectDownload runtime 入口共享完成语义，明确其一次性文件目标不支持持久续传。
- M4 完成：Node Host 与 CLI、独立 tsconfig、公共 runtime 入口及 JS/类型构建产物；本地 HTTP、真实文件与跨进程集成测试证明 headless 执行、续传与锁释放。
- 重构过程中发现并修复的边界：失败 worker 必须排空后释放执行锁；completed 写入后响应丢失不能反写 failed；目录命名空间不互相占用文件；冲突任务不能保存并清理他人的 partial；损坏队列与超过 1000 项的浏览器队列不会静默丢数据。
- 初次重构期间主工作区存在其他需求的并行修改，本次没有覆盖、暂存、提交、变基或重置主工作区；本轮只集成随后已提交到 main 的代码。
- 本轮 main 兼容：保留 Bilibili 番剧完整单文件 MP4 的 Progressive 队列执行；入队已知 Progressive/DASH 固定 MP4，解析后保存真实 mediaKind，原先未知或标为 DASH 的来源落到 Progressive 时也修正 outputFormat。过期整文件 URL 由队列重新解析后从头下载，不套用 HLS/DASH checkpoint。

### 明确保留的后续工作

- Web/Electron/云端完整应用、IPC/HTTP 远程客户端、部署与多机执行租约尚未实现；当前交付可嵌入 runtime 与两种宿主。
- 当前持久队列执行器为 HLS/DASH/Progressive；SABR 通过单项 runtime API 提供。Progressive 可持久化任务与重试，但没有字节断点续传；失败后重新解析来源并整文件重写，不能承接 HLS/DASH checkpoint。
- 浏览器单项内存 fallback 仍将整个文件缓存在内存；大文件应使用文件系统支持的流式目标。
- 同一队列执行会拒绝不同任务争用相同成品或 partial 名称，且保护其他任务的 checkpoint 引用。历史上已存在且不再被任务元数据引用的同名文件仍遵循宿主原有覆盖语义；跨宿主迁移不自动搬运文件。
- 未运行真实站点账号、浏览器目录权限交互或浏览器进程崩溃的端到端验证；没有把内存 mock/本地 HTTP 验证当作这些场景的证据。

### 初版验收（2026-09-27，变基前）

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm typecheck:runtime` | 通过；独立于 WXT 生成配置 |
| `pnpm test:run` | 54 个测试文件、385 项测试全部通过 |
| `pnpm build` | Chromium MV3 生产构建通过 |
| `pnpm build:runtime` | portable / Node JS 及类型声明产物构建通过 |
| `pnpm check:runtime` | `RUNTIME_BUILD_VERIFIED`；46 个实际构建模块的依赖边界检查通过 |
| 普通 Node 子进程使用已编译库 | 真实本地 HTTP HLS 下载成 157701 字节 MP4；音视频各 1 轨，时长约 8.93 秒，非 fragmented |
| `git diff --check` | 通过 |
| 工作区隔离 | `main` 与 `codex/download-runtime` 为不同 worktree；main 的并行修改未被本次写入或集成 |

上述表格记录变基前的初版结果，不作为本轮 main 集成后的验证结论。本轮在独立 worktree 中解决 manager/downloader、Progressive 引擎、站点适配器与 shared schema 的兼容问题，并重新执行回归与扩展 E2E；验证通过后创建 PR，不直接合并 main 或部署。


### 本轮集成验收（2026-09-27，变基后）

- 从 `origin/main` 的 `9ef39e5` 线性 rebase；保留 Bilibili 番剧来源身份、预览/DRM 限制、Progressive 超时与 host 并发协调。main 仍为本分支祖先，无 merge commit。
- 复审修复两处输出故障：无效成品重试可复用保留的 checkpoint；Node fresh staging 提交失败时清理暂存，保留原成品/续传 partial 和原始错误。

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm typecheck:runtime` | 均通过 |
| `pnpm test:run` | 61 个测试文件、468 项测试全部通过 |
| `pnpm build` | Chromium MV3 最终生产构建通过 |
| `pnpm build:runtime` / `pnpm check:runtime` | 均通过；47 个实际模块通过边界检查，普通 Node 子进程下载并校验 157701 字节 MP4，音视频各 1 轨 |
| `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/download-runtime-playwright pnpm exec playwright test` | 最终生产构建的 3 条浏览器 E2E 全部通过 |
| E2E 环境 | Node 24.14.1 / Playwright 1.63.0 / Chromium 153.0.8010.12，独立临时浏览器 profile |
| `git diff --check` | 通过 |
| 工作区隔离 | 所有修改、依赖安装与测试均在 runtime worktree；main 主工作区保持干净 |

E2E 从扩展 UI 操作并读取实际产物：

1. 本地 HLS 被 content/background 发现，经 popup 打开下载页，执行 Worker 封装，保存并校验 MP4 音视频轨道。
2. 从站点 fixture 扫描并加入两个任务，第二个 manager 争锁失败且不重置活跃任务；停止后保留分片，在新 manager 恢复，仅补缺失分片，校验两个输出及 partial 清理。
3. Bilibili 番剧页面/API fixture 经真实 discovery/resolver 进入 Progressive 队列执行器，完成 MP4 并校验轨道。

唯一文件选择接缝用真实 OPFS handle 代替原生 OS 对话框，真实 Chromium storage、IndexedDB、文件流、Web Locks 和扩展 Worker 仍参与执行。站点页面/API 使用受控 fixture，媒体走本地 HTTP；未验证真实账号、原生文件权限对话框或浏览器进程崩溃。trace、截图和诊断保存在忽略的 `test-results/e2e/`，HTML 报告在 `playwright-report/e2e/`；临时浏览器 profile 在退出时清理。复现命令见 README。
