# update-and-release（AGENTS.md 历史段落存档）

> 这些内容从 `AGENTS.md` 搬出，原文未改。AGENTS.md 里保留摘要与指针，
> 目的是让 AGENTS.md 回到工作区指令预算（65,536 B）以内，否则后半部分会被截断。

### 发布新版本（远程更新完全依赖 GitHub Releases）

应用内「检查更新」读的是 `https://api.github.com/repos/belldandy114/password-manager/releases/latest`，
**只提交 git 是不够的**，必须发 Release 并挂上安装包，否则所有人的「检查更新」永远停在旧版本（之前停在 v1.0.2）。

```bash
npm run dist                                     # → release/测试工具 Setup 1.2.6.exe
cp "release/测试工具 Setup 1.2.6.exe" "release/PasswordManager-Setup-1.2.6.exe"
gh release create v1.2.6 "release/PasswordManager-Setup-1.2.6.exe" \
  --title "测试工具 v1.2.6" --notes-file notes.md --latest --target master
```

- ⚠️ **上传前必须改成英文文件名**：中文名会被 GitHub 改写（`测试工具 Setup 1.2.6.exe` → `Setup.1.2.6.exe`）。
- `release/` 在 `.gitignore` 里，exe 不进 git，只能通过 Release 附件分发。
- 发布后自检：`gh release view v1.2.6 --json assets`（state=uploaded、size 对得上）；
  `curl -s .../releases/latest | grep tag_name` 应为 `v1.2.6`。
- 应用端 `updateCheck()` 会返回 `{current, latest, hasUpdate, url, notes}`，`url` 指向 Release 页；
  安装包是 NSIS，`/S /currentuser` 可静默覆盖安装，密码库数据不受影响。

### 禅道 Bug 重现步骤里的截图（file-read-*.png 需要登录态）

页面里的 `<img src="/zentao/file-read-29218.png">` **不能在渲染层直接当 src 用** ——
渲染进程的 `<img>` 不会带禅道的 Cookie，只会显示裂图/空白，所以之前只能显示 `[图片]` 占位。

正确做法（已实现，`zentao:bug-detail` 内）：
1. 解析时把 `img src` 转绝对地址，按出现顺序去重，正文里用 `[图1] [图2]` 占位对应；
2. 主进程 `ztFetchBinary(cfg, url)` 带上 `ztCookieHeader()` 取二进制（跟随 302，单张上限 8MB）；
3. 转 `data:image/png;base64,...` 返回给渲染层，抽屉里直接 `<img src={dataUrl}>` 显示；
4. 最多取 12 张，失败数放进 `imageFailed` 提示用户去浏览器看原图。

验证脚本：`node scripts/ui-bug-image-test.js`（断言 steps 里有 `[图N]`、images 长度、`naturalWidth > 0`）。
实测 Bug #14171：2 张图均取回（1920×953），dataURL 约 210KB / 50KB。

### ⚠️ 应用内更新（检查 + 下载）都必须用 Electron `net`，不要用 Node `fetch`

Node 的 `fetch`（undici）**不读系统代理**：公司/家里只配了系统代理时 `api.github.com` 直接连不上，
表现为「检查更新」转圈 10 秒；下载更是只会抛一句 `fetch failed`（信息量为零）。
现在 `fetchLatestRelease()` 与 `netDownload*` 都走 `net.request`（Chromium 网络栈）：跟随系统代理，
能拿到 `HTTP 404` 这类真实原因。实测本机直连 GitHub Release 附件 502 / 0 B/s，
走 `127.0.0.1:7890` 代理 1.6~2.9 MB/s；本地 `http://127.0.0.1` 桩服务 `resolveProxy` 返回 `DIRECT`，回归脚本不受影响。

- **公共免费镜像已废弃**：`ghfast.top` 走代理连不上、`gh-proxy.com` 只有 1.6 KB/s（直连 50~173 KB/s），
  点「换镜像」只会更慢。1.21.4 起 `UPDATE_MIRRORS` 移除，改为可选自定义源
  （`settings.updateMirrorUrl` / `PM_UPDATE_MIRROR` 环境变量），没配就只走 GitHub。
- ⚠️ **不要再自动切并行**（1.21.4 的「6 秒慢速 / 60 秒无数据自动改 6 分片」已在 1.21.6 撤销，
  1.21.7 又把 `netDownload` 里的慢速中止代码整段删掉）：
  公司环境里只是中途停顿的正常下载会被 60 秒规则误杀；切分片后 `update/parts-*` 目录
  又容易触发杀软隔离，写 `chunk-0.bin` 直接 `ENOENT`，结果是**完全下不了**（比慢更糟）。
  现在默认纯单连接 + 30 分钟总超时；`parts-*` 目录**只在用户显式启用并行时**才创建；
  单连接与并行两条路径的 `createWriteStream` 都必须监听 `error`。
  默认行为由 `scripts/ui-round9-test.js` 的「慢速桩（1MB/8 块/每块停 1.2s）」用例锁住：
  断言 `threads===1`、`verified===true`、`update/` 下无 `parts-*` 残留。改这里必须同步改该用例。
- **安装包执行白名单**：`update:install` 只执行 `update/` 目录内、或经 `update:pick-file` 对话框
  选中的 exe（模块作用域 `allowedInstallFiles`），拒绝渲染层传来的任意路径。
- **摘要缺失不静默**：`expectedSha256` 为空时下载仍成功但 `verified=false`；弹窗取消自动倒计时安装
  并显示警示，设置页也显示「未校验」提示。`PM_UPDATE_API` 在打包版只放行 `127.0.0.1/localhost` 桩服务。
- **设置项**：设置 › 通用里可填 `updateMirrorUrl`（国内直链前缀，只接受干净 http(s)）与
  `updateCheckIntervalHours`（0 = 仅启动查一次，默认）。两者都经 `settings:get` 读回，别只在主进程加字段。
- **链路诊断**：`session.defaultSession.resolveProxy(url)` 的结果经 `proxyLabel()` 变成
  「经代理 x.x.x.x」/「直连」推给 `update:progress`，弹窗显示「直连 · 检查 VPN 分流」。
  家里慢多半就是规则没放行 `github.com` / `*.githubusercontent.com`（302 到 `release-assets.githubusercontent.com`）。
- 失败时的兜底顺序：`浏览器下载`（发布页）→ `选择本地安装包`（`update:pick-file`）→ `加速重试`（用户手动，多线程并行）。
- 回归脚本（都在仓库内）：`scripts/ui-round9-test.js` 的 `R9_ONLY=update` 段覆盖
  落盘位置 / SHA-256 校验 / 摘要不符拒绝 / 6 分片 / **慢速停顿仍是单连接**；
  `scripts/ui-dl-time-test.js` 验证打包版检查更新与失败兜底文案。
  不要再用项目外 `_scope/` 里的临时探针作为长期依据。
- 安装**不要默认 `/S` 静默**：静默装的是默认目录，用户装到 `E:/password-manager` 会变成两份。
  默认走安装向导（`spawn(file, [])` + `app.quit()`）；静默才传 `['/S', '/D=<当前 exe 目录>']`。

### ⚠️ 发布时 CI 会覆盖 Release 说明（token 没有 workflow scope）

`.github/workflows/build.yml` 在打 tag 时会用 `softprops/action-gh-release` 建 Release，
body 是**写死的模板**，把我们 `gh release create --notes-file` 的说明覆盖掉（v1.2.6~v1.3.2 都中过），
还会额外上传一个中文名附件（被 GitHub 改名为 `Setup.1.3.2.exe`）。

- 本机 gh token 只有 `gist / read:org / repo`，**没有 `workflow`**，所以推不上去 workflow 的改动
  （`refusing to allow an OAuth App to create or update workflow ... without workflow scope`）。
  想根治得先 `gh auth refresh -h github.com -s workflow`（需浏览器授权）。
- 推荐工作流在 `scripts/ci-build.yml.recommended`：只在 `v*` tag 构建、CI 不再创建 Release /
  传附件 / 写说明，Release 全部交给 `release.js`（去掉双写）。把它手动覆盖到 workflow 路径即可。
  旧补丁 `ci-workflow-rename.patch.txt` 只改产品名，已不推荐。
- `release.js` 第 8 步对新旧 CI 都幂等：删掉旧 CI 多传的 `Setup.<ver>.exe`、用本地 notes 回填说明、
  核对附件与 latest。即使 workflow 还没更新，发布也不会坏。

