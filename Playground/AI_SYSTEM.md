# AI System

## Current implementation

The current app uses deterministic analysis as the primary engine.

AI is reserved for **second-pass verification**.

## Verification adapter

The local server exposes:

- `POST /api/ai/analyze`

When `OPENAI_API_KEY` is not set:

- the route returns a structured mock verification result.

When `OPENAI_API_KEY` is set:

- the route calls the OpenAI Responses API from the server side;
- the client bundle never receives the API key.

## Official API basis

This scaffold follows the current official OpenAI quickstart pattern for Responses API calls using:

- `model`
- `input`

Reference:
[Developer quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request)

The specific verification payload is a project inference layered on top of that official request shape.

## Safety rules

- source documents are treated as untrusted data
- AI output is not used for arithmetic, date logic or hard filters
- verification output is structured and stored separately from hidden reasoning
- deterministic engine remains the source of truth in Phase 0
