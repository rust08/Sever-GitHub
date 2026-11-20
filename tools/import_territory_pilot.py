from pathlib import Path
from zipfile import ZipFile
import hashlib
import json

# Produce the read-only map snapshot used by both online and offline builds.
root = Path(__file__).resolve().parents[1]
name = "Snow_Control_Territory_Responsibility_2026_11_20"
with ZipFile(root / "research" / (name + ".zip")) as archive:
    def read(path):
        return archive.read(name + "/" + path)

    for line in read("MANIFEST.sha256").decode().splitlines():
        digest, path = line.split(maxsplit=1)
        if hashlib.sha256(read(path)).hexdigest() != digest:
            raise ValueError("Archive checksum mismatch: " + path)

    prefix = "preview/"
    coverage = json.loads(read(prefix + "coverage_plow_2026-11-20.json"))
    features = json.loads(read(prefix + "roads_plow_2026-11-20.geojson"))["features"]
    rows = []
    for feature in features:
        props = feature["properties"]
        if (props["responsibility_status"] != "unverified" or props["operator_id"]
                or props["contract_id"] or props["operation"] != coverage["operation"]
                or feature["geometry"]["type"] != "LineString"):
            raise ValueError("Unexpected record in unverified pilot snapshot")
        rows.append([props["edge_id"], props["name"], props["osm_way"], feature["geometry"]["coordinates"]])
    if len({row[0] for row in rows}) != len(rows) or coverage["status_counts"] != {"unverified": len(rows)} or len(rows) != coverage["total_edges"]:
        raise ValueError("Pilot coverage and geometry disagree")

snapshot = {"date": coverage["date"], "operation": coverage["operation"], "roads": rows}
output = "export const territoryPilot=" + json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + ";\n"
(root / "public" / "territory-pilot.js").write_text(output, encoding="utf-8", newline="\n")
