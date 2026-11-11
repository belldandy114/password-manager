import React, { useMemo, useState } from 'react';
import { buildTimeline, timelineToText, formatDuration } from '../../utils/timeParse';
import { useToolState, useToolResult, copyText, ToolBlock } from './shell';

/* ============================ 时间轴 / 耗时 ============================ */

export function TimelineTool() {
  const [text, setText] = useToolState('input', '');
  const [copied, setCopied] = useState(false);

  const { rows, error } = useMemo(() => buildTimeline(text), [text]);
  const okRows = rows.filter((r) => !r.error);
  const total = okRows.length > 1 ? okRows[okRows.length - 1].ms - okRows[0].ms : 0;
  const outText = rows.length ? timelineToText(rows) : '';
  useToolResult(outText);

  return (
    <div className="tb-stack">
      <div className="tb-row">
        <span className="text-sm text-muted">每行一个时间（时间戳或日期都行）：自动算相邻间隔与相对首行的累计耗时</span>
        <span className="tb-row-spacer" />
        {okRows.length > 1 && <span className="tb-badge">总耗时 {formatDuration(total)}</span>}
        <button className="btn btn-ghost btn-sm" onClick={async () => { if (outText && await copyText(outText)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }} disabled={!outText}>{copied ? '已复制' : '复制结果'}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setText('')}>清空</button>
      </div>

      <div className="tb-panes">
        <ToolBlock title="时间列表">
          <textarea
            className="tb-textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={'1700000000000\n1700000005000\n2026-11-02 14:07:59'}
          />
        </ToolBlock>

        <ToolBlock title="时间轴">
          {error && <div className="json-error"><div className="json-error-msg">{error}</div></div>}
          {!error && !rows.length && <div className="tb-empty">左侧粘贴时间，这里按顺序显示间隔</div>}
          {!error && rows.length > 0 && (
            <div className="tl-list">
              {rows.map((r, i) => (
                <div key={i} className={`tl-row${r.error ? ' is-bad' : ''}`}>
                  <span className="tl-idx">{i + 1}</span>
                  <span className="tl-time">{r.error ? r.raw : r.local}</span>
                  <span className="tl-gap">{r.error ? r.error : i === 0 ? '起点' : `+${formatDuration(r.delta)}`}</span>
                  {!r.error && <span className="tl-sum">{formatDuration(r.offset)}</span>}
                </div>
              ))}
              {okRows.length > 1 && <div className="tl-total">总耗时 {formatDuration(total)}</div>}
            </div>
          )}
        </ToolBlock>
      </div>

      <div className="text-sm text-muted">单位按位数自动识别（10 位=秒、13 位=毫秒、16 位=微秒、19 位=纳秒），混着写也能算；坏行只标红那一行，不影响其它行。</div>
    </div>
  );
}

/* ============================ 图片 Base64 / 二维码 ============================ */

export function MediaTool() {
  const [tab, setTab] = useToolState<'image' | 'qrcode'>('tab', 'qrcode');
  const [qrText, setQrText] = useToolState('qrText', 'https://github.com/belldandy114/password-manager');
  const [qrSize, setQrSize] = useToolState('qrSize', 256);
  const [qrUrl, setQrUrl] = useState('');
  const [imgName, setImgName] = useState('');
  const [imgDataUrl, setImgDataUrl] = useState('');
  const [imgError, setImgError] = useState('');
  const [msg, setMsg] = useState('');

  useToolResult(tab === 'qrcode' ? qrText : imgDataUrl ? imgDataUrl.split(',')[1] || '' : '');

  const makeQr = async () => {
    setMsg('');
    if (!qrText.trim()) { setMsg('先输入要编码的文本'); return; }
    try {
      const QR = await import('qrcode');
      const url = await QR.toDataURL(qrText, { width: qrSize, margin: 1, errorCorrectionLevel: 'M' });
      setQrUrl(url);
    } catch (e) {
      setMsg(`生成失败：${(e as Error).message}`);
    }
  };

  const pickImage = (file: File | undefined) => {
    setImgError('');
    setImgDataUrl('');
    setImgName('');
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { setImgError('图片超过 8MB，换一张小的'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      setImgName(`${file.name} · ${(file.size / 1024).toFixed(1)} KB`);
      setImgDataUrl(String(reader.result || ''));
    };
    reader.onerror = () => setImgError('读取失败');
    reader.readAsDataURL(file);
  };

  return (
    <div className="tb-stack">
      <div className="tb-subtabs" role="tablist" aria-label="图片与二维码">
        <button role="tab" aria-selected={tab === 'qrcode'} className={`tb-subtab${tab === 'qrcode' ? ' is-on' : ''}`} onClick={() => setTab('qrcode')}>二维码</button>
        <button role="tab" aria-selected={tab === 'image'} className={`tb-subtab${tab === 'image' ? ' is-on' : ''}`} onClick={() => setTab('image')}>图片 Base64</button>
      </div>

      {tab === 'qrcode' ? (
        <div className="tb-panes">
          <ToolBlock title="内容（文本 / 链接 / 任意字符串）">
            <textarea className="tb-textarea tb-textarea-sm" value={qrText} onChange={(e) => setQrText(e.target.value)} spellCheck={false} placeholder="https://example.com" />
            <div className="tb-row tb-row-tight">
              <span className="text-sm text-muted">尺寸</span>
              <select className="json-indent" value={qrSize} onChange={(e) => setQrSize(Number(e.target.value))} aria-label="尺寸">
                {[128, 192, 256, 384, 512].map((s) => <option key={s} value={s}>{s}px</option>)}
              </select>
              <button className="btn btn-primary btn-sm" onClick={makeQr}>生成二维码</button>
              {qrUrl && <a className="btn btn-ghost btn-sm" href={qrUrl} download="qrcode.png">下载 PNG</a>}
            </div>
            {msg && <div className="text-sm text-muted">{msg}</div>}
          </ToolBlock>

          <ToolBlock title="预览">
            {qrUrl
              ? <div className="qr-box"><img src={qrUrl} alt="二维码" className="qr-img" /></div>
              : <div className="tb-empty">点「生成二维码」</div>}
          </ToolBlock>
        </div>
      ) : (
        <div className="tb-panes">
          <ToolBlock title="选择图片（不联网，只在本地读取）">
            <input
              className="tb-input"
              type="file"
              accept="image/*"
              aria-label="选择图片"
              onChange={(e) => pickImage(e.target.files?.[0])}
            />
            {imgName && <div className="tb-badge">{imgName}</div>}
            {imgError && <div className="json-error"><div className="json-error-msg">{imgError}</div></div>}
            {imgDataUrl && (
              <>
                <div className="tb-divider" />
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => { if (await copyText(imgDataUrl.split(',')[1] || '')) setMsg('已复制纯 base64（不含 data: 前缀）'); }}
                >复制纯 base64</button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={async () => { if (await copyText(imgDataUrl)) setMsg('已复制 dataURL（可直接写进 <img src>）'); }}
                >复制 dataURL</button>
                {msg && <div className="text-sm text-muted">{msg}</div>}
              </>
            )}
            <div className="tb-divider" />
            <div className="tb-label">反向：粘贴 base64 / dataURL → 还原图片</div>
            <Base64ToImage />
          </ToolBlock>

          <ToolBlock title="预览">
            {imgDataUrl
              ? <div className="qr-box"><img src={imgDataUrl} alt="预览" className="media-img" /></div>
              : <div className="tb-empty">选一张图片看预览</div>}
          </ToolBlock>
        </div>
      )}
    </div>
  );
}

function Base64ToImage() {
  const [src, setSrc] = useToolState('b64in', '');
  const dataUrl = useMemo(() => {
    const t = src.trim();
    if (!t) return '';
    if (t.startsWith('data:')) return t;
    if (!/^[A-Za-z0-9+/=\s]+$/.test(t)) return '';
    return `data:image/png;base64,${t.replace(/\s+/g, '')}`;
  }, [src]);

  return (
    <div className="tb-stack tb-stack-tight">
      <textarea className="tb-textarea tb-textarea-sm" value={src} onChange={(e) => setSrc(e.target.value)} spellCheck={false} placeholder="粘贴 base64 或 data:image/png;base64,..." aria-label="粘贴 base64 或 data:image/png;base64," />
      {dataUrl ? <div className="qr-box"><img src={dataUrl} alt="还原" className="media-img" /></div> : <div className="tb-empty">粘贴后这里显示还原的图片</div>}
    </div>
  );
}