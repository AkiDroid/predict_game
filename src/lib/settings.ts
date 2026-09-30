import type { GameFilters, PlayMode, SessionBucket, SymbolId, Timeframe } from './types';

export interface GameSettings {
  symbol: SymbolId;
  playTf: Timeframe;
  mode: PlayMode;
  filters: GameFilters;
}

const KEY = 'predict_game_settings_v1';

export const DEFAULT_SETTINGS: GameSettings = {
  symbol: 'ES',
  playTf: '5m',
  mode: 'direction',
  filters: {},
};

export function loadSettings(): GameSettings {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    const mode = parsed.mode === 'bracket' ? 'bracket' : 'direction';
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mode,
      filters: parsed.filters ?? {},
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: GameSettings): void {
  sessionStorage.setItem(KEY, JSON.stringify(s));
}

export const ALL_SESSIONS: SessionBucket[] = [
  'asia',
  'europe',
  'america_rth',
  'america_eth',
];
