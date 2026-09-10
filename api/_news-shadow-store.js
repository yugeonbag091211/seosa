'use strict';
/*
 * NEWS SHADOW STORE — 운영 UI/DB와 분리된 예측·사후평가 JSONL 저장소.
 * 기사 원문/제목/URL은 저장하지 않고 ingestion id와 event id만 보관한다.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;
const DEFAULT_PREDICTIONS_FILE = process.env.NEWS_SHADOW_FILE
  || path.join(__dirname, '..', '.news-audit', 'shadow-predictions.jsonl');
const DEFAULT_EVALUATIONS_FILE = process.env.NEWS_SHADOW_EVALUATIONS_FILE
  || path.join(__dirname, '..', '.news-audit', 'shadow-evaluations.jsonl');
const DECISIONS = ['BUY', 'WAIT', 'WATCH', 'NO_DECISION'];
const CONFIDENCE_LEVELS = ['LOW', 'MEDIUM', 'HIGH'];
const HORIZONS = [1, 3, 7];
const MAX_OBSERVATION_LAG_MS = 36 * 60 * 60 * 1000;

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}
function finite(v) { return v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null); }
function iso(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function ids(values) {
  return [...new Set((values || []).map(String).filter(Boolean))].sort();
}
function confidenceLevel(score) {
  return score >= 75 ? 'HIGH' : score >= 50 ? 'MEDIUM' : 'LOW';
}
function priceSnapshot(value, currentPrice) {
  const s = value || {};
  return {
    currentPrice: finite(currentPrice != null ? currentPrice : s.currentPrice),
    '7dChange': finite(s['7dChange']),
    '30dChange': finite(s['30dChange']),
    '30dAverage': finite(s['30dAverage']),
    '90dPercentile': finite(s['90dPercentile']),
    volatility: finite(s.volatility),
    observationCount: finite(s.observationCount) || 0
  };
}

function normalizePrediction(input) {
  const p = input || {};
  const createdAt = iso(p.createdAt);
  if (!createdAt) return null;
  const decision = DECISIONS.includes(p.decision) ? p.decision : 'NO_DECISION';
  const confidence = Math.max(0, Math.min(100, finite(p.confidence) || 0));
  const eventIds = ids(p.eventIds);
  const evidenceIds = ids(p.evidenceIds);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    predictionId: String(p.predictionId || ''),
    createdAt,
    product: String(p.product || ''),
    category: String(p.category || ''),
    decision,
    newsPressureScore: finite(p.newsPressureScore),
    priceOpportunityScore: finite(p.priceOpportunityScore),
    confidence,
    confidenceLevel: CONFIDENCE_LEVELS.includes(p.confidenceLevel)
      ? p.confidenceLevel : confidenceLevel(confidence),
    confidenceMeaning: 'EVIDENCE_STRENGTH_NOT_PROBABILITY',
    evidenceIds,
    eventIds,
    currentPrice: finite(p.currentPrice),
    priceStatsSnapshot: priceSnapshot(p.priceStatsSnapshot, p.currentPrice),
    coverageStatus: String(p.coverageStatus || 'UNSUPPORTED')
  };
  if (!record.predictionId) {
    record.predictionId = hash(JSON.stringify({
      createdAt, product: record.product, category: record.category,
      decision, eventIds, evidenceIds
    }));
  }
  return record;
}

function createPrediction(input) {
  const o = input || {};
  const adv = o.advice || {};
  return normalizePrediction({
    createdAt: o.createdAt || new Date().toISOString(),
    product: o.product || '', category: o.category || adv.categoryId || '',
    decision: adv.advice || o.decision,
    newsPressureScore: adv.news ? adv.news.score : o.newsPressureScore,
    priceOpportunityScore: adv.price ? adv.price.score : o.priceOpportunityScore,
    confidence: adv.confidence != null ? adv.confidence : o.confidence,
    confidenceLevel: adv.confidenceLevel || o.confidenceLevel,
    evidenceIds: adv.evidence ? adv.evidence.map(e => e.id) : o.evidenceIds,
    eventIds: adv.news ? adv.news.used.map(e => e.eventId) : o.eventIds,
    currentPrice: o.currentPrice,
    priceStatsSnapshot: o.priceStatsSnapshot || (adv.priceConfirmation && adv.priceConfirmation.snapshot),
    coverageStatus: adv.coverage || o.coverageStatus
  });
}

function load(file, normalize) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = normalize(JSON.parse(line));
      if (row) out.push(row);
    } catch (e) { /* corrupt line tolerance */ }
  }
  return out;
}

function appendUnique(record, file, key, normalize) {
  let lockFd = null;
  const lock = file + '.lock';
  try {
    const row = normalize(record);
    if (!row) return { ok: false, saved: false, duplicate: false, reason: 'invalid-record', file };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lockFd = fs.openSync(lock, 'wx');
    if (load(file, normalize).some(x => x[key] === row[key])) {
      return { ok: true, saved: false, duplicate: true, reason: 'duplicate-record', file, [key]: row[key] };
    }
    const fd = fs.openSync(file, 'a');
    try { fs.writeSync(fd, JSON.stringify(row) + '\n', null, 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return { ok: true, saved: true, duplicate: false, reason: '', file, [key]: row[key] };
  } catch (e) {
    return { ok: false, saved: false, duplicate: false, reason: String(e && e.message || e), file };
  } finally {
    if (lockFd != null) {
      try { fs.closeSync(lockFd); } catch (e) {}
      try { fs.unlinkSync(lock); } catch (e) {}
    }
  }
}

function appendPrediction(input, file) {
  return appendUnique(input, file || DEFAULT_PREDICTIONS_FILE, 'predictionId', normalizePrediction);
}
function loadPredictions(file) {
  return load(file || DEFAULT_PREDICTIONS_FILE, normalizePrediction);
}

function observationRows(values) {
  return (values || []).map(o => ({ at: iso(o.at || o.timestamp), price: finite(o.price) }))
    .filter(o => o.at && o.price > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
function observationAt(rows, targetMs) {
  return rows.find(o => Date.parse(o.at) >= targetMs && Date.parse(o.at) <= targetMs + MAX_OBSERVATION_LAG_MS) || null;
}

function evaluatePrediction(prediction, observations, asOf) {
  const p = normalizePrediction(prediction);
  const end = Date.parse(iso(asOf || new Date()) || '');
  if (!p || !Number.isFinite(end) || !(p.currentPrice > 0)) return null;
  const created = Date.parse(p.createdAt);
  const rows = observationRows(observations);
  const expectedDirection = p.newsPressureScore > 0 ? 1 : p.newsPressureScore < 0 ? -1 : 0;
  const horizons = {};
  for (const day of HORIZONS) {
    const target = created + day * 86400000;
    if (target > end) { horizons[`${day}d`] = null; continue; }
    const obs = observationAt(rows, target);
    if (!obs || Date.parse(obs.at) > end) { horizons[`${day}d`] = null; continue; }
    const changePct = Math.round((obs.price / p.currentPrice - 1) * 10000) / 100;
    const aligned = expectedDirection === 0 ? null : Math.sign(changePct) === expectedDirection;
    const timing = p.decision === 'BUY' ? changePct > 0
      : p.decision === 'WAIT' ? changePct < 0 : null;
    const utility = p.decision === 'BUY' ? changePct
      : p.decision === 'WAIT' ? -changePct : null;
    horizons[`${day}d`] = {
      observedAt: obs.at, price: obs.price, changePct,
      directionAccuracy: aligned, priceTimingQuality: timing,
      decisionUtility: utility,
      confidenceCalibration: aligned == null ? null : { level: p.confidenceLevel, aligned }
    };
  }
  const evaluation = {
    schemaVersion: SCHEMA_VERSION,
    evaluationId: hash(`${p.predictionId}|${iso(asOf || new Date())}`),
    predictionId: p.predictionId,
    evaluatedAt: iso(asOf || new Date()),
    category: p.category,
    decision: p.decision,
    confidenceLevel: p.confidenceLevel,
    horizons,
    priceChange1d: horizons['1d'] ? horizons['1d'].changePct : null,
    priceChange3d: horizons['3d'] ? horizons['3d'].changePct : null,
    priceChange7d: horizons['7d'] ? horizons['7d'].changePct : null,
    metrics: {
      priceTimingQuality: Object.fromEntries(HORIZONS.map(d => [`${d}d`, horizons[`${d}d`] ? horizons[`${d}d`].priceTimingQuality : null])),
      directionAccuracy: Object.fromEntries(HORIZONS.map(d => [`${d}d`, horizons[`${d}d`] ? horizons[`${d}d`].directionAccuracy : null])),
      confidenceCalibration: Object.fromEntries(HORIZONS.map(d => [`${d}d`, horizons[`${d}d`] ? horizons[`${d}d`].confidenceCalibration : null])),
      decisionUtility: Object.fromEntries(HORIZONS.map(d => [`${d}d`, horizons[`${d}d`] ? horizons[`${d}d`].decisionUtility : null]))
    },
    evaluable: HORIZONS.some(d => horizons[`${d}d`] != null)
  };
  return evaluation;
}

function normalizeEvaluation(input) {
  if (!input || !input.predictionId || !iso(input.evaluatedAt)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    evaluationId: String(input.evaluationId || hash(`${input.predictionId}|${iso(input.evaluatedAt)}`)),
    predictionId: String(input.predictionId), evaluatedAt: iso(input.evaluatedAt),
    category: String(input.category || ''), decision: DECISIONS.includes(input.decision) ? input.decision : 'NO_DECISION',
    confidenceLevel: CONFIDENCE_LEVELS.includes(input.confidenceLevel) ? input.confidenceLevel : 'LOW',
    horizons: input.horizons || {},
    priceChange1d: finite(input.priceChange1d), priceChange3d: finite(input.priceChange3d), priceChange7d: finite(input.priceChange7d),
    metrics: input.metrics || {}, evaluable: Boolean(input.evaluable)
  };
}
function appendEvaluation(input, file) {
  return appendUnique(input, file || DEFAULT_EVALUATIONS_FILE, 'evaluationId', normalizeEvaluation);
}
function loadEvaluations(file) {
  return load(file || DEFAULT_EVALUATIONS_FILE, normalizeEvaluation);
}

function calibration(evaluations, minSamples) {
  const minimum = Number.isFinite(Number(minSamples)) ? Number(minSamples) : 30;
  const groups = { LOW: [], MEDIUM: [], HIGH: [] };
  for (const ev of evaluations || []) {
    const level = CONFIDENCE_LEVELS.includes(ev.confidenceLevel) ? ev.confidenceLevel : 'LOW';
    for (const day of HORIZONS) {
      const row = ev.horizons && ev.horizons[`${day}d`];
      if (row && typeof row.directionAccuracy === 'boolean') groups[level].push(row.directionAccuracy);
    }
  }
  const sampleCounts = Object.fromEntries(CONFIDENCE_LEVELS.map(k => [k, groups[k].length]));
  if (CONFIDENCE_LEVELS.some(k => groups[k].length < minimum)) {
    return { status: 'NOT_ENOUGH_DATA_TO_CALIBRATE', minimumSamplesPerLevel: minimum, sampleCounts };
  }
  const accuracy = Object.fromEntries(CONFIDENCE_LEVELS.map(k => [k,
    Math.round(groups[k].filter(Boolean).length / groups[k].length * 1000) / 10]));
  return { status: 'CALIBRATED', minimumSamplesPerLevel: minimum, sampleCounts, directionAccuracyByConfidenceLevel: accuracy };
}

module.exports = {
  SCHEMA_VERSION, DEFAULT_PREDICTIONS_FILE, DEFAULT_EVALUATIONS_FILE,
  DECISIONS, CONFIDENCE_LEVELS, HORIZONS, MAX_OBSERVATION_LAG_MS,
  normalizePrediction, createPrediction, appendPrediction, loadPredictions,
  evaluatePrediction, normalizeEvaluation, appendEvaluation, loadEvaluations,
  calibration, priceSnapshot
};
