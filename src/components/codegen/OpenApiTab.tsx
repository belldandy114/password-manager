/**
 * 页签①：OpenAPI / Swagger → RestAssured 骨架
 *
 * 粘贴或选文件 → 解析 → 生成 → 预览 → 保存。解析与生成都是纯函数。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { useState, useMemo, useCallback } from 'react';
import { Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import { parseOpenApi } from '../../utils/openapi';
import { generateRestAssured } from '../../utils/codegen/restassured';
import type { GeneratedFile } from '../../utils/codegen/escape';
import type { OpenApiParseOk } from '../../utils/openapi';
import type { RestAssuredInput } from '../../utils/codegen/restassured';
import { saveJavaFile, GeneratedFilesView } from './GeneratedFiles';
import { pathOf, defaultClassName, MAX_SPEC_BYTES_HINT } from './specHelpers';

/* ================================================================
   页签①：OpenAPI → RestAssured
   ================================================================ */

export function OpenApiTab({ addToast }: { addToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  /** 粘贴/文件读入的原文 */
  const [specText, setSpecText] = useState('');
  /** 这份文本是从哪来的（文件名 + 大小），粘贴时显示「粘贴的文本」 */
  const [source, setSource] = useState('');
  const [parsed, setParsed] = useState<OpenApiParseOk | null>(null);
  const [parseErr, setParseErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [className, setClassName] = useState('ApiTest');
  const [packageName, setPackageName] = useState('api');
  const [baseUrl, setBaseUrl] = useState('');
  const [authName, setAuthName] = useState('');
  const [authValue, setAuthValue] = useState('Bearer {{token}}');
  const [baseTestClass, setBaseTestClass] = useState(true);

  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [genErr, setGenErr] = useState('');
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});

  const groups = useMemo(() => {
    if (!parsed) return [];
    const map = new Map<string, number>();
    for (const r of parsed.requests) map.set(r.group, (map.get(r.group) || 0) + 1);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [parsed]);

  /**
   * 解析。**先让界面画一帧再干重活**：大 spec（几 MB）的解析是同步纯函数，
   * 直接调用会让按钮的 disabled 和 BusyProgress 都来不及显示，用户体感就是「点了没反应然后突然出结果」。
   */
  const parse = useCallback(async (text: string) => {
    setBusy(true);
    setParseErr('');
    setGenErr('');
    setFiles([]);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const res = parseOpenApi(text, baseUrl.trim() ? { baseUrl: baseUrl.trim() } : undefined);
      if (!res.ok) {
        setParsed(null);
        setParseErr(res.error);
        return;
      }
      setParsed(res);
      setBaseUrl((prev) => prev.trim() || res.baseUrl);
      // 类名只在用户没改过（还是默认值）时跟着标题走，改过就不动
      setClassName((prev) => (prev === 'ApiTest' || !prev.trim() ? defaultClassName(res.title) : prev));
      if (res.requests.length === 0) {
        addToast('解析成功，但这份文档里没有可生成的接口', 'error');
      } else {
        addToast(`解析出 ${res.requests.length} 个接口`, 'success');
      }
    } catch (e) {
      setParsed(null);
      setParseErr('解析失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }, [addToast, baseUrl]);

  /** 路径一：真选文件（.json / .yaml / .yml）—— §8 里 1.1 的硬要求，只粘贴不算 */
  const pickFile = async () => {
    const r = await window.electronAPI.pickFile('选择 OpenAPI / Swagger 文件', [
      { name: 'OpenAPI（json / yaml）', extensions: ['json', 'yaml', 'yml'] },
    ]);
    if (!r.success) {
      if (!r.canceled) addToast(r.error || '选择文件失败', 'error');
      return;
    }
    const file = r.data?.file || '';
    if (!file) return;
    const read = await window.electronAPI.readTextFile(file);
    if (!read.success || !read.data) {
      addToast(read.error || '读取文件失败', 'error');
      return;
    }
    setSpecText(read.data.text);
    const kb = (read.data.size / 1024).toFixed(1);
    setSource(`${read.data.name}（${kb} KB · ${read.data.encodingLabel || read.data.encoding || 'utf-8'}）`);
    if (read.data.size > MAX_SPEC_BYTES_HINT) addToast('文本较大，解析可能需要几秒', 'info');
    await parse(read.data.text);
  };

  /** 路径二：粘贴文本 */
  const parsePasted = async () => {
    if (!specText.trim()) {
      setParseErr('还没有内容：先选一个 .json/.yaml 文件，或把 OpenAPI 文本粘到下面');
      return;
    }
    setSource((prev) => prev || '粘贴的文本');
    await parse(specText);
  };

  const generate = async () => {
    if (!parsed) return;
    setBusy(true);
    setGenErr('');
    setFiles([]);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const input: RestAssuredInput = {
        className: className.trim() || defaultClassName(parsed.title),
        packageName: packageName.trim() || 'api',
        baseUrl: (baseUrl.trim() || parsed.baseUrl),
        requests: parsed.requests,
        baseTestClass,
        ...(authName.trim() ? { authHeader: { name: authName.trim(), value: authValue } } : {}),
      };
      const res = generateRestAssured(input);
      if (!res.ok) {
        setGenErr(res.error);
        return;
      }
      setFiles(res.files);
      if (res.warnings.length) addToast(`已生成，但有 ${res.warnings.length} 条告警`, 'info');
      else addToast(`已生成 ${res.files.length} 个文件`, 'success');
    } catch (e) {
      setGenErr('生成失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async (file: GeneratedFile, defaultName: string) => {
    await saveJavaFile(file, defaultName, addToast, setSavedAt);
  };

  return (
    <div>
      {busy && <BusyProgress active label="处理中…" />}

      <Panel
        title="① 导入接口文档"
        meta={source || undefined}
        tools={
          <div className="tool-inline" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void pickFile()} disabled={busy}>
              <Icons.folder size={13} /> 选择文件
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void parsePasted()} disabled={busy}>
              <Icons.refresh size={13} /> 解析文本
            </button>
          </div>
        }
      >
        <Field
          label="OpenAPI / Swagger 文本（JSON 或 YAML）"
          hint="两条路都行：点右上「选择文件」真选一个 .json/.yaml/.yml；或把文本粘到下面再点「解析文本」。"
        >
          <textarea
            className="code-input"
            value={specText}
            onChange={(e) => setSpecText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void parsePasted();
              }
            }}
            placeholder={'openapi: 3.0.3\ninfo:\n  title: Pet Store API\n  version: 1.0.0\npaths:\n  /pets:\n    get:\n      operationId: listPets\n      responses:\n        "200":\n          description: OK'}
            spellCheck={false}
            aria-label="OpenAPI 文本"
            style={{ minHeight: 150 }}
          />
        </Field>

        {parseErr && (
          <div className="dev-banner is-error" role="alert">
            <Icons.bug size={14} />
            <div className="text-sm">{parseErr}</div>
          </div>
        )}
      </Panel>

      {/* ---- 解析预览：接口数 / 分组 / 告警（告警常显，不折叠） ---- */}
      {parsed && (
        <>
          <Panel title="② 解析预览" meta={`${parsed.requests.length} 个接口`}>
            <div className="tool-inline" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <span className="dev-tag is-ok">
                <Icons.check size={13} />
                {parsed.spec === 'swagger2' ? 'Swagger 2.0' : `OpenAPI ${parsed.oasVersion}`}
              </span>
              <span className="dev-tag is-ok">
                <Icons.list size={13} />
                {parsed.requests.length} 个接口
              </span>
              <span className="dev-tag is-ok">
                <Icons.server size={13} />
                {parsed.baseUrl}
              </span>
              {parsed.warnings.length > 0
                ? (
                  <span className="dev-tag is-heur">
                    <Icons.bug size={13} />
                    {parsed.warnings.length} 条告警
                  </span>
                )
                : (
                  <span className="dev-tag is-ok">
                    <Icons.check size={13} />
                    无告警
                  </span>
                )}
              {parsed.version ? <span className="dev-tag is-unknown">文档版本 {parsed.version}</span> : null}
            </div>

            {/* 告警：一条一句、默认展开。这些是用户判断「导入是否完整」的唯一依据（webhooks /
                callbacks / oneOf / discriminator 都落在这里），折叠起来等于把缺口藏起来。 */}
            {parsed.warnings.length > 0 && (
              <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
                {parsed.warnings.map((w) => (
                  <div className="dev-banner is-warn" key={w}>
                    <Icons.bug size={14} />
                    <div className="text-sm">{w}</div>
                  </div>
                ))}
                <div className="text-sm text-muted">
                  以上内容本批没有完整支持，已按告警里写的方式降级（截断 / 取首个分支 / 跳过）。
                  接口数与上面这个数字一致，但个别接口的请求体或鉴权可能不完整。
                </div>
              </div>
            )}

            {parsed.requests.length === 0
              ? (
                <Empty
                  icon={<Icons.inbox size={22} />}
                  title="解析成功，但这份文档里没有接口"
                  desc="paths 里没有任何 http 方法（get/post/put/delete/patch/head/options/trace）。"
                  hint="常见原因：只写了 components/schemas 没写 paths；或这是 asyncapi 之类的别的规范。"
                />
              )
              : (
                <>
                  <div className="text-sm text-muted" style={{ marginBottom: 6 }}>
                    分组：{groups.map(([g, n]) => `${g}（${n}）`).join(' · ')}
                  </div>
                  <div className="dev-scroll" style={{ maxHeight: 300 }}>
                    <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                      <thead>
                        <tr>
                          <th scope="col" style={{ width: 72 }}>方法</th>
                          <th scope="col">路径</th>
                          <th scope="col" style={{ width: 120 }}>分组</th>
                          <th scope="col" style={{ width: 96 }}>请求体</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.requests.map((r, i) => (
                          <tr key={`${r.method}-${r.url}-${i}`}>
                            <td><span className="dev-tag is-unknown">{r.method}</span></td>
                            <td title={r.url} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {pathOf(r.url, parsed.baseUrl)}
                            </td>
                            <td>{r.group}</td>
                            <td>{r.bodyType}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
          </Panel>

          {/* ---- 生成参数 + 生成 ---- */}
          {parsed.requests.length > 0 && (
            <Panel
              title="③ 生成 RestAssured 骨架"
              tools={
                <button className="btn btn-primary btn-sm" onClick={() => void generate()} disabled={busy}>
                  <Icons.tool size={13} /> 生成代码
                </button>
              }
            >
              <div className="grid2" style={{ gap: 12 }}>
                <Field label="类名">
                  <input value={className} onChange={(e) => setClassName(e.target.value)} placeholder="PetStoreApiTest" />
                </Field>
                <Field label="包名" hint="缺省 api；会逐段归一成合法包名">
                  <input value={packageName} onChange={(e) => setPackageName(e.target.value)} placeholder="api" />
                </Field>
                <Field label="baseUrl" hint={'生成的代码里走 System.getProperty("baseUrl")，跑测试时 -DbaseUrl=… 可覆盖'}>
                  <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
                </Field>
                <Field label="鉴权头（可选）" hint={'常见：Authorization / Bearer {{token}}。留空则用文档里的 security'}>
                  <div className="tool-inline" style={{ gap: 6 }}>
                    <input
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      placeholder="Authorization"
                      aria-label="鉴权头名称"
                      style={{ width: 140 }}
                    />
                    <input
                      value={authValue}
                      onChange={(e) => setAuthValue(e.target.value)}
                      placeholder={'Bearer {{token}}'}
                      aria-label="鉴权头取值"
                    />
                  </div>
                </Field>
              </div>

              <label className="checkbox-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={baseTestClass}
                  onChange={(e) => setBaseTestClass(e.target.checked)}
                />
                <span className="text-sm">额外生成 BaseTest.java（baseUrl 收敛到一处，多接口时推荐）</span>
              </label>

              {genErr && (
                <div className="dev-banner is-error" role="alert" style={{ marginTop: 8 }}>
                  <Icons.bug size={14} />
                  <div className="text-sm">{genErr}</div>
                </div>
              )}

              {files.length > 0 && (
                <>
                  <div className="dev-banner is-info" style={{ marginTop: 8 }}>
                    <Icons.check size={14} />
                    <div className="text-sm">
                      已生成 {files.length} 个文件。**先看一眼再保存**：保存会弹系统保存框，逐个文件写入，
                      不会覆盖你原来的工程（代码生成从不自动写盘）。
                    </div>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <GeneratedFilesView files={files} defaultSaveName={`${className || 'ApiTest'}.java`} onSave={(f, n) => void saveFile(f, n)} />
                  </div>
                  {Object.keys(savedAt).length > 0 && (
                    <div className="text-sm text-muted" style={{ marginTop: 6 }}>
                      已保存：{Object.entries(savedAt).map(([p, abs]) => `${p.split('/').pop()} → ${abs}`).join('；')}
                    </div>
                  )}
                </>
              )}
            </Panel>
          )}
        </>
      )}

      {!parsed && !parseErr && (
        <Panel title="② 解析预览">
          <Empty
            icon={<Icons.upload size={22} />}
            title="还没有导入接口文档"
            desc="点右上「选择文件」真选一个 .json / .yaml / .yml，或把文本粘到上面点「解析文本」。"
            hint="解析是纯函数、在本机跑，不会上传；解析出的告警会一条一条列出来，告诉你哪些接口没能完整生成。"
          />
        </Panel>
      )}
    </div>
  );
}