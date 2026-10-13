from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sim import MODES, simulate, analyse

app = FastAPI(title="Flow Control Simulator")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class Params(BaseModel):
    mode: str = "credit"
    send_rate: float = Field(2.0, gt=0, le=10)
    consume_rate: float = Field(1.0, gt=0, le=10)
    buffer_size: int = Field(20, ge=1, le=200)
    prop_delay: int = Field(5, ge=1, le=50)
    window: int = Field(8, ge=1, le=200)
    total_packets: int = Field(300, ge=10, le=2000)


def run(p, mode):
    return simulate(mode, p.send_rate, p.consume_rate, p.buffer_size,
                    p.prop_delay, p.window, p.total_packets)


@app.post("/api/simulate")
def simulate_one(p: Params):
    return run(p, p.mode if p.mode in MODES else "credit")


@app.post("/api/compare")
def compare(p: Params):
    results = [run(p, m) for m in MODES]
    return {"results": [{"mode": r["mode"], "summary": r["summary"]} for r in results],
            "analysis": analyse(p.model_dump(), results)}
