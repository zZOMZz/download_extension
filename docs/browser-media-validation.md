# 浏览器媒体来源：验证方法与案例

页面能播放、出现下载进度和生成非空文件，分别只是链路的一部分。验收需要检查
来源身份、完整计划、恢复边界、任务状态和实际媒体文件，并区分自动化样本与真实
账户结果。使用方法与架构见[浏览器内媒体处理与下载](browser-media-sources.md)。

## 可重复的自动化验证

```bash
pnpm typecheck
pnpm typecheck:runtime
pnpm test:run
pnpm build:runtime
pnpm check:runtime
pnpm exec playwright install chromium --no-shell
pnpm test:e2e
```

页面辅助 E2E 需要 `ffmpeg`、`ffprobe` 在 PATH 中。测试使用自行生成并加密的
H.264/AAC 媒体和官方固定版本 Aliplayer HLS2 模块：

- 版本：2.37.0。
- 来源：`https://g.alicdn.com/apsara-media-box/imp-web-player/2.37.0/hls/aliplayer-hls2-min.js`。
- SHA-256：`5de2506269a03c0a418f431021d774857a8698a9703e7597aa84c515ded16e36`。

测试首次从官方 CDN 获取 SDK 并缓存于操作系统临时目录，也可设置
`ALIPLAYER_TEST_SDK=/path/to/aliplayer-hls2-min.js` 使用相同哈希的本地副本。
`PLAYWRIGHT_BROWSERS_PATH` 可指定独立浏览器缓存，安装与执行需使用相同值。
SDK 不随仓库提交；测试页面、账户状态与媒体响应均为受控样本。

| 层级 | 验证内容 | 代码入口 |
| --- | --- | --- |
| 站点隔离 | 精确 URL、列表去重、丢弃导航前的旧视频状态 | `tests/koala-adapters.test.ts` |
| 执行与恢复 | 两轨提交后保存检查点、从已提交位置继续、过期刷新、计划变化与缺片拒绝 | `tests/browser-source-runtime.test.ts` |
| 未播放来源 | 检测无副作用；按需初始化、保留暂停状态；初始化超时有明确原因 | `tests/browser-source-preparation.test.ts`、`tests/browser-source-provider.test.ts` |
| 消息边界 | 扩展 sender 校验；拒绝绕过后台、伪造所有者的调用 | `tests/runtime-access.test.ts`、构建后 E2E |
| 请求规则 | 大标签页 ID、并发编号分配、按标签页清理且保留其他规则 | `tests/request-adapter-registry.test.ts` |
| 真实浏览器链路 | popup → 队列 → SDK → 文件 → 校验；来源页关闭后恢复；首页双任务 | `tests/e2e/koala.spec.ts` |
| 兼容性 | 原 HLS 单项/队列恢复、Progressive 集合下载、独立 Node runtime | 其余 E2E 与 runtime 检查 |

页面辅助 E2E 同时覆盖原播放器在主线程和 Worker 初始化两种情况，校验实际 MP4，
单视频产物还会严格解码。目录选择使用真实 OPFS 句柄替代系统文件对话框，所以不能把这些测试
写成原生对话框、真实账户、真实浏览器崩溃或断电已通过。

清理后的自动化验收保留正式下载、未播放页面初始化、恢复与诊断的回归覆盖；
扩展/runtime 类型检查、构建及 runtime 独立性检查与上述测试一起运行。
2026-09-30 最终回归：501 项测试、8 条构建后 E2E 和上述检查全部通过。

## 真实网站案例：Koala / Aliplayer

验证日期：2026-09-29。目标为
[一部约 33 分钟的视频](https://app.koala-oss.club/videos/a38d4ed3-873b-4110-bf51-02f3a6319f2c)。
用户在已经登录的浏览器中操作扩展，媒体验证在本机完成。

| 阶段 | 得到的证据 | 能说明什么 |
| --- | --- | --- |
| 随播放采集 | MSE 输入中取得连续 40 秒，可独立解码；其他区间存在缺口 | 输出字节可用，但缓存不等于整片 |
| 暂停后的主动处理 | 原播放器暂停，主动请求未缓冲的 4 个分片，共 40 秒；请求和处理耗时 1,849.4 ms | 可以独立于播放进度按清单处理 |
| 接入原插件 | 原下载入口和队列生成 33 分 14 秒完整 MP4，严格解码和时间线检查通过 | 当前案例的完整下载链路可用 |

主动处理实验选取约 220～260 秒区间，原播放进度和缓冲区均未变化。独立实例没有
连接 `<video>` 或 MSE。处理前的 CDN 分片不能直接解码，SDK 输出与合并文件可以；
合并前后 1,200 个视频包、1,722 个音频包逐包哈希相同，没有重新编码。这与公开前端
的 `vid + playauth + encryptType: 1` 配置共同支持对处理链路的判断，不是仅凭一个
解码错误推断加密类型。短片段耗时不包含导出与离线验收，不能当作整片下载速度。

完整视频结果：

| 指标 | 实测 |
| --- | --- |
| 文件大小 | 218,209,621 字节，约 218.2 MB |
| 容器时长 | 1,994.217710 秒，约 33 分 14 秒 |
| 视频 | H.264，1920 × 1080，30 fps，59,825 个视频包 |
| 音频 | AAC，44.1 kHz，双声道，85,884 个音频包 |
| 两轨时长差 | 约 51 ms |
| 相邻 DTS | 两轨均无超过 1 ms 的缺口/重叠，无时间倒退 |
| 严格全片解码 | 退出码 0，无错误输出 |
| 画面与声音抽查 | 第 10、997、1,980 秒画面正常；平均音量 -17.8 dB，峰值 -0.8 dB |
| 临时文件 | 下载中持续写入，完成后相应 partial 与 crswap 已清理 |

成品 SHA-256：`89a478eb5e492bcafe63e6e2cca605edd965e396c758f86371c39efed4deaeec`。

本地证据位于 `test-results/koala-full-real/validation.json` 和同目录三张抽帧；主动
实验位于 `test-results/koala-active-probe/real-site-v0.0.5/`。这些目录被 Git 忽略，
不随仓库分发，重新克隆后不会存在。文档保留脱敏结果，不提交用户下载的视频、
账户数据或播放凭证。

本次未人工听看全片，未单独导出真实任务状态仓库，也没有测量整片下载起止耗时。
真实账户的主页批量尚未验收；批量与来源页恢复的证据来自自动化测试。

### 未播放页面的初始化回归

2026-09-30 收到另一视频的失败报告：解析来源后约 40 秒进入 `waiting-source`，
没有 `manifest-loaded` 或检查点。用户确认打开页面后没有点击播放。这说明失败
发生在准备来源阶段，不能据此判断媒体解密失败。最初的 E2E 直接加载 HLS，遗漏了
SDK 延迟初始化和禁用预加载的页面状态。

新增回归使用同一官方 SDK 和加密样本，分别让 HLS 不加载来源、让播放器延迟创建
HLS 实例，再通过原插件单视频入口和批量队列启动。已验证输出 MP4，原媒体元素
保持暂停、进度为零且没有 `play` 事件。

2026-09-30，用户确认后续问题场景的完整视频下载已验证，本轮验收目标为
[另一部视频](https://app.koala-oss.club/videos/b0cc16c2-8a69-4f0d-99cf-ef0c4c9c95d9)。
该结果记录为用户验收，未另行记录本机解码或逐包统计。随后移除了临时分片验证
入口和独立实验探针；正式初始化、错误历史与构建后 E2E 回归继续保留。

## 新来源的验收清单

1. 核对来源身份和账户可用范围；固定清晰度、codec 与完整清单。
2. 验证处理前后媒体，并在暂停原播放器时请求未缓冲区间，区分主动处理与被动采集。
3. 通过正式下载入口生成全片；记录完成状态、输出文件和脱敏诊断，核对分片总数。
4. 检查音视频轨道、时长和逐包时间线；缺片不能通过压平时间戳掩盖。
5. 严格全片解码，抽查首、中、尾画面和音频；保留报告、哈希与已知限制。
6. 注入断网、来源页关闭、签名过期、计划变化和取消，确认只从有效检查点恢复，
   不混用内容、不提前成功、不清理其他任务的文件。

独立检查成品可使用：

```bash
ffprobe -v error -show_format -show_streams -of json "output.mp4"
ffmpeg -hide_banner -loglevel error -xerror -err_detect explode \
  -protocol_whitelist file -i "output.mp4" -f null -
ffprobe -v error -show_packets \
  -show_entries packet=stream_index,pts_time,dts_time,duration_time \
  -of json "output.mp4" > packets.json
```

逐轨比较 `下一包 DTS - 当前包 DTS - 当前包 duration`，保留时间舍入容差，同时
检查 PTS、轨道起止与清单时长。严格解码通过并不单独证明来源完整或人工听感同步。
来源准备失败时，从正式任务详情导出诊断报告；重试后仍可查看已保存的历史失败快照。
