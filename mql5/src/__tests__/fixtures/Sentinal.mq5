//+------------------------------------------------------------------+
//|                                                     Sentinal.mq5 |
//|                     Trend-adaptive Expert Advisor for MetaTrader 5 |
//+------------------------------------------------------------------+
#property copyright "Sentinal"
#property version   "2.00"
#property strict
#property description "Trend-adaptive MT5 bot. Higher-timeframe trend filter,"
#property description "ATR volatility-scaled stops, trailing stop and reversal"
#property description "handling. Tuned defaults for XAUUSD."

#include <Trade/Trade.mqh>
#include <Trade/PositionInfo.mqh>

//+------------------------------------------------------------------+
//| Enums                                                            |
//+------------------------------------------------------------------+
enum EStrategy
  {
   STRAT_EMA_CROSS,      // EMA cross (fast crosses slow)
   STRAT_RSI_REVERSION,  // RSI reversion (leaves oversold/overbought)
   STRAT_BREAKOUT        // Breakout of N-bar high/low
  };

enum ESignal { SIGNAL_NONE = 0, SIGNAL_BUY = 1, SIGNAL_SELL = -1 };

enum EDirection
  {
   DIR_BOTH,        // Long and short
   DIR_LONG_ONLY,   // Long only
   DIR_SHORT_ONLY   // Short only
  };

//+------------------------------------------------------------------+
//| Every reason a bar can fail to produce a trade. Tallied and      |
//| printed at the end of a run, so "it isn't trading" always has a  |
//| specific, counted answer instead of a guess.                     |
//+------------------------------------------------------------------+
enum EBlock
  {
   BLK_ENTER = 0,
   BLK_AUTOTRADE_OFF,
   BLK_TARGET_HALT,
   BLK_HOURS,
   BLK_DAILY_LOSS,
   BLK_SPREAD,
   BLK_POSLIMIT,
   BLK_TOTALRISK,
   BLK_NOSIGNAL,
   BLK_TREND_FLAT,
   BLK_TREND_OPPOSED,
   BLK_DIRECTION,
   BLK_SESSION,
   BLK_MAXLOSS,
   BLK_COUNT
  };

string BlockName(const int b)
  {
   switch(b)
     {
      case BLK_ENTER:         return("entered");
      case BLK_AUTOTRADE_OFF: return("auto-trade OFF");
      case BLK_TARGET_HALT:   return("halted at profit target");
      case BLK_HOURS:         return("outside trading hours");
      case BLK_DAILY_LOSS:    return("daily loss limit");
      case BLK_SPREAD:        return("spread too wide");
      case BLK_POSLIMIT:      return("position limit reached");
      case BLK_TOTALRISK:     return("combined open risk at cap");
      case BLK_NOSIGNAL:      return("no entry signal");
      case BLK_TREND_FLAT:    return("trend flat / ADX below minimum");
      case BLK_TREND_OPPOSED: return("signal against higher-TF trend");
      case BLK_DIRECTION:     return("direction disabled (long/short filter)");
      case BLK_SESSION:       return("outside New York session");
      case BLK_MAXLOSS:       return("max total loss reached");
     }
   return("unknown");
  }

//+------------------------------------------------------------------+
//| Inputs                                                           |
//|                                                                  |
//| All distances are in POINTS, never "pips". A point is the        |
//| smallest quote increment for the symbol, so the same number      |
//| means the same thing on XAUUSD, EURUSD and indices alike.        |
//| On 2-digit gold, 1 point = 0.01, so 100 points = $1.00 of price. |
//+------------------------------------------------------------------+
input group "=== Trading ==="
input bool   InpAutoTrade        = false;  // Auto-trade (false = monitor only)
input long   InpMagicNumber      = 770001; // Magic number
input int    InpMaxPositions     = 5;      // Maximum simultaneous positions

input group "=== Trend adaptation ==="
input bool   InpUseTrendFilter   = false;  // Only trade with the higher-TF trend
input ENUM_TIMEFRAMES InpTrendTF = PERIOD_H4; // Trend timeframe
input int    InpTrendEMA         = 200;    // Trend EMA period
input bool   InpUseADX           = false;  // Require a trending market
input int    InpADXPeriod        = 14;     // ADX period
input double InpADXMin           = 20.0;   // Min ADX to trade
input bool   InpCloseOnReverse   = true;   // Close position when trend flips

input group "=== Entry ==="
input bool   InpIntrabarSignals  = true;   // React inside the candle (executes immediately)
input EDirection InpDirection    = DIR_BOTH;        // Allowed trade direction
input EStrategy InpStrategy      = STRAT_EMA_CROSS; // Entry strategy
input int    InpFastEMA          = 12;     // EMA cross: fast period
input int    InpSlowEMA          = 26;     // EMA cross: slow period
input int    InpRSIPeriod        = 14;     // RSI: period
input int    InpRSIOversold      = 30;     // RSI: oversold level
input int    InpRSIOverbought    = 70;     // RSI: overbought level
input int    InpBreakoutBars     = 20;     // Breakout: lookback bars

input group "=== Trade Settings ==="
input bool   InpUseDollarStops   = true;   // Use $ stop/target instead of ATR
input double InpInitialLot       = 0.01;   // Initial lot size (MINIMUM)
input double InpStopLossUSD      = 2.0;    // Stop loss per trade ($)
input double InpTakeProfitUSD    = 1.0;    // Take profit per trade ($)
input double InpLossTriggerUSD   = 0.5;    // Loss to trigger recovery ($)

input group "=== Martingale Settings ==="
input bool   InpUseMartingale    = true;   // Enable martingale recovery
input double InpMartingaleMult   = 2.0;    // Martingale multiplier
input int    InpMaxRecovery      = 3;      // Maximum recovery attempts

input group "=== Session ==="
input bool   InpNewYorkOnly      = true;   // Trade the New York session only
input int    InpNYStartHour      = 15;     // NY session start (server time)
input int    InpNYEndHour        = 24;     // NY session end (server time)

input group "=== Risk (all % of live balance) ==="
input double InpDailyProfitUSD   = 100.0;  // Daily profit target ($, 0 = off)
input double InpMaxLossPctBal    = 50.0;   // Max total loss (% of balance, 0 = off)
input bool   InpUseRiskPercent   = true;   // Size by risk % (false = fixed lots)
input double InpRiskPercent      = 1.0;    // Target risk per trade (%)
input double InpMaxRiskPercent   = 5.0;    // Hard ceiling per trade (%, 0 = never exceed target)
input double InpMaxTotalRiskPct  = 6.0;    // Max combined open risk (%, 0 = off)
input double InpMaxDailyLossPct  = 5.0;    // Halt for the day after this loss (%, 0 = off)
input double InpFixedLots        = 0.01;   // Fixed lot size (when not sizing by risk)

input group "=== Stops (ATR-scaled) ==="
input bool   InpUseATRStops      = true;   // Scale stops to live volatility
input int    InpATRPeriod        = 14;     // ATR period
input double InpATRStopMult      = 2.0;    // Stop = ATR x this
input double InpATRTargetMult    = 3.0;    // Target = ATR x this
input int    InpStopLossPoints   = 3000;   // Fixed stop (points, if ATR off)
input int    InpTakeProfitPoints = 6000;   // Fixed target (points, if ATR off)
input bool   InpUseTrailingStop  = true;   // Trail the stop as price moves
input double InpATRTrailMult     = 2.0;    // Trail distance = ATR x this

input group "=== Filters ==="
input int    InpMaxSpreadPoints  = 500;    // Max spread (points, 0 = ignore)
input double InpMaxSpreadATR     = 0.5;    // Max spread as fraction of ATR (0 = ignore)
input double InpTargetProfitPct  = 0.0;    // Halt at profit (% of start balance, 0 = off)
input bool   InpUseTimeFilter    = false;  // Restrict trading hours
input int    InpStartHour        = 0;      // Start hour (server time)
input int    InpEndHour          = 24;     // End hour (server time)

input group "=== Display ==="
input bool   InpVerboseLog       = true;   // Log why each bar did/didn't trade
input bool   InpShowPanel        = true;   // Show status panel
input color  InpPanelColor       = clrWhite; // Panel text colour

//+------------------------------------------------------------------+
//| Globals                                                          |
//+------------------------------------------------------------------+
CTrade         trade;
CPositionInfo  position;

double   g_startBalance    = 0.0;
bool     g_halted          = false;
datetime g_lastBar         = 0;
datetime g_lastEntryBar    = 0;     // caps entries at one per candle

double   g_dayStartBalance = 0.0;   // balance at the start of the current day
datetime g_dayStamp        = 0;     // which day that was
bool     g_dayHalted       = false; // daily loss limit tripped

int      g_recoveryStep    = 0;     // consecutive martingale escalations
datetime g_lastDealTime    = 0;     // newest closed deal already accounted for

long     g_blockTally[BLK_COUNT];   // why each evaluated bar did not trade
long     g_barsSeen        = 0;
long     g_ordersPlaced    = 0;
long     g_sizingSkips     = 0;     // signal passed every gate, sizing refused

int g_hFast  = INVALID_HANDLE;
int g_hSlow  = INVALID_HANDLE;
int g_hRSI   = INVALID_HANDLE;
int g_hATR   = INVALID_HANDLE;
int g_hTrend = INVALID_HANDLE;
int g_hADX   = INVALID_HANDLE;

const string PANEL_PREFIX = "SENT_";

//+------------------------------------------------------------------+
//| Initialisation                                                   |
//+------------------------------------------------------------------+
int OnInit()
  {
   trade.SetExpertMagicNumber((ulong)InpMagicNumber);
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetDeviationInPoints(30);

   g_startBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   g_halted       = false;
   UpdateDailyTracking();

   // Seed the bar stamp now, so attaching mid-bar does not immediately
   // count as "a new bar" and fire an entry on stale conditions.
   g_lastBar = (datetime)SeriesInfoInteger(_Symbol, PERIOD_CURRENT, SERIES_LASTBAR_DATE);

   if(!ValidateInputs())
      return(INIT_PARAMETERS_INCORRECT);

   if(!CreateIndicators())
      return(INIT_FAILED);

   if(InpUseMartingale)
     {
      double worst = 0.0;
      for(int k = 0; k <= InpMaxRecovery; k++)
         worst += InpInitialLot * MathPow(InpMartingaleMult, k);
      PrintFormat("Sentinal: MARTINGALE ON. Ladder %d steps x%.2f. A full losing "
                  "sequence stakes %.2f lots in total before the ladder resets.",
                  InpMaxRecovery, InpMartingaleMult, worst);
     }

   if(InpIntrabarSignals)
      Print("Sentinal: INTRABAR mode — rules read the forming candle. Entries are "
            "faster but a signal can appear and then vanish before the candle closes, "
            "so live results will differ from a bar-close backtest.");

   if(InpShowPanel)
      PanelUpdate();

   PrintFormat("Sentinal v2 on %s | strategy=%s | auto-trade=%s | digits=%d | point=%s",
               _Symbol, EnumToString(InpStrategy), (InpAutoTrade ? "ON" : "OFF"),
               _Digits, DoubleToString(_Point, _Digits));

   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
//| Shutdown                                                         |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   if(g_hFast  != INVALID_HANDLE) IndicatorRelease(g_hFast);
   if(g_hSlow  != INVALID_HANDLE) IndicatorRelease(g_hSlow);
   if(g_hRSI   != INVALID_HANDLE) IndicatorRelease(g_hRSI);
   if(g_hATR   != INVALID_HANDLE) IndicatorRelease(g_hATR);
   if(g_hTrend != INVALID_HANDLE) IndicatorRelease(g_hTrend);
   if(g_hADX   != INVALID_HANDLE) IndicatorRelease(g_hADX);

   ObjectsDeleteAll(0, PANEL_PREFIX);
   ChartRedraw();

   PrintSummary();
  }

//+------------------------------------------------------------------+
//| End-of-run breakdown. This is the answer to "why isn't it        |
//| trading" — a count per gate, not an impression.                  |
//+------------------------------------------------------------------+
void PrintSummary()
  {
   Print("======== Sentinal summary ========");
   PrintFormat("Bars evaluated: %I64d   Orders placed: %I64d", g_barsSeen, g_ordersPlaced);

   if(g_barsSeen == 0)
     {
      Print("No bars were evaluated at all. OnTick returned before the entry check on");
      Print("every tick, which means TradingReady() was false throughout: no connection,");
      Print("algo trading disabled, or the symbol was never tradeable.");
      Print("==================================");
      return;
     }

   for(int b = 0; b < BLK_COUNT; b++)
     {
      if(g_blockTally[b] == 0)
         continue;
      PrintFormat("  %-34s %6I64d bars (%.1f%%)",
                  BlockName(b), g_blockTally[b],
                  100.0 * (double)g_blockTally[b] / (double)g_barsSeen);
     }

   if(g_sizingSkips > 0)
      PrintFormat("  %-34s %6I64d times", "passed all gates, sizing refused", g_sizingSkips);

   Print("==================================");
  }

//+------------------------------------------------------------------+
//| Input validation                                                 |
//+------------------------------------------------------------------+
bool ValidateInputs()
  {
   if(InpUseRiskPercent && InpRiskPercent <= 0.0)
     { Print("Sentinal: InpRiskPercent must be > 0."); return(false); }
   if(!InpUseRiskPercent && InpFixedLots <= 0.0)
     { Print("Sentinal: InpFixedLots must be > 0."); return(false); }
   if(!InpUseATRStops && InpStopLossPoints <= 0)
     { Print("Sentinal: fixed stops need InpStopLossPoints > 0."); return(false); }
   if(InpUseATRStops && InpATRStopMult <= 0.0)
     { Print("Sentinal: InpATRStopMult must be > 0."); return(false); }
   if(InpMaxPositions < 1)
     { Print("Sentinal: InpMaxPositions must be >= 1."); return(false); }
   if(InpMaxRiskPercent > 0.0 && InpMaxRiskPercent < InpRiskPercent)
     { Print("Sentinal: InpMaxRiskPercent must be >= InpRiskPercent (it is a ceiling)."); return(false); }
   if(InpMaxTotalRiskPct > 0.0 && InpMaxTotalRiskPct < InpMaxRiskPercent)
     Print("Sentinal: warning — InpMaxTotalRiskPct is below the per-trade ceiling; "
           "some single trades will be rejected by the portfolio cap.");

   if(InpStrategy == STRAT_EMA_CROSS && InpFastEMA >= InpSlowEMA)
     { Print("Sentinal: InpFastEMA must be smaller than InpSlowEMA."); return(false); }
   if(InpStrategy == STRAT_RSI_REVERSION &&
      (InpRSIOversold <= 0 || InpRSIOverbought >= 100 || InpRSIOversold >= InpRSIOverbought))
     { Print("Sentinal: need 0 < oversold < overbought < 100."); return(false); }
   if(InpStrategy == STRAT_BREAKOUT && InpBreakoutBars < 2)
     { Print("Sentinal: InpBreakoutBars must be >= 2."); return(false); }

   if(InpUseTimeFilter && (InpStartHour < 0 || InpEndHour > 24 || InpStartHour >= InpEndHour))
     { Print("Sentinal: need 0 <= StartHour < EndHour <= 24."); return(false); }

   if(InpUseDollarStops)
     {
      if(InpInitialLot <= 0.0)
        { Print("Sentinal: InpInitialLot must be > 0."); return(false); }
      if(InpStopLossUSD <= 0.0)
        { Print("Sentinal: InpStopLossUSD must be > 0 in dollar-stop mode."); return(false); }
     }

   if(InpUseMartingale)
     {
      if(InpMartingaleMult < 1.0)
        { Print("Sentinal: InpMartingaleMult must be >= 1.0."); return(false); }
      if(InpMaxRecovery < 0)
        { Print("Sentinal: InpMaxRecovery cannot be negative."); return(false); }
      if(InpLossTriggerUSD < 0.0)
        { Print("Sentinal: InpLossTriggerUSD cannot be negative."); return(false); }
     }

   if(InpNewYorkOnly && (InpNYStartHour < 0 || InpNYStartHour > 23 ||
                         InpNYEndHour   < 1 || InpNYEndHour   > 24))
     { Print("Sentinal: NY hours must be 0-23 (start) and 1-24 (end)."); return(false); }

   return(true);
  }

//+------------------------------------------------------------------+
//| Indicator handles                                                |
//+------------------------------------------------------------------+
bool CreateIndicators()
  {
   switch(InpStrategy)
     {
      case STRAT_EMA_CROSS:
         g_hFast = iMA(_Symbol, PERIOD_CURRENT, InpFastEMA, 0, MODE_EMA, PRICE_CLOSE);
         g_hSlow = iMA(_Symbol, PERIOD_CURRENT, InpSlowEMA, 0, MODE_EMA, PRICE_CLOSE);
         if(g_hFast == INVALID_HANDLE || g_hSlow == INVALID_HANDLE)
           { Print("Sentinal: EMA handle failed. err=", GetLastError()); return(false); }
         break;

      case STRAT_RSI_REVERSION:
         g_hRSI = iRSI(_Symbol, PERIOD_CURRENT, InpRSIPeriod, PRICE_CLOSE);
         if(g_hRSI == INVALID_HANDLE)
           { Print("Sentinal: RSI handle failed. err=", GetLastError()); return(false); }
         break;

      case STRAT_BREAKOUT:
         break;   // raw price data, no handle needed
     }

   if(InpUseATRStops || InpUseTrailingStop)
     {
      g_hATR = iATR(_Symbol, PERIOD_CURRENT, InpATRPeriod);
      if(g_hATR == INVALID_HANDLE)
        { Print("Sentinal: ATR handle failed. err=", GetLastError()); return(false); }
     }

   if(InpUseTrendFilter)
     {
      g_hTrend = iMA(_Symbol, InpTrendTF, InpTrendEMA, 0, MODE_EMA, PRICE_CLOSE);
      if(g_hTrend == INVALID_HANDLE)
        { Print("Sentinal: trend EMA handle failed. err=", GetLastError()); return(false); }
     }

   if(InpUseADX)
     {
      g_hADX = iADX(_Symbol, InpTrendTF, InpADXPeriod);
      if(g_hADX == INVALID_HANDLE)
        { Print("Sentinal: ADX handle failed. err=", GetLastError()); return(false); }
     }

   return(true);
  }

//+------------------------------------------------------------------+
//| Tick                                                             |
//+------------------------------------------------------------------+
void OnTick()
  {
   if(InpShowPanel)
      PanelUpdate();

   if(!TradingReady())
      return;

   // Manage what is already open every tick, not just on new bars —
   // trailing stops and reversals should not wait for a candle to close.
   ManageOpenPositions();

   UpdateDailyTracking();
   UpdateRecoveryState();

   if(InpDailyProfitUSD > 0.0 && !g_dayHalted && g_dayStartBalance > 0.0)
     {
      double dayProfit = AccountInfoDouble(ACCOUNT_EQUITY) - g_dayStartBalance;
      if(dayProfit >= InpDailyProfitUSD)
        {
         g_dayHalted = true;
         PrintFormat("Sentinal: daily profit target %.2f reached (%.2f). Done for today.",
                     InpDailyProfitUSD, dayProfit);
        }
     }

   if(InpTargetProfitPct > 0.0 && !g_halted && g_startBalance > 0.0)
     {
      double gainPct = (AccountInfoDouble(ACCOUNT_EQUITY) - g_startBalance)
                       / g_startBalance * 100.0;
      if(gainPct >= InpTargetProfitPct)
        {
         g_halted = true;
         PrintFormat("Sentinal: target +%.2f%% reached (%.2f%%). Halting new entries.",
                     InpTargetProfitPct, gainPct);
        }
     }
   bool newBar = IsNewBar();

   // In bar-close mode nothing is re-evaluated mid-candle. In intrabar
   // mode every tick is a chance to enter, capped at one entry per bar
   // so a signal flickering across a threshold cannot machine-gun orders.
   if(!InpIntrabarSignals && !newBar)
      return;

   // Work out whether this bar trades, and if not, exactly why. "Nothing
   // is happening" is the normal state for a filtered strategy, so this
   // has to distinguish that from something actually being broken. Note
   // auto-trade being off is counted as a reason rather than an early
   // return, so a monitor-only run still reports what it would have done.
   EBlock  blk    = BLK_ENTER;
   ESignal signal = SIGNAL_NONE;
   int     trend  = 0;

   if(!InpAutoTrade)
      blk = BLK_AUTOTRADE_OFF;
   else if(g_halted)
      blk = BLK_TARGET_HALT;
   else if(MaxTotalLossHit())
      blk = BLK_MAXLOSS;
   else if(!WithinNewYorkSession())
      blk = BLK_SESSION;
   else if(!WithinTradingHours())
      blk = BLK_HOURS;
   else if(DailyLossHit())
      blk = BLK_DAILY_LOSS;
   else if(!SpreadAcceptable())
      blk = BLK_SPREAD;
   else if(OpenPositionCount() >= InpMaxPositions)
      blk = BLK_POSLIMIT;
   else if(InpMaxTotalRiskPct > 0.0 && OpenRiskPercent() >= InpMaxTotalRiskPct)
      blk = BLK_TOTALRISK;
   else
     {
      signal = Signal();
      trend  = TrendDirection();

      if(signal == SIGNAL_NONE)
         blk = BLK_NOSIGNAL;
      else if((InpDirection == DIR_LONG_ONLY  && signal == SIGNAL_SELL) ||
              (InpDirection == DIR_SHORT_ONLY && signal == SIGNAL_BUY))
         blk = BLK_DIRECTION;
      else if(InpUseTrendFilter && trend == 0)
         blk = BLK_TREND_FLAT;
      else if(InpUseTrendFilter && trend != (int)signal)
         blk = BLK_TREND_OPPOSED;
     }

   // Tally once per bar, so the summary's percentages stay per-bar and
   // are not diluted by tick count in intrabar mode.
   if(newBar)
     {
      g_barsSeen++;
      g_blockTally[blk]++;
     }

   if(InpVerboseLog && newBar)
     {
      double atr = CurrentATR();
      PrintFormat("Sentinal bar %s | signal=%s trend=%s spread=%.0f atr=%.0f -> %s",
                  TimeToString(g_lastBar, TIME_DATE | TIME_MINUTES),
                  (signal == SIGNAL_BUY ? "BUY" : (signal == SIGNAL_SELL ? "SELL" : "none")),
                  (trend > 0 ? "up" : (trend < 0 ? "down" : "flat")),
                  CurrentSpreadPoints(),
                  (atr > 0.0 ? atr / _Point : 0.0),
                  BlockName(blk));
     }

   if(blk != BLK_ENTER)
      return;

   if(g_lastEntryBar == g_lastBar)
      return;                       // already entered on this candle

   OpenTrade(signal == SIGNAL_BUY ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);
   g_lastEntryBar = g_lastBar;
  }

//+------------------------------------------------------------------+
//| Trend direction: +1 up, -1 down, 0 undecided / not trending      |
//+------------------------------------------------------------------+
int TrendDirection()
  {
   if(!InpUseTrendFilter)
      return(0);

   double ema[];
   ArraySetAsSeries(ema, true);
   if(CopyBuffer(g_hTrend, 0, 0, 2, ema) < 2)
      return(0);

   // ADX measures trend strength, not direction: a low reading means
   // the market is ranging, where trend-following entries bleed.
   if(InpUseADX)
     {
      double adx[];
      ArraySetAsSeries(adx, true);
      if(CopyBuffer(g_hADX, 0, 0, 2, adx) < 2)
         return(0);
      if(adx[0] < InpADXMin)
         return(0);
     }

   double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(price <= 0.0)
      return(0);

   if(price > ema[0]) return(1);
   if(price < ema[0]) return(-1);
   return(0);
  }

//+------------------------------------------------------------------+
//| Entry signals — all read CLOSED candles only                     |
//+------------------------------------------------------------------+
ESignal Signal()
  {
   switch(InpStrategy)
     {
      case STRAT_EMA_CROSS:     return(SignalEmaCross());
      case STRAT_RSI_REVERSION: return(SignalRsiReversion());
      case STRAT_BREAKOUT:      return(SignalBreakout());
     }
   return(SIGNAL_NONE);
  }

//+------------------------------------------------------------------+
//| Which bar the rules read. 1 = the last CLOSED candle (settled,   |
//| a signal here can never be taken back). 0 = the candle currently |
//| forming, which reacts instantly but can change its mind on the   |
//| next tick.                                                       |
//+------------------------------------------------------------------+
int SignalShift()
  {
   return(InpIntrabarSignals ? 0 : 1);
  }

ESignal SignalEmaCross()
  {
   double fast[], slow[];
   ArraySetAsSeries(fast, true);
   ArraySetAsSeries(slow, true);

   int s = SignalShift();
   if(CopyBuffer(g_hFast, 0, s, 2, fast) < 2) return(SIGNAL_NONE);
   if(CopyBuffer(g_hSlow, 0, s, 2, slow) < 2) return(SIGNAL_NONE);

   if(fast[1] <= slow[1] && fast[0] > slow[0]) return(SIGNAL_BUY);
   if(fast[1] >= slow[1] && fast[0] < slow[0]) return(SIGNAL_SELL);
   return(SIGNAL_NONE);
  }

ESignal SignalRsiReversion()
  {
   double rsi[];
   ArraySetAsSeries(rsi, true);

   int s = SignalShift();
   if(CopyBuffer(g_hRSI, 0, s, 2, rsi) < 2) return(SIGNAL_NONE);

   if(rsi[1] <  InpRSIOversold   && rsi[0] >= InpRSIOversold)   return(SIGNAL_BUY);
   if(rsi[1] >  InpRSIOverbought && rsi[0] <= InpRSIOverbought) return(SIGNAL_SELL);
   return(SIGNAL_NONE);
  }

ESignal SignalBreakout()
  {
   MqlRates r[];
   ArraySetAsSeries(r, true);

   int s    = SignalShift();
   int need = InpBreakoutBars + s + 2;
   if(CopyRates(_Symbol, PERIOD_CURRENT, 0, need, r) < need)
      return(SIGNAL_NONE);

   // Range excludes the bar being tested, so its close is measured
   // against a range it did not help form.
   double hi = r[s + 1].high, lo = r[s + 1].low;
   for(int i = s + 2; i <= s + InpBreakoutBars; i++)
     {
      hi = MathMax(hi, r[i].high);
      lo = MathMin(lo, r[i].low);
     }

   if(r[s].close > hi) return(SIGNAL_BUY);
   if(r[s].close < lo) return(SIGNAL_SELL);
   return(SIGNAL_NONE);
  }

//+------------------------------------------------------------------+
//| Current ATR in price terms                                       |
//+------------------------------------------------------------------+
double CurrentATR()
  {
   if(g_hATR == INVALID_HANDLE)
      return(0.0);

   double atr[];
   ArraySetAsSeries(atr, true);
   if(CopyBuffer(g_hATR, 0, 1, 1, atr) < 1)
      return(0.0);

   return(atr[0]);
  }

//+------------------------------------------------------------------+
//| Stop / target distances in price, adapted to live volatility     |
//+------------------------------------------------------------------+
bool StopDistances(double &stopDist, double &targetDist)
  {
   if(InpUseATRStops)
     {
      double atr = CurrentATR();
      if(atr <= 0.0)
        {
         Print("Sentinal: ATR unavailable; skipping entry.");
         return(false);
        }
      stopDist   = atr * InpATRStopMult;
      targetDist = atr * InpATRTargetMult;
     }
   else
     {
      stopDist   = InpStopLossPoints   * _Point;
      targetDist = InpTakeProfitPoints * _Point;
     }

   // Respect the broker's minimum stop distance by widening, not by
   // abandoning the trade.
   double minDist = MinStopDistance();
   if(stopDist   < minDist) stopDist   = minDist;
   if(targetDist > 0.0 && targetDist < minDist) targetDist = minDist;

   return(stopDist > 0.0);
  }

double MinStopDistance()
  {
   long stopLevel  = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL);
   long freezeLvl  = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL);
   long lvl        = MathMax(stopLevel, freezeLvl);
   double spread   = SymbolInfoDouble(_Symbol, SYMBOL_ASK) -
                     SymbolInfoDouble(_Symbol, SYMBOL_BID);

   // A stop inside the spread is hit the instant it is placed.
   return(MathMax(lvl * _Point, spread * 2.0));
  }

//+------------------------------------------------------------------+
//| Order execution                                                  |
//+------------------------------------------------------------------+
void OpenTrade(const ENUM_ORDER_TYPE type)
  {
   double price = (type == ORDER_TYPE_BUY)
                  ? SymbolInfoDouble(_Symbol, SYMBOL_ASK)
                  : SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(price <= 0.0)
      return;

   double stopDist = 0.0, targetDist = 0.0, lots = 0.0;

   if(InpUseDollarStops)
     {
      // Dollar mode: the stop is a fixed cash amount, so lot size has to
      // be decided first and the price distance derived from it.
      lots = MartingaleLots();
      if(lots <= 0.0)
        {
         g_sizingSkips++;
         return;
        }

      stopDist   = UsdToPriceDist(InpStopLossUSD,   lots);
      targetDist = UsdToPriceDist(InpTakeProfitUSD, lots);

      double minDist = MinStopDistance();
      if(stopDist   < minDist) stopDist   = minDist;
      if(targetDist > 0.0 && targetDist < minDist) targetDist = minDist;

      if(stopDist <= 0.0)
        {
         Print("Sentinal: could not convert $ stop into a price distance.");
         g_sizingSkips++;
         return;
        }
     }
   else
     {
      if(!StopDistances(stopDist, targetDist))
         return;
      lots = CalculateLots(stopDist);
     }

   double sl = (type == ORDER_TYPE_BUY) ? price - stopDist : price + stopDist;
   double tp = 0.0;
   if(targetDist > 0.0)
      tp = (type == ORDER_TYPE_BUY) ? price + targetDist : price - targetDist;

   sl = NormalizeDouble(sl, _Digits);
   tp = (tp > 0.0) ? NormalizeDouble(tp, _Digits) : 0.0;

   if(lots <= 0.0)
     {
      g_sizingSkips++;
      return;
     }

   // Portfolio cap: one trade may be within its own limit and still take
   // the account's combined exposure past what it can absorb.
   if(InpMaxTotalRiskPct > 0.0)
     {
      double balance = AccountInfoDouble(ACCOUNT_BALANCE);
      if(balance > 0.0)
        {
         double newRiskPct = MoneyPerLot(stopDist) * lots / balance * 100.0;
         double projected  = OpenRiskPercent() + newRiskPct;
         if(projected > InpMaxTotalRiskPct)
           {
            PrintFormat("Sentinal: entry would take combined open risk to %.2f%% (cap %.2f%%). Skipped.",
                        projected, InpMaxTotalRiskPct);
            return;
           }
        }
     }

   if(!MarginSufficient(type, lots, price))
      return;

   bool ok = (type == ORDER_TYPE_BUY)
             ? trade.Buy(lots, _Symbol, 0.0, sl, tp, "Sentinal")
             : trade.Sell(lots, _Symbol, 0.0, sl, tp, "Sentinal");

   if(!ok)
      PrintFormat("Sentinal: order failed. retcode=%d (%s)",
                  trade.ResultRetcode(), trade.ResultRetcodeDescription());
   else
     {
      g_ordersPlaced++;
      PrintFormat("Sentinal: %s %.2f lots @ %s  SL=%s TP=%s  (stop %.0f pts)",
                  (type == ORDER_TYPE_BUY ? "BUY" : "SELL"), lots,
                  DoubleToString(trade.ResultPrice(), _Digits),
                  DoubleToString(sl, _Digits), DoubleToString(tp, _Digits),
                  stopDist / _Point);
     }
  }

//+------------------------------------------------------------------+
//| Position sizing from the actual stop distance                    |
//+------------------------------------------------------------------+
//+------------------------------------------------------------------+
//| Money risked per lot over a given price distance                 |
//+------------------------------------------------------------------+
double MoneyPerLot(const double priceDist)
  {
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue <= 0.0 || tickSize <= 0.0 || priceDist <= 0.0)
      return(0.0);
   return((priceDist / tickSize) * tickValue);
  }

//+------------------------------------------------------------------+
//| Combined risk of everything currently open, as % of balance      |
//+------------------------------------------------------------------+
double OpenRiskPercent()
  {
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   if(balance <= 0.0)
      return(0.0);

   double total = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!position.SelectByIndex(i))
         continue;
      if(position.Symbol() != _Symbol || position.Magic() != InpMagicNumber)
         continue;

      double sl = position.StopLoss();
      if(sl <= 0.0)
         continue;
      total += MoneyPerLot(MathAbs(position.PriceOpen() - sl)) * position.Volume();
     }

   return(total / balance * 100.0);
  }

//+------------------------------------------------------------------+
//| Position sizing — everything scales off the LIVE balance, so the |
//| same settings stay correct as the account grows or shrinks.      |
//+------------------------------------------------------------------+
double CalculateLots(const double stopDist)
  {
   if(!InpUseRiskPercent)
      return(NormalizeLots(InpFixedLots));

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   if(balance <= 0.0)
      return(0.0);

   double lossPerLot = MoneyPerLot(stopDist);
   if(lossPerLot <= 0.0)
     {
      Print("Sentinal: cannot size by risk (bad tick value/size).");
      return(0.0);
     }

   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double lots   = (balance * InpRiskPercent / 100.0) / lossPerLot;

   if(lots < minLot)
     {
      // The smallest tradeable position risks more than the target. Take
      // it only while that stays under the ceiling — which is itself a
      // percentage, so this constraint dissolves as the balance grows
      // and tightens automatically if the account draws down.
      double minLotPct = lossPerLot * minLot / balance * 100.0;

      if(InpMaxRiskPercent <= 0.0 || minLotPct > InpMaxRiskPercent)
        {
         PrintFormat("Sentinal: min lot %.2f risks %.2f%% of %.2f (target %.2f%%, ceiling %.2f%%). Skipped.",
                     minLot, minLotPct, balance, InpRiskPercent, InpMaxRiskPercent);
         return(0.0);
        }

      PrintFormat("Sentinal: min lot %.2f risks %.2f%% vs %.2f%% target — within the %.2f%% ceiling, taking it.",
                  minLot, minLotPct, InpRiskPercent, InpMaxRiskPercent);
      lots = minLot;
     }

   return(NormalizeLots(lots));
  }

//+------------------------------------------------------------------+
//| Convert a dollar risk into a price distance for a given lot size |
//+------------------------------------------------------------------+
double UsdToPriceDist(const double usd, const double lots)
  {
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue <= 0.0 || tickSize <= 0.0 || lots <= 0.0 || usd <= 0.0)
      return(0.0);
   return((usd * tickSize) / (tickValue * lots));
  }

//+------------------------------------------------------------------+
//| Martingale state.                                                |
//|                                                                  |
//| After a closing deal loses more than InpLossTriggerUSD the next   |
//| position is multiplied, up to InpMaxRecovery escalations. Any     |
//| winning deal resets the ladder. The escalation is capped rather   |
//| than unbounded, which is the whole of the "safer" in this scheme: |
//| the sequence still ends in one large loss, it just ends sooner.   |
//+------------------------------------------------------------------+
void UpdateRecoveryState()
  {
   if(!InpUseMartingale)
      return;

   if(!HistorySelect(g_lastDealTime, TimeCurrent() + 60))
      return;

   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0)
         continue;
      if(HistoryDealGetString(ticket, DEAL_SYMBOL) != _Symbol)
         continue;
      if(HistoryDealGetInteger(ticket, DEAL_MAGIC) != InpMagicNumber)
         continue;
      if(HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT)
         continue;

      datetime dt = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
      if(dt <= g_lastDealTime)
         continue;
      g_lastDealTime = dt;

      double net = HistoryDealGetDouble(ticket, DEAL_PROFIT)
                 + HistoryDealGetDouble(ticket, DEAL_SWAP)
                 + HistoryDealGetDouble(ticket, DEAL_COMMISSION);

      if(net < -InpLossTriggerUSD)
        {
         if(g_recoveryStep < InpMaxRecovery)
           {
            g_recoveryStep++;
            PrintFormat("Sentinal: loss %.2f -> recovery step %d of %d (next lot x%.2f).",
                        net, g_recoveryStep, InpMaxRecovery,
                        MathPow(InpMartingaleMult, g_recoveryStep));
           }
         else
           {
            PrintFormat("Sentinal: loss %.2f at max recovery (%d). Ladder reset to base lot.",
                        net, InpMaxRecovery);
            g_recoveryStep = 0;
           }
        }
      else if(net > 0.0)
        {
         if(g_recoveryStep > 0)
            PrintFormat("Sentinal: win %.2f — recovery ladder reset.", net);
         g_recoveryStep = 0;
        }
     }
  }

//+------------------------------------------------------------------+
//| Lot size for the fixed-lot / martingale path                     |
//+------------------------------------------------------------------+
double MartingaleLots()
  {
   double lots = InpInitialLot;
   if(InpUseMartingale && g_recoveryStep > 0)
      lots = InpInitialLot * MathPow(InpMartingaleMult, g_recoveryStep);
   return(NormalizeLots(lots));
  }

//+------------------------------------------------------------------+
//| Total loss guard, measured against the balance at attach         |
//+------------------------------------------------------------------+
bool MaxTotalLossHit()
  {
   if(InpMaxLossPctBal <= 0.0 || g_startBalance <= 0.0)
      return(false);

   double changePct = (AccountInfoDouble(ACCOUNT_EQUITY) - g_startBalance)
                      / g_startBalance * 100.0;
   return(changePct <= -InpMaxLossPctBal);
  }

//+------------------------------------------------------------------+
//| New York session. Hours are SERVER time, which is usually not    |
//| your local time — the panel prints the server clock so the       |
//| window can be calibrated against it.                             |
//+------------------------------------------------------------------+
bool WithinNewYorkSession()
  {
   if(!InpNewYorkOnly)
      return(true);

   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);

   if(InpNYStartHour <= InpNYEndHour)
      return(t.hour >= InpNYStartHour && t.hour < InpNYEndHour);

   // Window wraps past midnight.
   return(t.hour >= InpNYStartHour || t.hour < InpNYEndHour);
  }

//+------------------------------------------------------------------+
//| Daily loss limit, rebased to balance at the start of each day    |
//+------------------------------------------------------------------+
void UpdateDailyTracking()
  {
   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   t.hour = 0; t.min = 0; t.sec = 0;
   datetime today = StructToTime(t);

   if(today != g_dayStamp)
     {
      g_dayStamp        = today;
      g_dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      g_dayHalted       = false;
     }
  }

bool DailyLossHit()
  {
   if(InpMaxDailyLossPct <= 0.0 || g_dayStartBalance <= 0.0)
      return(false);
   if(g_dayHalted)
      return(true);

   double change = (AccountInfoDouble(ACCOUNT_EQUITY) - g_dayStartBalance)
                   / g_dayStartBalance * 100.0;

   if(change <= -InpMaxDailyLossPct)
     {
      g_dayHalted = true;
      PrintFormat("Sentinal: daily loss limit hit (%.2f%% of %.2f). No new entries today.",
                  change, g_dayStartBalance);
      return(true);
     }
   return(false);
  }

double NormalizeLots(double lots)
  {
   double minLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(lotStep <= 0.0) lotStep = 0.01;

   lots = MathFloor(lots / lotStep) * lotStep;
   lots = MathMax(minLot, MathMin(maxLot, lots));

   int lotDigits = (int)MathMax(0, MathRound(-MathLog10(lotStep)));
   return(NormalizeDouble(lots, lotDigits));
  }

//+------------------------------------------------------------------+
//| Reject the order before the broker does                          |
//+------------------------------------------------------------------+
bool MarginSufficient(const ENUM_ORDER_TYPE type, const double lots, const double price)
  {
   double required = 0.0;
   if(!OrderCalcMargin(type, _Symbol, lots, price, required))
     {
      Print("Sentinal: OrderCalcMargin failed. err=", GetLastError());
      return(false);
     }

   double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   if(required > freeMargin)
     {
      PrintFormat("Sentinal: not enough free margin (need %.2f, have %.2f).",
                  required, freeMargin);
      return(false);
     }
   return(true);
  }

//+------------------------------------------------------------------+
//| Manage open positions: reversal exit, then trailing stop         |
//+------------------------------------------------------------------+
void ManageOpenPositions()
  {
   int trend = TrendDirection();
   double atr = (InpUseTrailingStop ? CurrentATR() : 0.0);

   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!position.SelectByIndex(i))
         continue;
      if(position.Symbol() != _Symbol || position.Magic() != InpMagicNumber)
         continue;

      bool isBuy = (position.PositionType() == POSITION_TYPE_BUY);
      int  dir   = isBuy ? 1 : -1;

      // Trend flipped against an open trade — exit rather than sit
      // through it waiting for the stop.
      if(InpCloseOnReverse && InpUseTrendFilter && trend != 0 && trend != dir)
        {
         if(trade.PositionClose(position.Ticket()))
            PrintFormat("Sentinal: closed #%I64u on trend reversal.", position.Ticket());
         else
            PrintFormat("Sentinal: failed to close #%I64u. retcode=%d",
                        position.Ticket(), trade.ResultRetcode());
         continue;
        }

      if(!InpUseTrailingStop || atr <= 0.0)
         continue;

      double trailDist = MathMax(atr * InpATRTrailMult, MinStopDistance());
      double current   = isBuy ? SymbolInfoDouble(_Symbol, SYMBOL_BID)
                               : SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double newSL     = isBuy ? current - trailDist : current + trailDist;
      newSL = NormalizeDouble(newSL, _Digits);

      double oldSL = position.StopLoss();

      // Only ever tighten, never loosen — so trailing can reduce the risk
      // on a trade but never widen it beyond the original stop. The stop
      // must also stay on the correct side of the current price.
      bool improves = isBuy
                      ? (newSL < current && (oldSL <= 0.0 || newSL > oldSL))
                      : (newSL > current && (oldSL <= 0.0 || newSL < oldSL));

      if(!improves)
         continue;

      // Skip micro-adjustments; every modify is a server round trip.
      if(oldSL > 0.0 && MathAbs(newSL - oldSL) < MinStopDistance())
         continue;

      if(!trade.PositionModify(position.Ticket(), newSL, position.TakeProfit()))
         PrintFormat("Sentinal: trail modify failed on #%I64u. retcode=%d",
                     position.Ticket(), trade.ResultRetcode());
     }
  }

//+------------------------------------------------------------------+
//| Guards                                                           |
//+------------------------------------------------------------------+
bool TradingReady()
  {
   if(!TerminalInfoInteger(TERMINAL_CONNECTED))   return(false);
   if(!MQLInfoInteger(MQL_TRADE_ALLOWED))         return(false);
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)) return(false);
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))  return(false);
   if(!MarketOpen())                              return(false);
   return(true);
  }

//+------------------------------------------------------------------+
//| Gold trades nearly around the clock but still has a daily break. |
//| Full trade mode plus a fresh tick is the reliable test.          |
//+------------------------------------------------------------------+
bool MarketOpen()
  {
   long mode = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE);
   if(mode != SYMBOL_TRADE_MODE_FULL && mode != SYMBOL_TRADE_MODE_LONGONLY &&
      mode != SYMBOL_TRADE_MODE_SHORTONLY)
      return(false);

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return(false);
   if(tick.bid <= 0.0 || tick.ask <= 0.0)
      return(false);

   return(true);
  }

bool WithinTradingHours()
  {
   if(!InpUseTimeFilter)
      return(true);

   MqlDateTime t;
   TimeToStruct(TimeCurrent(), t);
   return(t.hour >= InpStartHour && t.hour < InpEndHour);
  }

//+------------------------------------------------------------------+
//| Spread filter.                                                   |
//|                                                                  |
//| An absolute point limit is broker-specific: gold quotes at 2 or  |
//| 3 digits depending on the broker, so the same 26c spread reads   |
//| as 26 points on one and 260 on another. The ATR-relative test    |
//| is the one that actually means something — a spread that is a    |
//| large fraction of the current range eats the trade regardless    |
//| of what the absolute number looks like.                          |
//+------------------------------------------------------------------+
bool SpreadAcceptable()
  {
   double spreadPts = CurrentSpreadPoints();

   if(InpMaxSpreadPoints > 0 && spreadPts > InpMaxSpreadPoints)
      return(false);

   if(InpMaxSpreadATR > 0.0)
     {
      double atr = CurrentATR();
      if(atr > 0.0 && (spreadPts * _Point) > (atr * InpMaxSpreadATR))
         return(false);
     }

   return(true);
  }

double CurrentSpreadPoints()
  {
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(_Point <= 0.0)
      return(0.0);
   return((ask - bid) / _Point);
  }

int OpenPositionCount()
  {
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(!position.SelectByIndex(i))
         continue;
      if(position.Symbol() == _Symbol && position.Magic() == InpMagicNumber)
         count++;
     }
   return(count);
  }

bool IsNewBar()
  {
   datetime thisBar = (datetime)SeriesInfoInteger(_Symbol, PERIOD_CURRENT, SERIES_LASTBAR_DATE);
   if(thisBar == g_lastBar)
      return(false);
   g_lastBar = thisBar;
   return(true);
  }

//+------------------------------------------------------------------+
//| Status panel — every value read straight from the terminal       |
//+------------------------------------------------------------------+
void PanelUpdate()
  {
   bool connected = TerminalInfoInteger(TERMINAL_CONNECTED);
   bool expertsOn = MQLInfoInteger(MQL_TRADE_ALLOWED) &&
                    AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) &&
                    AccountInfoInteger(ACCOUNT_TRADE_EXPERT);

   string state; color stateColor;
   if(!connected)         { state = "DISCONNECTED";    stateColor = clrOrangeRed; }
   else if(!MarketOpen()) { state = "MARKET CLOSED";   stateColor = clrGold;      }
   else if(g_halted)      { state = "HALTED (target)"; stateColor = clrGold;      }
   else if(g_dayHalted)   { state = "HALTED (daily loss)"; stateColor = clrOrangeRed; }
   else if(!expertsOn)    { state = "TRADING BLOCKED"; stateColor = clrOrangeRed; }
   else if(!InpAutoTrade) { state = "MONITOR ONLY";    stateColor = clrGold;      }
   else                   { state = "LIVE";            stateColor = clrLime;      }

   int trend = TrendDirection();
   string trendText = !InpUseTrendFilter ? "off"
                      : (trend > 0 ? "UP" : (trend < 0 ? "DOWN" : "ranging / weak"));

   double atr = CurrentATR();
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);

   int row = 0;
   PanelLine(row++, "Sentinal",  stateColor, state);
   PanelLine(row++, "Server",    InpPanelColor, AccountInfoString(ACCOUNT_SERVER));
   PanelLine(row++, "Account",   InpPanelColor,
             IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "  " +
             AccountInfoString(ACCOUNT_CURRENCY) +
             (AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO
              ? "  [DEMO]" : "  [REAL]"));
   PanelLine(row++, "Symbol",    InpPanelColor,
             _Symbol + "  " + EnumToString((ENUM_TIMEFRAMES)Period()));
   PanelLine(row++, "Strategy",  InpPanelColor, EnumToString(InpStrategy));
   PanelLine(row++, "Trend",     InpPanelColor,
             trendText + "  (" + EnumToString(InpTrendTF) + " EMA" +
             IntegerToString(InpTrendEMA) + ")");
   PanelLine(row++, "Bid/Ask",   InpPanelColor,
             DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_BID), _Digits) + " / " +
             DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_ASK), _Digits));
   PanelLine(row++, "Spread",    InpPanelColor,
             DoubleToString(CurrentSpreadPoints(), 0) + " / " +
             IntegerToString(InpMaxSpreadPoints) + " pts" +
             (SpreadAcceptable() ? "" : "  (TOO WIDE - no entries)"));
   PanelLine(row++, "ATR",       InpPanelColor,
             (atr > 0.0 ? DoubleToString(atr / _Point, 0) + " pts" : "warming up"));
   PanelLine(row++, "Positions", InpPanelColor,
             IntegerToString(OpenPositionCount()) + " / " + IntegerToString(InpMaxPositions));
   PanelLine(row++, "Equity",    InpPanelColor,
             DoubleToString(equity, 2) + "   P/L " +
             DoubleToString(equity - g_startBalance, 2));

   // What the smallest tradeable position would risk right now, as a
   // share of the live balance. This is the number that decides whether
   // a signal becomes a trade on a small account.
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double minLotPct = 0.0;
   if(atr > 0.0 && balance > 0.0)
     {
      double sd     = (InpUseATRStops ? atr * InpATRStopMult
                                      : InpStopLossPoints * _Point);
      double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
      minLotPct     = MoneyPerLot(sd) * minLot / balance * 100.0;
     }

   bool affordable = (minLotPct > 0.0 && minLotPct <= InpMaxRiskPercent);
   PanelLine(row++, "Risk", (minLotPct > 0.0 && !affordable ? clrOrangeRed : InpPanelColor),
             StringFormat("%.1f%% target | min lot %.2f%% | ceiling %.1f%%%s",
                          InpRiskPercent, minLotPct, InpMaxRiskPercent,
                          (minLotPct > 0.0 && !affordable ? "  (NO TRADES)" : "")));
   PanelLine(row++, "Open risk", InpPanelColor,
             StringFormat("%.2f%% / %.1f%%", OpenRiskPercent(), InpMaxTotalRiskPct));

   MqlDateTime st;
   TimeToStruct(TimeCurrent(), st);
   PanelLine(row++, "Server", InpPanelColor,
             StringFormat("%02d:%02d%s", st.hour, st.min,
                          (InpNewYorkOnly
                           ? (WithinNewYorkSession() ? "   NY session OPEN"
                                                     : "   outside NY session")
                           : "")));

   if(InpUseMartingale)
      PanelLine(row++, "Recovery", (g_recoveryStep > 0 ? clrOrangeRed : InpPanelColor),
                StringFormat("step %d / %d   next lot %.2f",
                             g_recoveryStep, InpMaxRecovery, MartingaleLots()));

   ChartRedraw();
  }

void PanelLine(const int row, const string label, const color clr, const string value)
  {
   string name = PANEL_PREFIX + IntegerToString(row);

   if(ObjectFind(0, name) < 0)
     {
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, 12);
      ObjectSetInteger(0, name, OBJPROP_FONTSIZE, 9);
      ObjectSetString(0, name, OBJPROP_FONT, "Consolas");
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
      ObjectSetInteger(0, name, OBJPROP_ZORDER, 1);
     }

   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, 20 + row * 16);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetString(0, name, OBJPROP_TEXT, StringFormat("%-10s %s", label + ":", value));
  }
//+------------------------------------------------------------------+
