import React, { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';

interface Props {
  onLogin: () => void;
}

export function Login({ onLogin }: Props) {
  const [mode, setMode] = useState<'loading' | 'setup' | 'login' | 'forgot'>('loading');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [storedHint, setStoredHint] = useState('');
  const setMasterPassword = useStore(s => s.setMasterPassword);
  // Forgot password state
  const [forgotSecurityWord, setForgotSecurityWord] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotNewPassword2, setForgotNewPassword2] = useState('');
  const [forgotStep, setForgotStep] = useState<'security' | 'reset'>('security');

  useEffect(() => {
    (async () => {
      try {
        const isSetup = await window.electronAPI.authIsSetup();
        if (isSetup) {
          const h = await window.electronAPI.authGetHint();
          setStoredHint(h);
          setMode('login');
        } else {
          setMode('setup');
        }
      } catch {
        setMode('setup');
      }
    })();
  }, []);

  const handleSetup = async () => {
    setError('');
    if (password.length < 8) { setError('密码至少需要8位'); return; }
    if (!/[a-z]/.test(password)) { setError('密码需包含小写字母'); return; }
    if (!/[A-Z]/.test(password)) { setError('密码需包含大写字母'); return; }
    if (!/[0-9]/.test(password)) { setError('密码需包含数字'); return; }
    if (!/[^a-zA-Z0-9]/.test(password)) { setError('密码需包含特殊符号'); return; }
    if (password !== confirmPassword) { setError('两次密码不一致'); return; }
    try {
      const result = await window.electronAPI.authSetup({ password, hint });
      if (result.success) {
        setMasterPassword(password);
        onLogin();
      } else {
        setError(result.error || '设置失败');
      }
    } catch (e: any) {
      setError(e.message || '设置失败');
    }
  };

  const handleLogin = async () => {
    setError('');
    if (!password) { setError('请输入主密码'); return; }
    try {
      const result = await window.electronAPI.authVerify({ password });
      if (result.success) {
        setMasterPassword(password);
        onLogin();
      } else {
        setError(result.error || '密码错误');
      }
    } catch (e: any) {
      setError(e.message || '验证失败');
    }
  };

  const handleForgotSecurity = async () => {
    setError('');
    if (!forgotSecurityWord) { setError('请输入安全词'); return; }
    try {
      const result = await window.electronAPI.authVerifySecurityWord({ securityWord: forgotSecurityWord });
      if (result.success) {
        setForgotStep('reset');
        setError('');
      } else {
        setError(result.error || '安全词错误');
      }
    } catch (e: any) {
      setError(e.message || '验证失败');
    }
  };

  const handleForgotReset = async () => {
    setError('');
    if (forgotNewPassword.length < 8) { setError('新密码至少8位'); return; }
    if (!/[a-z]/.test(forgotNewPassword)) { setError('密码需包含小写字母'); return; }
    if (!/[A-Z]/.test(forgotNewPassword)) { setError('密码需包含大写字母'); return; }
    if (!/[0-9]/.test(forgotNewPassword)) { setError('密码需包含数字'); return; }
    if (!/[^a-zA-Z0-9]/.test(forgotNewPassword)) { setError('密码需包含特殊符号'); return; }
    if (forgotNewPassword !== forgotNewPassword2) { setError('两次密码不一致'); return; }
    try {
      const result = await window.electronAPI.authResetPassword({ securityWord: forgotSecurityWord, newPassword: forgotNewPassword });
      if (result.success) {
        setMasterPassword(forgotNewPassword);
        onLogin();
      } else {
        setError(result.error || '重置失败');
      }
    } catch (e: any) {
      setError(e.message || '重置失败');
    }
  };

  const getPasswordStrength = (pw: string): { label: string; color: string; percent: number } => {
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-z]/.test(pw)) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^a-zA-Z0-9]/.test(pw)) score++;
    if (score <= 2) return { label: '弱', color: 'var(--danger)', percent: 33 };
    if (score <= 4) return { label: '中', color: 'var(--warning)', percent: 66 };
    return { label: '强', color: 'var(--success)', percent: 100 };
  };

  if (mode === 'loading') {
    return (
      <div className="login-page">
        <div className="login-card">
          <img src="./图标.png" alt="测试工具" className="login-logo" />
          <h1>测试工具</h1>
          <p className="subtitle" style={{ marginTop: 20 }}>加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img src="./图标.png" alt="测试工具" className="login-logo" />
        <h1>测试工具</h1>
        <p className="subtitle">
          {mode === 'setup' ? '首次使用，请设置主密码' : '请输入主密码解锁'}
        </p>

        {mode === 'setup' ? (
          <>
            <div className="form-group">
              <label>主密码</label>
              <div className="password-input-wrapper">
                <input type={showPassword ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="至少8位，包含大小写字母、数字和符号" autoFocus />
                <button className="password-toggle" onClick={() => setShowPassword(!showPassword)} type="button">
                  {showPassword ? '🙈' : '👁'}
                </button>
              </div>
              {password && (
                <div style={{ marginTop: 6 }}>
                  <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ width: `${getPasswordStrength(password).percent}%`, height: '100%', background: getPasswordStrength(password).color, transition: 'all 0.3s', borderRadius: 2 }} />
                  </div>
                  <div className="input-hint">密码强度: {getPasswordStrength(password).label}</div>
                </div>
              )}
              <div className="input-hint">需包含大小写字母、数字和特殊符号，至少8位</div>
            </div>
            <div className="form-group">
              <label>确认密码</label>
              <div className="password-input-wrapper">
                <input type={showPassword ? 'text' : 'password'} value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)} placeholder="再次输入密码" />
              </div>
            </div>
            <div className="form-group">
              <label>密码提示词（可选）</label>
              <input type="text" value={hint} onChange={e => setHint(e.target.value)}
                placeholder="帮助你记忆密码的提示" />
              <div className="input-hint">忘记主密码后将无法访问数据，请务必牢记</div>
            </div>
            {error && <div className="form-group"><div className="input-hint" style={{ color: 'var(--danger)' }}>{error}</div></div>}
            <button className="btn btn-primary btn-block btn-lg" onClick={handleSetup}>设置主密码并开始使用</button>
          </>
        ) : mode === 'forgot' ? (
          <>
            <p className="subtitle">重置主密码</p>
            {forgotStep === 'security' ? (
              <>
                <div className="form-group">
                  <label>安全词</label>
                  <input type="text" value={forgotSecurityWord}
                    onChange={e => setForgotSecurityWord(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleForgotSecurity(); }}
                    placeholder="输入设置的安全词" autoFocus />
                  <div className="input-hint">输入设置安全词时填写的词语</div>
                </div>
                {error && <div className="form-group"><div className="input-hint" style={{ color: 'var(--danger)' }}>{error}</div></div>}
                <button className="btn btn-primary btn-block btn-lg" onClick={handleForgotSecurity}>验证安全词</button>
              </>
            ) : (
              <>
                <div className="form-group">
                  <label>新主密码</label>
                  <div className="password-input-wrapper">
                    <input type={showPassword ? 'text' : 'password'} value={forgotNewPassword}
                      onChange={e => setForgotNewPassword(e.target.value)}
                      placeholder="至少8位，包含大小写字母、数字和符号" autoFocus />
                    <button className="password-toggle" onClick={() => setShowPassword(!showPassword)} type="button">
                      {showPassword ? '🙈' : '👁'}
                    </button>
                  </div>
                  <div className="input-hint">需包含大小写字母、数字和特殊符号，至少8位</div>
                </div>
                <div className="form-group">
                  <label>确认新密码</label>
                  <input type={showPassword ? 'text' : 'password'} value={forgotNewPassword2}
                    onChange={e => setForgotNewPassword2(e.target.value)} placeholder="再次输入新密码" />
                </div>
                {error && <div className="form-group"><div className="input-hint" style={{ color: 'var(--danger)' }}>{error}</div></div>}
                <button className="btn btn-primary btn-block btn-lg" onClick={handleForgotReset}>重置密码</button>
              </>
            )}
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => { setMode('login'); setError(''); setForgotStep('security'); setForgotSecurityWord(''); }}>
                返回登录
              </button>
            </div>
          </>
        ) : (
          <>
            {storedHint && (
              <div style={{ textAlign: 'center', marginBottom: 16, padding: '8px 12px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', fontSize: 13, color: 'var(--text-secondary)' }}>
                💡 提示: {storedHint}
              </div>
            )}
            <div className="form-group">
              <label>主密码</label>
              <div className="password-input-wrapper">
                <input type={showPassword ? 'text' : 'password'} value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="输入主密码解锁" autoFocus />
                <button className="password-toggle" onClick={() => setShowPassword(!showPassword)} type="button">
                  {showPassword ? '🙈' : '👁'}
                </button>
              </div>
            </div>
            {error && <div className="form-group"><div className="input-hint" style={{ color: 'var(--danger)' }}>{error}</div></div>}
            <button className="btn btn-primary btn-block btn-lg" onClick={handleLogin}>解锁</button>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button className="btn btn-ghost btn-sm" onClick={async () => {
                const has = await window.electronAPI.authHasSecurityWord();
                if (has) {
                  setMode('forgot');
                  setForgotStep('security');
                  setError('');
                } else {
                  setError('未设置安全词，无法重置密码');
                }
              }}>
                忘记密码?
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
