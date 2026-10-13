# Flow Control Simulator

React + Vite frontend, FastAPI backend. Compares four ways a sender can avoid overflowing a receiver's buffer:
no flow control, stop-and-wait, fixed sliding window, and receiver-advertised credit (TCP-style rwnd).

## Run

Backend (terminal 1):
```
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

Frontend (terminal 2):
```
cd frontend
npm install
npm run dev
```
Open http://localhost:5173. Vite proxies `/api` to the backend on port 8000.

## API
- `POST /api/simulate` body: `{mode, send_rate, consume_rate, buffer_size, prop_delay, window, total_packets}` -> per-tick series + summary
- `POST /api/compare` same body -> summary for all four modes + written trade-off notes

## Model (backend/sim.py)
One tick = one time unit. Link delay is fixed. The receiver app drains `consume_rate` packets/tick.
A packet arriving at a full buffer is dropped and resent after a timeout. Credit mode uses the free-buffer
size carried by each ack, plus a window-update message so a zero window cannot deadlock.
