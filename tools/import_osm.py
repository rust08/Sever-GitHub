"""Build the local routing graph from an OpenStreetMap API map XML response."""
import argparse
import json
import math
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import datetime, timezone
from itertools import pairwise
from pathlib import Path


BOUNDS = (158.625, 53.038, 158.658, 53.057)
SOURCE = 'https://api.openstreetmap.org/api/0.6/map?bbox=' + ','.join(map(str, BOUNDS))
CLASSES = {'primary', 'secondary', 'tertiary', 'residential', 'living_street',
           'unclassified', 'primary_link', 'secondary_link', 'tertiary_link'}


def tags(element):
    return {tag.get('k'): tag.get('v') for tag in element.findall('tag')}


def distance(p, q):
    lon1, lat1 = map(math.radians, p)
    lon2, lat2 = map(math.radians, q)
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12742 * math.asin(min(1, math.sqrt(a)))


def reachable(start, graph):
    pending, seen = [start], {start}
    while pending:
        for target in graph[pending.pop()]:
            if target not in seen:
                seen.add(target)
                pending.append(target)
    return seen


def largest_strong_component(edges):
    forward, backward = defaultdict(list), defaultdict(list)
    for edge in edges:
        a, b = edge['from'], edge['to']
        forward[a].append(b)
        backward[b].append(a)
        if not edge['oneway']:
            forward[b].append(a)
            backward[a].append(b)
    remaining = set(forward) | set(backward)
    largest = set()
    while len(remaining) > len(largest):
        start = min(remaining)
        component = reachable(start, forward) & reachable(start, backward)
        if len(component) > len(largest):
            largest = component
        remaining -= component
    return largest


def build(root):
    xmin, ymin, xmax, ymax = BOUNDS
    nodes = {}
    for node in root.findall('node'):
        x, y = float(node.get('lon')), float(node.get('lat'))
        if xmin <= x <= xmax and ymin <= y <= ymax and tags(node).get('barrier') not in {'gate', 'lift_gate', 'bollard', 'block'}:
            nodes[node.get('id')] = [x, y]
    buses = defaultdict(set)
    for relation in root.findall('relation'):
        values = tags(relation)
        if values.get('type') == 'route' and values.get('route') == 'bus':
            for member in relation.findall('member'):
                if member.get('type') == 'way' and member.get('role', '') in {'', 'forward', 'backward'}:
                    buses[member.get('ref')].add(values.get('ref') or f"OSM {relation.get('id')}")
    ways = []
    usage = Counter()
    for way in root.findall('way'):
        values = tags(way)
        access = next((values[k] for k in ('motor_vehicle', 'vehicle', 'access') if k in values), '')
        if values.get('highway') not in CLASSES or access in {'no', 'private', 'destination', 'permit'} or values.get('area') == 'yes':
            continue
        run = []
        refs = [n.get('ref') for n in way.findall('nd')]
        for ref in [*refs, None]:
            if ref in nodes:
                run.append(ref)
            else:
                if len(run) >= 2:
                    ways.append((way.get('id'), values, run))
                    usage.update(run)
                run = []
    edges = []
    for way_id, values, run in ways:
        oneway_tag = values.get('oneway', 'yes' if values.get('junction') == 'roundabout' else 'no')
        if oneway_tag not in {'true', 'yes', '1', '-1', 'false', 'no', '0'}:
            continue
        begin = 0
        for i, ref in enumerate(run[1:], start=1):
            if usage[ref] == 1 and i != len(run) - 1:
                continue
            section = run[begin:i + 1]
            begin = i
            if oneway_tag == '-1':
                section = list(reversed(section))
            if section[0] == section[-1]:
                continue
            geometry = [nodes[n] for n in section]
            km = round(sum(distance(p, q) for p, q in pairwise(geometry)), 5)
            if not km:
                continue
            edges.append({'id': f"w{way_id}-{section[0]}-{section[-1]}", 'osmWay': way_id,
                          'from': section[0], 'to': section[-1], 'geometry': geometry,
                          'km': km, 'oneway': oneway_tag in {'true', 'yes', '1', '-1'},
                          'highway': values['highway'], 'name': values.get('name', 'Проезд без названия'),
                          'busRoutes': sorted(buses[way_id]), 'bridge': values.get('bridge', 'no') != 'no'})
    component = largest_strong_component(edges)
    edges = [e for e in edges if e['from'] in component and e['to'] in component]
    intersections = {i: nodes[i] for i in sorted(component)}
    depot = min(component, key=lambda i: distance(nodes[i], [158.643, 53.050]))
    assert edges and len(edges) == len({e['id'] for e in edges})
    return {'nodes': intersections, 'edges': edges, 'depot': depot, 'source': SOURCE,
            'attribution': '© OpenStreetMap contributors', 'license': 'https://www.openstreetmap.org/copyright',
            'generatedUtc': datetime.now(timezone.utc).isoformat(), 'bounds': list(BOUNDS)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    data = build(ET.parse(args.input).getroot())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    print(f"{len(data['nodes'])} intersections; {len(data['edges'])} sections")
