"""Build the offline map context from Kamchatka's OSM PBF and the Mapzen relief.

python tools/render_relief.py
python tools/render_basemap.py kamchatka_krai-latest.osm.pbf
Requires osmium, shapely>=2, numpy, Pillow. Coordinates are WGS84.
"""
import argparse
import json
from collections import Counter, defaultdict
from math import asinh, atan, ceil, degrees, floor, pi, radians, sinh, tan
from pathlib import Path

import numpy as np
import osmium
from PIL import Image, ImageDraw, ImageFilter
from shapely import from_wkb, reverse, segmentize
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import nearest_points, polygonize, unary_union

ROOT=Path(__file__).resolve().parents[1]
W,E,N,S=1924,1931,663,671
ZOOM=11
TILES=2**ZOOM
SIZE=((E-W)*256,(S-N)*256)
def lon(x): return x/TILES*360-180
def lat(y): return degrees(atan(sinh(pi*(1-2*y/TILES))))
FRAME=box(lon(W),lat(S),lon(E),lat(N))
CITY=box(158.42,52.82,159.06,53.18)
COLORS={'forest':'#bed2b9','park':'#c9dec4','brush':'#d4ddc4','urban':'#ece9e0',
        'industrial':'#e0dcd3','water':'#a9cacd','river':'#9cbfc1','building':'#d1c8b9'}
def project(line):
    return [(((x+180)/360*TILES-W)*256,((1-asinh(tan(radians(y)))/pi)*TILES/2-N)*256) for x,y in line]

def parts(geom,kind):
    if geom.is_empty: return []
    if geom.geom_type==kind:return [geom]
    return [s for g in getattr(geom,'geoms',[]) for s in parts(g,kind)]

def area_kind(t):
    nat=t.get('natural','')
    use=t.get('landuse','')
    if t.get('building') not in (None,'no'):return 'building'
    if nat=='water' or use in ('reservoir','basin') or t.get('waterway')=='riverbank':return 'water'
    if nat=='wood' or use=='forest':return 'forest'
    if use in ('grass','meadow','recreation_ground','village_green') or t.get('leisure') in ('park','garden'):return 'park'
    if nat in ('scrub','heath','grassland','wetland'):return 'brush'
    if use in ('residential','retail','commercial'):return 'urban'
    if use in ('industrial','quarry','port','railway'):return 'industrial'

def inside(x,y):
    w,s,e,n=FRAME.bounds
    return w<=x<=e and s<=y<=n

def extract(path):
    factory=osmium.geom.WKBFactory()
    features=defaultdict(list); coasts=[]; landmarks=[]
    # Area assembly preserves holes and multipolygon members.
    for obj in osmium.FileProcessor(path).with_locations().with_areas():
        t=obj.tags
        if obj.is_area():
            kind=area_kind(t)
            if not kind:continue
            try: shape=from_wkb(bytes.fromhex(factory.create_multipolygon(obj)))
            except (RuntimeError,ValueError):continue
            bounds=CITY if kind=='building' else FRAME
            if not bounds.intersects(shape):continue
            if not shape.is_valid:shape=shape.buffer(0)
            for poly in parts(bounds.intersection(shape),'Polygon'):
                if poly.area>1e-11: features[kind].append(poly)
        elif obj.is_way():
            coast=t.get('natural')=='coastline'
            stream=t.get('waterway') in ('river','stream','canal')
            if not (coast or stream):continue
            try: line=LineString([(n.lon,n.lat) for n in obj.nodes])
            except (RuntimeError,ValueError):continue
            for segment in parts(FRAME.intersection(line),'LineString'):
                if coast:coasts.append(segment)
                elif segment.length>.001:features['river'].append(segment)
        elif obj.is_node() and t.get('name') and t.get('natural') in ('peak','bay','strait'):
            x,y=obj.location.lon,obj.location.lat
            if CITY.contains(Point(x,y)):landmarks.append([t['name'],round(x,5),round(y,5),t['natural']])
    return features,coasts,landmarks

def land_polygons(coasts):
    # OSM coastline ways run with land to the left. For each face, classify a
    # midpoint of a shared coast segment; this also handles islands in a bay.
    faces=list(polygonize(unary_union(coasts+[FRAME.boundary])))
    from shapely import STRtree
    tree=STRtree(coasts)
    land=[]
    for face in faces:
        for idx in tree.query(face.boundary,predicate='intersects'):
            coast=coasts[idx]
            overlap=face.boundary.intersection(coast)
            shared=parts(overlap,'LineString')
            if not shared:continue
            longest=max(shared,key=lambda p:p.length)
            midpoint=longest.interpolate(.5,normalized=True)
            along=coast.project(midpoint)
            a=coast.interpolate(max(0,along-1e-7))
            b=coast.interpolate(min(coast.length,along+1e-7))
            dx,dy=b.x-a.x,b.y-a.y
            norm=(dx*dx+dy*dy)**.5
            if not norm:continue
            if face.contains(Point(midpoint.x-dy/norm*1e-7,midpoint.y+dx/norm*1e-7)):land.append(face)
            break
    if not land:raise ValueError('No land faces derived from coastline')
    return land

def draw_polygon(draw,poly,value):
    draw.polygon(project(poly.exterior.coords),fill=value)
    for ring in poly.interiors:draw.polygon(project(ring.coords),fill=0)

def mask_of(shapes):
    mask=Image.new('L',SIZE,0);draw=ImageDraw.Draw(mask)
    for p in sorted(shapes,key=lambda a:-a.area):draw_polygon(draw,p,255)
    return mask

def render_raster(features,land,relief):
    source=Image.open(relief).convert('RGB')
    if source.size!=SIZE:raise ValueError('Unexpected Mapzen raster extent')
    surface=Image.new('RGB',SIZE,'#e6e6d6')
    for kind in ('brush','forest','park','urban','industrial','water','building'):
        surface.paste(COLORS[kind],mask=mask_of(features[kind]))
    terrain=np.asarray(source.convert('L'),dtype=np.float32)
    # Use the existing slope shading only over land. Elevation-zero ocean values
    # in the coarse DEM are never used as a shoreline.
    blur=np.asarray(source.convert('L').filter(ImageFilter.GaussianBlur(15)),dtype=np.float32)
    shade=np.clip((terrain-blur)*.88+(blur-221)*.40,-50,20)
    pixels=np.asarray(surface,dtype=np.float32)
    shaded=Image.fromarray(np.uint8(np.clip(pixels+shade[:,:,None],0,255)))
    inland=mask_of(features['water']); shaded.paste(COLORS['water'],mask=inland)
    sea=Image.new('RGB',SIZE,'#aacacd')
    sea.paste(shaded,mask=mask_of(land))
    draw=ImageDraw.Draw(sea)
    for river in features['river']:draw.line(project(river.coords),fill=COLORS['river'],width=1)
    dest=ROOT/'public/terrain-map.webp'
    sea.save(dest,quality=90,method=5)
    return dest

def pack(coords):
    points=[]
    for x,y in coords:
        q=(round(x*1e5),round(y*1e5))
        if not points or q!=points[-1]:points.append(q)
    if len(points)<2:return []
    encoded=list(points[0])
    for a,b in zip(points,points[1:]):encoded.extend((b[0]-a[0],b[1]-a[1]))
    return encoded

def vector_context(features,coasts,landmarks):
    # Small grid cells let the browser add only the features near its viewport.
    # Coordinates are delta-encoded to 0.00001 degree (less than 1.2 m).
    grid=defaultdict(list);records=[]
    all_features=dict(features,coast=coasts)
    for kind in ('brush','forest','park','urban','industrial','water','river','coast','building'):
        for g in all_features[kind]:
            if not CITY.intersects(g):continue
            g=g.simplify(.000012,preserve_topology=True)
            west,south,east,north=g.bounds
            rings=[g.exterior.coords]+[r.coords for r in g.interiors] if g.geom_type=='Polygon' else [g.coords]
            encoded=[p for ring in rings if (p:=pack(ring))]
            if not encoded:continue
            ident=len(records);records.append([kind,encoded])
            for x in range(floor(max(west,CITY.bounds[0])*100),floor(min(east,CITY.bounds[2])*100)+1):
                for y in range(floor(max(south,CITY.bounds[1])*100),floor(min(north,CITY.bounds[3])*100)+1):
                    grid[f'{x}/{y}'].append(ident)
    dest=ROOT/'public/city-context.js'
    data=dict(records=records,cells=grid,landmarks=landmarks)
    dest.write_text('export const cityContext='+json.dumps(data,separators=(',',':'),ensure_ascii=False)+';\n',encoding='utf8')
    return dest,Counter(row[0] for row in records)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('pbf',type=Path);args=parser.parse_args()
    features,coasts,landmarks=extract(args.pbf)
    land=land_polygons(coasts)
    print('land',len(land),'coasts',len(coasts),'geography',[(k,len(v)) for k,v in features.items()])
    raster=render_raster(features,land,ROOT/'data/terrain-shading.webp')
    vec,counts=vector_context(features,coasts,landmarks)
    print('bytes',raster.stat().st_size,vec.stat().st_size,'detail',counts,'landmarks',landmarks)
if __name__=='__main__':main()

