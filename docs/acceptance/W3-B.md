# W3-B 收尾验收证据（t27）

> 任务：`jmxlib:create-batch` 接线 + JMeter 引擎日志改落 jtl 同目录。
> 本文件是长证据的唯一落点；`agent_teams_update_task` 里每条 evidence 只放 ≤200 字摘要 + 指回本文件。
> 运行时间：2026-11-24 11:36–11:41（本机，Windows）。

## 1. 改动清单（6 个 inScope 文件）

| 文件 | 改动 |
|---|---|
| `electron/preload.js` | +1 行：`jmxlibCreateBatch: (rel, plan) => ipcRenderer.invoke('jmxlib:create-batch', { rel, plan }),` |
| `src/types.ts` | +`import type { JmxPlan } from '../electron/jmx-script';`；+`JmxCreateBatchResult` 接口（本地新定义，**不是**拷贝别人的等价类型）；+ElectronAPI 声明 `jmxlibCreateBatch(rel, plan)` |
| `electron/jmeter-args.js` | `buildJmeterArgs` 支持 `logPath` → 追加 `-j <logPath>`（位置紧跟 `-l`，顺序稳定）；新增纯函数 `pickJmeterLogPath(dir, stampStr)`、`canWriteDir(dir)`；三者都进 `module.exports` |
| `electron/ipc-jmeter.js` | `jmeter:run` 里先算日志路径：`pickJmeterLogPath(dirname(jtl), stamp())` + `canWriteDir(dir)`，可写才把 `logPath` 传给 `buildJmeterArgs`；不可写时 `console.log('[jmeter] 日志目录不可写或不可用，回退为不传 -j：<dir>')` 并退化为不传 |
| `src/utils/__tests__/jmeterArgs.test.ts` | +3 条新用例（见 §4），既有断言**一条未改** |
| `docs/acceptance/W3-B.md` | 本文件 |

## 2. 四元组（改动前后）

```
改动前：handler 221 个 / preload 调用 218 个 / 暴露方法 238 个 / 类型声明 238 个
        warn 3 条：jmxlib:create-batch、pin:close-all、pin:count
改动后：handler 221 个 / preload 调用 219 个 / 暴露方法 239 个 / 类型声明 239 个
        warn 2 条：pin:close-all、pin:count           ← 死通道 warn 消失
结果：通过（无 error 级问题）
```

## 3. 真跑证据：jmeter.log 不再落进脚本库（本任务的核心）

复刻 `ipc-jmeter.js` 的决策（**用的是真实纯函数**，不是手写字符串）：

```
pickJmeterLogPath → {"ok":true,"path":"...\\out\\jmeter-2026-11-24_11-39-25-engine.log"}
canWriteDir(out) = true；最终 -j 路径 = ...\\out\\jmeter-2026-11-24_11-39-25-engine.log
argv = ["-n","-t","...\\lib\\日志落盘验证.jmx","-l","...\\out\\run.jtl",
        "-j","...\\out\\jmeter-2026-11-24_11-39-25-engine.log","-Jthreads=2","-Jloops=3"]

--- 真跑（cwd = 脚本库目录，带 -j）---
  退出码 = 0
  stdout 汇总: summary =     18 in 00:00:05 =    3.9/s Avg:    76 Min:     0 Max:   674 Err:     0 (0.00%)
  样本数 = 18（期望 18）→ PASS
  脚本库目录内容 = ["日志落盘验证.jmx","账号源.csv"]
  **脚本库里有没有 .log = NO**            ← 修复前这里是 ["jmeter.log", ...]
  jtl 同目录内容 = ["jmeter-2026-11-24_11-39-25-engine.log","run.jtl"]
  **-j 指定的日志是否真的出现 = YES**（6036 B）
```

### 3.1 反证：不传 `-j` 时日志确实会落进脚本库（证明问题真实存在）

```
--- 退化路径 ---
  canWriteDir(不存在的目录)=false → 最终 jmeterLogPath='' → argv 含 -j = NO
  不带 -j 也能跑：样本数 = 18 → PASS（旧行为保留）
  此时脚本库目录 = ["jmeter.log","日志落盘验证.jmx","账号源.csv"]
                   ^^^^^^^^^^^ 这正是要传 -j 的原因
```

### 3.2 边界：目录不可写不能让压测失败

`canWriteDir('...\\no-such-out\\deeper')` 返回 `false` → 上层不传 `-j` → `buildJmeterArgs` 正常产出 argv
（`["-n","-t",...,"-l",...,"-Jthreads=2","-Jloops=3"]`，无 `-j`）→ 真跑仍 `samples = 18`。
`ipc-jmeter.js` 在该分支打一行 `[jmeter] 日志目录不可写或不可用，回退为不传 -j：<dir>`，**不抛错**。

### 3.3 为什么日志名带 `-engine`

应用自己还会把捕获的 stdout 落成 `<outDir>/jmeter-<时间戳>.log`（`electron/ipc-jmeter.js:477`，`stampNow()`）。
两者同目录同名会互相覆盖、引擎日志白留，所以本次命名为 `jmeter-<时间戳>-engine.log`。
验收文字里写的是 `jmeter-<时间戳>.log`，这是**有意的偏离**，理由见本条。

## 4. 单测变更点名（acceptance 第 4 条要求逐条点名）

**既有断言：0 条被修改。** 原因：`-j` 只在传了非空 `logPath` 时追加，不传即保持旧行为，
所以 `jmeter-args.test.ts` 里既有的精确数组断言（`['-n','-t',JMX,'-l','o\\r.jtl']`、
report 模式带 `-e -o`、`-Jthreads/-Jloops` 追加、`extraArgs` 追加）**全部原样通过**，一条没动。

新增 3 条（全绿，该文件 40 → 43 条）：

| 新用例 | 断言 |
|---|---|
| `传了 logPath 时追加 -j <日志路径>` | `['-n','-t',JMX,'-l','o\\r.jtl','-j',log]`；与 `-Jthreads/-Jloops` 同时给时顺序为 `-l → -j → -J*` |
| `不传 / 空串 / 空白时**不加** -j` | 三种输入都 `not.toContain('-j')`（向后兼容保证） |
| `pickJmeterLogPath 是纯函数` | 空/空白 → `{ok:false,reason:'no-dir'}`；正常目录 → `{ok:true,path:'C:\\out\\jmeter-<stamp>-engine.log'}`；不存在的目录仍算出路径（能不能写由 `canWriteDir` 探） |

> 说明：`electron/jmeter-args.d.ts` **不在本任务 inScope**（改了就是越界），所以新 API 没有同步声明；
> 测试里用 `require` 拿未类型化句柄来测这三个新导出（文件里有注释说明），避免为一个声明文件越界。
> **待办**：下一个能改 `.d.ts` 的任务补 `logPath?: string` 与 `pickJmeterLogPath` / `canWriteDir` 的声明。

## 5. 三条门原始输出（最后一次全量复跑）

```
========== npm run typecheck ==========
> password-manager@1.32.2 typecheck
> tsc --noEmit
exit=0                      （无诊断输出）

========== npm run test:unit ==========
 Test Files  100 passed (100)
      Tests  1471 passed (1471)
   Duration  27.95s
exit=0

========== node scripts/check-ipc-contract.js ==========
IPC 契约检查：handler 221 个 / preload 调用 219 个 / 暴露方法 239 个 / 类型声明 239 个
! 注册了但没人调用（可能是死代码或忘记接线）（2）
    pin:close-all
    pin:count
结果：通过（无 error 级问题）
exit=0
```

占位统计（全仓 grep「该功能尚未实现（W1 骨架）」）：**9 处**（scan 5 / git 2 / allure 2），本任务未增减。

## 6. 遗留 / 待跟进

1. `.d.ts` 声明补齐（见 §4 末尾）——需要一次 inScope 含 `electron/jmeter-args.d.ts` 的小任务。
2. 应用自身的 stdout 捕获日志仍在 `<outDir>/jmeter-<时间戳>.log`，与引擎日志 `-engine` 后缀并存；
   若后续想合并（只留一份引擎日志），需先改 `ipc-jmeter.js:477` 的既有行为，属另一个任务。
3. 本次真跑用的是本机回环 HTTP 服务（127.0.0.1）+ `-Jthreads=2 -Jloops=3`，`samples = 18` 与
   「3 接口 × 2 线程 × 3 循环」一致；csv 参数化脚本库搬家后的可移植性已在 t24 验证过（两次都 18）。