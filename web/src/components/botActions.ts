import { api } from '../api';
import { toast } from './Toast';

/** Starts the bot and says so, or says why it could not. */
export async function startBotNow(): Promise<boolean> {
  try {
    const view = await api.startBot();
    if (!view.stats.running) {
      toast(view.stats.haltReason ?? 'The bot did not start — see the log', 'error', 4200);
      return false;
    }
    toast('Bot started');
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : 'The bot did not start', 'error', 4200);
    return false;
  }
}

/** Stops the bot; open positions stay open unless `closePositions` is set. */
export async function stopBotNow(closePositions = false): Promise<boolean> {
  try {
    await api.stopBot(closePositions);
    toast(closePositions ? 'Bot stopped — closing its positions' : 'Bot stopped');
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : 'The bot did not stop', 'error', 4200);
    return false;
  }
}
