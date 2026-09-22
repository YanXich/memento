# Memento 100K 星路线图

> 目标：把 Memento 从"一个能用的编码 agent"变成"开发者愿意主动传播的编码 agent"。
> 本文是行动蓝图：先保命（质量/安全），再做差异（记忆），最后放大（生态/品牌）。
> 每一条都对应一个真实发现的问题或一个高 star 项目的验证过的打法。

---

## 0. 现状盘点（审计结论）

深度审查 + 逐行验证后，项目底子比预想的好：SDD 六阶段闭环（RECALL→GATE→BUILD→VERIFY→REFLECT）、
"模型所见 ⟺ 日志所记"的会话不变量、确定性 spec 检查器（永不调 LLM）、
置信度加权跨会话记忆（0.35 起始 / +0.15 证实 / −0.30 证伪 / <0.12 退休）都是真差异点。

但发现 5 个严重问题、14 个重要问题。**Phase 1 已全部修复严重问题**：

| 编号 | 问题 | 状态 |
|------|------|------|
| S1 | Anthropic 流式工具调用 ID 错位（start 用真实 id、delta/stop 用合成 id）→ 该 provider 下所有工具调用失效 | ✅ 已修 + 回归测试 |
| S2 | spec 写入路径逃逸：LLM 控制 relPath 可覆盖任意文件 | ✅ 已修（强制 `.memento/spec/` 内 + 拒绝 `..`/绝对路径/非 md）+ 回归测试 |
| S3 | 项目插件默认执行 → `git clone` 恶意仓库即 RCE | ✅ 已修（默认拒载 + 显式 `trustProjectPlugins: true` + 启动警告）+ 回归测试 |
| S4 | 审批分类器可被换行/`&`/`$()`/反引号/无空格重定向绕过 | ✅ 已修（全分隔符 + 未引号危险语法预扫描，引号内元字符不误伤）+ 回归测试 |
| S5 | symlink 目录逃逸（isInside 纯字符串比较） | ✅ 已修（realpath 解析到最深已存在祖先）+ 回归测试 |
| M1 | 输出截断 + 无工具调用被误判 "done" | ✅ 已修（自动 nudge 续写，连续 3 次放弃）+ 回归测试 |
| M3 | runLoop 无异常兜底 → session 永远 incomplete | ✅ 已修（catch 兜底写 result；hook/compact/事件处理器全部隔离） |
| M4 | compact 压缩请求未传 abort signal | ✅ 已修 |
| M7 | fetch 网络错误不区分 AbortError（abort 被误报为网络故障） | ✅ 已修（sseLines 读取挂起时也响应 abort） |
| M9 | shell 超时/取消只杀父进程，孙进程孤儿 | ✅ 已修（Windows taskkill /T，POSIX 进程组 kill） |
| M14 | shell 输出截断 O(n²)（每 chunk 整串 slice） | ✅ 已修（O(1) per chunk，溢出即丢弃） |
| — | 事件总线 handler 异常中断链、迭代期 on/off 语义不稳定 | ✅ 已修（快照语义 + 异常隔离 + 熔断） |
| — | 有写操作时整批工具串行 | ✅ 已优化（连续只读并行、写操作保序）+ 时序回归测试 |

**验证状态**：typecheck 干净 · **148/148 测试通过**（含 18+ 安全回归 + 并行时序 + MCP 双通道 + git/undo + commit hint + resume 断点续跑 + chat REPL + 记忆进化轨迹 + bench 并行调度 + 插件市场）· 构建成功。

尚待处理的重要问题（阶段归属见下）：

| 编号 | 问题 | 状态 |
|------|------|----------|
| M8 | ToolContext progress/approve 死通道（工具拿不到真实进度/审批） | ✅ 已修（progress 带工具名入事件总线 tool_progress；approve 转发循环真实策略，无策略默认拒绝；子 agent 进度转发到父 UI）+ 回归测试 |
| M12 | web server 同步读 O(2×N) | ✅ 已修（单遍 scanSession + stamp 缓存/ETag 304 增量读）+ 回归测试 |

Phase 1 全部项已落地：M2（600s 请求超时 + retryable 失败重试一次，含 429/5xx/中流断线，回归测试 kernel.test.ts）、M5（CJK token 双权重估算）、M6（lessons.jsonl O_APPEND 单行原子性 + 并发契约）、M10（approver 响应 abort signal）、M11（插件 API 形状收紧——BeforeLlmPatch 仅可改 system，无法伪造消息角色）、M13（插件加载失败显式警告）。

---

## 1. 对标：高 star 项目做对了什么

调研结论（OpenClaw 186k / OpenCode 172k / aider 49.1k / Cline / gpt-pilot 停维护反面教材）：

1. **免费替代品定位**（OpenCode 打法）：明确的"谁、替代谁、为什么现在"。
   Memento 的定位语：**"The coding agent that remembers"**——第一个把"从错误中学习"做成硬功能的终端编码 agent。
2. **benchmark 内容营销**（aider 打法）：aider 靠 Polyglot leaderboard 获得长期 SEO 流量。
   Memento 需要**记忆基准**：跨会话错误复现率、第二次解决同类问题少用多少 token。
3. **生态飞轮**（OpenClaw 打法）：Skills/插件让第三方贡献，贡献者自带传播。
   Memento 的插件系统已有，缺的是**发布渠道 + 模板 + 示例仓库**。
4. **Plan/Act 范式**（Cline 打法）：用户要"先看计划再执行"。Memento 有 spec/ADR，缺交互式 plan 确认。
5. **停更警示**（gpt-pilot）：单机自嗨项目会死。Memento 必须尽早拥抱 MCP/生态标准，别自造轮子。

## 2. 三大增长杠杆（按 ROI 排序）

### 杠杆 1：记忆基准（差异化核心）
- ✅ 自建基准 harness 已交付：`memento bench tasks.json` 把一族相似任务冷/热对比跑（冷=全新副本零记忆，热=召回经验），
  输出学习曲线与省下的轮数/token；`--dry` 确定性零网络 provider 让 harness 自身可测、可演示、可进 CI。
- ⬜ 跑真实数据：用同一族任务在 deepseek 等真实模型上跑出冷/热对比数字（第二次解决同类问题少用多少 token）。
- ✅ leaderboard 页面已交付：`site/benchmarks/index.html`（静态、GitHub Pages 可托管、fetch results.json 渲染、可点击学习曲线 + 提交指南，`npm run merge-bench` 合并提交）→ 长期 SEO 流量 → 吸引实验者 → 传播。
- 这是别的 agent 做不了的内容，因为记忆是 Memento 独有的硬功能。

### 杠杆 2：MCP 双通道（生态入场券）
- **client 方向**：接入 MCP server（一行配置连 filesystem/github/database）→ 工具生态立刻大一个数量级。
- **server 方向**：把 lessons 记忆作为 MCP server 暴露（`memento serve-mcp`）→ 别的 agent（Claude Code/Cline）
  都能消费 Memento 攒下的教训 → 反哺 Memento 品牌（"你的记忆，所有 agent 共享"）。
- 这一步让 Memento 从"又一个 CLI"变成"基础设施"。

### 杠杆 3：repo map + unified diff 编辑（可靠性口碑）
- repo map（aider/pi 验证过的设计）：文件树 + 关键符号 + 依赖关系，注入 system prompt → 定位正确率显著提升。
- unified diff 编辑格式：`apply_patch` 工具 + `<system_reminder>` 重试语义（Cline 验证）→ "改错行"大幅减少。
- 可靠性是编码 agent 口碑的第一驱动：第一次跑就砸锅的用户不会再给第二次机会。

## 3. 阶段划分

### Phase 1 — 核心质量（✅ 全部完成）
目标：**发布前没人能黑、没人能骂"不稳定"**。
- ✅ S1–S5、M1/M2/M3/M4/M5/M6/M7/M9/M10/M11/M13/M14、事件总线、并行批次、会话续跑、溢出防护、超时+重试
- 验收：`npm test` + `npm run build` 全绿 + 恶意 prompt 测试集全拦截 ✅

### Phase 2 — 差异化（✅ 已完成）
- ✅ repo map 生成器（确定性解析，无 LLM）+ 注入 system prompt
- ✅ `apply_patch` unified diff 工具（含模糊匹配、dry-run、失败重试语义）
- ✅ 反思增强：spec 建议生成 + 记忆回收入 `--reflect` 时机的双写（spec-suggestions.md 落盘）
- ✅ 交互式 plan 模式：`memento plan <task>` 先出计划，用户确认后执行（-y 直批）
- ✅ 断点续跑：`memento resume <session>` 把完整转录重放给模型，继续写入**同一个**会话日志，verify → reflect → commit hint 重跑（复用了 run/resume 共享的 hooks + aftermath 模块）
- ✅ 记忆进化可视化：web 工作台 Memory 页为每条 lesson 绘制置信度进化 sparkline + 事件时间线（created/reinforced/contradicted/retired），`?evol` deep link 一键展开；compact 保留每 lesson 最近 8 条轨迹（COMPACT_HISTORY_KEEP），会话详情页带 `memento resume` 复制提示
- ✅ M12 web server 增量读：单遍 scanSession + stamp 缓存/ETag 304
- ✅ 交互式 chat REPL：`memento chat` 同循环交互（每轮记忆召回、内联审批、退出反射、--session 续接）
- ✅ bench 并行调度：cold 副本独立 → worker 池并行（`--jobs`），warm 链严格串行（每任务继承记忆）独占 worker 即时重叠；输出按任务序，`--jobs 1` 回到串行；并行与串行结果一致 + `--no-cold` 空槽回归测试
- 验收：e2e 测试覆盖 repo map 注入与 plan 批准链路 ✅

### Phase 3 — 生态（✅ 已完成）
- ✅ MCP client 接入（stdio 传输；零依赖自写 JSON-RPC 2.0 wire 层；Windows shell 引号化；超时/exit/parse error 防御）
- ✅ `memento serve-mcp` 暴露 lessons（search_lessons / add_lesson / memory_stats；真实子进程 e2e 验证）
- ✅ MCP 信任模型：仅用户级配置加载，项目级需 `trustProjectMcp: true`（S3 同模式，防 clone RCE）
- ✅ 原生 git 集成：只读 git_status/git_diff/git_log 工具 + diff 感知 commit 建议（含 untracked 文件）+ `memento undo` 撤销快照链
- ✅ 子 agent 分派：内建 `subagent` 工具派出只读探索者（独立迷你循环 + 独立 JSONL 转录 + 主日志链指；只读工具带，无递归无写入）
- ✅ 插件市场雏形：`memento plugins install owner/repo[#subdir]`（git URL/本地路径均可）+ 来源 manifest（source/rev/installedAt）+ 安全确认（先列文件再问）+ `list`/`init`/`remove`；loader 支持目录包形态（plugins/<name>/index.ts）
- ✅ 官方示例插件（examples/plugins/）：todo-guard（spec checker）/ session-digest（生命周期钩子）/ now-tool（工具注册）+ 总览 README；`spec verify` 死通道修复（异步 attachPlugins，插件 checker 真正运行 + verifySpec 自动补 checker 归属）+ 回归测试
- 验收：MCP 双通道 22 测试 + git/undo 15 测试全绿 ✅

### Phase 4 — 品牌与增长（进行中：品牌化 ✅ / 落地页 ✅ / 发布闭环 ✅ / 传播 ⬜）
- ✅ 前端品牌化（**清新紫蓝 + 水木元素**）：web workbench 紫蓝渐变调色板（violet #a78bfa → aqua #6fe3d0）、顶部 water line、径向光晕背景、渐变 logo/置信条；终端输出品牌化（◈ 品牌徽记 + 紫蓝工具行 + 语义色状态）；浏览器实测截图存证（_shots/）
- ✅ workbench 插件页（Plugins tab + /api/plugins）：静态盘点已装插件（名称/来源/rev/安装时间/入口，绝不执行插件代码）+ 信任横幅（trustProjectPlugins 未开启时诚实提示“未加载”）+ overview 插件统计卡；共享 scanPluginDir（loader 与 CLI 单一事实源）
- ✅ README 重构（双语）：四答案定位（记忆/spec/插件/生态原生）+ 新输出示例 + 完整 CLI 表 + 安全模型（含 MCP 信任）
- ✅ 社区材料：CONTRIBUTING、SECURITY、ISSUE 模板（bug/feature）、PR 模板
- ✅ 落地页（静态 + GitHub Pages）：hero 定位语 + 动画终端（30s demo + chat）+ 记忆基准学习曲线 SVG + CTA；OG/twitter 标签；浏览器实测截图存证
- ✅ 发布闭环：GitHub Actions CI（双 OS × 双 Node 矩阵 typecheck+tests；build 后 CLI 启动/插件清单/全链路 demo/内存并发/bench dry 串行+并行冒烟）+ tag 触发 npm publish --provenance workflow；README 双语徽章（CI/npm）+ starter 模板（examples/starter-template/，15 分钟上手导览，spec verify + bench --dry 端到端验证）
- ⬜ 传播：HN/Reddit/V2EX 发帖节奏、benchmark 博客、模板仓库（memento-starter）
- ✅ 记忆基准（杠杆 1）leaderboard 页面已交付（harness `memento bench` ✅ + `site/benchmarks/` ✅）；真实模型数据待跑

## 4. 取舍原则（每步都要问）

1. **YAGNI**：只为"记忆/可靠性/生态"三大杠杆写代码，其余砍。
2. **兼容 > 自造**：MCP 是行业标准，优先接入而非发明协议。
3. **失败要可见**：错误进流不抛异常（pi 模式），但必须有痕迹——日志/警告/熔断。
4. **安全是门票**：一次 RCE 事故 = 永久出局。默认拒绝（插件、审批、路径）而非默认放行。
5. **每个卖点必须有 benchmark 或测试背书**：没有数字的卖点在 HN 上活不过一小时。

## 5. 验收路线图（里程碑）

- **M1（已完成）**：Phase 1-3 全绿（148/148 测试）→ `v0.2.0` tag 已打（含插件市场 + 插件页 + CI/发布闭环 + starter 模板）
- **M2（进行中）**：落地页 + 记忆基准真实数据 → 第一篇 benchmark 博客（leaderboard 页面已就绪）
- **M3（一个月）**：MCP 双通道文章 + 落地页 → HN 首发
- **M4（持续）**：插件生态 + 社区运营 → 冲 10k → 冲 100k

> 记住：10 万星不是目标，是"开发者觉得它值"的自然结果。我们要交付的是后者。
