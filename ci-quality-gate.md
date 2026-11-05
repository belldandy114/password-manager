# CI 质量门禁

**当前状态：已生效**，但入口不是 workflow 文件，而是构建脚本。

## 怎么生效的

`.github/workflows/build.yml` 的「构建安装包」步骤执行的是
`node scripts/build-installer.js`，而这个脚本现在第一步就跑门禁：

```js
step('质量门禁：类型检查', 'npx tsc --noEmit');
step('质量门禁：单元测试', 'npx vitest run');
```

任一步失败 → 脚本 `process.exit(1)` → CI 构建失败 → **不会出安装包、不会发 Release**。

同一套门禁在本地 `npm run dist` 时也会跑（约多 10 秒）。排查构建本身的问题时可以临时跳过：

```bash
SKIP_PREFLIGHT=1 npm run dist   # 仅排查用，正式发版不要跳
```

## 另一层：本地推送门禁

```bash
npm run check          # tsc --noEmit + vitest run
npm run check:pack     # 再加「打包后 CSV 导入」专项（需先 npm run dist）
npm run hooks:install  # 安装 git pre-push 钩子，推送前自动跑一遍
```

## 为什么没有把两步写进 workflow 文件

本机 `gh` 的 token 只有 `gist / read:org / repo`，**没有 `workflow`**，
推送对 `.github/workflows/*` 的任何改动都会被服务端拒绝：

```
! [remote rejected] master -> master
  (refusing to allow an OAuth App to create or update workflow
   `.github/workflows/build.yml` without `workflow` scope)
```

如果以后想让 GitHub UI 上直接看到「类型检查」「单元测试」两个独立步骤（失败时能一眼看出是哪一步），
先人工授权一次：

```bash
gh auth refresh -h github.com -s workflow
```

然后把下面两段插到 `build.yml` 的 `npm ci` 之后：

```yaml
      - name: 类型检查
        run: npm run typecheck

      - name: 单元测试
        run: npm run test:unit
```

这一步属于「更好看」而非「有没有」——门禁本身已经通过构建脚本生效了。