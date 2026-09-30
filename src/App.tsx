import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { BrowsePage } from './pages/BrowsePage';
import { HomePage } from './pages/HomePage';
import { PlayPage } from './pages/PlayPage';
import { StatsPage } from './pages/StatsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="browse" element={<BrowsePage />} />
          <Route path="play" element={<PlayPage />} />
          <Route path="stats" element={<StatsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
