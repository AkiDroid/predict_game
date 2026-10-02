import { DEFAULT_BRACKET_ATR_MULTIPLE } from './bracket';
import { isAtrMultipleChoice } from './sampling';
import type { GameFilters, PlayMode, SamplingMode, SessionBucket, SymbolId, Timeframe } from './types';

export interface GameSettings {
  symbol: SymbolId;
  playTf: Timeframe;
  mode: PlayMode;
  filters: GameFilters;
  /** How questions are drawn for the current game. */
  sampling: SamplingMode;
  /** Initial bracket distance, in ATR multiples. Used when sampling is balanced. */
  bracketAtrMultiple: number;
  /** New id each time the player starts a game, so the 50/50 shuffle starts over. */
  samplingSessionId: string;
}

const KEY = 'predict_game_settings_v1';

export const DEFAULT_SETTINGS: GameSettings = {
  symbol: 'ES',
  playTf: '5m',
  mode: 'direction',
  filters: {},
  sampling: 'random',
  bracketAtrMultiple: DEFAULT_BRACKET_ATR_MULTIPLE,
  samplingSessionId: '',
};

export function loadSettings(): GameSettings {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    const mode = parsed.mode === 'bracket' ? 'bracket' : 'direction';
    const sampling = parsed.sampling === 'balanced' ? 'balanced' : 'random';
    const multiple = typeof parsed.bracketAtrMultiple === 'number' ? parsed.bracketAtrMultiple : DEFAULT_BRACKET_ATR_MULTIPLE;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mode,
      sampling,
      bracketAtrMultiple: isAtrMultipleChoice(multiple) ? multiple : DEFAULT_BRACKET_ATR_MULTIPLE,
      samplingSessionId: typeof parsed.samplingSessionId === 'string' ? parsed.samplingSessionId.slice(0, 80) : '',
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
