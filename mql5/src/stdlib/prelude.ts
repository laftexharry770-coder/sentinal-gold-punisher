/**
 * Structures MQL5 predefines, compiled ahead of every program so natives can
 * build them and programs can declare them.
 */
export const PRELUDE = String.raw`
struct MqlRates
  {
   datetime time;
   double   open;
   double   high;
   double   low;
   double   close;
   long     tick_volume;
   int      spread;
   long     real_volume;
  };

struct MqlTick
  {
   datetime time;
   double   bid;
   double   ask;
   double   last;
   ulong    volume;
   long     time_msc;
   uint     flags;
   double   volume_real;
  };

struct MqlDateTime
  {
   int year;
   int mon;
   int day;
   int hour;
   int min;
   int sec;
   int day_of_week;
   int day_of_year;
  };

struct MqlTradeRequest
  {
   ENUM_TRADE_REQUEST_ACTIONS action;
   ulong                      magic;
   ulong                      order;
   string                     symbol;
   double                     volume;
   double                     price;
   double                     stoplimit;
   double                     sl;
   double                     tp;
   ulong                      deviation;
   ENUM_ORDER_TYPE            type;
   ENUM_ORDER_TYPE_FILLING    type_filling;
   ENUM_ORDER_TYPE_TIME       type_time;
   datetime                   expiration;
   string                     comment;
   ulong                      position;
   ulong                      position_by;
  };

struct MqlTradeResult
  {
   uint     retcode;
   ulong    deal;
   ulong    order;
   double   volume;
   double   price;
   double   bid;
   double   ask;
   string   comment;
   uint     request_id;
   int      retcode_external;
  };

struct MqlTradeCheckResult
  {
   uint     retcode;
   double   balance;
   double   equity;
   double   profit;
   double   margin;
   double   margin_free;
   double   margin_level;
   string   comment;
  };

struct MqlTradeTransaction
  {
   ulong                         deal;
   ulong                         order;
   string                        symbol;
   ENUM_TRADE_TRANSACTION_TYPE   type;
   ENUM_ORDER_TYPE               order_type;
   ENUM_ORDER_STATE              order_state;
   ENUM_DEAL_TYPE                deal_type;
   ENUM_ORDER_TYPE_TIME          time_type;
   datetime                      time_expiration;
   double                        price;
   double                        price_trigger;
   double                        price_sl;
   double                        price_tp;
   double                        volume;
   ulong                         position;
   ulong                         position_by;
  };

struct MqlBookInfo
  {
   ENUM_BOOK_TYPE type;
   double         price;
   long           volume;
   double         volume_real;
  };

struct MqlParam
  {
   ENUM_DATATYPE type;
   long          integer_value;
   double        double_value;
   string        string_value;
  };
`;

/** Structs the runtime constructs itself, so it needs their generated classes. */
export const RUNTIME_STRUCTS = [
  'MqlRates',
  'MqlTick',
  'MqlDateTime',
  'MqlTradeRequest',
  'MqlTradeResult',
  'MqlTradeCheckResult',
  'MqlTradeTransaction',
] as const;
