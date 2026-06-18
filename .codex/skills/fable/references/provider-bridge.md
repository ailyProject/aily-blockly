# Provider Bridge

Use this reference only when the user wants Codex to route model calls to an actual Fable-compatible Anthropic model. A skill cannot create access to a model. The user must have model availability, credentials, and a gateway that Codex can call.

## Reality Check

- Prompt instructions can emulate parts of a Fable-style workflow, but they cannot reproduce a model's weights, context window, training data, latency, or hidden safety systems.
- Codex custom providers work through OpenAI-compatible APIs. Current Codex provider examples use the Responses API for custom OpenAI-compatible providers.
- Anthropic models use the Anthropic Messages API natively. Use a gateway that translates between OpenAI-compatible Responses API calls and Anthropic.
- Model availability changes. Verify the current Anthropic model docs and your account access before changing Codex config.

## Recommended Gateway

Use LiteLLM Proxy when you need a practical OpenAI-compatible gateway for Anthropic models. LiteLLM documents OpenAI-compatible proxy support, Anthropic provider support, and Responses API support.

Typical flow:

```bash
python3 -m pip install "litellm[proxy]"
export ANTHROPIC_API_KEY="sk-ant-..."
litellm --config litellm-fable5.yaml --host 127.0.0.1 --port 4000
```

Generate a starter LiteLLM config:

```bash
python3 plugins/fable/skills/fable/scripts/make_litellm_config.py \
  --model claude-fable-5 \
  --alias claude-fable-5 \
  --output litellm-fable5.yaml
```

## Codex Config Example

Put provider config in your user-level `~/.codex/config.toml`, not in a project-local config, when it changes authentication or model routing.

```toml
model_provider = "litellm-fable5"
model = "claude-fable-5"

[model_providers.litellm-fable5]
name = "LiteLLM Fable 5"
base_url = "http://127.0.0.1:4000/v1"
env_key = "LITELLM_API_KEY"
env_key_instructions = "Set LITELLM_API_KEY to the LiteLLM virtual key or any accepted proxy key."
wire_api = "responses"
```

If your LiteLLM proxy does not require virtual keys, set `LITELLM_API_KEY` to a placeholder value accepted by the proxy, or configure LiteLLM authentication properly and use the real virtual key.

## Validation Steps

1. Start the gateway.
2. Verify the gateway accepts an OpenAI Responses-style request.
3. Start a new Codex session with the provider config.
4. Ask Codex to summarize its active model/provider only if the provider exposes that information. Do not treat a style change as proof of provider routing.
5. Run a small tool-using task, such as reading one file and editing one line, before attempting large autonomous work.

## Failure Modes

- No Anthropic access: use Fable-style Codex mode instead.
- Model retired or suspended: choose an available Anthropic model or return to OpenAI Codex models.
- Tool calling mismatch: update LiteLLM, enable parameter modification if needed, or use the native Codex model for tool-heavy coding work.
- Long-context mismatch: do not assume Anthropic's advertised context limits are usable through every gateway or Codex surface.
- Safety/refusal mismatch: provider-side refusals still apply and may differ from Codex/OpenAI refusals.
