/**
 * The MQL5 standard library's trade classes, written in MQL5.
 *
 * They follow MetaQuotes' published interface (Include/Trade/*.mqh) method
 * for method, and sit on the same built-in functions the real ones call —
 * OrderSend, PositionSelectByTicket, SymbolInfoDouble — so an EA written
 * against the standard library behaves here as it does in the terminal.
 */

export const OBJECT_MQH = String.raw`
class CObject
  {
protected:
   CObject          *m_prev;
   CObject          *m_next;
public:
                     CObject(void) { m_prev=NULL; m_next=NULL; }
   CObject          *Prev(void) const { return(m_prev); }
   void              Prev(CObject *node) { m_prev=node; }
   CObject          *Next(void) const { return(m_next); }
   void              Next(CObject *node) { m_next=node; }
   virtual bool      Save(const int file_handle) { return(true); }
   virtual bool      Load(const int file_handle) { return(true); }
   virtual int       Type(void) const { return(0); }
   virtual int       Compare(const CObject *node,const int mode=0) const { return(0); }
  };
`;

export const POSITION_INFO_MQH = String.raw`
#include <Object.mqh>
class CPositionInfo : public CObject
  {
protected:
   ENUM_POSITION_TYPE m_type;
   double            m_volume;
   double            m_price;
   double            m_stop_loss;
   double            m_take_profit;
public:
                     CPositionInfo(void) { m_type=POSITION_TYPE_BUY; m_volume=0; m_price=0; m_stop_loss=0; m_take_profit=0; }
   ulong             Ticket(void) const { return((ulong)PositionGetInteger(POSITION_TICKET)); }
   datetime          Time(void) const { return((datetime)PositionGetInteger(POSITION_TIME)); }
   ulong             TimeMsc(void) const { return((ulong)PositionGetInteger(POSITION_TIME_MSC)); }
   datetime          TimeUpdate(void) const { return((datetime)PositionGetInteger(POSITION_TIME_UPDATE)); }
   ulong             TimeUpdateMsc(void) const { return((ulong)PositionGetInteger(POSITION_TIME_UPDATE_MSC)); }
   ENUM_POSITION_TYPE PositionType(void) const { return((ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE)); }
   string            TypeDescription(void) const { return(PositionType()==POSITION_TYPE_BUY ? "buy" : "sell"); }
   long              Magic(void) const { return(PositionGetInteger(POSITION_MAGIC)); }
   long              Identifier(void) const { return(PositionGetInteger(POSITION_IDENTIFIER)); }
   double            Volume(void) const { return(PositionGetDouble(POSITION_VOLUME)); }
   double            PriceOpen(void) const { return(PositionGetDouble(POSITION_PRICE_OPEN)); }
   double            StopLoss(void) const { return(PositionGetDouble(POSITION_SL)); }
   double            TakeProfit(void) const { return(PositionGetDouble(POSITION_TP)); }
   double            PriceCurrent(void) const { return(PositionGetDouble(POSITION_PRICE_CURRENT)); }
   double            Commission(void) const { return(PositionGetDouble(POSITION_COMMISSION)); }
   double            Swap(void) const { return(PositionGetDouble(POSITION_SWAP)); }
   double            Profit(void) const { return(PositionGetDouble(POSITION_PROFIT)); }
   string            Symbol(void) const { return(PositionGetString(POSITION_SYMBOL)); }
   string            Comment(void) const { return(PositionGetString(POSITION_COMMENT)); }
   string            ExternalId(void) const { return(PositionGetString(POSITION_EXTERNAL_ID)); }
   bool              InfoInteger(const ENUM_POSITION_PROPERTY_INTEGER prop_id,long &var) const { return(PositionGetInteger(prop_id,var)); }
   bool              InfoDouble(const ENUM_POSITION_PROPERTY_DOUBLE prop_id,double &var) const { return(PositionGetDouble(prop_id,var)); }
   bool              InfoString(const ENUM_POSITION_PROPERTY_STRING prop_id,string &var) const { return(PositionGetString(prop_id,var)); }
   string            FormatType(string &str,const uint type) const { str=(type==POSITION_TYPE_BUY ? "buy" : "sell"); return(str); }
   bool              Select(const string symbol) { return(PositionSelect(symbol)); }
   bool              SelectByMagic(const string symbol,const ulong magic)
     {
      for(int i=PositionsTotal()-1; i>=0; i--)
        {
         ulong ticket=PositionGetTicket(i);
         if(ticket==0) continue;
         if(PositionGetString(POSITION_SYMBOL)==symbol && (ulong)PositionGetInteger(POSITION_MAGIC)==magic)
            return(true);
        }
      return(false);
     }
   bool              SelectByTicket(const ulong ticket) { return(PositionSelectByTicket(ticket)); }
   bool              SelectByIndex(const int index) { return(PositionGetTicket(index)!=0); }
   void              StoreState(void) { m_type=PositionType(); m_volume=Volume(); m_price=PriceOpen(); m_stop_loss=StopLoss(); m_take_profit=TakeProfit(); }
   bool              CheckState(void)
     {
      if(m_type==PositionType() && m_volume==Volume() && m_price==PriceOpen() && m_stop_loss==StopLoss() && m_take_profit==TakeProfit())
         return(false);
      return(true);
     }
  };
`;

export const ORDER_INFO_MQH = String.raw`
#include <Object.mqh>
class COrderInfo : public CObject
  {
protected:
   ulong             m_ticket;
public:
                     COrderInfo(void) { m_ticket=0; }
   ulong             Ticket(void) const { return(m_ticket); }
   datetime          TimeSetup(void) const { return((datetime)OrderGetInteger(ORDER_TIME_SETUP)); }
   ulong             TimeSetupMsc(void) const { return((ulong)OrderGetInteger(ORDER_TIME_SETUP_MSC)); }
   datetime          TimeDone(void) const { return((datetime)OrderGetInteger(ORDER_TIME_DONE)); }
   ENUM_ORDER_TYPE   OrderType(void) const { return((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)); }
   ENUM_ORDER_TYPE   Type(void) const { return((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE)); }
   string            TypeDescription(void) const { return(EnumToString(OrderType())); }
   ENUM_ORDER_STATE  State(void) const { return((ENUM_ORDER_STATE)OrderGetInteger(ORDER_STATE)); }
   datetime          TimeExpiration(void) const { return((datetime)OrderGetInteger(ORDER_TIME_EXPIRATION)); }
   ENUM_ORDER_TYPE_FILLING TypeFilling(void) const { return((ENUM_ORDER_TYPE_FILLING)OrderGetInteger(ORDER_TYPE_FILLING)); }
   ENUM_ORDER_TYPE_TIME TypeTime(void) const { return((ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME)); }
   long              Magic(void) const { return(OrderGetInteger(ORDER_MAGIC)); }
   long              PositionId(void) const { return(OrderGetInteger(ORDER_POSITION_ID)); }
   double            VolumeInitial(void) const { return(OrderGetDouble(ORDER_VOLUME_INITIAL)); }
   double            VolumeCurrent(void) const { return(OrderGetDouble(ORDER_VOLUME_CURRENT)); }
   double            PriceOpen(void) const { return(OrderGetDouble(ORDER_PRICE_OPEN)); }
   double            StopLoss(void) const { return(OrderGetDouble(ORDER_SL)); }
   double            TakeProfit(void) const { return(OrderGetDouble(ORDER_TP)); }
   double            PriceCurrent(void) const { return(OrderGetDouble(ORDER_PRICE_CURRENT)); }
   double            PriceStopLimit(void) const { return(OrderGetDouble(ORDER_PRICE_STOPLIMIT)); }
   string            Symbol(void) const { return(OrderGetString(ORDER_SYMBOL)); }
   string            Comment(void) const { return(OrderGetString(ORDER_COMMENT)); }
   bool              InfoInteger(const ENUM_ORDER_PROPERTY_INTEGER prop_id,long &var) const { return(OrderGetInteger(prop_id,var)); }
   bool              InfoDouble(const ENUM_ORDER_PROPERTY_DOUBLE prop_id,double &var) const { return(OrderGetDouble(prop_id,var)); }
   bool              InfoString(const ENUM_ORDER_PROPERTY_STRING prop_id,string &var) const { return(OrderGetString(prop_id,var)); }
   bool              Select(void) { return(OrderSelect(m_ticket)); }
   bool              Select(const ulong ticket) { if(OrderSelect(ticket)) { m_ticket=ticket; return(true); } m_ticket=0; return(false); }
   bool              SelectByIndex(const int index)
     {
      ulong ticket=OrderGetTicket(index);
      if(ticket==0) { m_ticket=0; return(false); }
      m_ticket=ticket;
      return(true);
     }
  };
`;

export const HISTORY_ORDER_INFO_MQH = String.raw`
#include <Object.mqh>
class CHistoryOrderInfo : public CObject
  {
protected:
   ulong             m_ticket;
public:
                     CHistoryOrderInfo(void) { m_ticket=0; }
   void              Ticket(const ulong ticket) { m_ticket=ticket; }
   ulong             Ticket(void) const { return(m_ticket); }
   datetime          TimeSetup(void) const { return((datetime)HistoryOrderGetInteger(m_ticket,ORDER_TIME_SETUP)); }
   datetime          TimeDone(void) const { return((datetime)HistoryOrderGetInteger(m_ticket,ORDER_TIME_DONE)); }
   ENUM_ORDER_TYPE   OrderType(void) const { return((ENUM_ORDER_TYPE)HistoryOrderGetInteger(m_ticket,ORDER_TYPE)); }
   ENUM_ORDER_STATE  State(void) const { return((ENUM_ORDER_STATE)HistoryOrderGetInteger(m_ticket,ORDER_STATE)); }
   long              Magic(void) const { return(HistoryOrderGetInteger(m_ticket,ORDER_MAGIC)); }
   long              PositionId(void) const { return(HistoryOrderGetInteger(m_ticket,ORDER_POSITION_ID)); }
   double            VolumeInitial(void) const { return(HistoryOrderGetDouble(m_ticket,ORDER_VOLUME_INITIAL)); }
   double            VolumeCurrent(void) const { return(HistoryOrderGetDouble(m_ticket,ORDER_VOLUME_CURRENT)); }
   double            PriceOpen(void) const { return(HistoryOrderGetDouble(m_ticket,ORDER_PRICE_OPEN)); }
   double            StopLoss(void) const { return(HistoryOrderGetDouble(m_ticket,ORDER_SL)); }
   double            TakeProfit(void) const { return(HistoryOrderGetDouble(m_ticket,ORDER_TP)); }
   string            Symbol(void) const { return(HistoryOrderGetString(m_ticket,ORDER_SYMBOL)); }
   string            Comment(void) const { return(HistoryOrderGetString(m_ticket,ORDER_COMMENT)); }
   bool              SelectByIndex(const int index) { ulong ticket=HistoryOrderGetTicket(index); if(ticket==0) return(false); m_ticket=ticket; return(true); }
  };
`;

export const DEAL_INFO_MQH = String.raw`
#include <Object.mqh>
class CDealInfo : public CObject
  {
protected:
   ulong             m_ticket;
public:
                     CDealInfo(void) { m_ticket=0; }
   void              Ticket(const ulong ticket) { m_ticket=ticket; }
   ulong             Ticket(void) const { return(m_ticket); }
   long              Order(void) const { return(HistoryDealGetInteger(m_ticket,DEAL_ORDER)); }
   datetime          Time(void) const { return((datetime)HistoryDealGetInteger(m_ticket,DEAL_TIME)); }
   ulong             TimeMsc(void) const { return((ulong)HistoryDealGetInteger(m_ticket,DEAL_TIME_MSC)); }
   ENUM_DEAL_TYPE    DealType(void) const { return((ENUM_DEAL_TYPE)HistoryDealGetInteger(m_ticket,DEAL_TYPE)); }
   string            TypeDescription(void) const { return(EnumToString(DealType())); }
   ENUM_DEAL_ENTRY   Entry(void) const { return((ENUM_DEAL_ENTRY)HistoryDealGetInteger(m_ticket,DEAL_ENTRY)); }
   string            EntryDescription(void) const { return(EnumToString(Entry())); }
   long              Magic(void) const { return(HistoryDealGetInteger(m_ticket,DEAL_MAGIC)); }
   long              PositionId(void) const { return(HistoryDealGetInteger(m_ticket,DEAL_POSITION_ID)); }
   double            Volume(void) const { return(HistoryDealGetDouble(m_ticket,DEAL_VOLUME)); }
   double            Price(void) const { return(HistoryDealGetDouble(m_ticket,DEAL_PRICE)); }
   double            Commission(void) const { return(HistoryDealGetDouble(m_ticket,DEAL_COMMISSION)); }
   double            Swap(void) const { return(HistoryDealGetDouble(m_ticket,DEAL_SWAP)); }
   double            Profit(void) const { return(HistoryDealGetDouble(m_ticket,DEAL_PROFIT)); }
   string            Symbol(void) const { return(HistoryDealGetString(m_ticket,DEAL_SYMBOL)); }
   string            Comment(void) const { return(HistoryDealGetString(m_ticket,DEAL_COMMENT)); }
   bool              InfoInteger(ENUM_DEAL_PROPERTY_INTEGER prop_id,long &var) const { return(HistoryDealGetInteger(m_ticket,prop_id,var)); }
   bool              InfoDouble(ENUM_DEAL_PROPERTY_DOUBLE prop_id,double &var) const { return(HistoryDealGetDouble(m_ticket,prop_id,var)); }
   bool              InfoString(ENUM_DEAL_PROPERTY_STRING prop_id,string &var) const { return(HistoryDealGetString(m_ticket,prop_id,var)); }
   bool              SelectByIndex(const int index) { ulong ticket=HistoryDealGetTicket(index); if(ticket==0) return(false); m_ticket=ticket; return(true); }
  };
`;

export const SYMBOL_INFO_MQH = String.raw`
#include <Object.mqh>
class CSymbolInfo : public CObject
  {
protected:
   string            m_name;
   MqlTick           m_tick;
   double            m_point;
   double            m_tick_value;
   double            m_tick_size;
   double            m_contract_size;
   double            m_lots_min;
   double            m_lots_max;
   double            m_lots_step;
   int               m_digits;
   int               m_stops_level;
   int               m_freeze_level;
public:
                     CSymbolInfo(void) { m_name=""; }
   bool              Name(const string name) { m_name=name; return(Select() && Refresh()); }
   string            Name(void) const { return(m_name); }
   bool              Refresh(void)
     {
      m_point=SymbolInfoDouble(m_name,SYMBOL_POINT);
      m_tick_value=SymbolInfoDouble(m_name,SYMBOL_TRADE_TICK_VALUE);
      m_tick_size=SymbolInfoDouble(m_name,SYMBOL_TRADE_TICK_SIZE);
      m_contract_size=SymbolInfoDouble(m_name,SYMBOL_TRADE_CONTRACT_SIZE);
      m_lots_min=SymbolInfoDouble(m_name,SYMBOL_VOLUME_MIN);
      m_lots_max=SymbolInfoDouble(m_name,SYMBOL_VOLUME_MAX);
      m_lots_step=SymbolInfoDouble(m_name,SYMBOL_VOLUME_STEP);
      m_digits=(int)SymbolInfoInteger(m_name,SYMBOL_DIGITS);
      m_stops_level=(int)SymbolInfoInteger(m_name,SYMBOL_TRADE_STOPS_LEVEL);
      m_freeze_level=(int)SymbolInfoInteger(m_name,SYMBOL_TRADE_FREEZE_LEVEL);
      return(m_point>0);
     }
   bool              RefreshRates(void) { return(SymbolInfoTick(m_name,m_tick)); }
   bool              Select(void) const { return(SymbolSelect(m_name,true)); }
   bool              Select(const bool select) { return(SymbolSelect(m_name,select)); }
   bool              IsSynchronized(void) const { return(SymbolIsSynchronized(m_name)); }
   long              Volume(void) const { return((long)m_tick.volume); }
   datetime          Time(void) const { return(m_tick.time); }
   int               Spread(void) const { return((int)SymbolInfoInteger(m_name,SYMBOL_SPREAD)); }
   bool              SpreadFloat(void) const { return((bool)SymbolInfoInteger(m_name,SYMBOL_SPREAD_FLOAT)); }
   int               TicksBookDepth(void) const { return(0); }
   int               StopsLevel(void) const { return(m_stops_level); }
   int               FreezeLevel(void) const { return(m_freeze_level); }
   double            Bid(void) const { return(m_tick.bid); }
   double            BidHigh(void) const { return(SymbolInfoDouble(m_name,SYMBOL_BIDHIGH)); }
   double            BidLow(void) const { return(SymbolInfoDouble(m_name,SYMBOL_BIDLOW)); }
   double            Ask(void) const { return(m_tick.ask); }
   double            AskHigh(void) const { return(SymbolInfoDouble(m_name,SYMBOL_ASKHIGH)); }
   double            AskLow(void) const { return(SymbolInfoDouble(m_name,SYMBOL_ASKLOW)); }
   double            Last(void) const { return(m_tick.last); }
   int               Digits(void) const { return(m_digits); }
   double            Point(void) const { return(m_point); }
   double            TickValue(void) const { return(m_tick_value); }
   double            TickValueProfit(void) const { return(SymbolInfoDouble(m_name,SYMBOL_TRADE_TICK_VALUE_PROFIT)); }
   double            TickValueLoss(void) const { return(SymbolInfoDouble(m_name,SYMBOL_TRADE_TICK_VALUE_LOSS)); }
   double            TickSize(void) const { return(m_tick_size); }
   double            ContractSize(void) const { return(m_contract_size); }
   double            LotsMin(void) const { return(m_lots_min); }
   double            LotsMax(void) const { return(m_lots_max); }
   double            LotsStep(void) const { return(m_lots_step); }
   double            LotsLimit(void) const { return(SymbolInfoDouble(m_name,SYMBOL_VOLUME_LIMIT)); }
   double            SwapLong(void) const { return(SymbolInfoDouble(m_name,SYMBOL_SWAP_LONG)); }
   double            SwapShort(void) const { return(SymbolInfoDouble(m_name,SYMBOL_SWAP_SHORT)); }
   double            MarginInitial(void) const { return(SymbolInfoDouble(m_name,SYMBOL_MARGIN_INITIAL)); }
   double            MarginMaintenance(void) const { return(SymbolInfoDouble(m_name,SYMBOL_MARGIN_MAINTENANCE)); }
   ENUM_SYMBOL_TRADE_MODE TradeMode(void) const { return((ENUM_SYMBOL_TRADE_MODE)SymbolInfoInteger(m_name,SYMBOL_TRADE_MODE)); }
   ENUM_SYMBOL_TRADE_EXECUTION TradeExecution(void) const { return((ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(m_name,SYMBOL_TRADE_EXEMODE)); }
   ENUM_SYMBOL_CALC_MODE TradeCalcMode(void) const { return((ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(m_name,SYMBOL_TRADE_CALC_MODE)); }
   int               TradeFillFlags(void) const { return((int)SymbolInfoInteger(m_name,SYMBOL_FILLING_MODE)); }
   int               OrderMode(void) const { return((int)SymbolInfoInteger(m_name,SYMBOL_ORDER_MODE)); }
   string            CurrencyBase(void) const { return(SymbolInfoString(m_name,SYMBOL_CURRENCY_BASE)); }
   string            CurrencyProfit(void) const { return(SymbolInfoString(m_name,SYMBOL_CURRENCY_PROFIT)); }
   string            CurrencyMargin(void) const { return(SymbolInfoString(m_name,SYMBOL_CURRENCY_MARGIN)); }
   string            Description(void) const { return(SymbolInfoString(m_name,SYMBOL_DESCRIPTION)); }
   string            Path(void) const { return(SymbolInfoString(m_name,SYMBOL_PATH)); }
   double            NormalizePrice(const double price) const
     {
      if(m_tick_size!=0)
         return(NormalizeDouble(MathRound(price/m_tick_size)*m_tick_size,m_digits));
      return(NormalizeDouble(price,m_digits));
     }
   bool              CheckMarketWatch(void) { return(true); }
   bool              InfoInteger(const ENUM_SYMBOL_INFO_INTEGER prop_id,long &var) const { return(SymbolInfoInteger(m_name,prop_id,var)); }
   bool              InfoDouble(const ENUM_SYMBOL_INFO_DOUBLE prop_id,double &var) const { return(SymbolInfoDouble(m_name,prop_id,var)); }
   bool              InfoString(const ENUM_SYMBOL_INFO_STRING prop_id,string &var) const { return(SymbolInfoString(m_name,prop_id,var)); }
  };
`;

export const ACCOUNT_INFO_MQH = String.raw`
#include <Object.mqh>
class CAccountInfo : public CObject
  {
public:
                     CAccountInfo(void) {}
   long              Login(void) const { return(AccountInfoInteger(ACCOUNT_LOGIN)); }
   ENUM_ACCOUNT_TRADE_MODE TradeMode(void) const { return((ENUM_ACCOUNT_TRADE_MODE)AccountInfoInteger(ACCOUNT_TRADE_MODE)); }
   string            TradeModeDescription(void) const
     {
      switch(TradeMode())
        {
         case ACCOUNT_TRADE_MODE_DEMO:    return("Demo trading account");
         case ACCOUNT_TRADE_MODE_CONTEST: return("Contest trading account");
         case ACCOUNT_TRADE_MODE_REAL:    return("Real trading account");
        }
      return("Unknown trade account");
     }
   long              Leverage(void) const { return(AccountInfoInteger(ACCOUNT_LEVERAGE)); }
   ENUM_ACCOUNT_STOPOUT_MODE StopoutMode(void) const { return((ENUM_ACCOUNT_STOPOUT_MODE)AccountInfoInteger(ACCOUNT_MARGIN_SO_MODE)); }
   ENUM_ACCOUNT_MARGIN_MODE MarginMode(void) const { return((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE)); }
   string            MarginModeDescription(void) const
     {
      switch(MarginMode())
        {
         case ACCOUNT_MARGIN_MODE_RETAIL_NETTING: return("Netting");
         case ACCOUNT_MARGIN_MODE_EXCHANGE:       return("Exchange");
         case ACCOUNT_MARGIN_MODE_RETAIL_HEDGING: return("Hedging");
        }
      return("Unknown margin mode");
     }
   bool              TradeAllowed(void) const { return((bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED)); }
   bool              TradeExpert(void) const { return((bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT)); }
   int               LimitOrders(void) const { return((int)AccountInfoInteger(ACCOUNT_LIMIT_ORDERS)); }
   double            Balance(void) const { return(AccountInfoDouble(ACCOUNT_BALANCE)); }
   double            Credit(void) const { return(AccountInfoDouble(ACCOUNT_CREDIT)); }
   double            Profit(void) const { return(AccountInfoDouble(ACCOUNT_PROFIT)); }
   double            Equity(void) const { return(AccountInfoDouble(ACCOUNT_EQUITY)); }
   double            Margin(void) const { return(AccountInfoDouble(ACCOUNT_MARGIN)); }
   double            FreeMargin(void) const { return(AccountInfoDouble(ACCOUNT_MARGIN_FREE)); }
   double            MarginLevel(void) const { return(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL)); }
   double            MarginCall(void) const { return(AccountInfoDouble(ACCOUNT_MARGIN_SO_CALL)); }
   double            MarginStopOut(void) const { return(AccountInfoDouble(ACCOUNT_MARGIN_SO_SO)); }
   string            Name(void) const { return(AccountInfoString(ACCOUNT_NAME)); }
   string            Server(void) const { return(AccountInfoString(ACCOUNT_SERVER)); }
   string            Currency(void) const { return(AccountInfoString(ACCOUNT_CURRENCY)); }
   string            Company(void) const { return(AccountInfoString(ACCOUNT_COMPANY)); }
   double            OrderProfitCheck(const string symbol,const ENUM_ORDER_TYPE trade_operation,const double volume,const double price_open,const double price_close) const
     {
      double profit=EMPTY_VALUE;
      if(!OrderCalcProfit(trade_operation,symbol,volume,price_open,price_close,profit))
         return(EMPTY_VALUE);
      return(profit);
     }
   double            MarginCheck(const string symbol,const ENUM_ORDER_TYPE trade_operation,const double volume,const double price) const
     {
      double margin=EMPTY_VALUE;
      if(!OrderCalcMargin(trade_operation,symbol,volume,price,margin))
         return(EMPTY_VALUE);
      return(margin);
     }
   double            FreeMarginCheck(const string symbol,const ENUM_ORDER_TYPE trade_operation,const double volume,const double price) const
     {
      return(FreeMargin()-MarginCheck(symbol,trade_operation,volume,price));
     }
   double            MaxLotCheck(const string symbol,const ENUM_ORDER_TYPE trade_operation,const double price,const double percent=100) const
     {
      double margin=0.0;
      if(!OrderCalcMargin(trade_operation,symbol,1.0,price,margin) || margin<=0.0)
         return(0.0);
      double volume=NormalizeDouble(FreeMargin()*percent/100.0/margin,2);
      double stepvol=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
      if(stepvol>0.0)
         volume=stepvol*MathFloor(volume/stepvol);
      double minvol=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
      if(volume<minvol)
         volume=0.0;
      double maxvol=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
      if(volume>maxvol)
         volume=maxvol;
      return(volume);
     }
  };
`;

export const TERMINAL_INFO_MQH = String.raw`
#include <Object.mqh>
class CTerminalInfo : public CObject
  {
public:
                     CTerminalInfo(void) {}
   int               Build(void) const { return((int)TerminalInfoInteger(TERMINAL_BUILD)); }
   bool              IsConnected(void) const { return((bool)TerminalInfoInteger(TERMINAL_CONNECTED)); }
   bool              IsDLLsAllowed(void) const { return(false); }
   bool              IsTradeAllowed(void) const { return((bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)); }
   bool              IsEmailEnabled(void) const { return(false); }
   bool              IsFtpEnabled(void) const { return(false); }
   int               MaxBars(void) const { return((int)TerminalInfoInteger(TERMINAL_MAXBARS)); }
   string            Language(void) const { return(TerminalInfoString(TERMINAL_LANGUAGE)); }
   string            Name(void) const { return(TerminalInfoString(TERMINAL_NAME)); }
   string            Company(void) const { return(TerminalInfoString(TERMINAL_COMPANY)); }
   string            Path(void) const { return(TerminalInfoString(TERMINAL_PATH)); }
   string            DataPath(void) const { return(TerminalInfoString(TERMINAL_DATA_PATH)); }
   string            CommonDataPath(void) const { return(TerminalInfoString(TERMINAL_COMMONDATA_PATH)); }
  };
`;

export const TRADE_MQH = String.raw`
#include <Object.mqh>
#include <Trade\OrderInfo.mqh>
#include <Trade\HistoryOrderInfo.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\DealInfo.mqh>

enum ENUM_LOG_LEVELS
  {
   LOG_LEVEL_NO_MSG,
   LOG_LEVEL_ERRORS,
   LOG_LEVEL_ALL
  };

class CTrade : public CObject
  {
protected:
   MqlTradeRequest   m_request;
   MqlTradeResult    m_result;
   MqlTradeCheckResult m_check_result;
   bool              m_async_mode;
   ulong             m_magic;
   ulong             m_deviation;
   ENUM_ORDER_TYPE_FILLING m_type_filling;
   ENUM_ACCOUNT_MARGIN_MODE m_margin_mode;
   ENUM_LOG_LEVELS   m_log_level;

   void              ClearStructures(void) { ZeroMemory(m_request); ZeroMemory(m_result); ZeroMemory(m_check_result); }
   bool              IsStopped(const string function)
     {
      if(!::IsStopped()) return(false);
      m_result.retcode=TRADE_RETCODE_CLIENT_DISABLES_AT;
      m_result.comment="expert was stopped";
      return(true);
     }
   bool              FillingCheck(const string symbol) { return(true); }
   ENUM_ORDER_TYPE   OppositeType(const ENUM_POSITION_TYPE type) const { return(type==POSITION_TYPE_BUY ? ORDER_TYPE_SELL : ORDER_TYPE_BUY); }

public:
                     CTrade(void)
     {
      m_async_mode=false;
      m_magic=0;
      m_deviation=10;
      m_type_filling=ORDER_FILLING_FOK;
      m_log_level=LOG_LEVEL_ERRORS;
      m_margin_mode=(ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
      SetTypeFillingBySymbol(Symbol());
     }
   void              LogLevel(const ENUM_LOG_LEVELS log_level) { m_log_level=log_level; }
   void              Request(MqlTradeRequest &request) const { request=m_request; }
   ENUM_TRADE_REQUEST_ACTIONS RequestAction(void) const { return(m_request.action); }
   string            RequestActionDescription(void) const { return(EnumToString(m_request.action)); }
   ulong             RequestMagic(void) const { return(m_request.magic); }
   ulong             RequestOrder(void) const { return(m_request.order); }
   ulong             RequestPosition(void) const { return(m_request.position); }
   ulong             RequestPositionBy(void) const { return(m_request.position_by); }
   string            RequestSymbol(void) const { return(m_request.symbol); }
   double            RequestVolume(void) const { return(m_request.volume); }
   double            RequestPrice(void) const { return(m_request.price); }
   double            RequestStopLimit(void) const { return(m_request.stoplimit); }
   double            RequestSL(void) const { return(m_request.sl); }
   double            RequestTP(void) const { return(m_request.tp); }
   ulong             RequestDeviation(void) const { return(m_request.deviation); }
   ENUM_ORDER_TYPE   RequestType(void) const { return(m_request.type); }
   string            RequestTypeDescription(void) const { return(EnumToString(m_request.type)); }
   ENUM_ORDER_TYPE_FILLING RequestTypeFilling(void) const { return(m_request.type_filling); }
   ENUM_ORDER_TYPE_TIME RequestTypeTime(void) const { return(m_request.type_time); }
   datetime          RequestExpiration(void) const { return(m_request.expiration); }
   string            RequestComment(void) const { return(m_request.comment); }
   void              Result(MqlTradeResult &result) const { result=m_result; }
   uint              ResultRetcode(void) const { return(m_result.retcode); }
   string            ResultRetcodeDescription(void) const { return(FormatRetcode(m_result.retcode)); }
   int               ResultRetcodeExternal(void) const { return(m_result.retcode_external); }
   ulong             ResultDeal(void) const { return(m_result.deal); }
   ulong             ResultOrder(void) const { return(m_result.order); }
   double            ResultVolume(void) const { return(m_result.volume); }
   double            ResultPrice(void) const { return(m_result.price); }
   double            ResultBid(void) const { return(m_result.bid); }
   double            ResultAsk(void) const { return(m_result.ask); }
   string            ResultComment(void) const { return(m_result.comment); }
   void              CheckResult(MqlTradeCheckResult &check_result) const { check_result=m_check_result; }
   uint              CheckResultRetcode(void) const { return(m_check_result.retcode); }
   string            CheckResultRetcodeDescription(void) const { return(FormatRetcode(m_check_result.retcode)); }
   double            CheckResultBalance(void) const { return(m_check_result.balance); }
   double            CheckResultEquity(void) const { return(m_check_result.equity); }
   double            CheckResultProfit(void) const { return(m_check_result.profit); }
   double            CheckResultMargin(void) const { return(m_check_result.margin); }
   double            CheckResultMarginFree(void) const { return(m_check_result.margin_free); }
   double            CheckResultMarginLevel(void) const { return(m_check_result.margin_level); }
   string            CheckResultComment(void) const { return(m_check_result.comment); }
   void              SetAsyncMode(const bool mode) { m_async_mode=mode; }
   void              SetExpertMagicNumber(const ulong magic) { m_magic=magic; }
   void              SetDeviationInPoints(const ulong deviation) { m_deviation=deviation; }
   void              SetTypeFilling(const ENUM_ORDER_TYPE_FILLING filling) { m_type_filling=filling; }
   bool              SetTypeFillingBySymbol(const string symbol)
     {
      uint filling=(uint)SymbolInfoInteger(symbol,SYMBOL_FILLING_MODE);
      if((filling&SYMBOL_FILLING_FOK)==SYMBOL_FILLING_FOK) { m_type_filling=ORDER_FILLING_FOK; return(true); }
      if((filling&SYMBOL_FILLING_IOC)==SYMBOL_FILLING_IOC) { m_type_filling=ORDER_FILLING_IOC; return(true); }
      m_type_filling=ORDER_FILLING_RETURN;
      return(false);
     }
   void              SetMarginMode(void) { m_margin_mode=(ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE); }

   bool              OrderCheck(const MqlTradeRequest &request,MqlTradeCheckResult &check_result) { return(::OrderCheck(request,check_result)); }
   bool              OrderSend(const MqlTradeRequest &request,MqlTradeResult &result)
     {
      bool res;
      if(m_async_mode)
         res=::OrderSendAsync(request,result);
      else
         res=::OrderSend(request,result);
      if(!res && m_log_level>LOG_LEVEL_NO_MSG)
         PrintFormat("CTrade::OrderSend: %s [%s]",FormatRequest(request),FormatRetcode(result.retcode));
      return(res);
     }

   bool              PositionOpen(const string symbol,const ENUM_ORDER_TYPE order_type,const double volume,
                                  const double price,const double sl,const double tp,const string comment="")
     {
      if(IsStopped(__FUNCTION__)) return(false);
      ClearStructures();
      if(order_type!=ORDER_TYPE_BUY && order_type!=ORDER_TYPE_SELL)
        {
         m_result.retcode=TRADE_RETCODE_INVALID;
         m_result.comment="Invalid order type";
         return(false);
        }
      m_request.action      =TRADE_ACTION_DEAL;
      m_request.symbol      =symbol;
      m_request.magic       =m_magic;
      m_request.volume      =volume;
      m_request.type        =order_type;
      m_request.price       =price;
      m_request.sl          =sl;
      m_request.tp          =tp;
      m_request.deviation   =m_deviation;
      m_request.type_filling=m_type_filling;
      m_request.comment     =comment;
      return(OrderSend(m_request,m_result));
     }
   bool              PositionModify(const string symbol,const double sl,const double tp)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      if(!PositionSelect(symbol)) return(false);
      return(PositionModify((ulong)PositionGetInteger(POSITION_TICKET),sl,tp));
     }
   bool              PositionModify(const ulong ticket,const double sl,const double tp)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      if(!PositionSelectByTicket(ticket)) return(false);
      ClearStructures();
      m_request.action  =TRADE_ACTION_SLTP;
      m_request.position=ticket;
      m_request.symbol  =PositionGetString(POSITION_SYMBOL);
      m_request.magic   =m_magic;
      m_request.sl      =sl;
      m_request.tp      =tp;
      return(OrderSend(m_request,m_result));
     }
   bool              PositionClose(const string symbol,const ulong deviation=ULONG_MAX)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      if(!PositionSelect(symbol)) return(false);
      return(PositionClose((ulong)PositionGetInteger(POSITION_TICKET),deviation));
     }
   bool              PositionClose(const ulong ticket,const ulong deviation=ULONG_MAX)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      if(!PositionSelectByTicket(ticket)) return(false);
      string symbol=PositionGetString(POSITION_SYMBOL);
      ClearStructures();
      ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      m_request.action   =TRADE_ACTION_DEAL;
      m_request.position =ticket;
      m_request.symbol   =symbol;
      m_request.volume   =PositionGetDouble(POSITION_VOLUME);
      m_request.magic    =m_magic;
      m_request.deviation=(deviation==ULONG_MAX) ? m_deviation : deviation;
      m_request.type     =OppositeType(type);
      m_request.price    =(type==POSITION_TYPE_BUY) ? SymbolInfoDouble(symbol,SYMBOL_BID) : SymbolInfoDouble(symbol,SYMBOL_ASK);
      m_request.type_filling=m_type_filling;
      return(OrderSend(m_request,m_result));
     }
   bool              PositionCloseBy(const ulong ticket,const ulong ticket_by)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      ClearStructures();
      m_request.action     =TRADE_ACTION_CLOSE_BY;
      m_request.position   =ticket;
      m_request.position_by=ticket_by;
      m_request.magic      =m_magic;
      return(OrderSend(m_request,m_result));
     }
   bool              PositionClosePartial(const string symbol,const double volume,const ulong deviation=ULONG_MAX)
     {
      if(!PositionSelect(symbol)) return(false);
      return(PositionClosePartial((ulong)PositionGetInteger(POSITION_TICKET),volume,deviation));
     }
   bool              PositionClosePartial(const ulong ticket,const double volume,const ulong deviation=ULONG_MAX)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      if(!PositionSelectByTicket(ticket)) return(false);
      string symbol=PositionGetString(POSITION_SYMBOL);
      ClearStructures();
      ENUM_POSITION_TYPE type=(ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      m_request.action   =TRADE_ACTION_DEAL;
      m_request.position =ticket;
      m_request.symbol   =symbol;
      m_request.volume   =MathMin(volume,PositionGetDouble(POSITION_VOLUME));
      m_request.magic    =m_magic;
      m_request.deviation=(deviation==ULONG_MAX) ? m_deviation : deviation;
      m_request.type     =OppositeType(type);
      m_request.price    =(type==POSITION_TYPE_BUY) ? SymbolInfoDouble(symbol,SYMBOL_BID) : SymbolInfoDouble(symbol,SYMBOL_ASK);
      m_request.type_filling=m_type_filling;
      return(OrderSend(m_request,m_result));
     }

   bool              OrderOpen(const string symbol,const ENUM_ORDER_TYPE order_type,const double volume,
                               const double limit_price,const double price,const double sl,const double tp,
                               ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,const datetime expiration=0,
                               const string comment="")
     {
      if(IsStopped(__FUNCTION__)) return(false);
      ClearStructures();
      if(order_type==ORDER_TYPE_BUY || order_type==ORDER_TYPE_SELL)
        {
         m_result.retcode=TRADE_RETCODE_INVALID;
         m_result.comment="Invalid order type";
         return(false);
        }
      if(expiration==0 && type_time==ORDER_TIME_SPECIFIED) type_time=ORDER_TIME_GTC;
      m_request.action      =TRADE_ACTION_PENDING;
      m_request.symbol      =symbol;
      m_request.magic       =m_magic;
      m_request.volume      =volume;
      m_request.type        =order_type;
      m_request.stoplimit   =limit_price;
      m_request.price       =price;
      m_request.sl          =sl;
      m_request.tp          =tp;
      m_request.type_time   =type_time;
      m_request.expiration  =expiration;
      m_request.type_filling=m_type_filling;
      m_request.comment     =comment;
      return(OrderSend(m_request,m_result));
     }
   bool              OrderModify(const ulong ticket,const double price,const double sl,const double tp,
                                 const ENUM_ORDER_TYPE_TIME type_time,const datetime expiration,const double stoplimit=0.0)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      if(!OrderSelect(ticket)) return(false);
      ClearStructures();
      m_request.symbol    =OrderGetString(ORDER_SYMBOL);
      m_request.action    =TRADE_ACTION_MODIFY;
      m_request.magic     =m_magic;
      m_request.order     =ticket;
      m_request.price     =price;
      m_request.stoplimit =stoplimit;
      m_request.sl        =sl;
      m_request.tp        =tp;
      m_request.type_time =type_time;
      m_request.expiration=expiration;
      return(OrderSend(m_request,m_result));
     }
   bool              OrderDelete(const ulong ticket)
     {
      if(IsStopped(__FUNCTION__)) return(false);
      ClearStructures();
      m_request.action=TRADE_ACTION_REMOVE;
      m_request.magic =m_magic;
      m_request.order =ticket;
      return(OrderSend(m_request,m_result));
     }

   bool              Buy(const double volume,const string symbol=NULL,double price=0.0,const double sl=0.0,const double tp=0.0,const string comment="")
     {
      string sym=(symbol==NULL || symbol=="") ? Symbol() : symbol;
      if(price==0.0) price=SymbolInfoDouble(sym,SYMBOL_ASK);
      return(PositionOpen(sym,ORDER_TYPE_BUY,volume,price,sl,tp,comment));
     }
   bool              Sell(const double volume,const string symbol=NULL,double price=0.0,const double sl=0.0,const double tp=0.0,const string comment="")
     {
      string sym=(symbol==NULL || symbol=="") ? Symbol() : symbol;
      if(price==0.0) price=SymbolInfoDouble(sym,SYMBOL_BID);
      return(PositionOpen(sym,ORDER_TYPE_SELL,volume,price,sl,tp,comment));
     }
   bool              BuyLimit(const double volume,const double price,const string symbol=NULL,const double sl=0.0,const double tp=0.0,
                              const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,const datetime expiration=0,const string comment="")
     {
      string sym=(symbol==NULL || symbol=="") ? Symbol() : symbol;
      return(OrderOpen(sym,ORDER_TYPE_BUY_LIMIT,volume,0.0,price,sl,tp,type_time,expiration,comment));
     }
   bool              BuyStop(const double volume,const double price,const string symbol=NULL,const double sl=0.0,const double tp=0.0,
                             const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,const datetime expiration=0,const string comment="")
     {
      string sym=(symbol==NULL || symbol=="") ? Symbol() : symbol;
      return(OrderOpen(sym,ORDER_TYPE_BUY_STOP,volume,0.0,price,sl,tp,type_time,expiration,comment));
     }
   bool              SellLimit(const double volume,const double price,const string symbol=NULL,const double sl=0.0,const double tp=0.0,
                               const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,const datetime expiration=0,const string comment="")
     {
      string sym=(symbol==NULL || symbol=="") ? Symbol() : symbol;
      return(OrderOpen(sym,ORDER_TYPE_SELL_LIMIT,volume,0.0,price,sl,tp,type_time,expiration,comment));
     }
   bool              SellStop(const double volume,const double price,const string symbol=NULL,const double sl=0.0,const double tp=0.0,
                              const ENUM_ORDER_TYPE_TIME type_time=ORDER_TIME_GTC,const datetime expiration=0,const string comment="")
     {
      string sym=(symbol==NULL || symbol=="") ? Symbol() : symbol;
      return(OrderOpen(sym,ORDER_TYPE_SELL_STOP,volume,0.0,price,sl,tp,type_time,expiration,comment));
     }

   string            FormatRequest(const MqlTradeRequest &request) const
     {
      return(StringFormat("%s %s %.2f %s at %.5f sl: %.5f tp: %.5f",EnumToString(request.action),EnumToString(request.type),
                          request.volume,request.symbol,request.price,request.sl,request.tp));
     }
   string            FormatRetcode(const uint retcode) const
     {
      switch(retcode)
        {
         case TRADE_RETCODE_REQUOTE:          return("requote");
         case TRADE_RETCODE_REJECT:           return("rejected");
         case TRADE_RETCODE_CANCEL:           return("canceled");
         case TRADE_RETCODE_PLACED:           return("placed");
         case TRADE_RETCODE_DONE:             return("done");
         case TRADE_RETCODE_DONE_PARTIAL:     return("done partially");
         case TRADE_RETCODE_ERROR:            return("common error");
         case TRADE_RETCODE_TIMEOUT:          return("timeout");
         case TRADE_RETCODE_INVALID:          return("invalid request");
         case TRADE_RETCODE_INVALID_VOLUME:   return("invalid volume");
         case TRADE_RETCODE_INVALID_PRICE:    return("invalid price");
         case TRADE_RETCODE_INVALID_STOPS:    return("invalid stops");
         case TRADE_RETCODE_TRADE_DISABLED:   return("trade disabled");
         case TRADE_RETCODE_MARKET_CLOSED:    return("market closed");
         case TRADE_RETCODE_NO_MONEY:         return("not enough money");
         case TRADE_RETCODE_PRICE_CHANGED:    return("price changed");
         case TRADE_RETCODE_PRICE_OFF:        return("off quotes");
         case TRADE_RETCODE_INVALID_EXPIRATION: return("invalid expiration");
         case TRADE_RETCODE_ORDER_CHANGED:    return("order changed");
         case TRADE_RETCODE_TOO_MANY_REQUESTS: return("too many requests");
         case TRADE_RETCODE_NO_CHANGES:       return("no changes");
         case TRADE_RETCODE_SERVER_DISABLES_AT: return("auto trading disabled by server");
         case TRADE_RETCODE_CLIENT_DISABLES_AT: return("auto trading disabled by client");
         case TRADE_RETCODE_LOCKED:           return("locked");
         case TRADE_RETCODE_FROZEN:           return("frozen");
         case TRADE_RETCODE_INVALID_FILL:     return("invalid fill");
         case TRADE_RETCODE_CONNECTION:       return("no connection");
         case TRADE_RETCODE_ONLY_REAL:        return("only real");
         case TRADE_RETCODE_LIMIT_ORDERS:     return("limit orders");
         case TRADE_RETCODE_LIMIT_VOLUME:     return("limit volume");
         case TRADE_RETCODE_POSITION_CLOSED:  return("position closed");
         case TRADE_RETCODE_INVALID_ORDER:    return("invalid order");
         case TRADE_RETCODE_CLOSE_ORDER_EXIST: return("close order already exists");
         case TRADE_RETCODE_LIMIT_POSITIONS:  return("limit positions");
        }
      return("unknown retcode "+IntegerToString(retcode));
     }
   void              PrintRequest(void) const { Print(FormatRequest(m_request)); }
   void              PrintResult(void) const { PrintFormat("retcode=%u (%s) deal=%I64u order=%I64u volume=%.2f price=%.5f",m_result.retcode,FormatRetcode(m_result.retcode),m_result.deal,m_result.order,m_result.volume,m_result.price); }
  };
`;
