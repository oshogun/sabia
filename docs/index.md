# Sabiá documentation

Self-hosted flight logging for MSFS 2020/2024 and FSX: an Express/TypeScript
server and a React web client, fed by the Sabiá MCDU client on the
simulator's Windows PC. Start with
the [README](../README.md) to get something running; come here for how it
actually works and how to operate it.

## Contents

| Page | What's in it |
|---|---|
| [architecture.md](architecture.md) | Component map, runtime flow (startup/request/shutdown), the flight state machine, leg matching, external integrations |
| [setup.md](setup.md) | Detailed local/dev setup, HTTPS, Docker, connecting the simulator, validating the install |
| [configuration.md](configuration.md) | Every environment variable — server, agent, and Docker Compose — with defaults and validation rules |
| [usage.md](usage.md) | Logging a flight, planning trips, ACARS, exports, run/debug/test commands, common failures |
| [navdata.md](navdata.md) | Map navdata: the replica of the MCDU client's MSFS navigation data, its sync/query endpoints, route expansion, licensing and operation |
| [api.md](api.md) | Every HTTP route, its auth requirement, and its request/response shape |
| [data-model.md](data-model.md) | Full SQLite schema, entity relationships, the `src/db/` module map |
| [operations.md](operations.md) | Running in production, Docker, backups/restore, maintenance scripts, log locations |
| [troubleshooting.md](troubleshooting.md) | Diagnostics and fixes for startup, Docker, agent connectivity, auth, and data issues |
| [development.md](development.md) | Repo layout, testing strategy, CI, branching convention |
| [security.md](security.md) | Threat model, auth/CSRF/token design, secrets, data-at-rest |
| [release.md](release.md) | Versioning, the tagged releases so far, upgrading, and how CI publishes a release |
| [glossary.md](glossary.md) | Domain terms: leg, trip, ACARS, OOOI, PDC, ingest token, and more |

## Reading order

New to the project and want it running: [README](../README.md) →
[setup.md](setup.md) → [usage.md](usage.md).

Making a change: [architecture.md](architecture.md) →
[data-model.md](data-model.md) / [api.md](api.md) as needed →
[development.md](development.md) for testing.

Operating an existing deployment: [operations.md](operations.md) →
[troubleshooting.md](troubleshooting.md) → [security.md](security.md).

## Scope

This documentation covers `src/` (server) and `client/` (web UI), the two
components of this repository. The Tauri/MCDU desktop client, which reads
the simulator over SimConnect and posts to this server, is a separate project
([`oshogun/sabia_mcdu`](https://github.com/oshogun/sabia_mcdu)) with its own
docs. It's mentioned here only where it touches this repo's API
([api.md](api.md), [architecture.md](architecture.md)). The Node.js
SimConnect agent that used to live in `agent/` was retired on 2026-09-25;
the MCDU client replaces it.

All required sections from this documentation's own spec are present:
architecture, setup, configuration, usage, API, data model, operations,
troubleshooting, development, security, release, and glossary are each a full
page.
