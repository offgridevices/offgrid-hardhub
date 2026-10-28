# SPDX-License-Identifier: AGPL-3.0-or-later
"""Look parts up in the JLCPCB / LCSC catalogues: price ladder, stock,
basic or extended at JLCPCB's assembly line, package, datasheet.

The same public endpoints offgrid-hardware's tools/lcsc.py reads.  Answers
are cached on disk for CACHE_TTL seconds: a search the AI repeats inside
one conversation should not hit the catalogue again, but stock and prices
older than a few hours are not shown as current.

Lifecycle: neither catalogue states active / not-for-new-designs / end of
life in these endpoints, so parts come back "unknown" unless the listing's
own text says it (LCSC marks discontinued parts in the description).
"""
import hashlib
import json
import os
import time
import urllib.request

JLC_SEARCH = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList'
LCSC_DETAIL = 'https://wmsc.lcsc.com/ftps/wm/product/detail?productCode='
UA = {'User-Agent': 'Mozilla/5.0 (HardHub)', 'Content-Type': 'application/json'}
CACHE = os.path.join(os.environ.get('HARDHUB_FP_CACHE', os.path.expanduser('~/.cache/hardhub')), 'parts')
CACHE_TTL = int(os.environ.get('HARDHUB_PARTS_TTL', 6 * 3600))


class CatalogError(Exception):
    pass


def _http(url, body=None, timeout=20):
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


# tests replace this with a reader of recorded answers
fetch = _http


def _cached(key, get):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, hashlib.sha1(key.encode()).hexdigest() + '.json')
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_TTL:
        return json.load(open(path))
    data = get()
    with open(path + '.tmp', 'w') as f:
        json.dump(data, f)
    os.replace(path + '.tmp', path)
    return data


def _lifecycle(text):
    t = (text or '').lower()
    if 'discontinued' in t or 'end of life' in t or 'obsolete' in t:
        return 'eol'
    if 'not recommended for new' in t or 'nrnd' in t:
        return 'nrnd'
    return 'unknown'


def from_jlc(c):
    tier = {'base': 'basic', 'expand': 'extended'}.get(c.get('componentLibraryType'), None)
    if tier == 'extended' and c.get('preferredComponentFlag'):
        tier = 'preferred'
    desc = c.get('describe') or ''
    out = dict(lcsc=c['componentCode'], mpn=c.get('componentModelEn') or '', maker=c.get('componentBrandEn'),
               package=c.get('componentSpecificationEn'), description=desc, tier=tier,
               stock=int(c.get('stockCount') or 0),
               prices=[dict(qty=int(p['startNumber']), usd=float(p['productPrice']))
                       for p in (c.get('componentPrices') or []) if p.get('productPrice') is not None],
               lifecycle=_lifecycle(desc))
    if c.get('dataManualUrl'):
        out['datasheet'] = c['dataManualUrl']
    return {k: v for k, v in out.items() if v is not None}


def from_lcsc(r):
    desc = r.get('productIntroEn') or ''
    out = dict(lcsc=r['productCode'], mpn=r.get('productModel') or '', maker=r.get('brandNameEn'),
               package=r.get('encapStandard'), description=desc, stock=int(r.get('stockNumber') or 0),
               prices=[dict(qty=int(p['ladder']), usd=float(p['usdPrice'])) for p in r.get('productPriceList') or []],
               lifecycle=_lifecycle(desc))
    if r.get('pdfUrl'):
        out['datasheet'] = r['pdfUrl']
    return {k: v for k, v in out.items() if v is not None}


def search(query, limit=10):
    """Keyword search at JLCPCB (what its assembly line stocks)."""
    limit = max(1, min(int(limit), 50))
    try:
        d = _cached('jlc:%s:%d' % (query, limit),
                    lambda: fetch(JLC_SEARCH, {'keyword': query, 'currentPage': 1, 'pageSize': limit}))
    except OSError as e:
        raise CatalogError('JLCPCB catalogue unreachable: %s' % e)
    rows = ((d.get('data') or {}).get('componentPageInfo') or {}).get('list') or []
    return [from_jlc(c) for c in rows[:limit]]


def get(codes):
    """Detail for LCSC numbers; the JLCPCB listing (for basic/extended) is
    merged in when the catalogue answers a search by the number."""
    out = []
    for code in codes:
        try:
            r = _cached('lcsc:' + code, lambda: fetch(LCSC_DETAIL + code))
        except OSError as e:
            raise CatalogError('LCSC catalogue unreachable: %s' % e)
        res = r.get('result')
        if not res:
            continue
        part = from_lcsc(res)
        try:
            for j in search(code, 5):
                if j['lcsc'] == code:
                    part['tier'] = j.get('tier')
                    break
        except CatalogError:
            pass
        out.append(part)
    return out
