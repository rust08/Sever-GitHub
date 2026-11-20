from pathlib import Path
import hashlib
import json
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
name = "Snow_Control_Equipment_Evidence_2026_11_20"
with ZipFile(root / "research" / (name + ".zip")) as archive:
    def read(path):
        return archive.read(name + "/" + path)

    for line in read("MANIFEST.sha256").decode("utf-8-sig").splitlines():
        digest, path = line.split(maxsplit=1)
        if hashlib.sha256(read(path)).hexdigest() != digest:
            raise ValueError("Checksum mismatch: " + path)
    facts = json.loads(read("data/evidence.json"))
    sources = {s["id"]: s for s in json.loads(read("data/sources.json"))}
    for fact in facts:
        if fact["usable_as_active_fleet"] is not False or fact["source_id"] not in sources:
            raise ValueError("Unexpected observation: " + fact["id"])
payload = json.dumps({"facts": facts, "sources": sources}, ensure_ascii=False, separators=(",", ":"))
(root / "public/equipment-evidence.js").write_text("window.equipmentEvidence=" + payload + ";\n", encoding="utf-8", newline="\n")
