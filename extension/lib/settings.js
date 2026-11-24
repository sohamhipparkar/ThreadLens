// settings.js — settings precedence: Settings panel (chrome.storage) > config.js (from .env) > defaults.

import ENV from '../config.js';
import { DEFAULT_SETTINGS } from './pipeline.js';

const hasChrome = typeof chrome !== 'undefined' && chrome.storage?.local;
const KEY = 'threadlens.settings';

const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
const bool = (v, d) => (v === undefined || v === '' ? d : String(v).toLowerCase() === 'true');

export function envDefaults() {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: ENV.GEMINI_API_KEY || '',
    model: ENV.GEMINI_MODEL || DEFAULT_SETTINGS.model,
    redactContacts: bool(ENV.REDACT_CONTACT_INFO, DEFAULT_SETTINGS.redactContacts),
    pseudonymizeNames: bool(ENV.PSEUDONYMIZE_NAMES, DEFAULT_SETTINGS.pseudonymizeNames),
    verifyWithLLM: bool(ENV.VERIFY_WITH_LLM, DEFAULT_SETTINGS.verifyWithLLM),
    singlePassTokenLimit: num(ENV.SINGLE_PASS_TOKEN_LIMIT, DEFAULT_SETTINGS.singlePassTokenLimit),
    chunkTokens: num(ENV.CHUNK_TOKENS, DEFAULT_SETTINGS.chunkTokens),
  };
}

export async function loadSettings() {
  const base = envDefaults();
  let saved = {};
  try {
    saved = hasChrome ? (await chrome.storage.local.get(KEY))[KEY] || {} : JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch { saved = {}; }
  const merged = { ...base, ...saved };
  if (!saved.apiKey) merged.apiKey = base.apiKey; // empty field in Settings falls back to .env
  merged.keySource = saved.apiKey ? 'settings' : base.apiKey ? '.env' : 'none';
  return merged;
}

export async function saveSettings(s) {
  const { keySource, ...rest } = s;
  // never copy the .env key into browser storage — only keys typed into Settings are saved
  if (keySource !== 'settings' && rest.apiKey === envDefaults().apiKey) rest.apiKey = '';
  try {
    if (hasChrome) await chrome.storage.local.set({ [KEY]: rest });
    else localStorage.setItem(KEY, JSON.stringify(rest));
  } catch { /* storage unavailable */ }
}
