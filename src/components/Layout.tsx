import { NavLink, Outlet } from 'react-router-dom';

export function Layout() {
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
        <div className="header-meta">时区 America/Chicago · 绿涨红跌</div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
