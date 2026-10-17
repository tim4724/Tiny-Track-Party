# gen-concept-cars.py — candidate cars in the toy-car kit's format, into
# public/assets/concepts/, for the asset gallery's "Concept cars" field and
# for racing them with ?cars=. Nothing ships them. Two kinds: cars CONVERTED
# from Kenney's Car Kit (CARS), and cars DESIGNED from its parts (DESIGNS).
#
#   blender -b --factory-startup --python scripts/gen-concept-cars.py [-- name ...]
#
# The Car Kit is Kenney's more detailed car set (CC0). It is fetched and
# hash-checked into the same cache as scripts/fetch-kits.mjs, and each car is
# made so it could drop into the roster as is:
#   * turned to face glTF -Z (the Car Kit faces +Z) and scaled to the roster's
#     width, 0.525 over the wheels;
#   * one root node holding the body (spoilers, a spare wheel, a kart's driver
#     joined into it), wheel-fl/fr/bl/br as its children;
#   * its UVs moved onto the toy-car kit's own palette, swatch for swatch, so
#     it samples the one Textures/colormap.png every car shares (and the seat
#     marks find their swatches). Both atlases are Kenney's 16 x 4 swatch grid
#     in mostly the same colours; a Car Kit colour the toy kit lacks takes its
#     nearest, and the run prints how far each one moved.
# The earlier hand-modelled concepts (toy-*, kit-*) are in git history.

import bmesh
import bpy
import hashlib
import json
import math
import os
import struct
import sys
import urllib.request
import zipfile
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KIT = os.path.join(REPO, 'public', 'assets', 'toycar')
OUT = os.path.join(REPO, 'public', 'assets', 'concepts')
CACHE = os.path.join(REPO, '.cache', 'kenney-kits')

CAR_KIT = {
    'version': '3.1',
    'url': 'https://kenney.nl/media/pages/assets/car-kit/1a312ec241-1775131960/kenney_car-kit.zip',
    'sha256': 'fac7dacac5c7874348cf19729af3ef205f3d366493edaf0a827d93f4fdf3d0c4',
}
GLB_DIR = 'Models/GLB format/'
TARGET_WIDTH = 0.525  # the roster cars' width over the wheels
WHEELS = {'wheel-front-left': 'wheel-fl', 'wheel-front-right': 'wheel-fr',
          'wheel-back-left': 'wheel-bl', 'wheel-back-right': 'wheel-br'}

# name -> (Car Kit model, what it is, the roster car to stand it beside).
CARS = {
    'carkit-sedan-sports': ('sedan-sports', 'Sports sedan with a rear spoiler.', 'vehicle-racer-low'),
    'carkit-race': ('race', 'Open-wheel racer.', 'vehicle-speedster'),
    'carkit-race-future': ('race-future', 'Futuristic racer.', 'vehicle-racer'),
    'carkit-hatchback-sports': ('hatchback-sports', 'Sports hatchback.', 'vehicle-vintage-racer'),
    'carkit-sedan': ('sedan', 'Sedan.', None),
    'carkit-taxi': ('taxi', 'Taxi.', None),
    'carkit-police': ('police', 'Police car.', None),
    'carkit-suv': ('suv', 'SUV with a spare wheel on the tail.', None),
    'carkit-suv-luxury': ('suv-luxury', 'Luxury SUV.', None),
    'carkit-van': ('van', 'Van.', None),
    'carkit-kart-oobi': ('kart-oobi', 'Kart with its driver.', None),
    'carkit-kart-oodi': ('kart-oodi', 'Kart with its driver.', None),
    'carkit-kart-ooli': ('kart-ooli', 'Kart with its driver.', None),
    'carkit-kart-oopi': ('kart-oopi', 'Kart with its driver.', None),
    'carkit-kart-oozi': ('kart-oozi', 'Kart with its driver.', None),
    # The ROLE candidates: one Car Kit body per roster role, its look pushed
    # towards the role's stats (see TWEAKS), standing beside the car it replaces.
    'role-dash': ('police', 'Dash (balanced): the police car as it is.', 'vehicle-racer-low'),
    'role-bolt': ('sedan-sports', 'Bolt (fastest, light, poor turn): the sports sedan lowered and '
                  'stretched.', 'vehicle-speedster'),
    'role-carve': ('hatchback-sports', 'Carve (corner king, low top speed): the sports hatchback in blue, '
                   'shortened.', 'vehicle-racer'),
    'role-rumble': ('suv', 'Rumble (heavy, slow launch): the SUV in purple.', 'vehicle-vintage-racer'),
    # The same four with the body narrowed between bigger wheels, so the
    # chase camera sees the front wheels steer (a Car Kit body covers them).
    'narrow-dash': ('police', 'Dash: the police car, narrow body between bigger wheels.', 'vehicle-racer-low'),
    'narrow-bolt': ('sedan-sports', 'Bolt: the sports sedan, narrow, lowered and stretched.', 'vehicle-speedster'),
    'narrow-carve': ('hatchback-sports', 'Carve: the sports hatchback in blue, narrow and shortened.',
                     'vehicle-racer'),
    'narrow-rumble': ('suv', 'Rumble: the SUV in purple, narrow on the biggest wheels.', 'vehicle-vintage-racer'),
    # The same four with the body shrunk evenly (proportions kept) between
    # wheels that stay put, a little bigger: front wheels show, nothing slim.
    'small-dash': ('police', 'Dash: the police car, body at 88% between bigger wheels.', 'vehicle-racer-low'),
    'small-bolt': ('sedan-sports', 'Bolt: the sports sedan, body at 88%, lowered and stretched.',
                   'vehicle-speedster'),
    'small-carve': ('hatchback-sports', 'Carve: the sports hatchback in blue, body at 88%, shortened.',
                    'vehicle-racer'),
    'small-rumble': ('suv', 'Rumble: the SUV in purple, body at 88% on the biggest wheels.', 'vehicle-vintage-racer'),
}

# Per-car edits on top of the conversion: `paint` moves Car Kit swatches
# {(row, col): (row, col)} before the palette mapping, `shape` scales the body
# (never the wheels) by (along the car, up from the ground), the wheels
# sliding with its length; `width` scales the body across, `body` all of it at
# its ride height, `tyres` the wheels about their own centres (the body rides
# up with them).
BLUE_PAINT = {(1, 7): (1, 15), (1, 6): (1, 14)}
PURPLE_PAINT = {(1, 7): (0, 3), (1, 6): (0, 2)}
TWEAKS = {
    'role-bolt': {'shape': (1.08, 0.82)},
    'role-carve': {'paint': BLUE_PAINT, 'shape': (0.82, 1.0)},
    'role-rumble': {'paint': PURPLE_PAINT},
    'narrow-dash': {'width': 0.58, 'tyres': 1.12},
    'narrow-bolt': {'width': 0.58, 'tyres': 1.12, 'shape': (1.08, 0.85)},
    'narrow-carve': {'width': 0.6, 'tyres': 1.12, 'paint': BLUE_PAINT, 'shape': (0.82, 1.0)},
    'narrow-rumble': {'width': 0.62, 'tyres': 1.22, 'paint': PURPLE_PAINT},
    'small-dash': {'body': 0.88, 'tyres': 1.15},
    'small-bolt': {'body': 0.88, 'tyres': 1.15, 'shape': (1.08, 0.85)},
    'small-carve': {'body': 0.88, 'tyres': 1.15, 'paint': BLUE_PAINT, 'shape': (0.82, 1.0)},
    'small-rumble': {'body': 0.88, 'tyres': 1.25, 'paint': PURPLE_PAINT},
}


# ---------------------------------------------------------------- the source

def car_kit():
    """The Car Kit zip, downloaded once into the kit cache and hash-checked
    on every run (a mismatch means the bytes under a trusted URL changed)."""
    path = os.path.join(CACHE, 'zips', os.path.basename(CAR_KIT['url']))
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        urllib.request.urlretrieve(CAR_KIT['url'], path + '.part')
        os.replace(path + '.part', path)
    with open(path, 'rb') as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    if digest != CAR_KIT['sha256']:
        raise SystemExit(f'Car Kit sha256 mismatch: got {digest}')
    return zipfile.ZipFile(path)


def extracted(zf, member):
    """member, extracted under the cache (once), as a path."""
    dest = os.path.join(CACHE, 'car-kit-src', member)
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as f:
            f.write(zf.read(member))
    return dest


# ---------------------------------------------------------- palette remapping

def cells(path):
    """An atlas as {(row, col): [rgb at 4 heights down the cell]}, on the
    16 x 4 swatch grid both kits use; rows are glTF's, top-down."""
    img = bpy.data.images.load(path)
    w, h = img.size
    px = list(img.pixels)
    out = {}
    for row in range(4):
        for col in range(16):
            samples = []
            for t in (0.15, 0.4, 0.6, 0.85):
                x = int((col + 0.5) / 16 * w)
                y = h - 1 - int((row + t) / 4 * h)  # Blender's pixel rows run bottom-up
                i = (y * w + x) * 4
                samples.append(px[i:i + 3])
            out[(row, col)] = samples
    return out


def palette_map(src_path):
    """{Car Kit cell: (toy-kit cell, error)}: the toy-kit swatch nearest in
    colour all the way down its gradient."""
    src, dst = cells(src_path), cells(os.path.join(KIT, 'Textures', 'colormap.png'))

    def err(a, b):
        return math.sqrt(sum((p - q) ** 2 for sa, sb in zip(a, b) for p, q in zip(sa, sb)))

    return {k: min(((d, err(v, dv)) for d, dv in dst.items()), key=lambda x: x[1]) for k, v in src.items()}


def move_swatches(mesh, swatch_of):
    """Move every UV to the swatch swatch_of((row, col)) names (None: leave
    it), keeping its place inside the swatch (so a gradient stays a
    gradient). Both atlases are the same 16 x 4 grid."""
    for layer in mesh.uv_layers:
        for d in layer.data:
            u, gv = d.uv[0], 1.0 - d.uv[1]
            col, row = min(int(u * 16), 15), min(int(gv * 4), 3)
            to = swatch_of((row, col))
            if to:
                r2, c2 = to
                d.uv = ((c2 + u * 16 - col) / 16, 1.0 - (r2 + gv * 4 - row) / 4)


def remap_uvs(mesh, pmap, used):
    """Move every UV onto the toy-kit swatch its Car Kit swatch maps to."""
    def to(key):
        used[key] = pmap[key]
        return pmap[key][0]
    move_swatches(mesh, to)


# ------------------------------------------------------------------- convert

def convert(model, pmap, used, paint=None, shape=(1.0, 1.0), width=1.0, tyres=1.0, body=1.0):
    """Import a Car Kit model and return (body, [(wheel name, mesh, loc)]),
    turned, scaled, tweaked (see TWEAKS) and remapped."""
    zf = car_kit()
    extracted(zf, GLB_DIR + 'Textures/colormap.png')  # so the import finds it
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=extracted(zf, GLB_DIR + model + '.glb'))
    new = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    xs = [(o.matrix_world @ v.co).x for o in new for v in o.data.vertices]
    turn = Matrix.Rotation(math.pi, 4, 'Z') @ Matrix.Scale(TARGET_WIDTH / (max(xs) - min(xs)), 4)
    worlds = {o: o.matrix_world.copy() for o in new}
    # the wheels' radius (a wheel's centre height): bigger tyres lift the body by its growth
    radius = min(max((turn @ worlds[o] @ v.co).z for v in o.data.vertices) / 2
                 for o in new if o.name.split('.')[0] in WHEELS)
    # a `body` scale shrinks it toward the ground; it keeps its ride height
    belly = min((turn @ worlds[o] @ v.co).z for o in new if o.name.split('.')[0] not in WHEELS
                for v in o.data.vertices)
    body_parts, wheels = [], []
    for o in new:
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
        o.data = o.data.copy()  # wheels share meshes; each takes its own transform
        o.data.transform(turn @ worlds[o])
        role = WHEELS.get(o.name.split('.')[0])
        if not role:
            if paint:
                move_swatches(o.data, paint.get)
            o.data.transform(Matrix.Diagonal((width * body, shape[0] * body, shape[1] * body, 1.0)))
            o.data.transform(Matrix.Translation((0.0, 0.0, belly * (1.0 - body) + radius * (tyres - 1.0))))
        remap_uvs(o.data, pmap, used)
        if role:
            # the wheel spins about its own centre: that is where its node goes
            vs = [v.co for v in o.data.vertices]
            c = [(min(v[i] for v in vs) + max(v[i] for v in vs)) / 2 for i in range(3)]
            o.data.transform(Matrix.Translation((-c[0], -c[1], -c[2])))
            o.data.transform(Matrix.Scale(tyres, 4))
            wheels.append((role, o.data, (c[0], c[1] * shape[0], c[2] * tyres)))
        else:
            body_parts.append(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in body_parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body_parts[0]
    if len(body_parts) > 1:
        bpy.ops.object.join()
    return bpy.context.view_layer.objects.active, wheels


# --------------------------------------------------------------------- export

def export(name, body, wheels):
    """Write OUT/<name>.glb: body at the root, the wheel nodes, given as
    (name, mesh, location), as its children."""
    bpy.ops.object.select_all(action='DESELECT')
    body.name = name
    keep = [body]
    for wname, mesh, loc in wheels:
        o = bpy.data.objects.new(wname, mesh)
        bpy.context.scene.collection.objects.link(o)
        o.parent = body
        o.location = loc
        keep.append(o)
    for o in keep:
        o.select_set(True)
    path = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_image_format='NONE', export_tangents=False,
                              export_yup=True, export_apply=False, export_extras=False)
    kit_material(path)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in keep)
    print(f"wrote {name}.glb ({tris} tris)")
    return tris


def kit_material(path):
    """Rewrite the export to the kit's layout: the single colormap material,
    and the root node first."""
    with open(path, 'rb') as f:
        data = f.read()
    jlen = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20:20 + jlen])
    rest = data[20 + jlen:]
    doc['extensionsUsed'] = ['KHR_texture_transform']
    doc.pop('extensionsRequired', None)
    doc['images'] = [{'uri': 'Textures/colormap.png', 'name': 'colormap'}]
    doc['samplers'] = [{'magFilter': 9728, 'minFilter': 9984}]
    doc['textures'] = [{'sampler': 0, 'source': 0, 'name': 'colormap'}]
    doc['materials'] = [{
        'pbrMetallicRoughness': {
            'baseColorTexture': {'index': 0, 'extensions': {'KHR_texture_transform': {'texCoord': 0}}},
            'metallicFactor': 0,
        },
        'doubleSided': True,
        'name': 'colormap',
    }]
    for mesh in doc['meshes']:
        for p in mesh['primitives']:
            p['material'] = 0
    root = doc['scenes'][0]['nodes'][0]
    order = [root] + [i for i in range(len(doc['nodes'])) if i != root]
    where = {old: new for new, old in enumerate(order)}
    doc['nodes'] = [doc['nodes'][i] for i in order]
    for n in doc['nodes']:
        if 'children' in n:
            n['children'] = [where[c] for c in n['children']]
    doc['scenes'] = [{'nodes': [0], 'name': doc['nodes'][0]['name']}]
    js = json.dumps(doc, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + len(rest))
    out += struct.pack('<II', len(js), 0x4E4F534A) + js + rest
    with open(path, 'wb') as f:
        f.write(out)


# ===================================================================== design
#
# The DESIGNED cars: built from scratch in the Car Kit's look — its wheels,
# its colours, chunky flat-shaded parts with one small chamfer — because no
# Car Kit body shows its front wheels to the chase camera, and the player
# reads steering off them. Each is a car type whose own design leaves the
# wheels out in the open (roadster, buggy, hot rod, open 4x4), so nothing is
# squeezed and the proportions stay a car's. Game scale, nose to +Y.

SW = {  # Car Kit atlas swatches (row, col); odd columns carry the gradient
    'red': (1, 13), 'blue': (1, 15), 'green': (1, 7), 'purple': (0, 3),
    'trim': (2, 7), 'dark': (2, 5), 'black': (2, 3), 'glass': (0, 1),
    'lamp': (2, 12), 'tail': (3, 5), 'seat': (2, 9),
}
CAR_H = (0.0, 0.45)  # the height the paint gradient runs over, light on top


def set_swatch(o, sw, faces=None):
    """UV o's faces (or only `faces`) into swatch sw, v down the swatch as
    the vertex rises: the kit's light-on-top gradient."""
    row, col = SW[sw]
    me = o.data
    uv = (me.uv_layers.active or me.uv_layers.new(name='UVMap')).data
    zlo, zhi = CAR_H
    for p in me.polygons:
        if faces is not None and p.index not in faces:
            continue
        for li in p.loop_indices:
            t = min(max((me.vertices[me.loops[li].vertex_index].co.z - zlo) / (zhi - zlo), 0.0), 1.0)
            uv[li].uv = ((col + 0.5) / 16.0, 1.0 - (row * 0.25 + 0.03 + 0.19 * (1.0 - t)))


def part(name, bm, sw, bev=0.008):
    """bm as a flat-shaded part in swatch sw with a small chamfer."""
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    set_swatch(o, sw)
    if bev > 0:
        m = o.modifiers.new('bevel', 'BEVEL')
        m.width, m.segments, m.limit_method, m.angle_limit = bev, 1, 'ANGLE', math.radians(30)
    return o


def paint(o, dirn, sw, **bounds):
    """Paint o's faces facing dirn inside bounds (x=(lo, hi), ...) in sw,
    flush: the faces are split along the bounds first."""
    d = Vector(dirn).normalized()
    bm = bmesh.new()
    bm.from_mesh(o.data)

    def facing(f):
        return f.normal.dot(d) > 0.6

    for axis, (lo, hi) in bounds.items():
        k = 'xyz'.index(axis)
        for cut in (lo, hi):
            fs = [f for f in bm.faces if facing(f)]
            geom = fs + list({e for f in fs for e in f.edges}) + list({v for f in fs for v in f.verts})
            co, no = [0.0] * 3, [0.0] * 3
            co[k], no[k] = cut, 1.0
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=co, plane_no=no)
            bm.normal_update()
    sel = {f.index for f in bm.faces if facing(f) and all(
        lo < f.calc_center_median()['xyz'.index(a)] < hi for a, (lo, hi) in bounds.items())}
    bm.to_mesh(o.data)
    bm.free()
    set_swatch(o, sw, sel)
    return o


def hull(name, pts, sw, bev=0.008):
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    r = bmesh.ops.convex_hull(bm, input=list(bm.verts))
    loose = [v for v in dict.fromkeys(r['geom_interior'] + r['geom_unused']) if isinstance(v, bmesh.types.BMVert)]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=list(bm.verts), edges=list(bm.edges))
    return part(name, bm, sw, bev)


def box(name, lo, hi, sw, bev=0.008):
    return hull(name, [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])], sw, bev)


def profile(name, hx, side, sw, cx=0.0, bev=0.008):
    """A convex side profile [(y, z), ...] extruded across cx +- hx."""
    return hull(name, [(cx + s * hx, y, z) for y, z in side for s in (-1, 1)], sw, bev)


def section(name, secs, sw, bev=0.008):
    """A hull through cross-sections (y, half-width at the bottom, z bottom,
    z top, half-width at the top): narrows upwards and along its length."""
    pts = []
    for y, hx, z0, z1, thx in secs:
        pts += [(s * hx, y, z0) for s in (-1, 1)] + [(s * thx, y, z1) for s in (-1, 1)]
    return hull(name, pts, sw, bev)


def cyl(name, p0, p1, r, sw, seg=10):
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r, radius2=r, depth=d.length)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4(),
                        verts=list(bm.verts))
    return part(name, bm, sw, 0)


def arc(name, cx, cy, cz, r, thick, hw, a0, a1, sw, segs=7):
    """A fender: a strip bent round the axle (x) at (cy, cz) from angle a0 to
    a1 (degrees; 0 = straight ahead, 90 = on top), hw half-wide."""
    bm = bmesh.new()
    rings = []
    for i in range(segs + 1):
        a = math.radians(a0 + (a1 - a0) * i / segs)
        rings.append([bm.verts.new((cx + s * hw, cy + rr * math.cos(a), cz + rr * math.sin(a)))
                      for rr in (r, r + thick) for s in (-1, 1)])
    for r0, r1 in zip(rings, rings[1:]):  # ring: inner-left, inner-right, outer-left, outer-right
        for a, b in ((2, 3), (1, 0), (0, 2), (3, 1)):
            bm.faces.new((r0[a], r0[b], r1[b], r1[a]))
    for rr in (rings[0], rings[-1][::-1]):
        bm.faces.new((rr[0], rr[1], rr[3], rr[2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return part(name, bm, sw, 0.004)


def kit_wheel(kind, r, w, left):
    """A Car Kit wheel mesh (wheel-default / -racing / -truck) at radius r and
    width w, centred, its hub facing out on its side."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=extracted(car_kit(), GLB_DIR + kind + '.glb'))
    src = next(o for o in bpy.data.objects if o not in before and o.type == 'MESH')
    me = src.data.copy()
    for o in [o for o in bpy.data.objects if o not in before]:
        bpy.data.objects.remove(o)
    vs = [v.co for v in me.vertices]
    lo = Vector([min(v[i] for v in vs) for i in range(3)])
    hi = Vector([max(v[i] for v in vs) for i in range(3)])
    me.transform(Matrix.Diagonal((w / (hi.x - lo.x), 2 * r / (hi.y - lo.y), 2 * r / (hi.z - lo.z), 1))
                 @ Matrix.Translation(-(lo + hi) / 2))
    if left:
        me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
        me.flip_normals()
    return me


def axle(wheels, kind, y, x, r, w, front):
    """The axle's two wheels, as (node name, mesh, location)."""
    for s, side in ((-1, 'l'), (1, 'r')):
        wheels.append((f"wheel-{'f' if front else 'b'}{side}", kit_wheel(kind, r, w, s < 0), (s * x, y, r)))


def xs(s, a, b):
    """The x interval a..b (both >= 0) on side s, low end first."""
    return tuple(sorted((s * a, s * b)))


def bar(name, lo, hi, sw='trim'):
    """A chunky square bar: the kit has no thin rods, so a tube, a strut or a
    cage is a block about 0.04 thick."""
    return box(name, lo, hi, sw, 0.006)



def lamp_block(name, lo, hi, face='y+'):
    """A lamp: a trim block whose outer face is the lens."""
    o = box(name, lo, hi, 'trim', 0.006)
    return paint(o, (0, 1 if face == 'y+' else -1, 0), 'lamp' if face == 'y+' else 'tail')


def hot_rod(wheels):
    """Dash, the all-rounder: a hot-rod roadster, long bonnet and upright
    grille, small front wheels on an exposed axle, big rear ones."""
    P, fy, ry = 'green', 0.31, -0.24
    section('hood', [(0.42, 0.075, 0.11, 0.25, 0.065), (0.06, 0.09, 0.10, 0.27, 0.08)], P)
    cab = section('cab', [(0.08, 0.14, 0.08, 0.28, 0.12), (-0.30, 0.14, 0.08, 0.29, 0.12),
                          (-0.42, 0.11, 0.10, 0.26, 0.09)], P)
    paint(cab, (0, 0, 1), 'black', x=(-0.10, 0.10), y=(-0.22, 0.04))
    paint(box('grille', (-0.09, 0.42, 0.09), (0.09, 0.48, 0.29), 'trim', 0.012), (0, 1, 0), 'dark',
          x=(-0.06, 0.06), z=(0.12, 0.26))
    box('screen', (-0.13, 0.02, 0.28), (0.13, 0.05, 0.36), 'glass', 0.006)
    bar('screenTop', (-0.145, 0.015, 0.35), (0.145, 0.055, 0.385))
    bar('axle', (-0.15, fy - 0.02, 0.085), (0.15, fy + 0.02, 0.125))
    for s in (-1, 1):
        paint(cab, (0, -1, 0), 'tail', x=xs(s, 0.04, 0.10), z=(0.19, 0.25))
        lo, hi = xs(s, 0.09, 0.16)
        lamp_block(f'lamp{s}', (lo, 0.40, 0.19), (hi, 0.47, 0.26))
        lo, hi = xs(s, 0.12, 0.145)
        bar(f'screenSide{s}', (lo, 0.015, 0.28), (hi, 0.055, 0.37))
        lo, hi = xs(s, 0.13, 0.175)
        bar(f'pipe{s}', (lo, -0.20, 0.07), (hi, 0.10, 0.11))
    axle(wheels, 'wheel-default', fy, 0.18, 0.105, 0.10, True)
    axle(wheels, 'wheel-default', ry, 0.19, 0.135, 0.17, False)


def roadster(wheels):
    """Bolt, the fastest and lightest: a Seven-style roadster, long nose,
    cycle fenders over the front wheels, a headrest fairing, side pipes."""
    P, fy, ry, tx, r = 'red', 0.30, -0.26, 0.20, 0.12
    tub = section('tub', [(-0.41, 0.10, 0.07, 0.235, 0.085), (-0.20, 0.12, 0.06, 0.255, 0.105),
                          (0.12, 0.12, 0.06, 0.25, 0.105), (0.32, 0.09, 0.07, 0.215, 0.075),
                          (0.47, 0.06, 0.085, 0.175, 0.045)], P)
    paint(tub, (0, 0, 1), 'black', x=(-0.085, 0.085), y=(-0.17, 0.07))
    paint(tub, (0, 1, 0), 'dark', x=(-0.045, 0.045), z=(0.10, 0.165))
    profile('headrest', 0.05, [(-0.18, 0.25), (-0.18, 0.31), (-0.25, 0.32), (-0.37, 0.24)], P)
    box('screen', (-0.1, 0.065, 0.24), (0.1, 0.095, 0.32), 'glass', 0.006)
    bar('screenTop', (-0.11, 0.06, 0.31), (0.11, 0.10, 0.34))
    for s in (-1, 1):
        lo, hi = xs(s, 0.045, 0.09)
        box(f'tail{s}', (lo, -0.425, 0.165), (hi, -0.405, 0.215), 'tail', 0.004)
        arc(f'fender{s}', s * tx, fy, r, r + 0.012, 0.024, 0.075, 20, 150, P)
        arc(f'rearwing{s}', s * tx, ry, r * 1.04, r * 1.04 + 0.014, 0.024, 0.085, 40, 150, P, 6)
        lo, hi = xs(s, 0.11, tx - 0.075)
        box(f'web{s}', (lo, ry - 0.06, 0.21), (hi, ry + 0.06, 0.24), P)
        bar(f'arm{s}', (lo, fy - 0.02, r - 0.02), (hi, fy + 0.02, r + 0.02))
        lo, hi = xs(s, 0.035, 0.085)
        lamp_block(f'lamp{s}', (lo, 0.36, 0.20), (hi, 0.43, 0.245))
        lo, hi = xs(s, 0.115, 0.155)
        bar(f'pipe{s}', (lo, -0.20, 0.075), (hi, 0.10, 0.115))
    axle(wheels, 'wheel-racing', fy, tx, r, 0.13, True)
    axle(wheels, 'wheel-racing', ry, tx, r * 1.04, 0.15, False)


def buggy(wheels):
    """Carve, the corner king: a short dune buggy, wheels at the corners
    under open flares, a roll bar and the engine out the back."""
    P, fy, ry, tx = 'blue', 0.25, -0.25, 0.20
    tub = section('tub', [(-0.37, 0.13, 0.09, 0.20, 0.11), (-0.15, 0.15, 0.07, 0.22, 0.13),
                          (0.12, 0.14, 0.07, 0.225, 0.12), (0.30, 0.12, 0.08, 0.20, 0.10),
                          (0.42, 0.10, 0.10, 0.165, 0.08)], P)
    paint(tub, (0, 0, 1), 'black', x=(-0.11, 0.11), y=(-0.17, 0.07))
    for s in (-1, 1):
        paint(tub, (0, -1, 0), 'tail', x=xs(s, 0.07, 0.115), z=(0.135, 0.185))
        arc(f'flareF{s}', s * tx, fy, 0.12, 0.135, 0.024, 0.08, 25, 155, P)
        arc(f'flareR{s}', s * tx, ry, 0.13, 0.145, 0.024, 0.09, 25, 155, P)
        lo, hi = xs(s, 0.12, tx - 0.07)
        box(f'webF{s}', (lo, fy - 0.07, 0.19), (hi, fy + 0.07, 0.215), P)
        lo, hi = xs(s, 0.13, tx - 0.08)
        box(f'webR{s}', (lo, ry - 0.08, 0.19), (hi, ry + 0.08, 0.215), P)
        lo, hi = xs(s, 0.015, 0.11)
        box(f'seat{s}', (lo, -0.18, 0.2), (hi, -0.12, 0.32), 'seat')
        lo, hi = xs(s, 0.105, 0.145)
        bar(f'hoopPost{s}', (lo, -0.22, 0.2), (hi, -0.18, 0.39))
        lo, hi = xs(s, 0.04, 0.10)
        lamp_block(f'lamp{s}', (lo, 0.30, 0.20), (hi, 0.36, 0.25))
        lo, hi = xs(s, 0.02, 0.06)
        bar(f'exhaust{s}', (lo, -0.47, 0.13), (hi, -0.40, 0.17))
    bar('hoopTop', (-0.145, -0.22, 0.355), (0.145, -0.18, 0.395))
    box('engine', (-0.09, -0.43, 0.12), (0.09, -0.32, 0.24), 'trim')
    box('screen', (-0.12, 0.075, 0.21), (0.12, 0.105, 0.29), 'glass', 0.006)
    bar('screenTop', (-0.13, 0.07, 0.28), (0.13, 0.11, 0.31))
    axle(wheels, 'wheel-default', fy, tx, 0.12, 0.13, True)
    axle(wheels, 'wheel-default', ry, tx, 0.13, 0.16, False)


def four_by_four(wheels):
    """Rumble, the heavy one: an open 4x4 on truck tyres, bull bar, roll
    cage with a light bar, the spare on its tail."""
    P, fy, ry, tx, r = 'purple', 0.27, -0.27, 0.19, 0.15
    box('frame', (-0.08, -0.40, 0.12), (0.08, 0.40, 0.17), 'dark')
    tub = section('tub', [(0.40, 0.13, 0.17, 0.30, 0.12), (0.10, 0.15, 0.17, 0.32, 0.14),
                          (-0.40, 0.15, 0.17, 0.31, 0.14)], P)
    paint(tub, (0, 0, 1), 'black', x=(-0.12, 0.12), y=(-0.28, 0.02))
    box('bumper', (-0.16, 0.42, 0.13), (0.16, 0.48, 0.20), 'trim')
    box('rbumper', (-0.16, -0.47, 0.13), (0.16, -0.41, 0.20), 'trim')
    bar('barTop', (-0.11, 0.44, 0.29), (0.11, 0.48, 0.33))
    for y0 in (-0.10, -0.32):
        bar(f'cageTop{y0}', (-0.145, y0, 0.37), (0.145, y0 + 0.04, 0.41))
    for s in (-1, 1):
        paint(tub, (0, 1, 0), 'lamp', x=xs(s, 0.05, 0.115), z=(0.235, 0.285))
        lo, hi = xs(s, 0.07, 0.13)
        box(f'tailLamp{s}', (lo, -0.415, 0.245), (hi, -0.395, 0.295), 'tail', 0.004)
        lo, hi = xs(s, 0.07, 0.11)
        bar(f'barPost{s}', (lo, 0.44, 0.20), (hi, 0.48, 0.31))
        arc(f'flareF{s}', s * tx, fy, r, r + 0.015, 0.024, 0.09, 35, 145, P)
        arc(f'flareR{s}', s * tx, ry, r, r + 0.015, 0.024, 0.09, 35, 145, P)
        lo, hi = xs(s, 0.105, 0.145)
        for y0 in (-0.10, -0.32):
            bar(f'cagePost{s}{y0}', (lo, y0, 0.31), (hi, y0 + 0.04, 0.40))
        bar(f'cageSide{s}', (lo, -0.32, 0.37), (hi, -0.06, 0.41))
        lo, hi = xs(s, 0.015, 0.11)
        box(f'seat{s}', (lo, -0.26, 0.3), (hi, -0.19, 0.38), 'seat')
    paint(box('lightbar', (-0.12, -0.10, 0.41), (0.12, -0.05, 0.45), 'dark', 0.006), (0, 1, 0), 'lamp',
          x=(-0.105, 0.105), z=(0.415, 0.445))
    spare = bpy.data.objects.new('spare', kit_wheel('wheel-truck', 0.09, 0.08, False))
    bpy.context.scene.collection.objects.link(spare)
    spare.rotation_euler.z = -math.pi / 2
    spare.location = (0.0, -0.48, 0.30)
    axle(wheels, 'wheel-truck', fy, tx, r, 0.16, True)
    axle(wheels, 'wheel-truck', ry, tx, r, 0.16, False)


# ====================================================================== remix
#
# The ROSTER cars as they ship, given the Car Kit's level of detail and
# nothing else: their bodies, stance and identities stay (they are sized for
# the chase camera, and Bolt and Rumble show their front wheels to it). Car
# Kit wheels with coloured rims at the same size, light glass in place of the
# dark slate windows, block lamps front and back, a grille. Details are kit
# blocks standing a little proud of the body's real faces (raycast), never
# thin plates.

FACES = {'x+': (0, 1), 'x-': (0, -1), 'y+': (1, 1), 'y-': (1, -1), 'z+': (2, 1)}


class Surface:
    """Raycasts onto a body, so details sit on its real faces. A face is the
    side a ray comes in from ('y+' is the nose); a point on it is named by
    the other two coordinates, in x, y, z order."""

    def __init__(self, obj):
        self.bvh = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())

    def at(self, face, a, b):
        axis, sign = FACES[face]
        o = [a, b]
        o.insert(axis, sign * 3.0)
        d = [0.0, 0.0, 0.0]
        d[axis] = -sign
        loc = self.bvh.ray_cast(Vector(o), Vector(d))[0]
        if loc is None:
            raise ValueError(f"nothing under {face} at {a:.3f}, {b:.3f}")
        return loc[axis]

    def block(self, name, face, rect, sw, out=0.016, depth=0.03, lens=None):
        """A block over rect = (a0, a1, b0, b1) standing `out` proud of the
        face found under its centre, `depth` into the body; `lens` colours
        only its outer face."""
        axis, sign = FACES[face]
        (a0, a1), (b0, b1) = sorted(rect[:2]), sorted(rect[2:])
        at = self.at(face, (a0 + a1) / 2, (b0 + b1) / 2)
        lo, hi = [a0, b0], [a1, b1]
        lo.insert(axis, min(at - sign * depth, at + sign * out))
        hi.insert(axis, max(at - sign * depth, at + sign * out))
        o = box(name, lo, hi, sw, 0.006)
        if lens:
            d = [0, 0, 0]
            d[axis] = sign
            paint(o, d, lens)
        return o

    def pair(self, name, face, xr, zr, sw, **kw):
        """A left and right pair of blocks over |x| in xr, z in zr."""
        for s in (-1, 1):
            self.block(f'{name}{s}', face, (*xs(s, *xr), *zr), sw, **kw)


def glass_windows(body):
    """The kit's dark slate windows (toy swatch 3, 5) as light glass (2, 13),
    pinned a quarter down its gradient: glass facing the sky washes white."""
    uv = body.data.uv_layers.active.data
    for p in body.data.polygons:
        u, v = uv[p.loop_indices[0]].uv
        if (int((1 - v) * 4), int(u * 16)) == (3, 5):
            for li in p.loop_indices:
                uv[li].uv = (13.5 / 16, 1 - (0.5 + 0.03 + 0.19 * 0.75))


def dash_remix(S):
    """Dash, the roster's low racer: Car Kit wheels, light glass, block
    head and tail lamps, a grille."""
    S.pair('head', 'y+', (0.10, 0.16), (0.219, 0.25), 'lamp')
    S.block('grille', 'y+', (-0.0625, 0.0625, 0.219, 0.25), 'black', out=0.008)
    S.pair('tail', 'y-', (0.094, 0.156), (0.219, 0.25), 'tail')


def bolt_remix(S):
    """Bolt, the roster's open-wheel speedster: Car Kit racing wheels, nose
    lamps, tail lamps on a bar."""
    S.pair('head', 'y+', (0.03, 0.08), (0.135, 0.17), 'lamp')
    S.block('tailBar', 'y-', (-0.1, 0.1, 0.198, 0.258), 'trim', out=0.012)
    S.pair('tail', 'y-', (0.03, 0.085), (0.21, 0.246), 'tail', out=0.024)


def carve_remix(S):
    """Carve, the roster's racer: Car Kit racing wheels, light glass, block
    head and tail lamps, a grille."""
    S.pair('head', 'y+', (0.094, 0.156), (0.225, 0.27), 'lamp')
    S.block('grille', 'y+', (-0.0625, 0.0625, 0.225, 0.27), 'black', out=0.008)
    S.pair('tail', 'y-', (0.094, 0.156), (0.25, 0.30), 'tail')


def rumble_remix(S):
    """Rumble, the roster's vintage racer: Car Kit wheels, block lamps
    beside a grille, tail lamps."""
    S.pair('head', 'y+', (0.06, 0.11), (0.2, 0.245), 'lamp')
    S.block('grille', 'y+', (-0.035, 0.035, 0.195, 0.25), 'black', out=0.008)
    S.pair('tail', 'y-', (0.035, 0.08), (0.17, 0.21), 'tail')


# name -> (builder, the roster car it remixes, the Car Kit wheel it wears)
REMIX = {
    'remix-dash': (dash_remix, 'vehicle-racer-low', 'wheel-default'),
    'remix-bolt': (bolt_remix, 'vehicle-speedster', 'wheel-racing'),
    'remix-carve': (carve_remix, 'vehicle-racer', 'wheel-racing'),
    'remix-rumble': (rumble_remix, 'vehicle-vintage-racer', 'wheel-default'),
}


def remix(fn, base, wheel_kind, pmap, used):
    """A roster car, its details added: (body, [(node name, mesh, loc)])."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(KIT, base + '.glb'))
    new = [o for o in bpy.data.objects if o not in before]
    body = next(o for o in new if o.parent is None)
    nodes = [(o.name.split('.')[0], o.data, tuple(o.matrix_world.translation)) for o in new if o is not body]
    for o in new:
        if o is not body:
            bpy.data.objects.remove(o)
    body.matrix_world = Matrix.Identity(4)
    have = set(bpy.data.objects)
    fn(Surface(body))
    glass_windows(body)
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    bm.from_mesh(body.data)
    for o in [o for o in bpy.data.objects if o not in have]:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.transform(o.matrix_world)
        remap_uvs(me, pmap, used)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        bpy.data.objects.remove(o)
    bm.to_mesh(body.data)
    bm.free()
    wheels = []
    for name, me, loc in nodes:
        if name.startswith('wheel-'):
            me = kit_wheel(wheel_kind, loc[2], 0.125, loc[0] < 0)
            remap_uvs(me, pmap, used)
        wheels.append((name, me, loc))
    return body, wheels


# name -> (builder, the roster car whose role it takes). The note is the
# builder's docstring.
DESIGNS = {
    'new-dash': (hot_rod, 'vehicle-racer-low'),
    'new-bolt': (roadster, 'vehicle-speedster'),
    'new-carve': (buggy, 'vehicle-racer'),
    'new-rumble': (four_by_four, 'vehicle-vintage-racer'),
}


def design(fn, pmap, used):
    """Run a builder, then join its parts (chamfers applied) into one body:
    (body, [(wheel name, mesh, loc)]), on the toy palette."""
    wheels = []
    fn(wheels)
    dg = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for o in list(bpy.context.scene.objects):
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.transform(o.matrix_world)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        bpy.data.objects.remove(o)
    me = bpy.data.meshes.new('body')
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    body = bpy.data.objects.new('body', me)
    bpy.context.scene.collection.objects.link(body)
    for m in [me] + [w[1] for w in wheels]:
        remap_uvs(m, pmap, used)
    return body, wheels


def build(name, pmap, used):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if name in DESIGNS:
        body, wheels = design(DESIGNS[name][0], pmap, used)
    elif name in REMIX:
        body, wheels = remix(*REMIX[name], pmap, used)
    else:
        body, wheels = convert(CARS[name][0], pmap, used, **TWEAKS.get(name, {}))
    for o in list(bpy.data.objects):
        if o is not body:
            bpy.data.objects.remove(o)
    return export(name, body, wheels)


def write_index(tris):
    """OUT/index.json, the gallery's list: every car in CARS order with its
    triangle count, what it is and the roster car to stand it beside. Counts
    for cars not rebuilt this run are carried over."""
    path = os.path.join(OUT, 'index.json')
    old = {}
    if os.path.exists(path):
        with open(path) as f:
            old = {m['name']: m for m in json.load(f)['models']}
    models = []
    for name, (model, note, base) in CARS.items():
        count = tris.get(name, old.get(name, {}).get('tris'))
        if count is None:
            continue
        m = {'name': name, 'tris': count, 'note': f'Car Kit {CAR_KIT["version"]} {model}: {note}'}
        if base:
            m['base'] = base
        models.append(m)
    for name, (fn, base) in DESIGNS.items():
        count = tris.get(name, old.get(name, {}).get('tris'))
        if count is not None:
            models.append({'name': name, 'tris': count, 'base': base,
                           'note': 'Designed from Car Kit parts. ' + ' '.join(fn.__doc__.split())})
    for name, (fn, base, kind) in REMIX.items():
        count = tris.get(name, old.get(name, {}).get('tris'))
        if count is not None:
            models.append({'name': name, 'tris': count, 'base': base, 'note': ' '.join(fn.__doc__.split())})
    with open(path, 'w') as f:
        json.dump({'_readme': 'Written by scripts/gen-concept-cars.py; read by the asset gallery.',
                   'models': models}, f, indent=1)
        f.write('\n')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    os.makedirs(OUT, exist_ok=True)
    pmap = palette_map(extracted(car_kit(), GLB_DIR + 'Textures/colormap.png'))
    used = {}
    write_index({name: build(name, pmap, used) for name in argv or list(CARS) + list(DESIGNS) + list(REMIX)})
    for src, (dst, e) in sorted(used.items(), key=lambda kv: -kv[1][1]):
        print(f'palette: Car Kit {src} -> toy kit {dst}, error {e:.3f}')


main()
