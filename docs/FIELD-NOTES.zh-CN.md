# Field Notes — 从 pi 与 deepseek-harness 学到的工程知识

> 这份笔记来自对两个参考项目源码与文档的逐文件研读，以及把它们真实跑起来实测之后。
> 每一条都注明了出处；最后一节说明 Memento 采纳了什么、有意舍弃了什么。
> 想深入任何一条，出处文件可以直接打开对照。

---

## 一、Agent 主循环（pi）

**1. 用两级队列把"用户插话"建模成两种语义**
`steering`（agent 还在干活时的中途引导）在工具批次边界注入；`follow-up`（agent 即将停止时的补充）进入外层循环开启新 turn。主循环只在安全点读队列，绝不并发改写对话历史。
出处：`pi/packages/agent/src/agent-loop.ts`（双层 while），`agent.ts`（`steeringQueue`/`followUpQueue` 默认 "one-at-a-time"）。
启示：不要用"打断+重启"处理插入消息；让循环结构自己表达"何时该听用户的话"。

**2. 工具批次：串行准备、并行执行、显式终止信号**
一次 assistant 消息里的多个工具调用是一个批次：参数准备必须串行（可能有顺序副作用），执行默认并发（`Promise.all`），结果按原序回收；"提前结束循环"是工具结果上的 `terminate` 字段（要求全批次一致），不是异常。
出处：`agent/src/types.ts` L40-43，`agent-loop.ts` L602-604、L644-645。
启示：与 Memento 的 `executeBatch` 同构——批量工具在结果里表达控制流，而不是靠 throw。

**3. 流式协议：迭代器 + 最终结果双通道；错误进流，不抛异常**
`EventStream<T,R>` 同时提供 `for await`（增量渲染）和 `result()`（最终消息）；失败与中止被编码为流内终止事件（`stopReason: "error" | "aborted"`），主循环永远不需要 catch 传输层异常。同类"Contract: must not throw"标注遍布所有回调（getApiKey / getSteeringMessages / …）。
出处：`pi/packages/ai/src/utils/event-stream.ts`，`agent/src/types.ts` 契约注释。
启示：Memento 的 `LlmProvider.stream` 采用同一契约（"implementations MUST translate provider errors into error events"），主循环事件序列因此永远完整。

**4. 上下文压缩的目标是"可继续工作的检查点"，不是省 token**
阈值触发（contextWindow − reserveTokens）；结构化摘要模板固定小节（Goal / Progress / …）；二次压缩用 `UPDATE_SUMMARIZATION_PROMPT` 把 <previous-summary> 与新消息合并（"PRESERVE all existing information"）；保留最近 ~20k token 原文；摘要尾部自动附加已读/已改文件清单，防止压缩后重复探索。
出处：`agent/src/harness/compaction/compaction.ts`（DEFAULT_COMPACTION_SETTINGS、findCutPoint、formatFileOperations）。

**5. 溢出安全阀三件套**
① 集中式检测表：`OVERFLOW_PATTERNS` 每条正则标注来源供应商，`NON_OVERFLOW_PATTERNS` 排除 rate limit 假阳性，同时检测"错误文本"与"silent overflow（成功但 input 超窗）"；② 一次性自动恢复：`overflowRecoveryUsed` 标记防死循环；③ 确定性兜底：输出被截断时（stopReason "length"）该消息里的工具调用"看似合法实则残缺"，全部判失败让模型重发。
出处：`ai/src/utils/overflow.ts`，`agent-loop.ts` L427-433、`drive/response.ts` L189-195。

---

## 二、多供应商抽象（pi）

**6. 加一个供应商 = 一个 factory + 一张模型表**
`createProvider({ id, auth, models, api })`：`auth` 是强制字段（"every provider has auth semantics, even ambient/keyless ones"），`api` 支持单一实现或按 `model.api` 分发。anthropic.ts 全文仅 60 行。
出处：`ai/src/models.ts`，`ai/src/providers/anthropic.ts`。

**7. 开放联合类型 + 兼容差异表**
`type Api = KnownApi | (string & {})` —— 保留字面量补全，又不把未知供应商排除在类型系统外；"OpenAI 兼容"端点之间的差异（supportsStore、supportsDeveloperRole、supportsReasoningEffort…）收敛成一张显式 compat 表，注释统一标注 "Default: auto-detected from URL"。
出处：`ai/src/types.ts`（`OpenAICompletionsCompat`）。

**8. lazyStream：同步返回句柄，异步准备藏在后面**
认证解析、模块懒加载等异步准备不阻塞 API 边界；准备失败 = 流以 error 事件终止。
出处：`ai/src/api/lazy.ts`。

---

## 三、会话与持久化（pi）

**9. JSONL 事务日志：一行 = 一个事务，写入串行，原子发布，容忍撕裂尾行**
commit 通过 Promise 链串行化（`commitQueue`）；一行可含多条 write；读取端 `splitCompleteLines` 返回 `{ lines, torn }` 安全丢弃进程被杀时的残行；发布走"写 .tmp → rename"原子替换。
出处：`agent/src/harness/session/jsonl/storage.ts` L47/L128-135，`jsonl/io.ts` L81-103。
启示：Memento 的 `SessionLog` 是同族设计（append-only + 部分行跳过 + "崩溃最多丢最后一行"注释）。

**10. Entry 树 + 压缩感知重放：摘要是一等公民**
`EntryType = "message" | "compaction" | "branch_summary" | "custom"`；compaction entry 带 `firstKeptEntryId` 规定"压缩点之后从哪继续"；`buildContextEntries()` 把"重建上下文"写成确定性纯函数（entries → messages）并有规范文档。
启示：摘要/检查点用显式记录类型，而不是隐含逻辑。

**11. 把并发纪律写进 API 契约**
`commit()` 的 JSDoc："Exactly zero or one commit attempt. A second attempt rejects."——不变量用类型和注释锁定，再用 conformance 测试套件保证多后端（JSONL / SQLite）行为一致。

---

## 四、插件树与 seam（deepseek-harness）

**12. 无特权内核：产品的每一部分都是插件**
模型适配器、工具注册表、会话日志、agent loop 本身都是插件，"没有任何需要打补丁的特权内核"；扩展方式是把插件挂到其他插件旁边，注册都是副作用，插件卸载时撤销。
出处：`dsh/docs/architecture.zh.md`（Cordis 一节）。

**13. seam 三角色：Service Definition / Provider / Consumer**
一项可替换能力 = 声明接口的服务 + 一个或多个提供方 + 消费方（通常是工具）。`packages/shell` 是范例：dsh-shell（定义）/ dsh-bash-local / dsh-bash-sandbox（提供方）/ dsh-tool-bash（消费方）。"替换一个提供方就能改变整个产品"——文件系统指向远程沙箱，Bash、PTY、LSP 全部搬过去。
出处：`dsh/docs/glossary.zh.md`（capability-seam），`architecture.zh.md`（能力 seam 一节）。

**14. profile + 组合包：分层组装 + patch 定位替换**
运行中的 dsh 是一棵插件树，由启动时按序叠加的层组成（bundle → profile patch → home patch → --patch overlay）；一条 patch 按 id 定位某条目并替换其整个 config。`dsh --profile web --dump-config` 打印的条目都可被替换。
启示：可组合配置的本质是"ID 定位 + 整体替换 + 有序叠加"，比递归 merge 好推理得多。

**15. 两层扁平作用域 + shadowing**
全局 / 带作用域（恰好一个 scope key）两层，不做继承树；"最具体者胜出"的名称解析（scoped 注册替换同名全局项）；子树行为通过 lineage 数据表达，从不通过 scope 结构。
出处：`dsh/docs/glossary.zh.md`（agent-scope 一节）。

---

## 五、事件与工具流水线（deepseek-harness）

**16. 事件选域是第一个设计决定**
会话事件（追加到日志的持久事实）/ Agent 事件（携带活跃 agent 的观察拦截点，`agent/*`）/ 能力事件（向 seam 附加策略适配器，`fs/*`、`tools/*`）。waterfall 事件（监听器必须调用 `next()` 委托）与 serial 事件（无 next，如 `agent/turn-stopping`）语义分明。
出处：`architecture.zh.md`（事件、轮次流程）。

**17. turn / step 词汇表**
一个步骤 = 一次模型请求 + 它调用的工具；一个轮次 = 零或多个步骤，在领取首条输入前打开、在不再欠工作时关闭。外层策略迭代叫 Round（Goal Round / Ralph Round），计数器归策略所有。
启示：把"轮次"和"步骤"分开命名，才能精确描述"max turns 限制的到底是什么"。

**18. "模型可见即已记录"是运行时不变量**
请求里的一切都必须能从会话日志重建，有断言守着；新增模型可见输入必须新增会话事件；修改消息内容的插件要注册"纯消息投影"。fork、恢复、遥测、持久化全部从这些持久记录派生——不存快照，只存事实。
启示：Memento 的 SessionLog 头注释即此不变量（"what the model saw ⟺ what was logged"）。

**19. 工具执行流水线：waterfall 优先，确定性守卫压轴**
`tools/pre-execute`（钩子、权限、沙箱）→ 单调守卫（deny 或 abstain，身份受保护）→ `tools/execute`（超时、重试等环绕分发）→ `tools/post-execute`（接受、阻断、替换、附加上下文）→ finalizeContent → `tools/result`（不可变权威结果）。每个环节抛异常都被规范化成 isError 快照，绝不会破坏消息序列。
出处：`dsh/docs/tool-execution-pipeline.zh.md`（含完整 Mermaid 流程图）。
启示：审批（approval）在守卫之前、"一次性询问"，拒绝与不可答一律按拒绝处理。

**20. 会话日志的 generation 与迁移**
"已提交 generation 路径绝不重命名、替换或删除"；每个相邻迁移包只负责一个 `vN → vN+1` 步骤；写 open 先编码、校验、再排他发布后继。旧格式永远可读。
启示：文件格式演化 = 只增不改 + 单向迁移链，这是"可审计的本地数据"的正确姿势。

---

## 六、防御性工程（deepseek-harness，全部来自真实事故）

> 出处：`dsh/docs/defensive-patterns.zh.md`——"每条模式都是本项目实际发布或差点发布的一类缺陷"。

**21. 正交结果独立上报**：进程可能"已超时却以退出码 0 结束"（它捕获了终止信号）；`timedOut` / `signal` / `exitCode` 各自独立上报，绝不把 A 的上报嵌在 B 的分支里。

**22. dispose 必须达到停稳，而不仅是请求停止**：清理流程只发信号不等待 = 孤儿进程；必须 await 子进程退出，且先关监听器注册表让迟到的事件静默。

**23. 分发器隔离回调异常**：用户监听器抛异常不得 reject 宿主 promise、不得饿死后续监听器；try/catch 包住分发循环并记录——"一个行为不当的订阅者绝不能破坏核心生命周期"。

**24. 绝不把环境变量或可预测路径暴露给不可信输出**：启动的命令使用清理过 env（剔除 `*KEY*` `*SECRET*` `*TOKEN*` `*PASSWORD*`）；临时文件放 0700 私有目录、随机名、`'wx'` 独占打开——防符号链接竞态与凭证泄漏。

**25. 用 unlink 删除链接形态的路径**：先 `lstatSync().isSymbolicLink()` 判断再 `unlinkSync`；Windows junction 上 `rmSync` 会 `ERR_FS_EISDIR`，递归删除可能穿过 junction 进入目标。

---

## 七、"AI 自维护"的真相（deepseek-harness）

dsh 的 README 级宣传里最抓人的一条是 agent 运行时自修改。核实结论：**有真实机制，但比"AI 重写自己"克制得多**——它修的是**扩展层**，不是核心：

- **`packages/extensions/` 组**（官方描述："Agent runtime self-modification: live plugin/service inspection and model-written mount/unmount"）：
  - `tool-cordis`：两个**只读**运行时 API 发现工具——agent 先看自己有什么 API 可用；
  - `cordis-host-runner`：host 半——注册表、**沙箱化**的 host 半生命周期、inspect 注册表；
  - `cordis-client-runner`：浏览器半——把"浏览器半源码"**求值为运行中的插件**；
  - `ui-cordis`：浏览器面板与生命周期工具卡片。
  - "Creator 模式通过 Plugin Manager 安装**持久化**插件"。
- 设计居所在 Agent Note：*self-referential-cordis-toolset*（自引用 Cordis 工具集）——沙箱语义、生命周期与组合都有专门决策文档。

**强在哪**：① 插件粒度即能力粒度，agent 写的扩展可以热挂载、立即生效；② 卸载是注册的逆操作，试错无残留；③ 只读 inspect 先行，agent 不会瞎改；④ 因为"无特权内核"，它改的永远是外围插件，核心稳定性不被 agent 侵蚀。

**边界在哪**：不是任意改核心代码；有沙箱与生命周期约束；生效范围限定在插件树。一句话：**它把"自维护"做成了受控的、可逆的扩展安装，而不是危险的自我重写。**

---

## 八、工程纪律与理念（pi）

**26. 语言子集换"源码即产物"**：只用 erasable TypeScript（无 enum / namespace / 参数属性），Node strip-only 模式直接运行源码，免构建跑测试与 CLI；禁 `any`；不用内联动态 import。
出处：`pi/AGENTS.md`。

**27. 类型手法三件套**：branded type 守边界（"只有 normalizeContext() 能产出此类型，原始 Context 无法意外到达 provider 代码"）；空接口 + declaration merging 做扩展点（`CustomAgentMessages`）；开放联合做插件式枚举。

**28. 供应链按代码审查对待**：依赖精确锁版 + `.npmrc` save-exact + min-release-age、lockfile 是唯一事实源且 pre-commit 默认拦截、9 类检查串成 `check`（含入口图、shrinkwrap、browser-smoke）；测试用 `env -i` 白名单隔离、假 provider（"No real provider APIs, keys, or paid tokens."）。

**29. 核心极小政策与表达规范**：CONTRIBUTING 原文——"pi's core is minimal. If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected."；"You must understand your code."；沟通规范 problem → 具体例子/短追踪 → 方案，且须区分"为什么必要"与"可选复杂度"。

---

## 九、Memento 采纳与取舍对照

| 学到的 | Memento 的落地 | 出处 |
| --- | --- | --- |
| 错误进流不抛异常 | `LlmProvider.stream` 契约 + `StreamEvent.error` | pi #3 |
| JSONL append-only 会话日志 | `kernel/session.ts`（"what the model saw ⟺ what was logged"） | pi #9、dsh #18 |
| 压缩即检查点 | `compaction` entry（摘要 + replacedCount + tokensSaved） | pi #4 |
| 加供应商 = 工厂 + 模型表 | `llm/registry.ts` + 5 个内置预设 + openai-compat 自定义 | pi #6 |
| 可逆注册的插件 | jiti 免构建加载 + `disposer` LIFO 卸载 + 崩溃不拖垮 | dsh #12/#15 |
| 确定性守卫先于执行 | `tools/guard.ts`（受保护路径、灾难命令，不调 LLM 的 fail-safe） | dsh #19 |
| 防御模式 | 审批默认拒绝、非 TTY 拒绝、错误规范化 | dsh #21-25 |
| 核心极小 | 4 个运行时依赖、单包、纯文件状态 | pi #29 |
| **有意舍弃**：运行时自修改 | 列为非目标——插件必须由用户显式安装（`plugins/` 目录），agent 不得自写自挂（安全面太大，收益不匹配） | dsh #7 的克制版 |
| **有意舍弃**：分层 patch/profile 组装 | 单层 config.json + `config.local.json` 覆盖——个人工具不需要企业级组装树 | dsh #14 |
| **新增（两个项目都没有）** | 置信度加权记忆（0.35 / +0.15 / −0.30 / <0.12 退休）与 SDD 闭环（RECALL→GATE→BUILD→VERIFY→REFLECT） | — |

---

*笔记整理于把两个项目跑通、并完成 Memento 主体之后。所有出处均可在仓库内直接打开对照。*
