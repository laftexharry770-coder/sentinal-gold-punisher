//+------------------------------------------------------------------+
//|                                                    Angel_Bot.mq5 |
//|                                                                  |
//|  "Angel Bot" - XAUUSD stop-order bracket scalper, reconstructed  |
//|  from live recordings of "NEW ANGEL BOT" running on XAUUSD.ecn   |
//|                                                                  |
//|  THE MECHANISM                                                   |
//|  ---------------------------------------------------------------|
//|  Price is bracketed by a BUY STOP above and a SELL STOP below.   |
//|  Each order trails TOWARD the price at StopDistance from the     |
//|  extreme: the buy stop sits StopDistance above the lowest BID    |
//|  since it was (re)placed and only ever moves down; the sell stop |
//|  sits StopDistance below the highest BID and only moves up.      |
//|                                                                  |
//|  Whichever order fills opens a position, and both orders are     |
//|  then re-priced StopDistance either side of the FILL.            |
//|                                                                  |
//|  As shown in the new recording, every position actively updates  |
//|  its server-side Stop Loss. When basket trail is enabled, all    |
//|  positions of the same direction share ONE tightest server S/L   |
//|  and exit as a unit.                                             |
//+------------------------------------------------------------------+
#property copyright   "Angel Bot - reconstructed from video"
#property version     "1.10"
#property description "Angel Bot: XAUUSD stop-order bracket with unified server-side basket trail; all distances in pips"
#property strict

#include <Trade\Trade.mqh>

input group           "=== Position sizing ==="
input double InpLots               = 0.10;   // Base lot size (Updated to match video sizing)
input int    InpPositionsPerEntry  = 2;      // Positions opened when a cycle starts from flat
input int    InpMaxPositions       = 5;      // Max positions per direction

input group           "=== Pip definition ==="
input double InpPipSize            = 0.10;   // Price units per pip (XAUUSD: 1 pip = $0.10 = 10 points)

input group           "=== Stop-order geometry (pips) ==="
input double InpStopDistance       = 1.9;    // Pending stop distance from the price extreme, pips
input double InpStraddleDistance   = 1.0;    // Initial straddle half-width when flat, pips
input double InpOrderStep          = 0.1;    // Min move before a pending order is re-priced, pips

input group           "=== Basket trailing stop (pips) ==="
input double InpTrailDistance      = 3.0;    // Trailing stop behind best price, pips
input double InpTrailStep          = 0.1;    // Min improvement before the trail moves, pips
input bool   InpBasketTrail        = true;   // Basket trailing SL: one shared server level per direction
input double InpHardStopLoss       = 2.0;    // Initial server-side safety SL per position, pips
input bool   InpCloseOppositeOnReversal = false; // Close the old basket the moment a reversal fills

input group           "=== Take profit (pips) ==="
input double InpTakeProfit         = 3.0;    // TP from entry, pips (0 = off)

input group           "=== Daily profit target (account currency) ==="
input double InpDailyProfitTarget  = 20.0;   // Stop for the day once today's P/L >= this (0 = off)
input double InpDailyLossLimit     = 0.0;    // Stop for the day once today's P/L <= -this (0 = off)
input int    InpDailyResetHour     = 0;      // Server hour at which the trading day starts (0-23)

input group           "=== Protection ==="
input double InpMaxSpread          = 6.0;    // Suspend pendings above this spread, pips
input double InpSpreadBuffer       = 0.0;    // Extra gap for pendings, as a multiple of the spread

input group           "=== Adaptive engine (recalibrates to the broker) ==="
input bool   InpAdaptive       = true;     // Auto-tune distances/steps/guard to measured spread
input int    InpAdaptUpdateSec = 30;       // Recalibrate every N seconds (0 = every tick)
input int    InpAdaptVolBars   = 30;       // 1-minute bars used for the volatility estimate
input double InpAdaptMinMult   = 1.0;      // Floor multiplier on Stop/Trail
input double InpAdaptMaxMult   = 4.0;      // Ceiling multiplier on Stop/Trail 
input double InpAdaptSpreadF   = 2.0;      // Stops keep >= this x typical spread 

input group           "=== Identity ==="
input long   InpMagic              = 15092026;
input double InpMaxDeviation       = 3.0;    // Max deviation on market fills, pips
input string InpComment            = "Angel Bot";
input bool   InpShowPanel          = true;   // Draw the status panel on the chart

//--- runtime -------------------------------------------------------
CTrade   trade;

int      gDigits;
double   gPoint;
double   gStopLevel;
double   gFreezeLevel;
double   gLotMin, gLotMax, gLotStep;
double   gLots;
double   gHardSL;                

struct BookEntry
  {
   ulong             ticket;
   int               type;      // POSITION_TYPE_BUY / POSITION_TYPE_SELL
   double            open;
   datetime          time;
   double            profit;    // floating profit + swap
   double            vol;       // position volume
  };

BookEntry gBook[];
int       gBuys = 0, gSells = 0;

// previous-tick snapshot for open/close event detection
ulong    gPrevTickets[];
int      gPrevBuys = 0, gPrevSells = 0;
bool     gAdopted = false;       
ulong    gSeen[];                
ulong    gDealPos[];             

// pending-order levels
double   gBuySeed = 0.0,  gBuyAnchor = 0.0,  gBuyLow   = 0.0;
double   gSellSeed = 0.0, gSellAnchor = 0.0, gSellHigh = 0.0;
bool     gBracketFlat = true;    
bool     gNeedReset   = true;
double   gResetRef    = 0.0;     
ulong    gResetTicket = 0;       

ulong    gBuyStopTicket = 0, gSellStopTicket = 0;
uint     gBuyPlacedMs = 0,   gSellPlacedMs = 0;
uint     gBuyRejectMs = 0,   gSellRejectMs = 0;

int      gTopUpDir   = -1;
int      gTopUpSent  = 0;
int      gTopUpTries = 0;
datetime gTopUpArmed = 0;
uint     gLastFlushMs = 0;       // last TopUp market-order attempt timestamp (throttle)
ulong    gTopUpSeed  = 0;        
int      gCloseDir   = -1;       
int      gLastFillDir = -1;      

ulong    gClosing[];
uint     gClosingMs[];

ulong    gModTicket = 0;
double   gModPrice  = 0.0;
bool     gTradeBlocked = false;
bool     gNetting = false;

struct FillEvent
  {
   double  price;                  
   int     dir;                    
   ulong   ticket;                
   ulong   deal;                   
  };
FillEvent gFillEv[];
ulong     gLastFillDeal = 0;

// trading day
datetime gDayStart    = 0;
bool     gDayLocked   = false;
string   gLockReason  = "";
double   gDayRealized = 0.0;
bool     gHistDirty   = true;

// spread guard state
bool     gSpreadPaused = false;
uint     gSpreadPauseNoteMs = 0;   

struct AdaptState
  {
   bool     ready;                        
   double   tick;                         
   double   tickFloor;                    
   double   spreadEma;                    
   double   spreadMin;                    
   double   volEma;                       
   double   stop, trail, straddle;        
   double   orderStep, trailStep;         
   double   buffer, maxSpread;            
   datetime lastCalc;
  };
AdaptState gA;

// fingerprint
long     gFills = 0, gReversals = 0, gAdds = 0, gTopUps = 0, gTrailExits = 0;
int      gMaxDepth = 0;
double   gSprSum = 0.0, gSprMin = DBL_MAX, gSprMax = 0.0;
long     gSprCount = 0, gSprBlocks = 0;

//+------------------------------------------------------------------+
//| Normalise a lot size to the broker's volume step within min/max  |
//+------------------------------------------------------------------+
double NormalizeLots(double lots)
  {
   if(gLotStep <= 0.0) return(lots);
   double v = MathRound(lots / gLotStep) * gLotStep;
   v = MathMax(gLotMin, MathMin(gLotMax, v));
   int digits = (int)MathMin(8, MathCeil(-MathLog10(gLotStep)));
   if(digits < 0) digits = 0;
   return(NormalizeDouble(v, digits));
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   gDigits  = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   gPoint   = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   gLotMin  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   gLotMax  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   gLotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   RefreshLevels();
   AdaptInit();

   trade.SetExpertMagicNumber(InpMagic);
   trade.SetDeviationInPoints((ulong)MathMax(1.0, MathRound(PipsToPrice(InpMaxDeviation) / gPoint)));
   trade.SetTypeFillingBySymbol(_Symbol);
   trade.SetAsyncMode(false);

   int marginMode = (int)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   gNetting = (marginMode != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING);
   if(gNetting)
     {
      if(marginMode == ACCOUNT_MARGIN_MODE_RETAIL_NETTING)
         Print("Angel Bot: NETTING account - one position per symbol. The basket becomes a single position.");
      else
         Print("Angel Bot: EXCHANGE-style account - treated like a netting account.");
     }

   long tradeMode = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE);
   if(tradeMode == SYMBOL_TRADE_MODE_DISABLED) return(INIT_FAILED);
   
   if(InpPipSize <= 0.0 || InpStopDistance <= 0.0 || InpTrailDistance <= 0.0 || InpStraddleDistance <= 0.0) return(INIT_FAILED);
   if(InpPositionsPerEntry < 1 || InpMaxPositions < 1) return(INIT_FAILED);

   gHardSL = PipsToPrice(InpHardStopLoss);
   if(gHardSL > 0.0)
     {
      if(gHardSL < gStopLevel + gPoint)
        {
         gHardSL = gStopLevel + gPoint;
         PrintFormat("Angel Bot WARNING: HardStopLoss raised to the broker minimum %.3f", gHardSL);
        }
     }

   gLots = NormalizeLots(InpLots);
   if(MathAbs(gLots - InpLots) > gLotStep / 4.0)
      PrintFormat("Angel Bot WARNING: lot size %.3f normalised to %.3f", InpLots, gLots);

   PrintFormat("Angel Bot on %s | digits=%d point=%.5f stopLevel=%.3f freeze=%.3f | lots=%.2f x%d (max %d) | "
               "stop=%.3f straddle=%.3f trail=%.3f hardSL=%.3f | target=%.2f lossLimit=%.2f resetHour=%d",
               _Symbol, gDigits, gPoint, gStopLevel, gFreezeLevel, gLots, InpPositionsPerEntry, InpMaxPositions,
               AStop(), AStraddle(), ATrail(), gHardSL,
               InpDailyProfitTarget, InpDailyLossLimit, InpDailyResetHour);

   PrintFormat("Angel Bot pips: 1 pip = %.3f | stop=%.1fp straddle=%.1fp trail=%.1fp hardSL=%.1fp tp=%.1fp maxSpread=%.1fp",
               PipSize(), InpStopDistance, InpStraddleDistance, InpTrailDistance, InpHardStopLoss, InpTakeProfit, InpMaxSpread);

   gDayStart  = DayStartFor(TimeCurrent());
   gHistDirty = true;

   gAdopted   = false;
   gNeedReset = true;
   gResetRef  = 0.0;
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   Comment("");
   GlobalVariablesFlush();

   bool leaving = (reason == REASON_REMOVE || reason == REASON_CHARTCLOSE ||
                   reason == REASON_PROGRAM || reason == REASON_TEMPLATE ||
                   reason == REASON_INITFAILED || reason == REASON_ACCOUNT ||
                   (reason == REASON_CHARTCHANGE && ChartSymbol(0) != _Symbol));
   if(leaving)
     {
      ClearPendings();
      if(gBuys + gSells > 0)
         PrintFormat("Angel Bot WARNING: removed with %d buys / %d sells still open - they are no longer trailed.",
                     gBuys, gSells);
     }
  }

//+------------------------------------------------------------------+
double OnTester()
  {
   double trades = TesterStatistics(STAT_TRADES);
   double wins   = TesterStatistics(STAT_PROFIT_TRADES);
   PrintFormat("RESULT | net=%.2f PF=%.2f winRate=%.1f%% maxEquityDD=%.1f%% avgWin=%.2f avgLoss=%.2f",
               TesterStatistics(STAT_PROFIT), TesterStatistics(STAT_PROFIT_FACTOR),
               (trades > 0 ? 100.0 * wins / trades : 0.0),
               TesterStatistics(STAT_EQUITY_DDREL_PERCENT),
               TesterStatistics(STAT_GROSS_PROFIT) / MathMax(1.0, wins),
               TesterStatistics(STAT_GROSS_LOSS)   / MathMax(1.0, trades - wins));
   return(TesterStatistics(STAT_PROFIT));
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(bid <= 0.0 || ask <= 0.0) return;

   double spread = ask - bid;
   gSprSum += spread;
   gSprCount++;
   if(spread < gSprMin) gSprMin = spread;
   if(spread > gSprMax) gSprMax = spread;

   RefreshLevels();                    
   AdaptRecalc(bid, ask, spread);      

   if(!gAdopted) Adopt(bid, ask);

   RebuildBook(bid, ask);
   DetectEvents(bid, ask);
   Snapshot();

   // ---- trading day ------------------------------------------------
   datetime ds = DayStartFor(TimeCurrent());
   if(ds != gDayStart)
     {
      bool wasLocked = gDayLocked;
      gDayStart   = ds;
      gDayLocked  = false;
      gLockReason = "";
      gHistDirty  = true;
      GlobalVariableDel(LockKey());
      if(wasLocked)
        {
         gNeedReset = true;
         gResetRef  = 0.0;
        }
     }
   if(gHistDirty)
     {
      bool ok = false;
      double r = TodayRealized(ok);
      if(ok)
        {
         gDayRealized = r;
         gHistDirty   = false;
        }
     }
   double floating = 0.0;
   for(int i = 0; i < ArraySize(gBook); i++) floating += gBook[i].profit;
   double dayPL = gDayRealized + floating;

   bool allowed = (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED));
   if(!allowed)
     {
      gTradeBlocked = true;
      Panel(bid, ask, dayPL);
      return;
     }
   gTradeBlocked = false;

   if(!gDayLocked)
     {
      if(InpDailyProfitTarget > 0.0 && dayPL >= InpDailyProfitTarget)
         LockDay(StringFormat("Daily profit target reached: %.2f >= %.2f", dayPL, InpDailyProfitTarget));
      else if(InpDailyLossLimit > 0.0 && dayPL <= -InpDailyLossLimit)
         LockDay(StringFormat("Daily loss limit hit: %.2f <= -%.2f", dayPL, InpDailyLossLimit));
     }

   // ---- basket trailing stop (updates server SL) ---------------------
   if(ManageTrail(bid, ask))
     {
      RebuildBook(bid, ask);
      DetectEvents(bid, ask);
      Snapshot();
     }

   if(gDayLocked)
     {
      ClearPendings();
      if(gBuys + gSells > 0) CloseAll(-1);
      Panel(bid, ask, dayPL);
      return;
     }

   if(gCloseDir >= 0)
     {
      int left = (gCloseDir == POSITION_TYPE_BUY) ? gBuys : gSells;
      if(left == 0 || CloseAll(gCloseDir) == left)
         gCloseDir = -1;
     }

   TopUp(bid, ask);

   if(spread > AMaxSpread())
     {
      gSprBlocks++;
      if(!gSpreadPaused) gSpreadPaused = true;
      ClearPendings();
      gNeedReset = true;              
      gResetRef  = 0.0;               
     }
   else
     {
      if(gSpreadPaused) gSpreadPaused = false;
      MaintainBracket(bid, ask, spread);
     }

   Panel(bid, ask, dayPL);
  }

//+------------------------------------------------------------------+
void RefreshLevels()
  {
   gStopLevel   = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL)  * gPoint;
   gFreezeLevel = SymbolInfoInteger(_Symbol, SYMBOL_TRADE_FREEZE_LEVEL) * gPoint;
  }

//+------------------------------------------------------------------+
double AStop()      { return(InpAdaptive && gA.ready ? gA.stop      : AStopP()); }
double AStraddle()  { return(InpAdaptive && gA.ready ? gA.straddle  : AStraddleP()); }
double ATrail()     { return(InpAdaptive && gA.ready ? gA.trail     : ATrailP()); }
double AOrderStep() { return(InpAdaptive && gA.ready ? gA.orderStep : AOrderStepP()); }
double ATrailStep() { return(InpAdaptive && gA.ready ? gA.trailStep : ATrailStepP()); }
double AMaxSpread() { return(InpAdaptive && gA.ready ? gA.maxSpread : AMaxSpreadP()); }
double ABuffer()    { return(InpAdaptive && gA.ready ? gA.buffer    : InpSpreadBuffer); }
double ATickFloor() { return(gA.tickFloor > 0.0 ? gA.tickFloor : gPoint); }

double PipSize()     { return(InpPipSize > 0.0 ? InpPipSize : (gPoint > 0.0 ? gPoint * 10.0 : 0.1)); }
double PipsToPrice(double pips) { return(pips * PipSize()); }
double AStopP()      { return(PipsToPrice(InpStopDistance)); }
double AStraddleP()  { return(PipsToPrice(InpStraddleDistance)); }
double ATrailP()     { return(PipsToPrice(InpTrailDistance)); }
double AOrderStepP() { return(PipsToPrice(InpOrderStep)); }
double ATrailStepP() { return(PipsToPrice(InpTrailStep)); }
double AMaxSpreadP() { return(PipsToPrice(InpMaxSpread)); }
double ATP()         { return(PipsToPrice(InpTakeProfit)); }

double RoundToTickUp(double v)
  {
   double t = ATickFloor();
   return(NormalizeDouble(MathCeil(v / t - 1e-9) * t, gDigits));
  }

double AvgMinRange(int n)
  {
   MqlRates r[];
   ArraySetAsSeries(r, true);
   int got = CopyRates(_Symbol, PERIOD_M1, 0, n, r);
   if(got <= 0) return(0.0);
   double sum = 0.0;
   int    cnt = MathMin(got, n);
   for(int i = 0; i < cnt; i++) sum += r[i].high - r[i].low;
   return(sum / cnt);
  }

void AdaptInit()
  {
   gA.tick = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(gA.tick <= 0.0 || gA.tick < gPoint) gA.tick = gPoint;
   gA.tickFloor = MathMax(gPoint, gA.tick);

   gA.ready      = true;
   gA.stop       = AStopP();
   gA.trail      = ATrailP();
   gA.straddle   = AStraddleP();
   gA.orderStep  = MathMax(AOrderStepP(),  gA.tickFloor);
   gA.trailStep  = MathMax(ATrailStepP(),  gA.tickFloor);
   gA.buffer     = MathMax(InpSpreadBuffer, 0.5);
   gA.maxSpread  = MathMax(AMaxSpreadP(), AStopP());
   gA.lastCalc   = 0;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double spr = (bid > 0.0 && ask > 0.0) ? (ask - bid) : gPoint * 10.0;
   gA.spreadEma = spr;
   gA.spreadMin = spr;
   gA.volEma    = 0.0;
  }

void AdaptRecalc(double bid, double ask, double spread)
  {
   if(!InpAdaptive || !gA.ready || bid <= 0.0 || ask <= 0.0) return;
   datetime now = TimeCurrent();
   if(gA.lastCalc > 0 && now - gA.lastCalc < MathMax(InpAdaptUpdateSec, 0)) return;
   gA.lastCalc = now;

   int    n     = MathMax(InpAdaptVolBars, 5);
   double rng   = AvgMinRange(n);
   if(spread > 0.0)
     {
      gA.spreadEma = (gA.spreadEma <= 0.0) ? spread : 0.8 * gA.spreadEma + 0.2 * spread;      
      if(gA.spreadMin <= 0.0 || spread < gA.spreadMin) gA.spreadMin = spread;
     }
   if(rng > 0.0)
      gA.volEma = (gA.volEma <= 0.0) ? rng : 0.7 * gA.volEma + 0.3 * rng;

   double multMin = MathMax(InpAdaptMinMult, 1.0);
   double multMax = MathMax(multMin, InpAdaptMaxMult);

   double floorStop = MathMax(AStopP(), gA.spreadEma * MathMax(InpAdaptSpreadF, 1.0)); 
   double volScal   = MathMax(1.0, gA.volEma / (4.0 * AStopP()));                       
   double eStop     = floorStop * volScal;
   eStop = MathMax(eStop, AStopP() * multMin);
   eStop = MathMin(eStop, AStopP() * multMax);

   double eTrail = ATrailP() * (eStop / AStopP());        
   double eStrad = MathMax(AStraddleP(), gA.spreadEma * 1.5);    
   eStrad = MathMin(eStrad, eStop);

   gA.stop       = RoundToTickUp(eStop);
   gA.trail      = RoundToTickUp(eTrail);
   gA.straddle   = RoundToTickUp(eStrad);
   gA.orderStep  = MathMax(AOrderStep(), RoundToTickUp(gA.tickFloor * 2.0));
   gA.trailStep  = MathMax(ATrailStep(), RoundToTickUp(gA.tickFloor));
   gA.buffer     = MathMax(InpSpreadBuffer, 0.5);
   gA.maxSpread  = MathMax(AMaxSpreadP(), RoundToTickUp(gA.spreadEma * 3.0));   
  }

//+------------------------------------------------------------------+
void Adopt(double bid, double ask)
  {
   gAdopted = true;
   RebuildBook(bid, ask);
   Snapshot();

   if(GlobalVariableCheck(LockKey()) && (datetime)GlobalVariableGet(LockKey()) == gDayStart)
     {
      gDayLocked  = true;
      gLockReason = "restored after restart";
     }

   bool   flat = (gBuys + gSells == 0);
   double off  = flat ? AStraddle() : AStop();
   double mid  = (bid + ask) / 2.0;
   ulong  tk   = 0;
   double px   = 0.0;

   if(FindStop(ORDER_TYPE_BUY_STOP, tk, px)) gBuySeed = px;
   else gBuySeed = flat ? mid + off : bid + AStop();
   gBuyAnchor = bid;
   gBuyLow    = bid;

   if(FindStop(ORDER_TYPE_SELL_STOP, tk, px)) gSellSeed = px;
   else gSellSeed = flat ? mid - off : bid - AStop();
   gSellAnchor = bid;
   gSellHigh   = bid;

   gBracketFlat = flat;
   gNeedReset   = false;
  }

//+------------------------------------------------------------------+
void RebuildBook(double bid, double ask)
  {
   ArrayResize(gBook, 0);
   gBuys  = 0;
   gSells = 0;

   for(int i = 0; i < (int)PositionsTotal(); i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0 || !PositionSelectByTicket(tk)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(PositionGetInteger(POSITION_MAGIC) != InpMagic) continue;

      BookEntry e;
      e.ticket = tk;
      e.type   = (int)PositionGetInteger(POSITION_TYPE);
      e.open   = PositionGetDouble(POSITION_PRICE_OPEN);
      e.time   = (datetime)PositionGetInteger(POSITION_TIME);
      e.profit = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      e.vol    = PositionGetDouble(POSITION_VOLUME);

      int n = ArraySize(gBook);
      ArrayResize(gBook, n + 1);
      gBook[n] = e;

      if(e.type == POSITION_TYPE_BUY) gBuys++;
      else gSells++;

      RememberSeen(tk);
     }
  }

//+------------------------------------------------------------------+
//| Server-side Trailing Stop Logic (Basket and Single)              |
//+------------------------------------------------------------------+
bool ManageTrail(double bid, double ask)
  {
   bool modifiedAny = false;
   bool closedAny = false;

   if(InpBasketTrail && gBuys + gSells > 0)
     {
      double bTarget = (gBuys  > 0) ? NormalizeDouble(bid - ATrail(), gDigits) : 0.0;
      double sTarget = (gSells > 0) ? NormalizeDouble(ask + ATrail(), gDigits) : 0.0;
      
      double currentBestBuySL = 0.0;
      double currentBestSellSL = 0.0;

      // Find the tightest SL currently on the server across the basket
      for(int i = 0; i < ArraySize(gBook); i++)
        {
         ulong tk = gBook[i].ticket;
         if(!PositionSelectByTicket(tk)) continue;
         double sl = PositionGetDouble(POSITION_SL);
         
         if(gBook[i].type == POSITION_TYPE_BUY)
           {
            if(sl > currentBestBuySL) currentBestBuySL = sl;
            if(gHardSL > 0.0) 
               currentBestBuySL = MathMax(currentBestBuySL, NormalizeDouble(gBook[i].open - gHardSL, gDigits));
           }
         else
           {
            if(currentBestSellSL == 0.0 || (sl > 0.0 && sl < currentBestSellSL)) currentBestSellSL = sl;
            if(gHardSL > 0.0)
              {
               double hSL = NormalizeDouble(gBook[i].open + gHardSL, gDigits);
               currentBestSellSL = (currentBestSellSL == 0.0) ? hSL : MathMin(currentBestSellSL, hSL);
              }
           }
        }
      
      // The new shared level never drops below the current tightest level
      if(gBuys > 0) bTarget = MathMax(bTarget, currentBestBuySL);
      if(gSells > 0) 
        {
         if(currentBestSellSL > 0.0 && sTarget > 0.0) sTarget = MathMin(sTarget, currentBestSellSL);
         else if(currentBestSellSL > 0.0) sTarget = currentBestSellSL;
        }

      double firstBuyOpen = 0.0, firstSellOpen = 0.0;
      datetime firstBuyTime = 0, firstSellTime = 0;
      for(int i = 0; i < ArraySize(gBook); i++)
        {
         if(gBook[i].type == POSITION_TYPE_BUY && (firstBuyTime == 0 || gBook[i].time < firstBuyTime))
           { firstBuyTime = gBook[i].time; firstBuyOpen = gBook[i].open; }
         else if(gBook[i].type == POSITION_TYPE_SELL && (firstSellTime == 0 || gBook[i].time < firstSellTime))
           { firstSellTime = gBook[i].time; firstSellOpen = gBook[i].open; }
        }
      // The trail is measured from the FIRST open position: the shared SL never sits
      // more than the trail distance (pips) away from the basket's earliest entry.
      if(firstBuyOpen  > 0.0) bTarget = MathMax(bTarget, NormalizeDouble(firstBuyOpen - ATrail(), gDigits));
      if(firstSellOpen > 0.0) sTarget = MathMin(sTarget, NormalizeDouble(firstSellOpen + ATrail(), gDigits));

      bool exitB = false, exitS = false;
      
      // Apply the unified level to all positions
      for(int i = 0; i < ArraySize(gBook); i++)
        {
         ulong tk = gBook[i].ticket;
         if(!PositionSelectByTicket(tk)) continue;
         double sl = PositionGetDouble(POSITION_SL);

         if(gBook[i].type == POSITION_TYPE_BUY)
           {
            if(bTarget > sl + ATrailStep() - gPoint / 2.0)
              {
               if(trade.PositionModify(tk, bTarget, CurTp(tk)))
                 {
                  modifiedAny = true;
                  sl = bTarget;
                 }
              }
            if(sl > 0.0 && bid <= sl) exitB = true; 
           }
         else
           {
            if(sl == 0.0 || (sTarget > 0.0 && sTarget < sl - ATrailStep() + gPoint / 2.0))
              {
               if(trade.PositionModify(tk, sTarget, CurTp(tk)))
                 {
                  modifiedAny = true;
                  sl = sTarget;
                 }
              }
            if(sl > 0.0 && ask >= sl) exitS = true;
           }
        }

      if(exitB)
        {
         int n = CloseAll(POSITION_TYPE_BUY);
         if(n > 0) { gTrailExits += n; closedAny = true; }
        }
      if(exitS)
        {
         int n = CloseAll(POSITION_TYPE_SELL);
         if(n > 0) { gTrailExits += n; closedAny = true; }
        }
      return(closedAny);
     }
   else if(!InpBasketTrail && gBuys + gSells > 0)
     {
      for(int i = 0; i < ArraySize(gBook); i++)
        {
         ulong tk = gBook[i].ticket;
         if(!PositionSelectByTicket(tk)) continue;
         double sl = PositionGetDouble(POSITION_SL);

         if(gBook[i].type == POSITION_TYPE_BUY)
           {
            double wantSL = NormalizeDouble(bid - ATrail(), gDigits);
            wantSL = MathMax(wantSL, NormalizeDouble(gBook[i].open - ATrail(), gDigits));
            if(gHardSL > 0.0) wantSL = MathMax(wantSL, NormalizeDouble(gBook[i].open - gHardSL, gDigits));

            if(wantSL > sl + ATrailStep() - gPoint / 2.0)
              {
               if(trade.PositionModify(tk, wantSL, CurTp(tk))) sl = wantSL;
              }
            if(sl > 0.0 && bid <= sl && ClosePosition(tk))
              {
               gTrailExits++;
               closedAny = true;
              }
           }
         else
           {
            double wantSL = NormalizeDouble(ask + ATrail(), gDigits);
            wantSL = MathMin(wantSL, NormalizeDouble(gBook[i].open + ATrail(), gDigits));
            if(gHardSL > 0.0)
              {
               double hSL = NormalizeDouble(gBook[i].open + gHardSL, gDigits);
               wantSL = (wantSL > 0.0) ? MathMin(wantSL, hSL) : hSL;
              }

            if(sl == 0.0 || (wantSL > 0.0 && wantSL < sl - ATrailStep() + gPoint / 2.0))
              {
               if(trade.PositionModify(tk, wantSL, CurTp(tk))) sl = wantSL;
              }
            if(sl > 0.0 && ask >= sl && ClosePosition(tk))
              {
               gTrailExits++;
               closedAny = true;
              }
           }
        }
     }
   return(closedAny);
  }

//+------------------------------------------------------------------+
void Snapshot()
  {
   ArrayResize(gPrevTickets, ArraySize(gBook));
   for(int i = 0; i < ArraySize(gBook); i++) gPrevTickets[i] = gBook[i].ticket;
   gPrevBuys  = gBuys;
   gPrevSells = gSells;
  }

//+------------------------------------------------------------------+
void DetectEvents(double bid, double ask)
  {
   int closed = 0;
   for(int i = 0; i < ArraySize(gPrevTickets); i++)
     {
      ulong ptk = gPrevTickets[i];
      bool found = false;
      for(int j = 0; j < ArraySize(gBook); j++)
        {
         if(gBook[j].ticket == ptk) { found = true; break; }
        }
      if(!found) closed++;
     }

   if(closed > 0)
     {
      if(gTopUpDir >= 0)
        {
         bool found = false;
         for(int i = 0; i < ArraySize(gBook); i++)
            if(gBook[i].ticket == gTopUpSeed) { found = true; break; }
         if(!found) gTopUpDir = -1;
        }

      if(gBuys + gSells == 0)
        {
         gHistDirty = true;
         if(!gDayLocked)
           {
            gNeedReset = true;
            gResetRef  = 0.0; 
           }
        }
     }

   ArrayResize(gFillEv, 0);
   if(gNetting) DetectNettingFills();
   else DetectHedgingFills();

   for(int i = 0; i < ArraySize(gFillEv); i++)
     {
      double px   = gFillEv[i].price;
      int    type = gFillEv[i].dir;
      ulong  tk   = gFillEv[i].ticket;
      gFills++;
      gLastFillDir = type;
      gHistDirty   = true;

      bool isPyramid = ((type == POSITION_TYPE_BUY  && gPrevBuys > 0) ||
                        (type == POSITION_TYPE_SELL && gPrevSells > 0));
      bool isRevers  = ((type == POSITION_TYPE_BUY  && gPrevSells > 0) ||
                        (type == POSITION_TYPE_SELL && gPrevBuys > 0));
      
      bool handled = false;
      if(isRevers)
        {
         gReversals++;
         if(InpCloseOppositeOnReversal && !gNetting)
            gCloseDir = (type == POSITION_TYPE_BUY) ? POSITION_TYPE_SELL : POSITION_TYPE_BUY;
        }
      else if(isPyramid) { gAdds++; handled = true; }
      else if(gTopUpDir == type) { gTopUps++; handled = true; }

      if(!handled)
        {
         gTopUpDir   = type;
         gTopUpSeed  = tk;
         gTopUpSent  = 1;
         gTopUpTries = 0;
         gTopUpArmed = TimeCurrent();
        }

      gNeedReset   = true;
      gResetRef    = px;
      gResetTicket = tk;
     }

   if(gNeedReset && !gDayLocked && (gBuys + gSells == 0 || gResetRef > 0.0))
     {
      if(gResetTicket != 0)
        {
         bool found = false;
         for(int i = 0; i < ArraySize(gBook); i++)
            if(gBook[i].ticket == gResetTicket) { found = true; break; }
         if(!found)
           {
            gResetRef    = 0.0;
            gResetTicket = 0;
           }
        }
      ResetBracket(bid, ask);
     }
     
   int depth = gNetting ? (int)MathRound((gBuys > 0 ? gBook[0].vol : (gSells > 0 ? gBook[0].vol : 0.0)) / gLots)
                        : (gBuys > 0 ? gBuys : gSells);
   if(depth > gMaxDepth) gMaxDepth = depth;
  }

void DetectHedgingFills()
  {
   for(int i = 0; i < ArraySize(gBook); i++)
     {
      ulong tk = gBook[i].ticket;
      bool isNew = true;
      for(int j = 0; j < ArraySize(gPrevTickets); j++)
        {
         if(gPrevTickets[j] == tk) { isNew = false; break; }
        }
      if(isNew)
        {
         int n = ArraySize(gFillEv);
         ArrayResize(gFillEv, n + 1);
         gFillEv[n].price  = gBook[i].open;
         gFillEv[n].dir    = gBook[i].type;
         gFillEv[n].ticket = tk;
         gFillEv[n].deal   = 0;
        }
     }
  }

void DetectNettingFills()
  {
   HistorySelect(TimeCurrent() - 3600, TimeCurrent() + 86400);
   int deals = HistoryDealsTotal();
   for(int i = deals - 1; i >= 0; i--)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      if(HistoryDealGetString(deal, DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(deal, DEAL_MAGIC) != InpMagic) continue;
      if(HistoryDealGetInteger(deal, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
      
      bool seen = false;
      for(int k = 0; k < ArraySize(gDealPos); k++)
         if(gDealPos[k] == deal) { seen = true; break; }
      if(seen) continue;

      int type = (int)HistoryDealGetInteger(deal, DEAL_TYPE);
      if(type != DEAL_TYPE_BUY && type != DEAL_TYPE_SELL) continue;

      int n = ArraySize(gFillEv);
      ArrayResize(gFillEv, n + 1);
      gFillEv[n].price  = HistoryDealGetDouble(deal, DEAL_PRICE);
      gFillEv[n].dir    = (type == DEAL_TYPE_BUY) ? POSITION_TYPE_BUY : POSITION_TYPE_SELL;
      gFillEv[n].ticket = HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      gFillEv[n].deal   = deal;

      int m = ArraySize(gDealPos);
      ArrayResize(gDealPos, m + 1);
      gDealPos[m] = deal;
     }
  }

void ResetBracket(double bid, double ask)
  {
   ClearPendings();
   bool   flat = (gBuys + gSells == 0);
   double ref  = flat ? (bid + ask) / 2.0 : gResetRef;
   double off  = flat ? AStraddle() : AStop();

   gBuySeed    = ref + off;
   gBuyAnchor  = bid;
   gBuyLow     = bid;

   gSellSeed   = ref - off;
   gSellAnchor = bid;
   gSellHigh   = bid;

   gBracketFlat = flat;
   gNeedReset   = false;
   gResetRef    = 0.0;
   gResetTicket = 0;
  }

//+------------------------------------------------------------------+
void TopUp(double bid, double ask)
  {
   if(gTopUpDir < 0 || gDayLocked) return;
   if(gTopUpSent >= InpPositionsPerEntry || gTopUpSent >= InpMaxPositions)
     {
      gTopUpDir = -1;
      return;
     }

   if(gNetting) { TopUpNetting(bid, ask); return; }

   int have = (gTopUpDir == POSITION_TYPE_BUY) ? gBuys : gSells;
   int target = MathMin(InpPositionsPerEntry, InpMaxPositions);
   
   bool foundSeed = false;
   for(int i = 0; i < ArraySize(gBook); i++)
      if(gBook[i].ticket == gTopUpSeed) { foundSeed = true; break; }

   if(have >= target || TimeCurrent() - gTopUpArmed > 30 || !foundSeed)
     {
      gTopUpDir = -1;
      return;
     }
     
   if(GetTickCount() - gLastFlushMs < 500) return;

   int type = (gTopUpDir == POSITION_TYPE_BUY) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double price = (type == ORDER_TYPE_BUY) ? ask : bid;
   double sl = 0.0;
   if(gHardSL > 0.0) sl = (type == ORDER_TYPE_BUY) ? ask - gHardSL : bid + gHardSL;

   double tp = (ATP() > 0.0) ? (type == ORDER_TYPE_BUY ? price + ATP() : price - ATP()) : 0.0;
   if(trade.PositionOpen(_Symbol, (ENUM_ORDER_TYPE)type, gLots, price, sl, tp, "TopUp"))
     {
      gTopUpSent++;
      gTopUpTries = 0;
     }
   else
     {
      gTopUpTries++;
      if(gTopUpTries > 3) gTopUpDir = -1; 
     }
   gLastFlushMs = GetTickCount();
  }

void TopUpNetting(double bid, double ask)
  {
   double haveVol = 0.0;
   for(int i = 0; i < ArraySize(gBook); i++)
     {
      if(gBook[i].type == gTopUpDir)
         haveVol += gBook[i].vol;
     }
   
   double targetVol = MathMin(InpPositionsPerEntry, InpMaxPositions) * gLots;
   if(haveVol >= targetVol - gLotStep / 2.0 || TimeCurrent() - gTopUpArmed > 30)
     {
      gTopUpDir = -1;
      return;
     }

   if(GetTickCount() - gLastFlushMs < 500) return;

   int type = (gTopUpDir == POSITION_TYPE_BUY) ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double price = (type == ORDER_TYPE_BUY) ? ask : bid;
   
   double tp = (ATP() > 0.0) ? (type == ORDER_TYPE_BUY ? price + ATP() : price - ATP()) : 0.0;
   if(trade.PositionOpen(_Symbol, (ENUM_ORDER_TYPE)type, gLots, price, 0.0, tp, "TopUp"))
     {
      gTopUpSent++;
      gTopUpTries = 0;
     }
   else
     {
      gTopUpTries++;
      if(gTopUpTries > 3) gTopUpDir = -1;
     }
   gLastFlushMs = GetTickCount();
  }

//+------------------------------------------------------------------+
void MaintainBracket(double bid, double ask, double spread)
  {
   if(gDayLocked) return;

   double flatSpread = InpAdaptive ? gA.spreadEma : spread;
   double flatStrad  = InpAdaptive ? gA.straddle  : AStraddleP();
   
   if(bid < gBuyLow)  gBuyLow  = bid;
   if(bid > gSellHigh) gSellHigh = bid;

   double buyTarget  = gBuySeed  - MathMax(0.0, gBuyAnchor - gBuyLow);
   double sellTarget = gSellSeed + MathMax(0.0, gSellHigh - gSellAnchor);

   if(gBracketFlat)
     {
      double mid = (bid + ask) / 2.0;
      double stopOff = AStop();
      buyTarget  = MathMax(buyTarget,  mid + flatStrad);
      buyTarget  = MathMin(buyTarget,  mid + stopOff);
      sellTarget = MathMin(sellTarget, mid - flatStrad);
      sellTarget = MathMax(sellTarget, mid - stopOff);
     }
     
   double guardGap = (flatSpread * ABuffer()) + (spread / 2.0);
   buyTarget  = MathMax(buyTarget,  ask + guardGap);
   sellTarget = MathMin(sellTarget, bid - guardGap);

   buyTarget  = RoundToTickUp(buyTarget);
   sellTarget = RoundToTickUp(sellTarget);
   
   double orderStep = AOrderStep();

   int haveBuys = gNetting ? (gLastFillDir == POSITION_TYPE_BUY ? (gBuys > 0 ? (int)MathRound(gBook[0].vol / gLots) : 0) : 0) : gBuys;
   if(haveBuys < InpMaxPositions)
     {
      ulong tk; double px;
      if(FindStop(ORDER_TYPE_BUY_STOP, tk, px))
        {
         gBuyStopTicket = tk;
         if(buyTarget < px - orderStep + gPoint / 2.0 && GetTickCount() - gBuyRejectMs > 1000)
            ModifyStop(tk, ORDER_TYPE_BUY_STOP, buyTarget);
        }
      else if(GetTickCount() - gBuyPlacedMs > 500 && GetTickCount() - gBuyRejectMs > 1000)
        {
         if(PlaceStop(ORDER_TYPE_BUY_STOP, buyTarget)) gBuyPlacedMs = GetTickCount();
         else gBuyRejectMs = GetTickCount();
        }
     }
   else ClearSide(ORDER_TYPE_BUY_STOP);

   int haveSells = gNetting ? (gLastFillDir == POSITION_TYPE_SELL ? (gSells > 0 ? (int)MathRound(gBook[0].vol / gLots) : 0) : 0) : gSells;
   if(haveSells < InpMaxPositions)
     {
      ulong tk; double px;
      if(FindStop(ORDER_TYPE_SELL_STOP, tk, px))
        {
         gSellStopTicket = tk;
         if(sellTarget > px + orderStep - gPoint / 2.0 && GetTickCount() - gSellRejectMs > 1000)
            ModifyStop(tk, ORDER_TYPE_SELL_STOP, sellTarget);
        }
      else if(GetTickCount() - gSellPlacedMs > 500 && GetTickCount() - gSellRejectMs > 1000)
        {
         if(PlaceStop(ORDER_TYPE_SELL_STOP, sellTarget)) gSellPlacedMs = GetTickCount();
         else gSellRejectMs = GetTickCount();
        }
     }
   else ClearSide(ORDER_TYPE_SELL_STOP);
  }

double HardSlFor(int type, double price)
  {
   if(gHardSL <= 0.0) return(0.0);
   return(type == ORDER_TYPE_BUY_STOP ? price - gHardSL : price + gHardSL);
  }

double HardTpFor(int type, double price)
  {
   double tp = ATP();
   if(tp <= 0.0) return(0.0);
   return(type == ORDER_TYPE_BUY_STOP ? price + tp : price - tp);
  }

double CurTp(ulong ticket)
  {
   if(!PositionSelectByTicket(ticket)) return(0.0);
   return(PositionGetDouble(POSITION_TP));
  }
     
bool PlaceStop(int type, double price)
  {
   double sl = HardSlFor(type, price);
   double tp = HardTpFor(type, price);
   return(trade.OrderOpen(_Symbol, (ENUM_ORDER_TYPE)type, gLots, 0.0, price, sl, tp, ORDER_TIME_GTC, 0, InpComment));
  }

void ModifyStop(ulong ticket, int type, double price)
  {
   if(ticket == gModTicket && MathAbs(price - gModPrice) < gPoint / 2.0) return;
   double sl = HardSlFor(type, price);
   double tp = HardTpFor(type, price);
   bool ok = trade.OrderModify(ticket, price, sl, tp, ORDER_TIME_GTC, 0);
   if(ok)
     {
      gModTicket = ticket;
      gModPrice  = price;
     }
   else
     {
      if(type == ORDER_TYPE_BUY_STOP) gBuyRejectMs = GetTickCount();
      else gSellRejectMs = GetTickCount();
     }
  }

bool FindStop(int type, ulong &outTicket, double &outPrice)
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong tk = OrderGetTicket(i);
      if(tk > 0 && OrderGetString(ORDER_SYMBOL) == _Symbol && OrderGetInteger(ORDER_MAGIC) == InpMagic)
        {
         if(OrderGetInteger(ORDER_TYPE) == type)
           {
            outTicket = tk;
            outPrice  = OrderGetDouble(ORDER_PRICE_OPEN);
            return(true);
           }
        }
     }
   return(false);
  }

void ClearPendings()
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong tk = OrderGetTicket(i);
      if(tk > 0 && OrderGetString(ORDER_SYMBOL) == _Symbol && OrderGetInteger(ORDER_MAGIC) == InpMagic)
         trade.OrderDelete(tk);
     }
   gBuyStopTicket  = 0;
   gSellStopTicket = 0;
  }

void ClearSide(int type)
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      ulong tk = OrderGetTicket(i);
      if(tk > 0 && OrderGetString(ORDER_SYMBOL) == _Symbol && OrderGetInteger(ORDER_MAGIC) == InpMagic)
        {
         if(OrderGetInteger(ORDER_TYPE) == type) trade.OrderDelete(tk);
        }
     }
  }

//+------------------------------------------------------------------+
bool ClosePosition(ulong ticket)
  {
   for(int i = 0; i < ArraySize(gClosing); i++)
     {
      if(gClosing[i] == ticket)
        {
         if(GetTickCount() - gClosingMs[i] < 2000) return(false);
        }
     }
   bool ok = trade.PositionClose(ticket);
   if(ok)
     {
      int n = ArraySize(gClosing);
      ArrayResize(gClosing, n + 1);
      ArrayResize(gClosingMs, n + 1);   // v1.10 never grew this array: MT5 stopped the EA here with "array out of range"
      gClosing[n] = ticket;
      gClosingMs[n] = GetTickCount();
     }
   return(ok);
  }

int CloseAll(int type)
  {
   int closed = 0;
   for(int i = ArraySize(gBook) - 1; i >= 0; i--)
     {
      if(type < 0 || gBook[i].type == type)
        {
         if(ClosePosition(gBook[i].ticket)) closed++;
        }
     }
   return(closed);
  }

void RememberSeen(ulong tk)
  {
   for(int i = 0; i < ArraySize(gSeen); i++)
      if(gSeen[i] == tk) return;
   int n = ArraySize(gSeen);
   if(n >= 500)
     {
      ArrayCopy(gSeen, gSeen, 0, 100);
      n -= 100;
      ArrayResize(gSeen, n);
     }
   ArrayResize(gSeen, n + 1);
   gSeen[n] = tk;
  }

//+------------------------------------------------------------------+
datetime DayStartFor(datetime t)
  {
   MqlDateTime dt;
   TimeToStruct(t, dt);
   if(dt.hour < InpDailyResetHour)
     {
      t -= 86400;
      TimeToStruct(t, dt);
     }
   dt.hour = InpDailyResetHour;
   dt.min  = 0;
   dt.sec  = 0;
   return(StructToTime(dt));
  }

double TodayRealized(bool &ok)
  {
   ok = false;
   if(!HistorySelect(gDayStart, TimeCurrent() + 86400)) return(0.0);
   double p = 0.0;
   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; i++)
     {
      ulong deal = HistoryDealGetTicket(i);
      if(deal > 0 && HistoryDealGetString(deal, DEAL_SYMBOL) == _Symbol &&
         HistoryDealGetInteger(deal, DEAL_MAGIC) == InpMagic)
        {
         p += HistoryDealGetDouble(deal, DEAL_PROFIT) +
              HistoryDealGetDouble(deal, DEAL_SWAP) +
              HistoryDealGetDouble(deal, DEAL_COMMISSION);
        }
     }
   ok = true;
   return(p);
  }

string LockKey()
  {
   return StringFormat("AngelBot.%I64d.%I64d.%s.lockday", AccountInfoInteger(ACCOUNT_LOGIN), InpMagic, _Symbol);
  }

void LockDay(string reason)
  {
   gDayLocked  = true;
   gLockReason = reason;
   gTopUpDir   = -1;
   gCloseDir   = -1;
   GlobalVariableSet(LockKey(), (double)gDayStart);
   GlobalVariablesFlush();
   PrintFormat("Angel Bot: %s - locked out until the next trading day (server hour %d).", reason, InpDailyResetHour);
  }

//+------------------------------------------------------------------+
void Panel(double bid, double ask, double dayPL)
  {
   if(!InpShowPanel) return;

   double buyTrail = 0.0, sellTrail = 0.0, floating = 0.0;
   for(int i = 0; i < ArraySize(gBook); i++)
     {
      floating += gBook[i].profit;
      if(PositionSelectByTicket(gBook[i].ticket))
        {
         double sl = PositionGetDouble(POSITION_SL);
         if(gBook[i].type == POSITION_TYPE_BUY)
            buyTrail = (buyTrail == 0.0) ? sl : MathMax(buyTrail, sl);
         else
            sellTrail = (sellTrail == 0.0) ? sl : MathMin(sellTrail, sl);
        }
     }

   string lk = gDayLocked ? StringFormat("[LOCKED] %s", gLockReason) : "ACTIVE";
   if(gTradeBlocked) lk = "[BLOCKED] AutoTrading disabled";

   string txt = StringFormat("--- ANGEL BOT ---\nStatus: %s\nDay P/L: %.2f (float %.2f)\n"
                             "Depth: %d buy / %d sell\nBase lot: %.2f\nTarget: %.2f | Loss limit: %.2f | TP: %.1f pips",
                             lk, dayPL, floating, gBuys, gSells, gLots, InpDailyProfitTarget, InpDailyLossLimit, InpTakeProfit);

   if(InpAdaptive && gA.ready)
      txt += StringFormat("\n\n-- ADAPTIVE ENGINE --\nSpread EMA: %.3f (min %.3f)\nVol (1m): %.3f\n"
                          "Eff Stop: %.3f\nEff Trail: %.3f\nEff Straddle: %.3f\nGuard gap: %.3f",
                          gA.spreadEma, gA.spreadMin, gA.volEma, gA.stop, gA.trail, gA.straddle, gA.maxSpread);

   string buyStopTxt  = "-";
   if(gBuyStopTicket > 0 && OrderSelect(gBuyStopTicket))
      buyStopTxt = StringFormat("%.3f", OrderGetDouble(ORDER_PRICE_OPEN));
   string sellStopTxt = "-";
   if(gSellStopTicket > 0 && OrderSelect(gSellStopTicket))
      sellStopTxt = StringFormat("%.3f", OrderGetDouble(ORDER_PRICE_OPEN));

   txt += StringFormat("\n\n-- LEVELS --\nBid: %.3f\nAsk: %.3f\n\nBuy Stop: %s\nBuy Trail: %s\n\nSell Stop: %s\nSell Trail: %s",
                       bid, ask,
                       buyStopTxt,
                       buyTrail > 0.0 ? StringFormat("%.3f (%.1f p)", buyTrail, (bid - buyTrail) / PipSize()) : "-",
                       sellStopTxt,
                       sellTrail > 0.0 ? StringFormat("%.3f (%.1f p)", sellTrail, (sellTrail - ask) / PipSize()) : "-");

   Comment(txt);
  }
//+------------------------------------------------------------------+