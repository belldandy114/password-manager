import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { applyBackground } from '../utils/background';
import { extractAccent, ensureReadableOnWhiteText } from '../utils/accent';

/**
 * 背景层：一张 <img> 铺满窗口 + 一层压暗遮罩。
 *
 * 为什么用 <img> 而不是 body::before：
 *   data URL 写进 CSS 自定义属性时，Chromium 对这种超长值偶发解析失败（实测 --bg-url 直接被丢弃，
 *   背景空白）。<img src> 没有这个问题，object-fit: cover 同样等比裁剪不变形。
 */
export function BackgroundLayer() {
  const settings = useStore(s => s.settings);
  const updateSettings = useStore(s => s.updateSettings);
  const [url, setUrl] = useState('');

  const file = settings.backgroundImage || '';

  // 换图时向主进程要 base64（图片存在数据目录，渲染层不直接读文件）
  useEffect(() => {
    let alive = true;
    if (!file) { setUrl(''); return () => { alive = false; }; }
    void (async () => {
      const r = await window.electronAPI.bgGet();
      if (!alive) return;
      setUrl(r.success && r.data && r.data.configured ? String(r.data.dataUrl || '') : '');
    })();
    return () => { alive = false; };
  }, [file]);

  // 效果参数同步到 <html>（data-bg + 三个 CSS 变量）
  useEffect(() => {
    applyBackground({
      present: !!url,
      opacity: settings.backgroundOpacity,
      blur: settings.backgroundBlur,
      dim: settings.backgroundDim,
      accent: settings.backgroundAccent,
      autoAccent: settings.backgroundAutoAccent !== false,
      presetAccent: settings.accent || 'teal',
    });
  }, [url, settings.backgroundOpacity, settings.backgroundBlur, settings.backgroundDim, settings.backgroundAccent, settings.backgroundAutoAccent, settings.accent]);

  // 换图后取一次主色（已经取过就跳过，避免每次启动都算一遍）
  useEffect(() => {
    if (!url || settings.backgroundAutoAccent === false) return;
    if (settings.backgroundAccent) return;
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (!alive) return;
      // 强调色上会放白字（主按钮），太浅的颜色要压暗到 AA，否则按钮文字看不清
      const accent = ensureReadableOnWhiteText(extractAccent(img));
      updateSettings({ backgroundAccent: accent });
      void window.electronAPI.settingsSave({ backgroundAccent: accent });
    };
    img.src = url;
    return () => { alive = false; };
  }, [url, settings.backgroundAutoAccent, settings.backgroundAccent, updateSettings]);

  if (!url) return null;
  return (
    <div className="app-bg" aria-hidden>
      <img className="app-bg-img" src={url} alt="" draggable={false} />
      <div className="app-bg-dim" />
    </div>
  );
}

