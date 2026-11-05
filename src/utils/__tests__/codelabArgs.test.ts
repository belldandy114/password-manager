import { describe, it, expect } from 'vitest';
import { buildRunPlan, javaClassName, splitSteps, SUPPORTED } from '../../../electron/codelab-args.js';

const RT = {
  nodePath: 'C:/electron.exe',
  pythonPath: 'C:/python.exe',
  javaExe: 'C:/jdk/bin/java.exe',
  javacExe: 'C:/jdk/bin/javac.exe',
};

describe('codelab-args：语言 → 文件 + 命令', () => {
  it('支持 js / python / java', () => {
    expect(SUPPORTED).toEqual(['javascript', 'python', 'java']);
  });

  it('JavaScript 用 node 跑 main.js', () => {
    const p = buildRunPlan({ lang: 'javascript', code: 'console.log(1)', dir: 'D:/t', runtime: RT });
    expect(p.files[0].name).toBe('main.js');
    expect(p.steps).toEqual([{ cmd: RT.nodePath, args: ['main.js'] }]);
  });

  it('Python 用 -u 跑 main.py（不缓冲，输出能实时看到）', () => {
    const p = buildRunPlan({ lang: 'python', code: 'print(1)', dir: 'D:/t', runtime: RT });
    expect(p.files[0].name).toBe('main.py');
    expect(p.steps[0].args).toEqual(['-u', 'main.py']);
  });

  it('Java 先 javac 再 java，文件名跟类名一致', () => {
    const code = 'public class HelloWorld {\n  public static void main(String[] a) { System.out.println("hi"); }\n}';
    const p = buildRunPlan({ lang: 'java', code, dir: 'D:/t', runtime: RT });
    expect(p.files[0].name).toBe('HelloWorld.java');
    expect(p.steps.length).toBe(2);
    expect(p.steps[0]).toEqual({ cmd: RT.javacExe, args: ['HelloWorld.java'] });
    expect(p.steps[1]).toEqual({ cmd: RT.javaExe, args: ['-cp', '.', 'HelloWorld'] });
  });

  it('缺少运行时给出可读错误', () => {
    expect(() => buildRunPlan({ lang: 'python', code: 'x', dir: 'D:/t', runtime: {} })).toThrow(/Python/);
    expect(() => buildRunPlan({ lang: 'java', code: 'class A{}', dir: 'D:/t', runtime: {} })).toThrow(/javac/);
    expect(() => buildRunPlan({ lang: 'ruby', code: 'x', dir: 'D:/t', runtime: RT })).toThrow(/不支持的语言/);
  });
});

describe('codelab-args：Java 类名识别', () => {
  it('优先 public class', () => {
    expect(javaClassName('class A {}\npublic class B {}')).toBe('B');
  });

  it('没有 public 就用第一个 class', () => {
    expect(javaClassName('class Foo { }')).toBe('Foo');
  });

  it('找不到类名兜底 Main', () => {
    expect(javaClassName('// 只有注释')).toBe('Main');
  });

  it('splitSteps：编译失败就不跑最后一步', () => {
    const p = buildRunPlan({ lang: 'java', code: 'public class X{}', dir: 'D:/t', runtime: RT });
    const s = splitSteps(p);
    expect(s.compile.length).toBe(1);
    expect(s.run.length).toBe(1);
    expect(s.run[0].args).toEqual(['-cp', '.', 'X']);
  });
});
