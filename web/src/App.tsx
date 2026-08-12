import { useCallback, useEffect, useState } from 'react';
import { Shell, SCREENS, type ScreenId } from './components/Shell';
import { BotControlCenter } from './screens/BotControlCenter';
import { ConnectBroker } from './screens/ConnectBroker';
import { Dashboard } from './screens/Dashboard';
import { TradeSettings } from './screens/TradeSettings';

const SCREEN_IDS = SCREENS.map((screen) => screen.id);

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

  return (
    <Shell screen={screen} onNavigate={navigate}>
      {screen === 'dashboard' && <Dashboard />}
      {screen === 'bot' && <BotControlCenter />}
      {screen === 'settings' && <TradeSettings />}
      {screen === 'brokers' && <ConnectBroker />}
    </Shell>
  );
}
