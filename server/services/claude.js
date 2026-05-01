// Claude API integration. Uses Opus 4.7 with adaptive thinking and prompt caching
// for the rates database (the stable prefix on every quantification request).

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const MODEL = 'claude-opus-4-7';

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY must be set in .env');
  }
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

const RATES_PATH = path.join(__dirname, '..', 'data', 'rates.json');
function loadRates() {
  return JSON.parse(fs.readFileSync(RATES_PATH, 'utf8'));
}

// Build a stable, deterministically-serialized rates blob so the cache prefix
// is identical request-to-request.
function serializeRates() {
  const r = loadRates();
  const lines = ['# Halford Rate Library', `Source: ${r._meta.source}`, `Currency: ${r._meta.currency}`, ''];
  lines.push('## Element rates (BoQ codes)');
  for (const code of Object.keys(r.elements).sort()) {
    const e = r.elements[code];
    lines.push(`${e.code} | ${e.section} | ${e.discipline} | ${e.desc} | ${e.unit} | ${e._meta?.source || 'RLB'} | ${r._meta.currency} ${e.rate}/${e.unit}`);
  }
  lines.push('', '## Resource rates');
  for (const code of Object.keys(r.resources).sort()) {
    const x = r.resources[code];
    lines.push(`${x.code} | ${x.type} | ${x.desc} | ${x.unit} | ${r._meta.currency} ${x.rate}/${x.unit} | ${x.productivity}`);
  }
  return lines.join('\n');
}

const RATES_SYSTEM = serializeRates();

const ELEMENT_SCHEMA = {
  type: 'object',
  properties: {
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Halford rate code from the rate library, or new code if not present' },
          desc: { type: 'string', description: 'Element description with size/spec' },
          discipline: { type: 'string', enum: ['Structural', 'Architectural', 'MEP', 'Civil'] },
          section: { type: 'string', description: 'Cost-plan section: Preliminaries | Substructure | Frame | Roof | Envelope | Internal walls | Finishes | MEP | External' },
          qty: { type: 'number' },
          unit: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 100 },
          source: { type: 'string', description: 'Source drawing reference' },
        },
        required: ['code', 'desc', 'discipline', 'section', 'qty', 'unit', 'confidence', 'source'],
        additionalProperties: false,
      },
    },
    gfa: { type: 'number', description: 'Gross floor area in m²' },
    notes: { type: 'string' },
  },
  required: ['elements', 'gfa'],
  additionalProperties: false,
};

// Compress APS properties into a structured QS-relevant summary.
// No element ceiling — every element from every viewable is processed and grouped
// by IFC/Revit category. Identical instances (e.g. 248× same-size column) are
// aggregated to a single line with a sample of dimensions/materials, but the
// counts are preserved so Claude sees the true quantity in the model.
function compressProperties(properties, drawingName) {
  // QS-relevant property categories. Covers Revit (Constraints/Dimensions/Identity Data/...),
  // IFC (IFC.*), and AutoCAD/DWG (Block Attributes/Object Data/AEC/Layer/Property Sets/XData).
  // For DWGs especially, dimensioned data lives in Block Attributes and Object Data tables —
  // not in Revit-style "Dimensions" — so we widen the filter to capture them.
  const interesting = /^(Constraints|Dimensions|Identity Data|Materials and Finishes|Structural|Mechanical|Electrical|Plumbing|Pipes|Ducts|Other|Construction|Phasing|IFC.*|Element|Type|Analytical|Energy Analysis|Type Mark|Mark|Comments|Block Attributes?|Object Data|AEC.*|XData|Extended.*|Layer|AutoCAD.*|Property Set.*|Annotation.*|User.*Data|Custom.*|General|Geometry|Quantities?)$/i;

  // Map element family/type → IFC discipline bucket. Drives section assignment downstream.
  function disciplineFor(name, props) {
    const lower = (name || '').toLowerCase();
    const cat   = (props['Element']?.Category || props['Other']?.Category || '').toLowerCase();
    const text  = lower + ' ' + cat;
    if (/(column|beam|slab|wall (struct|core)|foundation|footing|pile|raft|reinforcement|rebar|frame|truss|brace)/.test(text)) return 'Structural';
    if (/(door|window|curtain|cladding|fa[çc]ade|roof|ceiling|floor finish|tile|partition|gypsum|drywall|stair|railing|balustrade)/.test(text)) return 'Architectural';
    if (/(duct|pipe|fcu|ahu|chiller|cooling|heating|hvac|sanitary|plumb|drain|tap|shower|wc|basin|sprinkler|fire|cctv|cable|conduit|fixture|panel|switch|socket|lighting|fitting|electrical|mep|equipment)/.test(text)) return 'MEP';
    if (/(road|paving|landscap|fence|gate|pool|external|drainage|manhole|kerb|hardscape)/.test(text)) return 'Civil/External';
    return 'Other';
  }

  const byCategory = new Map(); // discipline -> Map(typeName -> { count, sample, instances:[{view,objectid}] })
  let totalElements = 0;
  let totalParsed   = 0;

  for (const view of properties || []) {
    for (const obj of view.items || []) {
      totalParsed++;
      const name  = obj.name || `obj_${obj.objectid}`;
      const props = obj.properties || {};
      const summary = {};
      for (const cat of Object.keys(props)) {
        if (!interesting.test(cat)) continue;
        const subset = {};
        // No 8-key cap — capture every property in interesting categories.
        for (const k of Object.keys(props[cat])) {
          const v = props[cat][k];
          if (v != null && v !== '' && String(v).length < 200) subset[k] = v;
        }
        if (Object.keys(subset).length) summary[cat] = subset;
      }
      if (!Object.keys(summary).length) continue;
      const discipline = disciplineFor(name, props);
      const typeKey    = name.replace(/\s*\[\d+\]/g, '').trim();
      if (!byCategory.has(discipline)) byCategory.set(discipline, new Map());
      const bucket = byCategory.get(discipline);
      if (!bucket.has(typeKey)) bucket.set(typeKey, { count: 0, sample: summary, viewSet: new Set() });
      const b = bucket.get(typeKey);
      b.count++;
      b.viewSet.add(view.view);
      totalElements++;
    }
  }

  // Render structured by discipline → type → count + sample properties
  const lines = [
    `Drawing: ${drawingName}`,
    `Viewables processed: ${properties.length}`,
    `Total objects parsed: ${totalParsed.toLocaleString('en-US')}`,
    `Elements with QS-relevant properties: ${totalElements.toLocaleString('en-US')}`,
    `Distinct types: ${[...byCategory.values()].reduce((s, m) => s + m.size, 0)}`,
    '',
  ];

  // Stable display order
  const order = ['Structural', 'Architectural', 'MEP', 'Civil/External', 'Other'];
  for (const disc of order) {
    if (!byCategory.has(disc)) continue;
    const bucket = byCategory.get(disc);
    lines.push(`════════ ${disc.toUpperCase()} (${[...bucket.values()].reduce((s, b) => s + b.count, 0)} instances · ${bucket.size} types) ════════`);
    // Sort types by count desc — most numerous first so Claude sees the bulk quantities first
    const types = [...bucket.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [typeKey, v] of types) {
      lines.push(`# ${typeKey} × ${v.count}  [seen in ${v.viewSet.size} view${v.viewSet.size > 1 ? 's' : ''}]`);
      for (const [cat, kv] of Object.entries(v.sample)) {
        const kvStr = Object.entries(kv).map(([k, val]) => `${k}=${val}`).join(', ');
        // Wrap long lines for readability rather than truncate
        if (kvStr.length > 220) {
          lines.push(`  ${cat}:`);
          for (const [k, val] of Object.entries(kv)) lines.push(`    ${k} = ${val}`);
        } else {
          lines.push(`  ${cat}: ${kvStr}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Build the multimodal user message: text properties + per-drawing images (PNG thumbnails
// from APS) and raw PDFs (Claude reads PDFs natively as document blocks).
// Image/PDF size budget: Anthropic accepts up to 100 documents and many images per call.
// We attach every available preview so Claude can SEE the drawing rather than infer.
function buildUserContent({ projectName, projectType, location, drawingsBlock, drawings }) {
  const blocks = [];

  // 1. Project header (text)
  blocks.push({
    type: 'text',
    text:
`Project: ${projectName}
Type: ${projectType}
Location: ${location}

You will receive (a) compressed BIM/CAD properties below, and (b) attached images / PDFs of
the actual drawings. PRIORITISE reading from the attached images and PDFs — they contain
dimensioned plans, schedules, and elevations. Use the property summary as a cross-check,
not as the primary source.`,
  });

  // 2. Per-drawing visual content. Each drawing gets: name header → all sheet images → PDF (if any).
  for (const d of drawings || []) {
    // sheets is an array of { name, role, type, buffer } from APS renderSheets()
    const sheets = d.sheets || [];
    if (sheets.length) {
      blocks.push({ type: 'text', text: `\n──── Drawing: ${d.name} — ${sheets.length} sheet(s) ────` });
      for (const s of sheets) {
        blocks.push({ type: 'text', text: `Sheet: ${s.name} (${s.role}/${s.type})` });
        blocks.push({
          type: 'image',
          source: {
            type:       'base64',
            media_type: 'image/png',
            data:       s.buffer.toString('base64'),
          },
        });
      }
    } else if (d.image_buffer) {
      // Single-image fallback (older code path)
      blocks.push({ type: 'text', text: `\n──── Drawing: ${d.name} (image preview) ────` });
      blocks.push({
        type: 'image',
        source: {
          type:       'base64',
          media_type: d.image_media_type || 'image/png',
          data:       d.image_buffer.toString('base64'),
        },
      });
    }
    if (d.pdf_buffer) {
      blocks.push({ type: 'text', text: `\n──── Drawing: ${d.name} (full PDF) ────` });
      blocks.push({
        type: 'document',
        source: {
          type:       'base64',
          media_type: 'application/pdf',
          data:       d.pdf_buffer.toString('base64'),
        },
      });
    }
  }

  // 3. Compressed property text summary
  blocks.push({
    type: 'text',
    text: `\n\nParsed drawing properties (compressed from APS Properties API):\n\n${drawingsBlock}`,
  });

  // 4. Schema instruction
  blocks.push({
    type: 'text',
    text: `\n\nReturn JSON only, matching this schema:\n${JSON.stringify(ELEMENT_SCHEMA, null, 2)}`,
  });

  return blocks;
}

// Request element extraction from Claude. Uses prompt caching on the rate library
// + extraction system prompt so subsequent requests for the same project hit cache.
async function extractElements({ projectName, projectType, location, drawings }) {
  const c = client();

  const drawingsBlock = drawings.map(d => {
    const parts = [`## ${d.name}`];
    if (d.summary && String(d.summary).trim()) {
      parts.push(d.summary);
    }
    if (d.pdf_text && d.pdf_text.trim()) {
      parts.push(`\n[Text extracted from PDF via PyMuPDF — use for element and dimension identification]\n${d.pdf_text}`);
    }
    if (d.title_block && d.title_block.trim()) {
      parts.push(`\n[Title block / revision panel]\n${d.title_block}`);
    }
    if (!d.summary && !d.pdf_text) {
      parts.push(`(no parsed geometry — infer typical ${projectType} elements for a drawing titled "${d.name}")`);
    }
    return parts.join('\n');
  }).join('\n\n');

  // Render order: tools → system → messages. We put cache_control on the last
  // system block so the rates + system prompt cache together. Per-project
  // drawings vary, so they go in the user message after the breakpoint.
  // Use streaming to avoid SDK timeout on long extraction responses
  let fullText = '';
  const stream = await c.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: [
      {
        type: 'text',
        text:
`You are a Senior Chartered Quantity Surveyor (MRICS) performing a full elemental takeoff
for the Halford workbench. Your output drives a binding tender estimate, so missing categories
or under-counted quantities cause a contractor BoQ that comes in 30–50% above your estimate.
Your output must align to RICS NRM2 elemental classification.

WORKING METHOD — read these inputs from the drawings before extracting:
1. Title block / cover sheet → project type, GFA, number of storeys, parking bays.
2. Floor plans (every level) → room schedule, partition layout, door schedule, bathroom count,
   apartment/unit count, kitchen count, lift cores, staircases.
3. Sections / elevations → storey heights, façade type, parapet height, basement depth.
4. MEP drawings & equipment schedules → chiller schedule, AHU/FCU schedule, panel schedule,
   pump schedule, lift schedule (count of stops), sanitary schedule, fire panel schedule.
5. Door & window schedules → exact counts and types.
6. Specifications → finishes by area, MEP equipment ratings.
If a schedule exists in the drawing properties or PDF text, use the EXACT counts shown there.

MANDATORY element categories — every category below must appear in your output, with quantities
either read from drawings or derived from project type using the rules of thumb supplied.

SUBSTRUCTURE: bulk excavation, hardcore fill, blinding concrete, foundations (raft/pile caps/pads
  per geotech), pile lengths × pile count if piled, ground beams, formwork to foundations,
  reinforcement bar (Fe-500), tanking/waterproofing, dewatering provisional sum.

FRAME: ALL RC columns (count × storey height), beams, slabs (every floor including roof slab
  and ground slab on grade), shear walls, lift cores, staircases (count flights × storeys),
  parapet walls, lintels over openings, formwork (= concrete surface area × 6–8),
  reinforcement bar to superstructure (typical 90–120 kg/m³ of concrete for residential,
  130–160 kg/m³ for commercial), structural steel where applicable.

ROOF: waterproofing membrane (= roof area), insulation, screed to falls, roof finish,
  gutters & rainwater outlets (1 per 50 m² of roof).

ENVELOPE: external walls (blockwork + render), thermal insulation, curtain wall / unitised
  glazing / structural glazing as drawn, EVERY window (count from elevations or schedule),
  EVERY external door (entrance + service + garage rolling shutters), louvres,
  external painting (= envelope wall area).

INTERNAL WALLS: this is a MANDATORY section — never omit. Calculate by partition density:
  • Residential apartment: ~0.7–0.9 m² of partition per m² of GFA.
  • Office (open plan): 0.3–0.5 m² per m² GFA.
  • Hotel: 0.9–1.1 m² per m² GFA.
  • Hospital / lab: 1.0–1.3 m² per m² GFA.
  Mix of types: ~70% blockwork (load-bearing or wet area separation), ~30% drywall
  (between bedrooms / offices); 5–10% fire-rated FR60/FR90 (corridors, lift lobbies, plant rooms).

FINISHES — FLOORS: screed (all floors except roof slab), floor finishes by room — tile to wet
  rooms and kitchen, marble/timber/carpet to bedrooms & living, porcelain to corridors.
FINISHES — WALLS: wall tiling to wet areas (bath wall area + kitchen splashback × bathroom/kitchen
  count), feature walls, internal emulsion (= room wall area).
FINISHES — CEILINGS: suspended gypsum ceilings to all rooms typically; coffered/feature in
  living/dining/lobby.
FINISHES — JOINERY: every internal door (typical residential = 1 per room + 1 per bathroom +
  1 per service area), kitchen joinery (typical 4–8 m run per kitchen), built-in wardrobes
  (typical 3–5 m per bedroom), balustrades to all stairs & balconies, handrails, skirting
  (= room perimeter).
FINISHES — SANITARY FITTINGS: WC + washbasin + bath/shower per bathroom; kitchen sink per kitchen.
  Count from room schedule. Standard residential: 1 master bath + 1 powder room + 1 per other
  bedroom + 1 maid's bathroom.

MEP — HVAC (read equipment schedules; if absent, derive from cooling load):
  Cooling load rules of thumb (W/m² GFA): residential 80–110 · office 110–140 · retail 130–170
  · hotel 130–160 · hospital 160–200 · data centre 800–1500.
  Plant: 1 chiller per ~500 kW load (or DC plate heat exchanger if district cooling), CHW pumps
  duty/standby, primary CHW pipework (m = building footprint perimeter × storeys × 2).
  Distribution: FCUs (1 per ~25 m² in residential, 1 per ~40 m² in office), AHUs for fresh air
  / common areas, ductwork (kg = roughly 2–3 kg/m² GFA), grilles/diffusers (1 per ~15–20 m²),
  duct insulation. Smoke extract for parking & basements. Kitchen extract for F&B kitchens.

MEP — VERTICAL TRANSPORT (mandatory for buildings > 3 storeys):
  Lift count: residential ~1 lift per 50–60 apartments; office ~1 per 2,500 m² GFA; hotel
  guest lifts ~1 per 75 keys + service lifts 1 per 100 keys + fire lift always.
  Quantity = number of lifts × number of stops (= storeys served).
  Add: lift shaft pressurisation fans, escalators where applicable.

MEP — ELECTRICAL: 11kV RMU intake (high-rise/commercial), distribution transformer 1000 kVA
  per ~3,000–5,000 m² GFA, main switchboard, sub-DBs (1 per floor + 1 per service zone),
  standby generator (life safety + 30% load), UPS for IT/BMS, busbar trunking riser
  (= storeys × 3.2m floor-to-floor), conduit + wiring, all sockets (residential: 6–10 per room),
  all switches, data/TV outlets, LED fittings (1 per 8–12 m²), earthing & lightning protection.

MEP — PLUMBING: cold + hot water pipework (separate runs), soil & vent stacks (1 per wet stack
  zone × storey height), waste pipework, water tanks (sized to demand), booster pumps duty/
  standby, transfer pumps, solar water heaters where applicable, sewage treatment plant if
  no mains sewer.

MEP — FIRE: sprinkler heads (1 per ~12 m² coverage), fire pump set duty/standby + jockey,
  hose reel cabinets (1 per ~30 m hose length), dry risers (per floor), fire alarm panel,
  smoke + heat detectors (1 per ~40 m²), manual call points (1 per floor near each exit),
  FM200 for IT/data rooms, stair pressurisation system (high-rise).

MEP — BMS / SPECIALIST: BMS head-end + controllers (count = HVAC + electrical + lifts +
  fire + access points × ~1.2 — typically 1 BMS point per 25–40 m² GFA), IBMS gateway for
  high-rise/commercial, lighting control (DALI) circuits, public address / voice alarm by zone,
  rooftop PV where required by code (Dubai Green Building Code).

MEP — SECURITY: CCTV system, video intercom, access control.

EXTERNAL WORKS: boundary wall (m² face area), automated gate, driveway paving, asphalt road,
  soft landscaping, irrigation system, external lighting, surface water + foul drainage,
  septic tank or sewer connection, swimming pool (residential villas), retaining walls,
  carpark line marking (per bay), bollards, wayfinding signage.

PRELIMINARIES (typical 8–13% of works subtotal — bench against this):
  Site mobilisation, temporary facilities (per month × programme duration), hoarding/site fence,
  scaffold (= envelope face area), tower crane (months on site, mandatory > 3 storeys),
  goods/passenger hoist (months on site, mandatory > 5 storeys), authority permits & NOC fees
  (DM, DEWA, Civil Defence, RTA), insurance (CAR + PI + third-party), design coordination,
  health & safety, testing & commissioning, temporary utilities, site clearance.

EXTRACTION RULES:
- Output ONLY valid JSON matching the schema. No prose, no markdown, no \`\`\`json fences.
- Map each element to the closest rate code in the library. If nothing fits, mint a new code
  following pattern SECTION-TYPE-NNN and pick the nearest discipline/section.
- NEVER omit a category because the drawing lacks data. Use the rules of thumb above to derive
  quantities from project type, GFA, storey count, and room schedule. An incomplete BoQ is
  worse than one with assumed quantities flagged at lower confidence.
- The "source" field must reference the drawing name(s) the element was found in (or "derived
  from GFA × storeys" if assumed).
- Aggregate identical elements: 24× same columns → one row qty=24. But split by spec/size if
  rates differ (e.g. 600×600 columns separate from 800×800 columns).
- For high-rise (> 3 storeys), Internal walls, MEP-VT (lifts), MV switchgear, smoke control,
  busbar risers, BMS, and tower crane preliminaries are NOT optional.

VISION INSTRUCTIONS — when drawing images or PDFs are attached:
- READ THE IMAGES. Treat each attached image as a sheet from the drawing set.
- Read the title block: project name, scale, sheet number, drawing title, GFA, storey count.
- For floor plans: count rooms, count doors (every door swing), count windows (every opening
  on elevations), count bathrooms (locate WCs/basins/showers), count kitchens (sinks/cooktops),
  measure GFA from grids and dimensions, count parking bays, identify lift cores and stair cores.
- For sections / elevations: read storey heights from level tags, read parapet heights, identify
  façade type (curtain wall vs blockwork+render vs cladding).
- For schedules (door, window, finishes, room, equipment): READ THE TABLE. Extract exact counts,
  sizes, and types directly. Schedule data is the highest-confidence quantity source.
- For MEP drawings: read equipment schedules — chiller capacities, FCU counts per zone,
  AHU sizes, panel schedule rows. Count diffusers, sprinklers, light fittings on plans.
- For structural drawings: count columns on grid, count beams, count piles, read column schedule
  for sizes, read rebar schedule for tonnage.
- When you read a quantity from an image (sheet count, schedule row, dimension), set confidence
  85+ and put the sheet name/number in "source" (e.g. "A-101 Floor Plan Level 1, Door D-12 ×3").
- When you derive from rules of thumb because the image data is unclear, confidence 50–69 and
  source "derived from GFA × ratio" — but PREFER reading from images whenever legible.

CONFIDENCE SCORING:
- 85–95: quantity explicitly readable from drawing schedules, dimensioned text, or BIM properties.
- 70–84: element clearly identified, quantity counted from images / legible drawing geometry.
- 50–69: element inferred from project type and rules of thumb when drawing data is illegible.
- Below 50: highly assumed with no drawing evidence — flag for manual review.`,
      },
      {
        type: 'text',
        text: RATES_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: buildUserContent({
          projectName, projectType, location,
          drawingsBlock,
          drawings,                     // raw drawings with .image_buffer / .pdf_buffer
        }),
      },
    ],
  });

  // Collect full streamed response
  const resp = await stream.finalMessage();
  const textBlock = resp.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude returned no text block');
  let text = textBlock.text.trim();
  // Strip ```json fences if Claude added them despite instructions
  text = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('Claude returned invalid JSON: ' + text.slice(0, 300));
  }

  return {
    ...parsed,
    usage: resp.usage,
    cache_read: resp.usage?.cache_read_input_tokens || 0,
    cache_write: resp.usage?.cache_creation_input_tokens || 0,
  };
}

// Stub mode for when properties extraction returns nothing (e.g. an image-only PDF)
// — Claude infers from drawing names + project type alone.
async function extractElementsFromNames({ projectName, projectType, location, drawingNames }) {
  return extractElements({
    projectName, projectType, location,
    drawings: drawingNames.map(n => ({
      name: n,
      summary: `(no parsed geometry — drawing is image-based or pre-translation; infer typical ${projectType} elements appropriate to a drawing titled "${n}")`,
    })),
  });
}

module.exports = {
  MODEL,
  client,
  loadRates,
  compressProperties,
  extractElements,
  extractElementsFromNames,
};
