import { lazy, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';

const loadBrowse = () => import('./pages/BrowsePage');
const loadPlay = () => import('./pages/PlayPage');
const loadStats = () => import('./pages/StatsPage');

const BrowsePage = lazy(() => loadBrowse().then((m) => ({ default: m.BrowsePage })));
const PlayPage = lazy(() => loadPlay().then((m) => ({ default: m.PlayPage })));
const StatsPage = lazy(() => loadStats().then((m) => ({ default: m.StatsPage })));

function preloadPages() {
  void loadPlay();
  void loadBrowse();
  void loadStats();
}

export default function App() {
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(preloadPages, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preloadPages, 1500);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route index element={<HomePage />} />
              <Route path="browse" element={<BrowsePage />} />
              <Route path="play" element={<PlayPage />} />
              <Route path="stats" element={<StatsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
