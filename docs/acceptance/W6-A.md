# W6-A Git 只读域验收证据（t37）

> 任务：模块 6「Git 影响面」主进程侧 —— 纯函数命令白名单 + `-z` 双段解析 + `git:probe` / `git:diff` 两条只读通道。
> 本文件是长证据唯一落点；`update_task` 里每条 evidence ≤200 字并指向本文件章节。
> 环境：Windows 11 + **git 2.39.1.windows.1** + Node 22.22。运行时间 2026-11-24 12:05–12:25。

## 1. 改动清单（5 个 inScope 文件）

| 文件 | 内容 |
|---|---|
| `electron/git-args.js`（新） | 只读命令白名单（`buildProbeArgs` / `buildDiffArgs`）、`-z` 解析（`parseStatusZ` / `parseNumstatZ`）、`statusOf`、`filterByScope`、`mergeDiff`、`MAX_FILES`、`WRITE_COMMANDS`。**只 require `path`** |
| `electron/git-args.d.ts`（新） | 上述 API 的类型声明 |
| `electron/ipc-git.js` | 2 条通道落地：spawn（`shell:false`、`GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`GIT_PAGER=cat`）+ 10 s 超时杀树 + C-60 错误文案 |
| `src/utils/__tests__/gitArgs.test.ts`（新） | **25 条**单测 |
| `docs/acceptance/W6-A.md`（新） | 本文件 |

## 2. 安全面：为什么「没有任意参数口子」是结构性的

`ipc-git.js` 的 `git:diff` 只从 payload 里读两个字段：`root`、`scope`。
**`args` / `extra` / 任何其它字段一律不读**，命令来自 `buildDiffArgs(scope)` 的四条白名单之一：

```
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
git status --porcelain -z
git diff --numstat -z [--cached | HEAD]
```

三重保护叠加：
1. **结构上无口子**：不存在把用户字符串拼进 argv 的代码路径；
2. **`spawn(..., { shell: false })`**：即便将来有人把文件名写进参数，也不经过 shell，`;`、反引号、`$(...)` 都不会被解释；
3. **`WRITE_COMMANDS` 单测**：遍历全部白名单 argv，断言 `commit/push/checkout/stash/reset/clean/config/merge/rebase/rm/add` 一个都不出现。

## 3. `-z` 段序：**实测 git 为准确认了契约的一处错误**

用真实 git 造 rename 后抓原始字节（脚本见 §4 复现方式）：

```
--- git status --porcelain -z ---
  raw = "M  other.txt\0R  新名字 file.txt\0old name.txt\0"
--- git diff --numstat -z --cached ---
  raw = "1\t1\tother.txt\00\t0\t\0old name.txt\0新名字 file.txt\0"
```

| 格式 | 实测段序 | 契约 §2.3 写的 | 结论 |
|---|---|---|---|
| `status --porcelain -z` 的 rename | `R  <新路径>\0<旧路径>\0`（**新在前**） | `R  old\0new\0` | ❌ **契约写反了**，实现按实测 |
| `diff --numstat -z` 的 rename | `add\tdel\t\0<旧>\0<新>\0`（**旧在前**） | 同 | ✅ 一致 |

这条差异如果照契约实现，rename 的 `path`/`origPath` 会**对调**——界面上就是「改名后的文件显示成改名前」。
单测 `parseStatusZ` 的那条 rename 用例里写明了「实测 git 2.39.1」，防止后人按契约改回去。

两条解析都用**段号指针**推进（rename 一次消费两段/三段），并各有一条「rename 后面紧跟普通条目」的回归：
少消费一段时后面所有条目整体错位，这条用例会立刻红。

## 4. 安全取证：恶意文件名仓库（这条最关键）

在一个真实 git 仓库里创建这些文件名（`;`、反引号、`$()`、`&& ` 全部齐活），`git add -A` 后跑 `git:diff`：

```
已创建文件名 = ["evil; rm -rf important.txt","back`whoami`.txt","dollar $(whoami).txt","amp && echo pwned.txt"]
git:diff(staged) success = true  files = 4
返回的路径 = ["amp && echo pwned.txt","back`whoami`.txt","dollar $(whoami).txt","evil; rm -rf important.txt"]

每个恶意文件名都原样出现（含分号、反引号、$()、&&）→ PASS
SENTINEL.txt 未被删除（rm -rf 没执行）           → PASS
base.txt 仍在                                    → PASS
HEAD 未变（没有 commit/push）                     → PASS
目录条目数 = 6（4 个恶意文件 + base.txt + SENTINEL.txt）→ PASS

传 { root, args: ['push'], extra: ['--force'] } 后结果与不带时**完全一致** → PASS
HEAD 仍未变                                                       → PASS
```

也就是说：**命令没被注入**，而且「渲染层想塞参数」这条路径根本不存在（payload 里那两个字段没人读）。

### 4.1 两处诚实的限制

1. **含换行的文件名在 Windows 上建不出来**（`fs.writeFileSync` 直接 `ENOENT`），所以 E2E 那条断言是 FAIL。
   换行场景改在**解析层**单测覆盖：`parseStatusZ` 的「路径里含换行也原样保留」用例（`-z` 按 NUL 切段，
   路径里的 `\n` 不会被误当分隔符）。这是平台限制，不是实现缺陷。
2. 我最初还试了带 `|`、`"` 的文件名，Windows 同样拒绝（`ENOENT`），脚本已按「跳过并打印原因」处理，
   不静默丢用例。

## 5. 端到端：1 修改 / 1 新增 / 1 重命名 / 1 已暂存修改

仓库：`keep.txt` 改内容（未暂存）、`new.txt` 新增并 `git add`、`git mv rename-me.txt renamed.txt`、
`staged-only.txt` 改内容并 `git add`。

```
git:probe = {"isRepo":true,"branch":"master","head":"4faddb8","dirty":true}   → PASS

unstaged = [{"path":"keep.txt","status":"modified","additions":1,"deletions":1}]
staged   = [{"path":"new.txt","status":"added","additions":1,"deletions":0},
            {"path":"renamed.txt","status":"renamed","additions":0,"deletions":0,"origPath":"rename-me.txt"},
            {"path":"staged-only.txt","status":"staged-modified","additions":1,"deletions":1}]
head     = 上面三个 + keep.txt（HEAD→工作区全量）

staged 里新增 status=added                    → PASS
staged 里 rename 的 old/new 都对               → PASS
unstaged 里 keep.txt status=modified 且行数>0  → PASS
staged 修改 staged-only.txt status=staged-modified → PASS
truncated 均为 false                           → PASS
```

**实跑抓到的设计缺陷（已修 + 补测试）**：第一版 `staged` 里混进了 `keep.txt`——它只在工作区改过，
却被 `status`（覆盖整个工作区）带了出来。修法：新增纯函数 `filterByScope`（staged 只留索引侧 `X` 有改动、
unstaged 只留工作区侧 `Y` 有改动与未跟踪 `??`、head 全留），`git:diff` 先过滤再合并；
补 3 条单测（staged/unstaged/head）。修后 `unstaged` 只剩 `keep.txt`、`staged` 只剩三个真正的暂存改动。

## 6. 错误路径（C-60 文案逐条）

```
目录不存在      → {"success":false,"error":"目录不存在"}
不是 git 仓库   → {"success":false,"error":"不是 git 仓库"}          （probe）
不是 git 仓库   → {"success":false,"error":"不是 git 仓库"}          （diff，带 scope）
未知 scope      → {"success":false,"error":"未知的 diff 范围：push"}  （不拼进命令）
root 空         → {"success":false,"error":"目录不存在"}
```

非 git 目录返回的是**可读中文**，不是把 git 的英文 stderr 吐出去（`runGit` 里对
`not a git repository` 做了识别与转换）。`git 不可用（未安装或不在 PATH）` 由 `child.on('error')` 的
`ENOENT` 分支给出；`命令超时（10 秒）` 由 10 s 定时器 + `taskkill /T /F`（Windows）/ `SIGKILL` 给出。

## 7. 单测分布（25 条）

| 分组 | 条数 | 覆盖 |
|---|---|---|
| 命令白名单 | 5 | 三条 probe 命令逐字、三种 scope 逐字、未知 scope 拒绝、防御性拷贝（调用方改返回值不影响下次）、无写命令 |
| `parseStatusZ` | 6 | 普通条目、**rename 双段（新在前）**、**rename 后紧跟普通条目不错位**、空格/中文/制表符路径、**路径含换行**、空输入 |
| `parseNumstatZ` | 5 | 普通条目、二进制 `-`、**rename 双段（旧在前）**、**rename 后不错位**、空 diff |
| `filterByScope` | 3 | staged / unstaged / head 各自只留该范围改动 |
| `statusOf` | 2 | 六种状态映射、`-binary` 后缀 |
| `mergeDiff` | 4 | 合并状态+行数+rename old/new、二进制、**超 2000 截断**、空改动 |

## 8. 三条门原始输出

```
========== npm run typecheck ==========   tsc --noEmit 无诊断，exit=0
========== npm run test:unit ==========  （见回执；本任务新增 gitArgs.test.ts 25 条）
========== node scripts/check-ipc-contract.js ==========
IPC 契约检查：handler 221 个 / preload 调用 219 个 / 暴露方法 239 个 / 类型声明 239 个
! 注册了但没人调用（2）：pin:close-all、pin:count
结果：通过（无 error 级问题）exit=0
```

占位：**4 → 2**（清掉 `git:` 2 条，剩 `ipc-allure.js` 2 条给 W6-B）。

## 9. 需要队长裁定 / 契约修订一条

**契约 §2.3 的 `status --porcelain -z` rename 段序写反了**：实际是 `R  <新路径>\0<旧路径>\0`。
建议把该行改成「rename/copy 是两段：**新路径在前、旧路径在后**（`diff --numstat -z` 相反，旧在前）」。
我没有改契约文档（不在 inScope），实现按实测走，单测里也写了「实测 git 2.39.1」的注释防止被改坏。

## 10. 遗留

- `src/utils/gitImpact.ts` / `src/pages/CodeAudit.tsx`（前端）不在 inScope。
- `git:probe` 的 `dirty` 目前按「`status --porcelain` 有任何条目」判定（含未跟踪文件）。
  若产品希望「未跟踪不算 dirty」，是 `filterByScope` 一行过滤的事，但需要先改契约口径。
- 空仓库（还没有 commit）时 `rev-parse` 会失败：probe 的 `branch`/`head` 记空串、
  `scope=head` 的 diff 返回空改动（不报错），已实现但未单独取证。