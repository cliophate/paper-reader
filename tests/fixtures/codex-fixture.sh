#!/bin/sh
# Only the provider changes. Paper supplies all normal tool and sandbox flags.
exec /usr/local/bin/codex "$@" \
  -c 'model_provider="fixture"' \
  -c 'model_providers.fixture={name="Local fixture",base_url="http://fixture:8090/v1",wire_api="responses",requires_openai_auth=false}'
