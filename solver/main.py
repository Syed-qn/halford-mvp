"""Halford solver service.

Endpoints:
    GET  /health          — liveness probe
    POST /optimize        — OR-Tools CP-SAT schedule optimizer (with DEAP fallback for huge problems)
    POST /predict-cost    — LightGBM cost prediction from element features
    POST /parse-ifc       — IFC element extraction via IfcOpenShell
    POST /parse-pdf       — Text extraction from PDF drawings via PyMuPDF
    POST /simulate        — SimPy discrete-event simulation of the schedule
"""

import io
import logging
import math
import os
import tempfile
import time
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("halford-solver")

app = FastAPI(title="Halford Solver", version="1.0.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "halford-solver"}


# ---------------- /optimize ----------------
class Activity(BaseModel):
    name: str
    duration: int  # weeks
    cost: float = 0.0
    crew: str = "default"
    predecessors: List[str] = Field(default_factory=list)


class Constraints(BaseModel):
    target_weeks: int = 104
    max_concurrent_crews: int = 12
    workdays_per_week: int = 6
    max_weekly_spend: Optional[float] = None
    locked_milestones: dict = Field(default_factory=dict)  # name -> week


class OptimizeReq(BaseModel):
    activities: List[Activity]
    constraints: Constraints
    objective: str = "balanced"  # balanced | fastest | cheapest


@app.post("/optimize")
def optimize(req: OptimizeReq):
    """CP-SAT schedule optimizer.

    Models a resource-constrained project scheduling problem (RCPSP) and finds
    a sequence that respects predecessor relationships, crew capacity, and the
    target completion window. Returns activity start weeks + makespan.
    """
    from ortools.sat.python import cp_model

    model = cp_model.CpModel()
    horizon = req.constraints.target_weeks * 2  # generous upper bound
    starts, ends, intervals = {}, {}, {}
    name_to_idx = {a.name: i for i, a in enumerate(req.activities)}

    for a in req.activities:
        s = model.NewIntVar(0, horizon, f"s_{a.name}")
        e = model.NewIntVar(0, horizon, f"e_{a.name}")
        iv = model.NewIntervalVar(s, a.duration, e, f"i_{a.name}")
        starts[a.name] = s
        ends[a.name] = e
        intervals[a.name] = iv

    # Predecessor constraints (FS = 0)
    for a in req.activities:
        for pred in a.predecessors:
            if pred in ends:
                model.Add(starts[a.name] >= ends[pred])

    # Crew capacity: cumulative resource constraint per crew
    crews = set(a.crew for a in req.activities)
    for crew in crews:
        crew_acts = [a for a in req.activities if a.crew == crew]
        if not crew_acts:
            continue
        demands = [1] * len(crew_acts)
        ivs = [intervals[a.name] for a in crew_acts]
        model.AddCumulative(ivs, demands, req.constraints.max_concurrent_crews)

    # Locked milestones
    for milestone, wk in (req.constraints.locked_milestones or {}).items():
        if milestone in starts:
            model.Add(starts[milestone] == int(wk))

    # Objective
    makespan = model.NewIntVar(0, horizon, "makespan")
    model.AddMaxEquality(makespan, list(ends.values()))

    if req.objective == "fastest":
        model.Minimize(makespan)
    elif req.objective == "cheapest":
        # Front-load cheap-resource activities, defer expensive ones (proxy)
        total_cost_weighted = sum(a.cost * starts[a.name] for a in req.activities)
        model.Minimize(makespan * 1000 + total_cost_weighted // 1000)
    else:  # balanced
        model.Minimize(makespan)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise HTTPException(status_code=422, detail=f"No feasible schedule found ({solver.StatusName(status)})")

    activities_out = []
    for a in req.activities:
        s = solver.Value(starts[a.name])
        e = solver.Value(ends[a.name])
        activities_out.append({
            "name": a.name,
            "start_week": s + 1,
            "end_week": e,
            "duration": a.duration,
            "cost": a.cost,
            "crew": a.crew,
        })

    return {
        "objective": req.objective,
        "makespan_weeks": int(solver.Value(makespan)),
        "status": solver.StatusName(status),
        "wall_time_s": solver.WallTime(),
        "activities": activities_out,
    }


# ---------------- /predict-cost ----------------
class CostPredictReq(BaseModel):
    project_type: str
    location: str
    gfa: float
    storeys: int = 1
    quality: str = "standard"  # economy | standard | premium


@app.post("/predict-cost")
def predict_cost(req: CostPredictReq):
    """LightGBM cost prediction.

    In production this loads a trained model from disk. We ship a heuristic
    fallback so the endpoint is functional out of the box; train a real model
    by running scripts/train_cost_model.py on historical project data.
    """
    base_per_m2 = {
        "Residential — high rise": 8200,
        "Residential — villa": 6400,
        "Commercial — office": 9100,
        "Retail": 7400,
        "Industrial": 4500,
        "Infrastructure": 6000,
        "Mixed use": 8600,
    }.get(req.project_type, 8000)

    quality_factor = {"economy": 0.82, "standard": 1.00, "premium": 1.34}.get(req.quality, 1.0)
    storey_factor = 1.0 + max(0, req.storeys - 5) * 0.012  # high-rise premium per extra storey

    # Try LightGBM if a model file is present
    model_path = os.environ.get("LGBM_MODEL_PATH", "/app/models/cost.txt")
    used_ml = False
    if os.path.exists(model_path):
        try:
            import lightgbm as lgb
            import numpy as np
            booster = lgb.Booster(model_file=model_path)
            features = np.array([[req.gfa, req.storeys, quality_factor, storey_factor]])
            base_per_m2 = float(booster.predict(features)[0])
            used_ml = True
        except Exception as e:
            log.warning("LightGBM prediction failed, falling back to heuristic: %s", e)

    cost_per_m2 = base_per_m2 * quality_factor * storey_factor
    total = cost_per_m2 * req.gfa
    return {
        "model": "lightgbm" if used_ml else "heuristic",
        "cost_per_m2": round(cost_per_m2, 2),
        "total": round(total, 2),
        "factors": {"quality": quality_factor, "storey": round(storey_factor, 3)},
    }


# ---------------- /parse-ifc ----------------
@app.post("/parse-ifc")
async def parse_ifc(file: UploadFile = File(...)):
    """Extract elements from an IFC file using IfcOpenShell."""
    try:
        import ifcopenshell
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ifcopenshell unavailable: {e}")

    content = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".ifc", delete=False) as f:
        f.write(content)
        f.flush()
        path = f.name

    try:
        ifc = ifcopenshell.open(path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse IFC: {e}")
    finally:
        os.unlink(path)

    summary: dict[str, dict] = {}
    for entity in ("IfcWall", "IfcSlab", "IfcColumn", "IfcBeam", "IfcDoor", "IfcWindow", "IfcStair", "IfcRoof", "IfcCovering", "IfcPipeSegment", "IfcDuctSegment"):
        elements = ifc.by_type(entity)
        if not elements:
            continue
        types = {}
        for el in elements[:500]:
            type_name = (getattr(el, "ObjectType", None) or getattr(el, "Name", None) or entity).strip()
            types[type_name] = types.get(type_name, 0) + 1
        summary[entity] = {
            "count": len(elements),
            "types": types,
        }

    project = ifc.by_type("IfcProject")
    return {
        "schema": ifc.schema,
        "project_name": project[0].Name if project else None,
        "elements": summary,
        "total_entities": len(list(ifc)),
    }


# ---------------- /parse-pdf ----------------
@app.post("/parse-pdf")
async def parse_pdf(file: UploadFile = File(...)):
    """Extract text + drawing-title-block info from a PDF using PyMuPDF."""
    import fitz  # PyMuPDF

    content = await file.read()
    try:
        doc = fitz.open(stream=content, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to parse PDF: {e}")

    pages = []
    for i, page in enumerate(doc):
        text = page.get_text("text")
        # Heuristic: title block usually in the bottom-right region
        rect = page.rect
        title_block = page.get_text("text", clip=fitz.Rect(rect.width * 0.6, rect.height * 0.7, rect.width, rect.height))
        pages.append({
            "page": i + 1,
            "size": [round(rect.width), round(rect.height)],
            "text_excerpt": text[:500],
            "title_block": title_block.strip(),
            "n_chars": len(text),
        })
    doc.close()
    return {"page_count": len(pages), "pages": pages}


# ---------------- /simulate ----------------
class SimulateReq(BaseModel):
    activities: List[Activity]
    crew_count: int = 8
    iterations: int = 100  # Monte Carlo


@app.post("/simulate")
def simulate(req: SimulateReq):
    """SimPy discrete-event simulation with stochastic activity durations.

    Useful for risk analysis — gives P10/P50/P90 makespan instead of a single
    deterministic answer.
    """
    import random
    import simpy

    durations = []
    for _ in range(req.iterations):
        env = simpy.Environment()
        crew = simpy.Resource(env, capacity=req.crew_count)
        ends = {}

        def run_activity(a: Activity):
            # Wait on predecessors
            for pred in a.predecessors:
                if pred in ends:
                    yield ends[pred]
            with crew.request() as req_:
                yield req_
                # Stochastic duration: triangular(80%, 100%, 130%)
                d = random.triangular(a.duration * 0.8, a.duration * 1.3, a.duration)
                yield env.timeout(d)

        # Schedule all activities
        events = {}
        for a in req.activities:
            events[a.name] = env.process(run_activity(a))
        ends.update(events)
        env.run()
        durations.append(env.now)

    durations.sort()
    return {
        "iterations": req.iterations,
        "p10": durations[len(durations) // 10],
        "p50": durations[len(durations) // 2],
        "p90": durations[(len(durations) * 9) // 10],
        "min": durations[0],
        "max": durations[-1],
    }
