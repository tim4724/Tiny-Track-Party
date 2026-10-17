# gen-concept-cars.py — convert candidate cars from Kenney's CAR KIT into the
# toy-car kit's format, into public/assets/concepts/, for the asset gallery's
# "Concept cars" field and for racing them with ?cars=. Nothing ships them.
#
#   blender -b --factory-startup --python scripts/gen-concept-cars.py [-- name ...]
#
# The Car Kit is Kenney's more detailed car set (CC0). It is fetched and
# hash-checked into the same cache as scripts/fetch-kits.mjs, and each model is
# converted so it could drop into the roster as is:
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

import bpy
import hashlib
import json
import math
import os
import struct
import sys
import urllib.request
import zipfile
from mathutils import Matrix

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


def build(name, pmap, used):
    bpy.ops.wm.read_factory_settings(use_empty=True)
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
    with open(path, 'w') as f:
        json.dump({'_readme': 'Written by scripts/gen-concept-cars.py; read by the asset gallery.',
                   'models': models}, f, indent=1)
        f.write('\n')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    os.makedirs(OUT, exist_ok=True)
    pmap = palette_map(extracted(car_kit(), GLB_DIR + 'Textures/colormap.png'))
    used = {}
    write_index({name: build(name, pmap, used) for name in argv or list(CARS)})
    for src, (dst, e) in sorted(used.items(), key=lambda kv: -kv[1][1]):
        print(f'palette: Car Kit {src} -> toy kit {dst}, error {e:.3f}')


main()
