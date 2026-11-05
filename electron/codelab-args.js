'use strict';

/**
 * 在线代码调试：把「语言 + 代码」翻译成「写哪些文件 + 跑哪些命令」（纯函数，便于单测）。
 *
 * 设计取舍：
 * - 只在本机执行（不联网、不沙箱）。界面上必须写明这一点。
 * - Java 需要「public class 名 == 文件名」，所以先从代码里找类名。
 * - Python / Node 直接跑；Java 是两步（javac → java）。
 */

const SUPPORTED = ['javascript', 'python', 'java'];

/** 从 Java 代码里找主类名：优先 public class，其次任意 class，兜底 Main */
function javaClassName(code) {
  const text = String(code || '');
  const pub = /public\s+(?:final\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (pub) return pub[1];
  const any = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(text);
  if (any) return any[1];
  return 'Main';
}

const FILE_NAMES = {
  javascript: 'main.js',
  python: 'main.py',
  java: 'Main.java', // 由 javaClassName 覆盖
};

/**
 * @param {{ lang: string, code: string, dir: string, runtime: { nodePath?: string, pythonPath?: string, javaExe?: string, javacExe?: string } }} input
 * @returns {{ lang: string, files: { name: string, content: string }[], steps: { cmd: string, args: string[], env?: Record<string,string> }[] }}
 */
function buildRunPlan({ lang, code, dir, runtime }) {
  const l = String(lang || '').toLowerCase();
  if (!SUPPORTED.includes(l)) throw new Error(`不支持的语言：${lang}`);
  const src = String(code == null ? '' : code);
  const rt = runtime || {};

  if (l === 'javascript') {
    if (!rt.nodePath) throw new Error('找不到 Node 运行时');
    return {
      lang: l,
      files: [{ name: FILE_NAMES.javascript, content: src }],
      // js 里拼路径交给调用方用 path.join，这里只给文件名引用
      steps: [{ cmd: rt.nodePath, args: [FILE_NAMES.javascript] }],
    };
  }

  if (l === 'python') {
    if (!rt.pythonPath) throw new Error('没有找到 Python（请安装或在设置里指定）');
    return {
      lang: l,
      files: [{ name: FILE_NAMES.python, content: src }],
      steps: [{ cmd: rt.pythonPath, args: ['-u', FILE_NAMES.python] }],
    };
  }

  // java
  if (!rt.javacExe) throw new Error('没有找到 javac（需要 JDK，不是 JRE）');
  if (!rt.javaExe) throw new Error('没有找到 java');
  const cls = javaClassName(src);
  const file = `${cls}.java`;
  return {
    lang: l,
    files: [{ name: file, content: src }],
    steps: [
      { cmd: rt.javacExe, args: [file] },
      { cmd: rt.javaExe, args: ['-cp', '.', cls] },
    ],
  };
}

/**
 * 拆分「编译步骤」与「运行步骤」：编译失败就不该继续跑（否则 java 报 class not found，误导）
 * @param {{ steps: { cmd: string, args: string[] }[] }} plan
 */
function splitSteps(plan) {
  const steps = (plan && plan.steps) || [];
  return { compile: steps.slice(0, Math.max(0, steps.length - 1)), run: steps.length ? [steps[steps.length - 1]] : [] };
}

/** 新建一个随机的临时目录名（不用系统 tmp 之外的依赖） */
function tempDirName(stamp, rand) {
  return `codelab-${stamp}-${rand}`;
}

module.exports = { SUPPORTED, javaClassName, FILE_NAMES, buildRunPlan, splitSteps, tempDirName };
