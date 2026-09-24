import { describe, expect, it } from 'vitest';
import { compileMql5 } from '../compiler/index.js';
import { Expert } from '../runtime/expert.js';
import { SimHost, makeBars } from './simHost.js';

/** Compiles a program around `body` (placed in OnInit) and returns what it printed. */
async function run(globals: string, body: string, host = new SimHost()): Promise<string[]> {
  const source = `${globals}\nint OnInit() {\n${body}\nreturn(INIT_SUCCEEDED);\n}\nvoid OnTick() {}\n`;
  const compiled = compileMql5(source, 'Test.mq5');
  if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
  const expert = new Expert(compiled, host);
  const ok = await expert.start();
  if (!ok) throw new Error(expert.error ?? 'did not start');
  await expert.stop();
  return host.logs.filter((l) => l.level === 'info' && !/started on|removed/.test(l.message)).map((l) => l.message);
}

describe('integer and floating arithmetic', () => {
  it('truncates integer division and keeps doubles exact', async () => {
    const out = await run('', `
      int a = 7, b = 2;
      double c = 7;
      Print(a / b, " ", c / b, " ", -7 / 2, " ", 7 % 3, " ", (double)a / b);
    `);
    expect(out).toEqual(['3 3.5 -3 1 3.5']);
  });

  it('wraps int arithmetic at 32 bits and converts on assignment', async () => {
    const out = await run('', `
      int big = 2147483647;
      big = big + 1;
      int t = 2.9;
      int n = -2.9;
      long l = 3000000000;
      Print(big, " ", t, " ", n, " ", l * 2);
    `);
    expect(out).toEqual(['-2147483648 2 -2 6000000000']);
  });

  it('stops the expert on an integer division by zero, with the line', async () => {
    const host = new SimHost();
    const compiled = compileMql5('int OnInit(){ int z = 0; int x = 5 / z; Print(x); return 0; }\nvoid OnTick(){}', 'Z.mq5');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const expert = new Expert(compiled, host);
    expect(await expert.start()).toBe(false);
    expect(expert.error).toMatch(/zero divide/);
    expect(expert.error).toMatch(/line 1/);
  });
});

describe('strings and formatting', () => {
  it('concatenates numbers the way MQL5 prints them', async () => {
    const out = await run('', `
      double d = 2;
      string s = "d=" + d + " i=" + 5 + " b=" + true;
      Print(s);
      Print(DoubleToString(3.14159, 2), " ", IntegerToString(7, 3, '0'));
    `);
    expect(out).toEqual(['d=2.0 i=5 b=true', '3.14 007']);
  });

  it('formats like PrintFormat, including I64 and widths', async () => {
    const out = await run('', `
      long n = 1234567890123;
      PrintFormat("%-10s|%6I64d|%.2f%%|%05d|%x", "gold", n, 12.345, 42, 255);
    `);
    expect(out).toEqual(['gold      |1234567890123|12.35%|00042|ff']);
  });

  it('rounds NormalizeDouble half away from zero at the decimal', async () => {
    const out = await run('', `Print(NormalizeDouble(1.005, 2), " ", NormalizeDouble(-2.675, 2), " ", NormalizeDouble(3300.555, 2));`);
    expect(out).toEqual(['1.01 -2.68 3300.56']);
  });

  it('handles the string library with references', async () => {
    const out = await run('', `
      string s = "  a,b,,c  ";
      StringTrimLeft(s); StringTrimRight(s);
      string parts[];
      int n = StringSplit(s, ',', parts);
      string r = "xx-yy";
      int count = StringReplace(r, "-", "+");
      Print(n, " ", parts[3], " ", r, " ", count, " ", StringSubstr("gold", 1, 2), " ", StringFind("gold", "ld"));
    `);
    expect(out).toEqual(['4 c xx+yy 1 ol 2']);
  });
});

describe('structs, arrays and references', () => {
  it('copies structs on assignment and passes them by reference when asked', async () => {
    const out = await run(`
      struct Pt { double x; double y; };
      void Move(Pt &p, double dx) { p.x += dx; }
      Pt Make(double x) { Pt p; p.x = x; p.y = -x; return p; }
    `, `
      Pt a; a.x = 1; a.y = 2;
      Pt b = a;
      b.x = 10;
      Move(a, 5);
      Pt c = Make(3);
      Print(a.x, " ", b.x, " ", c.y);
    `);
    expect(out).toEqual(['6.0 10.0 -3.0']);
  });

  it('passes scalars by reference', async () => {
    const out = await run(`
      void Split(double v, double &whole, double &frac) { whole = MathFloor(v); frac = v - whole; }
      void Bump(int &values[], int i) { values[i]++; }
    `, `
      double w = 0, f = 0;
      Split(3.25, w, f);
      int arr[3] = {1, 2, 3};
      Bump(arr, 1);
      Print(w, " ", f, " ", arr[1]);
    `);
    expect(out).toEqual(['3.0 0.25 3']);
  });

  it('indexes series arrays newest-first', async () => {
    const out = await run('', `
      double a[];
      ArrayResize(a, 3);
      a[0] = 1; a[1] = 2; a[2] = 3;
      ArraySetAsSeries(a, true);
      Print(a[0], " ", ArraySize(a), " ", ArrayMaximum(a));
    `);
    // ArrayMaximum reports the index in series order, where 0 is the newest.
    expect(out).toEqual(['3.0 3 0']);
  });

  it('stops on an out-of-range index instead of reading undefined', async () => {
    await expect(run('', 'double a[2]; Print(a[5]);')).rejects.toThrow(/array out of range/);
  });

  it('supports two-dimensional arrays', async () => {
    const out = await run('', `
      double grid[][2];
      ArrayResize(grid, 3);
      grid[2][1] = 7;
      Print(grid[2][1], " ", ArrayRange(grid, 0), " ", ArrayRange(grid, 1), " ", ArraySize(grid));
    `);
    expect(out).toEqual(['7.0 3 2 6']);
  });
});

describe('classes', () => {
  it('dispatches virtual methods and runs constructors in order', async () => {
    const out = await run(`
      class Shape { protected: string m_name; public: Shape(string n) : m_name(n) {} virtual double Area() { return 0; } string Name() { return m_name; } };
      class Square : public Shape { double m_side; public: Square(double s) : Shape("square"), m_side(s) {} virtual double Area() { return m_side * m_side; } };
      class Counter { public: static int count; Counter() { count++; } };
      int Counter::count = 0;
    `, `
      Shape *s = new Square(3);
      Counter a; Counter b;
      Print(s.Name(), " ", s.Area(), " ", Counter::count, " ", CheckPointer(s) == POINTER_DYNAMIC);
      delete s;
      Print(CheckPointer(s) == POINTER_INVALID);
    `);
    expect(out).toEqual(['square 9.0 2 true', 'true']);
  });

  it('reads enums, their labels and EnumToString', async () => {
    const out = await run(`
      enum Mode { MODE_A = 3, MODE_B, MODE_C = 10 };
    `, `
      Mode m = MODE_B;
      Print(m, " ", EnumToString(m), " ", EnumToString(PERIOD_H4), " ", MODE_C);
      switch(m) { case MODE_A: Print("a"); break; case MODE_B: Print("b"); default: Print("fell"); }
    `);
    expect(out).toEqual(['4 MODE_B PERIOD_H4 10', 'b', 'fell']);
  });
});

describe('inputs', () => {
  it('describes inputs with their labels, groups and enum options', () => {
    const compiled = compileMql5(`
      enum ERisk { RISK_LOW, // Low risk
                   RISK_HIGH // High risk
                 };
      input group "Money"
      input double InpLot = 0.05;      // Lot size
      input ERisk  InpRisk = RISK_HIGH; // Risk profile
      input ENUM_TIMEFRAMES InpTF = PERIOD_M15; // Signal timeframe
      sinput string InpNote = "hi";
      void OnTick() {}
    `, 'In.mq5');
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const [lot, risk, tf, note] = compiled.inputs;
    expect(lot).toMatchObject({ name: 'InpLot', label: 'Lot size', group: 'Money', kind: 'double', defaultValue: 0.05 });
    expect(risk).toMatchObject({ kind: 'enum', defaultValue: 1 });
    expect(risk?.options?.map((o) => o.label)).toEqual(['Low risk', 'High risk']);
    expect(tf).toMatchObject({ kind: 'timeframe', defaultValue: 15 });
    expect(note).toMatchObject({ kind: 'string', static: true, defaultValue: 'hi' });
  });

  it('applies values from the settings form over the defaults', async () => {
    const host = new SimHost();
    const compiled = compileMql5('input int InpN = 1; input bool InpOn = false; int OnInit(){ Print(InpN, " ", InpOn); return 0; } void OnTick(){}', 'I.mq5');
    if (!compiled.ok) throw new Error('compile');
    const expert = new Expert(compiled, host);
    await expert.start({ InpN: '42', InpOn: 'true' });
    expect(host.logs.map((l) => l.message)).toContain('42 true');
  });
});

describe('what the compiler refuses', () => {
  it('explains MQL4 code', () => {
    const r = compileMql5('int start(){ OrderSelect(0, SELECT_BY_POS, MODE_TRADES); return 0; }', 'Old.mq4');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/MQL4/);
  });

  it('explains an indicator', () => {
    const r = compileMql5('#property indicator_chart_window\nint OnCalculate(const int a, const int b, const double &c[]) { return a; }', 'Ind.mq5');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/indicator/);
  });

  it('explains DLL imports', () => {
    const r = compileMql5('#import "user32.dll"\nint MessageBoxW(int a);\n#import\nvoid OnTick(){}', 'Dll.mq5');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/DLL/);
  });

  it('names an unknown function and where it is', () => {
    const r = compileMql5('void OnTick(){\n  DoMagic();\n}', 'U.mq5');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ line: 2 });
    expect(r.diagnostics[0]?.message).toMatch(/DoMagic/);
  });

  it('asks for a missing header', () => {
    const r = compileMql5('#include <MyLib\\Signals.mqh>\nvoid OnTick(){}', 'H.mq5');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toMatch(/Upload that \.mqh/);
  });

  it('compiles against an uploaded header', () => {
    const r = compileMql5('#include "Helpers.mqh"\nvoid OnTick(){ Print(Twice(2)); }', 'H.mq5', {
      files: [{ name: 'MQL5/Include/Helpers.mqh', source: 'int Twice(int x) { return x * 2; }' }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('market data and trading', () => {
  it('reads bars, indicators and places orders through CTrade', async () => {
    const start = 1_758_700_000 - (1_758_700_000 % 60);
    const host = new SimHost('XAUUSD', 1, start, 3300);
    host.seedBars(1, makeBars(200, start));
    const compiled = compileMql5(`
      #include <Trade\\Trade.mqh>
      CTrade trade;
      int h;
      int OnInit() { h = iMA(_Symbol, PERIOD_CURRENT, 10, 0, MODE_SMA, PRICE_CLOSE); trade.SetExpertMagicNumber(99); return h == INVALID_HANDLE; }
      void OnTick() {
        double ma[]; ArraySetAsSeries(ma, true);
        if (CopyBuffer(h, 0, 0, 3, ma) != 3) return;
        MqlRates r[]; ArraySetAsSeries(r, true);
        if (CopyRates(_Symbol, PERIOD_CURRENT, 0, 2, r) != 2) return;
        if (PositionsTotal() == 0 && trade.Buy(0.05, _Symbol, 0, 0, 0, "t"))
          PrintFormat("bought %.2f at %.2f ma=%.2f", trade.ResultVolume(), trade.ResultPrice(), ma[0]);
      }
    `, 'Ma.mq5');
    if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => d.message).join('\n'));
    expect(compiled.handlers.find((h) => h.name === 'OnTick')?.async).toBe(true);
    expect(compiled.handlers.find((h) => h.name === 'OnInit')?.async).toBe(false);
    const expert = new Expert(compiled, host);
    expect(await expert.start()).toBe(true);
    host.quoteAt(3301, start + 10);
    expert.tick();
    await expert.idle();
    expect(host.requests).toHaveLength(1);
    expect(host.requests[0]).toMatchObject({ action: 1, type: 0, volume: 0.05, magic: 99, comment: 't' });
    expect(host.positions()).toHaveLength(1);
    expect(host.logs.some((l) => /bought 0.05 at 3301.20/.test(l.message))).toBe(true);
  });

  it('refuses to trade while AutoTrading is off, as the terminal does', async () => {
    const host = new SimHost();
    host.allowTrading = false;
    const compiled = compileMql5(`
      #include <Trade\\Trade.mqh>
      CTrade trade;
      int OnInit(){ bool ok = trade.Buy(0.01); Print(ok, " ", trade.ResultRetcode()); return 0; }
      void OnTick(){}
    `, 'Off.mq5');
    if (!compiled.ok) throw new Error('compile');
    const expert = new Expert(compiled, host);
    await expert.start();
    expect(host.requests).toHaveLength(0);
    expect(host.logs.some((l) => l.message === 'false 10027')).toBe(true);
  });
});
