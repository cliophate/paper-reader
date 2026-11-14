# AI providers

Paper supports an OpenAI-compatible Chat Completions API and the isolated Codex
worker. Choose a provider in Settings > Reading & connections, enable AI, choose
features and save. None keeps AI off. Reading and saved AI results work without
any provider. Changing providers affects new requests. A running batch may finish.

## OpenAI-compatible API

Select OpenAI-compatible API. Enter the base URL, API key and model names. Paper
adds `/chat/completions` to the base URL. Include `/v1` when your server uses it.
The default URL is `https://api.openai.com/v1`; all five model fields default to
`gpt-6-luna`. Change them for your provider. A model must support Chat
Completions and the feature's output format.

| Server | Example base URL | Models |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | An available Chat Completions model |
| OpenRouter | `https://openrouter.ai/api/v1` | The provider's model identifier |
| Ollama | `http://localhost:11434/v1` | A model installed on that server |
| LM Studio | `http://localhost:1234/v1` | A loaded model identifier |
| vLLM | `http://localhost:8000/v1` | The served model name |

Paper has separate fields for discussion, headlines, grouping, briefing shortlist
and briefing editor. Headline writing and review use the headlines model. Grouping
and membership review use the grouping model. All batch results pass through the
same feature validation as Codex, including source IDs and evidence checks.

Test connection uses the form values without saving or enabling AI. It sends
one short request using the discussion model, without an output limit, so
reasoning models can reply. A blank key uses the saved key, or the environment
key if none was saved. It reports a fixed success or error message;
it never displays the provider's reply or error body. It does not test the other
models, JSON support or streaming. The request may incur a charge.

Leave the key blank to keep the saved value. Remove key clears it on save and
prevents fallback to an environment key. A key only goes to the origin it was
saved for. If you change the base URL's scheme, host or port, enter the key again
or remove it. Otherwise Paper rejects the change and the test. A local server without authentication
can use an empty key. Turning AI off keeps the key for later. Paper stores it in
`data/connections.json` with mode 0600, like Readwise and Kirby tokens. It is not
encrypted at rest. Settings returns only whether a key is configured and whether
it came from Settings or the environment. Protect the data directory and backups.

The API adapter runs in the main Paper server. It sends plain HTTP requests with
no tools or agent process. The key never enters the Codex worker, worker payloads
or model subprocess environment. No worker container is needed for this provider.
Paper does not log provider response bodies, authorization headers or raw network
errors. Only fixed error messages reach callers.

## Local servers and network policy

Public HTTPS endpoints work by default. HTTP or private destinations require an
exact origin in the administrator's `PAPER_TRUSTED_AI_ORIGINS` environment setting.
It uses the same address checks as feeds, with a separate allowlist. Settings
cannot change this allowlist. Trust only servers you control.

For native Paper with local Ollama, add this to the private environment file:

```dotenv
PAPER_TRUSTED_AI_ORIGINS=http://localhost:11434
```

Restart Paper after changing administrator configuration. The origin includes
the scheme and port, with no path, query, credentials or wildcard. Multiple
origins use commas. A feed allowlist entry does not authorize an AI endpoint.
Paper checks all DNS answers and pins the connection to a validated address.
Redirects are rejected, including redirects within a trusted origin. Use the
server's final base URL. URLs with embedded credentials or query strings are
rejected.

Inside Docker, localhost refers to Paper's container. Use a reachable Docker
service name or host address and allow that exact origin. For a model server on
the Docker host, a private override can provide the host gateway:

```yaml
services:
  paper:
    extra_hosts:
      - host.docker.internal:host-gateway
    environment:
      PAPER_TRUSTED_AI_ORIGINS: http://host.docker.internal:11434
```

Set the base URL in Settings to `http://host.docker.internal:11434/v1`. The model
server must listen on an interface reachable from the container. Keep its port
restricted to the intended network. The main Compose file already reads API
configuration from Paper's private environment file. Do not add that file to
`paper-ai` or pass the API key through the worker's environment.

## Environment defaults

Saved Settings fields override environment defaults, including in the briefing
CLI. The following names configure the API provider:

```dotenv
PAPER_AI_PROVIDER=openai
PAPER_OPENAI_BASE_URL=https://api.openai.com/v1
PAPER_OPENAI_API_KEY=
PAPER_OPENAI_DISCUSSION_MODEL=gpt-6-luna
PAPER_OPENAI_HEADLINES_MODEL=gpt-6-luna
PAPER_OPENAI_GROUPING_MODEL=gpt-6-luna
PAPER_OPENAI_SHORTLIST_MODEL=gpt-6-luna
PAPER_OPENAI_EDITOR_MODEL=gpt-6-luna
PAPER_TRUSTED_AI_ORIGINS=
```

`PAPER_AI_PROVIDER` accepts `none`, `codex` or `openai`. If omitted,
`CODEX_ENABLED=true` still selects Codex for existing installations. Existing
saved Codex switches migrate to the provider selector. New installations default
to None. Selecting Codex requires its worker and login; see the
[worker setup](integrations.md#isolated-codex-worker). API keys and Codex logins
remain separate when switching providers. Briefings use the existing
`recap/editorial-profile.md` with either provider.

## Protocol and limits

Batch requests first send `response_format: json_schema`. A 400 or 422 response
mentioning `response_format` or `json_schema` triggers one retry with
`response_format: json_object` and the schema in the prompt. Paper parses the
JSON and applies the existing feature validators. It does not retry in plain text
mode. Servers must support at least JSON mode. Truncated replies and refusals
fail. Existing feature retry rules still apply.

Discussion uses SSE text deltas. Paper requires a successful stop and a completed
stream. Tool calls, refusals, truncated streams and malformed events fail.
Requests are at most 2 MiB. Responses are at most 4 MiB; discussion text is limited
to 24,000 characters. Compressed responses are rejected, and requests ask for
identity encoding. Response headers are limited to 16 KiB.

The HTTP provider has two active slots and room for 16 waiting requests. One
deadline covers queue wait, DNS, connection and body processing: 300 seconds for
batches, 120 seconds for discussions and 15 seconds for a connection test.
Cancellation removes queued requests or closes the active socket. A late DNS
result cannot start a cancelled request. Briefings retain their ten-minute
overall deadline and cancellation rules.

There is no native Anthropic Messages adapter. Use a compatible Chat Completions
endpoint when available. A Messages adapter would need a separate streaming and
structured-output protocol.
