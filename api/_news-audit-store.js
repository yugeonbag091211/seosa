'use strict';
/*
 * NEWS AUDIT STORE — 여러 날의 dry-run 집계만 JSONL 로 보관한다.
 * 운영 DB/스키마와 무관하며 기사 제목·URL·본문은 저장하지 않는다.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = process.env.NEWS_AUDIT_FILE
  || path.join(__dirname, '..', '.news-audit', 'runs.jsonl');
const VERDICTS = ['BUY', 'WAIT', 'WATCH', 'NO_DECISION'];
const SCHEMA_VERSION = 2;

function number(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function pct(a, b) { return b ? Math.round(a / b * 1000) / 10 : 0; }
function ratioObject(value) {
  const v = value || {};
  return { A: number(v.A), B: number(v.B), C: number(v.C) };
}
function decisionsObject(value) {
  const v = value || {};
  return VERDICTS.reduce((out, key) => { out[key] = number(v[key]); return out; }, {});
}

function makeRunId(record) {
  const basis = {
    timestamp: record.timestamp,
    mode: record.mode || '',
    totalArticles: record.totalArticles,
    validArticles: record.validArticles,
    unknownRatio: record.unknownRatio,
    mappedNodeRatio: record.mappedNodeRatio,
    classifiedEventRatio: record.classifiedEventRatio,
    duplicateRatio: record.duplicateRatio,
    sourceTierDistribution: record.sourceTierDistribution,
    actionableSignalCount: record.actionableSignalCount,
    decisions: record.decisions
  };
  return crypto.createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 24);
}

/* 새 flat schema와 Claude가 먼저 만든 nested metrics schema를 모두 읽는다. */
function normalizeRecord(input) {
  if (!input || typeof input !== 'object') return null;
  const m = input.metrics || input;
  const timestamp = input.timestamp || input.ranAt || m.timestamp || m.ranAt;
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;

  const eventCount = number(m.eventCount != null ? m.eventCount : m.events);
  const unknownEventCount = number(m.unknownEventCount != null ? m.unknownEventCount : m.unknownEvents);
  const mappedNodeArticleCount = number(m.mappedNodeArticleCount != null ? m.mappedNodeArticleCount : m.mappedNodeArticles);
  const classifiedEventCount = number(m.classifiedEventCount != null
    ? m.classifiedEventCount
    : Math.max(0, eventCount - unknownEventCount));
  const sourceTierCounts = ratioObject(m.sourceTierCounts || m.tierCounts);
  const sourceTotal = sourceTierCounts.A + sourceTierCounts.B + sourceTierCounts.C;
  const validArticles = number(m.validArticles);
  const duplicateCount = number(m.duplicateCount != null
    ? m.duplicateCount
    : Math.round(number(m.duplicateRatio) / 100 * validArticles));

  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId: String(input.runId || m.runId || ''),
    timestamp: new Date(timestamp).toISOString(),
    mode: String(input.mode || m.mode || ''),
    totalArticles: number(m.totalArticles),
    validArticles,
    unknownRatio: number(m.unknownRatio != null ? m.unknownRatio : pct(unknownEventCount, eventCount)),
    mappedNodeRatio: number(m.mappedNodeRatio != null ? m.mappedNodeRatio : pct(mappedNodeArticleCount, validArticles)),
    classifiedEventRatio: number(m.classifiedEventRatio != null
      ? m.classifiedEventRatio
      : pct(classifiedEventCount, eventCount)),
    duplicateRatio: number(m.duplicateRatio),
    sourceTierDistribution: ratioObject(m.sourceTierDistribution || {
      A: pct(sourceTierCounts.A, sourceTotal),
      B: pct(sourceTierCounts.B, sourceTotal),
      C: pct(sourceTierCounts.C, sourceTotal)
    }),
    actionableSignalCount: number(m.actionableSignalCount != null ? m.actionableSignalCount : m.usableSignals),
    decisions: decisionsObject(m.decisions || m.decisionsByVerdict),

    /* 누적 비율을 정확히 가중하기 위한 분자/분모. */
    eventCount,
    unknownEventCount,
    mappedNodeArticleCount,
    classifiedEventCount,
    duplicateCount,
    sourceTierCounts,

    /* V2 관측성. 기사 제목/URL/본문은 절대 들어오지 않는다. */
    sourceHealth: Array.isArray(m.sourceHealth) ? m.sourceHealth.map(s => ({
      sourceId: String(s.sourceId || ''), status: String(s.status || 'UNKNOWN'),
      lastAttemptAt: s.lastAttemptAt || null, lastSuccessAt: s.lastSuccessAt || null,
      consecutiveFailures: number(s.consecutiveFailures), http403Count: number(s.http403Count),
      http429Count: number(s.http429Count), timeoutCount: number(s.timeoutCount),
      averageLatency: s.averageLatency == null ? null : number(s.averageLatency),
      backoffUntil: s.backoffUntil || null
    })) : [],
    lifecycleCounts: Object.assign({ ACTIVE: 0, WEAKENING: 0, RESOLVED: 0, EXPIRED: 0, UNCERTAIN: 0 }, m.lifecycleCounts || {
      ACTIVE: m.activeEvents, WEAKENING: m.weakeningEvents,
      RESOLVED: m.resolvedEvents, EXPIRED: m.expiredEvents, UNCERTAIN: m.uncertainEvents
    }),
    contradictionCount: number(m.contradictionCount),
    shadowPredictions: number(m.shadowPredictions),
    evaluablePredictions: number(m.evaluablePredictions),
    evaluated1d: number(m.evaluated1d),
    evaluated3d: number(m.evaluated3d),
    evaluated7d: number(m.evaluated7d),
    calibrationStatus: String(m.calibrationStatus || 'NOT_ENOUGH_DATA_TO_CALIBRATE'),
    categoryDiagnostics: Array.isArray(m.categoryDiagnostics) ? m.categoryDiagnostics.map(c => ({
      category: String(c.category || ''), coverage: String(c.coverage || 'UNSUPPORTED'),
      unknownRatio: number(c.unknownRatio), eventCount: number(c.eventCount), actionable: number(c.actionable)
    })) : []
  };
  record.activeEvents = number(record.lifecycleCounts.ACTIVE);
  record.weakeningEvents = number(record.lifecycleCounts.WEAKENING);
  record.resolvedEvents = number(record.lifecycleCounts.RESOLVED);
  record.expiredEvents = number(record.lifecycleCounts.EXPIRED);
  record.uncertainEvents = number(record.lifecycleCounts.UNCERTAIN);
  if (!record.runId) record.runId = makeRunId(record);
  return record;
}

function ensureDir(file) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch (e) { /* fail-open */ }
}

/** 같은 runId(또는 같은 내용의 자동 fingerprint)는 두 번 쓰지 않는다. */
function append(input, file) {
  const f = file || DEFAULT_FILE;
  let lockFd = null;
  const lock = f + '.lock';
  try {
    const record = normalizeRecord(input);
    if (!record) return { ok: false, saved: false, duplicate: false, file: f, reason: 'invalid-record' };
    ensureDir(f);
    lockFd = fs.openSync(lock, 'wx');
    const duplicate = load(f).some(row => row.runId === record.runId);
    if (duplicate) return { ok: true, saved: false, duplicate: true, file: f, reason: 'duplicate-run' };
    const fd = fs.openSync(f, 'a');
    try { fs.writeSync(fd, JSON.stringify(record) + '\n', null, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return { ok: true, saved: true, duplicate: false, file: f, reason: '', runId: record.runId };
  } catch (e) {
    return { ok: false, saved: false, duplicate: false, file: f, reason: String(e && e.message || e) };
  } finally {
    if (lockFd != null) {
      try { fs.closeSync(lockFd); } catch (e) {}
      try { fs.unlinkSync(lock); } catch (e) {}
    }
  }
}

/** 깨진 줄은 건너뛰고, 과거 schema는 읽을 때 새 schema로 정규화한다. */
function load(file) {
  const f = file || DEFAULT_FILE;
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = normalizeRecord(JSON.parse(line));
      if (record) out.push(record);
    } catch (e) { /* 한 줄 때문에 전체 기록을 버리지 않는다 */ }
  }
  return out;
}

function summarize(runs) {
  const rows = (runs || []).map(normalizeRecord).filter(Boolean);
  const totals = {
    totalArticles: 0, validArticles: 0, events: 0, unknownEvents: 0,
    mappedNodeArticles: 0, classifiedEvents: 0, duplicates: 0,
    actionableSignals: 0, tierA: 0, tierB: 0, tierC: 0,
    contradictions: 0, shadowPredictions: 0, evaluablePredictions: 0,
    evaluated1d: 0, evaluated3d: 0, evaluated7d: 0,
    decisions: decisionsObject()
  };

  for (const r of rows) {
    totals.totalArticles += r.totalArticles;
    totals.validArticles += r.validArticles;
    totals.events += r.eventCount;
    totals.unknownEvents += r.unknownEventCount;
    totals.mappedNodeArticles += r.mappedNodeArticleCount;
    totals.classifiedEvents += r.classifiedEventCount;
    totals.duplicates += r.duplicateCount;
    totals.actionableSignals += r.actionableSignalCount;
    totals.contradictions += r.contradictionCount;
    totals.shadowPredictions += r.shadowPredictions;
    totals.evaluablePredictions += r.evaluablePredictions;
    totals.evaluated1d += r.evaluated1d;
    totals.evaluated3d += r.evaluated3d;
    totals.evaluated7d += r.evaluated7d;
    totals.tierA += r.sourceTierCounts.A;
    totals.tierB += r.sourceTierCounts.B;
    totals.tierC += r.sourceTierCounts.C;
    VERDICTS.forEach(v => { totals.decisions[v] += r.decisions[v]; });
  }

  const tierTotal = totals.tierA + totals.tierB + totals.tierC;
  return {
    runs: rows.length,
    firstRun: rows.length ? rows[0].timestamp : null,
    lastRun: rows.length ? rows[rows.length - 1].timestamp : null,
    distinctDays: new Set(rows.map(r => r.timestamp.slice(0, 10))).size,
    totals,
    ratios: {
      validRatio: pct(totals.validArticles, totals.totalArticles),
      unknownRatio: pct(totals.unknownEvents, totals.events),
      mappedNodeRatio: pct(totals.mappedNodeArticles, totals.validArticles),
      classifiedEventRatio: pct(totals.classifiedEvents, totals.events),
      duplicateRatio: pct(totals.duplicates, totals.validArticles),
      tierAShare: pct(totals.tierA, tierTotal),
      tierBShare: pct(totals.tierB, tierTotal),
      tierCShare: pct(totals.tierC, tierTotal)
    },
    perRun: rows.map(r => ({
      runId: r.runId, timestamp: r.timestamp, mode: r.mode,
      total: r.totalArticles, valid: r.validArticles,
      unknownRatio: r.unknownRatio, actionableSignalCount: r.actionableSignalCount,
      decisions: r.decisions
    }))
  };
}

module.exports = {
  append, load, summarize, normalizeRecord, makeRunId, DEFAULT_FILE, VERDICTS, SCHEMA_VERSION
};
