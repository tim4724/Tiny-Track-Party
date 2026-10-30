# gen-concept-cars.py — exports the cars scripts/toy_cars.py builds, in the
# toy-car kit's own GLB layout (one colormap material by URI, the root node
# first, wheel-fl/fr/bl/br — and the spare, where a car has one — as its
# children):
#
#   blender -b --factory-startup --python scripts/gen-concept-cars.py -- --roster
#       the four SHIPPED cars (toy_cars.ROSTER) into public/assets/toycar/.
#       Then: scripts/dedupe-wheel-meshes.mjs, scripts/gen-kit-colors.mjs and a
#       wasm rebuild, scripts/capture-car-thumbs.js.
#   blender -b --factory-startup --python scripts/gen-concept-cars.py [-- name ...]
#       the CONCEPT cars (toy_cars.CARS) into public/assets/concepts/ with the
#       index.json the asset gallery's "Concept cars" field lists them from.
#       Nothing ships them; `?cars=<name>,...` races them on the web.
#
# The earlier families — Kenney Car Kit conversions, cars designed from its
# parts, the roster cars remixed — are in git history with the converter that
# made them.

import bpy
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import toy_cars  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
KIT = os.path.join(REPO, 'public', 'assets', 'toycar')
OUT = os.path.join(REPO, 'public', 'assets', 'concepts')


def export(name, body, children, out):
    """Write out/<name>.glb: body at the root, the children, given as
    (name, mesh, location), as its child nodes. Returns the triangle count."""
    bpy.ops.object.select_all(action='DESELECT')
    body.name = name
    keep = [body]
    for cname, mesh, loc in children:
        o = bpy.data.objects.new(cname, mesh)
        bpy.context.scene.collection.objects.link(o)
        o.parent = body
        o.location = loc
        keep.append(o)
    for o in keep:
        o.select_set(True)
    path = os.path.join(out, name + '.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_image_format='NONE', export_tangents=False,
                              export_yup=True, export_apply=False, export_extras=False)
    kit_material(path)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in keep)
    print(f"wrote {name}.glb ({tris} tris)")
    return tris


def kit_material(path):
    """Rewrite the export to the kit's layout: the single colormap material by
    URI (the kit's shared Textures/colormap.png), and the root node first."""
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


def build(name, out):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    body, children = toy_cars.build(name)
    for o in list(bpy.data.objects):
        if o is not body:
            bpy.data.objects.remove(o)
    return export(name, body, children, out)


def write_index(tris):
    """OUT/index.json, the gallery's list: every concept car with its triangle
    count and what it is, in toy_cars.CARS order. A roster car's first
    variation names it as `base`, which the gallery stands ahead of the group
    so the shipped car heads its own variations. Counts for cars not rebuilt
    this run are carried over."""
    path = os.path.join(OUT, 'index.json')
    old = {}
    if os.path.exists(path):
        with open(path) as f:
            old = {m['name']: m for m in json.load(f)['models']}
    models = []
    headed = set()
    for name, (fn, paint) in toy_cars.CARS.items():
        count = tris.get(name, old.get(name, {}).get('tris'))
        if count is None:
            continue
        m = {'name': name, 'tris': count,
             'note': 'Toy kit construction, front wheels in the open. ' + ' '.join(fn.__doc__.split())}
        base = 'vehicle-' + name.split('-')[1]
        if base in toy_cars.ROSTER and base not in headed:
            m['base'] = base
            headed.add(base)
        models.append(m)
    with open(path, 'w') as f:
        json.dump({'_readme': 'Written by scripts/gen-concept-cars.py; read by the asset gallery.',
                   'models': models}, f, indent=1)
        f.write('\n')


def main():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if argv == ['--roster']:
        for name in toy_cars.ROSTER:
            build(name, KIT)
        return
    os.makedirs(OUT, exist_ok=True)
    write_index({name: build(name, OUT) for name in argv or list(toy_cars.CARS)})


main()
