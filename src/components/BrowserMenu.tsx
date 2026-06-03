import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface BrowserOption {
  id: string;
  name: string;
}

interface Props {
  url: string;
}

export function BrowserMenu({ url }: Props) {
  const [open, setOpen] = useState(false);
  const [browsers, setBrowsers] = useState<BrowserOption[]>([]);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && browsers.length === 0) {
      window.electronAPI.browserDetect().then(setBrowsers);
    }
  }, [open, browsers.length]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClick);
      // Recalculate position on scroll
      document.addEventListener('scroll', () => setOpen(false), { once: true });
    }
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const dropdownWidth = 160;
      const estHeight = 220;
      let left = rect.left;
      if (left + dropdownWidth > window.innerWidth - 8) {
        left = window.innerWidth - dropdownWidth - 8;
      }
      let top = rect.bottom + 4;
      if (top + estHeight > window.innerHeight - 8) {
        top = Math.max(4, rect.top - estHeight - 4);
      }
      setPos({ top, left });
    }
    setOpen(!open);
  };

  const handleOpen = async (browser: string) => {
    try {
      const result = await window.electronAPI.browserOpen({ browser, url });
      if (!result.success) {
        console.warn('打开链接失败:', result.error);
      }
    } catch (e) {
      console.warn('打开链接异常:', e);
    }
    setOpen(false);
  };

  if (!url) return null;

  return (
    <div className="browser-menu" ref={menuRef}>
      <button ref={btnRef} className="browser-btn" onClick={handleToggle} title="打开链接">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </button>
      {open && createPortal(
        <div className="browser-dropdown portal" style={{ top: pos.top, left: pos.left }}>
          {browsers.map(b => (
            <div key={b.id} className="browser-option" onMouseDown={e => { e.stopPropagation(); handleOpen(b.id); }}>
              {b.name}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
