"""Rebuild public/locations.js from the locations spreadsheet.

Usage:  python3 tools/update_locations.py path/to/LocationsandOperators.xlsx
The first sheet must have columns: name, lat, long, operator (header row first).
"""
import json, sys, pathlib
import openpyxl

src = sys.argv[1]
out_path = pathlib.Path(__file__).resolve().parent.parent / "public" / "locations.js"
wb = openpyxl.load_workbook(src, data_only=True)
ws = wb.worksheets[0]
rows = []
for r in ws.iter_rows(min_row=2, values_only=True):
    name, lat, lng, op = (list(r) + [None] * 4)[:4]
    if name is None or lat is None or lng is None:
        continue
    try:
        lat, lng = round(float(lat), 6), round(float(lng), 6)
    except (TypeError, ValueError):
        print("Skipped (bad coordinates):", name)
        continue
    rows.append([str(name).strip(), lat, lng, (op or "").strip()])
rows.sort(key=lambda x: x[0].upper())
body = json.dumps(rows, separators=(",", ":"), ensure_ascii=False).replace("],[", "],\n[")
out_path.write_text(
    "// Crude Maps locations: [name, lat, lng, operator]\n"
    f"// Generated from {pathlib.Path(src).name} by tools/update_locations.py\n"
    f"window.LOCATIONS = {body};\n",
    encoding="utf-8",
)
print(f"Wrote {len(rows)} locations to {out_path}")
