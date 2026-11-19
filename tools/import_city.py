"""Extract the public street network and mapped vehicle roads of Petropavlovsk-Kamchatsky.

    pip install osmium shapely
    python tools/import_city.py kamchatka_krai-latest.osm.pbf data/city-network.json

Source: https://download.openstreetmap.fr/extracts/russia/far_eastern_federal_district/kamchatka_krai-latest.osm.pbf
"""
import argparse
import hashlib
import json
import itertools
from collections import Counter, defaultdict
from pathlib import Path
from itertools import pairwise

import osmium
from shapely.geometry import LineString, mapping
from shapely.ops import polygonize, unary_union
from shapely.prepared import prep

from import_osm import distance, reachable

MUNICIPALITY = 1783597
SOURCE = 'https://download.openstreetmap.fr/extracts/russia/far_eastern_federal_district/kamchatka_krai-latest.osm.pbf'
STREETS = set('motorway trunk primary secondary tertiary motorway_link trunk_link primary_link secondary_link tertiary_link residential living_street unclassified road'.split())
CLASSES = STREETS | {'track', 'service'}
BLOCKED = {'no', 'private', 'permit', 'agricultural', 'forestry', 'delivery', 'customers', 'destination'}
BARRIERS = {'gate', 'lift_gate', 'bollard', 'block', 'chain', 'jersey_barrier', 'cycle_barrier', 'sump_buster', 'bus_trap'}
BASE = [158.643, 53.050]


def read_boundary_and_routes(path):
    borders = {}
    buses = defaultdict(set)
    for rel in osmium.FileProcessor(path, osmium.osm.RELATION):
        if rel.id == MUNICIPALITY:
            if rel.tags.get('boundary') != 'administrative':
                raise ValueError('Wrong boundary type')
            for m in rel.members:
                if m.type == 'w' and m.role in ('outer', 'inner', ''):
                    borders[m.ref] = m.role or 'outer'
        if rel.tags.get('type') == 'route' and rel.tags.get('route') == 'bus':
            for m in rel.members:
                if m.type == 'w' and m.role in ('', 'forward', 'backward'):
                    buses[m.ref].add(rel.tags.get('ref') or f'OSM {rel.id}')
    if not borders:
        raise ValueError('Municipal boundary missing from extract')
    lines = defaultdict(list)
    remaining = set(borders)
    for obj in osmium.FileProcessor(path).with_locations():
        if obj.is_way() and obj.id in remaining:
            lines[borders[obj.id]].append(LineString([(n.lon,n.lat) for n in obj.nodes]))
            remaining.remove(obj.id)
    if remaining:
        raise ValueError('Incomplete municipal boundary')
    boundary = unary_union(list(polygonize(lines['outer']))).difference(unary_union(list(polygonize(lines['inner']))))
    if not boundary.is_valid or boundary.is_empty:
        raise ValueError('Invalid municipal geometry')
    return boundary, buses


def clip_way(refs, points, polygon, prepared):
    """Clip crossing segments precisely while preserving topology by OSM node id."""
    line = LineString(points)
    if prepared.covers(line):
        return [refs]
    if not prepared.intersects(line):
        return []
    parts = []
    for (a,b),(p,q) in zip(pairwise(refs), pairwise(points)):
        if p == q:
            continue
        clipped = polygon.intersection(LineString([p,q]))
        for part in getattr(clipped, 'geoms', [clipped]):
            if part.geom_type != 'LineString' or part.is_empty:
                continue
            pair = []
            for xy in (part.coords[0],part.coords[-1]):
                if xy == p:
                    pair.append(a)
                elif xy == q:
                    pair.append(b)
                else:
                    # Crossing identities are local to the segment, not to overlapping roads.
                    pair.append((f'clip-{min(a[0],b[0])}-{max(a[0],b[0])}-{xy[0]:.7f}-{xy[1]:.7f}', list(xy)))
            if parts and parts[-1][-1][0] == pair[0][0]:
                parts[-1].append(pair[1])
            else:
                parts.append(pair)
    return parts


def read_roads(path, boundary):
    prepared = prep(boundary)
    xmin,ymin,xmax,ymax = boundary.bounds
    ways = []
    barriers = set()
    usage = Counter()
    for obj in osmium.FileProcessor(path).with_locations():
        if obj.is_node() and obj.tags.get('barrier') in BARRIERS and obj.tags.get('motor_vehicle') not in ('yes','designated'):
            barriers.add(str(obj.id))
        if not obj.is_way() or obj.tags.get('highway') not in CLASSES or obj.tags.get('area') == 'yes':
            continue
        # Regional extracts can omit nodes of ways crossing the provincial border.
        # Split at missing nodes, so no artificial link bridges a gap.
        for valid, group in itertools.groupby(obj.nodes, key=lambda n:n.location.valid()):
            if not valid:
                continue
            refs = [(str(n.ref),(n.lon,n.lat)) for n in group]
            points = [point for _,point in refs]
            if len(points)<2 or max(p[0] for p in points)<xmin or min(p[0] for p in points)>xmax or max(p[1] for p in points)<ymin or min(p[1] for p in points)>ymax:
                continue
            for run in clip_way(refs,points,boundary,prepared):
                ways.append((obj.id,dict(obj.tags),run))
                usage.update(n for n,_ in run)
    return ways, barriers, usage


def extract(path):
    boundary,buses = read_boundary_and_routes(path)
    ways,barriers,usage = read_roads(path,boundary)
    edges, nodes = [], {}
    used_ids = set()
    for way,tags,run in ways:
        highway = tags['highway']
        road_access = next((tags[k] for k in ('motorcar','motor_vehicle','vehicle','access') if k in tags), 'yes')
        direction = tags.get('oneway','yes' if tags.get('junction') in ('roundabout','circular') or highway == 'motorway' else 'no')
        routable = road_access not in BLOCKED and direction in ('yes','1','true','-1','no','false','0')
        splits = [0]+[i for i,(node,_) in enumerate(run[1:-1],1) if usage[node]>1 or node in barriers]+[len(run)-1]
        for left,right in pairwise(splits):
            # Closed loops without other junctions still have two drivable arcs.
            indices = [left,(left+right)//2,right] if run[left][0]==run[right][0] and right-left>=2 else [left,right]
            for start,end in pairwise(indices):
                part=run[start:end+1]
                if direction=='-1':
                    part=part[::-1]
                a,b = part[0][0],part[-1][0]
                if a==b:
                    continue
                geometry = [[round(x,7),round(y,7)] for _,(x,y) in part]
                km = round(sum(distance(p,q) for p,q in pairwise(geometry)),5)
                if not km:
                    continue
                edge_id=f'w{way}-{a}-{b}'
                if edge_id in used_ids:
                    edge_id+=f'-{start}'
                if edge_id in used_ids:
                    raise ValueError('Duplicate section')
                used_ids.add(edge_id)
                nodes[a],nodes[b]=geometry[0],geometry[-1]
                allowed=routable and a not in barriers and b not in barriers
                edges.append(dict(id=edge_id,osmWay=str(way), **{'from':a,'to':b}, geometry=geometry,km=km,
                    oneway=direction in ('yes','true','1','-1'),highway=highway,name=tags.get('name:ru') or tags.get('name') or 'Проезд без названия',
                    busRoutes=sorted(buses[way]),bridge=tags.get('bridge','no')!='no',routable=allowed,
                    serviceRequired=allowed and highway in STREETS))
    outgoing,incoming=defaultdict(list),defaultdict(list)
    for edge in edges:
        if not edge['routable']:
            continue
        a,b=edge['from'],edge['to']
        outgoing[a].append(b)
        incoming[b].append(a)
        if not edge['oneway']:
            outgoing[b].append(a)
            incoming[a].append(b)
    # Select a depot at the nearest public street in the urban component; avoid an isolated driveway.
    candidates={e['from'] for e in edges if e['serviceRequired']}
    for depot in sorted(candidates,key=lambda n:distance(nodes[n],BASE)):
        round_trip=reachable(depot,outgoing) & reachable(depot,incoming)
        if len(round_trip)>len(nodes)*0.5:
            break
    else:
        raise ValueError('No nearby depot with access to main city component')
    stats=dict(mappedSections=len(edges), routingSections=sum(e['routable'] for e in edges),
               requiredSections=sum(e['serviceRequired'] for e in edges),
               reachableSections=sum(e['routable'] and e['from'] in round_trip and e['to'] in round_trip for e in edges),
               mappedKm=round(sum(e['km'] for e in edges),3))
    with open(path,'rb') as file:
        checksum=hashlib.file_digest(file,'sha256').hexdigest()
    header=osmium.io.Reader(path)
    try:
        timestamp=header.header().get('osmosis_replication_timestamp') or None
    finally:
        header.close()
    return dict(scope='city',version='pkgo-'+checksum[:12],depot=depot,nodes=nodes,edges=edges,
        bounds=list(boundary.bounds),boundary=mapping(boundary.simplify(0.00008,preserve_topology=True)),
        source=SOURCE,attribution='© OpenStreetMap contributors',license='https://www.openstreetmap.org/copyright',
        boundaryRelation=MUNICIPALITY,snapshotUtc=timestamp,inputSha256=checksum,statistics=stats)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    result=extract(str(args.pbf))
    args.output.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')),encoding='utf8')
    print(result['statistics'], result['version'], result['snapshotUtc'])

