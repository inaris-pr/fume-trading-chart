# Synthetic Alpaca error fixtures

These bodies are **synthetic** (not captured from Alpaca). They exist so the adapter's error
mapping is tested for failures that should not be triggered deliberately against the real API
(bad credentials, rate limiting, server errors). Their shapes follow the recorded real errors in
`../recorded/` (`{ "message": ... }`, optionally with a numeric `code`).

Recorded real errors: `../recorded/error-400-bars.json`, `error-403-recent-sip.json`,
`error-404-asset.json`.
