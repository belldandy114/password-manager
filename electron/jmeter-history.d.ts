/** 声明文件：让渲染层单测可以 import electron/jmeter-history.js */

export interface JmeterHistoryRecord {
  id: string;
  at: string;
  jmx: string;
  jmxName: string;
  mode: string;
  threads: number;
  loops: number;
  ok: boolean;
  code: number | null;
  samples: number;
  errors: number;
  errorPct: number;
  avg: number;
  max: number;
  tps: number;
  jtlPath: string;
  reportDir: string;
  logPath: string;
}

export declare const MAX_RECORDS: number;
export declare function pushRecord(list: JmeterHistoryRecord[], rec: JmeterHistoryRecord, max?: number): JmeterHistoryRecord[];
export declare function recordFromRun(run: unknown, extra?: { jmxPath?: string; mode?: string; threads?: number; loops?: number }): JmeterHistoryRecord;
export declare function historyFile(dataDir: string): string;
export declare function loadHistory(dataDir: string): JmeterHistoryRecord[];
export declare function saveHistory(dataDir: string, list: JmeterHistoryRecord[]): boolean;
