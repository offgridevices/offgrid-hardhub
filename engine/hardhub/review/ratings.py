# SPDX-License-Identifier: AGPL-3.0-or-later
"""What each part can take: temperature range, voltage, current, power.

A design can state a part's limits itself (`part.ratings`, read from the
datasheet).  What it leaves out is filled in here, in three grades:

  design     the design's own `part.ratings`
  datasheet  read from the part's own text ("16V X7R", "1/10W") or from the
             small table of part families below, each entry from that
             family's datasheet
  typical    a generic default for the kind of part and its size; listed in
             `assumed`, so every check that relies on it can say so

    ratings(part) -> {temp_min, temp_max, voltage_max, current_max, power_max,
                      theta_jb, dropout, efficiency, assumed: [...], source: {field: grade}, ...}

The tables are kept small on purpose: a short list of numbers with their
sources beats a long list nobody can check.
"""
import re

FIELDS = ('temp_min', 'temp_max', 'voltage_max', 'current_max', 'power_max', 'theta_jb', 'dropout', 'efficiency')

# ------------------------------------------------------------------ parsing

_SI = {'p': 1e-12, 'n': 1e-9, 'u': 1e-6, 'µ': 1e-6, 'μ': 1e-6, 'm': 1e-3}


def text(part):
    """Everything a part says about itself, for searching."""
    return ' '.join(str(part.get(k) or '') for k in ('value', 'description', 'mpn'))


def parse_capacitance(s):
    """'100nF' -> 1e-7, '10uF' 10e-6, '4.7µF', '4u7', '2n2', '100n' (no F), '22 pF'."""
    if not s:
        return None
    s = str(s)
    m = re.search(r'(\d+(?:\.\d+)?)\s*([pnuµμm])\s*F\b', s, re.I)
    if m:
        return float(m.group(1)) * _SI[m.group(2).lower() if m.group(2) not in 'µμ' else m.group(2)]
    m = re.search(r'(?<![\w.])(\d+)([pnuµμ])(\d+)(?![\w.])', s)          # 4u7, 2n2
    if m:
        return float('%s.%s' % (m.group(1), m.group(3))) * _SI[m.group(2)]
    m = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*([pnuµμ])\s*', s)               # a bare value field: "100n"
    if m:
        return float(m.group(1)) * _SI[m.group(2)]
    return None


def parse_voltage(s):
    """'16V' -> 16, '6.3 V', '50VDC', '6V3' -> 6.3.  The first one found."""
    if not s:
        return None
    s = str(s)
    m = re.search(r'(?<![\w.])(\d+(?:\.\d+)?)\s*V(?:DC)?(?![a-zA-Z\d])', s)
    if m:
        return float(m.group(1))
    m = re.search(r'(?<![\w.])(\d+)V(\d)(?!\d)', s)                         # 6V3
    if m:
        return float('%s.%s' % (m.group(1), m.group(2)))
    return None


DIELECTRICS = {'X5R': 'X5R', 'X7R': 'X7R', 'X6S': 'X6S', 'X7S': 'X7S', 'X8R': 'X8R', 'C0G': 'C0G', 'COG': 'C0G',
               'NP0': 'C0G', 'NPO': 'C0G', 'Y5V': 'Y5V', 'Z5U': 'Z5U'}
# Makers' part-number codes for the dielectric, for parts whose description leaves it out:
# Samsung CL<size><dielectric>: A = X5R, B = X7R, C = C0G (Samsung MLCC part numbering guide);
# Murata GRM<size><height><dielectric>: R6 = X5R, R7 = X7R, 5C = C0G (Murata part numbering)
_SAMSUNG = {'A': 'X5R', 'B': 'X7R', 'C': 'C0G', 'F': 'Y5V'}
_MURATA = {'R6': 'X5R', 'R7': 'X7R', '5C': 'C0G', 'C7': 'X7S', 'C8': 'X6S'}


def parse_dielectric(part_or_text):
    s = text(part_or_text) if isinstance(part_or_text, dict) else str(part_or_text or '')
    m = re.search(r'\b(X5R|X7R|X6S|X7S|X8R|C0G|COG|NP0|NPO|Y5V|Z5U)\b', s, re.I)
    if m:
        return DIELECTRICS[m.group(1).upper()]
    mpn = part_or_text.get('mpn', '') if isinstance(part_or_text, dict) else ''
    m = re.match(r'CL\d\d([A-Z])', mpn)
    if m and m.group(1) in _SAMSUNG:
        return _SAMSUNG[m.group(1)]
    m = re.match(r'GR[MJ]\d{3}([A-Z0-9]{2})', mpn)
    if m and m.group(1) in _MURATA:
        return _MURATA[m.group(1)]
    return None


def parse_resistance(s):
    """'4.7k' -> 4700, '10K', '4k7', '1R', '0R' -> 0, '2R2', '1M' (mega), '100m' / '100mΩ' (milli),
    '100', '10kΩ', '10 kohm'."""
    if s is None:
        return None
    s = str(s).strip()
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*([RrKkM]|m|G)?(\d+)?\s*(?:Ω|ohms?|Ohms?)?', s)
    if m:
        return _res(m)
    # inside a description: a number with a unit letter or ohm sign ("Resistor 10k 1% 0402")
    m = re.search(r'(?<![\w.])(\d+(?:\.\d+)?)\s*([RrKkM]|m|G)(\d+)?(?:\s*(?:Ω|ohms?))?(?![\w%])', s) \
        or re.search(r'(?<![\w.])(\d+(?:\.\d+)?)\s*()()(?:Ω|ohms?)', s)
    return _res(m) if m else None


def _res(m):
    mult = {'': 1, 'R': 1, 'r': 1, 'k': 1e3, 'K': 1e3, 'M': 1e6, 'm': 1e-3, 'G': 1e9}[m.group(2) or '']
    whole = m.group(1)
    if m.group(3):                                   # 4k7, 2R2: the letter is the decimal point
        whole = '%s.%s' % (whole, m.group(3))
    return float(whole) * mult


def parse_tolerance(part):
    """'1%' -> 0.01; UNI-ROYAL / Yageo style codes (…WGF…: F = 1 %, J = 5 %) when the text has none."""
    m = re.search(r'(?:±\s*)?(\d+(?:\.\d+)?)\s*%', (part.get('value') or '') + ' ' + (part.get('description') or ''))
    if m:
        return float(m.group(1)) / 100
    m = re.match(r'\d{4}W[A-Z]([FJDG])\d', part.get('mpn', ''))     # 0402WGF1001TCE (UNI-ROYAL)
    if m:
        return {'F': 0.01, 'J': 0.05, 'D': 0.005, 'G': 0.02}[m.group(1)]
    return None


_SIZES = ('01005', '0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512')


def package(part):
    """The package or chip size code from the footprint name (and text): '0402', 'SOT-223', ..."""
    fp = (part.get('footprint') or '').split(':')[-1]
    m = re.search(r'_(\d{4,5})_\d{4}Metric', fp)                       # KiCad: R_0402_1005Metric
    if m and m.group(1) in _SIZES:
        return m.group(1)
    s = fp + ' ' + (part.get('description') or '')
    for pat, name in ((r'SOT-?223', 'SOT-223'), (r'SOT-?23-?6', 'SOT-23-6'), (r'SOT-?23-?5', 'SOT-23-5'),
                      (r'SOT-?23', 'SOT-23'), (r'SOT-?89', 'SOT-89'), (r'TO-?252|DPAK', 'TO-252'),
                      (r'TO-?263|D2PAK', 'TO-263'), (r'TO-?220', 'TO-220'), (r'SOD-?123', 'SOD-123'),
                      (r'SOD-?323', 'SOD-323'), (r'SMA\b|DO-?214AC', 'SMA'), (r'SMB\b|DO-?214AA', 'SMB'),
                      (r'SOIC|SO-8\b', 'SOIC'), (r'TSSOP|MSOP', 'TSSOP'), (r'[QD]FN', 'QFN'),
                      (r'ESP32|WROOM|MINI-1', 'module')):
        if re.search(pat, s, re.I):
            return name
    m = re.search(r'(?<!\d)(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?!\d)', s)
    return m.group(1) if m else None


def cap_type(part):
    """'ceramic', 'tantalum', 'polymer' or 'electrolytic'."""
    s = text(part) + ' ' + (part.get('footprint') or '')
    if re.search(r'polymer', s, re.I):
        return 'polymer'
    if re.search(r'tantal|CP_Tantalum', s, re.I):
        return 'tantalum'
    if re.search(r'electrolytic|CP_Elec|aluminium|aluminum', s, re.I):
        return 'electrolytic'
    return 'ceramic'


LED_VF = {   # forward voltage at a few mA, by colour (typical small SMD LEDs: AlGaInP red/yellow, InGaN green/blue/white)
    'red': 2.0, 'orange': 2.1, 'amber': 2.1, 'yellow': 2.1, 'green': 3.0, 'blue': 3.0, 'white': 3.0, 'ir': 1.3,
    'infrared': 1.3, 'uv': 3.3,
}


def led_colour(part):
    s = text(part).lower()
    for c in ('infrared', 'white', 'blue', 'green', 'yellow', 'amber', 'orange', 'red', 'uv', 'ir'):
        if re.search(r'\b%s\b' % c, s):
            return 'ir' if c == 'infrared' else c
    return None


# ------------------------------------------------------------------ part families (datasheet values)
#
# Matched by the start of the part number (upper case, ignoring the maker's
# suffixes).  Each entry quotes the datasheet the numbers come from.  'kind'
# marks regulators: 'ldo', 'buck' or 'boost'.  For regulators: current_max is
# the rated output current, voltage_max the maximum input, dropout the input
# minus output it needs at full load (datasheet maximum where given),
# vin_min the lowest input it works from, cin/cout the input and output
# capacitance its datasheet asks for (farads).
FAMILIES = [
    # AMS1117 datasheet (Advanced Monolithic Systems): 1 A output; dropout 1.3 V max at 1 A (1.1 V typical);
    # input 15 V absolute maximum; operating junction -40..125 °C; SOT-223 junction-to-tab 15 °C/W;
    # application circuit 10 µF input, 22 µF output (10 µF minimum for stability)
    # (pins: SOT-223 / SOT-89 pinout, 1 = GND or ADJ, 2 = output (and the tab), 3 = input)
    ('AMS1117', dict(kind='ldo', current_max=1.0, dropout=1.3, voltage_max=15.0, temp_min=-40, temp_max=125,
                     theta_jb=15.0, cin=10e-6, cout=10e-6, pin_in='3', pin_out='2', note='AMS1117 datasheet')),
    ('LM1117', dict(kind='ldo', current_max=0.8, dropout=1.2, voltage_max=15.0, temp_min=0, temp_max=125,
                    theta_jb=15.0, cin=10e-6, cout=10e-6, pin_in='3', pin_out='2',
                    note='TI LM1117 datasheet (0..125 °C junction for the base grade)')),
    # Diodes Inc. AP2112: 600 mA, dropout 400 mV max at 600 mA, 6.5 V absolute maximum input (6 V operating),
    # -40..85 °C ambient, 1 µF in and out
    ('AP2112', dict(kind='ldo', current_max=0.6, dropout=0.4, voltage_max=6.0, temp_min=-40, temp_max=85,
                    cin=1e-6, cout=1e-6, note='Diodes AP2112 datasheet')),
    # Torex XC6206: 200 mA, 6 V maximum input, -40..85 °C; dropout 250 mV typical at 100 mA,
    # taken as 0.6 V at the full 200 mA (the datasheet's dropout curve)
    ('XC6206', dict(kind='ldo', current_max=0.2, dropout=0.6, voltage_max=6.0, temp_min=-40, temp_max=85,
                    cin=1e-6, cout=1e-6, note='Torex XC6206 datasheet')),
    # Microne ME6211: 500 mA, 6 V maximum input, -40..85 °C; dropout 100 mV at 100 mA, about 0.5 V at 500 mA
    ('ME6211', dict(kind='ldo', current_max=0.5, dropout=0.5, voltage_max=6.0, temp_min=-40, temp_max=85,
                    cin=1e-6, cout=1e-6, note='Microne ME6211 datasheet')),
    # Richtek RT9013: 500 mA, dropout 250 mV at 500 mA, 5.5 V operating input (6 V absolute), -40..85 °C
    ('RT9013', dict(kind='ldo', current_max=0.5, dropout=0.25, voltage_max=5.5, temp_min=-40, temp_max=85,
                    cin=1e-6, cout=1e-6, note='Richtek RT9013 datasheet')),
    # TI TPS563200: 3 A synchronous buck, 4.5..17 V input, about 90 % efficient at 5 V -> 3.3 V, -40..125 °C junction
    ('TPS563200', dict(kind='buck', current_max=3.0, voltage_max=17.0, vin_min=4.5, efficiency=0.9, temp_min=-40,
                       temp_max=125, cin=10e-6, cout=22e-6, note='TI TPS563200 datasheet')),
    # MPS MP1584: 3 A buck, 4.5..28 V input, about 85-90 % efficient, -40..125 °C junction
    ('MP1584', dict(kind='buck', current_max=3.0, voltage_max=28.0, vin_min=4.5, efficiency=0.85, temp_min=-40,
                    temp_max=125, cin=10e-6, cout=22e-6, note='MPS MP1584 datasheet')),
    # TI LM2596: 3 A non-synchronous buck, 4.5..40 V input, about 80 % efficient at 5 V out, -40..125 °C junction
    ('LM2596', dict(kind='buck', current_max=3.0, voltage_max=40.0, vin_min=4.5, efficiency=0.8, temp_min=-40,
                    temp_max=125, cin=680e-6, cout=220e-6, note='TI LM2596 datasheet')),
    # Espressif modules: supply 3.0..3.6 V (3.6 V is also the absolute maximum), operating ambient from the
    # module datasheets.  ESP32-S3-WROOM-1 versions with octal PSRAM (…R8, …R16V) are rated -40..65 °C only;
    # H-versions (high temperature) -40..105 °C
    ('ESP32-C3-WROOM-02', dict(voltage_max=3.6, temp_min=-40, temp_max=85, theta_jb=10.0,
                               note='Espressif ESP32-C3-WROOM-02 datasheet')),
    ('ESP32-C3-MINI-1', dict(voltage_max=3.6, temp_min=-40, temp_max=85, theta_jb=10.0,
                             note='Espressif ESP32-C3-MINI-1 datasheet (N4; H4 versions -40..105 °C)')),
    ('ESP32-S3-WROOM-1', dict(voltage_max=3.6, temp_min=-40, temp_max=85, theta_jb=10.0,
                              note='Espressif ESP32-S3-WROOM-1 datasheet')),
    ('ESP32-WROOM-32', dict(voltage_max=3.6, temp_min=-40, temp_max=85, theta_jb=10.0,
                            note='Espressif ESP32-WROOM-32E datasheet')),
    # Sensirion SHT4x: supply 1.08..3.6 V, operating -40..125 °C (SHT4x datasheet)
    ('SHT4', dict(voltage_max=3.6, temp_min=-40, temp_max=125, note='Sensirion SHT4x datasheet')),
    # UNI-ROYAL thick-film chip resistors: 0402WGF = 1/16 W, 50 V; 0603WAF = 1/10 W, 75 V; -55..155 °C
    ('0402WG', dict(power_max=1 / 16, voltage_max=50.0, temp_min=-55, temp_max=155, note='UNI-ROYAL chip resistor datasheet')),
    ('0603WA', dict(power_max=0.1, voltage_max=75.0, temp_min=-55, temp_max=155, note='UNI-ROYAL chip resistor datasheet')),
    # Everlight 19-217 0603 LEDs: 25 mA absolute maximum forward current (20 mA used as the limit), -40..85 °C
    ('19-217', dict(current_max=0.02, temp_min=-40, temp_max=85, note='Everlight 19-217 datasheet')),
]


def family(part):
    """(prefix, entry) of the part's family, or (None, None)."""
    mpn = (part.get('mpn') or '').upper()
    for prefix, f in FAMILIES:
        if mpn.startswith(prefix.upper()):
            # S3-WROOM-1 versions with octal PSRAM are rated to 65 °C only (module datasheet, ordering table)
            if prefix == 'ESP32-S3-WROOM-1' and re.search(r'R(8|16)', mpn):
                f = dict(f, temp_max=65, note=f['note'] + ' (octal-PSRAM version: -40..65 °C)')
            if prefix.startswith('ESP32') and re.search(r'-H\d', mpn):
                f = dict(f, temp_max=105, note=f['note'] + ' (high-temperature version)')
            return prefix, f
    return None, None


# ------------------------------------------------------------------ regulators

_REG = re.compile(r'\b(LDO|regulator|buck|boost|DC-?DC|DC/DC|step-?down|step-?up|switching converter)\b', re.I)


def regulator(part):
    """None, or {kind: ldo|buck|boost, vout (fixed output, if the part says), current_max, dropout,
    voltage_max (max input), vin_min, efficiency, cin, cout, source}.  Missing numbers are typical values,
    listed in 'assumed'."""
    if part.get('kind') not in ('U', 'MOD', 'other'):
        return None
    pre, fam = family(part)
    s = text(part)
    if not (fam and fam.get('kind')) and not _REG.search(s):
        return None
    if re.search(r'reference|supervisor|charger|driver', part.get('description', ''), re.I) and not fam:
        return None
    if fam and fam.get('kind'):
        kind = fam['kind']
    elif re.search(r'LDO|linear', s, re.I):
        kind = 'ldo'
    elif re.search(r'boost|step-?up', s, re.I):
        kind = 'boost'
    elif re.search(r'buck|step-?down|DC-?DC|DC/DC|switching', s, re.I):
        kind = 'buck'
    else:
        kind = 'ldo'                                 # "voltage regulator" with nothing else: most are linear
    out = dict(kind=kind, family=pre, assumed=[])
    m = re.search(r'-(\d{1,2}\.\d{1,2})(?![\d])', part.get('mpn', '')) or re.search(r'-(\d\.\d)', part.get('value') or '')
    if m:
        out['vout'] = float(m.group(1))
    # typical values for a regulator nobody has told us about: a small LDO (SOT-23 class) delivers
    # about 300 mA with about 0.3 V dropout and takes up to 6 V in (AP2112 / XC6206 / ME6211 class);
    # a generic buck about 85 % efficient (makers' efficiency curves at mid load)
    typical = dict(ldo=dict(current_max=0.3, dropout=0.3, voltage_max=6.0, cin=1e-6, cout=1e-6),
                   buck=dict(current_max=1.0, voltage_max=18.0, vin_min=None, efficiency=0.85, cin=10e-6, cout=22e-6),
                   boost=dict(current_max=0.5, voltage_max=5.5, vin_min=None, efficiency=0.85, cin=10e-6, cout=22e-6))[kind]
    for k, v in typical.items():
        if fam and fam.get(k) is not None:
            out[k] = fam[k]
        else:
            out[k] = v
            if v is not None:
                out['assumed'].append(k)
    if kind == 'ldo':
        out['efficiency'] = None
    out['source'] = fam['note'] if fam else 'typical values'
    if fam and fam.get('pin_in') and re.search(r'SOT-?223|SOT-?89', part.get('footprint', ''), re.I):
        out['pin_in'], out['pin_out'] = fam['pin_in'], fam['pin_out']
    return out


# ------------------------------------------------------------------ generic defaults (typical)

# Thick-film chip resistors, rated power at 70 °C and maximum working voltage by size
# (Yageo RC series / Vishay CRCW datasheets; UNI-ROYAL the same): -55..155 °C
RES_POWER = {'01005': 0.03, '0201': 0.05, '0402': 1 / 16, '0603': 0.1, '0805': 0.125, '1206': 0.25, '1210': 0.5,
             '1812': 0.75, '2010': 0.75, '2512': 1.0}
RES_VMAX = {'01005': 15.0, '0201': 25.0, '0402': 50.0, '0603': 75.0, '0805': 150.0, '1206': 200.0, '1210': 200.0,
            '1812': 200.0, '2010': 200.0, '2512': 200.0}
# the most any resistor of that size is made for (high-power and anti-surge series: Panasonic ERJ-P,
# Vishay CRCW-HP, Yageo RC-P).  With the rating only assumed from the size, a power above this fails
# anyway: no part of that size would take it
RES_POWER_ANY = {'01005': 0.05, '0201': 0.1, '0402': 0.2, '0603': 0.25, '0805': 0.5, '1206': 0.75, '1210': 1.0,
                 '1812': 1.0, '2010': 1.0, '2512': 2.0}
# temperature rise of a chip resistor on an FR4 board per watt (°C/W), for its own heating
# (makers' application notes, e.g. Vishay "Thermal management of chip resistors"; rough, board-dependent)
RES_THETA = {'01005': 600.0, '0201': 500.0, '0402': 400.0, '0603': 250.0, '0805': 170.0, '1206': 100.0, '1210': 80.0,
             '1812': 60.0, '2010': 60.0, '2512': 50.0}
# EIA-198 class II/I temperature codes: the dielectric's rated range
DIELECTRIC_TEMP = {'X5R': (-55, 85), 'X7R': (-55, 125), 'X6S': (-55, 105), 'X7S': (-55, 125), 'X8R': (-55, 150),
                   'C0G': (-55, 125), 'Y5V': (-30, 85), 'Z5U': (10, 85)}
# junction-to-board thermal resistance by package, °C/W (JEDEC JESD51 figures in TI/ON datasheets, typical)
THETA_JB = {'SOT-23': 60.0, 'SOT-23-5': 50.0, 'SOT-23-6': 50.0, 'SOT-89': 25.0, 'SOT-223': 15.0, 'TO-252': 8.0,
            'TO-263': 5.0, 'SOIC': 50.0, 'TSSOP': 50.0, 'QFN': 20.0, 'module': 10.0}
# connectors: current per contact (A), typical makers' ratings
CONNECTOR_CURRENT = [
    (r'USB[-_ ]?C|TYPE-?C', 1.25, 'USB Type-C spec: 5 A over four VBUS contacts, 1.25 A each'),
    (r'USB', 1.0, 'USB 2.0 receptacles: about 1 A per contact (typical datasheets)'),
    (r'PinHeader|pin header|PZ254|2\.54', 3.0, 'typical 2.54 mm pin header: 3 A per pin'),
    (r'JST.*PH|\bPH\b|S\dB-PH', 2.0, 'JST PH datasheet: 2 A per contact'),
    (r'JST.*XH|\bXH\b|B\dB-XH', 3.0, 'JST XH datasheet: 3 A per contact'),
    (r'BarrelJack|barrel|DC jack|DC-?0\d\d', 2.0, 'typical 5.5 x 2.1 mm DC jack: 2 A'),
    (r'TerminalBlock|terminal', 10.0, 'typical 5 mm screw terminal: 10 A or more'),
]


def ratings(part, comp=None):
    """The part's limits, merged: design > datasheet (text, family) > typical defaults."""
    kind = part.get('kind')
    pkg = package(part)
    out, grade = {}, {}

    def put(k, v, g):
        if v is not None and k not in out:
            out[k] = v
            grade[k] = g

    for k, v in (part.get('ratings') or {}).items():
        if k in FIELDS and v is not None:
            put(k, float(v), 'design')
    pre, fam = family(part)
    if fam:
        for k in FIELDS:
            put(k, fam.get(k), 'datasheet')
    reg = regulator(part)
    if reg:
        for k in ('current_max', 'dropout', 'voltage_max', 'efficiency'):
            put(k, reg.get(k), 'typical' if k in reg['assumed'] else 'datasheet')

    s = text(part)
    if kind == 'C':
        put('voltage_max', parse_voltage(part.get('value')) or parse_voltage(part.get('description')), 'datasheet')
        put('voltage_max', 6.3, 'typical')       # the lowest common rating: safest to assume
        ct = cap_type(part)
        d = parse_dielectric(part)
        if ct == 'ceramic' and d:
            put('temp_min', DIELECTRIC_TEMP[d][0], 'datasheet')
            put('temp_max', DIELECTRIC_TEMP[d][1], 'datasheet')
        elif ct == 'tantalum':
            put('temp_min', -55, 'typical'); put('temp_max', 125, 'typical')     # KEMET T491 class
        elif ct == 'electrolytic':
            m = re.search(r'\b(85|105|125)\s*°?\s*C\b', s)
            put('temp_max', float(m.group(1)) if m else 85.0, 'datasheet' if m else 'typical')
            put('temp_min', -40, 'typical')
        else:
            put('temp_min', -55, 'typical'); put('temp_max', 85, 'typical')       # X5R, the narrowest common
    elif kind == 'R':
        m = re.search(r'(?<![\d.])(\d+)\s*/\s*(\d+)\s*W\b', s) or None
        if m:
            put('power_max', float(m.group(1)) / float(m.group(2)), 'datasheet')
        else:
            m = re.search(r'(?<![\w.])(\d+(?:\.\d+)?)\s*(m?)W\b', s)
            if m:
                put('power_max', float(m.group(1)) * (1e-3 if m.group(2) else 1), 'datasheet')
        put('power_max', RES_POWER.get(pkg, 1 / 16), 'typical')
        put('voltage_max', RES_VMAX.get(pkg, 50.0), 'typical')
        put('temp_min', -55, 'typical'); put('temp_max', 155, 'typical')
    elif kind == 'LED':
        put('current_max', 0.02, 'typical')      # 20 mA continuous: the usual rating of small SMD LEDs
        put('temp_min', -40, 'typical'); put('temp_max', 85, 'typical')
    elif kind in ('D', 'Q'):
        put('temp_min', -55, 'typical'); put('temp_max', 150, 'typical')         # junction range of small discretes
    elif kind == 'J':
        for pat, amps, why in CONNECTOR_CURRENT:
            if re.search(pat, s + ' ' + (part.get('footprint') or ''), re.I):
                put('current_max', amps, 'typical')
                out.setdefault('_current_why', why)
                break
        put('current_max', 1.0, 'typical')
        put('temp_min', -40, 'typical'); put('temp_max', 85, 'typical')
    elif kind == 'SW':
        put('temp_min', -20, 'typical'); put('temp_max', 70, 'typical')           # small tactile switches
    elif kind in ('Y',):
        put('temp_min', -20, 'typical'); put('temp_max', 70, 'typical')           # commercial crystals
    elif kind in ('L', 'FB', 'F'):
        put('temp_min', -40, 'typical'); put('temp_max', 125, 'typical')
    elif kind in ('U', 'MOD'):
        # a chip says nothing: commercial grade 0..70 °C, unless its text says industrial or automotive
        if re.search(r'industrial|automotive|AEC-?Q|-40\s*(?:°?C)?\s*(?:to|~|\.\.|-)\s*\+?(85|105|125)', s, re.I):
            m = re.search(r'-40\s*(?:°?C)?\s*(?:to|~|\.\.|-)\s*\+?(85|105|125)', s)
            put('temp_min', -40, 'datasheet' if m else 'typical')
            put('temp_max', float(m.group(1)) if m else 85.0, 'datasheet' if m else 'typical')
        put('temp_min', 0, 'typical'); put('temp_max', 70, 'typical')
        m = re.search(r'(\d+(?:\.\d+)?)\s*(?:V)?\s*(?:-|to|~)\s*(\d+(?:\.\d+)?)\s*V\b', part.get('description') or '')
        if m and not reg:
            put('voltage_max', float(m.group(2)), 'datasheet')                   # "1.8-3.6 V supply"
        if pkg in THETA_JB:
            put('theta_jb', THETA_JB[pkg], 'typical')
    out['assumed'] = sorted(k for k, g in grade.items() if g == 'typical')
    out['source'] = grade
    out['package'] = pkg
    out['family'] = fam.get('note') if fam else None
    for k in FIELDS:
        out.setdefault(k, None)
    return out


# ------------------------------------------------------------------ capacitors under voltage and temperature

# typical case volume (L x W x T, mm³) of each MLCC size, for the DC-bias estimate
CASE_VOLUME = {'01005': 0.4 * 0.2 * 0.2, '0201': 0.6 * 0.3 * 0.3, '0402': 1.0 * 0.5 * 0.5, '0603': 1.6 * 0.8 * 0.8,
               '0805': 2.0 * 1.25 * 1.25, '1206': 3.2 * 1.6 * 1.6, '1210': 3.2 * 2.5 * 2.5, '1812': 4.5 * 3.2 * 2.0}
# K below, volts: fitted to makers' typical DC-bias curves (Samsung CL10A226MQ8 22 µF/6.3 V/0603 ~35 %
# left at 3.3 V; CL10A106 10 µF/0603 ~40 % at 5 V; Murata GRM155R61A105 1 µF/0402 ~70 % at 3.3 V;
# GRM21BR61E106 10 µF/0805 ~30 % at 12 V); Y5V is far worse
_K = {'X5R': 11.0, 'X7R': 11.0, 'X6S': 11.0, 'X7S': 11.0, 'X8R': 11.0, 'Y5V': 4.0, 'Z5U': 4.0}


def mlcc_remaining(part, volts, temp):
    """Fraction of a ceramic capacitor's marked value left at `volts` DC and `temp` °C (typical, not
    guaranteed): None if it is not a class II ceramic or the numbers are missing.

    Why this shape: a class II ceramic loses capacitance as the field across its layers grows.  For a
    given size, the more capacitance a maker fits in, the thinner the layers (t ~ sqrt(volume / C)),
    so the voltage at which half the value is gone is V50 = K * sqrt(volume / C).  The value left is
    1 / (1 + (V / V50)^2), times the dielectric's temperature limit (X5R/X7R: -15 % at the ends of its
    range, EIA-198), interpolated from 25 °C."""
    d = parse_dielectric(part)
    c = parse_capacitance(part.get('value')) or parse_capacitance(part.get('description'))
    pkg = package(part)
    if cap_type(part) != 'ceramic' or not c:
        return None
    if d == 'C0G':
        return 1.0
    if d not in _K or pkg not in CASE_VOLUME:
        return None
    v50 = _K[d] * (CASE_VOLUME[pkg] / (c * 1e6)) ** 0.5
    bias = 1.0 / (1.0 + (abs(volts) / v50) ** 2)
    lo, hi = DIELECTRIC_TEMP[d]
    swing = {'Y5V': 0.82, 'Z5U': 0.56, 'X6S': 0.22, 'X7S': 0.22}.get(d, 0.15)
    if temp >= 25:
        t = 1 - swing * min(1.0, (temp - 25) / (hi - 25))
    else:
        t = 1 - swing * min(1.0, (25 - temp) / (25 - lo))
    return bias * t
