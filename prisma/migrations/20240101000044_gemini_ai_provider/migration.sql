-- ============================================================
-- 044_gemini_ai_provider.sql — allow 'gemini' as an AI provider
--
-- Adds Google Gemini as a fourth bring-your-own-key AI provider
-- (alongside OpenAI, Anthropic, and OpenRouter) — Gemini has a
-- rate-limited free tier on Google AI Studio keys, useful for trying
-- the assistant at no cost.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'gemini'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter', 'gemini'));
