import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/**
 * Routes that read the round cache synchronously on mount (streak, toolbar win rate) and never
 * re-read it until the next answer, so they must not mount before the sign-in sync settles.
 */
const NEEDS_ROUNDS = new Set(['/play']);

export function RequireAuth() {
  const { user, loading, roundsSettled } = useAuth();
  const location = useLocation();

  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  if (loading || (user && !roundsSettled && NEEDS_ROUNDS.has(pathname))) {
    return (
      <div className="auth-shell">
        <div className="muted">正在验证登录状态…</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}
