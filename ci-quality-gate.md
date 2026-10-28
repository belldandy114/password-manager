# CI 质量门禁（待启用）

`.github/workflows/build.yml` 里要加的两步：

```yaml
      - name: 类型检查
        run: npm run typecheck

      - name: 单元测试
        run: npm run test:unit
```

位置：`npm ci` 之后、「安装子应用依赖」之前。

## 为什么还没加进 workflow

本机 `gh` 的 token 只有 `gist / read:org / repo`，**没有 `workflow`**，
推送任何对 `.github/workflows/*` 的改动都会被服务端拒绝：

```
! [remote rejected] master -> master
  (refusing to allow an OAuth App to create or update workflow
   `.github/workflows/build.yml` without `workflow` scope)
```

## 启用方法（需要人工授权一次）

```bash
gh auth refresh -h github.com -s workflow
```

浏览器里点授权后，把上面的两步贴进 `build.yml`、提交、推送即可；
或者直接 `git cherry-pick` 下面这个补丁。

## 在这之前：本地门禁

```bash
npm run check          # tsc --noEmit + vitest run
npm run check:pack     # 再加「打包后 CSV 导入」专项
```

`npm run hooks:install` 会把 `scripts/preflight.js` 装成 git `pre-push` 钩子，
推送前自动跑一遍——效果等同 CI 门禁，只是发生在本地。