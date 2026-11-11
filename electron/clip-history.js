'use strict';
/**
 * 剪贴板历史（本地加密落盘，滚动 30 条）。
 *
 * 为什么单独一个模块：原来这份历史只是 main.js 里的一个内存数组，锁屏/退出就没了，
 * 而「测试时反复粘地址、账号、curl」恰恰是跨会话的——关掉应用再打开，历史全丢，
 * 等于没做。落盘就必须加密：这些内容里有密码和验证码，明文写进 userData 目录
 * 等于把密码库的防护绕过去了。
 *
 * 加密用的是当前会话主密码（与 vault.enc 同一套 AES-256-GCM），所以：
 *   - 锁屏时只清内存，文件留着；下次解锁用同一个主密码再读回来。
 *   - 改主密码时要重新加密一次，否则旧文件再也解不开。
 *   - 用户点「清空」才真正删文件。
 * 文件解不开（主密码变了、文件损坏）时静默当作空历史，不阻塞解锁。
 */

const fs = require('fs');
const path = require('path');

/** 滚动保留条数。30 条足够覆盖一次联调，再多就变成「另一个密码库」了。 */
const CLIP_HISTORY_MAX = 30;

/** 落盘文件名（放在数据目录下，与 vault.enc 同级） */
const CLIP_HISTORY_FILE = 'clipboard.enc';

/**
 * @param {object} opts
 * @param {string} opts.dir 数据目录
 * @param {(plain: string, pw: string) => string} opts.encrypt
 * @param {(cipher: string, pw: string) => string|null} opts.decrypt
 * @param {(file: string, content: string) => void} opts.writeFileAtomic
 * @param {() => string|null} opts.getPassword
 * @param {() => boolean} opts.isEnabled 设置里的开关（关闭时不记录、不落盘）
 */
function createClipHistory(opts) {
  const { dir, encrypt, decrypt, writeFileAtomic, getPassword, isEnabled } = opts;
  const file = path.join(dir, CLIP_HISTORY_FILE);
  /** @type {{ text: string, at: string }[]} */
  let items = [];

  function persist(pwOverride) {
    const pw = pwOverride || getPassword();
    if (!pw) return;
    try {
      writeFileAtomic(file, encrypt(JSON.stringify(items), pw));
    } catch {
      /* 落盘失败不影响复制本身 */
    }
  }

  /** 解锁后调用：把上次会话的历史读回来（解不开就当空） */
  function load() {
    const pw = getPassword();
    if (!pw) return items;
    try {
      if (!fs.existsSync(file)) return items;
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (!raw) return items;
      const plain = decrypt(raw, pw);
      if (!plain) return items;
      const parsed = JSON.parse(plain);
      if (Array.isArray(parsed)) {
        items = parsed
          .filter((x) => x && typeof x.text === 'string' && x.text)
          .slice(0, CLIP_HISTORY_MAX)
          .map((x) => ({ text: x.text, at: typeof x.at === 'string' ? x.at : '' }));
      }
    } catch {
      items = [];
    }
    return items;
  }

  /** 记一条（去重：已存在就提到最前，不产生重复条目） */
  function remember(text) {
    try {
      if (typeof isEnabled === 'function' && !isEnabled()) return;
      const t = String(text || '');
      if (!t) return;
      if (items[0] && items[0].text === t) return;
      // 重复复制同一条（比如反复粘同一个 token）不该在列表里堆成好几行，
      // 但也不该丢掉——把它提到最前，位置反映「最近用过」。
      const dup = items.findIndex((x) => x.text === t);
      if (dup >= 0) items.splice(dup, 1);
      items.unshift({ text: t, at: new Date().toISOString() });
      while (items.length > CLIP_HISTORY_MAX) items.pop();
      persist();
    } catch {
      /* 记录失败不影响复制 */
    }
  }

  /** 锁屏：只清内存，文件留着等下次解锁 */
  function forget() {
    items = [];
  }

  /** 用户点「清空」：内存与文件一起删 */
  function wipe() {
    items = [];
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* 删不掉也不影响内存已清空 */
    }
  }

  /** 改主密码后重新加密一次，否则旧文件用新密码解不开 */
  function repersist(pwOverride) {
    if (!items.length) return;
    persist(pwOverride);
  }

  function list() {
    return items.slice();
  }

  return { remember, forget, wipe, repersist, load, list, file };
}

module.exports = { createClipHistory, CLIP_HISTORY_MAX, CLIP_HISTORY_FILE };
