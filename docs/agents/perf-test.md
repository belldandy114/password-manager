# perf-test（AGENTS.md 历史段落存档）

> 这些内容从 `AGENTS.md` 搬出，原文未改。AGENTS.md 里保留摘要与指针，
> 目的是让 AGENTS.md 回到工作区指令预算（65,536 B）以内，否则后半部分会被截断。

## 压力测试（JMeter 非 GUI）—— 2026-10-29 新增

侧边栏「工具 → 压力测试」。只跑 **非 GUI（`-n`）** 模式：选本机 `.jmx`、定输出目录、可选 HTML 报告，
运行过程按 cmd 的样子**逐行流式显示**，结束后给统计（样本/平均/最大/P90/错误率/TPS）。

### 实现拆解（改这块前先看）

| 文件 | 职责 |
|---|---|
| `electron/jmeter-args.js` | **纯函数**：`pickPaths`（输出路径规划）、`buildJmeterArgs`（拼参数）、`parseSummary`（控制台汇总行）、`parseJtl`（CSV 结果统计）、三个 `validate*`。配 16 条单测 |
| `electron/ipc-jmeter.js` | `jmeter:detect / pick-exe / pick-script / pick-out-dir / run / stop / status / open-path / defaults / remember`；spawn、按行转发、退出后解析 |
| `src/pages/PerfTest.tsx` | 环境区（JMeter/Java/候选）、运行配置、日志窗、结果统计 |
| `preload` / `types.ts` | `jmeter*` 方法 + `onJmeterOutput` / `onJmeterDone`（返回取消订阅函数） |
| 设置字段 | `jmeterPath` / `jmeterOutDir` / `jmeterLastJmx`（只记路径，**脚本不会复制进应用**） |

### 四个必须记住的坑

1. **Windows 上 `.bat` 不能直接 spawn**（`EINVAL`）。必须 `cmd.exe /c <bat> <args>`；代码里按扩展名判断。
2. **停止要杀进程树**：`taskkill /PID <pid> /T /F`。只 kill 父进程会留下 `java.exe` 继续跑，CPU 一直占着。
3. **报告模式 `-o` 要求目录为空或不存在**。所以每次运行都建 `report-<时间戳>/` 新目录，jtl 放在它**旁边**
   （jtl 若放进报告目录，第二次运行就会撞「目录非空」）。
4. **输出必须流式 + 限量**：按行推 `jmeter:output`，界面只保留最近 4000 行；完整日志另外落
   `<输出目录>/jmeter-<runId>.log`，出问题可以回看。

### 线程数 / 循环次数覆盖

通过 `-Jthreads=N -Jloops=N` 传属性覆盖，**脚本里必须用 `${__P(threads,默认值)}` / `${__P(loops,默认值)}` 才生效**——
这是 JMeter 的约定，不是我们实现的限制，界面上已经写在字段提示里。

### 回归方式：假 JMeter（不需要本机装 JMeter）

`scripts/ui-round10-test.js` 会在临时目录造一个 `fake-jmeter.cmd`（内容 `node fake-jmeter.js %*`），
假脚本按真实约定：解析 `-l`/`-o`、写 CSV jtl、建 `index.html`、打印 `summary = ...`、退出 0。
覆盖 14 条断言：页面结构 / 命令回显 / 流式日志 / 统计解析 / jtl 与报告落盘 / 连续运行不撞非空目录 /
stop 杀掉长任务 / 停止后状态清空。

```bash
node scripts/ui-round10-test.js                 # 开发目录（先 npx vite build）
USE_PACKED=1 node scripts/ui-round10-test.js    # 打包版（先 npm run pack）
```

⚠️ **不要**用真实 JMeter 对本机/内网环境跑压测做回归——会真的打对方服务。
需要人工验证时，用 `-Jthreads=1 -Jloops=1` 对测试环境的最小接口跑一次即可。

### 打包时的额外注意

`npm run pack` 会去下载 electron/winCodeSign，公司网络下会 `ETIMEDOUT`。先设：

```powershell
$env:ELECTRON_BUILDER_CACHE = "$env:LOCALAPPDATA\electron-builder\Cache"
```

`scripts/build-installer.js`（`npm run dist`）会自动探测这个目录，但 **`npm run pack` 不会**，要手动设。

