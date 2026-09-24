/**
 * The built-in functions MQL5 programs can call, declared as MQL5 prototypes.
 *
 * Declaring them in MQL5's own syntax means the compiler applies MQL5's rules
 * to them — argument conversion, reference parameters, default values and
 * overload selection — exactly as it does for the program's own functions.
 *
 * `async` marks a function that has to wait for the broker. Only those, and
 * functions that call them, compile to asynchronous code; everything else runs
 * synchronously at full speed. `@Name` names the runtime implementation when
 * an overload needs its own. `...` is a variadic tail.
 */
export const NATIVE_PROTOTYPES = String.raw`
void Print(...)
void PrintFormat(string format, ...)
void Comment(...)
void Alert(...)
string StringFormat(string format, ...)
int GetLastError()
void ResetLastError()
void SetUserError(ushort code)
bool IsStopped()
uint GetTickCount()
ulong GetTickCount64()
ulong GetMicrosecondCount()
async void Sleep(int milliseconds)
bool SendNotification(string text)
bool SendMail(string subject, string text)
bool PlaySound(string filename)
int MessageBox(string text, string caption = NULL, int flags = 0)
void DebugBreak()
void ExpertRemove()
bool TerminalClose(int ret_code)
long TerminalInfoInteger(ENUM_TERMINAL_INFO_INTEGER property_id)
double TerminalInfoDouble(ENUM_TERMINAL_INFO_DOUBLE property_id)
string TerminalInfoString(ENUM_TERMINAL_INFO_STRING property_id)
long MQLInfoInteger(ENUM_MQL_INFO_INTEGER property_id)
string MQLInfoString(ENUM_MQL_INFO_STRING property_id)
string Symbol()
ENUM_TIMEFRAMES Period()
double Point()
int Digits()
bool EventSetTimer(int seconds)
bool EventSetMillisecondTimer(int milliseconds)
void EventKillTimer()
bool EventChartCustom(long chart_id, ushort custom_event_id, long lparam, double dparam, string sparam)
int WebRequest(string method, string url, string headers, int timeout, char &data[], char &result[], string &result_headers)

double AccountInfoDouble(ENUM_ACCOUNT_INFO_DOUBLE property_id)
long AccountInfoInteger(ENUM_ACCOUNT_INFO_INTEGER property_id)
string AccountInfoString(ENUM_ACCOUNT_INFO_STRING property_id)

double SymbolInfoDouble(string name, ENUM_SYMBOL_INFO_DOUBLE prop_id)
bool SymbolInfoDouble(string name, ENUM_SYMBOL_INFO_DOUBLE prop_id, double &value) @SymbolInfoDoubleRef
long SymbolInfoInteger(string name, ENUM_SYMBOL_INFO_INTEGER prop_id)
bool SymbolInfoInteger(string name, ENUM_SYMBOL_INFO_INTEGER prop_id, long &value) @SymbolInfoIntegerRef
string SymbolInfoString(string name, ENUM_SYMBOL_INFO_STRING prop_id)
bool SymbolInfoString(string name, ENUM_SYMBOL_INFO_STRING prop_id, string &value) @SymbolInfoStringRef
bool SymbolInfoTick(string symbol, MqlTick &tick)
bool SymbolSelect(string name, bool select)
bool SymbolExist(string name, bool &is_custom)
int SymbolsTotal(bool selected)
string SymbolName(int pos, bool selected)
bool SymbolIsSynchronized(string name)
bool SymbolInfoSessionTrade(string name, ENUM_DAY_OF_WEEK day_of_week, uint session_index, datetime &from, datetime &to)
bool SymbolInfoSessionQuote(string name, ENUM_DAY_OF_WEEK day_of_week, uint session_index, datetime &from, datetime &to)
bool SymbolInfoMarginRate(string name, ENUM_ORDER_TYPE order_type, double &initial_margin_rate, double &maintenance_margin_rate)

long SeriesInfoInteger(string symbol_name, ENUM_TIMEFRAMES timeframe, ENUM_SERIES_INFO_INTEGER prop_id)
bool SeriesInfoInteger(string symbol_name, ENUM_TIMEFRAMES timeframe, ENUM_SERIES_INFO_INTEGER prop_id, long &value) @SeriesInfoIntegerRef
int Bars(string symbol_name, ENUM_TIMEFRAMES timeframe)
int Bars(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, datetime stop_time) @BarsRange
int iBars(string symbol, ENUM_TIMEFRAMES timeframe)
datetime iTime(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
double iOpen(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
double iHigh(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
double iLow(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
double iClose(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
long iVolume(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
long iTickVolume(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
long iRealVolume(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
int iSpread(string symbol, ENUM_TIMEFRAMES timeframe, int shift)
int iBarShift(string symbol, ENUM_TIMEFRAMES timeframe, datetime time, bool exact = false)
int iHighest(string symbol, ENUM_TIMEFRAMES timeframe, ENUM_SERIESMODE type, int count = WHOLE_ARRAY, int start = 0)
int iLowest(string symbol, ENUM_TIMEFRAMES timeframe, ENUM_SERIESMODE type, int count = WHOLE_ARRAY, int start = 0)

int CopyRates(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, MqlRates &rates_array[])
int CopyRates(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, int count, MqlRates &rates_array[]) @CopyRatesFrom
int CopyRates(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, datetime stop_time, MqlRates &rates_array[]) @CopyRatesRange
int CopyTime(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, datetime &time_array[])
int CopyTime(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, int count, datetime &time_array[]) @CopyTimeFrom
int CopyTime(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, datetime stop_time, datetime &time_array[]) @CopyTimeRange
int CopyOpen(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, double &open_array[])
int CopyOpen(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, int count, double &open_array[]) @CopyOpenFrom
int CopyOpen(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, datetime stop_time, double &open_array[]) @CopyOpenRange
int CopyHigh(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, double &high_array[])
int CopyHigh(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, int count, double &high_array[]) @CopyHighFrom
int CopyHigh(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, datetime stop_time, double &high_array[]) @CopyHighRange
int CopyLow(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, double &low_array[])
int CopyLow(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, int count, double &low_array[]) @CopyLowFrom
int CopyLow(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, datetime stop_time, double &low_array[]) @CopyLowRange
int CopyClose(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, double &close_array[])
int CopyClose(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, int count, double &close_array[]) @CopyCloseFrom
int CopyClose(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, datetime stop_time, double &close_array[]) @CopyCloseRange
int CopyTickVolume(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, long &volume_array[])
int CopyTickVolume(string symbol_name, ENUM_TIMEFRAMES timeframe, datetime start_time, int count, long &volume_array[]) @CopyTickVolumeFrom
int CopyRealVolume(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, long &volume_array[])
int CopySpread(string symbol_name, ENUM_TIMEFRAMES timeframe, int start_pos, int count, int &spread_array[])
int CopyTicks(string symbol_name, MqlTick &ticks_array[], uint flags = COPY_TICKS_ALL, ulong from = 0, uint count = 0)
int CopyTicksRange(string symbol_name, MqlTick &ticks_array[], uint flags = COPY_TICKS_ALL, ulong from_msc = 0, ulong to_msc = 0)
int CopyBuffer(int indicator_handle, int buffer_num, int start_pos, int count, double &buffer[])
int CopyBuffer(int indicator_handle, int buffer_num, datetime start_time, int count, double &buffer[]) @CopyBufferFrom
int CopyBuffer(int indicator_handle, int buffer_num, datetime start_time, datetime stop_time, double &buffer[]) @CopyBufferRange
int BarsCalculated(int indicator_handle)
bool IndicatorRelease(int indicator_handle)

int iMA(string symbol, ENUM_TIMEFRAMES period, int ma_period, int ma_shift, ENUM_MA_METHOD ma_method, int applied_price)
int iRSI(string symbol, ENUM_TIMEFRAMES period, int ma_period, int applied_price)
int iATR(string symbol, ENUM_TIMEFRAMES period, int ma_period)
int iADX(string symbol, ENUM_TIMEFRAMES period, int adx_period)
int iADXWilder(string symbol, ENUM_TIMEFRAMES period, int adx_period)
int iBands(string symbol, ENUM_TIMEFRAMES period, int bands_period, int bands_shift, double deviation, int applied_price)
int iMACD(string symbol, ENUM_TIMEFRAMES period, int fast_ema_period, int slow_ema_period, int signal_period, int applied_price)
int iOsMA(string symbol, ENUM_TIMEFRAMES period, int fast_ema_period, int slow_ema_period, int signal_period, int applied_price)
int iStochastic(string symbol, ENUM_TIMEFRAMES period, int Kperiod, int Dperiod, int slowing, ENUM_MA_METHOD ma_method, ENUM_STO_PRICE price_field)
int iCCI(string symbol, ENUM_TIMEFRAMES period, int ma_period, int applied_price)
int iMomentum(string symbol, ENUM_TIMEFRAMES period, int mom_period, int applied_price)
int iSAR(string symbol, ENUM_TIMEFRAMES period, double step, double maximum)
int iWPR(string symbol, ENUM_TIMEFRAMES period, int calc_period)
int iEnvelopes(string symbol, ENUM_TIMEFRAMES period, int ma_period, int ma_shift, ENUM_MA_METHOD ma_method, int applied_price, double deviation)
int iStdDev(string symbol, ENUM_TIMEFRAMES period, int ma_period, int ma_shift, ENUM_MA_METHOD ma_method, int applied_price)
int iAO(string symbol, ENUM_TIMEFRAMES period)
int iAC(string symbol, ENUM_TIMEFRAMES period)
int iDEMA(string symbol, ENUM_TIMEFRAMES period, int ma_period, int ma_shift, int applied_price)
int iTEMA(string symbol, ENUM_TIMEFRAMES period, int ma_period, int ma_shift, int applied_price)
int iMFI(string symbol, ENUM_TIMEFRAMES period, int ma_period, ENUM_APPLIED_VOLUME applied_volume)
int iOBV(string symbol, ENUM_TIMEFRAMES period, ENUM_APPLIED_VOLUME applied_volume)
int iForce(string symbol, ENUM_TIMEFRAMES period, int ma_period, ENUM_MA_METHOD ma_method, ENUM_APPLIED_VOLUME applied_volume)
int iDeMarker(string symbol, ENUM_TIMEFRAMES period, int ma_period)
int iBullsPower(string symbol, ENUM_TIMEFRAMES period, int ma_period)
int iBearsPower(string symbol, ENUM_TIMEFRAMES period, int ma_period)
int iIchimoku(string symbol, ENUM_TIMEFRAMES period, int tenkan_sen, int kijun_sen, int senkou_span_b)
int iAlligator(string symbol, ENUM_TIMEFRAMES period, int jaw_period, int jaw_shift, int teeth_period, int teeth_shift, int lips_period, int lips_shift, ENUM_MA_METHOD ma_method, int applied_price)
int iFractals(string symbol, ENUM_TIMEFRAMES period)
int iVolumes(string symbol, ENUM_TIMEFRAMES period, ENUM_APPLIED_VOLUME applied_volume)
int iCustom(string symbol, ENUM_TIMEFRAMES period, string name, ...)
int IndicatorCreate(string symbol, ENUM_TIMEFRAMES period, ENUM_INDICATOR indicator_type, int parameters_cnt = 0, MqlParam &parameters_array[] = NULL)

async bool OrderSend(MqlTradeRequest &request, MqlTradeResult &result)
bool OrderSendAsync(MqlTradeRequest &request, MqlTradeResult &result)
bool OrderCheck(MqlTradeRequest &request, MqlTradeCheckResult &result)
bool OrderCalcMargin(ENUM_ORDER_TYPE action, string symbol, double volume, double price, double &margin)
bool OrderCalcProfit(ENUM_ORDER_TYPE action, string symbol, double volume, double price_open, double price_close, double &profit)
int PositionsTotal()
string PositionGetSymbol(int index)
bool PositionSelect(string symbol)
bool PositionSelectByTicket(ulong ticket)
ulong PositionGetTicket(int index)
double PositionGetDouble(ENUM_POSITION_PROPERTY_DOUBLE property_id)
bool PositionGetDouble(ENUM_POSITION_PROPERTY_DOUBLE property_id, double &double_var) @PositionGetDoubleRef
long PositionGetInteger(ENUM_POSITION_PROPERTY_INTEGER property_id)
bool PositionGetInteger(ENUM_POSITION_PROPERTY_INTEGER property_id, long &long_var) @PositionGetIntegerRef
string PositionGetString(ENUM_POSITION_PROPERTY_STRING property_id)
bool PositionGetString(ENUM_POSITION_PROPERTY_STRING property_id, string &string_var) @PositionGetStringRef
int OrdersTotal()
ulong OrderGetTicket(int index)
bool OrderSelect(ulong ticket)
double OrderGetDouble(ENUM_ORDER_PROPERTY_DOUBLE property_id)
bool OrderGetDouble(ENUM_ORDER_PROPERTY_DOUBLE property_id, double &double_var) @OrderGetDoubleRef
long OrderGetInteger(ENUM_ORDER_PROPERTY_INTEGER property_id)
bool OrderGetInteger(ENUM_ORDER_PROPERTY_INTEGER property_id, long &long_var) @OrderGetIntegerRef
string OrderGetString(ENUM_ORDER_PROPERTY_STRING property_id)
bool OrderGetString(ENUM_ORDER_PROPERTY_STRING property_id, string &string_var) @OrderGetStringRef
bool HistorySelect(datetime from_date, datetime to_date)
bool HistorySelectByPosition(long position_id)
bool HistoryOrderSelect(ulong ticket)
int HistoryOrdersTotal()
ulong HistoryOrderGetTicket(int index)
double HistoryOrderGetDouble(ulong ticket_number, ENUM_ORDER_PROPERTY_DOUBLE property_id)
bool HistoryOrderGetDouble(ulong ticket_number, ENUM_ORDER_PROPERTY_DOUBLE property_id, double &double_var) @HistoryOrderGetDoubleRef
long HistoryOrderGetInteger(ulong ticket_number, ENUM_ORDER_PROPERTY_INTEGER property_id)
bool HistoryOrderGetInteger(ulong ticket_number, ENUM_ORDER_PROPERTY_INTEGER property_id, long &long_var) @HistoryOrderGetIntegerRef
string HistoryOrderGetString(ulong ticket_number, ENUM_ORDER_PROPERTY_STRING property_id)
bool HistoryOrderGetString(ulong ticket_number, ENUM_ORDER_PROPERTY_STRING property_id, string &string_var) @HistoryOrderGetStringRef
bool HistoryDealSelect(ulong ticket)
int HistoryDealsTotal()
ulong HistoryDealGetTicket(int index)
double HistoryDealGetDouble(ulong ticket_number, ENUM_DEAL_PROPERTY_DOUBLE property_id)
bool HistoryDealGetDouble(ulong ticket_number, ENUM_DEAL_PROPERTY_DOUBLE property_id, double &double_var) @HistoryDealGetDoubleRef
long HistoryDealGetInteger(ulong ticket_number, ENUM_DEAL_PROPERTY_INTEGER property_id)
bool HistoryDealGetInteger(ulong ticket_number, ENUM_DEAL_PROPERTY_INTEGER property_id, long &long_var) @HistoryDealGetIntegerRef
string HistoryDealGetString(ulong ticket_number, ENUM_DEAL_PROPERTY_STRING property_id)
bool HistoryDealGetString(ulong ticket_number, ENUM_DEAL_PROPERTY_STRING property_id, string &string_var) @HistoryDealGetStringRef

datetime TimeCurrent()
datetime TimeCurrent(MqlDateTime &dt_struct) @TimeCurrentStruct
datetime TimeTradeServer()
datetime TimeTradeServer(MqlDateTime &dt_struct) @TimeTradeServerStruct
datetime TimeLocal()
datetime TimeLocal(MqlDateTime &dt_struct) @TimeLocalStruct
datetime TimeGMT()
datetime TimeGMT(MqlDateTime &dt_struct) @TimeGMTStruct
int TimeGMTOffset()
int TimeDaylightSavings()
bool TimeToStruct(datetime dt, MqlDateTime &dt_struct)
datetime StructToTime(MqlDateTime &dt_struct)
string TimeToString(datetime value, int mode = TIME_DATE|TIME_MINUTES)
datetime StringToTime(string value)

string DoubleToString(double value, int digits = 8)
string IntegerToString(long number, int str_len = 0, ushort fill_symbol = ' ')
double StringToDouble(string value)
long StringToInteger(string value)
double NormalizeDouble(double value, int digits)
string CharToString(uchar char_code)
string ShortToString(ushort symbol_code)
string ColorToString(color color_value, bool color_name = false)
color StringToColor(string color_string)
int StringToCharArray(string text_string, uchar &array[], int start = 0, int count = -1, uint codepage = CP_ACP)
string CharArrayToString(uchar &array[], int start = 0, int count = -1, uint codepage = CP_ACP)
int StringToShortArray(string text_string, ushort &array[], int start = 0, int count = -1)
string ShortArrayToString(ushort &array[], int start = 0, int count = -1)
int StringLen(string string_value)
int StringFind(string string_value, string match_substring, int start_pos = 0)
string StringSubstr(string string_value, int start_pos, int length = -1)
int StringReplace(string &str, string find, string replacement)
int StringTrimLeft(string &string_var)
int StringTrimRight(string &string_var)
bool StringToUpper(string &string_var)
bool StringToLower(string &string_var)
int StringSplit(string string_value, ushort separator, string &result[])
int StringCompare(string string1, string string2, bool case_sensitive = true)
bool StringAdd(string &string_var, string add_substring)
int StringConcatenate(string &string_var, ...)
ushort StringGetCharacter(string string_value, int pos)
bool StringSetCharacter(string &string_var, int pos, ushort character)
bool StringInit(string &string_var, int new_len = 0, ushort character = 0)
int StringFill(string &string_var, ushort character)
int StringBufferLen(string string_var)
bool StringReserve(string &string_var, uint new_capacity)

long MathAbs(long value) @MathAbs
double MathAbs(double value)
double MathArccos(double val)
double MathArcsin(double val)
double MathArctan(double value)
double MathArctan2(double y, double x)
double MathCeil(double val)
double MathCos(double value)
double MathCosh(double value)
double MathExp(double value)
double MathExpm1(double value)
double MathFloor(double val)
double MathLog(double val)
double MathLog10(double val)
double MathLog1p(double value)
long MathMax(long value1, long value2) @MathMax
double MathMax(double value1, double value2)
long MathMin(long value1, long value2) @MathMin
double MathMin(double value1, double value2)
double MathMod(double value, double value2)
double MathPow(double base, double exponent)
double MathRound(double value)
double MathSin(double value)
double MathSinh(double value)
double MathSqrt(double value)
double MathTan(double rad)
double MathTanh(double value)
int MathRand()
void MathSrand(int seed)
bool MathIsValidNumber(double number)
double fabs(double value) @MathAbs
double fmax(double a, double b) @MathMax
double fmin(double a, double b) @MathMin
double fmod(double a, double b) @MathMod
double pow(double base, double exponent) @MathPow
double sqrt(double value) @MathSqrt
double floor(double value) @MathFloor
double ceil(double value) @MathCeil
double round(double value) @MathRound
double log(double value) @MathLog
double log10(double value) @MathLog10
double exp(double value) @MathExp
double sin(double value) @MathSin
double cos(double value) @MathCos
double tan(double value) @MathTan
double asin(double value) @MathArcsin
double acos(double value) @MathArccos
double atan(double value) @MathArctan
double atan2(double y, double x) @MathArctan2
int rand() @MathRand
void srand(int seed) @MathSrand

int ArrayResize(void &array[], int new_size, int reserve_size = 0)
int ArraySize(void &array[])
int ArrayRange(void &array[], int rank_index)
bool ArraySetAsSeries(void &array[], bool flag)
bool ArrayGetAsSeries(void &array[])
bool ArrayIsSeries(void &array[])
bool ArrayIsDynamic(void &array[])
int ArrayInitialize(void &array[], any value)
void ArrayFill(void &array[], int start, int count, any value)
int ArrayCopy(void &dst_array[], void &src_array[], int dst_start = 0, int src_start = 0, int count = WHOLE_ARRAY)
void ArrayFree(void &array[])
int ArrayMaximum(void &array[], int start = 0, int count = WHOLE_ARRAY)
int ArrayMinimum(void &array[], int start = 0, int count = WHOLE_ARRAY)
bool ArraySort(void &array[])
int ArrayBsearch(void &array[], any value)
bool ArrayReverse(void &array[], int start = 0, int count = WHOLE_ARRAY)
bool ArrayInsert(void &dst_array[], void &src_array[], int dst_start, int src_start = 0, int count = WHOLE_ARRAY)
bool ArrayRemove(void &array[], int start, int count = WHOLE_ARRAY)
bool ArraySwap(void &array1[], void &array2[])
int ArrayCompare(void &array1[], void &array2[], int start1 = 0, int start2 = 0, int count = WHOLE_ARRAY)
void ArrayPrint(void &array[], uint digits = _Digits, string separator = NULL, ulong start = 0, ulong count = WHOLE_ARRAY, ulong flags = 0)

bool ObjectCreate(long chart_id, string name, ENUM_OBJECT type, int sub_window, datetime time1 = 0, double price1 = 0, datetime time2 = 0, double price2 = 0, datetime time3 = 0, double price3 = 0)
bool ObjectDelete(long chart_id, string name)
int ObjectsDeleteAll(long chart_id, int sub_window = -1, int type = -1)
int ObjectsDeleteAll(long chart_id, string prefix, int sub_window = -1, int type = -1) @ObjectsDeleteAllPrefix
int ObjectFind(long chart_id, string name)
bool ObjectSetInteger(long chart_id, string name, ENUM_OBJECT_PROPERTY_INTEGER prop_id, long prop_value)
bool ObjectSetInteger(long chart_id, string name, ENUM_OBJECT_PROPERTY_INTEGER prop_id, int prop_modifier, long prop_value) @ObjectSetIntegerMod
bool ObjectSetDouble(long chart_id, string name, ENUM_OBJECT_PROPERTY_DOUBLE prop_id, double prop_value)
bool ObjectSetDouble(long chart_id, string name, ENUM_OBJECT_PROPERTY_DOUBLE prop_id, int prop_modifier, double prop_value) @ObjectSetDoubleMod
bool ObjectSetString(long chart_id, string name, ENUM_OBJECT_PROPERTY_STRING prop_id, string prop_value)
bool ObjectSetString(long chart_id, string name, ENUM_OBJECT_PROPERTY_STRING prop_id, int prop_modifier, string prop_value) @ObjectSetStringMod
long ObjectGetInteger(long chart_id, string name, ENUM_OBJECT_PROPERTY_INTEGER prop_id, int prop_modifier = 0)
double ObjectGetDouble(long chart_id, string name, ENUM_OBJECT_PROPERTY_DOUBLE prop_id, int prop_modifier = 0)
string ObjectGetString(long chart_id, string name, ENUM_OBJECT_PROPERTY_STRING prop_id, int prop_modifier = 0)
bool ObjectMove(long chart_id, string name, int point_index, datetime time, double price)
int ObjectsTotal(long chart_id, int sub_window = -1, int type = -1)
string ObjectName(long chart_id, int pos, int sub_window = -1, int type = -1)
void ChartRedraw(long chart_id = 0)
long ChartID()
bool ChartSetInteger(long chart_id, ENUM_CHART_PROPERTY_INTEGER prop_id, long value)
bool ChartSetInteger(long chart_id, ENUM_CHART_PROPERTY_INTEGER prop_id, int sub_window, long value) @ChartSetIntegerSub
long ChartGetInteger(long chart_id, ENUM_CHART_PROPERTY_INTEGER prop_id, int sub_window = 0)
bool ChartSetDouble(long chart_id, ENUM_CHART_PROPERTY_DOUBLE prop_id, double value)
double ChartGetDouble(long chart_id, ENUM_CHART_PROPERTY_DOUBLE prop_id, int sub_window = 0)
bool ChartSetString(long chart_id, ENUM_CHART_PROPERTY_STRING prop_id, string str_value)
string ChartGetString(long chart_id, ENUM_CHART_PROPERTY_STRING prop_id)
string ChartSymbol(long chart_id = 0)
ENUM_TIMEFRAMES ChartPeriod(long chart_id = 0)
bool ChartSetSymbolPeriod(long chart_id, string symbol, ENUM_TIMEFRAMES period)
int ChartWindowFind()
bool ChartIndicatorAdd(long chart_id, int sub_window, int indicator_handle)

datetime GlobalVariableSet(string name, double value)
double GlobalVariableGet(string name)
bool GlobalVariableGet(string name, double &double_var) @GlobalVariableGetRef
bool GlobalVariableCheck(string name)
bool GlobalVariableDel(string name)
datetime GlobalVariableTime(string name)
int GlobalVariablesDeleteAll(string prefix_name = NULL, datetime limit_data = 0)
int GlobalVariablesTotal()
string GlobalVariableName(int index)
bool GlobalVariableTemp(string name)
bool GlobalVariableSetOnCondition(string name, double value, double check_value)
void GlobalVariablesFlush()

int FileOpen(string file_name, int open_flags, short delimiter = '\t', uint codepage = CP_ACP)
void FileClose(int file_handle)
uint FileWrite(int file_handle, ...)
uint FileWriteString(int file_handle, string text_string, int length = -1)
string FileReadString(int file_handle, int length = -1)
double FileReadNumber(int file_handle)
bool FileReadBool(int file_handle)
datetime FileReadDatetime(int file_handle)
bool FileIsEnding(int file_handle)
bool FileIsLineEnding(int file_handle)
bool FileIsExist(string file_name, int common_flag = 0)
bool FileDelete(string file_name, int common_flag = 0)
ulong FileSize(int file_handle)
ulong FileTell(int file_handle)
bool FileSeek(int file_handle, long offset, ENUM_FILE_POSITION origin)
void FileFlush(int file_handle)
`;
