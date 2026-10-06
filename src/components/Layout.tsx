import { Suspense } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Layout() {
  const { user, logout, syncError, retrySync } = useAuth();
  const nav = useNavigate();

  async function onLogout() {
    await logout();
    nav('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          K线预测<span>终端</span>
        </div>
        <nav className="nav" aria-label="页面">
          <NavLink to="/" end>
            开始
          </NavLink>
          <NavLink to="/browse">
            <span className="nav-full">浏览行情</span>
            <span className="nav-short">行情</span>
          </NavLink>
          <NavLink to="/play">
            <span className="nav-full">预测对局</span>
            <span className="nav-short">对局</span>
          </NavLink>
          <NavLink to="/stats">
            <span className="nav-full">统计分析</span>
            <span className="nav-short">统计</span>
          </NavLink>
        </nav>
        <div className="header-user">
          <span className="header-username" title={user?.username}>
            {user?.displayName ?? user?.username}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onLogout()}>
            退出
          </button>
        </div>
      </header>
      <main className="app-main">
        {syncError ? (
          <div className="error-banner">
            {syncError}。统计与连胜可能不完整。{' '}
            <button type="button" className="btn btn-sm" onClick={() => void retrySync()}>
              重试
            </button>
          </div>
        ) : null}
        <Suspense fallback={<div className="muted">加载中…</div>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
