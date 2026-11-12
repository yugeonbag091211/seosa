'use strict';
// Promptfoo test cases generated from the FROZEN question file (one test per
// question; multi-turn questions are run turn-by-turn by the provider with
// the server state carried, exactly like the web client).
const path = require('node:path');
const SET_FILES = { main: 'questions-v34', holdout: 'questions-v34-holdout', fixture: 'questions-v34-fixture' };
const { questions } = require(path.resolve(__dirname, '../../../scripts/ai-v34/eval', SET_FILES[process.env.SEOSA_EVAL_SET || 'main'] || SET_FILES.main));

module.exports = questions
  .filter(q => !process.env.SEOSA_EVAL_IDS || process.env.SEOSA_EVAL_IDS.split(',').includes(q.id))
  .map(q => ({
    description: q.id + ' [' + q.type + '] ' + q.turns.map(t => t.p).join(' → '),
    vars: { question_id: q.id, question: q.turns.map(t => t.p).join(' → ') },
    metadata: { questionId: q.id, type: q.type, turns: q.turns.length, fault: q.fault ? JSON.stringify(q.fault) : 'none' }
  }));
