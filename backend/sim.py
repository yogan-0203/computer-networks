"""Tick-based flow control simulator.

One tick is one unit of time. The sender pushes packets through a link with a
fixed one-way propagation delay into a receiver that has a finite buffer. The
receiver's application drains that buffer at its own (possibly slower) rate.
Packets that arrive at a full buffer are dropped and must be retransmitted
after a timeout.
"""
from collections import deque
from math import ceil

MODES = ["none", "stop_and_wait", "sliding_window", "credit"]


def simulate(mode, send_rate=2.0, consume_rate=1.0, buffer_size=20,
             prop_delay=5, window=8, total_packets=300, max_ticks=4000):
    assert mode in MODES
    rto = 4 * prop_delay + 10                 # retransmission timeout
    queue = deque(range(total_packets))       # packets waiting to be sent
    retx = deque()                            # retransmissions go first
    inflight = {}                             # seq -> tick sent (unacked)
    first_sent = {}                           # seq -> tick of first send
    forward, backward = [], []                # (arrival_tick, payload)
    buffer, seen = deque(), set()
    tokens = consume_acc = 0.0
    rwnd, last_adv = buffer_size, buffer_size
    sent = drops = retransmits = delivered = stalls = 0
    latencies, series = [], []
    done_tick = None

    for t in range(max_ticks):
        # 1. packets reach the receiver
        due = [p for p in forward if p[0] <= t]
        forward = [p for p in forward if p[0] > t]
        for _, seq in due:
            if seq in seen:
                pass                                   # duplicate, just re-ack
            elif len(buffer) >= buffer_size:
                drops += 1                             # OVERFLOW
                continue
            else:
                seen.add(seq)
                buffer.append(seq)
            backward.append((t + prop_delay, ("ack", seq, buffer_size - len(buffer))))
            last_adv = buffer_size - len(buffer)

        # 2. receiving application drains the buffer
        consume_acc += consume_rate
        while consume_acc >= 1 and buffer:
            seq = buffer.popleft()
            delivered += 1
            latencies.append(t - first_sent[seq])
            consume_acc -= 1
        if not buffer:
            consume_acc = 0.0

        # 3. window update after a zero window reopens (prevents deadlock)
        free = buffer_size - len(buffer)
        if last_adv == 0 and free > 0:
            backward.append((t + prop_delay, ("update", None, free)))
            last_adv = free

        # 4. acks reach the sender
        due = [p for p in backward if p[0] <= t]
        backward = [p for p in backward if p[0] > t]
        for _, (_, seq, win) in due:
            inflight.pop(seq, None)
            rwnd = win

        # 5. timeouts
        for seq, ts in list(inflight.items()):
            if t - ts >= rto:
                del inflight[seq]
                retx.append(seq)
                retransmits += 1

        # 6. sender transmits as far as its mode allows
        limit = {"none": float("inf"), "stop_and_wait": 1,
                 "sliding_window": window, "credit": rwnd}[mode]
        tokens += send_rate
        blocked = False
        while tokens >= 1 and (retx or queue):
            if len(inflight) >= limit:
                blocked = True
                break
            seq = retx.popleft() if retx else queue.popleft()
            first_sent.setdefault(seq, t)
            inflight[seq] = t
            forward.append((t + prop_delay, seq))
            sent += 1
            tokens -= 1
        if blocked:
            stalls += 1
        tokens = min(tokens, max(1.0, send_rate))

        series.append({"t": t, "buffer": len(buffer), "inflight": len(inflight),
                       "drops": drops, "delivered": delivered, "sent": sent,
                       "limit": None if limit == float("inf") else min(limit, buffer_size * 4)})
        if delivered >= total_packets:
            done_tick = t
            break

    ticks = len(series)
    avg_lat = sum(latencies) / len(latencies) if latencies else 0
    return {
        "mode": mode, "series": series,
        "summary": {
            "completed": done_tick is not None,
            "ticks": ticks,
            "delivered": delivered,
            "goodput": round(delivered / ticks, 3),
            "drops": drops,
            "retransmits": retransmits,
            "efficiency": round(delivered / sent, 3) if sent else 0,   # useful share of transmissions
            "sender_stall_pct": round(100 * stalls / ticks, 1),
            "peak_buffer": max(s["buffer"] for s in series),
            "avg_latency": round(avg_lat, 1),
        },
    }


def analyse(params, results):
    """Plain-language trade-off notes derived from the numbers."""
    notes = []
    bdp = params["send_rate"] * 2 * params["prop_delay"]
    by = {r["mode"]: r["summary"] for r in results}
    n = by["none"]
    if n["drops"]:
        notes.append(f"Without flow control {n['drops']} packets overflowed the buffer; only "
                     f"{round(n['efficiency'] * 100)}% of transmissions were useful, so the link wasted capacity on retransmits.")
    else:
        notes.append("Without flow control nothing overflowed here. The buffer is big enough for this sender, so flow control adds cost with no benefit.")
    s = by["stop_and_wait"]
    notes.append(f"Stop-and-wait never overflows but keeps the sender blocked {s['sender_stall_pct']}% of the time and finishes in {s['ticks']} ticks. It sends one packet per round trip ({2 * params['prop_delay']} ticks).")
    if n["drops"] and n["goodput"] >= by["credit"]["goodput"] * 0.9:
        notes.append(f"Goodput looks fine without flow control because a constantly full buffer keeps the receiver busy, but average latency is {n['avg_latency']} ticks vs {by['credit']['avg_latency']} with credit. You pay in bandwidth and delay, not in speed.")
    w = by["sliding_window"]
    if params["window"] < bdp:
        notes.append(f"The fixed window ({params['window']}) is smaller than the bandwidth-delay product (~{round(bdp)}), so the pipe is never full. A larger window would raise throughput.")
    if w["drops"]:
        notes.append(f"The fixed window ({params['window']}) is larger than the receiver can absorb: {w['drops']} drops. A fixed window needs tuning to the buffer.")
    c = by["credit"]
    notes.append(f"Receiver credit (advertised window) finished with {c['drops']} drops and goodput {c['goodput']}, "
                 f"close to the receiver's drain rate of {params['consume_rate']}/tick. It adapts automatically, at the price of one extra header field and stale-window delay.")
    if params["consume_rate"] < params["send_rate"]:
        notes.append("The receiver is slower than the sender, so the bottleneck is the receiver. No scheme can beat its drain rate; flow control only decides whether the excess is dropped or held back.")
    return notes
