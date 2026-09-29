# 下载 Runtime 与宿主边界

下载的任务所有权、协议执行与成品提交由 `DownloadRuntime` 负责；扩展和最小 Node 宿主复用同一套 TypeScript runtime，React 页面负责发送命令和展示快照。

## 一次下载由谁负责

```text
扩展 UI / Node CLI / 未来 Web 或 Electron UI
                    |
             command / snapshot
                    v
             DownloadRuntime
          /        |         \
  Source resolver  |     TaskStore + ExecutionLocks
                   v
      HLS / DASH / Progressive executor
          /        |         \
     Transport  ArtifactStore  TransformBackend
          \        |         /
             Extension / Node host
```

- **浏览器采集器**仍在 content script、MAIN world 播放器 bridge 和 background 中。它观察页面 DOM、网络资源、播放器响应及受授权的短时播放上下文。
- **Source resolver**把结构化来源解析成 HLS/DASH 地址、嵌入的轨道元数据或 Progressive 完整 MP4 地址。它可以使用 runtime 提供的 `fetchText`，不能假设存在浏览器标签页或登录态。
- **MediaSourceProvider**是宿主可选能力，在页面辅助执行方式下提供会话、分片计划和处理后的媒体块；普通 HTTP 执行器不依赖它。
- **DownloadRuntime**拥有任务状态转换、任务并发、请求健康状态、等待重试、取消、恢复、成品校验与清理顺序。打开 UI、读取快照都不会接管任务。
- **协议与媒体内核**负责 manifest、分片、解密、轨道选择、续传指纹、MP4 封装与校验。
- **宿主**实现网络、文件、持久化、执行锁和计算后端。扩展的文件授权、Web Worker、DNR 规则属于宿主；Node 的路径、文件描述符和本地执行锁也属于宿主。

浏览器请求头规则在后台串行配置：从现有 session rules 中识别当前标签页的规则，
分配未占用的有效整数 ID，再原子替换。规则 ID 不由标签页 ID 加偏移生成，避免
大标签页 ID 溢出；后台重启后仍可从规则条件恢复归属，关闭标签页只清理其自身规则。

代码入口：

| 入口 | 职责 |
|---|---|
| `src/runtime/download-runtime.ts` | `DownloadRuntime`、任务仓库/执行锁契约、快照 |
| `src/runtime/task-executors/` | 共用 HLS/DASH/Progressive 任务执行器 |
| `src/runtime/artifact-store.ts` | 输出命名空间、范围读取、可恢复随机写入 |
| `src/runtime/transform-backend.ts` | 宿主封装后端接口 |
| `src/runtime/media-source.ts` | 可选媒体来源 provider 与临时会话契约 |
| `src/runtime/media/` | 不依赖 DOM/Worker 的双轨 MP4 与 TS 封装编排 |
| `src/core/network/transport.ts` | 注入的 fetch-compatible 网络实现 |
| `src/browser/download-runtime.ts` | 扩展任务仓库、锁、来源解析与会话设置的组装 |
| `src/browser/runtime-adapters.ts` | 浏览器目录/Worker 的宿主实现 |
| `src/hosts/node/index.ts` | 最小 Node 宿主组装 |
| `scripts/runtime-cli.ts` | 直接 HLS/DASH URL 的 headless CLI |

旧 `src/browser/task-executors/` 保留适配入口以兼容现有调用和测试，协议实现只有 runtime 中的一份。TS→MP4 的 writer 算法由浏览器 Web Worker 和 Node mux.js 后端共同复用。

## Runtime API

```ts
const runtime = new DownloadRuntime({
  store,          // list / save / remove
  artifacts,      // id / name / stat / read / open / remove
  transforms,     // createHlsWriter / createDashWriter
  locks,          // runExclusive(operation)
  transport,      // fetch(input, init)
  mediaSourceProvider, // 可选；需要页面处理时由宿主提供
  resolve,        // resolve(source, { fetchText, signal })
  networkSettings,
  concurrency: 2,
});

const unsubscribe = runtime.subscribe((snapshot) => render(snapshot));
await runtime.refresh(); // 仅读取，不改写遗留任务
await runtime.enqueue(discoveredItems, 'mp4'); // source.id 去重，新增 queued 任务
await runtime.start();   // 取得执行权，然后恢复并运行队列
runtime.cancel();        // 中止当前运行；等待 start() 返回后执行权才释放
await runtime.retry(taskId);
await runtime.restart(taskId);
await runtime.remove(taskId);
await runtime.clearCompleted(); // 清理完成记录；不删除用户成品
unsubscribe();
```

`enqueue` 按 `source.id` 去重，已知的 DASH/Progressive 自动选择 MP4。来源解析完成后，runtime 会先持久化真实 `source.mediaKind` 再执行；最初协议未知或标为 DASH 的来源实际返回 Progressive 时，同步把 `outputFormat` 修正为 MP4，诊断事件也记录 Progressive。扩展仓库队列超过 1000 项时明确拒绝新增，保留原队列；损坏的持久化状态也会报错，不能静默当成空队列。`clearCompleted` 只移除完成任务记录；如果还有提交清理记录，先尝试清理，失败则保留任务供下次恢复，不删除最终成品。

`start()` 处理取得执行权时队列中的 queued/waiting 任务。`enqueue`、重试、删除和清空完成记录也使用同一执行锁；运行期间其他客户端的写命令会返回 `runtimeBusy`，调用方需在本轮结束后重试。第二个管理页/CLI 不会把第一位执行者的任务标记为中断。UI 订阅失败不影响任务执行。

当前通用持久队列提供 HLS/DASH/Progressive 执行器。SABR 仍走一次性单项入口并保留宿主播放会话边界；Node CLI 明确只接受直接 HLS/DASH manifest，不宣称支持任意站点页面或 YouTube 播放会话。

### 页面辅助来源

来源解析可附带 `browserSource` 描述；协议仍是 HLS，执行方式为 `browser-session`。
宿主通过可选 `MediaSourceProvider` 提供临时会话、完整分片计划和有界数据读取。
它与 `Transport` 分开，因为页面 SDK 同时涉及授权、媒体处理和会话生命周期。
默认 HTTP 执行器及旧检查点保持兼容。

runtime 新增 `waiting-source` 状态：来源页面不可用时释放任务池位置并保留
检查点，等待显式重连；这类任务不进入网络退避循环。页面辅助下载的版本 3
检查点在音视频文件关闭提交后保存，完成前校验计划完整性和输出时长。
执行器按媒体协议和执行方式共同选择。具体使用、云端/本地分工及站点接入示例见
[浏览器媒体来源](browser-media-sources.md)，验收方法见[验证与案例](browser-media-validation.md)。

Bilibili 番剧解析沿用 main 的来源校验：同一 episode/cid、完整播放权限、无 DRM，且 `durl` 仅有一个可识别为 MP4 的资源时，才可作为 Progressive 完整文件执行。多文件 durl、FLV、预览内容不会被当成完整 MP4。Progressive 下载保留流式写入、最终媒体校验与任务恢复；401/403、暂时网络失败或超时进入队列重试，重新解析来源取得新 URL 后重新写完整文件，不携带 Range 或分片 checkpoint。文件写入失败不伪装成网络故障。

## 公共入口与独立构建

```sh
pnpm build:runtime
pnpm exec tsx --tsconfig tsconfig.runtime.json scripts/check-runtime-build.ts
```

构建产物在 `.output/runtime/`，包含 ESM JavaScript、TypeScript 声明和独立 `package.json`：

- `@open-media-downloader/runtime`：公共 runtime、契约、协议入口、校验器和模型。
- `@open-media-downloader/runtime/node`：`createNodeHost` 与 Node 宿主实现。

该产物可以作为本地 package 供其他项目安装，当前标记为 private，未发布到 registry。消费项目使用包内声明的运行依赖；它不需要 WXT、React、tsx 或本仓库的路径别名。

```ts
// 在安装了构建产物的消费项目中
import { DownloadRuntime } from '@open-media-downloader/runtime';
import { createNodeHost } from '@open-media-downloader/runtime/node';
```

也可以直接在仓库根目录创建普通 `.mjs` 文件，交给 Node 执行：

```js
import { createNodeHost } from './.output/runtime/node.js';

const { runtime } = await createNodeHost({ outputDirectory: '/tmp/media-output' });
await runtime.enqueue([{
  id: 'authorized-local-video',
  adapterId: 'direct',
  pageUrl: 'http://127.0.0.1:8080/movie.m3u8',
  title: 'movie',
  mediaKind: 'hls',
}], 'mp4');
const result = await runtime.start();
console.log(result.tasks.map(({ id, status }) => ({ id, status })));
```

`scripts/check-runtime-build.ts` 检查 Vite 实际 module/import 图及构建产物与当前图是否一致，不扫描注释或错误文案中的关键词。公共入口的 chunk 依赖闭包不得引用 `node:*`，Node 专用入口才允许使用 Node 内置模块。随后从产物 `package.json.exports` 找到两个入口，在不加载 TypeScript loader、也不使用项目工作目录的普通 Node 子进程中动态导入，使用真实本地 HTTP HLS fixture 产出并校验 MP4。成功打印 `RUNTIME_BUILD_VERIFIED`。

## 单项下载入口

`executeDirectDownload(request, target, options)` 为 HLS、DASH、Progressive、SABR 提供一次性执行入口。它与持久队列使用相同协议引擎、Transport、TransformBackend 及媒体校验；一次性文件目标不持久化 checkpoint，`DirectOutputTarget.resumable` 明确为 `false`。

- `describeDirectOutput(selection, title)` 同步计算建议文件名，界面可在原用户手势中立即调用宿主 picker。
- 宿主提供 target 的 `writer`、关闭后范围读取、`finish`、`abort`；runtime 等关闭、校验、finish 全部完成才发最终 completed 进度。
- 浏览器 SABR 上下文仍由 `src/browser/direct-download.ts` 查询；runtime 不读取标签页或登录态。
- 浏览器内存 fallback 在校验后发起下载，并等待 downloads 最终状态；拿到 download ID 不等于成功。
- 原生文件 picker 的 writer 关闭后才能重新读取校验；无效输出不会报告成功，但浏览器已提交的文件不保证可以回滚。内存 fallback 仍会累计整个文件，大文件优先使用流式文件目标。
- 当前 Node CLI 使用持久 HLS/DASH 队列入口；其余协议的 Node 产品接入仍需提供相应来源与输出目标。

## 输出、持久化与恢复

`ArtifactStore.id` 是宿主输出命名空间身份，`name` 是显示名称。新 checkpoint 同时记录稳定身份；老版本缺少 ID 时仍按旧目录名称规则读取。两个同名但不同身份的目录不允许继续、重启或删除同一新任务的 partial。

同一轮 runtime 会记录任务使用的成品与 partial 文件名；不同任务争用同一名称时返回 `outputConflict`，清理也会检查其他任务的引用。

`open(filename)` 开始新的输出；`open(filename, { resumeFrom })` 要求已有文件至少到达该位置，截断多余字节，再追加。后者 `abort()` 保留已经写下的 partial。`read` 是范围读取，校验和合并不要求整部视频进入内存。文件名只能指向当前输出命名空间，不能携带任意本地路径。

完成顺序：

1. 协议执行器关闭成品，保留必要 partial。
2. runtime 持久化 `outputCommit`：输出身份、成品名称、校验要求、待清理 partial 名称。
3. 从 ArtifactStore 重新读取并校验成品。
4. 持久化 `completed`。
5. 删除 partial，清除 `outputCommit` 清理记录。

清理失败不会回退已经持久化的完成状态；下次取得执行权时会再清理。成品已经写完而 completed 尚未保存时，仍保留提交记录及可恢复内容。HLS/DASH checkpoint 中的字节计数不是落盘证明，恢复时仍要核对实际文件大小、分片边界与资源指纹。Progressive 任务只恢复队列状态与来源，未完成整文件需要重新下载；已有分片 checkpoint 不能直接转成 Progressive。

成品被结构校验证实无效或缺失时，runtime 清除失效的 `outputCommit`，保留 checkpoint；用户重试会用原有 partial 重新执行封装。普通文件 I/O 或存储响应失败仍保留提交记录，避免重复下载已完成的有效成品。已持久化 completed 的任务不会被旧失败状态覆盖。

这保证的是应用流程和进程重启后的可恢复顺序；浏览器/OS 突然断电、硬件缓存与文件系统损坏不属于已验证的 durable transaction。一个 JSON 任务快照和一个媒体文件不是跨文件事务。

## Node 宿主

`tsconfig.runtime.json` 独立于 WXT 配置；CLI 和库构建不需要 `.wxt` 生成目录。Node host 默认使用独立 HTTP fetch，没有浏览器 cookie jar，不导入 `wxt/browser`、React、页面 DOM 或 Web Worker。认证网络只能由调用者显式提供 `Transport`；网页播放上下文只能由显式 source provider 提供。`credentials: omit` 不代表调用者显式提供的 Authorization/Cookie header 会被删除。

`NodeArtifactStore`：

- 以输出目录的 realpath 作为稳定身份。
- 新成品先写同目录临时文件，关闭同步后 rename；取消新写入保留之前的成品。
- partial 使用真实位置写入；恢复前核对长度并 truncate，close/abort 同步并关闭文件。
- 所有读取按 offset/length 进行，阻止文件名越界和通过文件软链接读取/写入。

Node 新文件的 sync、close 或 rename 失败时会尽力删除无恢复归属的 staging 文件，保留首个错误与原成品；续传 partial 则保留供 checkpoint 恢复。

`NodeTaskStore` 把任务保存在输出目录的 `.download-runtime.tasks.json`，先写临时快照并同步，再 rename。无效 schema/损坏 JSON 会报错，不能静默当空队列覆盖。仓库写操作需要由同一 `ExecutionLocks` 保护；直接调用底层 store 的嵌入方必须遵守这个约束。

执行锁用 realpath 身份哈希映射到 `127.0.0.1` 的本地 TCP 端口，仅用于内核排他绑定，不接收业务请求。进程退出或被杀后由 OS 释放，没有清理旧锁文件时误删新 owner 的竞态。端口碰撞会保守返回 busy，不会放行重复执行；可用 `--lock-port` 指定端口，同一输出目录的全部客户端必须使用一致设置。该锁仅覆盖同一台机器，不是多机租约。

Node TS 后端在当前进程执行 mux.js；它避免 DOM/Worker 依赖，但不会把 CPU 工作自动移到另一线程。需要 UI 响应隔离的 Electron/云端可以按同一 TransformBackend 契约提供 worker_threads 或其他工作进程。

```sh
pnpm runtime:cli --output /tmp/media-output \
  --url http://127.0.0.1:8080/movie.m3u8 --kind hls --title movie

pnpm runtime:cli --output /tmp/media-output \
  --url http://127.0.0.1:8080/movie.mpd --kind dash --title movie-dash

# 没有 URL 时运行磁盘中遗留的 queued/waiting/中断任务
pnpm runtime:cli --output /tmp/media-output

# 失败或取消后，重复同一 URL/kind/format 命令可保留 checkpoint 重试
pnpm runtime:cli --output /tmp/media-output \
  --url http://127.0.0.1:8080/movie.m3u8 --kind hls --title movie
```

CLI 将结果以 JSON 写 stdout；存在未完成任务时返回非零退出码。SIGINT/SIGTERM 请求停止当前任务，并等执行器关闭输出、保存状态、释放执行锁后退出。它是本地授权媒体与集成验证入口，不是面向互联网的下载代理服务。

## 其他前端/宿主接入时仍需解决的能力

| 平台 | 可以复用 | 仍属于平台的工作 |
|---|---|---|
| 纯 Web | runtime、协议、封装算法 | CORS、文件 API/用户手势、页面生命周期；不能直接读取其他站点标签页 |
| Browser extension | 当前完整采集与任务接入 | host permissions、DNR、MAIN world bridge、目录授权；执行页关闭后任务会停止 |
| Electron | Node 文件能力与 runtime | 安全 IPC、应用自己的登录 session、独立执行进程；不会自动继承外部 Chrome 会话 |
| 云端 | runtime、协议、状态/输出接口 | 明确认证、出网策略、服务端文件/对象存储、任务授权与多实例所有权；对象存储需要可 seek 临时区再发布 |

源码中的 YouTube 上下文仍绑定原 source tab、独立网络观察及短时有效期，并只存 session。抽出 runtime 不会改变这个授权边界，也不代表 signed URL、partial 或凭据可以任意换机器复用。

## 可重复验证

```sh
pnpm test:runtime
pnpm build:runtime
pnpm exec tsx --tsconfig tsconfig.runtime.json scripts/check-runtime-build.ts
pnpm typecheck
pnpm test:run
pnpm build
```

`tests/download-runtime.test.ts` 另外用实际 Bilibili resolver、默认 executor registry 和有效 MP4 fixture 验证：初始协议未知/DASH 提示最终解析为 Progressive，下载开始前及完成后的协议/格式持久化，过期 URL 403 后重新解析与整文件重试。这是可重复的本地协议集成验证，不使用真实 Bilibili 账号。

`tests/node-runtime.test.ts` 使用真实本地 HTTP server 和真实临时文件，覆盖：

- HLS manifest 下载、TS→MP4 及音视频轨道校验。
- DASH manifest 解析、双轨下载合并、成品校验、partial 清理。
- 第二个 HLS 分片失败后重新组装 Node host，从磁盘 checkpoint 只补缺失分片。
- 独立 Node 子进程调用实际 CLI 产出可校验成品。
- 随机写入、续传截断、abort 保存 partial、新输出取消不破坏旧文件、路径及软链接边界。
- 两个真实进程竞争执行锁，以及 SIGKILL 后新进程取得执行权。
- Node transport 显式使用无浏览器会话的请求方式。

这些测试不使用真实站点账号，也不证明浏览器真实崩溃、权限撤销、Electron/云端部署已经通过验收；真实平台行为需要各宿主自己的后续验证。
