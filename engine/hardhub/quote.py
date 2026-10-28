# SPDX-License-Identifier: AGPL-3.0-or-later
"""Rough JLCPCB price for a design: bare board by layer count, assembly
fees, parts from the design's own sourcing data.  An estimate to compare
options with, not a quote: every figure says where it comes from, and the
person is told to read the fab's live quote before paying.

Sources (dated):
  * 4 layers, 5 boards, under 100 x 100 mm, green, HASL: $8; 104 x 66 mm:
    $29; black mask +$8, ENIG +$17 per order of five -- live JLCPCB quotes
    for Print Hub, 18 Oct 2026 (offgrid-hardware print-hub/v1/README.md)
  * 2 layers, 5 boards, under 100 x 100 mm: $2 -- JLCPCB's advertised
    price, Oct 2026 (promotions change it)
  * 6 and 8 layers, about $60 and $86 for five 100 x 100 mm boards --
    forum reports, 2025-2026; not verified against a live quote
  * assembly: about $3 loading fee per extended part type, none for basic
    or (on Economic PCBA) preferred-extended parts -- Print Hub's quote;
    setup $8 (Economic) and $25 (Standard), $0.0017 per solder joint --
    JLCPCB assembly price page as read Oct 2026, not re-verified
"""
BASIS = ('Estimate from JLCPCB prices read Oct 2026 (Print Hub live quotes for 2-4 layers; '
         '6+ layers from forum reports). Check the live quote before ordering.')

SMALL = {2: 2.0, 4: 8.0, 6: 60.0, 8: 86.0}       # five boards, <= 100 x 100 mm
MASK_EXTRA = {'green': 0.0, 'black': 8.0}         # per order of five
FINISH_EXTRA = {'hasl': 0.0, 'lead-free-hasl': 0.0, 'enig': 17.0}
SETUP = {'economic': 8.0, 'standard': 25.0}
LOADING_FEE = 3.0
JOINT = 0.0017


def pcb_price(layers, w, h, qty, mask='green', finish='lead-free-hasl'):
    base = SMALL.get(layers) or SMALL[8] * 1.4 ** ((layers - 8) / 2)
    if max(w, h) > 100:
        # Print Hub's first layout: 104 x 66 mm quoted 3.6 times the small price
        base *= 3.0 + (w * h) / 10000
    # more than five: each extra board costs about what one of the five did,
    # tapering as panels fill
    per = base / 5
    extra = sum(per * (0.9 if i < 25 else 0.6) for i in range(max(0, qty - 5)))
    lots = max(1, qty / 5)
    add = (MASK_EXTRA.get(mask, 8.0) + FINISH_EXTRA.get(finish, 0.0)) * lots ** 0.5
    return round(base + extra + add, 2)


def unit_price(prices, n):
    """Price per piece for n pieces from a ladder [{qty, usd}]."""
    best = None
    for p in sorted(prices, key=lambda p: p['qty']):
        if p['qty'] <= n or best is None:
            best = p['usd']
    return best or 0.0


def parts_cost(d, qty):
    per_type = {}
    for c in d['components']:
        p = d['parts'].get(c['part'])
        if not p or not p.get('assembled', True):
            continue
        per_type.setdefault(c['part'], [p, 0])[1] += 1
    total, extended, joints = 0.0, 0, 0
    for key, (p, n) in per_type.items():
        s = p.get('sourcing') or {}
        need = n * qty
        total += unit_price(s.get('prices') or [], need) * need
        if s.get('tier') == 'extended':
            extended += 1
    for c in d['components']:
        p = d['parts'].get(c['part'])
        if p and p.get('assembled', True):
            joints += max(2, len(c['pins']))
    return round(total, 2), extended, joints


def quote(d, qtys=(5, 100), layer_options=None, tier='economic'):
    b = d['board']
    layers = layer_options or sorted({2, 4, 6, 8} | {b['layers']})
    parts = {q: parts_cost(d, q) for q in qtys}
    out = []
    for n in layers:
        for q in qtys:
            pcb = pcb_price(n, b['width'], b['height'], q, b.get('mask_color', 'green'), b.get('finish', 'lead-free-hasl'))
            pc, ext, joints = parts[q]
            asm = round(SETUP[tier] + LOADING_FEE * ext + JOINT * joints * q, 2) if joints else 0.0
            total = round(pcb + asm + pc, 2)
            out.append(dict(layers=n, qty=q, pcb_usd=pcb, assembly_usd=asm, parts_usd=pc, total_usd=total,
                            per_board_usd=round(total / q, 2), basis=BASIS))
    return out
