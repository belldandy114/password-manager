'use strict';

/**
 * 浏览器检测/启动 IPC。
 *
 * 依赖 fs/path/spawn/shell 与「浏览器路径设置」，不碰密码库状态，
 * 因此从 setupIpcHandlers() 搬到独立模块；loadSettings 通过参数注入，避免反向依赖 main.js。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ipcMain, shell } = require('electron');

const KNOWN_BROWSERS = [
  { id: 'chrome', name: 'Chrome', paths: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ]},
  { id: 'msedge', name: 'Edge', paths: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]},
  { id: 'firefox', name: 'Firefox', paths: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ]},
  { id: 'brave', name: 'Brave', paths: [
    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  ]},
  { id: 'opera', name: 'Opera', paths: [
    path.join(process.env.LOCALAPPDATA || '', 'Programs\\Opera\\opera.exe'),
    'C:\\Program Files\\Opera\\opera.exe',
  ]},
  { id: 'vivaldi', name: 'Vivaldi', paths: [
    path.join(process.env.LOCALAPPDATA || '', 'Vivaldi\\Application\\vivaldi.exe'),
    'C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe',
  ]},
  { id: '360', name: '360 浏览器', paths: [
    'C:\\Program Files\\360\\360Chrome\\Chrome\\Application\\360chrome.exe',
    'C:\\Program Files (x86)\\360\\360Chrome\\Chrome\\Application\\360chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', '360\\360Chrome\\Chrome\\Application\\360chrome.exe'),
  ]},
  { id: 'qq', name: 'QQ 浏览器', paths: [
    'C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe',
    'C:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Tencent\\QQBrowser\\QQBrowser.exe'),
  ]},
  { id: 'quark', name: '夸克', paths: [
    path.join(process.env.LOCALAPPDATA || '', 'Quark\\Quark\\Application\\quark.exe'),
    'C:\\Program Files\\Quark\\Quark\\Application\\quark.exe',
    'C:\\Program Files (x86)\\Quark\\Quark\\Application\\quark.exe',
  ]},
];

function findBrowser(id, configuredPath) {
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
  const info = KNOWN_BROWSERS.find(b => b.id === id);
  if (!info) return null;
  for (const p of info.paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function registerBrowserIpc({ loadSettings }) {
    ipcMain.handle('browser:detect', async () => {
      const settings = loadSettings();
      const paths = (settings && settings.browserPaths) || {};
      const browsers = [{ id: 'default', name: '默认浏览器' }];
      for (const b of KNOWN_BROWSERS) {
        if (findBrowser(b.id, paths[b.id])) browsers.push({ id: b.id, name: b.name });
      }
      return browsers;
    });

    ipcMain.handle('browser:get-known', async () => {
      return KNOWN_BROWSERS.map(b => ({ id: b.id, name: b.name }));
    });

    ipcMain.handle('browser:open', async (_event, { browser, url }) => {
      try {
        if (!url || !url.trim()) return { success: false, error: 'URL 为空' };
        let trimmedUrl = url.trim();
        // Auto-prepend https:// if no protocol specified
        if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(trimmedUrl)) {
          trimmedUrl = 'https://' + trimmedUrl;
        }

        if (browser === 'default') {
          await shell.openExternal(trimmedUrl);
        } else {
          const settings = loadSettings();
          const paths = (settings && settings.browserPaths) || {};
          const configuredPath = paths[browser] || '';
          const exePath = findBrowser(browser, configuredPath);
          if (exePath) {
            await new Promise((resolve, reject) => {
              const child = spawn(exePath, [trimmedUrl], { shell: false, detached: true, stdio: 'ignore' });
              child.on('error', () => {
                // If spawn fails (e.g. exe not found), fall back to default browser
                shell.openExternal(trimmedUrl).then(resolve).catch(reject);
              });
              child.on('close', (code) => {
                if (code === 0) resolve();
                else resolve(); // Browser may exit with non-zero even on success, still consider it ok
              });
              child.unref();
            });
          } else {
            await shell.openExternal(trimmedUrl);
          }
        }
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
}

module.exports = { registerBrowserIpc, findBrowser, KNOWN_BROWSERS };
