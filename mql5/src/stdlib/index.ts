import {
  ARRAY_DOUBLE_MQH,
  ARRAY_INT_MQH,
  ARRAY_LONG_MQH,
  ARRAY_MQH,
  ARRAY_OBJ_MQH,
  ARRAY_STRING_MQH,
} from './arrays.js';
import {
  ACCOUNT_INFO_MQH,
  DEAL_INFO_MQH,
  HISTORY_ORDER_INFO_MQH,
  OBJECT_MQH,
  ORDER_INFO_MQH,
  POSITION_INFO_MQH,
  SYMBOL_INFO_MQH,
  TERMINAL_INFO_MQH,
  TRADE_MQH,
} from './trade.js';

/** Bundled standard-library headers, keyed by normalised include path. */
export const STDLIB = new Map<string, string>([
  ['object.mqh', OBJECT_MQH],
  ['trade/trade.mqh', TRADE_MQH],
  ['trade/positioninfo.mqh', POSITION_INFO_MQH],
  ['trade/orderinfo.mqh', ORDER_INFO_MQH],
  ['trade/historyorderinfo.mqh', HISTORY_ORDER_INFO_MQH],
  ['trade/dealinfo.mqh', DEAL_INFO_MQH],
  ['trade/symbolinfo.mqh', SYMBOL_INFO_MQH],
  ['trade/accountinfo.mqh', ACCOUNT_INFO_MQH],
  ['trade/terminalinfo.mqh', TERMINAL_INFO_MQH],
  ['arrays/array.mqh', ARRAY_MQH],
  ['arrays/arraydouble.mqh', ARRAY_DOUBLE_MQH],
  ['arrays/arrayint.mqh', ARRAY_INT_MQH],
  ['arrays/arraylong.mqh', ARRAY_LONG_MQH],
  ['arrays/arraystring.mqh', ARRAY_STRING_MQH],
  ['arrays/arrayobj.mqh', ARRAY_OBJ_MQH],
  // Headers that only declare things this runtime already provides.
  ['stdlib.mqh', ''],
  ['stderror.mqh', ''],
  ['mqlerrors.mqh', ''],
]);
