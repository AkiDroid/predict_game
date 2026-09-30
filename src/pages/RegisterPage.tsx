import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';

export function RegisterPage() {
  const { user, loading, register } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!loading && user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError('两次输入的密码不一致');
      return;
    }
    setSubmitting(true);
    try {
      await register(username.trim(), password);
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card panel card-block">
        <div className="brand auth-brand">
          K线预测<span>终端</span>
        </div>
        <h1>注册</h1>
        <p className="lead">创建账号后，对局统计会保存在服务器，登录即可同步。</p>
        {error ? <div className="error-banner">{error}</div> : null}
        <form className="auth-form" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="reg-username">用户名</label>
            <input
              id="reg-username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              maxLength={32}
              placeholder="3–32 位字母/数字/下划线/中文"
            />
          </div>
          <div className="field">
            <label htmlFor="reg-password">密码</label>
            <input
              id="reg-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              placeholder="至少 8 位"
            />
          </div>
          <div className="field">
            <label htmlFor="reg-password2">确认密码</label>
            <input
              id="reg-password2"
              type="password"
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              required
              minLength={8}
              maxLength={128}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting}>
            {submitting ? '注册中…' : '注册'}
          </button>
        </form>
        <p className="auth-switch muted">
          已有账号？<Link to="/login">登录</Link>
        </p>
      </div>
    </div>
  );
}
