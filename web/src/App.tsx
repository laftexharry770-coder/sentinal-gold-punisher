import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { SessionState } from './backend/session';
import { Shell, SCREENS, type ScreenId } from './components/Shell';
import { Toaster } from './components/Toast';
import { BotControlCenter } from './screens/BotControlCenter';
import { ConnectBroker } from './screens/ConnectBroker';
import { ControlPanel } from './screens/ControlPanel';
import { Dashboard } from './screens/Dashboard';
import { SignIn } from './screens/SignIn';
import { TradeSettings } from './screens/TradeSettings';

const SCREEN_IDS = SCREENS.map((screen) => screen.id);

function isScreenId(value: string | null): value is ScreenId {
  return value !== null && (SCREEN_IDS as string[]).includes(value);
}

/** Screen comes from the URL so app shortcuts and the back button both work. */
function screenFromLocation(): ScreenId {
  const fromQuery = new URLSearchParams(window.location.search).get('screen');
  return isScreenId(fromQuery) ? fromQuery : 'control';
}

export function App() {
  const [screen, setScreen] = useState<ScreenId>(screenFromLocation);
  const [session, setSession] = useState<SessionState>(() => api.sessionState());

  useEffect(() => api.onSession(setSession), []);

  const navigate = useCallback((next: ScreenId) => {
    setScreen(next);
    const url = new URL(window.location.href);
    if (next === 'control') url.searchParams.delete('screen');
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
    return (
      <>
        <SignIn session={session} />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <Shell screen={screen} onNavigate={navigate} session={session}>
        {screen === 'control' && <ControlPanel session={session} onOpenSettings={() => navigate('settings')} />}
        {screen === 'dashboard' && <Dashboard />}
        {screen === 'bot' && <BotControlCenter />}
        {screen === 'settings' && <TradeSettings />}
        {screen === 'brokers' && <ConnectBroker session={session} />}
      </Shell>
      <Toaster />
    </>
  );
}
