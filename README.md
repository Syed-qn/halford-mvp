# Halford AI QS & Planning Workbench

**One platform. One login. One project record. Two engines (Cost + Schedule) sharing the same data.**

Upload drawings once. Get priced BoQ, cost plan, and resource-loaded schedule out. Use the same project record for tender review, variations, and forensic delay analysis throughout the project lifecycle.

## What's in here

```
.
├── halford_ai_qs_workbench.html  ← single-page UI (5-step flow)
├── docker-compose.yml             ← full dev stack
├── server/                        ← Node.js API + Claude + APS integrations
│   ├── index.js
│   ├── services/
│   │   ├── aps.js              ← Autodesk APS (Forge) — auth, upload, translate, properties
│   │   ├── claude.js           ← Claude Opus 4.7 + adaptive thinking + prompt caching
│   │   ├── pricing.js          ← BoQ engine, location/project factors, schedule, cashflow
│   │   ├── db.js               ← Postgres adapter (falls back to JSON files in dev)
│   │   ├── storage.js          ← MinIO adapter (falls back to local filesystem)
│   │   ├── queue.js            ← BullMQ Redis queue (falls back to inline async)
│   │   ├── auth.js             ← Keycloak OIDC middleware (no-op without KEYCLOAK_URL)
│   │   ├── solver.js           ← bridge to Python solver service
│   │   └── generators/
│   │       ├── boq-excel.js          ← Priced BoQ (.xlsx, NRM2-style)
│   │       ├── cost-plan-pdf.js      ← Cost Plan with elemental breakdown (.pdf)
│   │       ├── benchmark-pdf.js      ← Benchmark vs RLB / F+G (.pdf)
│   │       ├── audit-pdf.js          ← Audit trail every BoQ → drawing (.pdf)
│   │       ├── p6-xer.js             ← Primavera P6 XER format
│   │       └── cashflow-excel.js     ← Monthly + cumulative S-curve (.xlsx)
│   └── data/rates.json         ← UAE/GCC rate library (32 elements + 14 resources)
├── solver/                        ← Python FastAPI sidecar
│   ├── main.py                 ← /optimize (CP-SAT), /predict-cost (LightGBM),
│   │                             /parse-ifc (IfcOpenShell), /parse-pdf (PyMuPDF),
│   │                             /simulate (SimPy Monte Carlo)
│   ├── requirements.txt
│   └── Dockerfile
└── infra/
    ├── postgres-init/01_schema.sql       ← projects, drawings, elements, exports
    ├── timescale-init/01_metrics.sql     ← api_calls, schedule_progress hypertables
    └── keycloak/halford-realm.json       ← realm + qs / planner / viewer roles
```

## Architecture

| Layer | Role |
|---|---|
| **Frontend** | Single-page HTML + Chart.js, served by the Node server |
| **Node.js API** (`server/`) | REST API; orchestrates Claude + APS + solver + storage |
| **Claude API** (`Opus 4.7`) | AI takeoff (drawings → elements), BoQ classification, delay NLP |
| **Autodesk APS** (Model Derivative) | DWG / RVT / DXF / IFC parsing, geometry → properties |
| **Python solver** (`solver/`) | OR-Tools CP-SAT scheduler, LightGBM cost prediction, IfcOpenShell + PyMuPDF parsers, SimPy simulation |
| **PostgreSQL** | Projects, drawings, elements, exports |
| **TimescaleDB** | `api_calls` + `schedule_progress` hypertables (cost & EVM telemetry) |
| **MinIO** | S3-compatible object store for drawings + outputs |
| **Redis** + **BullMQ** | Job queue for APS translate jobs |
| **Keycloak** | OIDC SSO; realm `halford` with `qs`, `planner`, `viewer` roles |

## Quick start (zero config — JSON files, local FS, inline jobs)

```bash
cd server
cp .env.example .env
# Add your APS_CLIENT_ID, APS_CLIENT_SECRET, ANTHROPIC_API_KEY
npm install
node index.js
# → http://localhost:3000/halford_ai_qs_workbench.html
```

The server runs without any external services. Drawings + outputs go to `server/uploads/` and `server/output/`; projects to `server/projects/<id>.json`.

## Full dev stack

```bash
# Set credentials at the repo root for compose interpolation
cp server/.env.example .env
# Edit .env

docker compose up -d
docker compose logs -f server
# → http://localhost:3000  (UI)
# → http://localhost:9001  (MinIO console: halford / halford-dev-secret)
# → http://localhost:8080  (Keycloak: admin / admin)
# → http://localhost:8001/docs  (Solver Swagger UI)
```

## End-to-end flow

| Step | UI action | API | Backend |
|---|---|---|---|
| 1 | Set project name/type/location → drag drawings | `POST /api/projects` + `POST /api/projects/:id/upload` | Multer → MinIO → BullMQ enqueue → APS Model Derivative (translate + properties) |
| 1 | Click "Analyse drawings" | `POST /api/projects/:id/analyse` | Claude Opus 4.7 with adaptive thinking + cached rate library; returns elements + GFA |
| 2 | Review checkboxes / edit qty | `PATCH /api/projects/:id/elements` | Persist edits |
| 3 | Adjust markup / per-line rates | `GET/PATCH /api/projects/:id/boq` | `pricing.computeBoQ()` applies location × project-type × markup factors |
| 4 | Click an export card | `POST /api/projects/:id/export/{boq,cost-plan,benchmark,audit,xer,cashflow}` | ExcelJS / PDFKit / custom XER generator → MinIO → presigned URL |
| 5 | Set constraints → "Run optimiser" | `POST /api/projects/:id/optimize` | Calls Python solver `/optimize` (OR-Tools CP-SAT) for balanced/fastest/cheapest scenarios |
| 5 | Pick scenario → view Gantt / Cashflow | `GET/POST /api/projects/:id/schedule` | `pricing.buildSchedule()` + `buildCashflow()` |

## Output files

Every export is **real**:

| File | Format | Generator |
|---|---|---|
| `Halford_<id>_BoQ.xlsx` | Excel 2007+ | ExcelJS — sectioned NRM2 BoQ + summary tab |
| `Halford_<id>_CostPlan.pdf` | PDF | PDFKit — elemental breakdown + per-section detail |
| `Halford_<id>_Benchmark.pdf` | PDF | PDFKit — visual range bar vs RLB low/mid/high |
| `Halford_<id>_Audit.pdf` | PDF | PDFKit — every line → source drawing, chain of custody |
| `Halford_<id>_Schedule.xer` | Primavera P6 XER | tab-delimited; imports cleanly into P6 |
| `Halford_<id>_CashFlow.xlsx` | Excel 2007+ | ExcelJS — monthly, cumulative, drawdown %, resources tab |

## Required API credentials

- **Autodesk Platform Services** (formerly Forge): https://aps.autodesk.com/
  - Create an app, set `APS_CLIENT_ID` + `APS_CLIENT_SECRET`
- **Anthropic Claude API**: https://console.anthropic.com/
  - Set `ANTHROPIC_API_KEY` (uses `claude-opus-4-7`)

## Cost & telemetry

The Claude integration uses prompt caching on the rate library (~5K tokens of stable system prompt) — second-and-onward calls within 5 minutes hit cache at ~10% of base price. Cache stats are returned in `extraction_usage` on every `/analyse` response and (when TimescaleDB is wired) logged to the `api_calls` hypertable.
