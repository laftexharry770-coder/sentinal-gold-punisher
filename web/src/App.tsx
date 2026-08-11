import { useState } from 'react';
import { Shell, type ScreenId } from './components/Shell';
import { BotControlCenter } from './screens/BotControlCenter';
import { ConnectBroker } from './screens/ConnectBroker';
import { Dashboard } from './screens/Dashboard';
import { TradeSettings } from './screens/TradeSettings';

export function App() {
  const [screen, setScreen] = useState<ScreenId>('dashboard');

  return (
    <Shell screen={screen} onNavigate={setScreen}>
      {screen === 'dashboard' && <Dashboard />}
      {screen === 'bot' && <BotControlCenter />}
      {screen === 'settings' && <TradeSettings />}
      {screen === 'brokers' && <ConnectBroker />}
    </Shell>
  );
}
