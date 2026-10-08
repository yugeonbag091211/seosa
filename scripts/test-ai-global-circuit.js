#!/usr/bin/env node
'use strict';

/*
 * The multi-instance global-circuit fixture predates the paid OpenAI primary.
 * Its purpose is specifically to prove that the existing free Gemini/Groq/
 * OpenRouter fallback shares circuit state across isolated serverless instances.
 *
 * Keep the original fixture byte-for-byte in test-ai-global-circuit-base.js and
 * make only its synthetic VM source point at _llm-free.js. Expectations and
 * assertion counts remain unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');

const realReadFileSync = fs.readFileSync;
const wrapperPath = path.resolve(__dirname, '..', 'api', '_llm.js');
const freePath = path.resolve(__dirname, '..', 'api', '_llm-free.js');

fs.readFileSync = function patchedReadFileSync(file, ...args) {
  try {
    if (path.resolve(String(file)) === wrapperPath) {
      return realReadFileSync.call(fs, freePath, ...args);
    }
  } catch (_) {}
  return realReadFileSync.call(fs, file, ...args);
};

try {
  require('./test-ai-global-circuit-base.js');
} finally {
  // The base fixture captures LLM_SOURCE synchronously before launching its async
  // simulations, so restoring fs immediately cannot change what it executes.
  fs.readFileSync = realReadFileSync;
}
