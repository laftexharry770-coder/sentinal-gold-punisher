import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { SessionState } from './backend/session';
import { DIGIT_SCREENS, Shell, SCREENS, type ScreenId } from './components/Shell';
import { BotControlCenter } from './screens/BotControlCenter';
import { ConnectBroker } from './screens/ConnectBroker';
import { Dashboard } from './screens/Dashboard';
import { DigitsDesk } from './screens/DigitsDesk';
import { SignIn } from './screens/SignIn';
import { TradeSettings } from './screens/TradeSettings';

const SCREEN_IDS = [...SCREENS, ...DIGIT_SCREENS].map((screen) => screen.id);

function isScreenId(value: string | null): value is ScreenId {
  return value !== null && (SCREEN_IDS as string[]).includes(value);
}

/** Screen comes from the URL so app shortcuts and the back button both work. */
function screenFromLocation(): ScreenId {
  const fromQuery = new URLSearchParams(window.location.search).get('screen');
  return isScreenId(fromQuery) ? fromQuery : 'dashboard';
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>(screenFromLocation);
  const [session, setSession] = useState<SessionState>(() => api.sessionState());

  useEffect(() => api.onSession(setSession), []);

  const navigate = useCallback((next: ScreenId) => {
    setScreen(next);
    const url = new URL(window.location.href);
    if (next === 'dashboard') url.searchParams.delete('screen');
    else url.searchParams.set('screen', next);
    window.history.pushState({ screen: next }, '', url);
  }, []);

  useEffect(() => {
    const onPopState = () => setScreen(screenFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // No market data, no chart, no accounts until a session exists.
  if (session.status === 'locked' || session.status === 'connecting') {
    return <SignIn session={session} />;
  }

  // A digits session opens on its own desk, and a screen belonging to the
  // other mode is not reachable from it.
  const mode = session.status === 'live' ? session.mode : 'gold';
  const allowed = (mode === 'digits' ? DIGIT_SCREENS : SCREENS).map((item) => item.id);
  const current = allowed.includes(screen) ? screen : (allowed[0] ?? 'dashboard');

  return (
    <Shell screen={current} onNavigate={navigate} session={session}>
      {current === 'digits' && <DigitsDesk />}
      {current === 'dashboard' && <Dashboard />}
      {current === 'bot' && <BotControlCenter />}
      {current === 'settings' && <TradeSettings />}
      {current === 'brokers' && <ConnectBroker />}
    </Shell>
  );
}
