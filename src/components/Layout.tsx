import { NavLink, Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          K线预测<span>终端</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            开始
          </NavLink>
          <NavLink to="/browse">浏览行情</NavLink>
          <NavLink to="/play">预测对局</NavLink>
          <NavLink to="/stats">统计分析</NavLink>
        </nav>
        <div className="header-meta">时区 America/Chicago · 绿涨红跌</div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
