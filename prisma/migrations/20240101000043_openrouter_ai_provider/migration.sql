-- ============================================================
-- 043_openrouter_ai_provider.sql — allow 'openrouter' as an AI provider
--
-- Adds OpenRouter as a third bring-your-own-key AI provider (alongside
-- OpenAI and Anthropic), so an account can point ai_configs at any
-- OpenRouter-routed model (`<publisher>/<model>` ids) instead of being
-- limited to those two vendors directly.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));
